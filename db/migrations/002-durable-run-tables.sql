-- 002-durable-run-tables.sql
-- S1 确定性耐久闭环：Run/Attempt/Lease/verified cursor（SUPERVISOR-AGENT-DESIGN.md 第 7 节）。
-- 纯新增表，幂等；提交记录复用 001 的 supervisor_commit_records。
-- 回滚：002-rollback.sql

CREATE TABLE IF NOT EXISTS durable_runs (
  run_id          uuid PRIMARY KEY,
  identity        jsonb NOT NULL,                -- tenant/store/platform/account/contract 身份
  execution_status text NOT NULL DEFAULT 'QUEUED'
                  CHECK (execution_status IN ('QUEUED','RUNNING','RETRY_WAIT','PAUSED','SUCCEEDED','FAILED')),
  verified_cursor integer NOT NULL DEFAULT 0,    -- 最后已验证且已提交的页
  cursor_version  bigint NOT NULL DEFAULT 0,     -- CAS 版本
  target_end      integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS durable_attempts (
  attempt_id      text PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES durable_runs(run_id),
  attempt_no      integer NOT NULL,
  lease_owner     text,
  lease_state     text NOT NULL DEFAULT 'WAITING'
                  CHECK (lease_state IN ('WAITING','HELD','EXPIRED','RELEASED')),
  lease_expires_at timestamptz,
  status          text NOT NULL DEFAULT 'RUNNING',
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_durable_attempts_run ON durable_attempts(run_id, attempt_no DESC);
