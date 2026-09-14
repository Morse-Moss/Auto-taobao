// 阶段 3 配套单测：manifest 契约与校验
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest, normalizeManifest, parseDependency, formatDependency,
  MANIFEST_SCHEMA_VERSION, SIDE_EFFECT_CLASSES,
} from './skill-manifest.mjs';

function baseManifest(overrides = {}) {
  return {
    name: 'xws.market-analysis.collect',
    version: '1.0.0',
    kind: 'capability',
    description: '采集小旺神市场分析分片',
    entry: 'scripts/run-adaptive-export.mjs',
    inputs: [{ name: 'report_window', type: 'date_range', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact_ref' }],
    preconditions: ['logged_in_taobao', 'edge_proxy_health'],
    permissions: ['browser.read', 'filesystem.write'],
    sideEffects: ['browser_read', 'local_artifact'],
    dependencies: ['adapter.xws@^1.0.0'],
    validation: ['source_identity', 'contiguous_prefix', 'artifact_integrity'],
    recovery: { supported: true, resumeFrom: 'verified_cursor' },
    ...overrides,
  };
}

function codes(result) {
  return result.errorCodes;
}

test('合法 manifest 通过校验', () => {
  const result = validateManifest(baseManifest());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('SIDE_EFFECT_CLASSES 与 policy 副作用表同源', () => {
  assert.ok(SIDE_EFFECT_CLASSES.includes('feishu_write'));
  assert.ok(SIDE_EFFECT_CLASSES.includes('local_artifact'));
  assert.ok(SIDE_EFFECT_CLASSES.includes('paid_provider_call'));
});

test('name/version/kind/entry 基础字段校验', () => {
  assert.ok(codes(validateManifest(baseManifest({ name: 'XWS.Market' }))).includes('NAME_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ version: '1.0' }))).includes('VERSION_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ kind: 'sorcery' }))).includes('KIND_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ description: '' }))).includes('DESCRIPTION_REQUIRED'));
});

test('entry 必须站内相对 .mjs，拒绝绝对路径与逃逸', () => {
  assert.ok(codes(validateManifest(baseManifest({ entry: '../evil.mjs' }))).includes('ENTRY_ESCAPE'));
  assert.ok(codes(validateManifest(baseManifest({ entry: 'C:/evil.mjs' }))).includes('ENTRY_ABSOLUTE'));
  assert.ok(codes(validateManifest(baseManifest({ entry: 'scripts/run.py' }))).includes('ENTRY_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ entry: undefined }))).includes('ENTRY_REQUIRED'));
});

test('未知/被禁权限与未知副作用被拒绝', () => {
  assert.ok(codes(validateManifest(baseManifest({ permissions: ['browser.read', 'telepathy'] }))).includes('PERMISSION_UNKNOWN'));
  assert.ok(codes(validateManifest(baseManifest({ permissions: ['credentials.read'] }))).includes('PERMISSION_FORBIDDEN'));
  assert.ok(codes(validateManifest(baseManifest({ sideEffects: ['local_artifact', 'summon_demon'] }))).includes('SIDE_EFFECT_UNKNOWN'));
});

test('外部副作用必须声明对应权限，写权限必须声明对应副作用', () => {
  const missingPermission = validateManifest(baseManifest({
    permissions: ['filesystem.write'],
    sideEffects: ['local_artifact', 'feishu_write'],
    recovery: { supported: true, resumeFrom: 'idempotent_commit' },
  }));
  assert.ok(codes(missingPermission).includes('PERMISSION_MISSING'));

  const undeclaredEffect = validateManifest(baseManifest({
    permissions: ['browser.read', 'filesystem.write', 'feishu.api'],
    sideEffects: ['browser_read', 'local_artifact'],
  }));
  assert.ok(codes(undeclaredEffect).includes('UNDECLARED_SIDE_EFFECT'));
});

test('外部副作用不可恢复（recovery.supported=false）被拒绝', () => {
  const result = validateManifest(baseManifest({
    permissions: ['filesystem.write', 'feishu.api'],
    sideEffects: ['local_artifact', 'feishu_write'],
    recovery: { supported: false, resumeFrom: 'none' },
  }));
  assert.ok(codes(result).includes('RECOVERY_NOT_RESUMABLE'));
});

test('recovery supported 必须给出具体 resumeFrom', () => {
  assert.ok(codes(validateManifest(baseManifest({ recovery: { supported: true, resumeFrom: 'none' } }))).includes('RECOVERY_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ recovery: { supported: true } }))).includes('RECOVERY_INVALID'));
});

test('依赖串与版本区间校验', () => {
  assert.ok(codes(validateManifest(baseManifest({ dependencies: ['adapter.xws@not-a-range'] }))).includes('DEPENDENCY_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ dependencies: ['not a dep'] }))).includes('DEPENDENCY_INVALID'));
  assert.ok(codes(validateManifest(baseManifest({ validation: ['vibes'] }))).includes('VALIDATION_UNKNOWN'));
  assert.ok(codes(validateManifest(baseManifest({ preconditions: ['vibes'] }))).includes('PRECONDITION_UNKNOWN'));
});

test('parseDependency / formatDependency 往返一致', () => {
  assert.deepEqual(parseDependency('adapter.xws@^1.0.0'), { id: 'adapter.xws', range: '^1.0.0' });
  assert.deepEqual(parseDependency('adapter.xws'), { id: 'adapter.xws', range: '*' });
  assert.equal(formatDependency({ id: 'adapter.xws', range: '^1.0.0' }), 'adapter.xws@^1.0.0');
  assert.equal(formatDependency({ id: 'adapter.xws', range: '*' }), 'adapter.xws');
});

test('normalizeManifest 补默认值且不改写语义', () => {
  const normalized = normalizeManifest(baseManifest({ inputs: undefined, recovery: undefined, dependencies: undefined }));
  assert.equal(normalized.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(normalized.inputs, []);
  assert.deepEqual(normalized.dependencies, []);
  assert.deepEqual(normalized.recovery, { supported: false, resumeFrom: 'none' });
  assert.equal(Object.isFrozen(normalized), true);
});
