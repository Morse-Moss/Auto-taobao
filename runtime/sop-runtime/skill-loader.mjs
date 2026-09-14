// Skill Loader：只装载 Registry 允许的能力实现（Spec 8.1）
// 约束：
//  - 不能按任意路径/任意脚本加载；只能加载已注册能力，且实现文件必须落在该技能目录内；
//  - manifest 与实现不一致（id/version/digest 漂移）拒绝加载；
//  - 加载是可重复的，不做任何状态写入。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertAdapter } from './worker-adapter.mjs';

export class SkillLoaderError extends Error {
  constructor(message, { code = 'SKILL_LOADER_ERROR', details = {} } = {}) {
    super(`${code}: ${message}`);
    this.name = 'SkillLoaderError';
    this.code = code;
    this.details = details;
  }
}

function sha256HexOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createLoader({
  registry,
  skillsRoot = null,
  importer = (href) => import(href),
  readFileFn = readFile,
  existsFn = existsSync,
} = {}) {
  if (!registry || typeof registry.entryFor !== 'function') {
    throw new SkillLoaderError('registry with entryFor() is required', { code: 'LOADER_REGISTRY_REQUIRED' });
  }

  const cache = new Map();

  function resolveEntry(name, version) {
    const entry = registry.entryFor(name, version);
    if (!entry) {
      const known = typeof registry.versionsOf === 'function' ? registry.versionsOf(name) : [];
      const code = known.length ? 'LOADER_VERSION_UNRESOLVED' : 'LOADER_NOT_REGISTERED';
      throw new SkillLoaderError(
        known.length
          ? `no registered version of ${name} satisfies ${version}; have: ${known.join(', ')}`
          : `capability not registered: ${name}`,
        { code },
      );
    }
    return entry;
  }

  function resolvePath(entry) {
    const { manifest } = entry;
    const baseDir = entry.skillDir ?? (skillsRoot ? path.join(skillsRoot, manifest.name) : null);
    if (!baseDir) {
      throw new SkillLoaderError(`${manifest.name} has no skillDir; loader cannot resolve ${manifest.entry}`, { code: 'LOADER_NO_SOURCE' });
    }
    const base = path.resolve(baseDir);
    const abs = path.resolve(base, manifest.entry);
    const relative = path.relative(base, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SkillLoaderError(`${manifest.name} entry escapes skill directory: ${manifest.entry}`, { code: 'LOADER_PATH_ESCAPE' });
    }
    return abs;
  }

  async function verifyDigest(entry, absPath) {
    if (!entry.manifest.implementationDigest) return null;
    if (!existsFn(absPath)) {
      throw new SkillLoaderError(`${entry.manifest.name} entry file missing: ${absPath}`, { code: 'LOADER_FILE_MISSING' });
    }
    const buffer = await readFileFn(absPath);
    const actual = `sha256:${sha256HexOf(buffer)}`;
    if (actual !== entry.manifest.implementationDigest) {
      throw new SkillLoaderError(
        `${entry.manifest.name}@${entry.manifest.version} implementation drift: manifest=${entry.manifest.implementationDigest} actual=${actual}`,
        { code: 'LOADER_DIGEST_MISMATCH', details: { expected: entry.manifest.implementationDigest, actual } },
      );
    }
    return actual;
  }

  // 实现自报身份必须与 manifest 一致（模板：export const capabilityId / manifestVersion）。
  function verifyIdentity(entry, module) {
    const source = module?.default && typeof module.default === 'object' ? module.default : module;
    const declaredId = module?.capabilityId ?? source?.capabilityId ?? null;
    const declaredVersion = module?.manifestVersion ?? source?.manifestVersion ?? null;
    if (declaredId !== null && declaredId !== entry.manifest.name) {
      throw new SkillLoaderError(
        `${entry.manifest.name} implementation declares capabilityId ${declaredId}`,
        { code: 'LOADER_MANIFEST_IMPLEMENTATION_MISMATCH', details: { declaredId, manifestId: entry.manifest.name } },
      );
    }
    if (declaredVersion !== null && declaredVersion !== entry.manifest.version) {
      throw new SkillLoaderError(
        `${entry.manifest.name} implementation declares manifestVersion ${declaredVersion}`,
        { code: 'LOADER_MANIFEST_IMPLEMENTATION_MISMATCH', details: { declaredVersion, manifestVersion: entry.manifest.version } },
      );
    }
    return { declaredId, declaredVersion };
  }

  async function load(name, { version = '*', verifyImplementationDigest = true } = {}) {
    const entry = resolveEntry(name, version);
    const key = `${entry.manifest.name}@${entry.manifest.version}`;
    if (cache.has(key)) return cache.get(key);

    const absPath = resolvePath(entry);
    if (!existsFn(absPath)) {
      throw new SkillLoaderError(`${entry.manifest.name} entry file missing: ${absPath}`, { code: 'LOADER_FILE_MISSING' });
    }

    const digest = verifyImplementationDigest ? await verifyDigest(entry, absPath) : null;
    let module;
    try {
      module = await importer(pathToFileURL(absPath).href);
    } catch (error) {
      throw new SkillLoaderError(`${entry.manifest.name} failed to import: ${error?.message ?? error}`, { code: 'LOADER_IMPORT_FAILED' });
    }

    const identity = verifyIdentity(entry, module);
    const result = Object.freeze({
      name: entry.manifest.name,
      version: entry.manifest.version,
      manifest: entry.manifest,
      module,
      sourcePath: absPath,
      manifestDigest: entry.digest,
      implementationDigest: digest,
      identity,
    });
    cache.set(key, result);
    return result;
  }

  // 装载并校验 Adapter 契约（Spec 11.1）；仅当能力 kind=adapter 时使用。
  async function loadAdapter(name, options = {}) {
    const loaded = await load(name, options);
    const adapter = loaded.module.adapter ?? loaded.module.default ?? loaded.module;
    try {
      assertAdapter(adapter);
    } catch (error) {
      throw new SkillLoaderError(`${name} does not satisfy the adapter contract: ${error?.message ?? error}`, { code: 'LOADER_ADAPTER_CONTRACT' });
    }
    return { ...loaded, adapter };
  }

  return { load, loadAdapter, resolveEntry, resolvePath, cacheSize: () => cache.size };
}
