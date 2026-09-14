// 两条运行时缺口的回归测试（2026-09-14 真实演练暴露，缺口 A / 缺口 B）。
//
// 缺口 A：`UNKNOWN` 落在**运行**的发布轴上没有出口 —— 提交记录能对账成 VERIFIED，
//         运行却永远停在 UNKNOWN，游标推不动、幂等键不释放。后来在真实库上又发现**同源的第三格**：
//         `READY` + 提交记录停在 `COMMITTING`（上次崩溃遗留的 run b4e7e120）同样没有任何出口。
//         这里断言两个前置状态、两个出口，以及「先对账账本、再收敛运行」这条顺序闸门。
// 缺口 B：任何未终结的运行永久占住它的幂等键 —— 没有 stale 回收、也没有出口，
//         两次真实演练都只能人工 recover + cancel。这里断言回收的两道闸门与准入的自动回收。
//
// 用**真实** Controller/Ledger/admission（只有 store 在内存），断言的对象是状态机本身，不是替身。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

const spec = {
  taskId: 'sop-recovery',
  workflow: 'demo.workflow',
  capability: 'demo.publish',
  identity,
  targetEnd: 10,
  verifiedCursor: { start: 1, end: 0, version: 0 },
};

const RECEIPT = { verifiedAt: '2026-09-14T12:00:00.000Z', rows: 300, digest: 'sha256:reconciled' };
const BUSINESS_KEY = 'bk-1';

async function boot({ leaseTtlMs = 5 * 60 * 1000, runId = 'run-u', withAttempt = true } = {}) {
  const store = createMemoryStore();
  const controller = createController({
    store,
    leaseTtlMs,
    idFactory: () => `attempt-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ledger = createSideEffectLedger({ store });
  const admission = await admitTask({ store, spec, idFactory: () => runId });
  let attemptId = null;
  if (withAttempt) {
    const started = await controller.beginAttempt(runId, { stage: 'COLLECT' });
    attemptId = started.attemptId;
  }
  return { store, controller, ledger, admission, runId, attemptId };
}

// 把提交记录推到指定状态。COMMITTING 只能**直接写库**模拟：真进程死在 handler 执行中时，
// 记录就停在这一格，而 ledger.commit 不会自己返回这个状态。
async function attachCommit({ store, ledger, runId, status = 'READY' }) {
  const prepared = await ledger.prepare({ runId, target: 'feishu:base/table', businessKey: BUSINESS_KEY });
  const commitKey = prepared.commitKey;
  if (status === 'READY') return commitKey;
  if (status === 'COMMITTING') {
    await store.updateCommit(commitKey, { status: 'COMMITTING' });
    return commitKey;
  }
  if (status === 'FAILED') {
    await ledger.commit({
      commitKey, businessKey: BUSINESS_KEY,
      handler: async () => { throw Object.assign(new Error('403 forbidden'), { failureClass: 'POLICY_DENIED' }); },
    });
    return commitKey;
  }
  if (status === 'UNKNOWN') {
    await ledger.commit({
      commitKey, businessKey: BUSINESS_KEY,
      handler: async () => { throw Object.assign(new Error('socket hang up'), { unknown: true }); },
    });
    return commitKey;
  }
  // COMMITTED / VERIFIED 都先真的提交一次
  await ledger.commit({ commitKey, businessKey: BUSINESS_KEY, handler: async () => ({ ok: true }) });
  if (status === 'VERIFIED') {
    const verified = await ledger.verify({ commitKey, businessKey: BUSINESS_KEY, readBack: async () => RECEIPT });
    assert.equal(verified.status, 'VERIFIED', '夹具应当能真的把提交记录对账成 VERIFIED');
  }
  return commitKey;
}

// 走到「外部写入已提交、回读却拿不到凭据」的真实处境：COMMITTED → UNKNOWN。
async function bootUnknown(options = {}) {
  const booted = await boot(options);
  const { controller, runId, attemptId } = booted;
  await controller.completeAttempt(runId, { attemptId, nextAction: 'COMMIT' });
  await controller.markEvidenceValidated(runId);
  await controller.markPublicationReady(runId, { commitKey: null });
  await controller.markPublicationCommitted(runId, { commitKey: null });
  const ctx = await controller.settlePublication(runId, {
    verdict: 'UNKNOWN', detail: 'read-back not verified: missing credentials',
  });
  assert.equal(ctx.publicationStatus, 'UNKNOWN');
  return booted;
}

// ── 缺口 A：运行侧「外部写入已发生」的两格的出口 ──────────────────────────────

test('对账收敛：UNKNOWN + 账本已 VERIFIED + 真实回读收据 → VERIFIED，随后游标可以推进', async () => {
  const { store, controller, ledger, runId } = await bootUnknown();
  const commitKey = await attachCommit({ store, ledger, runId, status: 'VERIFIED' });

  const settled = await controller.reconcilePublication(runId, {
    verdict: 'VERIFIED', commitKey, receipt: RECEIPT, detail: 'read-back re-run after credentials fixed',
  });
  assert.equal(settled.publicationStatus, 'VERIFIED');
  assert.equal(settled.nextAction, 'ADVANCE_CURSOR');
  assert.equal(settled.blocker, null, '对账成功后必须清掉 COMMIT_UNKNOWN blocker');
  const decision = settled.decisions.at(-1);
  assert.equal(decision.kind, 'PUBLICATION');
  assert.equal(decision.status, 'VERIFIED');
  assert.equal(decision.via, 'RECONCILE');
  assert.equal(decision.receiptRows, 300);
  assert.deepEqual(decision.commitRecords, [{ commitKey, status: 'VERIFIED' }]);

  // 这是缺口 A 的实质：收敛之后游标真的能推进（旧行为永远推不动）。
  const advanced = await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey }] });
  assert.equal(advanced.verifiedCursor.end, 10);
  assert.equal((await controller.succeed(runId)).executionStatus, 'SUCCEEDED');
});

test('顺序闸门：账本还没收敛就不许收敛运行（两处真相不能打架）', async () => {
  for (const status of ['READY', 'COMMITTING', 'UNKNOWN', 'FAILED']) {
    const { store, ledger, controller, runId } = await bootUnknown();
    await attachCommit({ store, ledger, runId, status });
    await assert.rejects(
      () => controller.reconcilePublication(runId, { verdict: 'VERIFIED', receipt: RECEIPT }),
      (error) => error.code === 'COMMIT_NOT_CONVERGED' && /ledger\.(verify|reconcileUnknown)/u.test(error.details.hint),
      `提交记录停在 ${status} 时不该允许把运行收敛成 VERIFIED`,
    );
    assert.equal((await controller.getContext(runId)).publicationStatus, 'UNKNOWN');
  }
});

test('完全没有提交记录的运行不许被收敛成 VERIFIED（缺的是「效果发生过」的证据）', async () => {
  const { controller, runId } = await bootUnknown();
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'VERIFIED', receipt: RECEIPT }),
    (error) => error.code === 'COMMIT_NOT_CONVERGED' && error.details.records.length === 0,
  );
});

test('对账到 VERIFIED 必须带真实回读收据：没有凭据就拒绝（UNKNOWN 不是免回读后门）', async () => {
  const { store, ledger, controller, runId } = await bootUnknown();
  await attachCommit({ store, ledger, runId, status: 'VERIFIED' });
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'VERIFIED' }),
    (error) => error.code === 'RECEIPT_REQUIRED',
  );
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'VERIFIED', receipt: { rows: 300 } }),
    (error) => error.code === 'RECEIPT_REQUIRED',
  );
  assert.equal((await controller.getContext(runId)).publicationStatus, 'UNKNOWN');
});

test('第三格：READY + 提交记录停在 COMMITTING（进程死在 handler 里）—— 回收与两种对账都必须先过账本', async () => {
  // 这一格在真实库上真实存在（上次崩溃遗留的 run b4e7e120：publication=READY、commit=COMMITTING）。
  const { store, ledger, controller, runId } = await boot({ leaseTtlMs: -1000 });
  const commitKey = await attachCommit({ store, ledger, runId, status: 'COMMITTING' });
  await controller.markPublicationReady(runId, { commitKey });
  assert.equal((await controller.getContext(runId)).publicationStatus, 'READY');

  // 回收：可能写过，绝不能换一个 commitKey 再写一次。
  await assert.rejects(
    () => controller.reclaimStale(runId, { operator: 'ops-1' }),
    (error) => error.code === 'PUBLICATION_UNRESOLVED' && error.details.reason === 'COMMIT_NOT_TERMINAL',
  );
  // 对账成 VERIFIED：账本还没收敛 → 拒。
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'VERIFIED', receipt: RECEIPT }),
    (error) => error.code === 'COMMIT_NOT_CONVERGED',
  );
  // 声明 ABSENT：记录可能已经交付过 handler → 人也不能说它没发生。
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'ABSENT', operator: 'ops-1' }),
    (error) => error.code === 'COMMIT_HANDED_OFF' && error.details.records[0].status === 'COMMITTING',
  );

  // 唯一正确的顺序：先把账本回读对账掉，再收敛运行。
  const verified = await ledger.verify({ commitKey, businessKey: BUSINESS_KEY, readBack: async () => RECEIPT });
  assert.equal(verified.status, 'VERIFIED');
  const settled = await controller.reconcilePublication(runId, { verdict: 'VERIFIED', commitKey, receipt: RECEIPT });
  assert.equal(settled.publicationStatus, 'VERIFIED');
  assert.equal(settled.blocker, null);
});

test('对账只适用于 UNKNOWN / READY：对一条 COMMITTED 的运行调用直接抛', async () => {
  const { controller, runId, attemptId } = await boot();
  await controller.completeAttempt(runId, { attemptId, nextAction: 'COMMIT' });
  await controller.markEvidenceValidated(runId);
  await controller.markPublicationReady(runId, { commitKey: 'ck-1' });
  await controller.markPublicationCommitted(runId, { commitKey: 'ck-1' });
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'VERIFIED', receipt: RECEIPT }),
    (error) => error.code === 'PUBLICATION_STATE' && error.details.reconcilable.includes('UNKNOWN'),
  );
});

test('ABSENT 分支必须具名操作者：举证责任在人身上，不能匿名', async () => {
  const { controller, runId } = await bootUnknown();
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'ABSENT', note: 'looks absent' }),
    (error) => error.code === 'OPERATOR_REQUIRED',
  );
  assert.equal((await controller.getContext(runId)).publicationStatus, 'UNKNOWN');
});

test('ABSENT：操作者具名确认外部效果没发生 → 发布轴回 READY、运行终结、幂等键释放', async () => {
  const { store, controller, runId } = await bootUnknown();

  const settled = await controller.reconcilePublication(runId, {
    verdict: 'ABSENT', commitKey: 'ck-absent', operator: 'ops-1', note: '核对飞书：没有新建周表，写入确实没发生',
  });
  assert.equal(settled.publicationStatus, 'READY', '确定未发生就不能留在 UNKNOWN，也不能谎称 VERIFIED');
  assert.equal(settled.executionStatus, 'FAILED');
  assert.equal(settled.nextAction, 'TERMINAL');
  assert.equal(settled.blocker.class, 'TRANSIENT_EXTERNAL');
  const decision = settled.decisions.at(-1);
  assert.equal(decision.status, 'ABSENT');
  assert.equal(decision.operator, 'ops-1');

  // 幂等键确实被释放：同一个幂等键可以开新运行重跑。
  const retry = await admitTask({ store, spec, idFactory: () => 'run-retry' });
  assert.equal(retry.admitted, true);
  assert.equal(retry.runId, 'run-retry');
});

test('ABSENT 不许在「提交记录已交付过 handler」时使用（人也得看账本）', async () => {
  for (const status of ['COMMITTED', 'VERIFIED']) {
    const { store, ledger, controller, runId } = await bootUnknown();
    await attachCommit({ store, ledger, runId, status });
    await assert.rejects(
      () => controller.reconcilePublication(runId, { verdict: 'ABSENT', operator: 'ops-1' }),
      (error) => error.code === 'COMMIT_HANDED_OFF',
      `提交记录是 ${status} 时不该允许声明「没发生」`,
    );
  }
});

test('未知的对账结论被拒（不允许悄悄放宽成「大概好了」）', async () => {
  const { controller, runId } = await bootUnknown();
  await assert.rejects(
    () => controller.reconcilePublication(runId, { verdict: 'MAYBE' }),
    (error) => error.code === 'PUBLICATION_VERDICT',
  );
});

// ── 缺口 B：stale 回收与准入自动释放 ─────────────────────────────────────────

test('assessRun 只读汇报：死了吗 / 回收安全吗 / 下一步做什么，三件事分开答', async () => {
  const { controller, runId } = await boot({ leaseTtlMs: -1000 });
  const verdict = await controller.assessRun(runId);
  assert.equal(verdict.active, true);
  assert.equal(verdict.reclaimable, true);
  assert.equal(verdict.reason, 'LEASE_EXPIRED');
  assert.equal(verdict.safety.safe, true);
  assert.equal(verdict.safety.reason, 'NO_PUBLICATION_REQUESTED');
  assert.match(verdict.guidance, /safe to reclaim/u);
});

test('reclaimStale：租约过期的运行被终结，attempt 一并回收，幂等键释放', async () => {
  const { store, controller, runId } = await boot({ leaseTtlMs: -1000 });

  const result = await controller.reclaimStale(runId, { operator: 'ops-1', note: '进程崩了' });
  assert.equal(result.reclaimed, true);
  assert.equal(result.reason, 'LEASE_EXPIRED');
  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.publicationStatus, 'NOT_REQUESTED');
  assert.equal(result.reclaimedAttempts.length, 1);
  assert.equal(result.idempotencyKey, 'sop:sop-recovery:demo.publish:t-1:s-1:taobao:a-1:default');

  const attempt = (await store.listAttempts(runId))[0];
  assert.equal(attempt.status, 'FAILED');
  assert.equal(attempt.leaseState, 'EXPIRED');
  const ctx = await store.loadContext(runId);
  assert.equal(ctx.nextAction, 'TERMINAL');
  assert.equal(ctx.decisions.at(-1).kind, 'RECLAIM');

  const retry = await admitTask({ store, spec, idFactory: () => 'run-after-reclaim' });
  assert.equal(retry.admitted, true, '回收之后同一个幂等键必须能重新准入');
});

test('reclaimStale 拒绝活运行：租约还有效 → RUN_NOT_STALE（绝不去动可能正在跑的运行）', async () => {
  const { controller, runId } = await boot({ leaseTtlMs: 5 * 60 * 1000 });
  await assert.rejects(
    () => controller.reclaimStale(runId),
    (error) => error.code === 'RUN_NOT_STALE' && error.details.reason === 'LEASE_HELD',
  );
  assert.equal((await controller.getContext(runId)).executionStatus, 'RUNNING');
});

test('reclaimStale 拒绝等人工的运行：PAUSED 是合法等待，回收等于把审批中的运行杀掉', async () => {
  const store = createMemoryStore();
  const controller = createController({ store, leaseTtlMs: -1000 });
  await admitTask({
    store,
    spec: { ...spec, sideEffects: ['feishu_write'], target: 'feishu:base/table' },
    idFactory: () => 'run-gated',
  });
  assert.equal((await controller.getContext('run-gated')).executionStatus, 'PAUSED');
  await assert.rejects(
    () => controller.reclaimStale('run-gated'),
    (error) => error.code === 'RUN_NOT_STALE' && error.details.reason === 'WAITING',
  );
  assert.equal((await controller.getContext('run-gated')).executionStatus, 'PAUSED');
});

test('reclaimStale 拒绝外部写入未定的运行：UNKNOWN 只能对账，回收就是重复写入', async () => {
  const { controller, runId } = await bootUnknown({ leaseTtlMs: -1000 });
  await assert.rejects(
    () => controller.reclaimStale(runId, { operator: 'ops-1' }),
    (error) => error.code === 'PUBLICATION_UNRESOLVED'
      && error.details.publicationStatus === 'UNKNOWN'
      && /reconcilePublication/u.test(error.details.guidance),
  );
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'UNKNOWN', '判定失败不产生任何副作用');
  assert.equal(ctx.executionStatus, 'RUNNING');
});

test('reclaimStaleRuns 批量：能收的收掉、不能收的原样留着（单条失败不炸整批）', async () => {
  const store = createMemoryStore();
  const stale = createController({ store, leaseTtlMs: -1000, idFactory: () => 'att-stale' });
  await admitTask({ store, spec, idFactory: () => 'run-stale' });
  await stale.beginAttempt('run-stale', { stage: 'COLLECT' });

  const live = createController({ store, leaseTtlMs: 5 * 60 * 1000, idFactory: () => 'att-live' });
  // 换一个 capability 就换了 lane：非写操作的 lane 只由身份 + capability 决定。
  // 不换 lane 的话第二条 beginAttempt 会先被 lane 闸门（默认上限 1）挡住，测不到批量回收本身。
  await admitTask({ store, spec: { ...spec, capability: 'demo.other', scope: 'other' }, idFactory: () => 'run-live' });
  await live.beginAttempt('run-live', { stage: 'COLLECT' });

  const batch = await stale.reclaimStaleRuns({ operator: 'ops-1' });
  assert.equal(batch.scanned, 2);
  assert.deepEqual(batch.reclaimed.map((row) => row.runId), ['run-stale']);
  assert.equal(batch.skipped.length, 1);
  assert.equal(batch.skipped[0].runId, 'run-live');
  assert.equal(batch.skipped[0].code, 'RUN_NOT_STALE');
  assert.equal((await store.loadContext('run-live')).executionStatus, 'RUNNING');
});

test('批量 reaper 不依赖 this：解构出来调用同样成立', async () => {
  // 这条守的是一个很具体的坑：`reclaimStaleRuns` 内部若走 `this.reclaimStale`，
  // 调用方一解构就静默失效（this 变 undefined）。实现在关闭包里，所以解构可用。
  const store = createMemoryStore();
  const controller = createController({ store, leaseTtlMs: -1000, idFactory: () => 'att-this' });
  await admitTask({ store, spec, idFactory: () => 'run-this' });
  await controller.beginAttempt('run-this', { stage: 'COLLECT' });

  const { reclaimStaleRuns, reclaimStale, assessRun } = controller;
  assert.equal(typeof reclaimStaleRuns, 'function');
  assert.equal(typeof reclaimStale, 'function');
  assert.equal(typeof assessRun, 'function');

  const batch = await reclaimStaleRuns({ operator: 'ops-1' });
  assert.deepEqual(batch.reclaimed.map((row) => row.runId), ['run-this']);
  assert.equal((await store.loadContext('run-this')).executionStatus, 'FAILED');
});

test('准入自动回收：崩溃遗留的运行不再挡住重跑（旧行为是永久占住幂等键）', async () => {
  const store = createMemoryStore();
  const controller = createController({ store, leaseTtlMs: -1000, idFactory: () => 'att-1' });
  await admitTask({ store, spec, idFactory: () => 'run-crashed' });
  await controller.beginAttempt('run-crashed', { stage: 'COLLECT' });

  // 不带回收：还是会被挡住，但必须带上「为什么」与「下一步」。
  const blocked = await admitTask({ store, spec, idFactory: () => 'run-should-not-exist' });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.duplicateOf, 'run-crashed');
  assert.equal(blocked.reclaimable, true);
  assert.equal(blocked.reclaimReason, 'LEASE_EXPIRED');
  assert.deepEqual(blocked.duplicateStatus, { executionStatus: 'RUNNING', publicationStatus: 'NOT_REQUESTED' });
  assert.match(blocked.hint, /stale/u);

  // 带回收：准入先把 stale 运行收掉，再正常建新运行。
  const admitted = await admitTask({
    store,
    spec,
    idFactory: () => 'run-fresh',
    reclaimStale: true,
    reclaim: (runId) => controller.reclaimStale(runId, { operator: 'runner', note: 'auto reclaim' }),
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.runId, 'run-fresh');
  assert.equal((await store.loadContext('run-crashed')).executionStatus, 'FAILED');

  // 新运行接住了这个幂等键（原来的运行已不是活跃运行）。
  const again = await admitTask({ store, spec, idFactory: () => 'run-third' });
  assert.equal(again.admitted, false);
  assert.equal(again.duplicateOf, 'run-fresh');
});

test('准入自动回收不会掩盖真正的拒绝：外部写入未定时照样被挡住，并把拒绝码带回来', async () => {
  const store = createMemoryStore();
  const controller = createController({ store, leaseTtlMs: -1000, idFactory: () => 'att-u' });
  await admitTask({ store, spec, idFactory: () => 'run-unknown' });
  await controller.beginAttempt('run-unknown', { stage: 'COLLECT' });
  await controller.completeAttempt('run-unknown', { attemptId: 'att-u', nextAction: 'COMMIT' });
  await controller.markEvidenceValidated('run-unknown');
  await controller.markPublicationReady('run-unknown', { commitKey: 'ck-1' });
  await controller.settlePublication('run-unknown', { verdict: 'UNKNOWN', commitKey: 'ck-1', detail: 'read-back failed' });

  const result = await admitTask({
    store,
    spec,
    idFactory: () => 'run-nope',
    reclaimStale: true,
    reclaim: (runId) => controller.reclaimStale(runId, { operator: 'runner' }),
  });
  assert.equal(result.admitted, false);
  assert.equal(result.reclaimAttempt.reclaimed, false);
  assert.equal(result.reclaimAttempt.code, 'PUBLICATION_UNRESOLVED');
  assert.match(result.reclaimAttempt.guidance, /reconcilePublication/u);
  assert.equal((await store.loadContext('run-unknown')).publicationStatus, 'UNKNOWN');
});
