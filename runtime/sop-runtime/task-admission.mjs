// Task Admission：校验任务范围、身份、能力和配额，创建 run_id（不执行任何外部动作）
import { createContext, validateContext, advance } from './context-schema.mjs';
import { evaluatePolicy, laneKey, capabilityLane, laneFor, classifyRisk } from './policy.mjs';

const REQUIRED_SPEC = ['taskId', 'workflow', 'capability', 'identity'];

export function validateTaskSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['taskSpec must be an object'] };
  for (const key of REQUIRED_SPEC) {
    if (!spec[key]) errors.push(`taskSpec.${key} is required`);
  }
  const identity = spec?.identity ?? {};
  for (const key of ['tenantId', 'storeId', 'platform', 'accountId', 'browserProfileId', 'contractVersion']) {
    if (!identity[key]) errors.push(`identity.${key} is required`);
  }
  return { ok: errors.length === 0, errors };
}

export function buildIdempotencyKey({ taskId, identity, capability, scope }) {
  return [
    'sop', taskId, capability,
    identity.tenantId, identity.storeId, identity.platform, identity.accountId,
    scope ?? 'default',
  ].join(':');
}

export async function admitTask({
  store,
  spec,
  registeredCapabilities = null,
  nowIso = new Date().toISOString(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  const validation = validateTaskSpec(spec);
  if (!validation.ok) {
    return {
      admitted: false,
      rejectionReasons: validation.errors,
      failureClass: 'POLICY_DENIED',
      runId: null,
      context: null,
    };
  }

  // 写任务把「写目标」并入 lane，保证同一外部目标不被两个运行同时写。
  const isWrite = Boolean(spec.write);
  const lane = laneFor({ identity: spec.identity, capability: spec.capability, target: spec.target ?? null, write: isWrite });
  const activeInLane = await store.countActiveInLane(lane);
  const policy = evaluatePolicy({
    identity: spec.identity,
    capability: spec.capability,
    sideEffects: spec.sideEffects ?? [],
    target: spec.target ?? null,
    write: isWrite,
    activeInLane,
    registeredCapabilities,
  });

  if (policy.decision === 'DENY') {
    return {
      admitted: false,
      rejectionReasons: policy.reasons,
      failureClass: policy.failureClass ?? 'POLICY_DENIED',
      riskClass: policy.riskClass,
      runId: null,
      context: null,
    };
  }

  const runId = idFactory();
  const base = createContext({
    taskId: spec.taskId,
    runId,
    workflow: spec.workflow,
    capability: spec.capability,
    identity: spec.identity,
    stage: 'ADMITTED',
    target: spec.target ?? null,
    verifiedCursor: spec.verifiedCursor ?? (spec.targetEnd ? { start: 1, end: 0, version: 0 } : null),
    retryBudget: spec.retryBudget ?? { transientExternal: 3 },
  });

  let context = advance(base, {
    nextAction: policy.humanGate ? 'WAIT_APPROVAL' : 'START',
    humanGateStatus: policy.humanGate ? 'WAITING_HUMAN' : 'NONE',
    executionStatus: policy.humanGate ? 'PAUSED' : 'QUEUED',
    // lane 落到上下文里，成为权威值：执行期直接用它，不再重新推算，
    // 避免「准入时算一种 lane、开 attempt 时算成另一种」的静默漂移。
    lane,
    isWrite,
    queue: { ...(base.queue ?? {}), enqueuedAt: nowIso, priority: Number(spec.priority ?? 0), deadlineAt: spec.deadlineAt ?? null },
    updatedAt: nowIso,
  }, { nowIso });

  const check = validateContext(context);
  if (!check.ok) {
    return { admitted: false, rejectionReasons: check.errors, failureClass: 'BUG', runId: null, context: null };
  }

  await store.createRun({
    runId,
    identity: spec.identity,
    context,
    targetEnd: Number(spec.targetEnd ?? 0),
    lane,
  });

  return {
    admitted: true,
    runId,
    context,
    policy: { decision: policy.decision, riskClass: policy.riskClass, reasons: policy.reasons, lane, laneKey: laneKey(spec.identity) },
    rejectionReasons: [],
  };
}

export { classifyRisk };
