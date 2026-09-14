// 阶段 4b 测试：发布 / 回读路径 —— 只有「提交 + 真实回读 + manifest 发布期验证器」全过才算 VERIFIED
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';
import { createCapabilityPublisher, publicationValidatorsOf, writesExternally } from './publication.mjs';
import { buildRegistry } from './skill-registry.mjs';
import { listValidatorNames } from './validation-registry.mjs';
import { PUBLICATION_VALIDATION_NAMES, validateManifest } from './skill-manifest.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

function makeManifest({
  validation = ['digest', 'readback', 'publication'],
  sideEffects = ['local_parse', 'feishu_write'],
  permissions = ['filesystem.write', 'feishu.api', 'network.external'],
} = {}) {
  return {
    name: 'demo.publish',
    version: '1.0.0',
    kind: 'capability',
    description: 'demo publish capability',
    entry: 'scripts/publish.mjs',
    inputs: [{ name: 'window', type: 'date_range', required: true }],
    outputs: [{ name: 'receipt', type: 'receipt' }],
    preconditions: ['feishu_app_access'],
    permissions,
    sideEffects,
    dependencies: [],
    validation,
    recovery: { supported: true, resumeFrom: 'idempotent_commit' },
  };
}

const OK_RECEIPT = (rows = 10) => ({ verifiedAt: new Date().toISOString(), rows, digest: 'sha256:receipt-digest' });

async function boot({
  validation, sideEffects, permissions, contract = {},
  markEvidenceValidatedFirst = false, autoApprove = true, specSideEffects = null,
} = {}) {
  const manifest = makeManifest({ validation, sideEffects, permissions });
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: null }], knownValidators: listValidatorNames() });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));

  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `attempt-${Math.random().toString(36).slice(2, 8)}` });
  const ledger = createSideEffectLedger({ store });
  const admission = await admitTask({
    store,
    spec: {
      taskId: 'sop-publish',
      workflow: 'demo.workflow',
      capability: 'demo.publish',
      identity,
      targetEnd: 10,
      verifiedCursor: { start: 1, end: 0, version: 0 },
      // 准入用的副作用声明可以与 manifest 不同——这正是要防的绕过路径。
      sideEffects: specSideEffects ?? [...(manifest.sideEffects ?? [])],
      write: true,
    },
    idFactory: () => 'run-pub',
  });
  const runId = admission.runId;

  // 写外部的高风险能力准入即进人工闸门；要跑后续阶段必须先记录审批。
  const gateOpened = admission.context?.humanGateStatus === 'WAITING_HUMAN';
  if (gateOpened && autoApprove) await controller.approve(runId, { operator: 'test-operator' });

  let attemptId = null;
  if (markEvidenceValidatedFirst) {
    const started = await controller.beginAttempt(runId, { stage: 'PUBLISH' });
    attemptId = started.attemptId;
    await controller.completeAttempt(runId, { attemptId, nextAction: 'COMMIT' });
    await controller.markEvidenceValidated(runId);
  }

  const publisher = createCapabilityPublisher({ registry, controller, ledger, capabilityId: 'demo.publish', contract });
  return { publisher, manifest, registry, controller, ledger, store, runId, attemptId, gateOpened, admission };
}

test('发布期验证器名单由 Validator 实现表的 stage 派生', () => {
  assert.deepEqual([...PUBLICATION_VALIDATION_NAMES].sort(), ['publication', 'readback']);
  assert.deepEqual(publicationValidatorsOf({ validation: ['digest', 'readback', 'publication'] }).sort(), ['publication', 'readback']);
  assert.deepEqual(publicationValidatorsOf({ validation: ['digest', 'row_count'] }), []);
});

test('manifest 校验拒绝「写外部但没有发布期验证器」的能力', () => {
  const check = validateManifest(makeManifest({ validation: ['digest', 'structure'] }));
  assert.equal(check.ok, false);
  assert.ok(check.errorCodes.includes('PUBLICATION_VALIDATOR_MISSING'), JSON.stringify(check.errors));
});

test('同一能力只要补上发布期验证器就通过（证明拦的是这条义务本身）', () => {
  const check = validateManifest(makeManifest({ validation: ['digest', 'structure', 'readback'] }));
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('adapter 不受该义务约束（发布验收责任在能力层）', () => {
  const adapter = { ...makeManifest({ validation: [] }), name: 'adapter.demo', kind: 'adapter' };
  const check = validateManifest(adapter);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test('不写外部的能力没有发布义务：不触碰发布轴，也不调用 handler', async () => {
  const { publisher, controller, runId } = await boot({ sideEffects: ['local_parse'], permissions: ['filesystem.write'], validation: ['digest'] });
  let handlerCalls = 0;
  const result = await publisher.publish({
    runId, businessKey: 'k-1',
    handler: async () => { handlerCalls += 1; return {}; },
    readBack: async () => OK_RECEIPT(),
  });
  assert.equal(result.verdict, 'NOT_REQUESTED');
  assert.equal(handlerCalls, 0);
  assert.equal((await controller.getContext(runId)).publicationStatus, 'NOT_REQUESTED');
});

test('运行时兜底：绕过注册期校验也不会静默放行', async () => {
  // 直接用一个不校验的 stub registry 返回「写外部但没有发布期验证器」的 manifest，
  // 证明运行时这道闸门独立于 manifest 校验存在。
  const badManifest = makeManifest({ validation: ['digest'] });
  const stubRegistry = {
    require: () => ({ manifest: badManifest, digest: 'sha256:stub' }),
    assertSideEffectDeclared: () => true,
  };
  const store = createMemoryStore();
  const controller = createController({ store });
  const ledger = createSideEffectLedger({ store });
  await admitTask({
    store,
    spec: { taskId: 't', workflow: 'w', capability: 'demo.publish', identity, targetEnd: 10, verifiedCursor: { start: 1, end: 0, version: 0 } },
    idFactory: () => 'run-stub',
  });
  const publisher = createCapabilityPublisher({ registry: stubRegistry, controller, ledger, capabilityId: 'demo.publish' });
  assert.equal(publisher.writesExternally, true);
  assert.throws(() => publisher.assertPublicationDeclared(), (e) => e.code === 'PUBLICATION_VALIDATOR_MISSING');
  await assert.rejects(
    () => publisher.publish({ runId: 'run-stub', businessKey: 'k', handler: async () => ({}), readBack: async () => OK_RECEIPT() }),
    (e) => e.code === 'PUBLICATION_VALIDATOR_MISSING',
  );
});

test('未审批时拒绝提交：人工闸门在提交路径上再守一道', async () => {
  const { publisher, runId, gateOpened, controller } = await boot({ autoApprove: false });
  assert.equal(gateOpened, true, '写外部的能力准入即应开闸');
  assert.equal(publisher.riskClass, 'HIGH');
  assert.equal(publisher.approvalRequired, true);
  assert.equal((await controller.getContext(runId)).humanGateStatus, 'WAITING_HUMAN');

  let handlerCalls = 0;
  await assert.rejects(
    () => publisher.publish({
      runId, businessKey: 'biz-gate', handler: async () => { handlerCalls += 1; return {}; },
      readBack: async () => OK_RECEIPT(),
    }),
    (e) => e.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(handlerCalls, 0, '闸门未过时不得产生任何外部效果');
  assert.equal((await controller.getContext(runId)).publicationStatus, 'NOT_REQUESTED');
});

test('按只读副作用准入也无法绕过人工闸门（风险取自 manifest 而不是准入参数）', async () => {
  // 准入时只声明 local_parse → 风险判 LOW → 不开闸；但 manifest 声明了 feishu_write，
  // 提交路径必须按 manifest 重新判定风险，否则这就是一条绕过闸门的路。
  const { publisher, admission, runId, controller } = await boot({ autoApprove: false, specSideEffects: ['local_parse'] });
  assert.equal(admission.context.humanGateStatus, 'NONE', '准入阶段确实没开闸');
  assert.equal(publisher.riskClass, 'HIGH', '提交阶段按 manifest 重判为高风险');

  let handlerCalls = 0;
  await assert.rejects(
    () => publisher.publish({
      runId, businessKey: 'biz-bypass', handler: async () => { handlerCalls += 1; return {}; },
      readBack: async () => OK_RECEIPT(),
    }),
    (e) => e.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(handlerCalls, 0);
  assert.equal((await controller.getContext(runId)).publicationStatus, 'NOT_REQUESTED');
});

test('提交 + 真实回读 + 发布期验证器全过：publicationStatus=VERIFIED 且游标可推进', async () => {
  const { publisher, controller, runId } = await boot({
    contract: { publication: { rows: 10 } },
    markEvidenceValidatedFirst: true,
  });
  const result = await publisher.publish({
    runId, businessKey: 'biz-2026-09-01', effectClass: 'feishu_write',
    handler: async () => ({ ok: true }),
    readBack: async () => OK_RECEIPT(10),
    expected: { rows: 10 },
  });
  assert.equal(result.verdict, 'VERIFIED', JSON.stringify(result));
  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.validation.results.map((r) => r.name).sort(), ['publication', 'readback']);

  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'VERIFIED');
  assert.equal(ctx.nextAction, 'ADVANCE_CURSOR');

  const advanced = await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey: result.commitKey }] });
  assert.equal(advanced.verifiedCursor.end, 10);
  assert.equal(advanced.sideEffectRefs.length, 1);
});

test('回读行数不符：UNKNOWN + 对账动作，游标不得推进', async () => {
  const { publisher, controller, runId } = await boot({
    contract: { publication: { rows: 10 } },
    markEvidenceValidatedFirst: true,
  });
  const result = await publisher.publish({
    runId, businessKey: 'biz-mismatch',
    handler: async () => ({ ok: true }),
    readBack: async () => OK_RECEIPT(7),
    expected: { rows: 10 },
  });
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.requiresReconcile, true);

  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'UNKNOWN');
  assert.equal(ctx.nextAction, 'RECONCILE_COMMIT');
  assert.equal(ctx.blocker.class, 'COMMIT_UNKNOWN');
  await assert.rejects(() => controller.advanceCursor(runId, { end: 10 }), /PUBLICATION_NOT_SETTLED/u);
});

test('可证伪：账本回读通过但 manifest 的 readback 验证器失败 → 仍然 UNKNOWN', async () => {
  // expected.rows 与收据一致（账本判通过），但契约要求 readback.rows=99；
  // 这个矛盾只有 manifest 声明的验证器能看到，所以结论必须由它决定。
  const { publisher, controller, runId } = await boot({ contract: { readback: { rows: 99 } } });
  const result = await publisher.publish({
    runId, businessKey: 'biz-validator-gate',
    handler: async () => ({ ok: true }),
    readBack: async () => OK_RECEIPT(10),
    expected: { rows: 10 },
  });
  assert.equal(result.verdict, 'UNKNOWN', JSON.stringify(result));
  assert.deepEqual(result.validation.codes, ['PUBLICATION_UNVERIFIED']);
  assert.equal((await controller.getContext(runId)).publicationStatus, 'UNKNOWN');
});

test('不声明 readback 时同一份收据被放行（证明是 manifest 在拦）', async () => {
  const { publisher, controller, runId } = await boot({ validation: ['publication'], contract: { readback: { rows: 99 } } });
  const result = await publisher.publish({
    runId, businessKey: 'biz-no-readback',
    handler: async () => ({ ok: true }),
    readBack: async () => OK_RECEIPT(10),
    expected: { rows: 10 },
  });
  assert.equal(result.verdict, 'VERIFIED', JSON.stringify(result));
  assert.deepEqual(result.validation.results.map((r) => r.name), ['publication']);
  assert.equal((await controller.getContext(runId)).publicationStatus, 'VERIFIED');
});

test('提交失败按结构化状态码归类：4xx 判策略拒绝，5xx 判瞬时（不一律当 BUG 停线）', async () => {
  const a = await boot();
  const r1 = await a.publisher.publish({
    runId: a.runId, businessKey: 'biz-4xx',
    handler: async () => { const error = new Error('Feishu API failed: delete target'); error.status = 403; throw error; },
    readBack: async () => OK_RECEIPT(),
  });
  assert.equal(r1.verdict, 'REJECTED');
  const ctx1 = await a.controller.getContext(a.runId);
  assert.equal(ctx1.blocker.class, 'POLICY_DENIED', '4xx 是策略/配置类拒绝，不是 BUG');
  assert.equal(ctx1.executionStatus, 'FAILED');

  const b = await boot();
  const r2 = await b.publisher.publish({
    runId: b.runId, businessKey: 'biz-5xx',
    handler: async () => { const error = new Error('upstream unavailable'); error.status = 503; throw error; },
    readBack: async () => OK_RECEIPT(),
  });
  assert.equal(r2.verdict, 'REJECTED');
  const ctx2 = await b.controller.getContext(b.runId);
  assert.equal(ctx2.blocker.class, 'TRANSIENT_EXTERNAL');
  assert.equal(ctx2.executionStatus, 'RETRY_WAIT');
  assert.equal(ctx2.retryUsed.transientExternal, 1);
});

test('提交结果未知：UNKNOWN，且不做回读、不重试', async () => {
  const { publisher, controller, runId } = await boot();
  let readBackCalls = 0;
  const result = await publisher.publish({
    runId, businessKey: 'biz-unknown',
    handler: async () => { throw Object.assign(new Error('socket hang up'), { unknown: true }); },
    readBack: async () => { readBackCalls += 1; return OK_RECEIPT(); },
  });
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(readBackCalls, 0);
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'UNKNOWN');
  assert.equal(ctx.nextAction, 'RECONCILE_COMMIT');
});

test('确定性拒绝：REJECTED，发布轴回到「未提交」，策略拒绝进终止', async () => {
  const { publisher, controller, runId } = await boot();
  const result = await publisher.publish({
    runId, businessKey: 'biz-rejected',
    handler: async () => { throw Object.assign(new Error('403 forbidden'), { failureClass: 'POLICY_DENIED' }); },
    readBack: async () => OK_RECEIPT(),
  });
  assert.equal(result.verdict, 'REJECTED');
  const ctx = await controller.getContext(runId);
  // 效果确定未发生：不能标记 VERIFIED，也不谎称 UNKNOWN
  assert.equal(ctx.publicationStatus, 'READY');
  assert.equal(ctx.executionStatus, 'FAILED');
  assert.equal(ctx.nextAction, 'TERMINAL');
  assert.equal(ctx.blocker.class, 'POLICY_DENIED');
});

test('确定性瞬时失败：REJECTED + 重试等待，重试计数递增', async () => {
  const { publisher, controller, runId } = await boot();
  const result = await publisher.publish({
    runId, businessKey: 'biz-transient',
    handler: async () => { throw Object.assign(new Error('503 service unavailable'), { failureClass: 'TRANSIENT_EXTERNAL' }); },
    readBack: async () => OK_RECEIPT(),
  });
  assert.equal(result.verdict, 'REJECTED');
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.executionStatus, 'RETRY_WAIT');
  assert.equal(ctx.retryUsed.transientExternal, 1);
  assert.equal(ctx.publicationStatus, 'READY');
});

test('幂等：同一 commitKey 只产生一次业务效果', async () => {
  const { publisher, ledger, runId } = await boot({ contract: { publication: { rows: 10 } } });
  let effects = 0;
  const first = await publisher.publish({
    runId, businessKey: 'biz-idem',
    handler: async () => { effects += 1; return {}; },
    readBack: async () => OK_RECEIPT(10),
    expected: { rows: 10 },
  });
  assert.equal(first.verdict, 'VERIFIED');
  // 账本层再提交一次：同 commitKey 已 COMMITTED，直接短路，不产生第二个业务效果
  const again = await ledger.commit({ commitKey: first.commitKey, handler: async () => { effects += 1; return {}; }, businessKey: 'biz-idem' });
  assert.equal(again.skipped, true);
  assert.equal(effects, 1);
});

test('已 VERIFIED 的 run 不允许再次发布（防止重复对外写入）', async () => {
  const { publisher, runId } = await boot({ contract: { publication: { rows: 10 } } });
  const first = await publisher.publish({
    runId, businessKey: 'biz-once',
    handler: async () => ({}),
    readBack: async () => OK_RECEIPT(10),
    expected: { rows: 10 },
  });
  assert.equal(first.verdict, 'VERIFIED');
  await assert.rejects(
    () => publisher.publish({ runId, businessKey: 'biz-twice', handler: async () => ({}), readBack: async () => OK_RECEIPT(10), expected: { rows: 10 } }),
    (e) => e.code === 'PUBLICATION_STATE',
  );
});

test('副作用闸门：未在 manifest 声明的外部副作用被拒绝', async () => {
  const { publisher, runId } = await boot();
  await assert.rejects(
    () => publisher.publish({ runId, businessKey: 'biz-gate', effectClass: 'postgres_write', handler: async () => ({}), readBack: async () => OK_RECEIPT() }),
    (e) => e.code === 'SIDE_EFFECT_UNDECLARED',
  );
});

test('缺少 businessKey 时拒绝提交（幂等键是硬前提）', async () => {
  const { publisher, runId } = await boot();
  await assert.rejects(
    () => publisher.publish({ runId, handler: async () => ({}), readBack: async () => OK_RECEIPT() }),
    (e) => e.code === 'BUSINESS_KEY_REQUIRED',
  );
});

test('settlePublication 非法转移直接抛错', async () => {
  const store = createMemoryStore();
  const controller = createController({ store });
  await admitTask({
    store,
    spec: { taskId: 't2', workflow: 'w', capability: 'demo.publish', identity, targetEnd: 10, verifiedCursor: { start: 1, end: 0, version: 0 } },
    idFactory: () => 'run-guard',
  });
  await assert.rejects(() => controller.settlePublication('run-guard', { verdict: 'VERIFIED' }), (e) => e.code === 'PUBLICATION_STATE');
  await assert.rejects(() => controller.settlePublication('run-guard', { verdict: 'REJECTED' }), (e) => e.code === 'PUBLICATION_STATE');
  await assert.rejects(() => controller.settlePublication('run-guard', { verdict: 'MAYBE' }), (e) => e.code === 'PUBLICATION_VERDICT');
});
