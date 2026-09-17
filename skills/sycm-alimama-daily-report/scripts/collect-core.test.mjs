import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SHOP_REPORT_PATTERN, PROMOTION_TASK_PATTERN, PROMOTION_ZIP_PATTERN,
  dateWithinRange, defaultDownloadsDir, listDownloads, newEntries, newestTaskName, parseCollectArgs, pickNewest,
} from './collect-core.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const readScript = (name) => readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');

function fixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'collect-core-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

test('下载目录扫描：只认形状对的文件，大小与 mtime 一起带出来', () => {
  const dir = fixture({
    '日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx': 'x'.repeat(20),
    '日报_20260917_adc987ef8d0897700e42dcf1427605b3 (2).xlsx': 'x'.repeat(24),
    '日报_20260916_othername.xlsx': 'x',
    '营销场景报表_20260917_112258.zip': 'zip',
    '~$日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx': 'lock',
    '别的文件.txt': 'x',
  });
  const shops = listDownloads(dir, SHOP_REPORT_PATTERN);
  // 关键：Excel 的锁文件 `~$…` 与不含哈希的旧名都不算候选 —— 它们是「看起来像」的那一类。
  assert.deepEqual(shops.map((entry) => entry.name).sort(),
    ['日报_20260917_adc987ef8d0897700e42dcf1427605b3 (2).xlsx',
      '日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx']);
  assert.equal(shops.find((entry) => entry.name.endsWith('(2).xlsx')).size, 24);
  assert.ok(shops.every((entry) => Number.isFinite(entry.mtimeMs)));

  assert.deepEqual(listDownloads(dir, PROMOTION_ZIP_PATTERN).map((entry) => entry.name),
    ['营销场景报表_20260917_112258.zip']);
  assert.equal(SHOP_REPORT_PATTERN.test('日报_20260916_othername.xlsx'), false,
    '哈希段缺失的文件不该被当成店铺报表');
  // 目录不存在要抛出可读错误，不许静默当成「目录里是空的」。
  assert.throws(() => listDownloads(path.join(dir, '__not_here__'), SHOP_REPORT_PATTERN), /cannot read downloads directory/u);
});

test('下载判据取文件系统：新出现的文件才是成功，且多个时取 mtime 最新的', () => {
  const before = ['日报_a.xlsx'];
  const after = ['日报_a.xlsx', '日报_b.xlsx', '日报_b (1).xlsx'];
  assert.deepEqual(newEntries(before, after), ['日报_b.xlsx', '日报_b (1).xlsx']);
  // 一个都没新增 ⇒ 空数组（调用方据此继续等，而不是「反正点了就算成功」）。
  assert.deepEqual(newEntries(before, before), []);
  assert.equal(pickNewest([]), null);

  const picked = pickNewest([
    { name: 'old.zip', mtimeMs: 100, size: 1 },
    { name: 'new.zip', mtimeMs: 300, size: 2 },
    { name: 'mid.zip', mtimeMs: 200, size: 3 },
  ]);
  assert.equal(picked.name, 'new.zip');
});

test('认下载任务：按名字里的时间戳取最新，不按「今天」过滤', () => {
  const names = [
    '营销场景报表_20260917_080428',
    '营销场景报表_20260917_112258',
    '营销场景报表_20260916_150325',
    '别的报表_20260917_235959',
    '营销场景报表_20260917_112258', // 列表里可能有重复
  ];
  assert.equal(newestTaskName(names), '营销场景报表_20260917_112258');
  // 跨零点跑的时候，「任务名里的日期」是导出日、不是目标日 —— 所以默认不按日期收窄。
  assert.equal(newestTaskName(names, { exportDate: '2026-09-16' }), '营销场景报表_20260916_150325');
  assert.equal(newestTaskName(['日报_20260917_abc.xlsx']), null);
  assert.equal(newestTaskName([]), null);
  assert.equal(PROMOTION_TASK_PATTERN.test('营销场景报表_20260917_112258'), true);
  assert.equal(PROMOTION_TASK_PATTERN.test('营销场景报表_20260917_1122'), false);
});

test('统计区间必须含目标日（含不含是这份工作簿能不能用的前提）', () => {
  assert.equal(dateWithinRange(['2026-08-18', '2026-09-16'], '2026-09-16'), true);
  assert.equal(dateWithinRange(['2026-08-18', '2026-09-15'], '2026-09-16'), false);
  assert.equal(dateWithinRange(['2026-09-16', '2026-09-16'], '2026-09-16'), true);
  assert.throws(() => dateWithinRange(null, '2026-09-16'), /invalid range/u);
  assert.throws(() => dateWithinRange(['2026/08/18', '2026-09-16'], '2026-09-16'), /invalid date/u);
  assert.throws(() => dateWithinRange(['2026-08-18', '2026-09-16'], '09-16'), /invalid date/u);
});

test('采集脚本参数：缺日期/未知参数/阶段写错一律抛错，不静默按默认值跑', () => {
  assert.deepEqual(parseCollectArgs(['--date', '2026-09-16']).date, '2026-09-16');
  assert.throws(() => parseCollectArgs([]), /missing or invalid --date/u);
  assert.throws(() => parseCollectArgs(['--date', '2026/09/16']), /missing or invalid --date/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--whatever']), /unknown argument/u);
  assert.throws(() => parseCollectArgs(['--date']), /requires a value/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--timeout-ms', '0']), /positive integer/u);

  // 只有阿里妈妈那支收 --phase，且只收这两个值。
  assert.equal(parseCollectArgs(['--date', '2026-09-16', '--phase', 'fetch'], { phases: ['submit', 'fetch'] }).phase, 'fetch');
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--phase', 'download'], { phases: ['submit', 'fetch'] }),
    /--phase must be one of submit\|fetch/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--phase', 'fetch']), /does not take --phase/u);
});

test('下载目录默认值从环境推，不许把某台机器的路径写进仓库', () => {
  assert.equal(defaultDownloadsDir({ USERPROFILE: 'C:\\Users\\someone' }),
    path.join('C:\\Users\\someone', 'Downloads'));
  assert.equal(defaultDownloadsDir({ HOME: '/home/someone' }), path.join('/home/someone', 'Downloads'));
  assert.throws(() => defaultDownloadsDir({}), /USERPROFILE\/HOME/u);
  for (const name of ['collect-shop-report.mjs', 'collect-promotion-report.mjs']) {
    assert.equal(/C:[\\/]Users[\\/]Administrator/u.test(readScript(name)), false,
      `${name} 里写死了本机路径`);
  }
});

// 这一条盯的是 2026-09-17 实亏过一次的坑：文件名在一个 tr、操作区在**紧邻的下一个 tr**。
// 按「同一行」找永远找不到，而且**不报错**，只是一直等（旧脚本空转 3 分钟）。
test('阿里妈妈取件：下载按钮必须往文件名行的下一个兄弟行找', () => {
  const source = readScript('collect-promotion-report.mjs');
  assert.match(source, /node\.nextElementSibling/u, '必须往下一个兄弟行找，而不是在文件名同一行里找');
  assert.match(source, /data-collect-task-download/u);
  // 反向自证：判据本身有效 —— 只想在同一行里找的写法要被这条规则判负。
  assert.equal(/closest\('tr'\)[\s\S]{0,80}textContent\.trim\(\) === '下载'/u.test("cell.closest('tr').querySelector('下载')"), false);
  // 点击前必须有 elementFromPoint 复核（按钮常在视口外，点击会静默落空）。
  assert.match(source, /elementFromPoint/u);
  // 成功判据必须落在文件系统上：页面说「生成成功」不算数。
  assert.match(source, /newEntries\(before, listDownloads/u);
});

test('排练开关 --locate-only：定位全走一遍但绝不点击（顺序也要对）', () => {
  assert.equal(parseCollectArgs(['--date', '2026-09-16', '--locate-only'], { flags: ['--locate-only'] }).locateOnly, true);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--locate-only']), /unknown argument/u);

  const shop = readScript('collect-shop-report.mjs');
  assert.match(shop, /if \(args\.locateOnly\) \{[\s\S]{0,200}?return;/u, '店铺脚本要有 --locate-only 的提前返回');
  const shopClick = shop.indexOf("clickVerified(args, targetId,\n    { selector: '[data-collect-download=\"1\"]'");
  assert.ok(shopClick > 0, '店铺脚本里找不到下载点击处（判据失效了）');
  assert.ok(shop.indexOf('args.locateOnly') < shopClick, '--locate-only 的返回必须出现在点击之前');

  const promo = readScript('collect-promotion-report.mjs');
  // 按阶段切出函数体再判序：同一段选择器字符串在「复核」和「点击」两处都出现，
  // 直接 indexOf 会命中复核那一处，判出错误的先后（第一版就是这么写废的）。
  const submitBody = promo.slice(promo.indexOf('async function phaseSubmit'), promo.indexOf('async function phaseFetch'));
  const fetchBody = promo.slice(promo.indexOf('async function phaseFetch'));
  for (const [label, body, clickCall] of [
    ['submit', submitBody, `await click(args, targetId, '[data-collect-alimama-download="1"]')`],
    ['fetch', fetchBody, `await click(args, targetId, '[data-collect-task-download="1"]')`],
  ]) {
    const locateAt = body.indexOf('args.locateOnly');
    const clickAt = body.indexOf(clickCall);
    assert.ok(locateAt > 0, `阿里妈妈脚本缺 ${label} 的排练分支`);
    assert.ok(clickAt > 0, `阿里妈妈脚本缺 ${label} 的点击处`);
    assert.ok(locateAt < clickAt, `--locate-only 的返回必须早于 ${label} 的点击`);
  }
  // 两个阶段都得有排练分支（只加一个是「以为排练过了」的经典形态）。
  assert.equal(promo.match(/args\.locateOnly/gu).length >= 2, true, 'submit 与 fetch 都要能排练');
});

test('采集脚本：失败要给非零退出码并说清原因，端口从登记表取', () => {
  for (const name of ['collect-shop-report.mjs', 'collect-promotion-report.mjs']) {
    const source = readScript(name);
    assert.match(source, /process\.exitCode = 1/u, `${name} 失败时必须给非零退出码`);
    assert.match(source, /采集失败：\$\{error\.message\}/u, `${name} 失败时必须打印一句可读的原因`);
    assert.match(source, /PROJECT_PORTS\.dailyReportProxy/u, `${name} 的代理端口必须来自登记表`);
    // 端口字面量不许出现（登记表是唯一来源；runtime/browser-ports.test.mjs 也在扫这一条）。
    assert.equal(/127\.0\.0\.1:\d{4}/u.test(source), false, `${name} 里出现了写死的端口`);
    assert.match(source, /expected one \w+ page/u, `${name} 必须自己确认页面恰好一个`);
  }
});
