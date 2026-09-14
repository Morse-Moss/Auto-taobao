// Store 端口：Workflow Controller 是运行状态唯一拥有者，所有持久化都经过这里。
// 实现必须提供：run/attempt 状态、上下文 CAS、lease、lane 计数、提交账本。

export const STORE_PORT = Object.freeze([
  'createRun', 'loadRun', 'listActiveRuns', 'countActiveInLane',
  'saveContext', 'loadContext',
  'createAttempt', 'updateAttempt', 'heartbeat', 'listAttempts',
  'upsertCommit', 'loadCommit', 'listUnknownCommits',
]);

export function assertStore(store) {
  const missing = STORE_PORT.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) throw new Error(`store is missing port methods: ${missing.join(', ')}`);
  return store;
}

export const CAS_CONFLICT = 'CAS_CONFLICT';

// lane 口径（**只有一种**，2026-09-14 修正）：
//  - ACTIVE（含 QUEUED）只用于「队列深度/背压」：回答「这条 lane 上排了多少活」。
//  - 执行槽占用**不再用 run 状态集合**判定，改用 policy.occupiesLane()（RUNNING + lease HELD）。
//    早先的 EXECUTING＝RUNNING/RETRY_WAIT/PAUSED 会把「采集完成等提交」（仍是 RUNNING）和
//    「失败等人工」（PAUSED）当成正在执行，从而把 lane 永久占死、同一 lane 的后续事项再也进不来。
//    这在实际的 FAQ 商品级 fan-out 上表现为整批卡在第一个子项之后（详见 occupiesLane 注释）。
// 注意：准入**不**判定 lane 占用（D7.1）——准入只排队，重复由 idempotencyKey 挡，占用是执行期的事。
export const LANE_ACTIVE_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'RETRY_WAIT', 'PAUSED']);

export class CasConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CasConflictError';
    this.code = CAS_CONFLICT;
    this.details = details;
  }
}
