import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKeywordReportUrl, KEYWORD_TASK_RE, KEYWORD_ZIP_RE,
  uniqueNewKeywordTask, validateKeywordReportState, validateAudienceReportState, buildAudienceReportUrl,
  AUDIENCE_TASK_RE, AUDIENCE_ZIP_RE, uniqueNewAudienceTask, validateExportRows, buildFeishuFields,
  reusablePromotionTask,
} from './promotion-daily-report-core.mjs';
import { dimensionTriggerExpression } from './run-promotion-daily-report.mjs';

test('维度选择器兼容平台更新后的按钮和 role=button 标记', () => {
  const expression = dimensionTriggerExpression();
  assert.match(expression, /textContent\|\|''\)\.trim\(\)==='维度'/u);
  assert.match(expression, /closest\('button,\[role="button"\],\[class\*="trigger"\]/u);
  assert.match(expression, /维度/u);
});

test('维度操作包含条件等待，避免弹层异步渲染竞态', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /for \(let attempt = 0; attempt < 20; attempt \+= 1\)/u);
  assert.match(source, /dimension-checkbox-missing/u);
  assert.match(source, /await sleep\(250\)/u);
});

test('提交入口包含任务列表轮询，避免任务创建延迟导致误报', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /for \(let attempt = 0; attempt < 20; attempt \+= 1\)/u);
  assert.match(source, /uniqueNewAudienceTask\(before, after\)/u);
  assert.match(source, /await sleep\(4000\)/u);
  assert.match(source, /await navigate\(args\.proxy, target, LIST_URL\);\s+const beforeRows = await readTaskRows/u);
});

test('下载入口以同一 tbody 的操作行定位并轮询显形', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /tr\[mx-stickytable-operation\^="line"\]/u);
  assert.match(source, /for \(let attempt = 0; attempt < 20; attempt \+= 1\)/u);
  assert.match(source, /querySelectorAll\('td,th,span,div'\)/u);
});

test('builds the keyword report URL with requested filters', () => {
  const url = buildKeywordReportUrl('2026-09-30');
  assert.match(url, /#!\/report\/bidword\?/u);
  assert.match(url, /rptType=bidword/u);
  assert.match(url, /queryDomains=/u);
  assert.match(url, /startTime=2026-09-30/u);
  assert.match(url, /effectEqual=30/u);
  assert.match(url, /queryDomains=%5B%22word%22%2C%22date%22%2C%22campaign%22%2C%22adgroup%22%5D/u);
});

test('validates the report page and all dimensions', () => {
  const state = {
    href: buildKeywordReportUrl('2026-09-30'),
    triggers: ['末次点击归因', '30天累计数据', '昨日 2026-09-30', '分天'],
    text: '关键词数据明细',
    dimensions: [{ value: 'keyword', checked: true }, { value: 'time', checked: true }],
  };
  assert.deepEqual(validateKeywordReportState(state, '2026-09-30'), { ok: true, date: '2026-09-30', dimensions: 2 });
});

test('recognizes exactly one newly submitted keyword task', () => {
  const task = '关键词报表_20261001_101530';
  assert.equal(KEYWORD_TASK_RE.test(task), true);
  assert.equal(KEYWORD_ZIP_RE.test(`${task}.zip`), true);
  assert.equal(uniqueNewKeywordTask(['关键词报表_20261001_101500'], [
    '关键词报表_20261001_101500', task,
  ]), task);
  assert.throws(() => uniqueNewKeywordTask([], []), /无法唯一确认/u);
});

test('重跑时只复用同目标日且生成成功的同种任务', () => {
  const rows = [
    { name: '关键词报表_20261010_180156', rangeStart: '2026-10-09', rangeEnd: '2026-10-09', status: '生成成功' },
    { name: '关键词报表_20261010_180245', rangeStart: '2026-10-08', rangeEnd: '2026-10-08', status: '生成成功' },
    { name: '人群报表_20261010_180300', rangeStart: '2026-10-09', rangeEnd: '2026-10-09', status: '生成成功' },
  ];
  assert.equal(reusablePromotionTask(rows, { kind: 'keyword', date: '2026-10-09' }), '关键词报表_20261010_180156');
  assert.equal(reusablePromotionTask(rows, { kind: 'audience', date: '2026-10-09' }), '人群报表_20261010_180300');
  assert.equal(reusablePromotionTask([{ ...rows[0], status: '生成中' }], { kind: 'keyword', date: '2026-10-09' }), null);
});

test('推广日报入口接入成熟日报的公共任务台账与恢复判据', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /judgeResume/u);
  assert.match(source, /recordSubmitted/u);
  assert.match(source, /writeLedger/u);
  assert.match(source, /promotion-task-ledger\.mjs/u);
  assert.match(source, /--ledger/u);
});

test('builds audience URL and validates both export shapes', () => {
  assert.match(buildAudienceReportUrl('2026-09-30'), /#!\/report\/crowd\?/u);
  assert.match(buildAudienceReportUrl('2026-09-30'), /rptType=crowd/u);
  assert.equal(AUDIENCE_TASK_RE.test('人群报表_20261001_101755'), true);
  assert.equal(AUDIENCE_ZIP_RE.test('人群报表_20261001_101755.zip'), true);
  assert.equal(uniqueNewAudienceTask([], ['人群报表_20261001_101755']), '人群报表_20261001_101755');
  assert.deepEqual(validateExportRows(['日期', '场景ID'], [['2026-09-30', '372']], {
    kind: '人群', expectedColumns: 2, date: '2026-09-30',
  }), { kind: '人群', columns: 2, rows: 1, date: '2026-09-30' });
});

test('validates audience page independently from keyword page', () => {
  const state = {
    href: buildAudienceReportUrl('2026-09-30'),
    triggers: ['30天累计数据', '昨日 2026-09-30', '分天'],
    text: '人群数据明细',
    dimensions: [
      { value: 'promotion', checked: true },
      { value: 'date', checked: true },
      { value: 'campaign', checked: true },
    ],
  };
  assert.equal(validateAudienceReportState(state, '2026-09-30').ok, true);
});

test('maps export fields while leaving lookup fields empty', () => {
  const fields = buildFeishuFields(['日期', '店铺', '展现量', '空列'], ['2026-09-30', '盖文旗舰店', '12', 'x'],
    new Map([['日期', 5], ['店铺', 19], ['展现量', 2], ['空列', 5]]));
  assert.deepEqual(fields, { 日期: Date.UTC(2026, 8, 30) - 8 * 3600 * 1000, 展现量: 12 });
});

test('接受关键词报表历史 75 列和平台新增 77 列', () => {
  const headers = Array.from({ length: 77 }, (_, i) => `列${i}`);
  headers[0] = '日期';
  const rows = [Array.from({ length: 77 }, (_, i) => i === 0 ? '2026-09-30' : '')];
  assert.equal(validateExportRows(headers, rows, { kind: '关键词', expectedColumns: [75, 77], date: '2026-09-30' }).columns, 77);
});

test('允许关键词推广当天无数据，保留表头作为合法空报表', () => {
  const headers = Array.from({ length: 77 }, (_, i) => `列${i}`);
  headers[0] = '日期';
  assert.equal(validateExportRows(headers, [], {
    kind: '关键词', expectedColumns: [75, 77], date: '2026-09-30', allowEmpty: true,
  }).rows, 0);
});
