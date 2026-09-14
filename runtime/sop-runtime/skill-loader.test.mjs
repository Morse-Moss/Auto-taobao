// 阶段 3 配套单测：Loader 只装载已注册能力，路径收敛，身份/摘要一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRegistry } from './skill-registry.mjs';
import { createLoader, SkillLoaderError } from './skill-loader.mjs';
import { discoverSkillManifests } from './skill-discovery.mjs';

async function makeSkillDir(entrySource, manifestOverrides = {}, entryName = 'run.mjs') {
  const dir = await mkdtemp(path.join(tmpdir(), 'sop-skill-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  const entryRel = `scripts/${entryName}`;
  const entryAbs = path.join(dir, entryRel);
  const body = entrySource ?? 'export const capabilityId = "demo.skill";\nexport const manifestVersion = "1.0.0";\nexport const adapter = { checkSession: async () => ({ ok: true }), prepare: async () => {}, start: async () => ({}), observe: async () => ({}), collectArtifact: async () => ({}), validate: async () => ({ ok: true }), release: async () => {} };\n';
  await writeFile(entryAbs, body, 'utf8');
  const manifest = {
    name: 'demo.skill',
    version: '1.0.0',
    kind: 'capability',
    description: 'demo skill',
    entry: entryRel,
    inputs: [],
    outputs: [],
    preconditions: [],
    permissions: ['browser.read'],
    sideEffects: ['browser_read'],
    dependencies: [],
    validation: [],
    recovery: { supported: true, resumeFrom: 'checkpoint' },
    ...manifestOverrides,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  return { dir, manifest, entryAbs, digest };
}

test('装载已注册能力：解析路径、校验身份与摘要', async () => {
  const { dir, manifest, entryAbs, digest } = await makeSkillDir();
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: dir }] });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));

  const loader = createLoader({ registry });
  const loaded = await loader.load('demo.skill');
  assert.equal(loaded.name, 'demo.skill');
  assert.equal(loaded.version, '1.0.0');
  assert.equal(loaded.sourcePath, entryAbs);
  assert.equal(loaded.manifest.name, manifest.name);
  assert.match(loaded.manifestDigest, /^sha256:/);
  assert.equal(loaded.identity.declaredVersion, '1.0.0');

  const again = await loader.load('demo.skill');
  assert.equal(again, loaded, '重复加载应命中缓存');
  assert.equal(digest.length > 0, true);
});

test('未注册能力拒绝加载', async () => {
  const registry = buildRegistry({ manifests: [] });
  const loader = createLoader({ registry });
  await assert.rejects(() => loader.load('demo.skill'), (e) => e.code === 'LOADER_NOT_REGISTERED');
});

test('版本不满足拒绝加载', async () => {
  const { dir, manifest } = await makeSkillDir();
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: dir }] });
  const loader = createLoader({ registry });
  await assert.rejects(() => loader.load('demo.skill', { version: '^2.0.0' }), (e) => e.code === 'LOADER_VERSION_UNRESOLVED');
});

test('entry 逃逸技能目录时 Loader 拒绝（不依赖 Registry 校验）', async () => {
  const fakeEntry = {
    manifest: { name: 'evil.skill', version: '1.0.0', entry: '../escape.mjs', implementationDigest: null },
    skillDir: path.join(tmpdir(), 'sop-skill-base'),
    digest: 'sha256:deadbeef',
  };
  const loader = createLoader({ registry: { entryFor: () => fakeEntry, versionsOf: () => ['1.0.0'] } });
  await assert.rejects(() => loader.load('evil.skill'), (e) => e.code === 'LOADER_PATH_ESCAPE');
});

test('实现摘要漂移拒绝加载', async () => {
  const { dir, manifest } = await makeSkillDir();
  const drifted = { ...manifest, implementationDigest: `sha256:${'0'.repeat(64)}` };
  const registry = buildRegistry({ manifests: [{ manifest: drifted, skillDir: dir }] });
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  const loader = createLoader({ registry });
  await assert.rejects(() => loader.load('demo.skill'), (e) => e.code === 'LOADER_DIGEST_MISMATCH');
});

test('实现自报身份与 manifest 不一致拒绝加载', async () => {
  const { dir, manifest } = await makeSkillDir('export const capabilityId = "someone.else";\nexport const manifestVersion = "9.9.9";\n');
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: dir }] });
  const loader = createLoader({ registry });
  await assert.rejects(
    () => loader.load('demo.skill'),
    (e) => e.code === 'LOADER_MANIFEST_IMPLEMENTATION_MISMATCH' && e.details.declaredId === 'someone.else',
  );
});

test('入口文件缺失拒绝加载', async () => {
  const { dir, manifest } = await makeSkillDir();
  const withMissing = { ...manifest, entry: 'scripts/does-not-exist.mjs' };
  const registry = buildRegistry({ manifests: [{ manifest: withMissing, skillDir: dir }] });
  const loader = createLoader({ registry });
  await assert.rejects(() => loader.load('demo.skill'), (e) => e.code === 'LOADER_FILE_MISSING');
});

test('loadAdapter 校验 Adapter 契约', async () => {
  const { dir, manifest } = await makeSkillDir();
  const registry = buildRegistry({ manifests: [{ manifest, skillDir: dir }] });
  const loader = createLoader({ registry });
  const loaded = await loader.loadAdapter('demo.skill');
  assert.equal(typeof loaded.adapter.checkSession, 'function');

  const broken = await makeSkillDir('export default { checkSession: async () => ({ ok: true }) };\n');
  const brokenRegistry = buildRegistry({ manifests: [{ manifest: broken.manifest, skillDir: broken.dir }] });
  const brokenLoader = createLoader({ registry: brokenRegistry });
  await assert.rejects(() => brokenLoader.loadAdapter('demo.skill'), (e) => e.code === 'LOADER_ADAPTER_CONTRACT');
});

test('discoverSkillManifests 默认忽略可执行 manifest.mjs', async () => {
  const { dir, manifest } = await makeSkillDir();
  await writeFile(path.join(dir, 'manifest.mjs'), 'export default { name: "boom" };\n', 'utf8');
  const strict = await discoverSkillManifests({ skillsRoot: path.dirname(dir), dirs: [path.basename(dir)] });
  assert.equal(strict.found.length, 1);
  assert.equal(strict.found[0].sourcePath.endsWith('manifest.json'), true);
  assert.equal(strict.errors.length, 0);
});
