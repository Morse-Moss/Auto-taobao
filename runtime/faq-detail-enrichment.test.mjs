import test from 'node:test';
import assert from 'node:assert/strict';

import { operatorContentFromRows } from './faq-operator-content.mjs';
import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { assertEnrichmentReadBack, buildDetailEnrichmentPlan, FAQ_DETAIL_ENRICHMENT_FIELDS } from './faq-detail-enrichment.mjs';

const label = FAQ_LABEL_CATALOG[0].label;
const operatorContent = operatorContentFromRows(
  FAQ_LABEL_CATALOG.filter(({ isPainPoint }) => isPainPoint).map(({ label: painLabel }) => ({ 痛点类型: painLabel, 痛点描述: `${painLabel}描述`, 典型用户原话: `${painLabel}原话` })),
  { sourcePath: 'operator.xlsx', sourceHash: 'a'.repeat(64) },
);

function record(recordId, faqLabel = label) {
  return { recordId, fields: { 原始内容: `${recordId}原文`, 分类标签: faqLabel, 来源类型: '评论', 商品链接: `https://example.test/${recordId}` } };
}

test('detail enrichment plan updates only records whose three new values differ', () => {
  const first = record('r1');
  const second = record('r2');
  second.fields.痛点描述 = operatorContent.content[label].痛点描述;
  second.fields.典型问题 = operatorContent.content[label].典型问题;
  second.fields.典型用户原话 = operatorContent.content[label].典型用户原话;
  const plan = buildDetailEnrichmentPlan({ masterRecords: [first, second], weeklyRecords: [], operatorContent });
  assert.deepEqual(plan.fields, FAQ_DETAIL_ENRICHMENT_FIELDS);
  assert.deepEqual(plan.master.updates.map(({ recordId }) => recordId), ['r1']);
  assert.equal(plan.weekly.updates.length, 0);
});

test('read-back accepts enrichment while preserving all original fields', () => {
  const before = [record('r1')];
  const after = [{ recordId: 'r1', fields: { ...before[0].fields, ...operatorContent.content[label] } }];
  assert.equal(assertEnrichmentReadBack({ before, after, operatorContent }), true);
});

test('read-back rejects changed original content', () => {
  const before = [record('r1')];
  const after = [{ recordId: 'r1', fields: { ...before[0].fields, 原始内容: '被改写', ...operatorContent.content[label] } }];
  assert.throws(() => assertEnrichmentReadBack({ before, after, operatorContent }), /original field changed/u);
});

test('unknown labels are blocked before any update is generated', () => {
  assert.throws(() => buildDetailEnrichmentPlan({ masterRecords: [record('r1', '未知标签')], weeklyRecords: [], operatorContent }), /unknown or empty label/u);
});
