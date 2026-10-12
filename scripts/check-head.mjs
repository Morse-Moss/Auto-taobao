#!/usr/bin/env node
/**
 * `check:head` —— 「干净检出下真的跑一遍」（2026-10-13 加）。
 *
 * 它补的是哪个缺口：**本地测试永远跑在工作区**。工作区里「消费侧 + 供给侧」两半都在，
 * 所以测试必过；只有干净检出（stash / clone / worktree / CI）才会暴露「HEAD 上只有一半」。
 * 本仓两个半提交实例（`ef629d0`、10-10 17:13 休眠流）都正好栽在这上面。
 *
 * 现有的 `runtime/head-loadable.test.mjs`（HEAD 可加载守卫）只挡得住「缺导出」那一类 ——
 * 因为它可以在模块链接期炸。「参数收了却不用」、「三态没认全」、「步骤顺序反了」这三类
 * 要跑起来才暴露，而跑起来跑的永远是工作区。`check:head` 就是把「干净检出 + 真跑」
 * 变成一条命令，提交前就能红，不用等几小时后的 CI。
 *
 * 做法：`git worktree add --detach <临时目录> HEAD` ⇒ 在**那个目录**里跑定向组 ⇒ 删掉。
 * 为什么用 worktree 而不是 `git stash`：stash 会动正在编辑的工作区（本仓常有未提交改动，
 * 那是别人或我自己正在做的事），worktree 一个字节都不碰它。
 *
 * node_modules 怎么办（默认走 junction，不跑 npm ci）：
 *   worktree 是空的，`npm ci` 要联网、要一两分钟。默认把仓库的 node_modules 用
 *   **junction**（NTFS 目录联接，不需要管理员权限）链进去 —— 秒级、离线可用。
 *   代价写在这里：这样跑的是「HEAD 的源码 + 当前 node_modules」。若某次提交改了
 *   `package.json` 的依赖而 node_modules 还没跟上，失败原因会指向依赖而不是契约。
 *   要排除这一种，加 `--npm-ci`（真装一遍，慢但干净）。
 *
 * 用法：
 *   node scripts/check-head.mjs                  # 跑默认四个组
 *   node scripts/check-head.mjs --only runtime   # 只跑名字含 runtime 的组
 *   node scripts/check-head.mjs --npm-ci         # 真装依赖再跑
 *
 * 退出码：0 = 全绿；1 = 有组红（或 worktree 起不来）。原始输出全部落
 * `evidence/head-check-<sha>-<时间戳>/`，报分母时报那个路径。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// `stdio` 必须显式写、且 stdin 只能是 'ignore'（同 check-fast.mjs 的理由）：
// 宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回 EBUSY，报出来像 git 坏了。
const STDIO = ['ignore', 'pipe', 'pipe'];

// 默认跑哪几组。刻意**不跑全量**：全量 20–23 分钟，那是 CI 的活；这里只跑
// 「日报链 + 它旁边那两条链 + runtime」，也就是最可能被一次改动打到的地方。
// 判据是「改动面」，不是「图省事」—— 漏跑一组不会让 check:head 假绿，只会让它漏报，
// 所以范围写成一个显式清单，改范围要改这里。
const GROUPS = Object.freeze([
  { name: 'runtime', args: ['runtime', '--concurrency=1'] },
  { name: 'skills:sycm-alimama-daily-report', args: ['skills', '--skill', 'sycm-alimama-daily-report', '--concurrency=1'] },
  { name: 'skills:sycm-promotion-data', args: ['skills', '--skill', 'sycm-promotion-data', '--concurrency=1'] },
  { name: 'skills:sycm-inquiry-data', args: ['skills', '--skill', 'sycm-inquiry-data', '--concurrency=1'] },
]);

const only = (() => {
  const index = process.argv.indexOf('--only');
  return index === -1 ? null : process.argv[index + 1];
})();
const wantNpmCi = process.argv.includes('--npm-ci');
const selected = only ? GROUPS.filter((group) => group.name.includes(only)) : GROUPS;
if (selected.length === 0) {
  console.error(`--only ${only} 没匹配到任何组；可选：${GROUPS.map((g) => g.name).join(' / ')}`);
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: STDIO, windowsHide: true });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error ?? null,
  };
}

const head = run('git', ['rev-parse', '--short', 'HEAD'], root);
if (head.status !== 0) {
  console.error(`拿不到 HEAD：${head.stderr.trim() || head.error?.message}`);
  process.exit(1);
}
const headSha = head.stdout.trim();

// 证据目录跟着这一次运行走（报分母时报它）。**不放在临时目录**—— 那里会被删掉。
const stamp = new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19);
const logRoot = path.join(root, 'evidence', `head-check-${headSha}-${stamp}`);
fs.mkdirSync(logRoot, { recursive: true });

const worktree = (() => {
  // 为什么必须 `realpathSync.native`：本机 `os.tmpdir()` 返回的是 **8.3 短名**
  // `C:\Users\ADMINI~1\AppData\Local\Temp`（这个目录真实存在）。而一批用例拿 fixture 的写法是
  // `new URL('./xxx.md', import.meta.url)` —— 路径里的 `~` 会被编成 `%7E`，
  // 于是 `readFile` 报 ENOENT（**文件明明在**）。2026-10-12 首跑就撞上：
  // `runtime/legacy-feishu-prompt-analysis.test.mjs` 4 条全红，原因全是一行 ENOENT。
  // 普通 `realpathSync` 在这个机器上**不解析短名**（它认为短名就是真名），只有 `.native` 会。
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.mkdtempSync(path.join(base, 'sycm-head-'));
})();
let exitCode = 0;

console.log(`==> check:head @ ${headSha}`);
console.log(`==> 干净检出目录：${worktree}`);
console.log(`==> 原始输出：${logRoot}`);

const cleanup = () => {
  // 先删 git 侧的登记，再删目录。顺序反了会留下一条指向不存在路径的 worktree 记录
  // （那条记录会让以后每次 `git worktree list` 都带一行脏信息）。
  run('git', ['worktree', 'remove', '--force', worktree], root);
  run('git', ['worktree', 'prune'], root);
  fs.rmSync(worktree, { recursive: true, force: true });
};

try {
  const added = run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], root);
  if (added.status !== 0) {
    console.error(`worktree 起不来：${added.stderr.trim() || added.error?.message}`);
    process.exit(1);
  }

  const repoModules = path.join(root, 'node_modules');
  const linkPath = path.join(worktree, 'node_modules');
  if (wantNpmCi) {
    console.log('==> npm ci --ignore-scripts（--npm-ci：真装一遍，慢但干净）');
    const ci = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], worktree);
    if (ci.status !== 0) {
      console.error(`npm ci 失败：\n${(ci.stdout + ci.stderr).slice(-2000)}`);
      process.exit(1);
    }
  } else if (fs.existsSync(repoModules)) {
    // junction 不需要管理员权限（ unlike symlink），删掉时也不会留下悬空链接。
    try {
      fs.symlinkSync(repoModules, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      console.log(`==> node_modules ← junction ${repoModules}`);
    } catch (error) {
      // 链不上不假装成功：缺依赖的组会自己红，而红的原因要说清是「没链上」。
      console.log(`==> ⚠️ node_modules 链不上（${error.message}）—— 需要依赖的组可能因缺包而红`);
    }
  } else {
    console.log('==> ⚠️ 仓库根没有 node_modules，且没给 --npm-ci —— 需要依赖的组会因缺包而红');
  }

  for (const group of selected) {
    const logFile = path.join(logRoot, `${group.name.replace(/[:/]/gu, '_')}.log`);
    console.log(`==> [${group.name}] node scripts/run-test-suite.mjs ${group.args.join(' ')}`);
    const result = run(process.execPath, [path.join('scripts', 'run-test-suite.mjs'), ...group.args], worktree);
    fs.writeFileSync(logFile, `${result.stdout}\n${result.stderr}\n[exit ${result.status}]\n`, 'utf8');
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-6).join('\n');
    console.log(tail.split('\n').map((line) => `    ${line}`).join('\n'));
    if (result.status !== 0) {
      exitCode = 1;
      console.log(`==> [${group.name}] 红（exit ${result.status}）｜完整输出 ${logFile}`);
    } else {
      console.log(`==> [${group.name}] 绿｜完整输出 ${logFile}`);
    }
  }
} finally {
  cleanup();
}

console.log(exitCode === 0
  ? `==> check:head PASS @ ${headSha}（干净检出自下跑通，不是工作区自下）`
  : `==> check:head FAIL @ ${headSha} —— 干净检出自下有组红；上面每一组的完整输出都在 ${logRoot}`);
process.exit(exitCode);
