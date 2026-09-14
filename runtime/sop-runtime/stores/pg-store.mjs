// PostgreSQL Store：复用 durable_runs / durable_attempts / supervisor_commit_records（不新建平行主表）。
// 依赖 005-sop-runtime-context.sql 的增量列；缺列直接抛 REQUIRES_MIGRATION_005，绝不静默降级。
import pg from 'pg';

import { CasConflictError, LANE_ACTIVE_STATUSES } from '../store-port.mjs';

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

// store 端口契约是 camelCase（见 stores/memory-store.mjs 与 store-port.mjs），
// 而 PG 默认返回 snake_case 列名。这里统一归一化——否则会出现「内存 store 测试全绿、
// 换到 PG 上 Controller/Ledger 读到一堆 undefined」的静默错误（故障注入实测踩到过）。
function mapRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    identity: row.identity,
    executionStatus: row.execution_status,
    verifiedCursor: Number(row.verified_cursor ?? 0),
    cursorVersion: Number(row.cursor_version ?? 0),
    targetEnd: row.target_end,
    lane: row.lane ?? null,
    context: row.context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    attemptNo: row.attempt_no,
    leaseOwner: row.lease_owner,
    leaseState: row.lease_state,
    leaseExpiresAt: row.lease_expires_at,
    status: row.status,
    stage: row.stage ?? null,
    stepId: row.step_id ?? null,
    failureClass: row.failure_class ?? null,
    result: row.result ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

function mapCommit(row) {
  if (!row) return null;
  return {
    id: row.id,
    commitKey: row.commit_key,
    runId: row.run_id,
    attemptId: row.attempt_id,
    target: row.target,
    status: row.status,
    artifactDigest: row.artifact_digest,
    businessKey: row.business_key ?? null,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

export async function createPgStore(connectionString, { pool: injected } = {}) {
  const pool = injected ?? new pg.Pool({ connectionString });
  const ownsPool = !injected;
  // 空闲连接被服务端中断（重启、DROP DATABASE 等）时 pg 会在 Pool 上抛 'error'。
  // 没有监听器就会直接终止进程——这里记录而不是静默吞掉，便于诊断，同时不让运行器崩。
  const poolErrors = [];
  if (ownsPool) pool.on('error', (error) => { poolErrors.push(String(error?.message ?? error)); });

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
      return mapRun(rows[0]);
    },

    async loadRun(runId) {
      const { rows } = await pool.query('select * from durable_runs where run_id = $1', [runId]);
      return mapRun(rows[0]);
    },

    async listActiveRuns({ lane = null } = {}) {
      const { rows } = await pool.query(
        `select * from durable_runs
         where execution_status in ('QUEUED','RUNNING','RETRY_WAIT','PAUSED')
           and ($1::text is null or lane = $1)
         order by created_at`,
        [lane],
      );
      return rows.map(mapRun);
    },

    async countActiveInLane(lane, { excludeRunId = null, statuses = LANE_ACTIVE_STATUSES } = {}) {
      // statuses 由调用方决定口径：准入用 ACTIVE（含 QUEUED，准入即占位），
      // 开 attempt 用 EXECUTING（只看真正在跑的）。两种口径不能混用。
      const { rows } = await pool.query(
        `select count(*)::int as n from durable_runs
         where lane = $1 and execution_status = any($3::text[])
           and ($2::uuid is null or run_id <> $2::uuid)`,
        [lane, excludeRunId, statuses],
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
      return mapAttempt(rows[0]);
    },

    async updateAttempt(attemptId, patch) {
      // 端口契约传的是 camelCase（见 store-port / memory-store），这里翻译成列名。
      // 只认 snake_case 会把 leaseState/endedAt/failureClass 静默丢掉——故障注入实测踩到过：
      // 恢复时「被杀 attempt 标记为 FAILED + lease EXPIRED」因此没有落库。
      const columnOf = {
        status: 'status',
        leaseState: 'lease_state',
        leaseOwner: 'lease_owner',
        leaseExpiresAt: 'lease_expires_at',
        endedAt: 'ended_at',
        failureClass: 'failure_class',
        result: 'result',
        stage: 'stage',
        stepId: 'step_id',
        lastHeartbeatAt: 'last_heartbeat_at',
      };
      const entries = Object.entries(patch).filter(([key]) => columnOf[key]);
      if (!entries.length) return store.loadAttempt(attemptId);
      const setSql = entries.map(([key], index) => `${columnOf[key]} = $${index + 2}`).join(', ');
      const values = entries.map(([, value]) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : value));
      const { rows } = await pool.query(
        `update durable_attempts set ${setSql} where attempt_id = $1 returning *`,
        [attemptId, ...values],
      );
      return mapAttempt(rows[0]);
    },

    async loadAttempt(attemptId) {
      const { rows } = await pool.query('select * from durable_attempts where attempt_id = $1', [attemptId]);
      return mapAttempt(rows[0]);
    },

    async heartbeat(attemptId) {
      const { rows } = await pool.query(
        'update durable_attempts set last_heartbeat_at = now() where attempt_id = $1 returning *',
        [attemptId],
      );
      return mapAttempt(rows[0]);
    },

    async listAttempts(runId) {
      const { rows } = await pool.query('select * from durable_attempts where run_id = $1 order by attempt_no', [runId]);
      return rows.map(mapAttempt);
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
        return mapCommit(rows[0]) ?? await store.loadCommit(commitKey);
      }
      const { rows } = await pool.query(
        `insert into supervisor_commit_records (commit_key, run_id, attempt_id, target, status, artifact_digest)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (commit_key) do nothing
         returning *`,
        [commitKey, runId, attemptId, target, status, artifactDigest],
      );
      return mapCommit(rows[0]) ?? await store.loadCommit(commitKey);
    },

    async loadCommit(commitKey) {
      const { rows } = await pool.query('select * from supervisor_commit_records where commit_key = $1', [commitKey]);
      return mapCommit(rows[0]);
    },

    async updateCommit(commitKey, { status, verifiedAt = null }) {
      const { rows } = await pool.query(
        `update supervisor_commit_records set status = $2, verified_at = coalesce($3, verified_at)
         where commit_key = $1 returning *`,
        [commitKey, status, verifiedAt],
      );
      return mapCommit(rows[0]);
    },

    async listUnknownCommits() {
      const { rows } = await pool.query("select * from supervisor_commit_records where status = 'UNKNOWN'");
      return rows.map(mapCommit);
    },

    // 按 run 反查提交记录（缺口 B 的回收安全判定用它区分 READY 与 COMMITTING）。
    async listCommitsByRun(runId) {
      const { rows } = await pool.query(
        'select * from supervisor_commit_records where run_id = $1::uuid order by created_at',
        [runId],
      );
      return rows.map(mapCommit);
    },

    async close() {
      if (ownsPool) await pool.end();
    },

    // 诊断用：连接池侧被记录下来的错误（不中断运行）
    get poolErrors() {
      return [...poolErrors];
    },
  };

  return store;
}
