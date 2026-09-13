// PostgreSQL Store：复用 durable_runs / durable_attempts / supervisor_commit_records（不新建平行主表）。
// 依赖 005-sop-runtime-context.sql 的增量列；缺列直接抛 REQUIRES_MIGRATION_005，绝不静默降级。
import pg from 'pg';

import { CasConflictError } from '../store-port.mjs';

const REQUIRED_RUN_COLUMNS = [
  'task_id', 'workflow', 'capability', 'stage', 'step_id', 'lane',
  'context', 'context_version', 'evidence_status', 'human_gate_status',
  'publication_status', 'blocker', 'next_action', 'retry_used',
];
const REQUIRED_ATTEMPT_COLUMNS = ['stage', 'step_id', 'failure_class', 'result'];

export class RequiresMigrationError extends Error {
  constructor(missing) {
    super(`durable tables are missing additive columns from 005: ${missing.join(', ')}`);
    this.name = 'RequiresMigrationError';
    this.code = 'REQUIRES_MIGRATION_005';
    this.missing = missing;
  }
}

async function columnsOf(pool, table) {
  const { rows } = await pool.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

export async function createPgStore(connectionString, { pool: injected } = {}) {
  const pool = injected ?? new pg.Pool({ connectionString });
  const ownsPool = !injected;

  const runCols = await columnsOf(pool, 'durable_runs');
  const attemptCols = await columnsOf(pool, 'durable_attempts');
  const commitCols = await columnsOf(pool, 'supervisor_commit_records');
  const missing = [
    ...REQUIRED_RUN_COLUMNS.filter((c) => !runCols.has(c)).map((c) => `durable_runs.${c}`),
    ...REQUIRED_ATTEMPT_COLUMNS.filter((c) => !attemptCols.has(c)).map((c) => `durable_attempts.${c}`),
  ];
  if (missing.length) {
    if (ownsPool) await pool.end();
    throw new RequiresMigrationError(missing);
  }

  const store = {
    async createRun({ runId, identity, context, targetEnd = 0, lane = null }) {
      const { rows } = await pool.query(
        `insert into durable_runs
           (run_id, identity, execution_status, verified_cursor, cursor_version, target_end,
            task_id, workflow, capability, stage, step_id, lane, context, context_version,
            evidence_status, human_gate_status, publication_status, blocker, next_action, retry_used)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         on conflict (run_id) do nothing
         returning *`,
        [
          runId, identity, context.executionStatus, Number(context.verifiedCursor?.end ?? 0),
          Number(context.verifiedCursor?.version ?? 0), targetEnd,
          context.taskId, context.workflow, context.capability, context.stage, context.stepId, lane,
          context, context.contextVersion,
          context.evidenceStatus, context.humanGateStatus, context.publicationStatus,
          context.blocker ?? null, context.nextAction, context.retryUsed ?? {},
        ],
      );
      return rows[0] ?? null;
    },

    async loadRun(runId) {
      const { rows } = await pool.query('select * from durable_runs where run_id = $1', [runId]);
      return rows[0] ?? null;
    },

    async listActiveRuns({ lane = null } = {}) {
      const { rows } = await pool.query(
        `select * from durable_runs
         where execution_status in ('QUEUED','RUNNING','RETRY_WAIT','PAUSED')
           and ($1::text is null or lane = $1)
         order by created_at`,
        [lane],
      );
      return rows;
    },

    async countActiveInLane(lane) {
      const { rows } = await pool.query(
        `select count(*)::int as n from durable_runs
         where lane = $1 and execution_status in ('QUEUED','RUNNING','RETRY_WAIT','PAUSED')`,
        [lane],
      );
      return rows[0].n;
    },

    async loadContext(runId) {
      const { rows } = await pool.query('select context from durable_runs where run_id = $1', [runId]);
      return rows[0]?.context ?? null;
    },

    async saveContext(runId, context, expectedVersion) {
      const { rows } = await pool.query(
        `update durable_runs set
           context = $2, context_version = $3, execution_status = $4,
           evidence_status = $5, human_gate_status = $6, publication_status = $7,
           stage = $8, step_id = $9, blocker = $10, next_action = $11, retry_used = $12,
           verified_cursor = $13, cursor_version = $14, updated_at = now()
         where run_id = $1 and context_version = $15
         returning context`,
        [
          runId, context, context.contextVersion, context.executionStatus,
          context.evidenceStatus, context.humanGateStatus, context.publicationStatus,
          context.stage, context.stepId, context.blocker ?? null, context.nextAction, context.retryUsed ?? {},
          Number(context.verifiedCursor?.end ?? 0), Number(context.verifiedCursor?.version ?? 0),
          expectedVersion,
        ],
      );
      if (!rows[0]) {
        const current = await pool.query('select context_version from durable_runs where run_id = $1', [runId]);
        throw new CasConflictError(`context CAS conflict for run ${runId}`, {
          expected: expectedVersion,
          actual: current.rows[0]?.context_version ?? null,
        });
      }
      return rows[0].context;
    },

    async createAttempt({ attemptId, runId, attemptNo, leaseOwner = null, leaseState = 'WAITING', leaseExpiresAt = null, stage = null, stepId = null }) {
      const { rows } = await pool.query(
        `insert into durable_attempts
           (attempt_id, run_id, attempt_no, lease_owner, lease_state, lease_expires_at, status, stage, step_id, last_heartbeat_at)
         values ($1,$2,$3,$4,$5,$6,'RUNNING',$7,$8, now())
         on conflict (attempt_id) do nothing
         returning *`,
        [attemptId, runId, attemptNo, leaseOwner, leaseState, leaseExpiresAt, stage, stepId],
      );
      return rows[0] ?? null;
    },

    async updateAttempt(attemptId, patch) {
      const allowed = ['status', 'lease_state', 'lease_owner', 'lease_expires_at', 'ended_at', 'failure_class', 'result', 'stage', 'step_id'];
      const keys = Object.keys(patch).filter((key) => allowed.includes(key));
      if (!keys.length) return store.loadAttempt(attemptId);
      const setSql = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
      const values = keys.map((key) => (typeof patch[key] === 'object' && patch[key] !== null ? JSON.stringify(patch[key]) : patch[key]));
      const { rows } = await pool.query(
        `update durable_attempts set ${setSql} where attempt_id = $1 returning *`,
        [attemptId, ...values],
      );
      return rows[0] ?? null;
    },

    async loadAttempt(attemptId) {
      const { rows } = await pool.query('select * from durable_attempts where attempt_id = $1', [attemptId]);
      return rows[0] ?? null;
    },

    async heartbeat(attemptId) {
      const { rows } = await pool.query(
        'update durable_attempts set last_heartbeat_at = now() where attempt_id = $1 returning *',
        [attemptId],
      );
      return rows[0] ?? null;
    },

    async listAttempts(runId) {
      const { rows } = await pool.query('select * from durable_attempts where run_id = $1 order by attempt_no', [runId]);
      return rows;
    },

    // 提交账本复用 supervisor_commit_records：commit_key 唯一即幂等键
    async upsertCommit({ commitKey, runId, attemptId, target, status = 'READY', artifactDigest = null, businessKey = null }) {
      // business_key 由 005 提供；缺失时降级为只登记幂等键，不改变提交语义。
      if (commitCols.has('business_key')) {
        const { rows } = await pool.query(
          `insert into supervisor_commit_records (commit_key, run_id, attempt_id, target, status, artifact_digest, business_key)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (commit_key) do nothing
           returning *`,
          [commitKey, runId, attemptId, target, status, artifactDigest, businessKey],
        );
        return rows[0] ?? await store.loadCommit(commitKey);
      }
      const { rows } = await pool.query(
        `insert into supervisor_commit_records (commit_key, run_id, attempt_id, target, status, artifact_digest)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (commit_key) do nothing
         returning *`,
        [commitKey, runId, attemptId, target, status, artifactDigest],
      );
      return rows[0] ?? await store.loadCommit(commitKey);
    },

    async loadCommit(commitKey) {
      const { rows } = await pool.query('select * from supervisor_commit_records where commit_key = $1', [commitKey]);
      return rows[0] ?? null;
    },

    async updateCommit(commitKey, { status, verifiedAt = null }) {
      const { rows } = await pool.query(
        `update supervisor_commit_records set status = $2, verified_at = coalesce($3, verified_at)
         where commit_key = $1 returning *`,
        [commitKey, status, verifiedAt],
      );
      return rows[0] ?? null;
    },

    async listUnknownCommits() {
      const { rows } = await pool.query("select * from supervisor_commit_records where status = 'UNKNOWN'");
      return rows;
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };

  return store;
}
