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

// lane 计数的两种口径，必须显式区分，不能混用：
//  - ACTIVE：含 QUEUED。用于「任务准入」——准入即占位，同一 lane 不重复准入同账号/profile/写目标。
//  - EXECUTING：只含真正占用执行槽的状态。用于「开 attempt」——队列里排队的 run 不算占资源，
//    否则同一 lane 连排队都排不进去。
export const LANE_ACTIVE_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'RETRY_WAIT', 'PAUSED']);
export const LANE_EXECUTING_STATUSES = Object.freeze(['RUNNING', 'RETRY_WAIT', 'PAUSED']);

export class CasConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CasConflictError';
    this.code = CAS_CONFLICT;
    this.details = details;
  }
}
