// 详情页采集器的参数与纯函数测试。
// 不启浏览器：这里只钉「解析用户输入」和「生成页面表达式」这两件容易悄悄写错的事。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseArgs,
  parseFrequency,
  itemIdsFromCsv,
  mtopExpression,
  writeCsvFile,
  existingDataRows,
  isReusableTabUrl,
  isPoisonedTabUrl,
  closeDecision,
} from './collect-taobao-detail.mjs';

import { SKU_COLUMNS } from './taobao-detail-core.mjs';

test('从周表 CSV 的链接列取 ID，去重且保序', () => {
  const csv = [
    '序号,商品链接',
    '1,https://item.taobao.com/item.htm?id=597600994634',
    '2,https://detail.tmall.com/item.htm?spm=a1z10&id=678598686014',
    '3,https://item.taobao.com/item.htm?id=597600994634',
  ].join('\r\n');
  assert.deepEqual(itemIdsFromCsv(csv), ['597600994634', '678598686014']);
});

test('CSV 里没有 id 时返回空数组，由上层决定报错', () => {
  assert.deepEqual(itemIdsFromCsv('序号,标题\r\n1,浴缸\r\n'), []);
});

test('itemIdsFromCsv 只认 6 位以上数字，避免把 spm 里的数字当 ID', () => {
  assert.deepEqual(itemIdsFromCsv('x?id=123'), []);
});

test('parseFrequency 支持单值与区间', () => {
  assert.deepEqual(parseFrequency('5'), { min: 5000, max: 5000 });
  assert.deepEqual(parseFrequency('3-6'), { min: 3000, max: 6000 });
  assert.deepEqual(parseFrequency('6-3'), { min: 3000, max: 6000 });
  assert.throws(() => parseFrequency('abc'), /--frequency 需为/u);
  assert.throws(() => parseFrequency('0'), /必须 > 0/u);
});

test('parseArgs 要求商品来源与至少一个输出', () => {
  assert.throws(() => parseArgs([]), /--items 或 --from-csv 必填/u);
  assert.throws(() => parseArgs(['--items', '1']), /至少要给一个/u);
});

test('parseArgs 默认值：评价 1 页、每页 40 条', () => {
  const options = parseArgs(['--items', '597600994634', '--out-sku', 'a.csv']);
  assert.equal(options.reviewPageCount, 1);
  assert.equal(options.pageSizeNumber, 40);
  assert.deepEqual(options.frequencyRange, { min: 3000, max: 6000 });
});

test('parseArgs 拒绝非法页数与页大小', () => {
  assert.throws(() => parseArgs(['--items', '1', '--out-sku', 'a.csv', '--review-pages', '0']), /--review-pages/u);
  assert.throws(() => parseArgs(['--items', '1', '--out-sku', 'a.csv', '--page-size', '200']), /--page-size/u);
});

test('页面表达式带上接口名、参数和 SUCCESS 判定', () => {
  const expr = mtopExpression({
    api: 'mtop.taobao.pcdetail.data.get',
    version: '1.0',
    data: { id: '1', detail_v: '3.3.2' },
  });
  assert.match(expr, /mtop\.taobao\.pcdetail\.data\.get/u);
  assert.match(expr, /window\.lib && window\.lib\.mtop/u);
  assert.match(expr, /SUCCESS::/u);
  assert.match(expr, /"detail_v":"3\.3\.2"/u);
  // 表达式必须总是回一个 JSON 字符串，不能靠抛异常让上游瞎猜
  assert.match(expr, /JSON\.stringify/u);
});

test('页面表达式对异常也返回结构化结果', () => {
  const expr = mtopExpression({ api: 'x', version: '1', data: {} });
  assert.match(expr, /REQUEST_THREW/u);
  assert.match(expr, /NO_MTOP_SDK/u);
});

function tempCsvPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taobao-detail-'));
  return path.join(dir, name);
}

test('写盘保护：本次 0 行不覆盖已有数据（2026-10-26 事故的防回归）', () => {
  const file = tempCsvPath('sku.csv');
  const row = { 商品ID: '597600994634', 商品标题: '浴缸', 价格: '1999.00' };
  writeCsvFile(file, [row], SKU_COLUMNS);
  assert.equal(existingDataRows(file), 1);

  const result = writeCsvFile(file, [], SKU_COLUMNS);
  assert.equal(result.written, false);
  assert.equal(result.existing, 1);
  // 原文件必须原封不动
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /597600994634/u);
  assert.equal(existingDataRows(file), 1);
});

test('写盘保护：0 行时不创建一个只有表头的空表', () => {
  const file = tempCsvPath('reviews.csv');
  const result = writeCsvFile(file, [], SKU_COLUMNS);
  assert.equal(result.written, false);
  assert.equal(result.existing, 0);
  assert.equal(fs.existsSync(file), false);
});

test('--allow-empty 才允许显式写空表', () => {
  const file = tempCsvPath('sku.csv');
  writeCsvFile(file, [{ 商品ID: '597600994634', 商品标题: '浴缸', 价格: '1999.00' }], SKU_COLUMNS);
  const result = writeCsvFile(file, [], SKU_COLUMNS, { allowEmpty: true });
  assert.equal(result.written, true);
  assert.equal(existingDataRows(file), 0);
  assert.match(fs.readFileSync(file, 'utf8'), /商品ID/u);
});

test('existingDataRows 对不存在的文件返回 0 而不是抛错', () => {
  assert.equal(existingDataRows(tempCsvPath('nope.csv')), 0);
});

test('可复用的标签页只认详情/商品页，不碰搜索页', () => {
  assert.equal(isReusableTabUrl('https://detail.tmall.com/item.htm?id=1'), true);
  assert.equal(isReusableTabUrl('https://item.taobao.com/item.htm?id=1'), true);
  assert.equal(isReusableTabUrl('https://chaoshi.detail.tmall.com/item.htm?id=1'), true);
  assert.equal(isReusableTabUrl('https://s.taobao.com/search?q=x'), false);
  assert.equal(isReusableTabUrl('about:blank'), false);
  assert.equal(isReusableTabUrl(undefined), false);
});

test('被验证污染的标签页必须认出来，否则下一次又会捡到它（2026-10-26 真踩过）', () => {
  assert.equal(isPoisonedTabUrl('https://login.taobao.com/havanaone/login/login.htm'), true);
  assert.equal(isPoisonedTabUrl('https://detail.tmall.com/item.htm?x=1&_____tmd_____=/page/login_jump'), true);
  assert.equal(isPoisonedTabUrl('https://detail.tmall.com/punish?x=1'), true);
  assert.equal(isPoisonedTabUrl('https://detail.tmall.com/item.htm?id=679380994840'), false);
});

// 收尾关闭决策。这块出过两次事，规则必须钉住：
//   reused 作用域写错 → 数据写好却退出码 1；
//   注释说「复用的一律不关」而代码只要 reused 就关 → 采成功也关掉了用户的窗口。
test('自己开的干净页：关，且不啰嗦', () => {
  const d = closeDecision({ targetId: 't1', keepTargetOpen: false, reused: false });
  assert.equal(d.close, true);
  assert.deepEqual(d.warnings, []);
});

test('自己开的页撞了验证：留着，并告诉人不用去拖', () => {
  const d = closeDecision({ targetId: 't1', keepTargetOpen: true, reused: false });
  assert.equal(d.close, false);
  assert.equal(d.warnings.length, 2);
  assert.match(d.warnings[0], /已保留被验证的标签页/u);
  assert.match(d.warnings[1], /不需要人去拖/u);
});

test('复用的页被验证污染：关掉，免得下次 --reuse-tab 再捡到它', () => {
  const d = closeDecision({ targetId: 't1', keepTargetOpen: true, reused: true });
  assert.equal(d.close, true);
  assert.match(d.warnings[0], /已被验证污染/u);
});

test('复用干净页且采成功：不动它，那是用户的窗口', () => {
  const d = closeDecision({ targetId: 't1', keepTargetOpen: false, reused: true });
  assert.equal(d.close, false, '复用页采成功不得关闭用户的窗口');
  assert.deepEqual(d.warnings, []);
});

test('没有标签页时什么都不做', () => {
  assert.deepEqual(closeDecision({ targetId: '' }), { close: false, warnings: [] });
  assert.deepEqual(closeDecision({}), { close: false, warnings: [] });
});
