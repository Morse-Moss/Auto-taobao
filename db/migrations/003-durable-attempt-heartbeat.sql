-- 003-durable-attempt-heartbeat.sql
-- 租约存活检测：worker 心跳。恢复时 HELD 且心跳过期 → 判死回收（不认领未知资源）。

ALTER TABLE durable_attempts ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
UPDATE durable_attempts SET last_heartbeat_at = started_at WHERE last_heartbeat_at IS NULL;
