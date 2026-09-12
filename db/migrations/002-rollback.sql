-- 002-rollback.sql：回滚 002-durable-run-tables.sql（幂等）。
DROP TABLE IF EXISTS durable_attempts;
DROP TABLE IF EXISTS durable_runs;
