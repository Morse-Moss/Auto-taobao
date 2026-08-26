import test from 'node:test';
import assert from 'node:assert/strict';

import { determineFaqOperatorState } from './faq-operator-core.mjs';

const complete = {
  manifestLocked: true,
  evidenceComplete: true,
  rawImported: true,
  analysisVerified: true,
  summaryVerified: true,
  operatorPublished: true,
};

test('operator state exposes exactly one next action', () => {
  assert.equal(determineFaqOperatorState({}).nextAction, 'LOCK_TOP5');
  assert.equal(determineFaqOperatorState({ ...complete, evidenceComplete: false, rawImported: false, analysisVerified: false, summaryVerified: false, operatorPublished: false }).nextAction, 'COLLECT_EVIDENCE');
  assert.equal(determineFaqOperatorState({ ...complete, rawImported: false, analysisVerified: false, summaryVerified: false, operatorPublished: false }).nextAction, 'IMPORT_RAW');
  assert.equal(determineFaqOperatorState({ ...complete, analysisVerified: false, summaryVerified: false, operatorPublished: false }).nextAction, 'ANALYZE');
  assert.equal(determineFaqOperatorState({ ...complete, summaryVerified: false, operatorPublished: false }).nextAction, 'SUMMARIZE');
  assert.equal(determineFaqOperatorState({ ...complete, operatorPublished: false }).nextAction, 'PUBLISH_OPERATOR_TABLE');
  assert.equal(determineFaqOperatorState(complete).nextAction, 'DONE');
});

test('operator state reports a recorded blocker before advancing', () => {
  assert.deepEqual(determineFaqOperatorState({ manifestLocked: true, blocker: { code: 'LOGIN_REQUIRED', productId: '123' } }), {
    status: 'BLOCKED',
    nextAction: 'RESOLVE_BLOCKER',
    blocker: { code: 'LOGIN_REQUIRED', productId: '123' },
  });
});

test('operator state rejects impossible stage ordering', () => {
  assert.throws(() => determineFaqOperatorState({ rawImported: true, manifestLocked: false }), /invalid FAQ operator state/u);
  assert.throws(() => determineFaqOperatorState({ summaryVerified: true, analysisVerified: false }), /invalid FAQ operator state/u);
});
