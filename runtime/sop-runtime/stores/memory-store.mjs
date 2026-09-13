// 内存 Store：用于单元测试与本地 dry-run。不具跨进程恢复能力，不得用于生产。
import { CasConflictError } from '../store-port.mjs';

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function createMemoryStore() {
  const runs = new Map();     // runId -> { runId, identity, executionStatus, verifiedCursor, cursorVersion, targetEnd, context, lane, createdAt, updatedAt }
  const attempts = new Map(); // attemptId -> attempt
  const commits = new Map();  // commitKey -> commitRecord

  const activeStatuses = new Set(['QUEUED', 'RUNNING', 'RETRY_WAIT', 'PAUSED']);

  return {
    async createRun({ runId, identity, context, targetEnd = 0, lane = null }) {
      if (runs.has(runId)) throw new Error(`run already exists: ${runId}`);
      const now = new Date().toISOString();
      const row = {
        runId,
        identity: clone(identity) ?? {},
        executionStatus: context.executionStatus ?? 'QUEUED',
        verifiedCursor: Number(context.verifiedCursor?.end ?? 0),
        cursorVersion: Number(context.verifiedCursor?.version ?? 0),
        targetEnd,
        lane,
        context: clone(context),
        createdAt: now,
        updatedAt: now,
      };
      runs.set(runId, row);
      return clone(row);
    },

    async loadRun(runId) {
      const row = runs.get(runId);
      return row ? clone(row) : null;
    },

    async listActiveRuns({ lane = null } = {}) {
      return [...runs.values()]
        .filter((row) => activeStatuses.has(row.executionStatus))
        .filter((row) => (lane ? row.lane === lane : true))
        .map(clone);
    },

    async countActiveInLane(lane) {
      return [...runs.values()].filter((row) => row.lane === lane && activeStatuses.has(row.executionStatus)).length;
    },

    async loadContext(runId) {
      const row = runs.get(runId);
      return row ? clone(row.context) : null;
    },

    async saveContext(runId, context, expectedVersion) {
      const row = runs.get(runId);
      if (!row) throw new Error(`run not found: ${runId}`);
      if (expectedVersion !== undefined && Number(row.context.contextVersion) !== Number(expectedVersion)) {
        throw new CasConflictError(`context CAS conflict for run ${runId}`, {
          expected: expectedVersion,
          actual: row.context.contextVersion,
        });
      }
      row.context = clone(context);
      row.executionStatus = context.executionStatus;
      row.verifiedCursor = Number(context.verifiedCursor?.end ?? row.verifiedCursor);
      row.cursorVersion = Number(context.verifiedCursor?.version ?? row.cursorVersion);
      row.updatedAt = new Date().toISOString();
      return clone(row.context);
    },

    async createAttempt({ attemptId, runId, attemptNo, leaseOwner = null, leaseState = 'WAITING', leaseExpiresAt = null, stage = null, stepId = null }) {
      if (attempts.has(attemptId)) throw new Error(`attempt already exists: ${attemptId}`);
      const attempt = {
        attemptId, runId, attemptNo, leaseOwner, leaseState, leaseExpiresAt,
        stage, stepId, status: 'RUNNING', failureClass: null, result: null,
        startedAt: new Date().toISOString(), endedAt: null, lastHeartbeatAt: new Date().toISOString(),
      };
      attempts.set(attemptId, attempt);
      return clone(attempt);
    },

    async updateAttempt(attemptId, patch) {
      const attempt = attempts.get(attemptId);
      if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
      Object.assign(attempt, patch, { updatedAt: new Date().toISOString() });
      return clone(attempt);
    },

    async heartbeat(attemptId) {
      return this.updateAttempt(attemptId, { lastHeartbeatAt: new Date().toISOString() });
    },

    async listAttempts(runId) {
      return [...attempts.values()].filter((a) => a.runId === runId).map(clone);
    },

    async upsertCommit(record) {
      const existing = commits.get(record.commitKey);
      if (existing) return clone(existing); // 幂等：同一 commitKey 不重复登记
      const row = { status: 'READY', createdAt: new Date().toISOString(), ...clone(record) };
      commits.set(row.commitKey, row);
      return clone(row);
    },

    async loadCommit(commitKey) {
      const row = commits.get(commitKey);
      return row ? clone(row) : null;
    },

    async updateCommit(commitKey, patch) {
      const row = commits.get(commitKey);
      if (!row) throw new Error(`commit not found: ${commitKey}`);
      Object.assign(row, patch);
      return clone(row);
    },

    async listUnknownCommits() {
      return [...commits.values()].filter((row) => row.status === 'UNKNOWN').map(clone);
    },

    // 测试辅助：故障注入用
    _state: { runs, attempts, commits },
  };
}
