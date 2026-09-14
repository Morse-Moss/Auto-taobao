// 阶段 4a 集成测试：Controller 按能力 ID 调用 —— Registry 解析 + Loader 装载 + manifest 决定验证器
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { createCapabilityWorker } from './worker-adapter.mjs';
import { buildRegistry } from './skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';
import { listValidatorNames } from './validation-registry.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

const ADAPTER_TEMPLATE = (rangeOffset) => `
import { createHash } from 'node:crypto';
export const capabilityId = 'demo.collect';
export const manifestVersion = '1.0.0';
const identity = ${JSON.stringify(identity)};
export const adapter = {
  async checkSession() { return { ok: true }; },
  async prepare() {},
  async start() { return { started: true }; },
  async observe() { return { identity, pages: 1 }; },
  async collectArtifact({ context }) {
    const cursorEnd = Number(context.verifiedCursor?.end ?? 0);
    const end = cursorEnd + 10;
    const bytes = Buffer.from('rows-' + end);
    return {
      artifactId: 'shard-' + end,
      artifactKind: 'csv',
      bytes,
      range: { start: cursorEnd + 1 + ${rangeOffset}, end },
      rowCount: 10,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  },
  async validate() { return { ok: true }; },
  async release() {},
};
`;

async function makeCapability({ rangeOffset = 0, validation = ['structure', 'contiguous_prefix', 'artifact_integrity', 'row_count'], extraManifest = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sop-cap-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'scripts', 'adapter.mjs'), ADAPTER_TEMPLATE(rangeOffset), 'utf8');
  const manifest = {
    name: 'demo.collect',
    version: '1.0.0',
    kind: 'capability',
    description: 'demo collect capability',
    entry: 'scripts/adapter.mjs',
    inputs: [{ name: 'window', type: 'date_range', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact_ref' }],
    preconditions: ['logged_in_taobao'],
    permissions: ['browser.read', 'filesystem.write'],
    sideEffects: ['browser_read', 'local_artifact'],
    dependencies: [],
    validation,
    recovery: { supported: true, resumeFrom: 'verified_cursor' },
    ...extraManifest,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifest };
}

async function boot({ rangeOffset = 0, validation, extraManifest } = {}) {
  const { dir, manifest } = await makeCapability({ rangeOffset, validation, extraManifest });
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: dir }], knownValidators: listValidatorNames() });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));

  const loader = createLoader({ registry });
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `attempt-${Math.random().toString(36).slice(2, 8)}` });
  const admission = await admitTask({
    store,
    spec: {
      taskId: 'sop-demo',
      workflow: 'demo.workflow',
      capability: 'demo.collect',
      identity,
      targetEnd: 20,
      verifiedCursor: { start: 1, end: 0, version: 0 },
    },
    idFactory: () => 'run-cap',
  });
  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'sop-cap-evidence-'));
  const evidenceStore = createEvidenceStore({ root: evidenceDir });

  const capability = await createCapabilityWorker({
    registry, loader, controller, evidenceStore,
    capabilityId: 'demo.collect',
    contract: { expectedRows: 10 },
  });
  return { ...capability, runId: admission.runId, controller, registry, loader };
}

test('按能力 ID 装配 Worker 并跑通一次采集', async () => {
  const { worker, manifest, assertEffect, runId, controller } = await boot();
  assert.equal(manifest.name, 'demo.collect');
  assert.equal(manifest.kind, 'capability');

  const result = await worker.runOnce({ runId, stage: 'COLLECT', stepId: 'part-1' });
  assert.equal(result.ok, true, JSON.stringify(result.validation));
  assert.deepEqual(result.manifest.range, { start: 1, end: 10 });
  assert.equal(result.manifest.extra.capability, 'demo.collect');
  assert.equal(result.validation.source, 'manifest:demo.collect@1.0.0');
  assert.deepEqual(
    result.validation.results.map((r) => r.name).sort(),
    ['adapter', 'artifact_integrity', 'contiguous_prefix', 'row_count', 'structure'],
  );

  const ctx = await controller.getContext(runId);
  assert.equal(ctx.evidenceStatus, 'CANDIDATE');

  // 副作用闸门：只放行 manifest 声明过的副作用
  assert.equal(assertEffect('browser_read'), true);
  assert.throws(() => assertEffect('feishu_write'), (e) => e.code === 'SIDE_EFFECT_UNDECLARED');
});

test('manifest 声明的 contiguous_prefix 真的会拦住不连续分片', async () => {
  const { worker, runId, controller } = await boot({ rangeOffset: 1 });
  const result = await worker.runOnce({ runId, stage: 'COLLECT' });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'EVIDENCE_INVALID');
  assert.deepEqual(result.validation.codes, ['SCOPE_MISMATCH']);

  const ctx = await controller.getContext(runId);
  assert.equal(ctx.evidenceStatus, 'REJECTED');
  await assert.rejects(() => controller.advanceCursor(runId, { end: 10 }), /EVIDENCE_NOT_VALIDATED/u);
});

test('不声明该验证器时不再拦同一问题（证明是 manifest 在起作用，不是硬编码）', async () => {
  const { worker, runId } = await boot({ rangeOffset: 1, validation: ['structure', 'row_count'] });
  const result = await worker.runOnce({ runId, stage: 'COLLECT' });
  assert.equal(result.ok, true);
  assert.equal(result.validation.results.some((r) => r.name === 'contiguous_prefix'), false);
});

test('manifest 声明未实现的验证器：注册期即失败', async () => {
  // 用「枚举内合法、但未注入实现」的名字触发覆盖检查；
  // 枚举外的名字会更早被 VALIDATION_UNKNOWN 拦住（两道闸门都必要）。
  const { manifest } = await makeCapability({ validation: ['structure', 'row_count'] });
  const registry = buildRegistry({
    manifests: [{ manifest, skillDir: path.join(tmpdir(), 'nowhere') }],
    knownValidators: ['structure'],
  });
  assert.equal(registry.ok, false);
  assert.ok(registry.errors.some((e) => e.code === 'VALIDATION_NOT_IMPLEMENTED' && e.detail.includes('row_count')));
});

test('枚举外验证器名在 manifest 阶段就被拒绝', async () => {
  const { manifest } = await makeCapability({ validation: ['structure', 'vibes'] });
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: path.join(tmpdir(), 'nowhere') }], knownValidators: listValidatorNames() });
  assert.equal(registry.ok, false);
  assert.ok(registry.errors.some((e) => e.code === 'VALIDATION_UNKNOWN'));
  assert.equal(registry.errors.some((e) => e.code === 'VALIDATION_NOT_IMPLEMENTED'), false);
});

test('前置条件未在 manifest 声明时拒绝装配', async () => {
  const { registry, loader, controller } = await boot();
  await assert.rejects(
    () => createCapabilityWorker({
      registry, loader, controller,
      capabilityId: 'demo.collect',
      preconditions: ['feishu_app_access'],
    }),
    (e) => e.code === 'PRECONDITION_UNDECLARED',
  );
});

test('按能力 ID 装配时未注册能力被拒绝', async () => {
  const { registry, loader, controller } = await boot();
  await assert.rejects(
    () => createCapabilityWorker({ registry, loader, controller, capabilityId: 'demo.ghost' }),
    (e) => e.code === 'CAPABILITY_NOT_REGISTERED',
  );
});
