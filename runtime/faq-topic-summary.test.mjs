import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_ANALYSIS_VERSION,
  FAQ_TOPIC_SUMMARY_FIELDS,
  FAQ_TOPIC_COUNT_FORMULA,
  buildTopicSummaryRecords,
} from './faq-topic-summary.mjs';

test('buildTopicSummaryRecords groups detail records by topic and links every source record', () => {
  const records = buildTopicSummaryRecords([
    { recordId: 'rec1', fields: { 高频问题或关键词: '尺寸适配' } },
    { recordId: 'rec2', fields: { 高频问题或关键词: '尺寸适配' } },
    { recordId: 'rec3', fields: { 高频问题或关键词: '包装物流' } },
  ]);
  assert.deepEqual(records, [
    { fields: { 高频问题或关键词: '包装物流', 关联分析记录: ['rec3'], 分析版本: FAQ_ANALYSIS_VERSION, 统计范围: '2026-08-23_2026-08-29' } },
    { fields: { 高频问题或关键词: '尺寸适配', 关联分析记录: ['rec1', 'rec2'], 分析版本: FAQ_ANALYSIS_VERSION, 统计范围: '2026-08-23_2026-08-29' } },
  ]);
  assert.equal(FAQ_TOPIC_COUNT_FORMULA, 'COUNTA(关联分析记录)+COUNTA(关联分析记录补充)');
  assert.equal(FAQ_TOPIC_SUMMARY_FIELDS.find((field) => field.name === '出现次数').type, 20);
});

test('buildTopicSummaryRecords splits link values at the Feishu per-field limit', () => {
  const records = buildTopicSummaryRecords(Array.from({ length: 501 }, (_, index) => ({
    recordId: `rec${index}`,
    fields: { 高频问题或关键词: '其他/无法判断' },
  })));
  assert.equal(records.length, 1);
  assert.equal(records[0].fields.关联分析记录.length, 500);
  assert.deepEqual(records[0].fields.关联分析记录补充, ['rec500']);
});
