// Task Admission：校验任务范围、身份、能力和配额，创建 run_id（不执行任何外部动作）
import { createContext, validateContext, advance } from './context-schema.mjs';
import { evaluatePolicy, laneKey, capabilityLane, laneFor, classifyRisk } from './policy.mjs';
import { assessRunLiveness } from './run-liveness.mjs';

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
  // 崩溃遗留的运行会永久占住幂等键（缺口 B）。下面两个参数是**显式可选**的逃生门：
  // 只有调用方同时给出 reclaimStale=true 与一个 reclaim 回调时，准入才会去尝试回收一条 stale 运行。
  // 刻意不做成默认行为——「悄悄终结一条运行」不该是准入的副作用。
  reclaimStale = false,
  reclaim = null,
  abandonedAfterMs = null,
  nowMs = Date.now(),
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

  // 去重按**业务范围**（idempotencyKey）而不是 lane 占用。
  // 同一账号下的两件不同商品不是重复，同一件事项被提交两次才是；
  // 按 lane 去重会把前者一起挡掉，商品级 fan-out 因此无法入队。
  const idempotencyKey = spec.idempotencyKey
    ?? buildIdempotencyKey({ taskId: spec.taskId, identity: spec.identity, capability: spec.capability, scope: spec.scope ?? null });
  let duplicate = await findActiveByIdempotencyKey(store, idempotencyKey);
  let reclaimAttempt = null;

  // 可选的一轮确定性回收：发现重复 → 先判定「这条运行是不是死了」→ 只有调用方给了回收回调
  // 才去真的回收 → 回收成功后**重查一次**幂等键。回收被拒不是错误，是判定结果：
  // 记进 reclaimAttempt 一并返回，让调用方拿到「下一步该做什么」，而不是只知道「被挡了」。
  if (duplicate && reclaimStale && typeof reclaim === 'function') {
    try {
      const result = await reclaim(duplicate.runId, {
        idempotencyKey, taskId: spec.taskId, capability: spec.capability, abandonedAfterMs,
      });
      reclaimAttempt = {
        runId: duplicate.runId,
        reclaimed: Boolean(result?.reclaimed),
        reason: result?.reason ?? null,
        code: null,
        guidance: null,
      };
    } catch (error) {
      reclaimAttempt = {
        runId: duplicate.runId,
        reclaimed: false,
        code: error?.code ?? 'RECLAIM_ERROR',
        reason: String(error?.message ?? error),
        guidance: error?.details?.guidance ?? null,
      };
    }
    duplicate = await findActiveByIdempotencyKey(store, idempotencyKey);
  }

  if (duplicate) {
    // 报告这条重复运行的**现状**，别让调用方只能靠猜：
    // publicationStatus 决定「能不能回收」，而 UNKNOWN/COMMITTED 只能对账
    // （见 controller.reconcilePublication）——换个 commitKey 重跑就是重复外部写入。
    const status = duplicate.context ?? duplicate;
    const attempts = typeof store.listAttempts === 'function' ? await store.listAttempts(duplicate.runId) : [];
    const liveness = assessRunLiveness({ run: duplicate, attempts, nowMs, abandonedAfterMs });
    return {
      admitted: false,
      rejectionReasons: [`duplicate task already active: ${idempotencyKey} (run ${duplicate.runId})`],
      failureClass: 'POLICY_DENIED',
      riskClass: policy.riskClass,
      duplicateOf: duplicate.runId,
      duplicateStatus: {
        executionStatus: status.executionStatus ?? null,
        publicationStatus: status.publicationStatus ?? null,
      },
      /** 这条重复运行是否已被判定为「死了」（可以回收）。false 时 reason 说明它在等什么。 */
      reclaimable: liveness.reclaimable,
      reclaimReason: liveness.reason,
      reclaimAttempt,
      hint: liveness.reclaimable
        ? 'duplicate run looks stale: reclaim it (controller.reclaimStale) or let the runner auto-reclaim, then retry'
        : 'duplicate run looks alive or legitimately waiting; if it is a crash leftover, check its publication status before reclaiming (UNKNOWN can only be reconciled, never re-run)',
      idempotencyKey,
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
    // 把准入时**声明**的副作用写进上下文。它不是留档：Controller 靠它判断
    // 「这次运行声明过外部写入吗」，从而在游标推进处独立于 manifest 地收紧闸门。
    sideEffects: [...(spec.sideEffects ?? [])],
    // lane 落到上下文里，成为权威值：执行期直接用它，不再重新推算，
    // 避免「准入时算一种 lane、开 attempt 时算成另一种」的静默漂移。
    lane,
    isWrite,
    idempotencyKey,
    parentRunId: spec.parentRunId ?? null,
    queue: {
      ...(base.queue ?? {}),
      enqueuedAt: nowIso,
      priority: Number(spec.priority ?? 0),
      deadlineAt: spec.deadlineAt ?? null,
    },
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
    idempotencyKey,
    policy: { decision: policy.decision, riskClass: policy.riskClass, reasons: policy.reasons, lane, laneKey: laneKey(spec.identity) },
    rejectionReasons: [],
  };
}

// 活动运行里是否已有同一 idempotencyKey。
// 走 listActiveRuns 而不是新增 store 端口：不引入新表、不要求每个 store 实现新方法，
// 代价是 O(活动运行数) 的扫描——当前量级可接受，量级上去再考虑加索引列。
async function findActiveByIdempotencyKey(store, idempotencyKey) {
  if (!idempotencyKey) return null;
  const runs = await store.listActiveRuns({});
  return runs.find((run) => run?.context?.idempotencyKey === idempotencyKey) ?? null;
}

export { classifyRisk };
