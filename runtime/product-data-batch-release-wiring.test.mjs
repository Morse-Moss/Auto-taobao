// 守卫：商品数据链的**分批释放接线**（2026-09-30 加 `--batches` 那一次改动）。
//
// 为什么要有这份守卫，而不是只靠 `product-data-job-core.test.mjs`：
//   那一份测的是**渲染出来的命令行**（定时入口带不带 `--batches`）与 plan 的名义值 ——
//   全是函数级的。而这次改动真正新增的东西是**一个循环里的调用顺序**：
//   「起这批 → 查这批登录 → 采三类 → 导三类 → **立刻释放这批**」。
//   函数级用例全绿 ≠ 接线接上了 —— 本仓已经吃过三次（最近一次是 2026-09-29 的
//   `--auto-repair`：四路 `===` 全落空、零动作执行过，而用例全绿）。
//   所以这里不做「调用某个函数看它返回什么」，而是直接钉**调用点在源码里的位置与顺序**：
//   位置错了不会报错，只会**静默**地多占内存（十二家一起开）或半路把浏览器停掉。
//
// 五条判据各对应一种「不报错的坏法」：
//   ① 释放出现在批次循环**体内**、且在 `await runRound(...)` **之后**
//      ⇒ 否则退回「整轮只释放一次」（内存没省）或「开着开着把浏览器停掉」（采到一半没了）。
//   ② 两次释放之间不许有 `throw` / 不许以 `gaps.length` 为条件
//      ⇒ 否则变成「只在成功时释放」，而那等于「失败那天十二家全留着」。
//   ③ `runRound` 函数体内**没有**释放调用
//      ⇒ 否则分批时**释放两次**：第二次面对一个已经空掉的目标，退出码不再说明任何事。
//   ④ `finally` 里的释放带 `!batched` 守卫 ⇒ 同 ③，这是防双重释放的另一半。
//   ⑤ 两处释放都要求收据 `released === false` 才算失败
//      ⇒ 本仓的释放路径出过**假绿**（退出码 0 而其实没停，见 AGENTS.md），
//        只信退出码等于把假绿写进这条新链。
//
// 另外三条是 CLI 契约（行为断言，不是读源码）：`--batches` 的默认值、非法值、
// 以及它必须真的写进 `--help`（写进 help 才算对外承诺过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main, parseArgs } from '../scripts/run-product-data-job.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'scripts/run-product-data-job.mjs';

/** 读一份源码并把行尾归一到 LF —— 断言按 `\n` 写，不该因为工作区的 CRLF 而变红。 */
function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

/** 取 `runRound` 的函数体（从签名到 `async function main(`）。取不到就当场失败，别让守卫静默空转。 */
function runRoundBody(source) {
  const start = source.indexOf('async function runRound(');
  assert.ok(start > 0, `在 ${ENTRY} 里找不到 runRound 的签名 —— 函数改名了就要连这份守卫一起改`);
  const end = source.indexOf('\nasync function main(', start);
  assert.ok(end > start, `在 ${ENTRY} 里找不到 runRound 的结尾 —— 结构变了就要连这份守卫一起改`);
  return source.slice(start, end);
}

test('每批的释放调用点在批次循环体内、且在 runRound 之后（不许退回整轮一次，也不许提前停）', () => {
  const source = readSource(ENTRY);
  const loopStart = source.indexOf('for (const round of rounds) {');
  assert.ok(loopStart > 0, '找不到批次循环 `for (const round of rounds) {` —— 结构变了就要连这份守卫一起改');
  // 循环体在 try 块里缩进 4 空格，所以它的收尾是一个 4 空格的 `}`。
  const loopEnd = source.indexOf('\n    }', loopStart);
  assert.ok(loopEnd > loopStart, '找不到批次循环的收尾 `}`');

  const loop = source.slice(loopStart, loopEnd);
  const roundAt = loop.indexOf('await runRound(');
  const releaseAt = loop.indexOf('PRODUCT_JOB_FILES.release');
  assert.ok(roundAt > 0, '批次循环里没有 `await runRound(` —— 那这个循环什么都没跑');
  assert.ok(releaseAt > 0, '批次循环里没有释放调用 ⇒ **退回「整轮只释放一次」**：十二家会同时开着，内存重新爆');
  assert.ok(releaseAt > roundAt, '释放调用排在了 `await runRound(` 之前 ⇒ 会把还没跑完的这一批浏览器停掉（采到一半没了）');

  // ② 一律释放：两次之间不许出现 `throw`，也不许以「有没有缺口」为条件。
  const between = loop.slice(roundAt, releaseAt);
  assert.ok(!between.includes('throw'), '释放排在一个 `throw` 之后 ⇒ 失败那批不会释放，等于「只在成功时释放」');
  assert.ok(!between.includes('gaps.length'), '释放被 `gaps.length` 挡住了 ⇒ 同上，失败那天十二家全留着');
  // ① 的另一半：不分批时这个 continue 必须排在释放之前（否则不分批会走两次释放）。
  const continueAt = loop.indexOf('if (!batched) continue;');
  assert.ok(continueAt > 0 && continueAt < releaseAt,
    '批次循环里的 `if (!batched) continue;` 不见了或排到了释放之后 ⇒ 不分批时会释放两次');
});

test('runRound 里不许释放，finally 里的释放必须带 !batched 守卫（防双重释放）', () => {
  const source = readSource(ENTRY);
  assert.ok(!runRoundBody(source).includes('PRODUCT_JOB_FILES.release'),
    'runRound 里出现了释放调用 ⇒ 分批时每批会**释放两次**，而第二次面对的是空目标、退出码不再说明任何事');
  assert.ok(source.includes('if (lock && !batched)'),
    'finally 里的释放少了 `!batched` 守卫 ⇒ 分批时整轮结束会再释放一次（同上的双重释放）');
});

test('两处释放都以收据 released=false 为失败判据，不是只看退出码（本仓的释放路径出过假绿）', () => {
  const source = readSource(ENTRY);
  const sites = [...source.matchAll(/PRODUCT_JOB_FILES\.release/gu)].map((match) => match.index);
  assert.equal(sites.length, 2, `释放调用点应当恰好两处（分批的循环里 + 不分批的 finally），实际 ${sites.length} 处`);
  // ⚠️ 判据必须落在 `if (...)`**条件本身**，不能只要求这一段里有 `released === false` 这几个字：
  // 紧随其后的那句日志里也写着 `released === false ? '、released=false' : ''`，
  // 于是「把条件改成只看退出码」这个突变**不会**让宽松版断言变红（2026-09-30 突变验证实测：
  // M4 改坏条件后守卫仍绿）—— 守卫自己犯了它要防的那个错（把「提到了」当成「判了」）。
  const JUDGE_RE = /if\s*\([^)\n]*released\.code[^)\n]*released\s*===\s*false/u;
  for (let i = 0; i < sites.length; i += 1) {
    const index = sites[i];
    // 窗口止于**下一个释放调用点**（别让后一处把前一处救了），最多 700 字符。
    const end = Math.min(index + 700, sites[i + 1] ?? Number.POSITIVE_INFINITY);
    const window = source.slice(index, end);
    const line = source.slice(0, index).split('\n').length;
    assert.ok(JUDGE_RE.test(window),
      `${ENTRY}:${line} 的释放只看退出码 ⇒ 会把「退出码 0 而其实没停」的假绿当成释放成功`);
  }
});

test('--batches 默认关闭、非法值当场拒（不回落默认）、且写进了 --help', async () => {
  // 默认必须是「不分批」：这条链还有别的调用方（手工排查、按店重跑），
  // 默认开启会把它们悄悄改成分批形态 —— 那不是它们的意图。
  assert.equal(parseArgs(['--date', 'yesterday', '--commit']).batches, null);
  assert.equal(parseArgs(['--batches', '5']).batches, 5);
  // 非法值不回落：`--batches 1O`（字母 O）若静默变成默认值，客户机上会一次开满一批。
  assert.throws(() => parseArgs(['--batches', '0']), /≥1 的整数/u);
  assert.throws(() => parseArgs(['--batches', 'abc']), /≥1 的整数/u);
  assert.throws(() => parseArgs(['--batches', '']), /≥1 的整数/u);
  assert.throws(() => parseArgs(['--batches']), /≥1 的整数/u);
  // 走真正的 main：解析失败要退 2（命令行的用法错误，不是运行失败），且**不能**有任何副作用。
  assert.equal(await main(['--batches', 'abc']), 2, '非法 --batches 必须以退出码 2 收场');
  assert.equal(await main(['--help']), 0, '--help 必须能干净退出');
  // `--help` 是这条开关**对外唯一的说明**。开关存在而 help 里没有它，等于没承诺过。
  assert.match(readSource(ENTRY), /--batches N/u, '--help 里没有写 --batches ⇒ 用命令行的人不会知道它存在');
});
