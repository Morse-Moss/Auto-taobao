import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask, validateTaskSpec, buildIdempotencyKey } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

const spec = {
  taskId: 'sop-xws-shard',
  workflow: 'xws.market-analysis',
  capability: 'xws.market-analysis.collect',
  identity,
  targetEnd: 40,
  verifiedCursor: { start: 1, end: 0, version: 0 },
};

async function boot() {
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `attempt-${Math.random().toString(36).slice(2)}` });
  const admission = await admitTask({ store, spec, idFactory: () => 'run-fixed' });
  return { store, controller, admission, runId: admission.runId };
}

test('taskSpec 校验：缺身份字段被拒', () => {
  assert.equal(validateTaskSpec({ taskId: 'a', workflow: 'b', capability: 'c', identity: {} }).ok, false);
  assert.equal(validateTaskSpec(spec).ok, true);
  assert.match(buildIdempotencyKey({ taskId: 't', identity, capability: 'c' }), /^sop:t:c:t-1:s-1:taobao:a-1:default$/u);
});

test('准入成功：run 落库，状态 QUEUED，nextAction START', async () => {
  const { store, runId, admission } = await boot();
  assert.equal(admission.admitted, true);
  const row = await store.loadRun(runId);
  assert.equal(row.executionStatus, 'QUEUED');
  const ctx = await store.loadContext(runId);
  assert.equal(ctx.nextAction, 'START');
  assert.equal(ctx.verifiedCursor.end, 0);
});

test('高风险副作用准入后进入人工闸门，不能直接开始', async () => {
  const store = createMemoryStore();
  const controller = createController({ store });
  const admission = await admitTask({
    store,
    spec: { ...spec, sideEffects: ['feishu_write'], target: 'feishu:base/table' },
    idFactory: () => 'run-risky',
  });
  assert.equal(admission.admitted, true);
  assert.equal(admission.context.humanGateStatus, 'WAITING_HUMAN');
  assert.equal(admission.context.executionStatus, 'PAUSED');
  await assert.rejects(() => controller.beginAttempt('run-risky'), /waiting for human approval/u);
  const approved = await controller.approve('run-risky', { operator: 'me' });
  assert.equal(approved.humanGateStatus, 'APPROVED');
  assert.equal(approved.executionStatus, 'QUEUED');
});

test('同一 lane 并发准入：第二条被拒且失败分类为 RESOURCE_BUSY', async () => {
  const store = createMemoryStore();
  await admitTask({ store, spec, idFactory: () => 'run-1' });
  const second = await admitTask({ store, spec, idFactory: () => 'run-2' });
  assert.equal(second.admitted, false);
  assert.equal(second.failureClass, 'RESOURCE_BUSY');
});

test('beginAttempt 持有 lease 并推进 RUNNING', async () => {
  const { controller, runId, store } = await boot();
  const ctx = await controller.beginAttempt(runId, { stage: 'COLLECT', stepId: 'part-1' });
  assert.equal(ctx.executionStatus, 'RUNNING');
  assert.equal(ctx.leaseStatus, 'HELD');
  assert.equal(ctx.stage, 'COLLECT');
  const attempts = await store.listAttempts(runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].leaseState, 'HELD');
});

test('失败分类：TRANSIENT_EXTERNAL 预算内进 RETRY_WAIT，耗尽进 FAILED', async () => {
  const { controller, runId, store } = await boot();
  const c1 = await controller.beginAttempt(runId, { stage: 'S1' });
  const after1 = await controller.failAttempt(runId, { attemptId: c1.attemptId, failureClass: 'TRANSIENT_EXTERNAL', detail: 'timeout' });
  assert.equal(after1.executionStatus, 'RETRY_WAIT');
  assert.equal(after1.retryUsed.transientExternal, 1);

  const c2 = await controller.beginAttempt(runId, { stage: 'S1' });
  const after2 = await controller.failAttempt(runId, { attemptId: c2.attemptId, failureClass: 'TRANSIENT_EXTERNAL', detail: 'timeout' });
  assert.equal(after2.executionStatus, 'RETRY_WAIT');
  const c3 = await controller.beginAttempt(runId, { stage: 'S1' });
  const after3 = await controller.failAttempt(runId, { attemptId: c3.attemptId, failureClass: 'TRANSIENT_EXTERNAL', detail: 'timeout' });
  assert.equal(after3.executionStatus, 'RETRY_WAIT');
  const c4 = await controller.beginAttempt(runId, { stage: 'S1' });
  const after4 = await controller.failAttempt(runId, { attemptId: c4.attemptId, failureClass: 'TRANSIENT_EXTERNAL', detail: 'timeout' });
  assert.equal(after4.executionStatus, 'FAILED', '预算耗尽必须进入明确终态');
});

test('HUMAN_REQUIRED 进 PAUSED + WAITING_HUMAN；COMMIT_UNKNOWN 进 UNKNOWN 不重试', async () => {
  const { controller, runId } = await boot();
  const a = await controller.beginAttempt(runId, { stage: 'S1' });
  const paused = await controller.failAttempt(runId, { attemptId: a.attemptId, failureClass: 'HUMAN_REQUIRED', detail: 'login expired' });
  assert.equal(paused.executionStatus, 'PAUSED');
  assert.equal(paused.humanGateStatus, 'WAITING_HUMAN');

  const approved = await controller.approve(runId, { operator: 'me' });
  const b = await controller.beginAttempt(runId, { stage: 'S1' });
  const unknown = await controller.failAttempt(runId, { attemptId: b.attemptId, failureClass: 'COMMIT_UNKNOWN', detail: 'timeout after write' });
  assert.equal(unknown.publicationStatus, 'UNKNOWN');
  assert.equal(unknown.nextAction, 'RECONCILE_COMMIT');
  assert.notEqual(unknown.executionStatus, 'RETRY_WAIT', 'UNKNOWN 不得当作可重试');
});

test('游标只能前进，且只能在 VALIDATED 证据上推进', async () => {
  const { controller, runId } = await boot();
  const a = await controller.beginAttempt(runId, { stage: 'S1' });
  await controller.completeAttempt(runId, { attemptId: a.attemptId });
  await assert.rejects(() => controller.advanceCursor(runId, { end: 10 }), /EVIDENCE_NOT_VALIDATED/u);
  await controller.markEvidenceValidated(runId);
  const advanced = await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey: 'k1' }] });
  assert.equal(advanced.verifiedCursor.end, 10);
  assert.equal(advanced.verifiedCursor.version, 1);
  await assert.rejects(() => controller.advanceCursor(runId, { end: 5 }), /CURSOR_REGRESSION/u);
});

test('终态拒绝再次转移；CAS 冲突可被检测', async () => {
  const { controller, runId, store } = await boot();
  await controller.succeed(runId);
  await assert.rejects(() => controller.beginAttempt(runId), /terminal/u);

  const fresh = await boot();
  const ctx = await fresh.controller.getContext(fresh.runId);
  await assert.rejects(
    () => fresh.store.saveContext(fresh.runId, ctx, ctx.contextVersion + 99),
    (error) => error.code === 'CAS_CONFLICT',
  );
});

test('recover：只从权威 store 恢复，回收过期 lease', async () => {
  const { controller, runId, store } = await boot();
  const ctx = await controller.beginAttempt(runId, { stage: 'S1' });
  // 模拟 worker 被杀：attempt 仍是 RUNNING，但 lease 已过期
  await store.updateAttempt(ctx.attemptId, { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
  const recovery = await controller.recover(runId);
  assert.deepEqual(recovery.reclaimedAttempts, [ctx.attemptId]);
  assert.equal(recovery.verifiedCursor.end, 0);
  const attempts = await store.listAttempts(runId);
  assert.equal(attempts[0].status, 'FAILED');
  assert.equal(attempts[0].leaseState, 'EXPIRED');
});
