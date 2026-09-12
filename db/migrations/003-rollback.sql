-- 003-rollback.sql
ALTER TABLE durable_attempts DROP COLUMN IF EXISTS last_heartbeat_at;
