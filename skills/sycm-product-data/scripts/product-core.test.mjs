import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductFields, parseCsvRows, planProductImport } from './product-core.mjs';

const header = ['统计日期','商品ID','商品名称','主商品ID','商品类型','货号','商品状态','商品标签','商品访客数','商品浏览量','平均停留时长','商品详情页跳出率','商品收藏人数','商品加购件数','商品加购人数','下单买家数','下单件数','下单金额','下单转化率','支付买家数','支付件数','支付金额','商品支付转化率','支付新买家数','支付老买家数','老买家支付金额','聚划算支付金额','访客平均价值','成功退款金额','竞争力评分','年累计支付金额','月累计支付金额','月累计支付件数','搜索引导支付转化率','搜索引导访客数','搜索引导支付买家数','结构化详情引导转化率','结构化详情引导成交占比'];
const row = ['2026-09-23','1','商品','1','主商品','-','当前在线','-','2','3','4.5','10.00%','0','1','1','0','0','1,234.00','0.00%','0','0','0.00','0.00%','0','0','0.00','0.00','617.00','0.00','-','10.00','2.00','1','0.00%','0','0','-','-'];

test('parses quoted CSV rows and preserves displayed percentage and dash values', () => {
  const rows = parseCsvRows(`${header.join(',')}\n${row.map((value, index) => index === 17 ? `"${value}"` : value).join(',')}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][17], '1,234.00');
  const fields = buildProductFields(rows[1], header);
  assert.equal(fields['当前在线'], '当前在线');
  assert.equal(fields['下单金额'], 1234);
  assert.equal(fields['竞争力评分'], '-');
  assert.equal(fields['统计日期'], Date.UTC(2026, 8, 23));
});

test('deduplicates the shared bottom sheet by date and product ID across shops', () => {
  const plan = planProductImport({ rows: [{ header, row, sourceShop: '盖文淘宝' }], existing: [{ fields: { 统计日期: Date.UTC(2026,8,23), 商品ID: '1' } }], shopForProduct: () => '盖文淘宝' });
  assert.equal(plan.records.length, 0);
  const otherShopSameProduct = planProductImport({ rows: [{ header, row, sourceShop: '盖文天猫' }], existing: [] });
  assert.equal(otherShopSameProduct.records.length, 1);
  const duplicateInBatch = planProductImport({ rows: [
    { header, row, sourceShop: '盖文淘宝' },
    { header, row, sourceShop: '盖文天猫' },
  ], existing: [] });
  assert.equal(duplicateInBatch.records.length, 1);
  const fresh = planProductImport({ rows: [{ header, row: [...row.slice(0, 1), '2', ...row.slice(2)], sourceShop: '盖文淘宝' }], existing: [] });
  assert.equal(fresh.records.length, 1);
  assert.equal(fresh.manifest[0].shop, '盖文淘宝');
});
