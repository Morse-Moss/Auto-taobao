import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyStagePlan } from './weekly-workflow-core.mjs';

test('weekly workflow pauses before post-AI stages until settlement is explicit', () => {
  const plan = buildWeeklyStagePlan({ completed: ['keyword-collect', 'weekly-table-import'] });
  assert.equal(plan.status, 'PAUSED_FOR_HUMAN');
  assert.equal(plan.next, 'ai-settlement');
  assert.equal(plan.reason, 'AI_FIELDS_NOT_SETTLED');
});

test('weekly workflow advances only from a completed stage receipt', () => {
  const plan = buildWeeklyStagePlan({ completed: ['keyword-collect', 'weekly-table-import'], aiReady: true });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.next, 'ai-settlement');
  assert.throws(() => buildWeeklyStagePlan({ completed: ['not-a-stage'] }), /unknown weekly stage/);
});
