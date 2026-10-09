import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKeywordReportUrl, KEYWORD_TASK_RE, KEYWORD_ZIP_RE,
  uniqueNewKeywordTask, validateKeywordReportState, validateAudienceReportState, buildAudienceReportUrl,
  AUDIENCE_TASK_RE, AUDIENCE_ZIP_RE, uniqueNewAudienceTask, validateExportRows, buildFeishuFields,
} from './promotion-daily-report-core.mjs';
import { dimensionTriggerExpression } from './run-promotion-daily-report.mjs';

test('维度选择器兼容平台更新后的按钮和 role=button 标记', () => {
  const expression = dimensionTriggerExpression();
  assert.match(expression, /querySelectorAll\('[^']*button/u);
  assert.match(expression, /role="button"/u);
  assert.match(expression, /维度/u);
});

test('builds the keyword report URL with requested filters', () => {
  const url = buildKeywordReportUrl('2026-09-30');
  assert.match(url, /#!\/report\/keyword_promotion\?/u);
  assert.match(url, /rptType=keyword_promotion/u);
  assert.match(url, /startTime=2026-09-30/u);
  assert.match(url, /effectEqual=30/u);
  assert.match(url, /granularity=day/u);
});

test('validates the report page and all dimensions', () => {
  const state = {
    href: buildKeywordReportUrl('2026-09-30'),
    triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '昨日 2026-09-30', '分天'],
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

test('builds audience URL and validates both export shapes', () => {
  assert.match(buildAudienceReportUrl('2026-09-30'), /rptType=crowd_promotion/u);
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
      { value: '主题', checked: true },
      { value: '时间', checked: true },
      { value: '计划', checked: true },
    ],
  };
  assert.equal(validateAudienceReportState(state, '2026-09-30').ok, true);
});

test('maps export fields while leaving lookup fields empty', () => {
  const fields = buildFeishuFields(['日期', '店铺', '展现量', '空列'], ['2026-09-30', '盖文旗舰店', '12', 'x'],
    new Map([['日期', 5], ['店铺', 19], ['展现量', 2], ['空列', 5]]));
  assert.deepEqual(fields, { 日期: Date.UTC(2026, 8, 30) - 8 * 3600 * 1000, 展现量: 12 });
});
