// Skill Registry：manifest 发现后的静态校验与索引（Spec 8.1）
// 只做静态检查（不执行任何 Skill 代码、不访问平台资源）。
// 拒绝：缺依赖、循环依赖、版本不兼容、重复 manifest、未声明副作用、manifest/实现不一致。
//
// 设计要点：add() 只登记输入，finalize() 从全部登记项幂等重建状态。
// 这样「非法的 manifest」不会被后续 finalize 静默清掉——它必须在执行前失败。
import { createHash } from 'node:crypto';
import {
  validateManifest,
  normalizeManifest,
  stableStringify,
} from './skill-manifest.mjs';
import { maxSatisfying } from './semver.mjs';

export class SkillRegistryError extends Error {
  constructor(message, { code = 'SKILL_REGISTRY_ERROR', errors = [] } = {}) {
    super(`${code}: ${message}`);
    this.name = 'SkillRegistryError';
    this.code = code;
    this.errors = errors;
  }
}

export function manifestDigest(manifest) {
  return `sha256:${createHash('sha256').update(stableStringify(manifest)).digest('hex')}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toRecord(input) {
  if (input && typeof input === 'object' && input.manifest) {
    return { manifest: input.manifest, skillDir: input.skillDir ?? null, sourcePath: input.sourcePath ?? null };
  }
  return { manifest: input, skillDir: null, sourcePath: null };
}

export function createRegistry({ externalAllowlist = [] } = {}) {
  const records = []; // 全部登记输入（含非法项），finalize 的唯一来源
  const byName = new Map(); // name -> [{ manifest, raw, skillDir, sourcePath, digest }]
  let errors = [];
  let warnings = [];
  let dirty = true;
  let finalizing = false;

  function add(input) {
    const record = toRecord(input);
    records.push(record);
    dirty = true;
    const check = validateManifest(record.manifest);
    if (!check.ok) {
      return {
        ok: false,
        errors: check.errors.map((error) => ({ ...error, source: record.sourcePath ?? record.manifest?.name ?? '<unknown>' })),
      };
    }
    return { ok: true };
  }

  function addAll(inputs = []) {
    const results = inputs.map((input) => add(input));
    ensure();
    return { ok: errors.length === 0, errors: [...errors] };
  }

  function allEntries() {
    return [...byName.values()].flat();
  }

  function versionsOf(name) {
    ensure();
    return (byName.get(name) ?? []).map((entry) => entry.manifest.version);
  }

  function resolveVersion(name, range = '*') {
    ensure();
    const candidates = byName.get(name);
    if (!candidates || !candidates.length) return null;
    return maxSatisfying(candidates.map((c) => c.manifest.version), range);
  }

  function entryFor(name, range = '*') {
    ensure();
    const version = resolveVersion(name, range);
    if (!version) return null;
    return byName.get(name).find((entry) => entry.manifest.version === version) ?? null;
  }

  // 从全部登记项幂等重建：manifest 校验 -> 去重 -> 依赖图 -> 环检测。
  // 重入安全：finalize 内部通过公开 API 读取时不会再触发一次 finalize。
  function finalize() {
    if (finalizing) return { ok: errors.length === 0, errors: [...errors], warnings: [...warnings] };
    finalizing = true;
    dirty = false;
    byName.clear();
    errors = [];
    warnings = [];

    for (const record of records) {
      const check = validateManifest(record.manifest);
      const source = record.sourcePath ?? record.manifest?.name ?? '<unknown>';
      if (!check.ok) {
        for (const error of check.errors) errors.push({ ...error, source, phase: 'manifest' });
        continue;
      }
      for (const warning of check.warnings) warnings.push({ ...warning, source });

      const normalized = normalizeManifest(record.manifest);
      const versions = byName.get(normalized.name) ?? [];
      if (versions.some((entry) => entry.manifest.version === normalized.version)) {
        errors.push({
          code: 'DUPLICATE_MANIFEST',
          field: 'name',
          detail: `duplicate manifest ${normalized.name}@${normalized.version}`,
          source,
          phase: 'manifest',
        });
        continue;
      }
      versions.push({ manifest: normalized, raw: record.manifest, skillDir: record.skillDir, sourcePath: record.sourcePath, digest: manifestDigest(record.manifest) });
      byName.set(normalized.name, versions);
    }

    const allow = new Set(externalAllowlist);
    for (const entry of allEntries()) {
      const { manifest } = entry;
      for (const dependency of manifest.dependencies) {
        const key = dependency.id;
        if (!byName.has(key)) {
          if (allow.has(key)) {
            warnings.push({ code: 'DEPENDENCY_EXTERNAL', field: 'dependencies', detail: `${manifest.name} depends on external ${key}@${dependency.range}`, source: manifest.name });
            continue;
          }
          errors.push({
            code: 'DEPENDENCY_MISSING',
            field: 'dependencies',
            detail: `${manifest.name}@${manifest.version} depends on unknown capability ${key}@${dependency.range}`,
            source: manifest.name,
            phase: 'graph',
          });
          continue;
        }
        const version = resolveVersion(key, dependency.range);
        if (!version) {
          errors.push({
            code: 'DEPENDENCY_VERSION_INCOMPATIBLE',
            field: 'dependencies',
            detail: `${manifest.name}@${manifest.version} requires ${key}@${dependency.range}; registered versions: ${versionsOf(key).join(', ') || 'none'}`,
            source: manifest.name,
            phase: 'graph',
          });
          continue;
        }
        const target = entryFor(key, dependency.range);
        if (target && target.manifest.kind === 'capability') {
          warnings.push({ code: 'DEPENDENCY_NOT_ADAPTER', field: 'dependencies', detail: `${manifest.name} depends on capability ${key}; prefer adapter/validator dependencies`, source: manifest.name });
        }
      }
    }

    for (const cycle of findCycles()) {
      errors.push({ code: 'DEPENDENCY_CYCLE', field: 'dependencies', detail: `circular dependency: ${cycle.join(' -> ')}`, source: cycle[0], phase: 'graph' });
    }

    finalizing = false;
    dirty = false;
    return { ok: errors.length === 0, errors: [...errors], warnings: [...warnings] };
  }

  function ensure() {
    if (dirty) finalize();
  }

  // DFS 三色标记找环；返回环路径（含闭合点）。
  function findCycles() {
    const WHITE = 0; const GRAY = 1; const BLACK = 2;
    const color = new Map();
    const stack = [];
    const cycles = [];
    const seenCycleKeys = new Set();

    const visit = (name) => {
      color.set(name, GRAY);
      stack.push(name);
      for (const entry of byName.get(name) ?? []) {
        for (const dependency of entry.manifest.dependencies) {
          const next = dependency.id;
          if (!byName.has(next)) continue;
          const state = color.get(next) ?? WHITE;
          if (state === GRAY) {
            const start = stack.indexOf(next);
            const cycle = [...stack.slice(start), next];
            const key = [...cycle].sort().join('|');
            if (!seenCycleKeys.has(key)) {
              seenCycleKeys.add(key);
              cycles.push(cycle);
            }
          } else if (state === WHITE) {
            visit(next);
          }
        }
      }
      stack.pop();
      color.set(name, BLACK);
    };

    for (const name of byName.keys()) {
      if ((color.get(name) ?? WHITE) === WHITE) visit(name);
    }
    return cycles;
  }

  function list(filter = {}) {
    ensure();
    let entries = allEntries();
    if (filter.kind) entries = entries.filter((entry) => entry.manifest.kind === filter.kind);
    if (filter.name) entries = entries.filter((entry) => entry.manifest.name === filter.name);
    if (filter.namePrefix) entries = entries.filter((entry) => entry.manifest.name.startsWith(filter.namePrefix));
    if (filter.hasPreconditions?.length) {
      entries = entries.filter((entry) => filter.hasPreconditions.every((p) => entry.manifest.preconditions.includes(p)));
    }
    if (filter.acceptsInputs?.length) {
      entries = entries.filter((entry) => {
        const types = new Set(entry.manifest.inputs.map((i) => i.type));
        return filter.acceptsInputs.every((t) => types.has(t));
      });
    }
    if (filter.declaresSideEffects?.length) {
      entries = entries.filter((entry) => filter.declaresSideEffects.every((s) => entry.manifest.sideEffects.includes(s)));
    }
    if (filter.permissions?.length) {
      entries = entries.filter((entry) => filter.permissions.every((p) => entry.manifest.permissions.includes(p)));
    }
    return entries;
  }

  function requireCapability(name, { version = '*', preconditions = [] } = {}) {
    ensure();
    if (!byName.has(name)) {
      throw new SkillRegistryError(`capability not registered: ${name}`, { code: 'CAPABILITY_NOT_REGISTERED' });
    }
    const entry = entryFor(name, version);
    if (!entry) {
      throw new SkillRegistryError(`no version of ${name} satisfies ${version}; registered: ${versionsOf(name).join(', ')}`, { code: 'CAPABILITY_VERSION_UNRESOLVED' });
    }
    const missing = preconditions.filter((p) => !entry.manifest.preconditions.includes(p));
    if (missing.length) {
      throw new SkillRegistryError(`${name}@${entry.manifest.version} does not declare preconditions: ${missing.join(', ')}`, { code: 'PRECONDITION_UNDECLARED' });
    }
    return entry;
  }

  // 运行时副作用闸门：能力未声明该副作用即拒绝（防止偷偷写外部系统）。
  function assertSideEffectDeclared(name, effectClass, { version = '*' } = {}) {
    ensure();
    const entry = byName.has(name) ? entryFor(name, version) : null;
    if (!entry) throw new SkillRegistryError(`capability not registered: ${name}`, { code: 'CAPABILITY_NOT_REGISTERED' });
    if (!entry.manifest.sideEffects.includes(effectClass)) {
      throw new SkillRegistryError(`${name}@${entry.manifest.version} did not declare side effect ${effectClass}`, { code: 'SIDE_EFFECT_UNDECLARED' });
    }
    return true;
  }

  function assertPermissionDeclared(name, permission, { version = '*' } = {}) {
    ensure();
    const entry = byName.has(name) ? entryFor(name, version) : null;
    if (!entry) throw new SkillRegistryError(`capability not registered: ${name}`, { code: 'CAPABILITY_NOT_REGISTERED' });
    if (!entry.manifest.permissions.includes(permission)) {
      throw new SkillRegistryError(`${name}@${entry.manifest.version} did not declare permission ${permission}`, { code: 'PERMISSION_UNDECLARED' });
    }
    return true;
  }

  // Registry 索引：可写盘、可 diff，作为版本漂移的单一比对来源。
  function index({ generatedAt = new Date().toISOString() } = {}) {
    const entries = list()
      .map((entry) => ({
        name: entry.manifest.name,
        version: entry.manifest.version,
        kind: entry.manifest.kind,
        entry: entry.manifest.entry,
        digest: entry.digest,
        dependencies: entry.manifest.dependencies.map((d) => (d.range && d.range !== '*' ? `${d.id}@${d.range}` : d.id)),
        sideEffects: [...entry.manifest.sideEffects],
        permissions: [...entry.manifest.permissions],
        recovery: { ...entry.manifest.recovery },
        source: entry.sourcePath ?? null,
      }))
      .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
    const body = { schemaVersion: 'skill-registry-index-v1', generatedAt, entries };
    return { ...body, registryDigest: `sha256:${sha256Hex(stableStringify(entries))}` };
  }

  const registry = {
    add,
    addAll,
    finalize,
    list,
    index,
    require: requireCapability,
    assertSideEffectDeclared,
    assertPermissionDeclared,
    resolveVersion,
    entryFor,
    names: () => {
      ensure();
      return [...byName.keys()].sort();
    },
    versionsOf,
    size: () => {
      ensure();
      return allEntries().length;
    },
  };

  Object.defineProperty(registry, 'errors', {
    get: () => {
      ensure();
      return [...errors];
    },
  });
  Object.defineProperty(registry, 'warnings', {
    get: () => {
      ensure();
      return [...warnings];
    },
  });
  Object.defineProperty(registry, 'ok', {
    get: () => {
      ensure();
      return errors.length === 0;
    },
  });

  return registry;
}

// 便捷入口：addAll + finalize；strict=true 时直接抛错（错误带在 error.errors 上）。
export function buildRegistry({ manifests = [], externalAllowlist = [], strict = false } = {}) {
  const registry = createRegistry({ externalAllowlist });
  registry.addAll(manifests);
  const result = registry.finalize();
  if (strict && !result.ok) {
    throw new SkillRegistryError(`registry invalid: ${result.errors.length} error(s)`, {
      code: 'SKILL_REGISTRY_INVALID',
      errors: result.errors,
    });
  }
  return registry;
}

export function assertRegistry(registry) {
  const result = registry.finalize();
  if (!result.ok) {
    throw new SkillRegistryError(`registry invalid: ${result.errors.length} error(s)`, {
      code: 'SKILL_REGISTRY_INVALID',
      errors: result.errors,
    });
  }
  return registry;
}
