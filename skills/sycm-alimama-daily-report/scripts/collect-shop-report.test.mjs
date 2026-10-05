import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SHOP_REPORT_ROW_TITLES, pickDailyPreview, reportRowTitleFor, rowTitleMatcher,
} from './collect-shop-report.mjs';

// 夹具取「真机实测读到的行文本」的形状（2026-10-05 `98-failure-state.json` 的
// `visibleText`），**不是**我编的短字符串 —— 这一条正是 2026-10-05 那次事故的教训：
// 之前的用例（如果有）会造一个「现实中不存在的形状」，于是全绿放行。
//
// ⚠️ 关键形状：`rowText` 是**整行**的 innerText —— 行标题在最前面，后面还跟着
// 报表类型/创建人/修改时间/操作。所以「逐字等于标题」永远不成立。
const ROW_LIKELIN = [{ i: 0, rowText: '日报 取数报表 小宁 2026-04-13 19:01:52 加入我的报表预览' }];
const ROW_GAIWEN_TB = [
  { i: 0, rowText: '店铺日报 取数报表 小瓜 2026-09-30 18:59:33 加入我的报表预览' },
  { i: 1, rowText: '日报2 取数报表 小瓜 2026-04-13 19:18:19 加入我的报表预览' },
  { i: 2, rowText: '日报 取数报表 旧版报表同步 2023-03-14 12:44:06 加入我的报表预览' },
];
const ROW_GAIWEN_TM = [{
  i: 0,
  rowText: '活动-店铺-整体-近30天 取数报表 小瓜 2026-09-30 18:59:33 加入我的报表预览',
}];

test('判据必须是一个「能被调用」的函数，不是一段源码/正则', () => {
  assert.equal(typeof rowTitleMatcher(null), 'function', '默认形态必须返回函数');
  assert.equal(typeof rowTitleMatcher('日报'), 'function', '登记形态必须返回函数');
});

test('默认形态（未登记店）必须真的命中含「日报」的整行文本', () => {
  // 这条就是 2026-10-05 那次事故的守卫：当时调用点把它包成 `new RegExp(...)`，
  // 于是恒不命中 ⇒ 8 家店全报「等不到『日报』这一行的预览按钮」。
  assert.equal(rowTitleMatcher(null)(ROW_LIKELIN[0].rowText), true);
  assert.equal(pickDailyPreview(ROW_LIKELIN, null)?.i, 0, '必须挑出里可林那条「日报」行');
});

test('默认形态不许命中不含「日报」的行', () => {
  const other = [{ i: 0, rowText: '店铺详情 取数报表 旧版报表同步 2024-03-16 14:19:12 加入我的报表预览' }];
  assert.equal(pickDailyPreview(other, null), null);
});

test('登记形态必须命中「整行以登记标题开头」的那种行（=== 会漏掉它）', () => {
  const title = SHOP_REPORT_ROW_TITLES.盖文天猫;
  assert.equal(title, '活动-店铺-整体-近30天');
  assert.equal(rowTitleMatcher(title)(ROW_GAIWEN_TM[0].rowText), true,
    '整行文本 = 标题 + 其余单元格，逐字相等会恒不命中');
  assert.equal(pickDailyPreview(ROW_GAIWEN_TM, title)?.i, 0);
});

test('登记形态不许被同前缀的别的行误命中（「日报2」不能被「日报」吃掉）', () => {
  const m = rowTitleMatcher('日报');
  assert.equal(m('日报 取数报表 旧版报表同步'), true, '正好是这一行 ⇒ 命中');
  assert.equal(m('日报2 取数报表 小瓜'), false, '标题后紧跟「2」⇒ 不算');
  assert.equal(m('店铺日报 取数报表 小瓜'), false, '前缀不同 ⇒ 不算');
});

test('默认形态保持历史行为：含匹配、取第一行（这条钉的是现状，不是推荐）', () => {
  // 盖文淘宝的公共空间里同时有「店铺日报」「日报2」「日报」三行。
  // 2026-10-05 之前一直是「含『日报』、取第一个」，这条改动**没有**动它；
  // 钉住它是为了将来若有人要改成「优先逐字等于日报」时，能明确知道这是行为变更。
  assert.equal(pickDailyPreview(ROW_GAIWEN_TB, null)?.i, 0);
});

test('reportRowTitleFor：未登记 ⇒ null（沿用默认），空的店名 ⇒ 抛错', () => {
  assert.equal(reportRowTitleFor('里可林淘宝'), null);
  assert.equal(reportRowTitleFor('盖文天猫'), '活动-店铺-整体-近30天');
  assert.throws(() => reportRowTitleFor(''), /没给店名/u);
});

test('接线守卫：调用点不许把判据再包成 RegExp/字符串 —— 判据必须被调用', () => {
  // 函数级用例全绿 ≠ 接线接上了（本项目吃过三次）。这条扫源码，钉的是**调用点**。
  //
  // ⚠️ 扫描前必须先剥注释：源码里的注释**正当**地引用了那个坏写法（写下来是为了让人别再犯），
  // 不剥就会把注释判成代码 —— 第一版就是这么红的。
  const source = readFileSync(new URL('./collect-shop-report.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  assert.doesNotMatch(codeOnly, /new RegExp\(\s*rowTitleMatcher/u,
    '把判据包成 RegExp 就等于恒不命中（2026-10-05 实亏）');
  assert.match(codeOnly, /pickDailyPreview\(\s*state\.info/u,
    '调用点必须走 pickDailyPreview');
});
