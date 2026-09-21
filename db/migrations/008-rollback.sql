-- 008 回滚：把约束还原成 005 的 8 值版本（不含 USAGE_LIMIT_REACHED）。
--
-- 刻意 fail-closed：如果表里已经存在 failure_class='USAGE_LIMIT_REACHED' 的尝试行，
-- ADD CONSTRAINT 会失败。这不是缺陷，而是设计选择——回滚一份词表约束不该顺手丢弃执行记录。
-- 确需回滚时的正确顺序：先人工确认/处置这些行（改判为 POLICY_DENIED 或归档），再执行本文件。
ALTER TABLE durable_attempts
  DROP CONSTRAINT IF EXISTS durable_attempts_failure_class_check;

ALTER TABLE durable_attempts
  ADD CONSTRAINT durable_attempts_failure_class_check
  CHECK (failure_class IS NULL OR failure_class IN (
    'TRANSIENT_EXTERNAL','RESOURCE_BUSY','HUMAN_REQUIRED','CAPABILITY_DEGRADED',
    'EVIDENCE_INVALID','POLICY_DENIED','COMMIT_UNKNOWN','BUG'));
