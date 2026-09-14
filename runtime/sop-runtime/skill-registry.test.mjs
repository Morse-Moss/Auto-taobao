// 阶段 3 配套单测：Registry 静态校验、依赖解析、索引
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, buildRegistry, assertRegistry, SkillRegistryError, manifestDigest } from './skill-registry.mjs';

function cap(name, overrides = {}) {
  return {
    name,
    version: '1.0.0',
    kind: 'capability',
    description: `capability ${name}`,
    entry: 'scripts/run.mjs',
    inputs: [{ name: 'window', type: 'date_range', required: true }],
    outputs: [{ name: 'artifact', type: 'artifact_ref' }],
    preconditions: ['logged_in_taobao'],
    permissions: ['browser.read', 'filesystem.write'],
    sideEffects: ['browser_read', 'local_artifact'],
    dependencies: [],
    validation: ['source_identity'],
    recovery: { supported: true, resumeFrom: 'verified_cursor' },
    ...overrides,
  };
}

function adp(name, overrides = {}) {
  return {
    name,
    version: '1.0.0',
    kind: 'adapter',
    description: `adapter ${name}`,
    entry: 'scripts/adapter.mjs',
    inputs: [],
    outputs: [],
    preconditions: [],
    permissions: ['browser.read'],
    sideEffects: ['browser_read'],
    dependencies: [],
    validation: [],
    recovery: { supported: true, resumeFrom: 'checkpoint' },
    ...overrides,
  };
}

function codesOf(registry) {
  return registry.errors.map((e) => e.code);
}

test('合法 registry 通过并生成索引', () => {
  const registry = buildRegistry({ manifests: [cap('xws.market-analysis.collect', { dependencies: ['adapter.xws@^1.0.0'] }), adp('adapter.xws')] });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  const index = registry.index({ generatedAt: '2026-09-14T00:00:00.000Z' });
  assert.equal(index.schemaVersion, 'skill-registry-index-v1');
  assert.equal(index.entries.length, 2);
  assert.deepEqual(index.entries.map((e) => e.name), ['adapter.xws', 'xws.market-analysis.collect']);
  assert.equal(index.entries[1].dependencies[0], 'adapter.xws@^1.0.0');
  assert.match(index.registryDigest, /^sha256:[0-9a-f]{64}$/);
});

test('索引 digest 对同一 manifest 稳定、对改动敏感', () => {
  const a = manifestDigest(cap('x.y.z'));
  const b = manifestDigest(cap('x.y.z'));
  const c = manifestDigest(cap('x.y.z', { version: '1.0.1' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('重复 manifest（同名同版本）被拒绝', () => {
  const registry = buildRegistry({ manifests: [cap('x.y.z'), cap('x.y.z')] });
  assert.ok(codesOf(registry).includes('DUPLICATE_MANIFEST'));
});

test('同名不同版本共存，resolveVersion 选最高匹配', () => {
  const registry = buildRegistry({ manifests: [cap('x.y.z', { version: '1.0.0' }), cap('x.y.z', { version: '1.2.0' }), cap('x.y.z', { version: '2.0.0' })] });
  assert.equal(registry.ok, true);
  assert.equal(registry.resolveVersion('x.y.z', '^1.0.0'), '1.2.0');
  assert.equal(registry.resolveVersion('x.y.z', '*'), '2.0.0');
});

test('缺失依赖被拒绝；allowlist 内外部依赖只告警', () => {
  const missing = buildRegistry({ manifests: [cap('a.b.c', { dependencies: ['adapter.ghost@^1.0.0'] })] });
  assert.ok(codesOf(missing).includes('DEPENDENCY_MISSING'));

  const allowed = buildRegistry({
    manifests: [cap('a.b.c', { dependencies: ['adapter.browser@^1.0.0'] })],
    externalAllowlist: ['adapter.browser'],
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
  assert.ok(allowed.warnings.some((w) => w.code === 'DEPENDENCY_EXTERNAL'));
});

test('版本不兼容被拒绝', () => {
  const registry = buildRegistry({ manifests: [cap('a.b.c', { dependencies: ['adapter.xws@^2.0.0'] }), adp('adapter.xws', { version: '1.0.0' })] });
  assert.ok(codesOf(registry).includes('DEPENDENCY_VERSION_INCOMPATIBLE'));
});

test('循环依赖被拒绝', () => {
  const registry = buildRegistry({ manifests: [adp('a.one', { dependencies: ['a.two@*'] }), adp('a.two', { dependencies: ['a.one@*'] })] });
  const cycleErrors = registry.errors.filter((e) => e.code === 'DEPENDENCY_CYCLE');
  assert.equal(cycleErrors.length, 1);
  assert.deepEqual(cycleErrors[0].detail, 'circular dependency: a.one -> a.two -> a.one');
});

test('非法 manifest 在任何执行前失败，strict 抛 SkillRegistryError', () => {
  const bad = cap('a.b.c', { permissions: ['credentials.read'] });
  assert.throws(
    () => buildRegistry({ manifests: [bad], strict: true }),
    (error) => error instanceof SkillRegistryError && error.code === 'SKILL_REGISTRY_INVALID' && error.errors.some((e) => e.code === 'PERMISSION_FORBIDDEN'),
  );
});

test('list 可按 kind/前置条件/输入类型/副作用筛选', () => {
  const registry = buildRegistry({
    manifests: [
      cap('xws.collect', { preconditions: ['logged_in_taobao', 'edge_proxy_health'], inputs: [{ name: 'w', type: 'date_range' }] }),
      cap('xws.publish', {
        preconditions: ['feishu_app_access'],
        inputs: [{ name: 'p', type: 'path' }],
        permissions: ['filesystem.read', 'feishu.api'],
        sideEffects: ['local_parse', 'feishu_write'],
        recovery: { supported: true, resumeFrom: 'idempotent_commit' },
      }),
      adp('adapter.xws'),
    ],
  });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  assert.equal(registry.list({ kind: 'adapter' }).length, 1);
  assert.deepEqual(registry.list({ hasPreconditions: ['edge_proxy_health'] }).map((e) => e.manifest.name), ['xws.collect']);
  assert.deepEqual(registry.list({ acceptsInputs: ['path'] }).map((e) => e.manifest.name), ['xws.publish']);
  assert.deepEqual(registry.list({ declaresSideEffects: ['feishu_write'] }).map((e) => e.manifest.name), ['xws.publish']);
  assert.deepEqual(registry.list({ namePrefix: 'adapter.' }).map((e) => e.manifest.name), ['adapter.xws']);
});

test('require 的三种失败路径', () => {
  const registry = buildRegistry({ manifests: [cap('a.b.c', { preconditions: ['logged_in_taobao'] })] });
  assert.throws(() => registry.require('a.b.ghost'), (e) => e.code === 'CAPABILITY_NOT_REGISTERED');
  assert.throws(() => registry.require('a.b.c', { version: '^9.0.0' }), (e) => e.code === 'CAPABILITY_VERSION_UNRESOLVED');
  assert.throws(() => registry.require('a.b.c', { preconditions: ['feishu_app_access'] }), (e) => e.code === 'PRECONDITION_UNDECLARED');
  assert.equal(registry.require('a.b.c').manifest.name, 'a.b.c');
});

test('副作用/权限闸门：未声明即拒绝', () => {
  const registry = buildRegistry({ manifests: [cap('a.b.c')] });
  assert.equal(registry.assertSideEffectDeclared('a.b.c', 'browser_read'), true);
  assert.throws(() => registry.assertSideEffectDeclared('a.b.c', 'feishu_write'), (e) => e.code === 'SIDE_EFFECT_UNDECLARED');
  assert.throws(() => registry.assertPermissionDeclared('a.b.c', 'feishu.api'), (e) => e.code === 'PERMISSION_UNDECLARED');
});

test('knownValidators 注入后，声明未实现验证器的 manifest 被拒绝', () => {
  // 不注入验证器名单时只做名称枚举校验（枚举内即可）
  const lenient = buildRegistry({ manifests: [cap('a.b.c', { validation: ['structure', 'row_count'] })] });
  assert.equal(lenient.ok, true, JSON.stringify(lenient.errors));

  // 注入后，枚举内但无实现的名字必须被拒
  const strict = buildRegistry({
    manifests: [cap('a.b.c', { validation: ['structure'] }), cap('d.e.f', { validation: ['row_count'] })],
    knownValidators: ['structure'],
  });
  assert.equal(strict.ok, false);
  const error = strict.errors.find((e) => e.code === 'VALIDATION_NOT_IMPLEMENTED');
  assert.ok(error);
  assert.match(error.detail, /row_count/);
});

test('assertRegistry 对非法注册表抛错', () => {
  const registry = createRegistry();
  registry.addAll([cap('a.b.c', { dependencies: ['adapter.ghost@^1.0.0'] })]);
  assert.throws(() => assertRegistry(registry), (e) => e.code === 'SKILL_REGISTRY_INVALID');
});
