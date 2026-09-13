import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoryRows,
  buildHistoryPlan,
  assessCompetitorWeeklyGate,
} from './competitor-history-publish-core.mjs';
import { readBackMatches } from './publish-competitor-visualization.mjs';

const row = (overrides = {}) => ({
  record_id: overrides.record_id ?? 'rec-1',
  fields: {
    商品ID: overrides.商品ID ?? '1',
    商品标题: overrides.商品标题 ?? '铸铁浴缸',
    商品链接: overrides.商品链接 ?? 'https://item.taobao.com/item.htm?id=1',
    价格: overrides.价格 ?? 2000,
    月收货人数: overrides.月收货人数 ?? '10',
    月收货人数计算值: overrides.月收货人数计算值 ?? 10,
    计算口径: overrides.计算口径 ?? '精确值',
    月收货金额: overrides.月收货金额 ?? 20000,
    材质分类: overrides.材质分类 ?? ['铸铁'],
    店铺名: overrides.店铺名 ?? '甲店',
    平台: overrides.平台 ?? '淘宝',
    是否有效竞品: overrides.是否有效竞品 ?? '是',
    竞品分类: overrides.竞品分类 ?? 'B-高价值竞品',
    批次ID: overrides.批次ID ?? 'batch-1',
    来源时间: overrides.来源时间 ?? 1787414400000,
    搜索关键词: overrides.搜索关键词 ?? '浴缸',
    公式版本: overrides.公式版本 ?? 'formula-v1',
    AI提示词版本: overrides.AI提示词版本 ?? 'ai-v1',
    批次有效性: overrides.批次有效性 ?? '有效',
    数据开始日期: overrides.数据开始日期 ?? '2026-08-23',
    数据结束日期: overrides.数据结束日期 ?? '2026-08-29',
    ...overrides,
  },
});

test('builds one auditable historical row with stable identity and derived fields', () => {
  const [result] = buildHistoryRows({
    records: [row()],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(result.fields.商品周期唯一键, '2026-08-23_2026-08-291');
  assert.equal(result.fields.周期开始日期, Date.parse('2026-08-23T00:00:00+08:00'));
  assert.equal(result.fields.周期结束日期, Date.parse('2026-08-29T00:00:00+08:00'));
  assert.equal(result.fields.金额可计算标记, '是');
  assert.equal(result.fields.可视化资格, '是');
  assert.equal(result.fields.材质分类, '铸铁');
  assert.equal(result.fields.客单价带分类, '1000-3000');
  assert.equal(result.fields.店铺名, '甲店');
  assert.equal(result.fields.来源周表, '竞品周_2026-08-23_2026-08-29');
  assert.equal(result.fields.本期标记, '是');
});

test('rejects invalid and reversed history periods', () => {
  assert.throws(() => buildHistoryRows({ records: [row()], period: { startDate: '2026-02-29', endDate: '2026-03-01' }, sourceTable: '竞品周_2026-08-23_2026-08-29' }), /period\.startDate is invalid/u);
  assert.throws(() => buildHistoryRows({ records: [row()], period: { startDate: '2026-08-30', endDate: '2026-08-29' }, sourceTable: '竞品周_2026-08-23_2026-08-29' }), /History period must use YYYY-MM-DD/u);
});

test('keeps unknown money auditable but excludes it from visualization qualification', () => {
  const [result] = buildHistoryRows({
    records: [row({ 月收货人数: '-', 月收货人数计算值: null, 计算口径: '不可计算', 月收货金额: null })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(result.fields.月收货人数, '-');
  assert.equal(result.fields.月收货人数计算值, undefined);
  assert.equal(result.fields.月收货金额, undefined);
  assert.equal(result.fields.材质金额分摊值, undefined);
  assert.equal(result.fields.金额可计算标记, '否');
  assert.equal(result.fields.可视化资格, '否');
  assert.equal(result.fields.金额质量状态, '金额不可计算');
});

test('omits unknown numeric values from Feishu writes while preserving unknown money status', () => {
  const [result] = buildHistoryRows({
    records: [row({ 月收货人数: '14人看过', 月收货人数计算值: null, 计算口径: '不可计算', 月收货金额: null })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(result.fields.月收货人数计算值, undefined);
  assert.equal(result.fields.月收货金额, undefined);
  assert.equal(result.fields.材质金额分摊值, undefined);
  assert.equal(result.fields.金额可计算标记, '否');
});

test('serializes price as a number for Feishu while omitting an unknown price', () => {
  const results = buildHistoryRows({
    records: [row({ 价格: '2,000' }), row({ 商品ID: '2', record_id: 'rec-2', 价格: '-' })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(results[0].fields.价格, 2000);
  assert.equal(results[1].fields.价格, undefined);
});

test('omits an empty source date from Feishu Date fields', () => {
  const [result] = buildHistoryRows({
    records: [row({ 来源时间: '' })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(result.fields.来源时间, undefined);
});

test('read-back accepts Feishu scalar normalization while rejecting changed business values', () => {
  const [desired] = buildHistoryRows({
    records: [row({ 商品图片: [{ name: 'source-image' }], 来源时间: '', 批次ID: '' })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });
  const actual = {
    ...desired.fields,
    商品图片: [],
    价格: '2000',
    批次ID: null,
    月收货人数计算值: '10',
    月收货金额: '20000',
    材质金额分摊值: '20000',
    来源时间: null,
  };
  assert.equal(readBackMatches([{ fields: actual }], [desired]), true);
  assert.equal(desired.fields.商品图片, undefined, '附件不允许跨表拷贝，历史行必须省略商品图片');
  assert.equal(readBackMatches([{ fields: { ...actual, 月收货金额: '20000.0000000001' } }], [desired]), true);
  assert.equal(readBackMatches([{ fields: { ...actual, 月收货金额: '1' } }], [desired]), false);
});

test('quality gate rejects incomplete or mixed snapshots and accepts a complete valid week', () => {
  const base = {
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    expectedRows: 2,
  };
  assert.equal(assessCompetitorWeeklyGate({ ...base, records: [row(), row({ 商品ID: '2', record_id: 'rec-2' })] }).status, '通过');
  assert.equal(assessCompetitorWeeklyGate({ ...base, records: [row()] }).status, '失败');
  assert.equal(assessCompetitorWeeklyGate({ ...base, records: [row({ 快照类型: 'mixed_snapshot' }), row({ 商品ID: '2', record_id: 'rec-2' })] }).status, '失败');
});

test('plans creates and updates idempotently by 商品周期唯一键 without deleting existing rows', () => {
  const desired = buildHistoryRows({
    records: [row(), row({ 商品ID: '2', record_id: 'rec-2' })],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });
  const plan = buildHistoryPlan({
    desiredRows: desired,
    existingRecords: [{ record_id: 'hist-1', fields: { 商品周期唯一键: '2026-08-23_2026-08-291', 商品ID: '1' } }],
  });

  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.deletes.length, 0);
  assert.equal(buildHistoryPlan({ desiredRows: desired, existingRecords: desired }).creates.length, 0);
});

test('uses the client recordId shape when planning idempotent updates', () => {
  const [desired] = buildHistoryRows({
    records: [row()],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });
  const plan = buildHistoryPlan({
    desiredRows: [desired],
    existingRecords: [{ recordId: 'hist-1', fields: { 商品周期唯一键: desired.fields.商品周期唯一键, 商品ID: '1' } }],
  });

  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates[0].record_id, 'hist-1');
});

test('writes a readable store display category with top five and other', () => {
  const results = buildHistoryRows({
    records: [
      row({ 商品ID: '1', 店铺名: '甲店', 价格: 100, 月收货人数计算值: 10 }),
      row({ 商品ID: '2', 店铺名: '乙店', 价格: 100, 月收货人数计算值: 9 }),
      row({ 商品ID: '3', 店铺名: '丙店', 价格: 100, 月收货人数计算值: 8 }),
      row({ 商品ID: '4', 店铺名: '丁店', 价格: 100, 月收货人数计算值: 7 }),
      row({ 商品ID: '5', 店铺名: '戊店', 价格: 100, 月收货人数计算值: 6 }),
      row({ 商品ID: '6', 店铺名: '己店', 价格: 100, 月收货人数计算值: 5 }),
      row({ 商品ID: '7', 店铺名: '', 价格: 100, 月收货人数计算值: 4 }),
    ],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.deepEqual(results.map(({ fields }) => fields.店铺展示分类), [
    '甲店', '乙店', '丙店', '丁店', '戊店', '其他', '店铺未知',
  ]);
});

test('excludes invalid competitor rows from store display ranking', () => {
  const results = buildHistoryRows({
    records: [
      row({ 商品ID: '1', 店铺名: '无效大店', 价格: 100, 月收货人数计算值: 100, 是否有效竞品: '否' }),
      row({ 商品ID: '2', 店铺名: '有效店', 价格: 100, 月收货人数计算值: 10 }),
    ],
    period: { startDate: '2026-08-23', endDate: '2026-08-29' },
    sourceTable: '竞品周_2026-08-23_2026-08-29',
  });

  assert.equal(results[0].fields.店铺展示分类, '其他');
  assert.equal(results[1].fields.店铺展示分类, '有效店');
});
