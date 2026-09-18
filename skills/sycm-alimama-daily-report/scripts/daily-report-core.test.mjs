import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENES, buildPromotionFields, buildShopFields, canonicalPromotionTargetName, reportDateEpoch,
  summarizeSourceDates,
} from './daily-report-core.mjs';

const REPORT_DATE = '2026-09-16';

// 造一份最小但形状正确的 source（店铺 119 列、推广 71 列都不是这个函数关心的，
// 它只看日期列与取用的那一行 —— 所以这里只用真实列名，不假装有整行数据）。
function makeSource({ shopDates, matchedDate = REPORT_DATE, promotionDates, csvName = '营销场景报表.csv' }) {
  return {
    shop: {
      headers: ['统计日期', ...Array.from({ length: 118 }, (_, index) => `店铺字段${index}`)],
      values: [matchedDate, '盖文旗舰店', ...Array.from({ length: 117 }, (_, index) => String(index))],
      workbookRows: shopDates.length + 1,
      dates: shopDates,
    },
    promotion: {
      headers: ['日期', '场景ID', '场景名字'],
      rows: promotionDates.map((value, index) => [value, String(371 + index), index === 0 ? '关键词推广' : '人群推广']),
      csvName,
      dates: promotionDates,
    },
  };
}

test('自证：两侧都是目标日时通过，并留下「观察到哪几天」的证据', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15', '2026-09-14'],
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.allMatchDate, true);
  assert.equal(selfCheck.shop.targetRowCount, 1);
  assert.equal(selfCheck.shop.matchedRowDate, REPORT_DATE);
  assert.equal(selfCheck.shop.uniqueDates, 3);
  assert.equal(selfCheck.shop.firstRowDate, '2026-09-16');
  assert.equal(selfCheck.shop.lastRowDate, '2026-09-14');
  assert.deepEqual(selfCheck.promotion.observedDates, [REPORT_DATE]);
  assert.equal(selfCheck.promotion.rowCount, 2);
  assert.equal(selfCheck.promotion.csvName, '营销场景报表.csv');
});

test('自证：推广 ZIP 是前一天的就判不通过（下载错文件的主要形态）', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15'],
    promotionDates: ['2026-09-15', '2026-09-15'],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.promotion.matches, false);
  assert.equal(selfCheck.promotion.targetRowCount, 0);
  assert.deepEqual(selfCheck.promotion.observedDates, ['2026-09-15']);
  assert.equal(selfCheck.allMatchDate, false, '推广侧不对时整体必须判不通过');
  assert.equal(selfCheck.shop.matches, true, '店铺侧仍然是对的，证据要分别保留');
});

test('自证：店铺工作簿里目标日出现两次也判不通过', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-16', '2026-09-15'],
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.shop.targetRowCount, 2);
  assert.equal(selfCheck.shop.matches, false);
  assert.equal(selfCheck.allMatchDate, false);
});

test('自证：取用的那一行不是目标日时判不通过（防止「列里有一行对」就放行）', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15'],
    matchedDate: '2026-09-15',
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.shop.targetRowCount, 1, '列里确实有一行是目标日');
  assert.equal(selfCheck.shop.matches, false, '但被取用的那一行不是它，所以不能通过');
  assert.equal(selfCheck.allMatchDate, false);
});

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

// 2026-09-18 实亏：09-17 的四家店（里可林家居/网林家居旗舰店/盖文全卫定制/科塔全卫定制）
// 当天无成交，数据源对 `UV价值`/`无线端UV价值` 给的是**文本标记 NULL**，而飞书这两列是**数字**字段。
// 原实现直接抛错 ⇒ 四家店同时推不动。处置定为「留空 + 留痕」，这条测试就是盯住它：
// 既不许悄悄写 0（造假事实、污染同比环比），也不许退回抛错（链推不动），还不许不留痕。
test('数字字段遇到数据源的文本标记 ⇒ 留空并留痕（不写 0，也不抛错）', () => {
  const headers = Array.from({ length: 119 }, (_, index) => `字段${index}`);
  headers[0] = 'UV价值';
  headers[1] = '无线端UV价值';
  headers[2] = 'PC端UV价值';
  headers[3] = '某数字字段';
  const values = Array.from({ length: 119 }, (_, index) => String(index));
  values[0] = 'NULL';
  values[1] = 'null'; // 大小写都要拦：数据源两种写法都出现过
  values[2] = 'NULL'; // 文本字段：能原样存，这是底单里已经落库的实况
  values[3] = '-';    // 同一语义的另一种标记写法
  const targets = headers.map((name, index) => ({ name, type: index === 2 ? 1 : 2 }));

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  let fields;
  try {
    fields = buildShopFields({ headers, values }, targets, '2026-09-17');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(Object.hasOwn(fields, 'UV价值'), false, '数字字段里存不下标记 ⇒ 该列不进 payload');
  assert.notEqual(fields['UV价值'], 0, '绝不能把「无数据」写成 0');
  assert.equal(Object.hasOwn(fields, '无线端UV价值'), false, '标记大小写不敏感');
  assert.equal(Object.hasOwn(fields, '某数字字段'), false, "'-' 与 NULL 同语义，同样留空");
  assert.equal(fields['PC端UV价值'], 'NULL', '文本字段能原样存标记（实测底单里就是字符串 NULL）');
  assert.equal(fields['字段4'], 4, '其余数字列照常转换');
  assert.equal(warnings.length, 3, '有几个格子被留空就必须有几行 warn —— 留空是静默的，不写日志事后分不出「无数据」与「漏采集」');
  assert.match(warnings[0], /UV价值/u);
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
