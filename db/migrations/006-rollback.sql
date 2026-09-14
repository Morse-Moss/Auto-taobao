-- 006 回滚：把约束还原成 001 的 6 值版本（不含 FAILED）。
--
-- 刻意 fail-closed：如果表里已经存在 status='FAILED' 的行，ADD CONSTRAINT 会失败。
-- 这不是缺陷，而是设计选择——回滚一份状态约束不该顺手丢弃审计行。
-- 确需回滚时的正确顺序：先人工确认/处置这些 FAILED 行（改判为 UNKNOWN 或归档），再执行本文件。
ALTER TABLE supervisor_commit_records
  DROP CONSTRAINT IF EXISTS supervisor_commit_records_status_check;

ALTER TABLE supervisor_commit_records
  ADD CONSTRAINT supervisor_commit_records_status_check
  CHECK (status IN ('NOT_REQUESTED','READY','COMMITTING','COMMITTED','VERIFIED','UNKNOWN'));
