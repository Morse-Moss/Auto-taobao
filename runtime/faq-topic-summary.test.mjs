import test from 'node:test';
import assert from 'node:assert/strict';

import { FAQ_MASTER_FIELDS, FAQ_MASTER_TABLE_NAME, FAQ_WEEKLY_FIELDS, faqWeeklyTableName, rowsForFeishu } from './faq-topic-summary.mjs';
import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { buildCumulativeSummary, buildSummary, classifyAndDeduplicate, stableDedupKey } from './faq-local-summary.mjs';
import { operatorContentFromRows } from './faq-operator-content.mjs';

const operatorContent = operatorContentFromRows(FAQ_LABEL_CATALOG.filter(({ isPainPoint }) => isPainPoint).map(({ label }) => ({ 痛点类型: label, 痛点描述: `${label} 描述`, 典型用户原话: `${label} 原话` })), { sourcePath: 'operator.xlsx', sourceHash: 'a'.repeat(64) });

const raw = (period, productId, sourceType, content) => ({ period, 商品ID: productId, 来源类型: sourceType, 原始内容: content });

test('FAQ target schemas match the master and weekly contracts', () => {
  assert.equal(FAQ_MASTER_TABLE_NAME, '问题主库');
  assert.deepEqual(FAQ_MASTER_FIELDS.map((field) => field.name), ['分类标签', '是否痛点', '出现次数', '占比', '痛点描述', '典型问题', '典型用户原话']);
  assert.deepEqual(FAQ_WEEKLY_FIELDS.map((field) => field.name), ['分类标签', '是否痛点', '出现次数', '痛点描述', '典型问题', '典型用户原话']);
  assert.equal(faqWeeklyTableName('2026-08-23_2026-08-29'), '问题库_2026-08-23_2026-08-29');
});

test('fallback dedup is stable per product and source type', () => {
  const first = stableDedupKey({ productId: 'p1', sourceType: '评论', rawContent: '  很重\n难搬  ' });
  const second = stableDedupKey({ productId: 'p1', sourceType: '评论', rawContent: '很重 难搬' });
  const otherProduct = stableDedupKey({ productId: 'p2', sourceType: '评论', rawContent: '很重 难搬' });
  assert.equal(first.key, second.key);
  assert.notEqual(first.key, otherProduct.key);
  assert.equal(first.method, 'normalized-content-fallback');
});

test('weekly summary counts each label once per deduplicated record', () => {
  const input = [
    raw('w1', 'p1', '评论', '浴缸很重很难搬，而且不包安装'),
    raw('w1', 'p1', '评论', '浴缸很重很难搬，而且不包安装'),
    raw('w1', 'p2', '评论', '没有一点味道，好清洁'),
  ];
  const deduped = classifyAndDeduplicate(input);
  const summary = buildSummary(deduped.records, { period: 'w1', includeShare: false, operatorContent });
  assert.equal(deduped.records.length, 4);
  assert.equal(deduped.duplicates.length, 2);
  assert.equal(summary.denominator, 4);
  assert.equal(summary.rows.length, FAQ_LABEL_CATALOG.length);
  assert.equal(summary.rows.find((row) => row.分类标签 === '重量大/搬运困难').出现次数, 1);
  assert.equal(summary.rows.find((row) => row.分类标签 === '不包安装/安装费贵').出现次数, 1);
  assert.match(summary.rows.find((row) => row.分类标签 === '重量大/搬运困难').痛点描述, /重量/u);
  assert.equal(Object.hasOwn(summary.rows[0], '占比'), false);
});

test('cumulative summary deduplicates across weeks and share uses record denominator', () => {
  const summary = buildCumulativeSummary([
    { period: 'w1', records: [raw('w1', 'p1', '评论', '浴缸很重很难搬')] },
    { period: 'w2', records: [raw('w2', 'p1', '评论', '浴缸很重很难搬'), raw('w2', 'p2', '评论', '外观很好看')] },
  ], { operatorContent });
  assert.equal(summary.denominator, 2);
  const heavy = summary.rows.find((row) => row.分类标签 === '重量大/搬运困难');
  assert.equal(heavy.出现次数, 1);
  assert.equal(heavy.占比, 0.5);
  assert.deepEqual(Object.keys(rowsForFeishu(summary, true)[0]), ['分类标签', '是否痛点', '出现次数', '占比', '痛点描述', '典型问题', '典型用户原话']);
  assert.match(rowsForFeishu(summary, true)[0].典型问题, /？$/u);
});

test('representative quote selection is stable when input order changes', () => {
  const records = [
    { labels: ['重量大/搬运困难'], 原始内容: '搬运很麻烦，浴缸太重', sourceRecordKey: 'source-b' },
    { labels: ['重量大/搬运困难'], 原始内容: '浴缸太重，搬运很麻烦', sourceRecordKey: 'source-a' },
  ];
  const first = buildSummary(records, { period: 'w1' }).rows.find((row) => row.分类标签 === '重量大/搬运困难');
  const second = buildSummary([...records].reverse(), { period: 'w1' }).rows.find((row) => row.分类标签 === '重量大/搬运困难');
  assert.equal(first.典型用户原话, second.典型用户原话);
  assert.equal(first.representativeEvidence.sourceKey, second.representativeEvidence.sourceKey);
});
