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

export class CasConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CasConflictError';
    this.code = CAS_CONFLICT;
    this.details = details;
  }
}
