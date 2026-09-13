-- 005-sop-runtime-context.sql
-- sop-runtime 确定性底座的增量列：复用 001 的 supervisor_* 与 002/003 的 durable_*，不新建平行主表。
-- 只做幂等 ADD COLUMN（全部可空、带默认值），不修改既有列语义，不删数据。
-- 回滚：005-rollback.sql
-- 状态：草案，尚未在任何环境执行；执行前必须在隔离库完成语法/重复执行/回滚验证。

ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS task_id text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS workflow text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS capability text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS step_id text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS lane text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS context_version bigint NOT NULL DEFAULT 0;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS evidence_status text NOT NULL DEFAULT 'NONE';
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS human_gate_status text NOT NULL DEFAULT 'NONE';
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'NOT_REQUESTED';
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS blocker jsonb;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS next_action text;
ALTER TABLE durable_runs ADD COLUMN IF NOT EXISTS retry_used jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE durable_attempts ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE durable_attempts ADD COLUMN IF NOT EXISTS step_id text;
ALTER TABLE durable_attempts ADD COLUMN IF NOT EXISTS failure_class text;
ALTER TABLE durable_attempts ADD COLUMN IF NOT EXISTS result jsonb;

-- 提交账本：保存业务唯一键，供 UNKNOWN 对账回读
ALTER TABLE supervisor_commit_records ADD COLUMN IF NOT EXISTS business_key text;
ALTER TABLE supervisor_commit_records ADD COLUMN IF NOT EXISTS provider_ref text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'durable_runs_evidence_status_check'
  ) THEN
    ALTER TABLE durable_runs ADD CONSTRAINT durable_runs_evidence_status_check
      CHECK (evidence_status IN ('NONE','CANDIDATE','VALIDATED','REJECTED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'durable_runs_human_gate_status_check'
  ) THEN
    ALTER TABLE durable_runs ADD CONSTRAINT durable_runs_human_gate_status_check
      CHECK (human_gate_status IN ('NONE','WAITING_HUMAN','APPROVED','DENIED','EXPIRED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'durable_runs_publication_status_check'
  ) THEN
    ALTER TABLE durable_runs ADD CONSTRAINT durable_runs_publication_status_check
      CHECK (publication_status IN ('NOT_REQUESTED','READY','COMMITTED','VERIFIED','UNKNOWN'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'durable_attempts_failure_class_check'
  ) THEN
    ALTER TABLE durable_attempts ADD CONSTRAINT durable_attempts_failure_class_check
      CHECK (failure_class IS NULL OR failure_class IN (
        'TRANSIENT_EXTERNAL','RESOURCE_BUSY','HUMAN_REQUIRED','CAPABILITY_DEGRADED',
        'EVIDENCE_INVALID','POLICY_DENIED','COMMIT_UNKNOWN','BUG'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_durable_runs_lane_active
  ON durable_runs (lane)
  WHERE execution_status IN ('QUEUED','RUNNING','RETRY_WAIT','PAUSED');

CREATE INDEX IF NOT EXISTS idx_durable_runs_status
  ON durable_runs (execution_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_commit_records_unknown
  ON supervisor_commit_records (commit_key)
  WHERE status = 'UNKNOWN';
