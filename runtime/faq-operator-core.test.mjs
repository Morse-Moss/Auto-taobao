import test from 'node:test';
import assert from 'node:assert/strict';

import { determineFaqOperatorState } from './faq-operator-core.mjs';

const complete = {
  manifestLocked: true,
  evidenceComplete: true,
  localSnapshotBuilt: true,
  localAnalysisVerified: true,
  localSummariesBuilt: true,
  summariesPublished: true,
};

test('operator state exposes exactly one next action', () => {
  assert.equal(determineFaqOperatorState({}).nextAction, 'LOCK_TOP5');
  assert.equal(determineFaqOperatorState({ ...complete, evidenceComplete: false, localSnapshotBuilt: false, localAnalysisVerified: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'COLLECT_EVIDENCE');
  assert.equal(determineFaqOperatorState({ ...complete, localSnapshotBuilt: false, localAnalysisVerified: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'BUILD_LOCAL_SNAPSHOT');
  assert.equal(determineFaqOperatorState({ ...complete, localAnalysisVerified: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'ANALYZE_LOCAL');
  assert.equal(determineFaqOperatorState({ ...complete, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'BUILD_LOCAL_SUMMARIES');
  assert.equal(determineFaqOperatorState({ ...complete, summariesPublished: false }).nextAction, 'PUBLISH_FEISHU_SUMMARIES');
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
  assert.throws(() => determineFaqOperatorState({ localSnapshotBuilt: true, manifestLocked: false }), /invalid FAQ operator state/u);
  assert.throws(() => determineFaqOperatorState({ localSummariesBuilt: true, localAnalysisVerified: false }), /invalid FAQ operator state/u);
});
