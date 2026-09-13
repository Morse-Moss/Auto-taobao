// 垂直切片：采集 -> 验证 -> EvidenceManifest -> 幂等提交 -> 崩溃恢复
// 目标证明：worker 被杀可从权威状态恢复；commit 前崩溃不产生重复业务副作用；UNKNOWN 只走对账。
import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';
import { createEvidenceStore, digestOf } from './evidence-store.mjs';
import { createSideEffectLedger, buildCommitKey } from './side-effect-ledger.mjs';
import { createDeterministicWorker } from './worker-adapter.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

function makeAdapter({ failWith = null, artifact = null } = {}) {
  const calls = { start: 0, release: 0 };
  return {
    calls,
    async checkSession() { return { ok: true }; },
    async prepare() {},
    async start() {
      calls.start += 1;
      if (failWith) throw Object.assign(new Error(failWith.message), { failureClass: failWith.failureClass });
      return { started: true };
    },
    async observe() { return { identity, pages: 1 }; },
    async collectArtifact({ context }) {
      const end = Number(context.verifiedCursor?.end ?? 0) + 10;
      const bytes = Buffer.from(`rows-1-${end}`);
      return {
        artifactId: `shard-${end}`,
        artifactKind: 'xws-part',
        bytes,
        range: { start: Number(context.verifiedCursor?.end ?? 0) + 1, end },
        rowCount: 10,
        sha256: digestOf(bytes),
      };
    },
    async validate() { return { ok: true }; },
    async release(_attempt, reason) { calls.release += 1; return reason; },
    ...(artifact ? { collectArtifact: async () => artifact } : {}),
  };
}

async function boot({ adapterOptions = {} } = {}) {
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `attempt-${Math.random().toString(36).slice(2, 8)}` });
  const admission = await admitTask({
    store,
    spec: {
      taskId: 'sop-xws-shard',
      workflow: 'xws.market-analysis',
      capability: 'xws.market-analysis.collect',
      identity,
      targetEnd: 40,
      verifiedCursor: { start: 1, end: 0, version: 0 },
    },
    idFactory: () => 'run-slice',
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sop-evidence-'));
  const evidenceStore = createEvidenceStore({ root: dir });
  const adapter = makeAdapter(adapterOptions);
  const worker = createDeterministicWorker({ adapter, controller, evidenceStore, contract: {} });
  const ledger = createSideEffectLedger({ store });
  return { store, controller, worker, adapter, ledger, evidenceStore, runId: admission.runId, dir };
}

test('采集 -> 验证 -> evidence manifest -> 提交 -> 游标推进', async () => {
  const { worker, runId, controller, ledger, evidenceStore, adapter } = await boot();
  const result = await worker.runOnce({ runId, input: { part: 1 }, stage: 'COLLECT', stepId: 'part-1' });
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.release, 1);

  // manifest 摘要自校验
  const verified = await evidenceStore.verifyDigest(runId, 'shard-10');
  assert.equal(verified.ok, true);

  await controller.markEvidenceValidated(runId);
  const prepared = await ledger.prepare({ runId, target: 'pg:xws_part', businessKey: 'part-1', artifactDigest: verified.sha256 });
  const committed = await ledger.commit({ commitKey: prepared.commitKey, handler: async () => ({ ok: true }) });
  assert.equal(committed.status, 'COMMITTED');
  const verifiedCommit = await ledger.verify({
    commitKey: prepared.commitKey,
    readBack: async () => ({ rows: 10, digest: verified.sha256, verifiedAt: new Date().toISOString() }),
    expected: { rows: 10, digest: verified.sha256 },
  });
  assert.equal(verifiedCommit.status, 'VERIFIED');

  await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey: prepared.commitKey }] });
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.verifiedCursor.end, 10);
  assert.equal(ctx.publicationStatus, 'NOT_REQUESTED');
});

test('同一 businessKey 重复提交只登记一条（幂等）', async () => {
  const { store, ledger, runId } = await boot();
  let sideEffects = 0;
  const first = await ledger.prepare({ runId, target: 'pg:xws_part', businessKey: 'part-1' });
  await ledger.commit({ commitKey: first.commitKey, handler: async () => { sideEffects += 1; return { ok: true }; } });
  const second = await ledger.prepare({ runId, target: 'pg:xws_part', businessKey: 'part-1' });
  assert.equal(second.reused, true);
  assert.equal(second.commitKey, first.commitKey);
  const again = await ledger.commit({ commitKey: second.commitKey, handler: async () => { sideEffects += 1; return { ok: true }; } });
  assert.equal(again.skipped, true);
  assert.equal(sideEffects, 1, '业务副作用只能发生一次');
  const commits = await store.listUnknownCommits();
  assert.equal(commits.length, 0);
});

test('commit-before-response：结果未知进 UNKNOWN，对账前不重试写入', async () => {
  const { ledger, runId, controller } = await boot();
  const prepared = await ledger.prepare({ runId, target: 'feishu:table', businessKey: 'publish-1' });
  const unknown = await ledger.commit({
    commitKey: prepared.commitKey,
    handler: async () => { const e = new Error('timeout after write'); e.unknown = true; throw e; },
  });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.requiresReconcile, true);

  // 盲目重试必须被拒绝
  const blocked = await ledger.commit({ commitKey: prepared.commitKey, handler: async () => ({ ok: true }) });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.status, 'UNKNOWN');

  // 对账：回读确认外部已生效 -> VERIFIED
  const reconciled = await ledger.reconcileUnknown({
    readBack: async () => ({ rows: 10, digest: 'd1', verifiedAt: new Date().toISOString() }),
  });
  assert.equal(reconciled.scanned, 1);
  assert.equal(reconciled.outcomes[0].status, 'VERIFIED');
  assert.equal(reconciled.outcomes[0].action, 'RESOLVED');
  await controller.markEvidenceValidated(runId).catch(() => {});
});

test('无 readBack 的 UNKNOWN 对账要求人工介入，不自动判定', async () => {
  const { ledger, runId } = await boot();
  const prepared = await ledger.prepare({ runId, target: 'feishu:table', businessKey: 'publish-2' });
  await ledger.commit({ commitKey: prepared.commitKey, handler: async () => { const e = new Error('unknown'); e.unknown = true; throw e; } });
  const result = await ledger.reconcileUnknown({});
  assert.equal(result.outcomes[0].action, 'REQUIRES_HUMAN');
  assert.equal(result.outcomes[0].status, 'UNKNOWN');
});

test('worker 崩溃后从权威状态恢复：不重复已确认副作用，继续下一分片', async () => {
  const { worker, runId, controller, ledger, store } = await boot();

  // 第一分片成功并提交
  const r1 = await worker.runOnce({ runId, stage: 'COLLECT', stepId: 'part-1' });
  assert.equal(r1.ok, true);
  await controller.markEvidenceValidated(runId);
  const c1 = await ledger.prepare({ runId, target: 'pg:xws_part', businessKey: 'part-1' });
  await ledger.commit({ commitKey: c1.commitKey, handler: async () => ({ ok: true }) });
  await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey: c1.commitKey }] });

  // 模拟 worker 被杀：attempt 处于 RUNNING 且 lease 过期
  const ctxBefore = await controller.getContext(runId);
  await store.createAttempt({ attemptId: 'attempt-dead', runId, attemptNo: 99, leaseState: 'HELD', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });

  const recovery = await controller.recover(runId);
  assert.deepEqual(recovery.reclaimedAttempts, ['attempt-dead']);
  assert.equal(recovery.verifiedCursor.end, 10);

  // 恢复后继续：范围必须接着已验证游标，副作用不重复
  const r2 = await worker.runOnce({ runId, stage: 'COLLECT', stepId: 'part-2' });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.manifest.range, { start: 11, end: 20 });
  const commits = await store.listUnknownCommits();
  assert.equal(commits.length, 0);
  const ctxAfter = await controller.getContext(runId);
  assert.equal(Number(ctxAfter.verifiedCursor.end), 10);
});

test('EVIDENCE_INVALID：坏工件被拒绝，不推进游标也不重试同一证据', async () => {
  const { store, controller } = await boot();
  const adapter = makeAdapter();
  adapter.validate = async () => ({ ok: false, code: 'STRUCTURE_INVALID', details: { missing: ['价格'] } });
  const { createDeterministicWorker } = await import('./worker-adapter.mjs');
  const worker = createDeterministicWorker({ adapter, controller, contract: {} });
  const result = await worker.runOnce({ runId: 'run-slice', stage: 'COLLECT' });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'EVIDENCE_INVALID');
  const ctx = await controller.getContext('run-slice');
  // 规范：坏证据必须被拒绝（REJECTED），且不得重试同一证据
  assert.equal(ctx.evidenceStatus, 'REJECTED');
  await assert.rejects(() => controller.advanceCursor('run-slice', { end: 10 }), /EVIDENCE_NOT_VALIDATED/u);
});

test('登录/风控类失败映射到 HUMAN_REQUIRED 并暂停', async () => {
  const { worker, runId, controller } = await boot({ adapterOptions: { failWith: { message: '需要登录: login required', failureClass: 'HUMAN_REQUIRED' } } });
  const result = await worker.runOnce({ runId, stage: 'COLLECT' });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'HUMAN_REQUIRED');
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.executionStatus, 'PAUSED');
  assert.equal(ctx.humanGateStatus, 'WAITING_HUMAN');
});

test('commitKey 由 businessKey 稳定派生', () => {
  const a = buildCommitKey({ runId: 'r', target: 't', businessKey: 'b' });
  const b = buildCommitKey({ runId: 'r', target: 't', businessKey: 'b' });
  const c = buildCommitKey({ runId: 'r', target: 't', businessKey: 'other' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 32);
});
