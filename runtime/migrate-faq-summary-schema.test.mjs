import test from 'node:test';
import assert from 'node:assert/strict';

import { FAQ_MASTER_FIELDS, FAQ_WEEKLY_FIELDS } from './faq-topic-summary.mjs';
import { migrationPlan } from './migrate-faq-summary-schema.mjs';

test('schema migration plan targets the new FAQ summary contracts', () => {
  const plan = migrationPlan({
    period: '2026-08-23_2026-08-29',
    master: { tableId: 'tbl-master', name: '问题主库', fields: [{ fieldId: 'f1', fieldName: '旧字段', type: 1 }] },
    weekly: { tableId: 'tbl-weekly', name: '问题库_2026-08-23_2026-08-29', fields: [{ fieldId: 'f2', fieldName: '旧字段', type: 1 }] },
  });
  assert.equal(plan.schemaVersion, 'faq-feishu-summary-v2.0.0');
  assert.match(plan.planHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(plan.targets.master.targetFields, FAQ_MASTER_FIELDS);
  assert.deepEqual(plan.targets.weekly.targetFields, FAQ_WEEKLY_FIELDS);
});

test('schema migration plan hash changes when live schema changes', () => {
  const input = { period: '2026-08-23_2026-08-29', master: { tableId: 'tbl-master', name: '问题主库', fields: [] }, weekly: { tableId: 'tbl-weekly', name: '问题库_2026-08-23_2026-08-29', fields: [] } };
  const first = migrationPlan(input);
  const second = migrationPlan({ ...input, weekly: { ...input.weekly, fields: [{ fieldId: 'f1', fieldName: '分类标签', type: 1 }] } });
  assert.notEqual(first.planHash, second.planHash);
});
