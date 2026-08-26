import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMainUpsertPlan } from './sync-latest-ab-to-main-core.mjs';

const history = (id, classification = 'B-高价值竞品') => ({
  record_id: `hist-${id}`,
  fields: {
    商品ID: id, 商品链接: `https://item.taobao.com/item.htm?id=${id}`, 商品标题: `浴缸 ${id}`, 价格: '2000',
    月收货人数: '100+', 类目: '浴缸', 同款数: '0', 平台: '淘宝', 店铺名: '店铺', 店铺旺旺: '旺旺',
    店铺类型: '普通', 地址: '浙江', 收藏人数: '-', 卖点: '卖点', 搜索关键词: '浴缸',
    数据开始日期: 1787500800000, 竞品分类: classification, 是否有效竞品: '是',
  },
});

test('upserts latest A/B products by stable product ID and does not copy formula fields', () => {
  const plan = buildMainUpsertPlan({ historyRecords: [history('1001'), history('1002')], mainRecords: [
    { record_id: 'main-p1', fields: { 商品链接: 'https://item.taobao.com/item.htm?id=1001', 商品标题: '旧标题' } },
  ] });
  assert.deepEqual(plan.summary, { latestAbRows: 2, toCreate: 1, toUpdate: 1, unchanged: 0 });
  assert.equal(plan.creates[0].竞品分类, undefined);
  assert.equal(plan.creates[0].是否有效竞品, undefined);
  assert.equal(plan.creates[0].商品链接, 'https://item.taobao.com/item.htm?id=1002');
});

test('ignores non-A/B rows from the latest period', () => {
  const plan = buildMainUpsertPlan({ historyRecords: [history('1001', 'C-差异化竞品')], mainRecords: [] });
  assert.equal(plan.summary.latestAbRows, 0);
  assert.equal(plan.summary.toCreate, 0);
});

test('rejects duplicate latest product IDs', () => {
  assert.throws(() => buildMainUpsertPlan({ historyRecords: [history('1001'), history('1001')], mainRecords: [] }), /duplicate product ID/u);
});

test('requires the weekly source keyword instead of silently defaulting to bathtub', () => {
  const row = history('1003');
  delete row.fields.搜索关键词;
  assert.throws(() => buildMainUpsertPlan({ historyRecords: [row], mainRecords: [] }), /search keyword/u);
});
