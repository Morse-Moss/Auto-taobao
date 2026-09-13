-- 005-rollback.sql
-- 只回滚 005 新增的列、约束和索引；不删表、不删库、不 DROP SCHEMA CASCADE。
-- 状态：草案，尚未执行。

ALTER TABLE durable_runs DROP CONSTRAINT IF EXISTS durable_runs_evidence_status_check;
ALTER TABLE durable_runs DROP CONSTRAINT IF EXISTS durable_runs_human_gate_status_check;
ALTER TABLE durable_runs DROP CONSTRAINT IF EXISTS durable_runs_publication_status_check;
ALTER TABLE durable_attempts DROP CONSTRAINT IF EXISTS durable_attempts_failure_class_check;

DROP INDEX IF EXISTS idx_durable_runs_lane_active;
DROP INDEX IF EXISTS idx_durable_runs_status;
DROP INDEX IF EXISTS idx_commit_records_unknown;

ALTER TABLE durable_runs DROP COLUMN IF EXISTS task_id;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS workflow;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS capability;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS stage;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS step_id;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS lane;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS context;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS context_version;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS evidence_status;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS human_gate_status;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS publication_status;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS blocker;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS next_action;
ALTER TABLE durable_runs DROP COLUMN IF EXISTS retry_used;

ALTER TABLE durable_attempts DROP COLUMN IF EXISTS stage;
ALTER TABLE durable_attempts DROP COLUMN IF EXISTS step_id;
ALTER TABLE durable_attempts DROP COLUMN IF EXISTS failure_class;
ALTER TABLE durable_attempts DROP COLUMN IF EXISTS result;

ALTER TABLE supervisor_commit_records DROP COLUMN IF EXISTS business_key;
ALTER TABLE supervisor_commit_records DROP COLUMN IF EXISTS provider_ref;
