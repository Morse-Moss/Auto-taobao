import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompetitorVisualization,
  selectFirstMaterial,
} from './competitor-visualization-core.mjs';

const row = (overrides = {}) => ({
  record_id: overrides.record_id ?? 'rec-1',
  fields: {
    商品ID: overrides.商品ID ?? '1',
    商品标题: overrides.商品标题 ?? '铸铁陶瓷浴缸',
    商品链接: overrides.商品链接 ?? 'https://item.taobao.com/item.htm?id=1',
    价格: overrides.价格 ?? 2000,
    月收货人数: overrides.月收货人数 ?? '10',
    月收货人数计算值: overrides.月收货人数计算值 ?? 10,
    计算口径: overrides.计算口径 ?? '精确值',
    月收货金额: overrides.月收货金额 ?? 20000,
    材质分类: overrides.材质分类 ?? ['铸铁', '陶瓷'],
    客单价带分类: overrides.客单价带分类 ?? '1000-3000',
    店铺名: overrides.店铺名 ?? '甲店',
    是否有效竞品: overrides.是否有效竞品 ?? '是',
    竞品分类: overrides.竞品分类 ?? 'B-高价值竞品',
    数据开始日期: overrides.数据开始日期 ?? 1787414400000,
    数据结束日期: overrides.数据结束日期 ?? 1787932800000,
    批次有效性: overrides.批次有效性 ?? '有效',
    ...overrides,
  },
});

test('selects the first real material from the original title and excludes transparent', () => {
  assert.equal(selectFirstMaterial('透明树脂人造石浴缸纯亚克力'), '人造石');
  assert.equal(selectFirstMaterial('铸铁陶瓷浴缸透明树脂'), '铸铁');
  assert.equal(selectFirstMaterial('普通浴缸'), '无注明');
});

test('builds four current-period visualization aggregates with stable money semantics', () => {
  const result = buildCompetitorVisualization({
    records: [
      row({ 月收货人数: '100+', 月收货人数计算值: 100, 计算口径: '下限值', 月收货金额: 200000 }),
      row({ record_id: 'rec-2', 商品ID: '2', 商品标题: '陶瓷浴缸', 价格: 1000, 月收货人数: '10', 月收货人数计算值: 10, 月收货金额: 10000, 材质分类: ['陶瓷'], 店铺名: '' }),
      row({ record_id: 'rec-3', 商品ID: '3', 商品标题: '亚克力浴缸', 价格: 900, 月收货人数: '5', 月收货人数计算值: 5, 月收货金额: 4500, 材质分类: ['亚克力'], 店铺名: '乙店', 竞品分类: 'A-爆款竞品' }),
      row({ record_id: 'rec-4', 商品ID: '4', 商品标题: '配件', 是否有效竞品: '否', 月收货金额: 999999, 材质分类: ['不适用'] }),
      row({ record_id: 'rec-5', 商品ID: '5', 商品标题: '未知金额浴缸', 月收货人数: '-', 月收货人数计算值: null, 计算口径: '不可计算', 月收货金额: null, 店铺名: '丙店' }),
    ],
    startDate: '2026-08-23',
    endDate: '2026-08-29',
  });

  assert.deepEqual(result.period, { startDate: '2026-08-23', endDate: '2026-08-29' });
  assert.deepEqual(result.materialAmountShare, [
    { name: '铸铁', amount: 200000, share: 200000 / 214500 },
    { name: '陶瓷', amount: 10000, share: 10000 / 214500 },
    { name: '亚克力', amount: 4500, share: 4500 / 214500 },
  ]);
  assert.deepEqual(result.priceBandAmountShare, [
    { name: '1000以下', amount: 4500, share: 4500 / 214500 },
    { name: '1000-3000', amount: 210000, share: 210000 / 214500 },
    { name: '3000-6000', amount: 0, share: 0 },
    { name: '6000-8000', amount: 0, share: 0 },
    { name: '8000以上', amount: 0, share: 0 },
  ]);
  assert.deepEqual(result.storeAmountShare, [
    { name: '甲店', amount: 200000, share: 200000 / 214500 },
    { name: '乙店', amount: 4500, share: 4500 / 214500 },
    { name: '店铺未知', amount: 10000, share: 10000 / 214500 },
  ]);
  assert.deepEqual(result.bHighValueRanking.map((item) => item.productId), ['1', '2']);
  assert.equal(result.money.coveredAmount, 214500);
  assert.equal(result.money.unknownAmountRows, 1);
  assert.equal(result.money.lowerBoundRows, 1);
});

test('recomputes visualization money from price and calculated monthly receipts', () => {
  const result = buildCompetitorVisualization({
    records: [row({ 价格: 3000, 月收货人数: '10', 月收货人数计算值: 10, 月收货金额: 1 })],
    startDate: '2026-08-23',
    endDate: '2026-08-29',
  });
  assert.equal(result.materialAmountShare[0].amount, 30000);
  assert.equal(result.priceBandAmountShare.find((item) => item.name === '3000-6000').amount, 30000);
});

test('builds a readable presentation with top stores, other, summary, and ranked B items', () => {
  const result = buildCompetitorVisualization({
    records: [
      row({ 商品ID: '1', 商品标题: '铸铁浴缸', 店铺名: '甲店', 价格: 10, 月收货人数: '10', 月收货人数计算值: 10, 月收货金额: 100 }),
      row({ record_id: 'rec-2', 商品ID: '2', 商品标题: '陶瓷浴缸', 店铺名: '乙店', 价格: 10, 月收货人数: '5', 月收货人数计算值: 5, 月收货金额: 50, 材质分类: ['陶瓷'] }),
      row({ record_id: 'rec-3', 商品ID: '3', 商品标题: '钢瓷浴缸', 店铺名: '丙店', 价格: 10, 月收货人数: '2', 月收货人数计算值: 2, 月收货金额: 20, 材质分类: ['钢瓷'], 竞品分类: 'A-爆款竞品' }),
      row({ record_id: 'rec-4', 商品ID: '4', 商品标题: '木浴缸', 店铺名: '丁店', 价格: 10, 月收货人数: '1', 月收货人数计算值: 1, 月收货金额: 10, 材质分类: ['木'], 竞品分类: 'A-爆款竞品' }),
    ],
    startDate: '2026-08-23',
    endDate: '2026-08-29',
    topN: 2,
  });
  const presentation = result.presentation;
  assert.deepEqual(presentation.storeAmountShare.map((item) => item.name), ['甲店', '乙店', '其他']);
  assert.equal(presentation.storeAmountShare.at(-1).amount, 30);
  assert.deepEqual(presentation.bHighValueRanking.map((item) => item.rank), [1, 2]);
  assert.equal(presentation.summary.includedRows, 4);
  assert.equal(presentation.summary.coverage, 1);
});
