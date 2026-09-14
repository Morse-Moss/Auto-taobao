// Task Queue：任务队列、限流、背压、超时、取消、重试退避、按 lane 容量出队、平台熔断、结果合并。
// （实施计划阶段 6：“增加限流、背压、平台熔断和结果合并”）
//
// 设计约束：
//  - 队列元数据保存在运行上下文里（durable_runs.context 是 jsonb），因此不新增表、不新增列，
//    也不依赖进程内状态——进程重启后队列顺序、退避时间、截止时间都还在。
//  - 队列只决定「谁先上」，不改变执行状态：状态转移一律由 Controller 完成。
//  - 出队前必须过闸门：退避时间、截止时间、熔断、lane 容量。任何一道不满足都只是
//    「这次不选它」，不会把它标记成失败或完成。
//  - 限流器与熔断器的状态是进程内的（没有落库），重启即复位。如实标注为 best-effort，
//    绝不宣称 durable；跨进程的硬约束由 lane（落库在 durable_runs.lane）承担。
import { LANE_EXECUTING_STATUSES } from './store-port.mjs';
import { laneLimit, laneFor } from './policy.mjs';
import { admitTask } from './task-admission.mjs';

// 入队被拒的确定性原因。与 FAILURE_CLASS 分开：这是「队列层拒绝」，不是执行层失败。
//  - BACKPRESSURE：容量满了（全局或单 lane）——「现在不该接活」，稍后再试。
//  - DUPLICATE_TASK：同一业务范围的任务已在活动队列里，重复提交（去重按 idempotencyKey，不按 lane）。
//  - RATE_LIMITED：外部平台限流预算用完，稍后再试。
//  - CIRCUIT_OPEN：目标平台连续失败，冷却期内不再派发。
//  - DEADLINE_PASSED：任务已过截止时间，不再受理。
//  - INVALID_SPEC：任务规格本身不合法，重试无用。
export const QUEUE_REJECTION = Object.freeze([
  'BACKPRESSURE', 'DUPLICATE_TASK', 'RATE_LIMITED', 'CIRCUIT_OPEN', 'DEADLINE_PASSED', 'INVALID_SPEC',
]);

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

// 指数退避：第 n 次尝试等待 base * 2^(n-1)，封顶 max。
// 确定性纯函数，便于测试与复现；抖动留给调用方，避免把随机性引进状态机。
export function backoffMs(attempts, { base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS } = {}) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(max, base * 2 ** (n - 1));
}

// 平台熔断：同一目标/平台连续失败到阈值就打开，冷却期内不再派发新任务。
// 注意：状态是进程内的（没有落库）。重启即复位——这一点必须如实告知，不能宣称「durable 熔断」。
export function createCircuitBreaker({ failureThreshold = 3, cooldownMs = 60_000, nowMs = () => Date.now() } = {}) {
  const state = new Map();

  function isOpen(key, now = nowMs()) {
    const entry = state.get(key);
    if (!entry || !entry.openedAt) return false;
    return now - entry.openedAt < cooldownMs;
  }

  function recordFailure(key, now = nowMs()) {
    const entry = state.get(key) ?? { failures: 0, openedAt: null };
    entry.failures += 1;
    if (entry.failures >= failureThreshold) entry.openedAt = now;
    state.set(key, entry);
    return { key, ...entry, open: isOpen(key, now) };
  }

  function recordSuccess(key) {
    state.delete(key);
  }

  function snapshot() {
    return [...state.entries()].map(([key, entry]) => ({ key, ...entry, open: isOpen(key) }));
  }

  return { isOpen, recordFailure, recordSuccess, snapshot };
}

// 令牌桶限流：每 key 一个桶，按 refillMs 匀速回填，上限 capacity。
// 用途是保护外部平台额度与风控，不用于业务正确性——因此进程内即可，
// 多进程各自持有一个桶，实际总放行量 ≈ 进程数 × capacity，这一点必须如实说明。
export function createRateLimiter({ capacity = 20, refillMs = 5_000, nowMs = () => Date.now() } = {}) {
  const buckets = new Map();

  function bucketOf(key, now) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now };
      buckets.set(key, bucket);
      return bucket;
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = Math.floor(elapsed / refillMs);
    if (refilled > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + refilled);
      bucket.updatedAt = bucket.updatedAt + refilled * refillMs;
    }
    return bucket;
  }

  return {
    // 非消费式探测：只判断「现在能不能取到令牌」，不改变状态。
    peek(key, now = nowMs()) {
      return bucketOf(key, now).tokens > 0;
    },
    // 消费一个令牌；取不到返回 false，且不改变状态。
    take(key, now = nowMs()) {
      const bucket = bucketOf(key, now);
      if (bucket.tokens <= 0) return false;
      bucket.tokens -= 1;
      return true;
    },
    // 取到令牌但后续准入被拒时归还，避免「没接成的活白扣配额」。
    refund(key, now = nowMs()) {
      const bucket = bucketOf(key, now);
      bucket.tokens = Math.min(capacity, bucket.tokens + 1);
    },
    snapshot(now = nowMs()) {
      return [...buckets.entries()].map(([key, bucket]) => ({ key, tokens: bucketOf(key, now).tokens }));
    },
  };
}

// fan-out 结果合并：确定性排序 + 冲突显式上报。
// 关键取舍：同一个 key 出现两个不同值时不「选一个」，而是记成冲突并交给人工——
// 静默择一等于用不确定的合并冒充确定的事实。
export function mergeFanoutResults(results = [], { keyOf = (item) => item.key } = {}) {
  const byKey = new Map();
  const conflicts = [];
  const failures = [];
  for (const item of results) {
    if (!item || item.ok === false) {
      failures.push({ source: item?.runId ?? item?.source ?? null, error: item?.error ?? 'unknown failure' });
      continue;
    }
    const key = String(keyOf(item));
    if (byKey.has(key)) {
      const previous = byKey.get(key);
      if (JSON.stringify(previous.value) !== JSON.stringify(item.value)) {
        conflicts.push({
          key,
          values: [previous.value, item.value],
          sources: [previous.runId ?? previous.source ?? null, item.runId ?? item.source ?? null],
        });
      }
      continue;
    }
    byKey.set(key, item);
  }
  const merged = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => ({ key, value: item.value, source: item.runId ?? item.source ?? null }));
  return {
    merged,
    conflicts,
    failures,
    ok: conflicts.length === 0 && failures.length === 0,
    requiresHuman: conflicts.length > 0,
  };
}

export function createTaskQueue({
  store,
  controller,
  nowIso = () => new Date().toISOString(),
  circuitBreaker = createCircuitBreaker(),
  rateLimiter = createRateLimiter(),
  limits = {},
} = {}) {
  if (!store) throw new Error('store is required');
  if (!controller) throw new Error('controller is required');

  const maxQueueDepth = Number(limits.maxQueueDepth ?? 200);
  const maxQueueDepthPerLane = Number(limits.maxQueueDepthPerLane ?? 20);
  const laneLimits = limits.laneLimits ?? null;

  const ms = (at) => new Date(at ?? nowIso()).getTime();

  // lane 是权威值：新准入的 run 一定被 task-admission 写进上下文。
  // 对更早创建、上下文里没有 lane 的 run，用同一条确定性规则重算，而不是「跳过它」——
  // 跳过会让老 run 永久留在队列里，且与 Controller.beginAttempt 的重算规则保持一致。
  function laneOf(run) {
    const context = run?.context ?? {};
    return context.lane ?? laneFor({
      identity: context.identity ?? {},
      capability: context.capability ?? null,
      target: context.target ?? null,
      write: Boolean(context.isWrite),
    });
  }

  function isWriteOf(run) {
    return Boolean(run?.context?.isWrite);
  }

  function queueOf(run) {
    return run?.context?.queue ?? {};
  }

  function breakerKeyOf(run) {
    const context = run?.context ?? {};
    return context.target ?? context.identity?.platform ?? 'unknown-target';
  }

  async function waiting() {
    const runs = await store.listActiveRuns({});
    return runs.filter((run) => run.executionStatus === 'QUEUED' || run.executionStatus === 'RETRY_WAIT');
  }

  async function nextCandidate({ at = nowIso() } = {}) {
    const nowMsValue = ms(at);
    const candidates = await waiting();
    const eligible = candidates
      .filter((run) => {
        const queue = queueOf(run);
        if (queue.notBefore && ms(queue.notBefore) > nowMsValue) return false; // 退避未到
        if (queue.deadlineAt && ms(queue.deadlineAt) <= nowMsValue) return false; // 已过期
        if (circuitBreaker.isOpen(breakerKeyOf(run), nowMsValue)) return false; // 熔断中
        return true;
      })
      .sort((a, b) => {
        // 顺序固定：优先级降序 -> 入队时间升序 -> runId 升序（保证可复现，不依赖 Map 迭代顺序）
        const pa = Number(queueOf(a).priority ?? 0);
        const pb = Number(queueOf(b).priority ?? 0);
        if (pa !== pb) return pb - pa;
        const ta = ms(queueOf(a).enqueuedAt ?? a.createdAt ?? 0);
        const tb = ms(queueOf(b).enqueuedAt ?? b.createdAt ?? 0);
        if (ta !== tb) return ta - tb;
        return String(a.runId).localeCompare(String(b.runId));
      });

    for (const run of eligible) {
      const lane = laneOf(run);
      const isWrite = isWriteOf(run);
      const limit = laneLimit({ lane, write: isWrite, limits: laneLimits });
      const executing = await store.countActiveInLane(lane, { excludeRunId: run.runId, statuses: LANE_EXECUTING_STATUSES });
      if (executing < limit) return { runId: run.runId, lane, isWrite, limit, executing };
    }
    return null;
  }

  // 准入拒绝 -> 队列拒绝原因的确定性映射。
  // 「排不上队」和「不许做」是两件完全不同的事：前者稍后再试即可，后者重试无用。
  function reasonForRejection(admission) {
    const reasons = admission?.rejectionReasons ?? [];
    if (reasons.some((reason) => /^duplicate task already active/.test(String(reason)))) return 'DUPLICATE_TASK';
    if (reasons.some((reason) => /^(taskSpec|identity)\./.test(String(reason)))) return 'INVALID_SPEC';
    const failureClass = admission?.failureClass ?? null;
    if (failureClass === 'RESOURCE_BUSY') return 'BACKPRESSURE';
    if (failureClass === 'CAPABILITY_DEGRADED') return 'CIRCUIT_OPEN';
    return failureClass ?? 'INVALID_SPEC';
  }

  return {
    async depth() {
      const runs = await waiting();
      const byLane = new Map();
      for (const run of runs) {
        const lane = laneOf(run);
        byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
      }
      return {
        total: runs.length,
        byLane: [...byLane.entries()]
          .map(([lane, count]) => ({ lane, count }))
          .sort((a, b) => a.lane.localeCompare(b.lane)),
      };
    },

    // 入队：依次过截止时间、熔断、限流、背压闸门，最后交给准入。
    // 顺序刻意如此——这些都是「现在不该接活」，不该先写一条 run 再说。
    async enqueue({ spec, registeredCapabilities = null } = {}) {
      const now = nowIso();
      if (spec?.deadlineAt && ms(spec.deadlineAt) <= ms(now)) {
        return { admitted: false, reason: 'DEADLINE_PASSED', failureClass: 'HUMAN_REQUIRED', runId: null };
      }
      const target = spec?.target ?? spec?.identity?.platform ?? 'unknown-target';
      if (circuitBreaker.isOpen(target, ms(now))) {
        return { admitted: false, reason: 'CIRCUIT_OPEN', failureClass: 'CAPABILITY_DEGRADED', runId: null };
      }
      if (!rateLimiter.peek(target, ms(now))) {
        return { admitted: false, reason: 'RATE_LIMITED', failureClass: 'RESOURCE_BUSY', detail: `rate budget exhausted for ${target}`, runId: null };
      }
      const current = await this.depth();
      if (current.total >= maxQueueDepth) {
        return {
          admitted: false, reason: 'BACKPRESSURE', failureClass: 'RESOURCE_BUSY',
          detail: `queue depth ${current.total}/${maxQueueDepth}`, runId: null,
        };
      }
      const lanePreview = laneFor({
        identity: spec?.identity ?? {},
        capability: spec?.capability ?? null,
        target: spec?.target ?? null,
        write: Boolean(spec?.write),
      });
      const laneDepth = current.byLane.find((entry) => entry.lane === lanePreview)?.count ?? 0;
      if (laneDepth >= maxQueueDepthPerLane) {
        return {
          admitted: false, reason: 'BACKPRESSURE', failureClass: 'RESOURCE_BUSY',
          detail: `lane depth ${laneDepth}/${maxQueueDepthPerLane}`, runId: null,
        };
      }

      // 真正要接活时才扣令牌；准入被拒则归还，避免白扣配额。
      if (!rateLimiter.take(target, ms(now))) {
        return { admitted: false, reason: 'RATE_LIMITED', failureClass: 'RESOURCE_BUSY', detail: `rate budget exhausted for ${target}`, runId: null };
      }
      const admission = await admitTask({ store, spec, registeredCapabilities, nowIso: now });
      if (!admission.admitted) {
        rateLimiter.refund(target, ms(now));
        return { ...admission, reason: reasonForRejection(admission) };
      }
      return { ...admission, reason: null };
    },

    async nextCandidate({ at } = {}) {
      return nextCandidate({ at: at ?? nowIso() });
    },

    // 认领：只做一次状态转移（Controller 拥有状态），失败不吞，交给调用方决定退避还是熔断。
    async claim({ at = nowIso() } = {}) {
      const candidate = await nextCandidate({ at });
      if (!candidate) return { claimed: false, reason: 'NO_ELIGIBLE' };
      const context = await controller.beginAttempt(candidate.runId, { stage: 'RUN', write: Boolean(candidate.isWrite) });
      return { claimed: true, runId: candidate.runId, attemptId: context.attemptId, lane: candidate.lane, limit: candidate.limit };
    },

    // 回队列：不重复执行已完成的部分，只把 notBefore 推到退避之后。
    // 注意 failAttempt 已经把执行轴置为 RETRY_WAIT/QUEUED/PAUSED（或终态），这里只补队列元数据。
    async requeue({ runId, failureClass = 'RESOURCE_BUSY', detail = '' } = {}) {
      const context = await controller.getContext(runId);
      const attempts = Number(context?.queue?.attempts ?? 0) + 1;
      const context2 = await controller.failAttempt(runId, { attemptId: context.attemptId, failureClass, detail });
      const notBefore = new Date(ms() + backoffMs(attempts)).toISOString();
      const patched = await store.saveContext(runId, {
        ...context2,
        queue: { ...(context2.queue ?? {}), attempts, notBefore, enqueuedAt: context2.queue?.enqueuedAt ?? context.queue?.enqueuedAt ?? null },
        contextVersion: context2.contextVersion + 1,
      }, context2.contextVersion);
      return { runId, attempts, notBefore, executionStatus: patched.executionStatus };
    },

    async cancel(runId) {
      return controller.cancel(runId);
    },

    // 超时清扫：RUNNING 且已过截止时间的运行，标记为需要人工（不自动重试）。
    // 理由：错过截止时间是业务判断，不是瞬时抖动；盲目重试只会更晚。
    async sweepTimeouts({ at = nowIso() } = {}) {
      const nowMsValue = ms(at);
      const runs = await store.listActiveRuns({});
      const expired = runs.filter((run) => {
        if (run.executionStatus !== 'RUNNING') return false;
        const deadline = queueOf(run).deadlineAt;
        return deadline && ms(deadline) <= nowMsValue;
      });
      const outcomes = [];
      for (const run of expired) {
        const context = await controller.getContext(run.runId);
        const updated = await controller.failAttempt(run.runId, {
          attemptId: context.attemptId,
          failureClass: 'HUMAN_REQUIRED',
          detail: 'queue deadline exceeded',
        });
        outcomes.push({ runId: run.runId, executionStatus: updated.executionStatus, humanGateStatus: updated.humanGateStatus });
      }
      return { scanned: runs.length, expired: outcomes.length, outcomes };
    },

    circuitBreaker,
    rateLimiter,
    mergeFanoutResults,
  };
}
