import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDownloadFailure, rankDownloadCandidates } from './download-entry-core.mjs';

// ---------------------------------------------------------------------------
// 下载入口候选的排序与过滤（2026-10-21 抽出来做离线判据）
// ---------------------------------------------------------------------------
// 旧判据 inline 在页面模板串里，只能真机验，于是它把「读取方式太窄」当成了「页面上没有」：
//   children.length === 0 && innerText === '下载' && width > 0
// 2026-10-20 里可林天猫现场：报表已渲染 35 行、URL 日期正确、无遮挡层，却报「下载入口不可见」。
// 这些用例钉的是「宽松在前、严格在后」这条判据本身。

const VIEW = { width: 1506, height: 642 };
const at = (x, y, w = 60, h = 24) => ({ x, y, w, h });

test('文字恰好是「下载」的候选排在最前', () => {
  const result = rankDownloadCandidates([
    { text: '下载报表', rect: at(10, 10) },
    { text: '下载', rect: at(200, 10) },
  ], { viewport: VIEW });
  assert.equal(result.ok, true);
  assert.equal(result.candidates[0].text, '下载');
});

test('文字只是**包含**「下载」（全角空格/图标/带前后缀）也算候选 —— 旧判据会漏掉', () => {
  const result = rankDownloadCandidates([{ text: ' 下载 ', rect: at(10, 10) }, { text: '下载明细', rect: at(80, 10) }], { viewport: VIEW });
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 2);
});

test('多个候选都可用 ⇒ 全部按优先级返回（调用方逐个做 elementFromPoint 复核）', () => {
  const result = rankDownloadCandidates([
    { text: '下载数据', rect: at(10, 10) },
    { text: '下载', rect: at(200, 10) },
    { text: '批量下载', rect: at(400, 10) },
  ], { viewport: VIEW });
  assert.deepEqual(result.candidates.map((c) => c.text), ['下载', '下载数据', '批量下载']);
});

test('同优先级保持页面顺序（排序必须稳定，不能靠 sort 实现细节）', () => {
  const result = rankDownloadCandidates([
    { text: '批量下载A', rect: at(10, 10) },
    { text: '批量下载B', rect: at(80, 10) },
  ], { viewport: VIEW });
  assert.deepEqual(result.candidates.map((c) => c.text), ['批量下载A', '批量下载B']);
});

test('坐标取矩形中心点并取整', () => {
  const result = rankDownloadCandidates([{ text: '下载', rect: at(100, 50, 60, 24) }], { viewport: VIEW });
  assert.deepEqual(result.candidates[0].point, [130, 62]);
});

test('操作行里压根没有含「下载」的元素 ⇒ no-download-text，且 saw 为空', () => {
  const result = rankDownloadCandidates([], { viewport: VIEW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-download-text');
  assert.deepEqual(result.saw, []);
});

test('尺寸为 0（元素存在但没渲染出来）⇒ zero-size，不是「没有」', () => {
  const result = rankDownloadCandidates([{ text: '下载', rect: at(10, 10, 0, 0) }], { viewport: VIEW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'zero-size');
  assert.equal(result.saw.length, 1, '要留下「看到了什么」，否则和「没有」无法区分');
});

test('在视口外 ⇒ outside-viewport，绝不把点投到视口外（会落到别的元素上）', () => {
  const result = rankDownloadCandidates([{ text: '下载', rect: at(10, 900) }], { viewport: VIEW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-viewport');
});

test('部分候选在视口外、部分在视口内 ⇒ 只返回视口内的', () => {
  const result = rankDownloadCandidates([
    { text: '下载', rect: at(10, 900) },
    { text: '下载数据', rect: at(10, 10) },
  ], { viewport: VIEW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map((c) => c.text), ['下载数据']);
});

test('矩形坐标为负（被滚出视口上方）⇒ 也算视口外', () => {
  const result = rankDownloadCandidates([{ text: '下载', rect: at(-50, -30) }], { viewport: VIEW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside-viewport');
});

test('失败文案能分辨「没有」与「在视口外」—— 这是旧版最缺的信息', () => {
  const none = describeDownloadFailure(rankDownloadCandidates([], { viewport: VIEW }));
  assert.match(none, /没有「下载」入口/u);
  const outside = describeDownloadFailure(rankDownloadCandidates([{ text: '下载', rect: at(10, 900) }], { viewport: VIEW }));
  assert.match(outside, /视口之外/u);
});

test('失败文案带上现场看到的候选文字，便于定位是文案变了还是层级变了', () => {
  const message = describeDownloadFailure(rankDownloadCandidates([{ text: '下载明细', rect: at(0, 0, 0, 0) }], { viewport: VIEW }));
  assert.match(message, /下载明细/u);
});

test('入参不是数组也不抛（页面取回 null 时不该把判据弄崩）', () => {
  assert.equal(rankDownloadCandidates(null, { viewport: VIEW }).ok, false);
  assert.equal(rankDownloadCandidates(undefined).reason, 'no-download-text');
});
