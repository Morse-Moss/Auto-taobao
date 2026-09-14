// Skill Manifest：机器可读能力契约（Spec 8.1）
// 单一事实来源：每个 Skill 目录下的 manifest.json / manifest.mjs 都由这里校验。
// 校验是纯函数、fail-closed：任何未知枚举、路径逃逸、未声明副作用都在装载前失败。
import { SIDE_EFFECT_RISK } from './policy.mjs';
import { isValidVersion, isValidRange } from './semver.mjs';
// 发布期验证器的判定必须与 Validator 实现表同源，否则「哪个名字属于发布期」会出现两套答案。
import { VALIDATION_STAGE, validationStageOf } from './validation-registry.mjs';

export const MANIFEST_SCHEMA_VERSION = 'skill-manifest-v1';
export const MANIFEST_FILE_NAMES = Object.freeze(['manifest.json', 'manifest.mjs']);

export const MANIFEST_KINDS = Object.freeze(['capability', 'adapter', 'validator', 'workflow']);

// 副作用类来自 policy 的唯一事实来源，避免两处枚举漂移。
export const SIDE_EFFECT_CLASSES = Object.freeze(Object.keys(SIDE_EFFECT_RISK));

export const INPUT_TYPES = Object.freeze(['date_range', 'string', 'number', 'boolean', 'enum', 'path', 'artifact_ref', 'credential_ref', 'object']);
export const OUTPUT_TYPES = Object.freeze(['artifact_ref', 'record_set', 'receipt', 'report', 'none']);
export const PRECONDITIONS = Object.freeze([
  'logged_in_taobao', 'logged_in_buyer', 'logged_in_seller', 'edge_proxy_health',
  'feishu_app_access', 'authorized_target', 'empty_target_table',
  'network_available', 'db_available', 'provider_available',
]);
export const PERMISSIONS = Object.freeze([
  'browser.read', 'browser.write',
  'filesystem.read', 'filesystem.write',
  'network.external',
  'postgres.read', 'postgres.write',
  'feishu.api', 'provider.call',
]);
// Agent Runtime / Skill 都不允许声明的权限（Spec 8.2 bounded read 边界）。
export const FORBIDDEN_PERMISSIONS = Object.freeze(['credentials.read', 'shell.arbitrary', 'cursor.advance', 'db.write.unbounded']);

// 声明的验证器名必须能落到 Validator 组合接口（Spec 7）。
export const VALIDATION_NAMES = Object.freeze([
  'source_identity', 'scope_match', 'structure', 'completeness', 'row_count',
  'digest', 'artifact_integrity', 'relations', 'publication', 'contiguous_prefix', 'readback',
]);
export const RECOVERY_RESUME_FROM = Object.freeze(['verified_cursor', 'idempotent_commit', 'checkpoint', 'none']);

// 发布期验证器名单：由 Validator 实现表的 stage 派生，不在这里重复维护。
// 有外部写副作用的能力必须声明其中至少一个，否则提交后无法自证「发布已生效」。
export const PUBLICATION_VALIDATION_NAMES = Object.freeze(
  VALIDATION_NAMES.filter((name) => validationStageOf(name) === VALIDATION_STAGE.PUBLICATION),
);

const NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const EXTERNAL_EFFECTS = Object.freeze(['feishu_write', 'external_publish', 'paid_provider_call', 'postgres_write']);

// 副作用 -> 必须同时声明的权限（未声明权限 = 隐性扩大写范围）。
const EFFECT_REQUIRES_PERMISSION = Object.freeze({
  browser_read: 'browser.read',
  browser_write: 'browser.write',
  feishu_write: 'feishu.api',
  postgres_write: 'postgres.write',
  paid_provider_call: 'provider.call',
  external_publish: 'network.external',
});

// 权限 -> 必须声明至少一个对应副作用（未声明副作用 = 偷偷写外部系统）。
const PERMISSION_REQUIRES_EFFECT = Object.freeze({
  'browser.write': ['browser_write'],
  'feishu.api': ['feishu_write'],
  'postgres.write': ['postgres_write'],
  'provider.call': ['paid_provider_call'],
});

function entryError(errors, code, field, detail) {
  errors.push({ code, field, detail: String(detail) });
}

export function parseDependency(spec) {
  if (typeof spec !== 'string') return null;
  const at = spec.indexOf('@');
  if (at <= 0) return { id: spec.trim(), range: '*' };
  const id = spec.slice(0, at).trim();
  const range = spec.slice(at + 1).trim();
  return { id, range: range || '*' };
}

export function formatDependency({ id, range }) {
  return range && range !== '*' ? `${id}@${range}` : id;
}

// 返回 { ok, errors, errorCodes, warnings }
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    entryError(errors, 'MANIFEST_NOT_OBJECT', 'manifest', 'manifest must be a plain object');
    return finish(errors, warnings);
  }

  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    entryError(errors, 'MANIFEST_SCHEMA_VERSION', 'schemaVersion', `must be ${MANIFEST_SCHEMA_VERSION}`);
  }

  if (!manifest.name) entryError(errors, 'NAME_REQUIRED', 'name', 'is required');
  else if (!NAME_RE.test(String(manifest.name))) {
    entryError(errors, 'NAME_INVALID', 'name', `"${manifest.name}" must be dotted lowercase segments, e.g. xws.market-analysis.collect`);
  }

  if (!manifest.version) entryError(errors, 'VERSION_REQUIRED', 'version', 'is required');
  else if (!isValidVersion(manifest.version)) entryError(errors, 'VERSION_INVALID', 'version', `"${manifest.version}" is not a semver`);

  if (!manifest.kind) entryError(errors, 'KIND_REQUIRED', 'kind', 'is required');
  else if (!MANIFEST_KINDS.includes(manifest.kind)) entryError(errors, 'KIND_INVALID', 'kind', `unknown kind: ${manifest.kind}`);

  if (!manifest.description || typeof manifest.description !== 'string') {
    entryError(errors, 'DESCRIPTION_REQUIRED', 'description', 'non-empty string is required');
  }

  // entry：实现入口，必须是站内相对路径，禁止绝对路径与 ../ 逃逸。
  if (!manifest.entry || typeof manifest.entry !== 'string') {
    entryError(errors, 'ENTRY_REQUIRED', 'entry', 'relative implementation path is required');
  } else {
    const entry = manifest.entry;
    if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(entry)) {
      entryError(errors, 'ENTRY_ABSOLUTE', 'entry', `must be relative to the skill directory: ${entry}`);
    } else if (entry.split(/[\\/]/).some((segment) => segment === '..')) {
      entryError(errors, 'ENTRY_ESCAPE', 'entry', `must not escape the skill directory: ${entry}`);
    } else if (!/\.mjs$/.test(entry)) {
      entryError(errors, 'ENTRY_INVALID', 'entry', `entry must be a .mjs module: ${entry}`);
    }
  }

  validateIo(manifest, 'inputs', INPUT_TYPES, errors);
  validateIo(manifest, 'outputs', OUTPUT_TYPES, errors);
  validateEnumList(manifest, 'preconditions', PRECONDITIONS, 'PRECONDITION_UNKNOWN', errors);
  validatePermissions(manifest, errors);
  validateSideEffects(manifest, errors);
  validateDependencies(manifest, errors);
  validateEnumList(manifest, 'validation', VALIDATION_NAMES, 'VALIDATION_UNKNOWN', errors);
  validateRecovery(manifest, errors);

  if (manifest.implementationDigest !== undefined) {
    if (typeof manifest.implementationDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.implementationDigest)) {
      entryError(errors, 'DIGEST_INVALID', 'implementationDigest', 'must be sha256:<64 hex>');
    }
  }

  // 外部副作用必须可恢复（幂等/对账），否则拒绝。
  const sideEffects = Array.isArray(manifest.sideEffects) ? manifest.sideEffects : [];
  const external = sideEffects.filter((effect) => EXTERNAL_EFFECTS.includes(effect));
  if (external.length && manifest.recovery?.supported !== true) {
    entryError(errors, 'RECOVERY_NOT_RESUMABLE', 'recovery', `external side effects ${external.join(', ')} require recovery.supported=true`);
  }

  // 发布期验收义务：能力声明了外部写副作用，就必须声明至少一个发布期验证器。
  // 否则「提交成功」永远只是本地假设，回读阶段没有可执行的判定依据，游标会在未验收的发布上推进。
  // 只约束 kind=capability：adapter 是低层合同，发布验收责任在能力层。
  // 反向不约束（只声明发布期验证器却不写外部）是无害的冗余，不报错。
  if (manifest.kind === 'capability' && external.length) {
    const declaredValidation = Array.isArray(manifest.validation) ? manifest.validation : [];
    const hasPublication = declaredValidation.some((name) => PUBLICATION_VALIDATION_NAMES.includes(name));
    if (!hasPublication) {
      entryError(errors, 'PUBLICATION_VALIDATOR_MISSING', 'validation',
        `capability declaring ${external.join(', ')} must also declare at least one of: ${PUBLICATION_VALIDATION_NAMES.join(', ')}`);
    }
  }

  const known = new Set([
    'schemaVersion', 'name', 'version', 'kind', 'description', 'entry',
    'inputs', 'outputs', 'preconditions', 'permissions', 'sideEffects',
    'dependencies', 'validation', 'recovery', 'implementationDigest', 'owner', 'tags',
  ]);
  for (const key of Object.keys(manifest)) {
    if (!known.has(key)) warnings.push({ code: 'UNKNOWN_FIELD', field: key, detail: 'ignored by registry, kept for documentation' });
  }

  return finish(errors, warnings);
}

function finish(errors, warnings) {
  return { ok: errors.length === 0, errors, errorCodes: [...new Set(errors.map((e) => e.code))], warnings };
}

function validateIo(manifest, key, allowedTypes, errors) {
  const value = manifest[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    entryError(errors, `${key.toUpperCase()}_INVALID`, key, 'must be an array');
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || !item.name || !item.type) {
      entryError(errors, `${key.toUpperCase()}_INVALID`, `${key}[${index}]`, 'requires { name, type }');
      return;
    }
    if (!allowedTypes.includes(item.type)) {
      entryError(errors, `${key.toUpperCase()}_INVALID`, `${key}[${index}].type`, `unknown type: ${item.type}`);
    }
    if (seen.has(item.name)) entryError(errors, `${key.toUpperCase()}_DUPLICATE`, `${key}[${index}].name`, `duplicate: ${item.name}`);
    seen.add(item.name);
  });
}

function validateEnumList(manifest, key, allowed, code, errors) {
  const value = manifest[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    entryError(errors, code, key, 'must be an array');
    return;
  }
  for (const item of value) {
    if (!allowed.includes(item)) entryError(errors, code, key, `unknown value: ${item}`);
  }
}

function validatePermissions(manifest, errors) {
  const value = manifest.permissions;
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    entryError(errors, 'PERMISSION_UNKNOWN', 'permissions', 'must be an array');
    return;
  }
  for (const item of value) {
    if (FORBIDDEN_PERMISSIONS.includes(item)) entryError(errors, 'PERMISSION_FORBIDDEN', 'permissions', `${item} is never allowed for a Skill`);
    else if (!PERMISSIONS.includes(item)) entryError(errors, 'PERMISSION_UNKNOWN', 'permissions', `unknown permission: ${item}`);
  }
}

function validateSideEffects(manifest, errors) {
  const value = manifest.sideEffects;
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    entryError(errors, 'SIDE_EFFECT_UNKNOWN', 'sideEffects', 'must be an array');
    return;
  }
  for (const item of value) {
    if (!SIDE_EFFECT_CLASSES.includes(item)) entryError(errors, 'SIDE_EFFECT_UNKNOWN', 'sideEffects', `unknown side effect: ${item}`);
  }
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  // 声明了副作用就必须声明对应权限。
  for (const effect of value) {
    const required = EFFECT_REQUIRES_PERMISSION[effect];
    if (required && !permissions.includes(required)) {
      entryError(errors, 'PERMISSION_MISSING', 'sideEffects', `${effect} requires permission ${required}`);
    }
  }
  // 声明了写权限就必须声明对应副作用，防止偷偷写外部系统。
  for (const permission of permissions) {
    const expects = PERMISSION_REQUIRES_EFFECT[permission];
    if (expects && !expects.some((effect) => value.includes(effect))) {
      entryError(errors, 'UNDECLARED_SIDE_EFFECT', 'sideEffects', `${permission} requires declaring one of: ${expects.join(', ')}`);
    }
  }
}

function validateDependencies(manifest, errors) {
  const value = manifest.dependencies;
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    entryError(errors, 'DEPENDENCY_INVALID', 'dependencies', 'must be an array');
    return;
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      entryError(errors, 'DEPENDENCY_INVALID', 'dependencies', `must be a string like adapter.xws@^1.0.0, got ${JSON.stringify(item)}`);
      continue;
    }
    const parsed = parseDependency(item);
    if (!parsed || !NAME_RE.test(parsed.id)) {
      entryError(errors, 'DEPENDENCY_INVALID', 'dependencies', `invalid dependency id: ${item}`);
      continue;
    }
    if (!isValidRange(parsed.range)) {
      entryError(errors, 'DEPENDENCY_INVALID', 'dependencies', `invalid version range in: ${item}`);
    }
  }
}

function validateRecovery(manifest, errors) {
  const value = manifest.recovery;
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || typeof value.supported !== 'boolean') {
    entryError(errors, 'RECOVERY_INVALID', 'recovery', 'requires { supported: boolean, resumeFrom?: string }');
    return;
  }
  if (value.resumeFrom !== undefined && !RECOVERY_RESUME_FROM.includes(value.resumeFrom)) {
    entryError(errors, 'RECOVERY_INVALID', 'recovery.resumeFrom', `unknown value: ${value.resumeFrom}`);
  }
  if (value.supported === true && (!value.resumeFrom || value.resumeFrom === 'none')) {
    entryError(errors, 'RECOVERY_INVALID', 'recovery.resumeFrom', 'supported=true requires a concrete resumeFrom');
  }
}

// 归一化：补默认值，不改写业务语义。返回冻结的普通对象。
export function normalizeManifest(manifest) {
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    description: manifest.description,
    entry: manifest.entry,
    inputs: Object.freeze((manifest.inputs ?? []).map((i) => Object.freeze({ ...i }))),
    outputs: Object.freeze((manifest.outputs ?? []).map((o) => Object.freeze({ ...o }))),
    preconditions: Object.freeze([...(manifest.preconditions ?? [])]),
    permissions: Object.freeze([...(manifest.permissions ?? [])]),
    sideEffects: Object.freeze([...(manifest.sideEffects ?? [])]),
    dependencies: Object.freeze((manifest.dependencies ?? []).map((d) => Object.freeze(parseDependency(d)))),
    validation: Object.freeze([...(manifest.validation ?? [])]),
    recovery: Object.freeze({ supported: false, resumeFrom: 'none', ...(manifest.recovery ?? {}) }),
    implementationDigest: manifest.implementationDigest ?? null,
  });
}

// 稳定序列化：键排序，保证 digest 可复现。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
