import assert from 'node:assert/strict';
import test from 'node:test';
import { promotionSales1Plan, parsePromotionSales1Args } from './run-promotion-sales1.mjs';

test('推广入口保留公共批次顺序，不在入口内切批', () => {
  assert.deepEqual(promotionSales1Plan({ shops: ['里可林淘宝', '网林天猫', '盖文淘宝'] }), [
    ['里可林淘宝', '网林天猫', '盖文淘宝'],
  ]);
});


test('推广日报拒绝销售二部或未登记店铺', () => {
  assert.throws(() => promotionSales1Plan({ shops: ['保拉淘宝'] }), /不在销售一部采集范围/u);
});

test('推广入口接受公共批次的 yesterday 日期并解析为目标日期', () => {
  const args = parsePromotionSales1Args(['--date', 'yesterday', '--plan']);
  assert.match(args.date, /^\d{4}-\d{2}-\d{2}$/u);
});
