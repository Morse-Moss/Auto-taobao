// 守卫：套件 runner 的**卡死看门狗**（2026-10-29 加）。
//
// 为什么需要这一份：2026-10-29 实测两次「`npm run test:runtime` 输出停在半路、永远不返回」。
// 现场取证（`Get-CimInstance Win32_Process` + `Get-Process -Id`）：
//   两个 `node --test <file>` 子进程还活着，但 CPU 累计只有 0.02–0.08 秒、线程数 3
//   ⇒ 它们**连测试文件都没加载完**，卡在进程启动阶段；把这两个文件单独重跑 1.35 秒全绿。
//   ⇒ 既不是「测试在跑只是慢」，也不是「句柄泄漏导致进程不退出」（后者会先打完 TAP 汇总再挂着）。
//
// 缺陷在 runner 这一侧：它没有任何「多久没输出就不对」的判据，于是同一种卡死
// 在 CI 里表现为「这个 job 永远不结束」——既不是红也不是绿，也没人去杀。
//
// 这条用例钉的是**形状**（有没有这条能力、失败时给什么退出码），不是阈值细节：
// 阈值将来要调就调，判据不该跟着改。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-test-suite.mjs');
const SRC = readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n');

// 这一条是 2026-10-29 当天自己踩出来的：上面那条守卫**只读源码文本**，
// 所以当 runSuite 里写了一个少 `:` 的三元表达式时，守卫 3/3 全绿、而 runner 一跑就
// `SyntaxError: Unexpected token ';'`。源码文本型判据必须配一条**真的解析一次**，
// 否则「守卫绿」与「文件能跑」是两件互相独立的事。
test('runner 必须能被 node 真的解析（源码文本型守卫的盲区）', () => {
  const parsed = spawnSync(process.execPath, ['--check', RUNNER], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  });
  const detail = `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim().split('\n').slice(0, 4).join(' | ');
  assert.equal(parsed.status, 0, `scripts/run-test-suite.mjs 解析失败（退出码 ${parsed.status}）：${detail}`);
});

const bodyOf = (text, startMark, endMark) => {
  const start = text.indexOf(startMark);
  if (start < 0) return null;
  const end = text.indexOf(endMark, start);
  return end > 0 ? text.slice(start, end) : text.slice(start);
};

test('runner 必须有卡死看门狗：长时间没输出就杀子进程并给 exit 3', () => {
  const body = bodyOf(SRC, 'function runSuite(', '\nconst argv =');
  assert.ok(body, '找不到 runSuite —— 名字变了的话这条用例要跟着更新');

  const judge = (text) => {
    const fn = bodyOf(text, 'function runSuite(', '\nconst argv =');
    if (!fn) return null;
    return {
      // 必须能观测「有没有输出」：stdio:'inherit' 直连控制台是观测不到静默的。
      pipesStdio: fn.includes("stdio: ['ignore', 'pipe', 'pipe']"),
      // 必须有「最后一次有输出的时间」这个东西，并且被看门狗读来判断静默时长。
      tracksLastOutput: /lastOutputAt\s*=\s*Date\.now\(\)/u.test(fn),
      // 超时后必须真的杀子进程（只打印不杀 = 仍然挂着）。
      kills: /killTree\(\);/u.test(fn),
      // 而且要杀**整棵**树：实测卡住的恰恰是 node --test 自己拉起的测试进程，
      // 只 kill 父进程会把它们留成孤儿（runner 退了、机器上还挂着 CPU≈0 的 node）。
      killsTree: /taskkill/u.test(fn) && /'\/T'/u.test(fn),
      // 静默判定必须与「子进程还活着」联动，否则正常结束的进程也会被判卡死。
      guardsExited: /child\.exitCode\s*!==\s*null/u.test(fn),
      exitsIncomplete: /resolve\(INCOMPLETE_EXIT\)/u.test(fn),
    };
  };

  const facts = judge(SRC);
  assert.equal(facts.pipesStdio, true,
    "runSuite 必须用管道接子进程输出（stdio:['ignore','pipe','pipe']）—— 直连控制台就观测不到「静默」");
  assert.equal(facts.tracksLastOutput, true, '必须记录最后一次收到输出的时间，看门狗才有判据');
  assert.equal(facts.kills, true, '静默超时后必须真的杀掉子进程：只打印一行日志的话这一轮仍然挂着');
  assert.equal(facts.killsTree, true,
    '必须杀整棵进程树（Windows: taskkill /T /F）—— 卡住的是 node --test 拉起的测试进程，只杀父进程会留孤儿');
  assert.equal(facts.guardsExited, true, '判卡死要看「子进程是否还活着」，否则正常退出的进程也会被算成卡死');
  assert.equal(facts.exitsIncomplete, true, '卡死必须落到 exit 3 = INCOMPLETE，不许读成通过或失败');

  // 退出码语义（与 npm run test:staged 超预算一致）：3 = 无判定。
  assert.match(SRC, /const INCOMPLETE_EXIT = 3;/u, 'INCOMPLETE 必须是 3（与 test:staged 超预算同一套语义）');

  // 反向自证：把看门狗里那句 killTree() 去掉，判据必须转红 —— 否则上面几条只是「源码里恰好有这些字」。
  const broken = SRC.replace(/^\s*killTree\(\);\s*$/mu, '');
  assert.notEqual(broken, SRC, '反向自证没生效：没匹配到 killTree() 那行（源码形状变了？）');
  assert.equal(judge(broken).kills, false,
    '守卫自证失败：去掉杀进程那行后判据仍为真 ⇒ 判据没在判东西');
});

test('所有套件调用都必须 await runSuite（它返回 Promise，不 await 会拿到 undefined）', () => {
  // 这是最容易静默出错的一处：`status = runSuite(...)` 拿到的是 Promise，
  // 既非 0 也非非 0 ⇒ `process.exit(status)` 会把一个对象当退出码，判读全废。
  const awaited = [...SRC.matchAll(/status = await runSuite\(/gu)].length;
  const bare = [...SRC.matchAll(/status = runSuite\(/gu)].length;
  assert.equal(bare, 0, `还有 ${bare} 处没 await runSuite ⇒ 退出码会变成 Promise 对象`);
  assert.equal(awaited, 5, `五个调用点（skills、unit 的两段、runtime、integration）都要 await，实际 ${awaited} 处`);
  assert.match(SRC, /process\.exit\(status\);/u, '收尾仍要把 status 交出去（不能退化成无条件 0）');
});

test('--stall-ms 只接受非负整数，且必须覆盖各档默认值', () => {
  assert.match(SRC, /--stall-ms=/u, '要能调阈值（排查期可能需要临时关掉）');
  assert.match(SRC, /--stall-ms must be a non-negative integer/u, '非法值要显式拒绝，不许静默取默认值');
  assert.match(SRC, /const stallFor = \(suiteName\) => \(stallArg \? Number\(stallArg\.split\('='\)\[1\]\) : defaultStallFor\(suiteName\)\);/u,
    '显式参数必须能覆盖各档默认值 —— 解析了但没用＝没这条能力');
  // 五个调用点（skills、unit 两段、runtime、integration）都必须经 stallFor 取阈值，
  // 少一处就是那一档永远没有判据。
  const viaStallFor = [...SRC.matchAll(/stallMs: stallFor\('/gu)].length;
  assert.equal(viaStallFor, 5, `五个调用点都要经 stallFor 取阈值，实际 ${viaStallFor} 处`);
  assert.doesNotMatch(SRC, /\{ stallMs \}/u, '不许再直接把一个全局 stallMs 传下去（那样各档就没区别了）');
});

/**
 * 默认值这一档最要紧：**只有 runtime 开**。
 *
 * 反例的代价是真实的：skills/unit/integration 里有以子进程启动真实 CLI、等它自己 60 分钟
 * 下载截止的用例（2026-09-25 实测一次选择跑 7.6 小时）。在那些档位套 180 秒判据，
 * 会把「合法地安静」判成「死了」，制造出一个比原来的干等更糟的误报源 ——
 * 而误报会直接训坏判读习惯（以后见到 exit 3 就当噪声忽略）。
 */
test('卡死判据默认只给 runtime 档开，别的档必须默认关', () => {
  assert.match(SRC, /function defaultStallFor\(suiteName\) \{\s*\n\s*return suiteName === 'runtime' \? STALL_DEFAULT_MS : 0;/u,
    'defaultStallFor 必须「只对 runtime 给阈值，其余返回 0」—— 放宽到 skills 会把慢判成死');
  assert.match(SRC, /const STALL_DEFAULT_MS = 180000;/u, 'runtime 档的阈值缺了（实测全量 34 秒、最慢单文件 4.9 秒）');
  assert.match(SRC, /const stallMs = options\.stallMs \?\? 0;/u,
    'runSuite 自己的兜底必须是 0（不传＝不开），否则「按档关」这件事在函数内部就被破了');
});
