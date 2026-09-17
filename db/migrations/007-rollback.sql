-- 007 回滚：删除日报链审计表。
--
-- 刻意 fail-closed（同 006）：表里已经有审计行时**拒绝删除**并报错。
-- 回滚一份「纯新增」的表却把这些行一起丢掉，是把「撤销一次 DDL」变成了「销毁审计证据」，
-- 而审计证据的价值恰恰在于它事后才被需要。
-- 确需回滚时的正确顺序：先把行导出归档（`\copy daily_report_push_audit to ...`），
-- 人工确认之后清空表，再执行本文件。
--
-- 幂等：表不存在时什么也不做，可重复执行。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'daily_report_push_audit'
  ) THEN
    IF EXISTS (SELECT 1 FROM daily_report_push_audit LIMIT 1) THEN
      RAISE EXCEPTION
        '007-rollback refused: daily_report_push_audit 仍有审计行。'
        '请先导出归档并清空表，再执行本回滚 —— 回滚 DDL 不该顺手销毁审计证据。';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS daily_report_push_audit;
