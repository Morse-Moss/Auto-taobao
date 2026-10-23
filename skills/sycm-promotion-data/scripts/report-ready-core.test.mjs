// 「报表页就绪」判据与接线的回归钉子（2026-10-22 加）。
//
// 起因（真机，`evidence/product-data-job-2026-10-21/2026-10-21-20261022021253864-e1dbdbf9/网林天猫/promotion-collect/`）：
// 报「找不到商品数据明细维度选择器」，而同一份现场里 URL 的日期参数完全正确
// （startTime=endTime=2026-10-21），页面却只剩 257 个 DIV、1 个 TR、0 个「维度」、0 个 INPUT、无弹窗。
// 对照 2026-10-21 里可林天猫的同类失败现场：DIV=822、TR=58、INPUT=6 —— 渲染完整，只是下载入口不可见。
// 两次形态不同 ⇒ 10-22 这次是**报表骨架还没渲出来就被判死**：
// 旧代码 `await sleep(6500)` 之后直接 `setPlanDimension`，而它找不到 `.mx-trigger` 就立刻 throw。
//
// 本文件钉两件事：
//   ① `planReportReadyStep` / `pollReportReady` 的决策本身（含「0 行也必须放行」）；
//   ② 采集脚本**真的**改成了轮询 —— 光有用例、采集侧不调用，等于没修。
//      （本项目已发作三次：「用例全绿 + 突变过了」≠ 接线接上了。）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describeReportReadyFailure, planReportReadyStep, pollReportReady } from './report-ready-core.mjs';

const COLLECT_SOURCE = readFileSync(path.join(import.meta.dirname, 'collect-product-report.mjs'), 'utf8')
  .replaceAll('\r\n', '\n');

// 2026-10-22 网林天猫现场读数（逐字取自 98-failure-state.json 的 domSummary/visibleText 统计）
const FAILED_READING_2026_10_22 = Object.freeze({
  href: 'https://one.alimama.com/index.html#!/report/item_promotion?rptType=item_promotion&startTime=2026-10-21&endTime=2026-10-21',
  triggers: [],
  rows: 0,
  hasDimensionText: false,
  dimInputs: 0,
});
// 2026-10-21 里可林天猫现场：渲染完整（DIV=822 / TR=58 / INPUT=6），维度触发器在 ⇒ 当时就该判 ready
const RENDERED_READING_2026_10_21 = Object.freeze({
  href: 'https://one.alimama.com/index.html#!/report/item_promotion?rptType=item_promotion&startTime=2026-10-20&endTime=2026-10-20',
  triggers: ['营销场景 关键词推广', '转化统计方式 末次点击归因', '维度 商品,计划'],
  rows: 35,
  hasDimensionText: true,
  dimInputs: 6,
});

test('维度触发器在 ⇒ ready（这是下一步要点的那个元素本身）', () => {
  assert.equal(planReportReadyStep(RENDERED_READING_2026_10_21), 'ready');
});

test('2026-10-22 现场（空壳页面）⇒ 不许判 ready，要继续等', () => {
  assert.equal(planReportReadyStep(FAILED_READING_2026_10_22), 'empty');
});

test('表格已有行但触发器还没出 ⇒ 骨架在长，继续等（table 不等于 ready）', () => {
  assert.equal(planReportReadyStep({ triggers: [], rows: 12 }), 'table');
});

test('当日 0 投放：触发器在、表格 0 行 ⇒ 必须放行（这不是「没就绪」）', () => {
  // 2026-10-22 网林家居推广源 0 行。要求「有行才算就绪」会把「今天确实没数据」判成故障，
  // 进而让整轮报缺口 —— 而这是正常业务形态（用户口径：有数据就有，没数据就没有）。
  assert.equal(planReportReadyStep({ triggers: ['维度 商品,计划'], rows: 0 }), 'ready');
  assert.equal(planReportReadyStep({ triggers: ['维度 商品,计划'], rows: null }), 'ready');
});

test('触发器文案含「维度」即算（平台会把「维度 商品」写成「维度 商品,计划」）', () => {
  assert.equal(planReportReadyStep({ triggers: ['维度 商品'] }), 'ready');
  assert.equal(planReportReadyStep({ triggers: ['维度'] }), 'ready');
  assert.equal(planReportReadyStep({ triggers: ['营销场景 关键词推广'] }), 'empty');
});

test('读数缺失按最保守处理：不许因为读不到就当成就绪', () => {
  assert.equal(planReportReadyStep(undefined), 'empty');
  assert.equal(planReportReadyStep({}), 'empty');
  assert.equal(planReportReadyStep({ triggers: null, rows: undefined }), 'empty');
});

test('轮询：第 3 次读到维度触发器就返回，正好读 3 次不多读', async () => {
  const reads = [FAILED_READING_2026_10_22, { triggers: [], rows: 4 }, RENDERED_READING_2026_10_21];
  let i = 0;
  let clock = 0;
  const result = await pollReportReady({ read: async () => reads[i++], delay: async () => {}, now: () => clock, timeoutMs: 10000 });
  assert.equal(result.step, 'ready');
  assert.equal(result.reads, 3);
  assert.equal(result.timedOut, false);
});

test('轮询：一直空壳 ⇒ timedOut=true 且不抛，把最后读数与读次数交回去', async () => {
  let clock = 0;
  const result = await pollReportReady({
    read: async () => FAILED_READING_2026_10_22,
    delay: async () => { clock += 1500; },
    now: () => clock,
    timeoutMs: 4500,
    intervalMs: 1500,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.step, 'empty');
  assert.equal(result.reads, 4, '0/1500/3000/4500 四次：超时那一轮也要读数，否则「等了几次」说不清');
  assert.deepEqual(result.state, FAILED_READING_2026_10_22);
});

test('轮询：timeoutMs 为负 / 缺 read 直接报错，不许静默空转', async () => {
  await assert.rejects(() => pollReportReady({ timeoutMs: -1, read: async () => ({}) }), /非负数/u);
  await assert.rejects(() => pollReportReady({}), /需要 read\(\)/u);
});

test('失败文案说清「看到了什么」，不是只甩一句找不到选择器', () => {
  const text = describeReportReadyFailure({ state: FAILED_READING_2026_10_22, reads: 16 });
  assert.match(text, /16 次/u);
  assert.match(text, /维度触发器 0 个/u);
  assert.match(text, /表格 0 行/u);
  assert.match(text, /已到报表页/u, '网址已在报表页时要能读出来 —— 这是与「被踢到登录页」的分界线');
  assert.doesNotMatch(text, /mx-trigger|querySelector|DOMException/u, '对运营说的话里不许出现选择器与内部符号');
});

// ---------------------------------------------------------------------------
// 接线守卫：采集脚本必须真的走轮询
// ---------------------------------------------------------------------------
test('produceTask 真的 await 了 pollReportReady，不再用固定的 sleep(6500) 当就绪', () => {
  assert.match(COLLECT_SOURCE, /import\s*\{[^}]*pollReportReady[^}]*\}\s*from\s*'\.\/report-ready-core\.mjs'/s,
    '必须从 report-ready-core.mjs 导入 pollReportReady');
  assert.match(COLLECT_SOURCE, /await\s+pollReportReady\s*\(/, '必须真的 await 调用 pollReportReady');
  assert.doesNotMatch(COLLECT_SOURCE, /await sleep\(6500\)/u,
    '不许退回到「固定等 6.5 秒就当就绪」—— 那正是 10-22 网林天猫被判死的原因');
});

test('就绪轮询必须排在 setPlanDimension 之前（顺序反了等于没修）', () => {
  const pollAt = COLLECT_SOURCE.indexOf('await pollReportReady(');
  const dimensionAt = COLLECT_SOURCE.indexOf('await setPlanDimension(');
  assert.ok(pollAt > 0 && dimensionAt > 0, '找不到调用点 —— 结构变了就更新这条判据');
  assert.ok(pollAt < dimensionAt, '必须等就绪之后再点维度选择器');
});

test('就绪失败时的报错必须带上 describeReportReadyFailure 的说明（不许只留符号）', () => {
  assert.match(COLLECT_SOURCE, /describeReportReadyFailure\(ready\)/u,
    '失败分支要用同一条描述函数，否则「等了几次、看到什么」又丢了');
});
