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

// 为什么 USAGE_LIMIT_REACHED 单列一类、而不是并进 POLICY_DENIED（2026-09-21 加）：
// 两者的**动作**相同（都是 FAIL、当天收工、不自动重试），但**通知措辞**必须不同 ——
// 运营看到「配置或授权不对，已拒绝执行」会去查配置和授权，而这里实际要做的是
// 「等额度重置」或「升级套餐」。告警指错了人，比不告警更贵。分类的粒度决定告警指不指得对人。
export const FAILURE_CLASS = Object.freeze([
  'TRANSIENT_EXTERNAL', 'RESOURCE_BUSY', 'HUMAN_REQUIRED', 'CAPABILITY_DEGRADED',
  'EVIDENCE_INVALID', 'POLICY_DENIED', 'USAGE_LIMIT_REACHED', 'COMMIT_UNKNOWN', 'BUG',
]);

// STALLED 只能描述阶段/分片诊断，不是完成态，因此不在 EXECUTION_STATUS 内。
export const DIAGNOSTIC_STATUS = Object.freeze(['OK', 'STALLED']);

// 上下文的**状态轴字段名**（不是取值）。凡是「谁能改运行状态」的问题都以此为准：
// Workflow Controller 是唯一拥有者；Agent 提案、decisions 记录、外部提交载荷都不得出现这些键。
// 独立导出的理由：Controller（核心模块）需要它来拒绝夹带状态轴的 decisions，
// 而核心模块**不允许** import Agent 层（见 agent-proposal.assertAgentRemovable）——
// 因此这份清单必须住在双方都能依赖的 context-schema 里，而不是在 Agent 层。
export const CONTEXT_STATE_AXIS_FIELDS = Object.freeze([
  'executionStatus', 'evidenceStatus', 'humanGateStatus', 'leaseStatus', 'publicationStatus',
  'verifiedCursor', 'cursorVersion', 'blocker', 'nextAction',
]);

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
    // 业务去重键（准入时写入）。重复判定按它做，不按 lane 占用做——
    // 同一账号下的两件不同商品不是重复，同一件事项被提交两次才是。
    idempotencyKey: null,
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
    // 准入期声明的副作用集合（dry-run 与 --commit 会声明不同的集合，见 task-admission）。
    // 它落进上下文是有作用的，不是留档：Controller 用它回答「这次运行声明过外部写入吗」，
    // 从而在**不依赖 manifest**的前提下收紧游标推进（见 workflow-controller.advanceCursor）。
    sideEffects: [],
    verifiedCursor,
    retryBudget,
    retryUsed: { transientExternal: 0 },
    artifacts: [],
    evidenceRefs: [],
    sideEffectRefs: [],
    decisions: [],
    blocker: null,
    nextAction: 'ADMIT',
    // 队列元数据随上下文一起持久化（durable_runs.context 是 jsonb），
    // 因此队列优先级/等待时间/截止时间不需要新增表或新增列，也不依赖进程内状态。
    queue: {
      priority: 0,
      notBefore: null,
      deadlineAt: null,
      enqueuedAt: null,
      attempts: 0,
    },
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
  if (context.sideEffects !== undefined && !Array.isArray(context.sideEffects)) errors.push('sideEffects must be an array when present');
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
