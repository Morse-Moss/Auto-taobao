import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENES, buildPromotionFields, buildShopFields, canonicalPromotionTargetName, reportDateEpoch,
} from './daily-report-core.mjs';

test('maps all 119 shop columns by exact header and converts live types', () => {
  const headers = Array.from({ length: 119 }, (_, index) => `字段${index}`);
  headers[0] = '统计日期';
  const values = Array.from({ length: 119 }, (_, index) => String(index));
  values[0] = '2026-09-15';
  values[1] = '盖文旗舰店';
  const targets = headers.map((name, index) => ({ name, type: index === 0 ? 5 : index === 1 ? 1 : 2 }));
  const fields = buildShopFields({ headers, values }, targets, '2026-09-15');
  assert.equal(fields['统计日期'], reportDateEpoch('2026-09-15'));
  assert.equal(fields['字段1'], '盖文旗舰店');
  assert.equal(fields['字段118'], 118);
  assert.throws(() => buildShopFields({ headers: [...headers.slice(0, 3), '错位', ...headers.slice(4)], values }, targets,
    '2026-09-15'), /shop header mismatch/u);
});

test('maps promotion columns, leaves secondary scene fields blank, and drops subsidy columns', () => {
  const headers = ['日期', '场景ID', '场景名字', ...Array.from({ length: 64 }, (_, index) => `指标${index}`),
    '平台补贴金额', '补贴引导成交金额', '发券补贴商品个数', '补贴引导成交人数'];
  const row = ['2026-09-15', '371', '关键词推广', ...Array.from({ length: 64 }, (_, index) => String(index)),
    '1', '2', '3', '4'];
  const targetNames = ['关键词推广日期', '场景ID', '场景名字', '原二级场景ID', '原二级场景名字',
    ...headers.slice(3, 67)];
  const targets = targetNames.map((name, index) => ({ name, type: index === 0 ? 5 : index === 2 || index === 4 ? 1 : 2 }));
  const fields = buildPromotionFields(headers, row, targets, SCENES.keyword, '2026-09-15');
  assert.equal(fields['场景ID'], 371);
  assert.equal(fields['场景名字'], '关键词推广');
  assert.equal(fields['指标63'], 63);
  assert.equal(Object.hasOwn(fields, '原二级场景ID'), false);
  assert.equal(Object.hasOwn(fields, '原二级场景名字'), false);
  assert.equal(Object.hasOwn(fields, '平台补贴金额'), false);
});

test('normalizes Feishu copy suffixes and scene prefixes for schema comparison', () => {
  assert.equal(canonicalPromotionTargetName('关键词推广花费 (1)', '关键词推广'), '花费');
  assert.equal(canonicalPromotionTargetName('会员成交金额 (2)', '人群推广'), '会员成交金额');
});
