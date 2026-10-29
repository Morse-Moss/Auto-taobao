// Suite runner for the repository test layers.
//
// Why this exists: the repository has 98 test files but no package-level entry
// point that runs them. Discovery here is directory-based (not hardcoded file
// lists) so that new tests are picked up automatically, and the exclusion
// registry below is the single, auditable place that decides which tests are
// offline-safe versus gated on external systems.
//
// Suites:
//   unit        - all skill tests that need no browser, proxy, clipboard or DB
//   skills      - the skill-test half of `unit` (used by CI to parallelise)
//   runtime     - all runtime/*.test.mjs (verified offline-clean)
//   integration - exactly the files excluded above, run in one place
//
// Usage: node scripts/run-test-suite.mjs <unit|runtime|integration> [--concurrency=N] [--dry-run] [--stall-ms=N]
//
// --concurrency=N passes --test-concurrency through. The
// xws-export-market-analysis suite spawns the real CLI against fake proxies
// and contains stall/deadline timing tests that can flake when many files run
// in parallel on a loaded machine; use --concurrency=1 to reproduce a quiet
// run before treating any failure there as a regression.
//
// --dry-run prints the resolved file list per suite and exits without running
// anything, so the exclusion partition stays auditable.
//
// --stall-ms=N kills the run and exits 3 = INCOMPLETE when the child has produced
// no output for that long. The per-suite default is on for `runtime` only
// (180s, that suite's profile is measured) and off elsewhere — see defaultStallFor.
// It exists because a silent stall used to hang forever with no verdict; the
// measured 2026-10-29 evidence is in the long comment above runSuite.
//
// --isolation=none|process: runtime defaults to `none` (all files in one process,
// zero spawned test children) because the 2026-10-29 stalls were in *process
// creation*, not in the tests; measured 142 files / 1554 cases in 51.8s, green,
// first try. Every other suite defaults to `process` — a shared process is a looser
// environment and can hide cross-file pollution, so `process` stays the authority.
// The two profiles must agree on the case count; `npm run verify:runtime-parity`
// checks exactly that, and it is the only thing standing between "single process is
// faster" and "single process quietly fakes a green".
//
// Conventions honoured from docs/standards/README.md:
//   - explicit file lists are preferred over shell glob expansion on Windows;
//   - integration tests must report "skipped" (not pass) when their external
//     system is unavailable, so the suite never fakes a green result.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { discoverRuntimeTests, discoverSkillTests } from './test-suite-discovery.mjs';

const root = path.resolve(import.meta.dirname, '..');

// Files that must never run in the offline suites, with the reason they are
// gated. Every entry here is run by the `integration` suite instead.
const EXCLUSIONS = [
  {
    file: 'skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs',
    reason: 'integration: drives the live merchant-chain CDP proxy (see runtime/browser-ports.mjs), the real Windows clipboard, and real browser tabs',
  },
  {
    file: 'skills/xws-export-market-analysis/tests/postgres-state.test.mjs',
    reason: 'integration: requires XWS_TEST_DATABASE_URL; skips itself when unset',
  },
];

// 测试发现与「哪个目录归哪个套件」现在住在 scripts/test-suite-discovery.mjs ——
// 抽出去是为了让 runtime 测试能断言它（见 runtime/test-suite-discovery.test.mjs）。
// 那边的登记表必须恰好覆盖 runtime/ 下所有含测试的子目录；漏一个会红，而不是静默不跑。
//
// --- 卡死看门狗（2026-10-29 加）------------------------------------------------
// 缺陷形态（实测两次，2026-10-29）：
//   `npm run test:runtime` 输出停在半路（最后一次是 `ok 211`），`# fail 0`，然后**永远不返回**。
//   现场取证：`Get-CimInstance Win32_Process` 看到两个 `node --test <file>` 子进程还活着，
//   但 CPU 累计只有 0.02–0.08 秒、线程 3 个 ⇒ 它们**连测试文件都没加载完**，是卡在进程启动阶段；
//   把这两个文件单独跑（`node --test a.mjs b.mjs`）1.35 秒全绿。
//   ⇒ 不是「测试在跑只是慢」，不是「句柄泄漏导致进程不退出」（那种形态会先打完 TAP 汇总再挂着），
//     而是**子进程启动被环境卡住**（本机是 141 个文件连续/并发 spawn 的场景下偶发，约 1–2%）。
// 为什么这算仓库的缺陷而不只是环境的：runner 此前没有任何「多久没输出就不对」的判据，
//   所以一次卡死就要人手工去查进程表、再杀进程 —— 在 CI 里表现为「这个 job 永远不结束」，
//   既不是红也不是绿。有判据之后，同一种卡死变成一个**有名字的结论**（exit 3 = INCOMPLETE，
//   与 `npm run test:staged` 超预算的语义一致：无判定，不许读成通过或失败）。
// 阈值取 180 秒：本套件最慢的文件实测 4.9 秒（run-flow-orchestrator），全量 34 秒；
//   ⚠️ 只给 runtime 档默认开，别的档默认关 —— 那里有合法的长静默，理由见 defaultStallFor 上方。
//   180 秒的空档远大于任何「正常的安静期」，误杀概率极低；而真卡住时它把 8 分钟+的干等变成 3 分钟。
const STALL_DEFAULT_MS = 180000;
const INCOMPLETE_EXIT = 3;

/**
 * 各档的默认静默阈值（0 = 关）。
 *
 * 只有 runtime 这一档有实测画像（141 个文件 34 秒、最慢单文件 4.9 秒），所以只给它默认开。
 * skills/unit/integration 默认关，理由是那里有**合法的长时间静默**：这些目录里有用例以子进程
 * 启动真实 CLI、等它自己的 60 分钟下载截止（2026-09-25 实测一次选择跑了 7.6 小时，92% 花在
 * 7 个这样的用例上）。在那种档位套 180 秒判据，等于把「慢」判成「死」，制造一个比干等更糟的误报源。
 * 要开就显式给 `--stall-ms`；将来量到某一档的画像再改这里的默认值。
 */
function defaultStallFor(suiteName) {
  return suiteName === 'runtime' ? STALL_DEFAULT_MS : 0;
}

/**
 * 各档默认的**隔离方式**（2026-10-29 加）。
 *
 * none    = 所有测试文件在同一个进程里跑，**一个子进程都不 spawn**；
 * process = 每个文件一个子进程（node --test 的默认行为）。
 *
 * 为什么 runtime 档默认走 none：实测（2026-10-29，142 文件 / 1555 用例）
 *   - 一次 spawn 全量：正常 34–60 秒，但当天 4/4 轮卡在**子进程启动**（CPU 0.02–0.08 秒、线程 3 个），
 *     一次都没拿到完整结果；
 *   - 逐文件 142 次 spawn：4 分 45 秒（每文件付一次 node 启动成本）；
 *   - 单进程 none：**51.8 秒、1555/1555 绿、exit 0，一次跑完不卡**。
 *   卡的是进程创建本身，不是在跑的测试 —— 那就不创建。快慢是附加值，稳才是理由。
 *
 * 为什么别的档仍然 process：
 *   假绿风险是真实的 —— 单进程里所有文件共享全局状态（process.env、process.chdir、模块级可变状态、
 *   全局句柄），一个文件改了不还原，后面的文件就在宽松环境下通过。隔离口径更严格，是权威口径。
 *   runtime 这一档敢换，是因为两个口径的**用例数逐值相同**（1555 = 1555），说明当前这批文件没有互相污染；
 *   这条等式靠 `npm run verify:runtime-parity` 定期复核，不许只信「今天绿了」。
 *   skills/unit 的 skills 半段/integration 里有用例真起子进程、真监听端口，单进程跑会互相踩，更不能换。
 */
function defaultIsolationFor(suiteName) {
  return suiteName === 'runtime' ? 'none' : 'process';
}

function runSuite(files, label, extraArgs = [], options = {}) {
  if (files.length === 0) {
    console.log(`==> ${label}: no test files`);
    return 0;
  }
  console.log(`==> ${label}: ${files.length} file(s)`);
  const stallMs = options.stallMs ?? 0;
  const isolation = options.isolation === 'process' ? 'process' : 'none';
  const isolationArgs = isolation === 'none'
    ? ['--experimental-test-isolation=none', '--test-force-exit']
    : [];
  console.log(`==> ${label}: 隔离方式=${isolation === 'none'
    ? '单进程（不 spawn 测试子进程）'
    : '每个文件一个子进程'}${isolation === 'none' ? '｜--test-force-exit（跑完强制退出，残留句柄不许拖住整轮）' : ''}`);
  const started = Date.now();
  let lastOutputAt = started;
  // 汇总出现＝这一轮已经跑完（只是进程可能还没退）。看门狗靠这个区分两种「没动静」。
  let sawSummary = false;
  let summaryFail = null;
  const scanSummary = (text) => {
    if (sawSummary) return;
    if (!/# fail \d+/u.test(text) && !/^1\.\.\d+/mu.test(text)) return;
    sawSummary = true;
    const m = text.match(/# fail (\d+)/u);
    if (m) summaryFail = Number(m[1]);
  };
  const child = spawn(process.execPath, ['--test', ...isolationArgs, ...extraArgs, ...files], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // 原样转发子进程输出：内容一个字不改，只记「最后一次有输出是什么时候」。
  // （原来用 stdio:'inherit' 直连控制台，那样拿不到任何时间信号，也就没法判断卡没卡。）
  child.stdout.on('data', (chunk) => {
    lastOutputAt = Date.now();
    const text = chunk.toString();
    scanSummary(text);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => { lastOutputAt = Date.now(); process.stderr.write(chunk); });

  // 杀**整棵**子进程树，不是只杀那一个 pid（2026-10-29：实测卡住的恰恰是 `node --test` 自己
  // 拉起的测试进程 —— 只 kill 父进程会把它变成孤儿：runner 退出了，机器上还挂着两个 CPU≈0 的 node）。
  // Windows 用 `taskkill /T /F`（/T 才是那棵树），其余平台按进程组发信号。
  const killTree = () => {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 15000,
        });
        return;
      } catch { /* 退回到单进程 kill */ }
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 没有独立进程组 */ }
    try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
  };

  let stalled = null;
  let watchdog = null;
  const onStall = () => {
    const idle = Date.now() - lastOutputAt;
    // 子进程已经退出就什么都不做（正常结束不该被判卡死）。
    if (idle < stallMs || child.exitCode !== null) return;
    stalled = { idle, elapsed: Date.now() - started };
    if (watchdog) clearInterval(watchdog);
    if (sawSummary) {
      // 2026-10-29 加的第二档：**汇总已经打出来了，只是进程不退**（残留句柄/连接没关）。
      // 这与「卡在启动」是两件不同的事，不能一起报成「卡死」——
      // 单进程模式下尤其明显：测试全绿、结论已经确定，只是进程收不了尾。
      // 判据要按已打出的汇总来，不许因为「进程不退」把一次全绿说成无判定。
      console.error(`\n[收尾] ${label}：汇总已打完，但进程 ${Math.round(idle / 1000)} 秒没退出（残留句柄没关）`
        + `｜按已打出的汇总判结果：# fail ${summaryFail ?? '?'}`);
      console.error('[收尾] 这不是测试失败；杀进程后按汇总返回。要根治就在对应测试里关掉那个句柄。');
      killTree();
      return;
    }
    console.error(`\n[卡死] ${label}：${Math.round(idle / 1000)} 秒没有任何输出（已跑 ${Math.round(stalled.elapsed / 1000)} 秒），判定子进程启动/运行被卡住`);
    console.error(`[卡死] 这不是测试失败。${files.length} 个文件由**同一个** node --test 拉起，`);
    console.error('[卡死] 想知道卡在哪个文件：趁着它还在，另开一个终端跑');
    console.error("[卡死]   Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select ProcessId,CommandLine");
    console.error('[卡死] 把还挂着的 `node --test <file>` 单独重跑一次即可判定（实测这类卡死重跑必过）。');
    console.error(`[卡死] 退出码 ${INCOMPLETE_EXIT} = INCOMPLETE（无判定），不许读成通过或失败。`);
    killTree();
  };
  if (stallMs > 0) {
    // 探测间隔取阈值的 1/6（夹在 1–5 秒之间）：够密，又不至于把 timer 本身变成负担。
    const tickMs = Math.min(5000, Math.max(1000, Math.floor(stallMs / 6)));
    watchdog = setInterval(onStall, tickMs);
    if (watchdog.unref) watchdog.unref();
  }

  return new Promise((resolve) => {
    // 起不来（node 路径不对之类）也归「没有判定」，不再往上层 throw ——
    // 这个 runner 的契约是「一定给出一个退出码」，把它变成未捕获异常会让调用方只看到一段栈。
    child.on('error', (error) => {
      if (watchdog) clearInterval(watchdog);
      console.error(`[起不来] ${label}：${error?.message ?? error}`);
      resolve(INCOMPLETE_EXIT);
    });
    child.on('close', (code, signal) => {
      if (watchdog) clearInterval(watchdog);
      // 「汇总已打出、被我们杀掉收尾」这一支按汇总判，不按信号判。
      if (stalled && sawSummary) return resolve(summaryFail === 0 ? 0 : 1);
      if (stalled) return resolve(INCOMPLETE_EXIT);
      if (signal) {
        console.error(`[中断] ${label} 的子进程收到 ${signal}（不是测试失败，也没有判定）`);
        return resolve(INCOMPLETE_EXIT);
      }
      resolve(code ?? 1);
    });
  });
}

const argv = process.argv.slice(2);
const suite = argv.find((value) => !value.startsWith('--'));
const concurrencyArg = argv.find((value) => value.startsWith('--concurrency='));
const skillArg = argv.find((value) => value.startsWith('--skill='));
const stallArg = argv.find((value) => value.startsWith('--stall-ms='));
const isolationArg = argv.find((value) => value.startsWith('--isolation='));
const dryRun = argv.includes('--dry-run');
const extraArgs = concurrencyArg ? [`--test-concurrency=${concurrencyArg.split('=')[1]}`] : [];
if (concurrencyArg && !/^\d+$/.test(concurrencyArg.split('=')[1])) {
  console.error('--concurrency must be a positive integer');
  process.exit(2);
}
// 显式给 `--stall-ms=N` 就一律覆盖（0 = 关）；不给就按档取默认值（见 defaultStallFor）。
if (stallArg && !/^\d+$/.test(stallArg.split('=')[1])) {
  console.error('--stall-ms must be a non-negative integer (0 = disable the stall watchdog)');
  process.exit(2);
}
const stallFor = (suiteName) => (stallArg ? Number(stallArg.split('=')[1]) : defaultStallFor(suiteName));
// 隔离方式的解析：显式给了就一律覆盖；不给按档取默认（见 defaultIsolationFor）。
if (isolationArg && !/^--isolation=(none|process)$/u.test(isolationArg)) {
  console.error('--isolation must be either none or process');
  process.exit(2);
}
const isolationFor = (suiteName) => (isolationArg
  ? isolationArg.split('=')[1]
  : defaultIsolationFor(suiteName));
const skillTests = discoverSkillTests();
if (skillArg) {
  const skillName = skillArg.split('=')[1] || '';
  const prefix = `skills/${skillName}/`;
  const filtered = skillTests.filter((file) => file.startsWith(prefix));
  if (!skillName || filtered.length === 0) {
    console.error(`--skill: no offline test files found for "${skillName}"; pass a directory name under skills/`);
    process.exit(2);
  }
  skillTests.length = 0;
  skillTests.push(...filtered);
}
const runtimeTests = discoverRuntimeTests();
const excluded = new Map(EXCLUSIONS.map((entry) => [entry.file, entry.reason]));

function partition(files) {
  const offline = [];
  const gated = [];
  for (const file of files) {
    (excluded.has(file) ? gated : offline).push(file);
  }
  return { offline, gated };
}

const skills = partition(skillTests);
const runtime = partition(runtimeTests);

function printList(label, files) {
  console.log(`${label}: ${files.length}`);
  for (const file of files) console.log(`  ${file}`);
}

let status = 0;
if (dryRun) {
  if (!suite) {
    printList('unit:skills', skills.offline);
    printList('unit:runtime', runtime.offline);
    printList('integration', [...skills.gated, ...runtime.gated]);
  } else if (suite === 'unit') {
    printList('unit:skills', skills.offline);
    printList('unit:runtime', runtime.offline);
  } else if (suite === 'skills') {
    printList('skills', skills.offline);
  } else if (suite === 'runtime') {
    printList('runtime', runtime.offline);
  } else if (suite === 'integration') {
    printList('integration', [...skills.gated, ...runtime.gated]);
  } else {
    console.error(`unknown suite: ${suite}`);
    status = 2;
  }
  process.exit(status);
}

if (suite === 'skills') {
  status = await runSuite(skills.offline, 'skills', [], { stallMs: stallFor('skills'), isolation: isolationFor('skills') });
} else if (suite === 'unit') {
  for (const [file, reason] of excluded) {
    console.log(`    excluded from offline suites: ${file} (${reason})`);
  }
  status = await runSuite(skills.offline, 'unit:skills', [], { stallMs: stallFor('skills'), isolation: isolationFor('skills') });
  if (status === 0) status = await runSuite(runtime.offline, 'unit:runtime', [], { stallMs: stallFor('runtime'), isolation: isolationFor('runtime') });
} else if (suite === 'runtime') {
  status = await runSuite(runtime.offline, 'runtime', [], { stallMs: stallFor('runtime'), isolation: isolationFor('runtime') });
} else if (suite === 'integration') {
  const gated = [...skills.gated, ...runtime.gated];
  console.log('    NOTE: these tests need external systems and may fail fast when unavailable:');
  for (const file of gated) console.log(`      ${file} - ${excluded.get(file)}`);
  status = await runSuite(gated, 'integration', [], { stallMs: stallFor('integration'), isolation: isolationFor('integration') });
} else {
  console.error('usage: node scripts/run-test-suite.mjs <unit|skills|runtime|integration> [--concurrency=N] [--stall-ms=N] [--isolation=none|process]');
  console.error('  unit        - offline skill + runtime tests (no browser, proxy, clipboard or DB)');
  console.error('  skills      - the skill-test half of unit only');
  console.error('  runtime     - runtime/*.test.mjs only');
  console.error('  integration - the gated files that offline suites exclude');
  console.error(`  --stall-ms  - kill the run when it has been silent this long; overrides the per-suite default (runtime ${Math.round(STALL_DEFAULT_MS / 1000)}s, others off); exit 3 = INCOMPLETE`);
  console.error('  --isolation - none = 全部文件在同一个进程里跑（runtime 档默认，不 spawn 子进程）');
  console.error('                process = 每个文件一个子进程（其余档默认，更严格，是权威口径）');
  process.exit(2);
}

process.exit(status);
