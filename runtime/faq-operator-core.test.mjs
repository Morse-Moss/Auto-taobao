import test from 'node:test';
import assert from 'node:assert/strict';

import { describeFaqStages, determineFaqOperatorState, ORDERED_STAGES } from './faq-operator-core.mjs';

const complete = {
  manifestLocked: true,
  evidenceComplete: true,
  localSnapshotBuilt: true,
  localAnalysisVerified: true,
  aiReviewComplete: true,
  humanReviewComplete: true,
  localSummariesBuilt: true,
  summariesPublished: true,
};

test('operator state exposes exactly one next action', () => {
  assert.equal(determineFaqOperatorState({}).nextAction, 'LOCK_TOP5');
  assert.equal(determineFaqOperatorState({ ...complete, evidenceComplete: false, localSnapshotBuilt: false, localAnalysisVerified: false, localSummariesBuilt: false, aiReviewComplete: false, humanReviewComplete: false, summariesPublished: false }).nextAction, 'COLLECT_EVIDENCE');
  assert.equal(determineFaqOperatorState({ ...complete, localSnapshotBuilt: false, localAnalysisVerified: false, localSummariesBuilt: false, aiReviewComplete: false, humanReviewComplete: false, summariesPublished: false }).nextAction, 'BUILD_LOCAL_SNAPSHOT');
  assert.equal(determineFaqOperatorState({ ...complete, localAnalysisVerified: false, aiReviewComplete: false, humanReviewComplete: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'ANALYZE_LOCAL');
  assert.equal(determineFaqOperatorState({ ...complete, aiReviewComplete: false, humanReviewComplete: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'RUN_AI_REVIEW');
  assert.equal(determineFaqOperatorState({ ...complete, humanReviewComplete: false, localSummariesBuilt: false, summariesPublished: false }).nextAction, 'REVIEW_AI_HUMAN_QUEUE');
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
  assert.throws(() => determineFaqOperatorState({ aiReviewComplete: true, localAnalysisVerified: false }), /invalid FAQ operator state/u);
  assert.throws(() => determineFaqOperatorState({ humanReviewComplete: true, aiReviewComplete: false }), /invalid FAQ operator state/u);
  assert.throws(() => determineFaqOperatorState({ localSummariesBuilt: true, humanReviewComplete: false }), /invalid FAQ operator state/u);
});

// 运营台的进度块直接渲染它，所以它必须与 determineFaqOperatorState 逐条同构 ——
// 尤其是「哪个阶段算当前」。二者分家会让页面把当前阶段指到别处。
test('stage breakdown marks exactly the stage the operator state calls next', () => {
  const stages = describeFaqStages({ ...complete, summariesPublished: false });
  assert.equal(stages.length, ORDERED_STAGES.length);
  assert.equal(stages.filter((stage) => stage.current).length, 1);
  assert.equal(stages.find((stage) => stage.current).name, 'PUBLISH_FEISHU_SUMMARIES');
  assert.equal(stages.at(-1).complete, false);
  assert.equal(stages.at(-1).skipped, false);

  const done = describeFaqStages(complete);
  assert.deepEqual(done.map((stage) => stage.complete), ORDERED_STAGES.map(() => true));
  assert.equal(done.some((stage) => stage.current), false);
});

// 空发布豁免只许有一份实现：状态机判 DONE 的周期，进度块必须 8 步全勾上。
// 否则一个已经跑完的周期会在页面上显示成「还差最后一步」。
test('vacuous publish is rendered as a completed (and labelled) final stage', () => {
  const input = { manifestLocked: true, evidenceComplete: true, localSnapshotBuilt: true, localAnalysisVerified: true, aiReviewComplete: true, humanReviewComplete: true, localSummariesBuilt: true, summariesPublished: false, rawRecords: 0 };
  assert.equal(determineFaqOperatorState(input).status, 'DONE');
  const stages = describeFaqStages(input);
  const last = stages.at(-1);
  assert.equal(last.complete, true);
  assert.equal(last.skipped, true);
  assert.match(last.reason, /0 条源记录/u);
  assert.equal(stages.some((stage) => stage.current), false);
});

// 反过来：非 0 记录时 summariesPublished=false 就是真的没发布，不许被豁免掉。
test('vacuous publish exemption does not apply when the period has source records', () => {
  const input = { manifestLocked: true, evidenceComplete: true, localSnapshotBuilt: true, localAnalysisVerified: true, aiReviewComplete: true, humanReviewComplete: true, localSummariesBuilt: true, summariesPublished: false, rawRecords: 27 };
  const last = describeFaqStages(input).at(-1);
  assert.equal(last.complete, false);
  assert.equal(last.skipped, false);
  assert.equal(last.current, true);
});
