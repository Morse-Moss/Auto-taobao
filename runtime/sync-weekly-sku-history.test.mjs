import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshotPlan } from './sync-weekly-sku-history.mjs';

const sku = (key, overrides = {}) => ({
  recordId: `rec-${key}`,
  fields: {
    商品ID: 'p-1', 商品链接: 'https://item.taobao.com/item.htm?id=p-1', 商品标题: '浴缸', 竞品分类: 'A-高销量高GMV竞品',
    SKU唯一键: key, SKU名称: '白色', SKU规格: '1500mm', SKU尺寸: '小户型', 尺寸汇总: '1.5m', 适用空间: '小户型',
    空间判定状态: '已判定', 空间判定依据: 'SKU尺寸', 采集状态: '已采集', 所属竞品: [{ record_id: 'rec-main' }], ...overrides,
  },
});

test('uses SKU唯一键 plus week start as an idempotent snapshot key', () => {
  const first = buildSnapshotPlan({ skuRecords: [sku('p-1|s-1')], historyRecords: [], startDate: '2026-08-24', endDate: '2026-08-30', collectedAt: '2026-08-24T01:00:00Z' });
  assert.deepEqual(first.summary, { sourceSkuRows: 1, toCreate: 1, toUpdate: 0, unchanged: 0 });
  const existing = [{ recordId: 'hist-1', fields: first.creates[0] }];
  const second = buildSnapshotPlan({ skuRecords: [sku('p-1|s-1')], historyRecords: existing, startDate: '2026-08-24', endDate: '2026-08-30', collectedAt: '2026-08-24T01:00:00Z' });
  assert.deepEqual(second.summary, { sourceSkuRows: 1, toCreate: 0, toUpdate: 0, unchanged: 1 });
});

test('treats Feishu null and an empty multi-select as the same snapshot value', () => {
  const first = buildSnapshotPlan({
    skuRecords: [sku('p-1|s-1', { 待补数据项: null })],
    historyRecords: [],
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    collectedAt: '2026-08-24T01:00:00Z',
  });
  const readBack = { ...first.creates[0], 待补数据项: null };
  const second = buildSnapshotPlan({
    skuRecords: [sku('p-1|s-1', { 待补数据项: null })],
    historyRecords: [{ recordId: 'hist-1', fields: readBack }],
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    collectedAt: '2026-08-24T01:00:00Z',
  });
  assert.deepEqual(second.summary, { sourceSkuRows: 1, toCreate: 0, toUpdate: 0, unchanged: 1 });
});

test('does not turn a same-week replay into an update only because collection time changed', () => {
  const first = buildSnapshotPlan({
    skuRecords: [sku('p-1|s-1')],
    historyRecords: [],
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    collectedAt: '2026-08-24T01:00:00Z',
  });
  const second = buildSnapshotPlan({
    skuRecords: [sku('p-1|s-1')],
    historyRecords: [{ recordId: 'hist-1', fields: first.creates[0] }],
    startDate: '2026-08-24',
    endDate: '2026-08-30',
    collectedAt: '2026-08-25T01:00:00Z',
  });
  assert.deepEqual(second.summary, { sourceSkuRows: 1, toCreate: 0, toUpdate: 0, unchanged: 1 });
});

test('updates the same-week snapshot but creates a new row for a new week', () => {
  const old = buildSnapshotPlan({ skuRecords: [sku('p-1|s-1')], historyRecords: [], startDate: '2026-08-24', endDate: '2026-08-30' }).creates[0];
  const changed = sku('p-1|s-1', { SKU尺寸: '常规卫生间', 适用空间: '常规卫生间' });
  const sameWeek = buildSnapshotPlan({ skuRecords: [changed], historyRecords: [{ recordId: 'hist-1', fields: old }], startDate: '2026-08-24', endDate: '2026-08-30' });
  assert.equal(sameWeek.summary.toUpdate, 1);
  const nextWeek = buildSnapshotPlan({ skuRecords: [changed], historyRecords: [{ recordId: 'hist-1', fields: old }], startDate: '2026-08-31', endDate: '2026-09-06' });
  assert.equal(nextWeek.summary.toCreate, 1);
});

test('blocks duplicate historical keys before any write', () => {
  assert.throws(() => buildSnapshotPlan({
    skuRecords: [sku('p-1|s-1')],
    historyRecords: [{ recordId: 'a', fields: { 'SKU周期唯一键': 'p-1|s-1|2026-08-24' } }, { recordId: 'b', fields: { 'SKU周期唯一键': 'p-1|s-1|2026-08-24' } }],
    startDate: '2026-08-24', endDate: '2026-08-30',
  }), /Duplicate SKU周期唯一键/u);
});
