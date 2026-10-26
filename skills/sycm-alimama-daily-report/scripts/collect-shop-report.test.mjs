import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SHOP_REPORT_ROW_TITLES, describeVisibleRows, pickDailyPreview, reportRowTitleFor, rowTitleLookupKey, rowTitleMatcher,
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

// --- 2026-10-26：销售2部五家恢复采集首跑，三家停在 shop-report -------------------------
// 下面三条夹具是**真机读数**（2026-10-26 14:5x 在三台窗口的「自助分析 → 公共空间」里
// 逐格读 `td` 得到的），不是编的形状。三家都有报表、类型都是「取数报表」，名字却不一样。
const ROW_ANBI_LEADING = [{ i: 0, rowText: '报表 取数报表 泡芙 2026-10-26 14:31:19 加入我的报表预览' }];
const ROW_ANBI_TB = [{ i: 0, rowText: '取数 取数报表 小森 2026-10-26 10:14:01 加入我的报表预览' }];
const ROW_KETA_LEADING = [{ i: 0, rowText: '取数 取数报表 小森 2026-10-26 10:09:20 加入我的报表预览' }];

test('2026-10-26 三家：报表名不是「日报」，默认判据必然落空（这就是那次的真因）', () => {
  // 先钉「旧判据确实找不到」——否则「登记修好了」就无从谈起，也看不出这次到底修了什么。
  for (const rows of [ROW_ANBI_LEADING, ROW_ANBI_TB, ROW_KETA_LEADING]) {
    assert.equal(pickDailyPreview(rows, null), null, '这三家的行文本里没有「日报」二字');
  }
});

test('2026-10-26 三家：按登记的行标题逐家命中', () => {
  assert.equal(reportRowTitleFor('安比龙头店'), '报表');
  assert.equal(reportRowTitleFor('安比淘宝'), '取数');
  assert.equal(reportRowTitleFor('科塔龙头店'), '取数');
  assert.equal(pickDailyPreview(ROW_ANBI_LEADING, reportRowTitleFor('安比龙头店'))?.i, 0);
  assert.equal(pickDailyPreview(ROW_ANBI_TB, reportRowTitleFor('安比淘宝'))?.i, 0);
  assert.equal(pickDailyPreview(ROW_KETA_LEADING, reportRowTitleFor('科塔龙头店'))?.i, 0);
});

test('2026-10-26 三家：名字不统一 —— 想用一个通用值覆盖三家，必然漏掉安比龙头店', () => {
  // 这条是给「顺手把三家都写成『取数』」的人准备的：安比龙头店那份叫「报表」，
  // 前缀不同 ⇒ 不命中。名字是运营侧起的，没有命名约束，只能一家一家登记。
  assert.equal(pickDailyPreview(ROW_ANBI_LEADING, '取数'), null, '安比龙头店的行以「报表」开头，不是「取数」');
  assert.equal(pickDailyPreview(ROW_ANBI_TB, '报表'), null, '反过来也一样：别指望一个值覆盖两家');
  // 而「报表」不能短到去吃同前缀的行：标题后必须紧跟空白或到头
  assert.equal(rowTitleMatcher('报表')('报表2 取数报表 某人'), false, '「报表2」不能被「报表」吃掉');
});

test('describeVisibleRows：把「这一屏有哪些行」说出来 —— 名字对不上时要能自证', () => {
  // 这条钉的是**那次被带偏的机制**：报错只写「等不到『日报』」，我据此说了「没有报表」。
  const text = describeVisibleRows(ROW_ANBI_TB);
  assert.match(text, /这一屏共 1 行/u);
  assert.match(text, /取数 取数报表 小森/u, '必须把整行原样带出来，人才看得见真实名字');
  // 去重 + 截断：同一屏里重复的行只算一次，超过 limit 要说明还剩几行
  const many = Array.from({ length: 9 }, (_, i) => ({ i, rowText: `报表${i} 取数报表 某人` }));
  many.push({ i: 9, rowText: '报表0 取数报表 某人' });
  const summary = describeVisibleRows(many, 3);
  assert.match(summary, /这一屏共 9 行/u, '重复行不许重复计数');
  assert.match(summary, /另有 6 行/u);
  // 空屏与「有 button 但读不到行文本」都要说清，不许返回空串（空串在日志里等于没打印）
  assert.match(describeVisibleRows([]), /一条带「预览」按钮的行都没有/u);
  assert.match(describeVisibleRows([{ i: 0, rowText: '   ' }]), /一条带「预览」按钮的行都没有/u);
});

test('接线守卫（五）：「没找到」的报错引用的 state 必须在外层声明（否则 ReferenceError）', () => {
  // 2026-10-26 读代码时发现：`state` 原来在 for 块里 `const`，而「没找到」的报错在块外引用 `state?.count`。
  // 未登记的店走的是不带 state 的另一条措辞，所以这三家从没触发过；**已登记**的店（盖文天猫）
  // 一旦落空就会抛 `ReferenceError: state is not defined` —— 把「报表改名了」吞成「脚本坏了」。
  const source = readFileSync(new URL('./collect-shop-report.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  assert.match(codeOnly, /let state = null;/u, 'state 必须在外层声明');
  assert.doesNotMatch(codeOnly, /const state = await evalOn/u, '不许再在轮询块里 const 一份遮蔽外层');
  assert.match(codeOnly, /describeVisibleRows\(/u, '落空时必须把可见行打出来，否则又会被人读成「没有报表」');
});

test('查键必须是运营叫法：拿页头店名去查 ⇒ 登记形同没登记（2026-10-05 第二次事故）', () => {
  // 这一条钉的是**机制**，不是一个返回值：登记表没错，错在查它的那把钥匙。
  // 盖文天猫的页头店名是「盖文旗舰店」（`shop-identities.mjs`：一店多名是常态）。
  assert.equal(rowTitleLookupKey({ shopKey: '盖文天猫', expectShop: '盖文旗舰店' }), '盖文天猫',
    '运营叫法在就必须用它查');
  assert.equal(reportRowTitleFor(rowTitleLookupKey({ shopKey: '盖文天猫', expectShop: '盖文旗舰店' })),
    '活动-店铺-整体-近30天');
  // 只给页头名 ⇒ 查不到 ⟺ 静默退回默认「含『日报』」——症状与「根本没登记」逐字一样。
  assert.equal(reportRowTitleFor(rowTitleLookupKey({ expectShop: '盖文旗舰店' })), null,
    '这就是事故现场：查不到 ⇒ 判据退回「含日报」⇒ 报「等不到『日报』」');
  // 本来就没登记的店：给什么都退回默认（历史行为不变）
  assert.equal(reportRowTitleFor(rowTitleLookupKey({ shopKey: '里可林淘宝', expectShop: '里可林家居' })), null);
  // 两个都不给 ⇒ 保持历史 fail-closed 措辞
  assert.throws(() => reportRowTitleFor(rowTitleLookupKey({})), /没给店名/u);
});

test('接线守卫（二）：调用点必须用运营叫法查行标题，不许直接拿 --expect-shop 去查', () => {
  const source = readFileSync(new URL('./collect-shop-report.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  assert.doesNotMatch(codeOnly, /reportRowTitleFor\(\s*args\.expectShop\s*\)/u,
    '这一行就是 2026-10-05 的病灶：页头店名 ≠ 运营叫法 ⇒ 登记查不到');
  assert.match(codeOnly, /reportRowTitleFor\(\s*rowTitleKey\s*\)/u,
    '调用点必须先算出 rowTitleKey（运营叫法优先）再查登记表');
  assert.match(codeOnly, /rowTitleLookupKey\(\s*\{\s*shopKey:\s*args\.shopKey/u,
    'rowTitleKey 必须由 --shop-key 参与计算，否则等于没接线');
});

test('接线守卫（三）：下载文件名判据也必须按店 —— 不许再用固定的 SHOP_REPORT_PATTERN', () => {
  // 2026-10-05 第三次事故：行标题终于查对了、下载也真落了盘，回执仍报「没等到新的店铺报表」——
  // 因为认文件的还是那条写死的「…日报…」正则（盖文天猫落盘叫「活动-店铺-整体-近30天_…」）。
  const source = readFileSync(new URL('./collect-shop-report.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  assert.doesNotMatch(codeOnly, /SHOP_REPORT_PATTERN/u,
    '本文件不该再直接引用固定正则 —— 文件名判据要按店算');
  assert.match(codeOnly, /shopReportNamePattern\(\s*rowTitle\s*\)/u,
    '文件名判据必须由 rowTitle 算出来（登记名当前缀）');
  assert.equal((codeOnly.match(/listDownloads\(\s*args\.downloads,\s*reportPattern\s*\)/gu) ?? []).length, 3,
    '三处（before 快照 + 轮询 + 取最新）都要用同一个 reportPattern，少一处就有一处看的是另一个世界');
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

test('接线守卫（四）：直下通道必须真接上 —— 装仪表先于点击、两条通道都落 shopXlsxPath', () => {
  // 2026-10-15：平台把日报导出改成在线预览、文件不落盘 ⇒ 只等文件系统就是
  // 8 家店 × 3 轮全败的那个超时。这条守卫钉的是**调用点**：
  // 仪表装晚了（URL 已过有效期/页面已导航走）＝ 直下通道形同虚设，
  // 而症状与「没这条通道」逐字一样（都是超时）—— 正是本项目最反复的那类静默失败。
  const source = readFileSync(new URL('./collect-shop-report.mjs', import.meta.url), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n');
  const installAt = codeOnly.indexOf('installDirectDownloadCaptureExpression()');
  const clickAt = codeOnly.indexOf("label: '下载报表按钮'");
  assert.ok(installAt >= 0, '调用点必须装直下通道仪表');
  assert.ok(clickAt >= 0, '找不到下载按钮的点击点（守卫自身失效？）');
  assert.ok(installAt < clickAt, '仪表必须装在点「下载报表」之前：签名 URL 有时效，装晚了抓不到');
  assert.match(codeOnly, /readDirectDownloadUrlsExpression\(\)/u, '轮询里必须读页面记到的 URL');
  assert.match(codeOnly, /pickDirectDownloadUrl\(\s*candidates,\s*reportPattern\s*\)/u,
    '挑候选必须带店家的 reportPattern：不带的挑法会把不明文件当成日报');
  assert.match(codeOnly, /fetchDirectDownload\(\{\s*url:\s*candidate,\s*dir:\s*args\.downloads,\s*pattern:\s*reportPattern\s*\}\)/u,
    '直取必须落进 args.downloads、并用同一个 reportPattern 当最后一道门');
  assert.equal((codeOnly.match(/shopXlsxPath = /gu) ?? []).length, 2,
    '老通道与新通道都必须打 shopXlsxPath —— 下游 run-multi-shop-day 只认这一句，少一条那个通道就取不到件');
});
