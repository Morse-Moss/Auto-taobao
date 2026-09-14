// Compression Service：结构化上下文摘要（Spec 第 12 节 / 实施计划阶段 5）
// 只做「把当前上下文压成可校验摘要」，不改变任何业务状态，也不代替当前 Run Context。
// 硬规则：
//  1) 摘要必须保留恢复必需字段（身份、授权边界、五条状态轴、游标、副作用、阻塞、下一动作、原文 digest）；
//  2) 缺关键字段一律 fail-closed：拒绝产出，也拒绝被消费；
//  3) 摘要只能引用原文摘要（digest），不能把原文内容替换成模型转述；
//  4) 历史规则/经验永远不能覆盖当前 run 的证据。
import { summarize, CONTEXT_SCHEMA_VERSION } from './context-schema.mjs';

export const COMPRESSION_SCHEMA_VERSION = 'sop-summary-v1';

// 这些字段缺任何一个，摘要都不能用于恢复——宁可拒绝，也不要「差不多能用」的摘要。
export const SUMMARY_REQUIRED_FIELDS = Object.freeze([
  'runId',
  'taskId',
  'workflow',
  'capability',
  'identity',
  'stage',
  'stepId',
  'attemptId',
  'executionStatus',
  'evidenceStatus',
  'humanGateStatus',
  'leaseStatus',
  'publicationStatus',
  'verifiedCursor',
  'sideEffectRefs',
  'blocker',
  'nextAction',
  'sourceDigest',
  'sourceVersion',
]);

// 这些字段允许是 null（表示「当前阶段没有这一步/没有游标/没有阻塞」），
// 但字段本身必须存在——「没有值」和「忘了写」是两回事，后者必须被拒绝。
export const NULLABLE_SUMMARY_FIELDS = Object.freeze([
  'stepId', 'attemptId', 'verifiedCursor', 'blocker',
]);

// 允许触发压缩的阶段边界：只有阶段结束时压缩，避免阶段中途丢掉「正在做什么」。
export const COMPRESS_BOUNDARY_STAGES = Object.freeze([
  'COLLECT', 'VALIDATE', 'COMMIT', 'PUBLISH', 'RECONCILE', 'DONE',
]);

// 授权边界：这些必须被摘要显式带出，否则恢复后可能越权。
export const AUTHORIZATION_FIELDS = Object.freeze([
  'humanGateStatus', 'publicationStatus', 'nextAction',
]);

export class CompressRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CompressRejectedError';
    this.code = 'COMPRESS_REJECTED';
    this.details = details;
  }
}

// token 估算：确定性、可复现，不调用模型。按 UTF-8 字节 / 3 估算（中英混排的保守近似）。
// 阈值本身可由调用方配置，这里只提供一个稳定的默认度量。
export function estimateBytes(context) {
  return Buffer.byteLength(JSON.stringify(context ?? {}), 'utf8');
}

export function estimateTokens(context) {
  return Math.ceil(estimateBytes(context) / 3);
}

// 是否应当压缩。两种触发：超过阈值，或到达阶段边界且显式要求。
export function shouldCompress(context, {
  maxBytes = 32 * 1024,
  maxTokens = 12 * 1024,
  stageBoundary = false,
} = {}) {
  const bytes = estimateBytes(context);
  const tokens = estimateTokens(context);
  const overBytes = bytes >= maxBytes;
  const overTokens = tokens >= maxTokens;
  const atBoundary = stageBoundary && COMPRESS_BOUNDARY_STAGES.includes(context?.stage);
  return {
    compress: overBytes || overTokens || atBoundary,
    reason: overBytes ? 'BYTE_THRESHOLD' : overTokens ? 'TOKEN_THRESHOLD' : atBoundary ? 'STAGE_BOUNDARY' : 'WITHIN_BUDGET',
    bytes,
    tokens,
  };
}

// 原文摘要：把「这次压缩引用的原始事实」固化成可追溯的 digest 列表。
// 摘要只允许引用 digest 与 URI，不允许把原文替换成自然语言转述。
export function buildSourceDigest(context, references = []) {
  const artifactDigests = [];
  for (const artifact of context?.artifacts ?? []) {
    if (artifact?.sha256) artifactDigests.push({ uri: artifact.uri ?? artifact.path ?? null, sha256: artifact.sha256 });
  }
  for (const evidence of context?.evidenceRefs ?? []) {
    if (evidence?.sha256) artifactDigests.push({ uri: evidence.uri ?? null, sha256: evidence.sha256 });
  }
  for (const extra of references) {
    if (extra?.sha256) artifactDigests.push({ uri: extra.uri ?? null, sha256: extra.sha256 });
  }
  return {
    algorithm: 'sha256',
    artifactDigests,
    sideEffectRefs: [...(context?.sideEffectRefs ?? [])],
  };
}

// 生成结构化摘要。sourceDigest 一并算出，保证「摘要 -> 原文」随时可回查。
export function buildSummary(context, { references = [], reason = 'MANUAL', nowIso = null } = {}) {
  const base = summarize(context);
  // 注意顺序：base 里带的是 context 的 schemaVersion，必须先铺开再覆盖成摘要自己的版本，
  // 否则摘要会被自己的校验器判成缺 schemaVersion。
  return {
    ...base,
    schemaVersion: COMPRESSION_SCHEMA_VERSION,
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    identity: { ...(context?.identity ?? {}) },
    sideEffectRefs: [...(context?.sideEffectRefs ?? [])],
    sourceDigest: buildSourceDigest(context, references),
    sourceVersion: context?.contextVersion ?? null,
    reason,
    createdAt: nowIso ?? new Date().toISOString(),
  };
}

// 摘要完整性校验：这是「拒绝使用坏摘要」的唯一入口，被 compressContext 与消费方共用。
export function validateSummary(summary) {
  const errors = [];
  if (!summary || typeof summary !== 'object') {
    return { ok: false, errors: ['summary must be an object'], missing: [...SUMMARY_REQUIRED_FIELDS] };
  }
  if (summary.schemaVersion !== COMPRESSION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${COMPRESSION_SCHEMA_VERSION}`);
  }
  const missing = [];
  const nullable = new Set(NULLABLE_SUMMARY_FIELDS);
  for (const field of SUMMARY_REQUIRED_FIELDS) {
    const value = summary[field];
    if (value === undefined) {
      missing.push(field);
      continue;
    }
    if (nullable.has(field)) continue; // null 是合法值，但字段必须在
    if (value === null || value === '') missing.push(field);
  }
  if (missing.length) errors.push(`missing required fields: ${missing.join(', ')}`);
  if (summary.sideEffectRefs !== undefined && !Array.isArray(summary.sideEffectRefs)) {
    errors.push('sideEffectRefs must be an array');
  }
  // 身份字段必须完整，否则恢复后无法确认是谁在跑。
  const identity = summary.identity ?? {};
  for (const key of ['tenantId', 'storeId', 'platform', 'accountId', 'browserProfileId', 'contractVersion']) {
    if (identity[key] === undefined || identity[key] === null || identity[key] === '') {
      errors.push(`identity.${key} is required`);
    }
  }
  // 原文引用必须是合法的 sha256 集合（可以为空数组，但不能没有结构）。
  const digests = summary.sourceDigest?.artifactDigests;
  if (!Array.isArray(digests)) errors.push('sourceDigest.artifactDigests must be an array');
  else {
    const bad = digests.filter((entry) => !/^[0-9a-f]{64}$/.test(String(entry?.sha256 ?? '')));
    if (bad.length) errors.push(`sourceDigest contains invalid sha256 entries: ${bad.length}`);
  }
  if (!Number.isInteger(summary.sourceVersion) || summary.sourceVersion < 1) {
    errors.push('sourceVersion must be a positive integer');
  }
  return { ok: errors.length === 0, errors, missing };
}

// 消费侧闸门：拿到摘要先过这一关，缺字段直接抛，绝不「尽力恢复」。
export function assertUsableSummary(summary) {
  const check = validateSummary(summary);
  if (!check.ok) {
    throw new CompressRejectedError(`summary is not usable: ${check.errors.join('; ')}`, { errors: check.errors, missing: check.missing });
  }
  return summary;
}

// 压缩入口：先校验源上下文能产出合法摘要，产出后再自校验一次。
// 任何一步不满足就抛 CompressRejectedError——不存在「先压了再说」。
export function compressContext(context, options = {}) {
  const summary = buildSummary(context, options);
  const check = validateSummary(summary);
  if (!check.ok) {
    throw new CompressRejectedError(`refusing to emit incomplete summary: ${check.errors.join('; ')}`, {
      errors: check.errors,
      missing: check.missing,
      runId: context?.runId ?? null,
    });
  }
  return summary;
}

// 命中阈值时压缩，否则返回 null（不产出摘要本身也是合法结果）。
export function compressIfNeeded(context, options = {}) {
  const decision = shouldCompress(context, options);
  if (!decision.compress) return { summary: null, decision };
  return { summary: compressContext(context, options), decision };
}

// 摘要与当前上下文的可追溯校验：摘要必须指向同一个 run/attempt，且不能比当前上下文还新。
// 这是「压缩污染恢复」的主要防线：串了 run/attempt 的摘要一律拒绝。
export function assertSummaryMatchesRun(summary, context) {
  assertUsableSummary(summary);
  const problems = [];
  if (summary.runId !== context?.runId) problems.push(`runId mismatch: summary=${summary.runId} context=${context?.runId}`);
  if (summary.attemptId !== (context?.attemptId ?? null)) problems.push(`attemptId mismatch: summary=${summary.attemptId} context=${context?.attemptId ?? null}`);
  if (Number(summary.sourceVersion) > Number(context?.contextVersion ?? 0)) {
    problems.push(`summary is newer than context: ${summary.sourceVersion} > ${context?.contextVersion}`);
  }
  if (problems.length) {
    throw new CompressRejectedError(`summary does not match the live run: ${problems.join('; ')}`, { problems });
  }
  return true;
}

// 当前证据优先：历史规则/经验永远不能覆盖当前 run 的验证结果。
// 返回确定性的判定结果，不返回「合并后的值」——合并会掩盖冲突。
export function resolveCurrentOverHistory({ currentEvidence = null, historical = [] } = {}) {
  if (currentEvidence) {
    return {
      source: 'CURRENT_RUN_EVIDENCE',
      value: currentEvidence,
      overridden: historical.map((entry) => ({ layer: entry?.layer ?? null, value: entry?.value ?? null })),
      reason: 'current run evidence outranks any historical rule or experience',
    };
  }
  return {
    source: 'HISTORICAL',
    value: historical.length ? historical[0].value ?? null : null,
    overridden: [],
    reason: 'no current-run evidence; historical entry used only as a fallback',
  };
}
