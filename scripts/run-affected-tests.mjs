import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function classifyChangedFiles(files) {
  const normalized = files.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''));
  const checks = new Set();

  for (const file of normalized) {
    if (file.endsWith('.md') || file.startsWith('evidence/')) {
      checks.add('docs');
      continue;
    }
    if (file === 'package.json' || file === 'package-lock.json' || file.startsWith('.github/')) {
      checks.add('unit');
      continue;
    }
    if (file.startsWith('agent-runtime/')) {
      checks.add('agent-runtime');
      continue;
    }
    if (file.startsWith('runtime/')) {
      checks.add(file.endsWith('.test.mjs') ? 'runtime-file' : 'runtime');
      continue;
    }
    const skillMatch = file.match(/^skills\/([^/]+)\//);
    if (skillMatch) {
      checks.add(`skill:${skillMatch[1]}`);
      continue;
    }
    if (file.endsWith('.mjs') || file.endsWith('.cjs') || file.endsWith('.js') || file.endsWith('.py')) {
      checks.add('unit');
    }
  }
  return [...checks].sort();
}

export function selectChecks(files) {
  const checks = classifyChangedFiles(files);
  const commands = [];
  const add = (command, args) => {
    const key = [command, ...args].join('\u0000');
    if (!commands.some((item) => item.key === key)) commands.push({ key, command, args });
  };

  if (checks.includes('unit')) add(npmCommand, ['run', 'test:unit']);
  if (checks.includes('runtime')) add(npmCommand, ['run', 'test:runtime']);
  for (const file of files.map((item) => item.replaceAll('\\', '/'))) {
    const skillTest = file.match(/^skills\/([^/]+)\/.*\.test\.mjs$/);
    if (skillTest) add('node', ['--test', file]);
    if (file.match(/^skills\/[^/]+\/.*(?:test_.*|.*_test)\.py$/)) {
      add('py', ['-3', '-m', 'unittest', file, '-q']);
    }
  }
  for (const check of checks.filter((item) => item.startsWith('skill:'))) {
    const skill = check.slice('skill:'.length);
    const hasImplementationChange = files.some((file) => {
      const normalized = file.replaceAll('\\', '/');
      return normalized.startsWith(`skills/${skill}/`) && !normalized.endsWith('.test.mjs') && !normalized.match(/(?:test_.*|.*_test)\.py$/);
    });
    if (hasImplementationChange) add('node', ['scripts/run-test-suite.mjs', 'skills', `--skill=${skill}`]);
  }
  for (const file of files.map((item) => item.replaceAll('\\', '/'))) {
    if (file.startsWith('runtime/') && file.endsWith('.test.mjs')) add('node', ['--test', file]);
  }
  if (checks.includes('runtime')) {
    add(npmCommand, ['run', 'test:runtime']);
  }
  if (checks.includes('agent-runtime')) add('npm', ['run', 'test:agent-runtime']);
  return { checks, commands };
}

function changedFilesFromGit(base, staged) {
  // `stdio` 必须显式写、且 stdin 只能是 `'ignore'`（2026-09-25，同 CHANGELOG 1.7.1）：
  // 宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回 `EBUSY`，而默认 stdio 三根都是管道
  // ⇒ **门禁自己在沙箱会话里跑不起来**（报 `spawnSync git EBUSY`，看起来像 git 坏了）。
  const GIT_STDIO = ['ignore', 'pipe', 'pipe'];
  if (staged) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: root,
      encoding: 'utf8',
      stdio: GIT_STDIO,
    }).split(/\r?\n/).filter(Boolean);
  }
  if (base) {
    return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      stdio: GIT_STDIO,
    }).split(/\r?\n/).filter(Boolean);
  }
  const status = execFileSync('git', ['status', '--porcelain=v1'],
    { cwd: root, encoding: 'utf8', stdio: GIT_STDIO });
  return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).flatMap((file) => {
    if (file.includes(' -> ')) return [file.split(' -> ').at(-1)];
    return [file];
  });
}

function parseArgs(argv) {
  const base = argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) || '';
  const explicit = argv.find((arg) => arg.startsWith('--files='))?.slice('--files='.length) || '';
  return { base: base || null, files: explicit ? explicit.split(',').filter(Boolean) : null, dryRun: argv.includes('--dry-run'), staged: argv.includes('--staged') };
}

// 时间预算：这道门必须在有限时间内给出结论，或者**明确承认自己没有结论**。
//
// 为什么必须有（2026-09-25 实测，8 小时 2 分的现场）：
//   `test:staged` 选到 `skills/xws-export-market-analysis/` 的实现改动时，会走
//   `run-test-suite.mjs skills --skill=…`，把该技能**整个测试文件**拉进来。那次一共跑了 664 条用例、
//   合计 7.64 小时，其中 `prepare-flow.test.mjs` 的 7 条 `full flow …` 用例**每条各烧约 60 分钟**
//   （日志：61.9 / 61.4 / 60.6 / 60.6 / 60.6 / 60.4 / 60.4 分，全是 CLI 自己的下载 deadline
//   `Timed out waiting for .csv download`）—— 而这 7 条吃掉了总时长的 92%。
//   后果不是「慢」，是**没人盯得住**：它在后台跑了 8 小时才被发现，期间谁都不知道门禁还在跑。
//
// 口径（沿用本仓已经立过的那一条）：**没给出结论既不是通过、也不是失败**，所以退出码单列 3，
// 而不是伪装成 0（假绿）或 1（假红）。被预算砍掉的那一刻，已跑完的部分结论仍然打出来了，
// 只是这道门整体上「不完整」。
const DEFAULT_BUDGET_SECONDS = 1800;
const EXIT_INCOMPLETE = 3;

function parseBudgetSeconds(argv) {
  const raw = argv.find((arg) => arg.startsWith('--budget-seconds='));
  if (raw === undefined) return DEFAULT_BUDGET_SECONDS;
  const value = raw.slice('--budget-seconds='.length);
  if (!/^\d+$/.test(value)) throw new Error(`--budget-seconds 要一个 ≥0 的整数（0＝不限），收到 ${JSON.stringify(value)}`);
  return Number(value);
}

// 超预算时不能只杀直接子进程：npm.cmd → node → … 是一条链，杀掉最上层会留下一堆孤儿
// （2026-09-25 就是这么留下了一棵跑了 8 小时的树）。Windows 用 taskkill /T 连根拔。
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      // stdio 必须显式写：宿主沙箱对默认三管道的同步 spawn 回 EBUSY（同 CHANGELOG 1.7.1）。
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } catch {
    // 杀不掉也要继续往下走：这里的目标是「别挂住」，不是「保证杀干净」。
  }
}

function runWithBudget(item, budgetMs) {
  return new Promise((resolve) => {
    const child = spawn(item.command, item.args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32' && item.command.endsWith('.cmd'),
    });
    let timedOut = false;
    const timer = budgetMs > 0
      ? setTimeout(() => {
        timedOut = true;
        console.log(`\n==> affected tests: OVER BUDGET（${Math.round(budgetMs / 1000)} 秒）—— 正在连根终止这棵进程树`);
        killTree(child);
      }, budgetMs)
      : null;
    const finish = (status, error) => {
      if (timer) clearTimeout(timer);
      if (error) throw error;
      resolve({ timedOut, status });
    };
    child.on('error', (error) => finish(1, error));
    child.on('close', (status) => finish(status, null));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const { base, files: explicit, dryRun, staged } = parseArgs(args);
  let budgetSeconds;
  try {
    budgetSeconds = parseBudgetSeconds(args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const files = explicit || changedFilesFromGit(base, staged);
  if (files.length === 0) {
    console.log('==> affected tests: no changed files');
    return 0;
  }
  const selection = selectChecks(files);
  console.log(`==> affected tests: ${files.length} changed file(s)`);
  console.log(`==> affected checks: ${selection.checks.join(', ') || 'none'}`);
  console.log(`==> budget: ${budgetSeconds === 0 ? '不限' : `${budgetSeconds} 秒/条命令`}`
    + '（超预算＝这道门没有结论，退出码 3；放宽用 --budget-seconds=<秒>）');
  if (dryRun) {
    for (const item of selection.commands) console.log(`  ${item.command} ${item.args.join(' ')}`);
    return 0;
  }
  for (const item of selection.commands) {
    const { timedOut, status } = await runWithBudget(item, budgetSeconds * 1000);
    if (timedOut) {
      console.log('');
      console.log('==> affected tests: INCOMPLETE（超时间预算被强制终止）');
      console.log(`    命令：${item.command} ${item.args.join(' ')}`);
      console.log('    含义：这道门**没有给出结论** —— 既不是通过，也不是失败。别把它当绿，也别当红。');
      console.log('    怎么办：单独把这一条跑完并盯着它（它本来就可能要几十分钟），例如');
      console.log(`      ${item.command} ${item.args.join(' ')}`);
      console.log(`    放宽预算：npm run test:staged -- --budget-seconds=${budgetSeconds * 4}`);
      return EXIT_INCOMPLETE;
    }
    if ((status ?? 1) !== 0) return status ?? 1;
  }
  console.log('==> affected tests: PASS');
  return 0;
}

// 不用顶层 await：本仓的语法自检（scripts/check-fast.mjs）过不去，且顶层 await 会让本模块
// 变成异步模块，对只 import `classifyChangedFiles`/`selectChecks` 的测试没有必要。
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
