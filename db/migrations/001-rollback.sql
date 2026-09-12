-- 001-rollback.sql：回滚 001-supervisor-tables.sql（幂等）。
DROP TABLE IF EXISTS supervisor_experience;
DROP TABLE IF EXISTS supervisor_commit_records;
DROP TABLE IF EXISTS supervisor_approvals;
DROP TABLE IF EXISTS supervisor_action_intents;
DROP TABLE IF EXISTS supervisor_proposals;
