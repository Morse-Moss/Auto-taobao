// 商品级 fan-out（实施计划：迁移顺序第 2 项 + 阶段 6「FAQ 商品级 fan-out 先做失败隔离，再扩大并发」）。
//
// 设计约束（每一条都对应一个具体的失败模式）：
//  - **失败隔离**：单个子项失败不得让整批停摆，也不得被静默吞掉——
//    每个子项都必须留下明确结果（ok / 失败分类 / 是否可重试）。
//  - **不重复消费**：每个子项有稳定 businessKey；同一父运行 + 同一子项重复派发时，
//    第二次必须被识别为「已派发」而不是再写一次外部效果。
//  - **冲突不静默合并**：两个子项对同一 key 给出不同值时，交人工（复用 queue 的 mergeFanoutResults）。
//  - **并发是显式决定**：默认并发 1（lane 默认值），只有拿到资源容量证据才通过 limits 放宽。
import { mergeFanoutResults } from './task-queue.mjs';
import { laneFor } from './policy.mjs';

export const FANOUT_REJECTION = Object.freeze(['DUPLICATE_ITEM_KEY', 'INVALID_ITEM', 'PARENT_UNKNOWN']);

export class FanoutError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'FanoutError';
    this.code = code;
    this.details = details;
  }
}

// 子项 businessKey：父运行 + 能力 + 子项键的确定性拼装。
// 用父运行参与拼接，是为了让「同一批里的同一商品」与「另一批里的同一商品」在提交账本上是两条记录——
// 否则跨周重跑会把它当成已提交而静默跳过。
export function buildItemBusinessKey({ parentRunId, capability, itemKey }) {
  return `${parentRunId ?? 'no-parent'}:${capability}:${itemKey}`;
}

export function buildFanoutSpecs({
  parent,
  items = [],
  capability,
  identity,
  target = null,
  keyOf = (item) => item?.id ?? item?.key ?? null,
  scope = null,
  write = false,
  priority = 0,
  sideEffects = [],
  targetEnd = 1,
} = {}) {
  if (!parent?.runId) throw new FanoutError('a parent run with runId is required', 'PARENT_UNKNOWN');
  if (!capability) throw new FanoutError('capability is required', 'INVALID_ITEM');
  if (!Array.isArray(items) || items.length === 0) throw new FanoutError('items must be a non-empty array', 'INVALID_ITEM');

  const seen = new Set();
  const specs = [];
  for (const [index, item] of items.entries()) {
    const itemKey = keyOf(item);
    if (itemKey === null || itemKey === undefined || String(itemKey) === '') {
      throw new FanoutError(`item at index ${index} has no stable key`, 'INVALID_ITEM', { index, item });
    }
    const key = String(itemKey);
    if (seen.has(key)) {
      throw new FanoutError(`duplicate item key ${key}; fan-out keys must be unique or the same product will be written twice`, 'DUPLICATE_ITEM_KEY', { key, index });
    }
    seen.add(key);
    specs.push({
      taskId: `${parent.taskId ?? parent.runId}::${capability}::${key}`,
      workflow: parent.workflow ?? capability,
      capability,
      identity,
      target,
      scope: scope ?? key,
      parentRunId: parent.runId,
      itemKey: key,
      item,
      personIndex: index,
      businessKey: buildItemBusinessKey({ parentRunId: parent.runId, capability, itemKey: key }),
      write,
      priority,
      sideEffects,
      targetEnd,
      lane: laneFor({ identity, capability, target, write }),
    });
  }
  return specs;
}

// 派发：逐个准入。单个子项失败只记录，不抛出——这是「失败隔离」的落点。
export async function dispatchFanout({ queue, specs = [], registeredCapabilities = null } = {}) {
  if (!queue) throw new FanoutError('queue is required', 'INVALID_ITEM');
  const outcomes = [];
  for (const spec of specs) {
    const admission = await queue.enqueue({ spec, registeredCapabilities });
    outcomes.push({
      itemKey: spec.itemKey,
      businessKey: spec.businessKey,
      dispatched: Boolean(admission.admitted),
      runId: admission.runId ?? null,
      reason: admission.reason ?? null,
      failureClass: admission.failureClass ?? null,
      // 背压/限流是「稍后再试」，不是「这个子项坏了」。区分它们，
      // 否则调用方会把容量问题误判成数据问题，去改数据。
      retryable: ['BACKPRESSURE', 'RATE_LIMITED', 'CIRCUIT_OPEN'].includes(admission.reason),
    });
  }
  const dispatched = outcomes.filter((outcome) => outcome.dispatched);
  return {
    total: specs.length,
    dispatched: dispatched.length,
    failed: outcomes.length - dispatched.length,
    retryableFailures: outcomes.filter((outcome) => !outcome.dispatched && outcome.retryable).length,
    outcomes,
    // 只要有子项没派出去，整批就不是完整的一批；调用方不得把它当成成功。
    complete: dispatched.length === specs.length,
  };
}

// 收集：把子项结果合并成父级结论。冲突交人工，失败单列，不阻塞其余结果。
export function collectFanout({ specs = [], outcomes = [] } = {}) {
  const byKey = new Map(specs.map((spec) => [spec.itemKey, spec]));
  const results = outcomes.map((outcome) => {
    const spec = byKey.get(outcome.itemKey) ?? null;
    return {
      key: outcome.itemKey,
      ok: outcome.ok !== false,
      value: outcome.value ?? null,
      runId: outcome.runId ?? spec?.businessKey ?? null,
      error: outcome.error ?? null,
      businessKey: spec?.businessKey ?? null,
    };
  });
  const merged = mergeFanoutResults(results, { keyOf: (item) => item.key });
  const missing = specs.filter((spec) => !outcomes.some((outcome) => outcome.itemKey === spec.itemKey)).map((spec) => spec.itemKey);
  return {
    ...merged,
    missingItems: missing,
    // 有缺失子项时父级不能结算为完成：宁可交人工，也不能把「少了几件」当成「全部成功」。
    complete: missing.length === 0,
    requiresHuman: merged.requiresHuman || missing.length > 0,
  };
}

// 重复消费守卫：同一批内 businessKey 必须唯一。
// 在提交账本层，businessKey 就是幂等键；重复即意味着会写出重复的外部效果。
export function assertNoDuplicateBusinessKeys(specs = []) {
  const seen = new Map();
  const duplicates = [];
  for (const spec of specs) {
    if (seen.has(spec.businessKey)) duplicates.push({ businessKey: spec.businessKey, itemKeys: [seen.get(spec.businessKey), spec.itemKey] });
    else seen.set(spec.businessKey, spec.itemKey);
  }
  if (duplicates.length) {
    throw new FanoutError('duplicate business keys would produce duplicate external effects', 'DUPLICATE_ITEM_KEY', { duplicates });
  }
  return true;
}

// 并发上限：默认 1，且写操作恒为 1。fan-out 的并发放大必须建立在容量证据上，不是想开就开。
export function fanoutLaneLimits({ lanes = [], evidence = null } = {}) {
  if (!evidence) return {};
  // evidence 必须显式声明每个 lane 的容量；没有证据的 lane 不放大。
  const limits = {};
  for (const lane of lanes) {
    const capacity = Number(evidence[lane]);
    if (Number.isFinite(capacity) && capacity > 1) limits[lane] = Math.floor(capacity);
  }
  return limits;
}
