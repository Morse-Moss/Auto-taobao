#!/usr/bin/env node
// 两个隔离口径的**用例数必须一致**（2026-10-29 加）。
//
// 为什么需要它：`test:runtime` 从 2026-10-29 起默认走单进程（`--isolation=none`），
// 为的是绕开「142 次子进程创建偶发卡死」。单进程更快更稳，但它**更宽松**：
// 所有文件共享一个进程（process.env、process.chdir、模块级可变状态、全局句柄），
// 一个文件改了不还原，后面的文件就在一个不干净的环境里通过 —— 那就是假绿。
//
// 所以判据不是「单进程绿了」，而是「两个口径数出来的是同一件事」：
//   用例数（`# tests`）相等、通过数（`# pass`）相等、失败数（`# fail`）相等。
// 只要有一条不等，就说明有文件在单进程下被别的文件影响了，必须先查清再谈速度。
//
// 两个口径都经 `scripts/run-test-suite.mjs` 跑，所以都带静默看门狗：
// 哪一边卡住就是 exit 3 = INCOMPLETE（无判定），不会被这份脚本读成通过。
//
// 本机的现实（2026-10-29 实测 5/5 轮）：**process 口径一次性全量在这台机器上拿不到判定**
// （卡在子进程启动，不是测试问题）。一个永远只能报 INCOMPLETE 的闸门等于没有闸门 ——
// 所以 process 那一边卡住时，自动退到「逐文件分批」再取分母：仍然是每个文件一个子进程
// （隔离口径不变），只是把 142 次 spawn 拆成几批，某批没汇总就重跑那一批。
// 走的哪条路一定会打出来（route 字段），不会把降级说成同一个东西。
//
// 用法：node scripts/verify-runtime-parity.mjs [--process-fallback=batched|none] [--batches=6]
// 退出码：0 = 两口径一致且全绿；1 = 不一致或有失败；3 = 有一边没拿到判定。

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { discoverRuntimeTests } from './test-suite-discovery.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const INCOMPLETE_EXIT = 3;
const MAX_BUFFER = 64 * 1024 * 1024;

const argv = process.argv.slice(2);
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const processFallback = argValue('process-fallback') ?? 'batched';
if (!['batched', 'none'].includes(processFallback)) {
  console.error('--process-fallback must be either batched or none');
  process.exit(2);
}
const batchCount = Number(argValue('batches') ?? 6);
if (!Number.isInteger(batchCount) || batchCount < 1) {
  console.error('--batches must be a positive integer');
  process.exit(2);
}

const PROFILES = [
  { id: 'none', args: ['runtime'], label: '单进程（默认，不 spawn 测试子进程）' },
  { id: 'process', args: ['runtime', '--isolation=process'], label: '每文件一个子进程（权威口径）' },
];

// ⚠️ 取**最后一个**匹配：TAP 汇总永远在最后，前面可能还有断言诊断块里带进来的同样字样
// （2026-10-29：攻击包读 `# fail` 取了第一个匹配，把「红」读成 0，三个突变体误报 GREEN_BAD）。
function readCount(out, pattern) {
  const hits = [...out.matchAll(pattern)].map((m) => Number(m[1]));
  return hits.length ? hits[hits.length - 1] : null;
}

function run(profile) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join('scripts', 'run-test-suite.mjs'), ...profile.args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30 * 60 * 1000,
    maxBuffer: MAX_BUFFER,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const verdict = r.status === INCOMPLETE_EXIT ? 'INCOMPLETE' : (r.status === 0 ? 'green' : 'red');
  return {
    id: profile.id,
    label: profile.label,
    route: '一次性全量',
    code: r.status,
    verdict,
    seconds: Math.round((Date.now() - started) / 100),  // 0.1s 精度
    tests: readCount(out, /# tests (\d+)/gu),
    pass: readCount(out, /# pass (\d+)/gu),
    fail: readCount(out, /# fail (\d+)/gu),
    // 卡死/收尾那两类标记也要带出来：它们是「没有判定」，不是「失败」。
    stalled: /\[卡死\]/u.test(out),
    lingered: /\[收尾\]/u.test(out),
  };
}

// process 口径的降级路线：仍然是每文件一个子进程（隔离不变），只是分批 + 单批重试。
// 判据按每批汇总累加，绝不用「没打汇总 = 0 失败」。
//
// 每一批都给**上限**（`BATCH_TIMEOUT_MS`），因为这里没有看门狗：spawnSync 一旦撞上
// 「卡在子进程启动」，不给 timeout 就是干等。2026-10-29 第一次跑这条降级路线时给了 30 分钟，
// 结果一轮挂在 16 分钟还不返回 —— 有上限才叫判据。实测一整批 24 个文件约 10–20 秒
// （全量 142 文件 34–60 秒），240 秒已经是很宽的上限。
const BATCH_TIMEOUT_MS = 240000;

function runBatchedProcess() {
  const started = Date.now();
  const files = discoverRuntimeTests();
  const size = Math.ceil(files.length / batchCount);
  const batches = [];
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size));

  const runBatch = (list) => {
    const r = spawnSync(process.execPath, ['--test', ...list], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: BATCH_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return {
      code: r.status,
      timedOut: r.error?.code === 'ETIMEDOUT',
      tests: readCount(out, /# tests (\d+)/gu),
      pass: readCount(out, /# pass (\d+)/gu),
      fail: readCount(out, /# fail (\d+)/gu),
      verified: /# fail \d+/u.test(out),
    };
  };

  let tests = 0;
  let pass = 0;
  let fail = 0;
  let unverified = 0;
  for (const [i, list] of batches.entries()) {
    let res = runBatch(list);
    if (!res.verified) res = runBatch(list);   // 单批重试一次：诊断动作，不是掩盖失败
    if (!res.verified) {
      unverified += 1;
      console.log(`  [分批] b${i + 1} ${list.length} 个文件两次都没打出汇总`
        + `${res.timedOut ? `（超 ${Math.round(BATCH_TIMEOUT_MS / 1000)} 秒被中止）` : ''} ⇒ 计入无判定`);
      continue;
    }
    tests += res.tests ?? 0;
    pass += res.pass ?? 0;
    fail += res.fail ?? 0;
  }
  const seconds = Math.round((Date.now() - started) / 100);
  if (unverified > 0) {
    return {
      id: 'process', label: `${PROFILES[1].label}｜分批 ${batches.length} 批`,
      route: '逐文件分批', code: INCOMPLETE_EXIT, verdict: 'INCOMPLETE',
      seconds, tests: null, pass: null, fail: null, stalled: true, lingered: false,
    };
  }
  return {
    id: 'process', label: `${PROFILES[1].label}｜分批 ${batches.length} 批`,
    route: '逐文件分批', code: fail === 0 ? 0 : 1, verdict: fail === 0 ? 'green' : 'red',
    seconds, tests, pass, fail, stalled: false, lingered: false,
  };
}

const results = PROFILES.map((p) => run(p));
if (results[1].verdict === 'INCOMPLETE' && processFallback === 'batched') {
  console.log('\nprocess 口径一次性全量没拿到判定（本机已知：卡在子进程启动）⇒ 退到逐文件分批重取分母。'
    + '隔离口径不变（仍是每文件一个子进程），只是拆批 + 单批重试。\n');
  results[1] = runBatchedProcess();
}

for (const r of results) {
  console.log(`${r.id.padEnd(8)} verdict=${r.verdict} exit=${r.code} ${(r.seconds / 10).toFixed(1)}s `
    + `tests=${r.tests ?? '?'} pass=${r.pass ?? '?'} fail=${r.fail ?? '?'}`
    + `｜route=${r.route}${r.stalled ? ' 卡死' : ''}${r.lingered ? ' 汇总后不退出' : ''}`);
  console.log(`         ${r.label}`);
}

const [a, b] = results;
const lacksVerdict = results.filter((r) => r.verdict === 'INCOMPLETE');
if (lacksVerdict.length) {
  console.error(`\nINCOMPLETE：${lacksVerdict.map((r) => r.id).join('、')} 没拿到判定（卡死/中断），`
    + '这不是失败也不是通过 —— 先把它跑通才有资格比。');
  process.exit(INCOMPLETE_EXIT);
}
if (results.some((r) => r.verdict === 'red')) {
  console.error('\n有口径是红的：先修红的那一边，再谈两口径是否一致。');
  process.exit(1);
}

const mismatch = [
  ['tests', a.tests, b.tests],
  ['pass', a.pass, b.pass],
  ['fail', a.fail, b.fail],
].filter(([, x, y]) => x !== y);

if (mismatch.length) {
  console.error('\nPARITY_FAIL：两口径数出来的不是同一件事 ⇒ 单进程下有文件被别的文件污染了');
  for (const [key, x, y] of mismatch) console.error(`  ${key}: none=${x} process=${y}`);
  console.error('先按这个方向查：process.env / process.chdir / 模块级可变状态 / 没关的全局句柄。');
  process.exit(1);
}

console.log(`\nPARITY_OK：两口径一致（tests=${a.tests} pass=${a.pass} fail=${a.fail}）`
  + `｜单进程 ${(a.seconds / 10).toFixed(1)}s vs 隔离 ${(b.seconds / 10).toFixed(1)}s（process 走 ${b.route}）`);
process.exit(0);
