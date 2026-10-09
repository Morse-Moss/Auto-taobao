import assert from 'node:assert/strict';
import test from 'node:test';
import { promotionSales1Plan } from './run-promotion-sales1.mjs';

test('销售一部推广日报按五家一批且保留登记顺序', () => {
  assert.deepEqual(promotionSales1Plan({ batchSize: 2 }), [
    ['里可林淘宝', '网林天猫'], ['盖文淘宝', '盖文天猫'], ['科塔淘宝', '网林淘宝'], ['里可林天猫', '网林家居'],
  ]);
});

test('默认销售一部批次沿用日报五家一批口径', () => {
  assert.deepEqual(promotionSales1Plan(), [
    ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'],
    ['网林淘宝', '里可林天猫', '网林家居'],
  ]);
});

test('推广日报拒绝销售二部或未登记店铺', () => {
  assert.throws(() => promotionSales1Plan({ shops: ['保拉淘宝'] }), /不在销售一部采集范围/u);
});
