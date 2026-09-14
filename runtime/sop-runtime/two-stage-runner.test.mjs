// 通用两段式运行器的单测。
// 用一个「合成能力」把 ADMIT → COLLECT → VALIDATED → PUBLISH → VERIFIED → CURSOR
// 整条链跑通，从而验证运行器本身的契约，而不是验证某条业务能力的细节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { summarize } from './context-schema.mjs';
import {
  runTwoStage, resolvePublishHooks, collectSideEffects, primaryWriteEffect,
  parseCliArgs, parseEnvFile, PUBLISH_HOOK_FACTORY, TwoStageError,
} from './two-stage-runner.mjs';

const IDENTITY = Object.freeze({
  tenantId: 't1', storeId: 's1', platform: 'fake',
  accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0',
});

const ARTIFACT_BYTES = Buffer.from('{"rows":2,"keyword":"浴缸"}\n', 'utf8');
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

function manifestOf(overrides = {}) {
  return {
    schemaVersion: 'skill-manifest-v1',
    name: 'fake.cap',
    version: '1.0.0',
    kind: 'capability',
    description: 'synthetic capability for runner tests',
    entry: 'scripts/fake.mjs',
    inputs: [], outputs: [],
    preconditions: [], permissions: ['filesystem.read'],
    sideEffects: ['local_parse', 'feishu_write'],
    dependencies: [],
    validation: ['structure', 'row_count', 'digest', 'readback', 'publication'],
    recovery: { supported: true, resumeFrom: 'idempotent_commit' },
    owner: 'test',
    tags: [],
    ...overrides,
  };
}

function moduleOf({ artifact = {}, validate = async () => ({ ok: true }), hooks = null, extra = {} } = {}) {
  const bytes = artifact.bytes ?? ARTIFACT_BYTES;
  return {
    capabilityId: 'fake.cap',
    manifestVersion: '1.0.0',
    collectContract: () => ({ requiredFields: ['artifactId', 'schemaVersion'] }),
    adapter: {
      checkSession: async () => ({ ok: true }),
      prepare: async () => {},
      start: async () => ({ rows: 2 }),
      observe: async ({ context }) => ({ identity: context.identity, rows: 2 }),
      collectArtifact: async () => ({
        artifactId: 'fake-artifact',
        artifactKind: 'json',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        rowCount: artifact.rowCount ?? 2,
        range: { start: 1, end: artifact.rowCount ?? 2 },
        schemaVersion: 'fake-artifact-v1',
        ...extra,
      }),
      validate,
      release: async () => {},
    },
    ...(hooks === null ? {} : { [PUBLISH_HOOK_FACTORY]: hooks }),
  };
}

function makeHarness({ manifest = manifestOf(), module = moduleOf(), workDir = null } = {}) {
  const store = createMemoryStore();
  const controller = createController({ store, workerId: 'w-test', idFactory: (() => { let n = 0; return () => `att-${++n}`; })() });
  const ledger = createSideEffectLedger({ store });
  const dir = workDir ?? mkdtempSync(path.join(tmpdir(), 'two-stage-'));
  const evidenceStore = createEvidenceStore({ root: path.join(dir, 'evidence') });
  const registry = {
    require: () => ({ manifest, digest: 'sha256:test' }),
    names: () => ['fake.cap'],
    assertSideEffectDeclared: () => true,
    assertPermissionDeclared: () => true,
  };
  const loader = { loadAdapter: async () => ({ module, adapter: module.adapter, sourcePath: '/fake.mjs' }) };
  return { store, controller, ledger, evidenceStore, registry, loader, dir };
}

function baseOptions(harness, overrides = {}) {
  return {
    registry: harness.registry,
    loader: harness.loader,
    store: harness.store,
    controller: harness.controller,
    ledger: harness.ledger,
    evidenceStore: harness.evidenceStore,
    capabilityId: 'fake.cap',
    identity: { ...IDENTITY },
    target: 'https://example.feishu.cn/base/appTokenAbc',
    businessKey: 'fake|2026-09-13',
    workDir: harness.dir,
    ...overrides,
  };
}

test('collectSideEffects 只保留非外部写副作用；primaryWriteEffect 取声明顺序里的第一个写副作用', () => {
  const manifest = manifestOf({ sideEffects: ['browser_read', 'local_parse', 'feishu_write', 'postgres_write'] });
  assert.deepEqual(collectSideEffects(manifest), ['browser_read', 'local_parse']);
  assert.equal(primaryWriteEffect(manifest), 'feishu_write');
  assert.equal(primaryWriteEffect(manifestOf({ sideEffects: ['local_parse'] })), null);
});

test('发布钩子解析：缺工厂 fail-closed；返回不合法即拒绝；合法则原样返回', () => {
  assert.throws(
    () => resolvePublishHooks({ module: {}, manifest: { name: 'fake.cap' } }),
    (error) => error.code === 'PUBLISH_HOOK_MISSING',
  );
  assert.throws(
    () => resolvePublishHooks({ module: { [PUBLISH_HOOK_FACTORY]: () => ({ handler: () => {} }) }, manifest: { name: 'fake.cap' } }),
    (error) => error.code === 'PUBLISH_HOOK_INVALID',
  );
  const hooks = { handler: async () => ({}), readBack: async () => ({}) };
  assert.equal(resolvePublishHooks({ module: { [PUBLISH_HOOK_FACTORY]: () => hooks } }), hooks);
});

test('CLI 参数校验：必填项与 --commit 的人工授权要求', () => {
  assert.throws(() => parseCliArgs([]), /--capability is required/);
  assert.throws(() => parseCliArgs(['--capability', 'a']), /--identity is required/);
  assert.throws(() => parseCliArgs(['--capability', 'a', '--identity', '{}']), /--business-key is required/);
  assert.throws(
    () => parseCliArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k', '--commit']),
    /--operator is required with --commit/,
  );
  assert.throws(
    () => parseCliArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k', '--commit', '--operator', 'x']),
    /--env-file is required with --commit/,
  );
  assert.throws(
    () => parseCliArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k', '--period-start', '2026-09-01']),
    /must be given together/,
  );
  const parsed = parseCliArgs(['--capability', 'a', '--identity', '{"tenantId":"t"}', '--business-key', 'k', '--expected-rows', '2']);
  assert.equal(parsed.expectedRows, '2');
  assert.equal(parsed.commit, false);
});

test('CLI 参数校验：probe profile 只要求 --capability（探测不建运行，不逼调用方传假身份）', () => {
  assert.throws(() => parseCliArgs(['--identity', '{}'], { profile: 'probe' }), /--capability is required/);
  const parsed = parseCliArgs(['--capability', 'a', '--collect-input', '{"x":1}'], { profile: 'probe' });
  assert.equal(parsed.capability, 'a');
  assert.equal(parsed.identity, undefined);
  assert.equal(parsed.businessKey, undefined);
  // run profile 一字不改：三件套与人工授权要求照旧。
  assert.throws(() => parseCliArgs(['--capability', 'a'], { profile: 'run' }), /--identity is required/);
  assert.equal(parseCliArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k']).commit, false);
});

test('parseEnvFile 解析键值、跳过注释并去掉成对引号', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, ['# comment', 'FEISHU_APP_ID="cli_x"', "FEISHU_APP_SECRET='sec'", 'EMPTY=', ''].join('\n'), 'utf8');
  assert.deepEqual(parseEnvFile(file), { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec', EMPTY: '' });
});

test('dry-run：只跑采集段，不动发布轴、不推进游标；即使 manifest 声明了外部写也不开人工闸门', async () => {
  const harness = makeHarness();
  const receipt = await runTwoStage(baseOptions(harness, { expectedRows: 2 }));

  assert.equal(receipt.ok, true);
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.gate.decision, 'ALLOW', '采集段只声明非外部写副作用，因此不触发审批');
  assert.equal(receipt.gate.status, 'NONE');
  assert.equal(receipt.collect.rowCount, 2);
  assert.equal(receipt.collect.sha256, ARTIFACT_SHA);
  assert.ok(receipt.collect.validators.some((entry) => entry.startsWith('structure:')));
  assert.ok(receipt.collect.validators.some((entry) => entry.startsWith('digest:')));
  assert.ok(receipt.collect.validators.some((entry) => entry.startsWith('adapter:')));
  assert.equal(receipt.publish.verdict, 'NOT_ATTEMPTED');
  assert.equal(receipt.publicationStatus, 'NOT_REQUESTED', '没跑发布就绝不能变成 COMMITTED/VERIFIED');
  assert.equal(receipt.cursorAdvanced, false);
  // 回归：本次调用结束后运行必须终结。completeAttempt 只改 nextAction，执行轴仍是 RUNNING，
  // 不显式 succeed() 的话这条 run 永远算活跃（占队列深度，旧口径下还占 lane）。
  assert.equal(receipt.executionStatus, 'SUCCEEDED', '本次调用该做的都做完了，运行必须终结');
  assert.equal(receipt.nextAction, 'TERMINAL');

  const context = await harness.controller.getContext(receipt.runId);
  assert.equal(context.evidenceStatus, 'VALIDATED');
  assert.equal(context.executionStatus, 'SUCCEEDED');
  assert.equal(context.verifiedCursor.end, 0, '游标不动');
  assert.equal(summarize(context).stage, 'COLLECT');
});

test('commit：人工闸门先开、提交后回读、验证器全过才 VERIFIED 并推进游标', async () => {
  const calls = [];
  const hooks = () => ({
    handler: async () => { calls.push('handler'); return { newTableId: 'tblNew' }; },
    readBack: async () => { calls.push('readBack'); return { verifiedAt: new Date().toISOString(), rows: 2 }; },
  });
  const harness = makeHarness({ module: moduleOf({ hooks }) });
  const receipt = await runTwoStage(baseOptions(harness, { commit: true, operator: '张三', expectedRows: 2 }));

  assert.equal(receipt.ok, true);
  assert.equal(receipt.mode, 'commit');
  assert.equal(receipt.gate.riskClass, 'HIGH', 'feishu_write 属高风险');
  assert.equal(receipt.gate.status, 'APPROVED');
  assert.equal(receipt.gate.operator, '张三');
  assert.equal(receipt.publish.verdict, 'VERIFIED');
  assert.equal(receipt.publicationStatus, 'VERIFIED');
  assert.equal(receipt.cursorAdvanced, true);
  assert.equal(receipt.verifiedCursor.end, 2);
  assert.deepEqual(calls, ['handler', 'readBack'], '先提交再回读');

  const context = await harness.controller.getContext(receipt.runId);
  assert.equal(context.sideEffectRefs.length, 1);
  assert.equal(context.sideEffectRefs[0].capability, 'fake.cap');
});

test('commit 但没有操作者：不开闸也不假装放行，直接返回等待人工', async () => {
  const harness = makeHarness();
  const receipt = await runTwoStage(baseOptions(harness, { commit: true, operator: null, expectedRows: 2 }));

  assert.equal(receipt.ok, false);
  assert.equal(receipt.admitted, true);
  assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
  assert.equal(receipt.gate.status, 'WAITING_HUMAN');
  assert.equal(receipt.stage, undefined, '连采集段都不该开始');

  const context = await harness.controller.getContext(receipt.runId);
  assert.equal(context.evidenceStatus, 'NONE');
  assert.equal(context.executionStatus, 'PAUSED');
});

test('声明要写外部却没有 createPublisher：提交路径 fail-closed，不静默跳过发布', async () => {
  const harness = makeHarness({ module: moduleOf({ hooks: null }) });
  await assert.rejects(
    () => runTwoStage(baseOptions(harness, { commit: true, operator: '张三', expectedRows: 2 })),
    (error) => error instanceof TwoStageError && error.code === 'PUBLISH_HOOK_MISSING',
  );
});

test('采集期验证器失败：整体失败并归类 EVIDENCE_INVALID，绝不进入发布段', async () => {
  const harness = makeHarness({
    module: moduleOf({ validate: async () => ({ ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no rows' } }) }),
  });
  const receipt = await runTwoStage(baseOptions(harness, { commit: true, operator: '张三', expectedRows: 2 }));

  assert.equal(receipt.ok, false);
  assert.equal(receipt.stage, 'COLLECT');
  assert.equal(receipt.failureClass, 'EVIDENCE_INVALID');
  assert.match(receipt.validation.codes.join(','), /ARTIFACT_INCOMPLETE/);
  assert.equal(receipt.publish, undefined);
  assert.equal((await harness.controller.getContext(receipt.runId)).publicationStatus, 'NOT_REQUESTED');
});

test('row_count 声明与工件不符即失败（expectedRows 是硬合同，不是提示）', async () => {
  const harness = makeHarness();
  const receipt = await runTwoStage(baseOptions(harness, { expectedRows: 99 }));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.failureClass, 'EVIDENCE_INVALID');
  assert.match(receipt.validation.codes.join(','), /INCOMPLETE_RANGE/);
});

test('structure 声明未实现的验证器即失败，且归类为能力缺陷而不是证据无效', async () => {
  // 语义要点：manifest 声明了没有实现的验证器，是「能力定义坏了」（CAPABILITY_DEGRADED，
  // 对应停用该能力版本），不是「这次采到的证据不合格」（EVIDENCE_INVALID）。
  // 归错会让人去重新采集，而真正要修的是 manifest。
  const harness = makeHarness({ manifest: manifestOf({ validation: ['no_such_validator', 'readback', 'publication'] }) });
  const receipt = await runTwoStage(baseOptions(harness, { expectedRows: 2 }));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.failureClass, 'CAPABILITY_DEGRADED');
  assert.match(String(receipt.error), /no_such_validator/);
});

test('拒绝准入时不创建运行（能力未注册）', async () => {
  const harness = makeHarness();
  const registry = { ...harness.registry, require: () => { throw new Error('unknown capability'); } };
  await assert.rejects(() => runTwoStage(baseOptions(harness, { registry })), /unknown capability/);
});

test('缺 businessKey 即拒绝：没有幂等键就不允许走提交路径', async () => {
  const harness = makeHarness();
  await assert.rejects(() => runTwoStage(baseOptions(harness, { businessKey: null })), /businessKey is required/);
});

test('回读不符预期时结算为 UNKNOWN 而非 VERIFIED，游标不推进', async () => {
  const hooks = () => ({
    handler: async () => ({}),
    readBack: async () => ({ verifiedAt: new Date().toISOString(), rows: 7 }),
  });
  const harness = makeHarness({ module: moduleOf({ hooks }) });
  const receipt = await runTwoStage(baseOptions(harness, { commit: true, operator: '张三', expectedRows: 2 }));

  assert.equal(receipt.ok, false);
  assert.equal(receipt.publish.verdict, 'UNKNOWN');
  assert.equal(receipt.publish.requiresReconcile, true);
  assert.equal(receipt.publicationStatus, 'UNKNOWN');
  assert.equal(receipt.cursorAdvanced, false);
  // 发布未被验证时**不得**把运行标成 SUCCEEDED：外部写入尚未结算，谎报终结会掩盖待对账的提交。
  assert.equal(receipt.executionStatus, null, '未结算的运行不能被终结');
  const context = await harness.controller.getContext(receipt.runId);
  assert.equal(context.executionStatus, 'RUNNING');
  assert.equal(context.blocker.class, 'COMMIT_UNKNOWN');
  assert.match(context.nextAction, /RECONCILE/);
});

test('UNKNOWN 对账收据必须带得出 commitKey（端口是 camelCase，不能读 snake_case 列名）', async () => {
  const harness = makeHarness();
  const prepared = await harness.ledger.prepare({ runId: '11111111-1111-4111-8111-111111111111', target: 'x', businessKey: 'k' });
  await harness.ledger.commit({ commitKey: prepared.commitKey, handler: async () => ({ unknown: true }), businessKey: 'k' });
  const { outcomes } = await harness.ledger.reconcileUnknown({});
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].commitKey, prepared.commitKey);
  assert.equal(outcomes[0].action, 'REQUIRES_HUMAN');
});
