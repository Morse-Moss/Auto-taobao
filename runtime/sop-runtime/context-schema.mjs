// sop-context-v1：统一任务上下文契约（Spec 第 6 节）
// 确定性模块只读/写这里定义的结构；模型不得创建或修改身份字段。

export const CONTEXT_SCHEMA_VERSION = 'sop-context-v1';

export const EXECUTION_STATUS = Object.freeze([
  'QUEUED', 'RUNNING', 'RETRY_WAIT', 'PAUSED', 'SUCCEEDED', 'FAILED',
]);
export const EVIDENCE_STATUS = Object.freeze(['NONE', 'CANDIDATE', 'VALIDATED', 'REJECTED']);
export const HUMAN_GATE_STATUS = Object.freeze(['NONE', 'WAITING_HUMAN', 'APPROVED', 'DENIED', 'EXPIRED']);
export const LEASE_STATUS = Object.freeze(['WAITING', 'HELD', 'EXPIRED', 'RELEASED']);
export const PUBLICATION_STATUS = Object.freeze(['NOT_REQUESTED', 'READY', 'COMMITTED', 'VERIFIED', 'UNKNOWN']);

export const FAILURE_CLASS = Object.freeze([
  'TRANSIENT_EXTERNAL', 'RESOURCE_BUSY', 'HUMAN_REQUIRED', 'CAPABILITY_DEGRADED',
  'EVIDENCE_INVALID', 'POLICY_DENIED', 'COMMIT_UNKNOWN', 'BUG',
]);

// STALLED 只能描述阶段/分片诊断，不是完成态，因此不在 EXECUTION_STATUS 内。
export const DIAGNOSTIC_STATUS = Object.freeze(['OK', 'STALLED']);

const REQUIRED_IDENTITY = ['tenantId', 'storeId', 'platform', 'accountId', 'browserProfileId', 'contractVersion'];

export function createContext({
  taskId,
  runId,
  workflow,
  capability,
  identity,
  stage = 'INIT',
  stepId = null,
  attemptId = null,
  parentRunId = null,
  target = null,
  verifiedCursor = null,
  retryBudget = { transientExternal: 3 },
} = {}) {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    taskId: taskId ?? null,
    runId: runId ?? null,
    parentRunId,
    workflow: workflow ?? null,
    capability: capability ?? null,
    identity: identity ?? {},
    stage,
    stepId,
    attemptId,
    target,
    executionStatus: 'QUEUED',
    evidenceStatus: 'NONE',
    humanGateStatus: 'NONE',
    leaseStatus: 'WAITING',
    publicationStatus: 'NOT_REQUESTED',
    verifiedCursor,
    retryBudget,
    retryUsed: { transientExternal: 0 },
    artifacts: [],
    evidenceRefs: [],
    sideEffectRefs: [],
    decisions: [],
    blocker: null,
    nextAction: 'ADMIT',
    contextVersion: 1,
    updatedAt: null,
  };
}

export function validateContext(context) {
  const errors = [];
  if (!context || typeof context !== 'object') return { ok: false, errors: ['context must be an object'] };
  if (context.schemaVersion !== CONTEXT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${CONTEXT_SCHEMA_VERSION}`);
  for (const key of ['taskId', 'runId', 'workflow', 'capability']) {
    if (!context[key]) errors.push(`${key} is required`);
  }
  if (!context.identity || typeof context.identity !== 'object') errors.push('identity must be an object');
  else {
    for (const key of REQUIRED_IDENTITY) {
      const value = context.identity[key];
      if (value === undefined || value === null || value === '') errors.push(`identity.${key} is required`);
    }
  }
  if (!EXECUTION_STATUS.includes(context.executionStatus)) errors.push(`invalid executionStatus: ${context.executionStatus}`);
  if (!EVIDENCE_STATUS.includes(context.evidenceStatus)) errors.push(`invalid evidenceStatus: ${context.evidenceStatus}`);
  if (!HUMAN_GATE_STATUS.includes(context.humanGateStatus)) errors.push(`invalid humanGateStatus: ${context.humanGateStatus}`);
  if (!LEASE_STATUS.includes(context.leaseStatus)) errors.push(`invalid leaseStatus: ${context.leaseStatus}`);
  if (!PUBLICATION_STATUS.includes(context.publicationStatus)) errors.push(`invalid publicationStatus: ${context.publicationStatus}`);
  if (!Number.isInteger(context.contextVersion) || context.contextVersion < 1) errors.push('contextVersion must be a positive integer');
  if (context.blocker && !FAILURE_CLASS.includes(context.blocker.class)) errors.push(`invalid blocker.class: ${context.blocker?.class}`);
  return { ok: errors.length === 0, errors };
}

// 每次状态推进都必须带版本；返回新对象，不原地修改。
export function advance(context, patch, { nowIso } = {}) {
  const next = {
    ...context,
    ...patch,
    contextVersion: context.contextVersion + 1,
    updatedAt: nowIso ?? new Date().toISOString(),
  };
  return next;
}

export function setBlocker(context, failureClass, detail, { nowIso } = {}) {
  return advance(context, {
    blocker: { class: failureClass, detail: String(detail ?? '').slice(0, 500), at: nowIso ?? new Date().toISOString() },
  }, { nowIso });
}

export function clearBlocker(context, { nowIso } = {}) {
  return advance(context, { blocker: null }, { nowIso });
}

// 上下文摘要：只保留恢复必需的确定性字段，不含原文。
export function summarize(context) {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    taskId: context.taskId,
    runId: context.runId,
    workflow: context.workflow,
    capability: context.capability,
    stage: context.stage,
    stepId: context.stepId,
    attemptId: context.attemptId,
    executionStatus: context.executionStatus,
    evidenceStatus: context.evidenceStatus,
    humanGateStatus: context.humanGateStatus,
    leaseStatus: context.leaseStatus,
    publicationStatus: context.publicationStatus,
    verifiedCursor: context.verifiedCursor ?? null,
    artifactCount: (context.artifacts ?? []).length,
    evidenceRefCount: (context.evidenceRefs ?? []).length,
    sideEffectRefCount: (context.sideEffectRefs ?? []).length,
    blocker: context.blocker ?? null,
    nextAction: context.nextAction,
    contextVersion: context.contextVersion,
  };
}

export function isTerminal(context) {
  return context.executionStatus === 'SUCCEEDED' || context.executionStatus === 'FAILED';
}
