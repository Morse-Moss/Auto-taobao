-- 008：把 durable_attempts 的失败分类约束补齐到运行时词表（新增 USAGE_LIMIT_REACHED）。
--
-- 背景（2026-09-21）：
--   runtime/sop-runtime/context-schema.mjs 的 FAILURE_CLASS 新增一类 USAGE_LIMIT_REACHED ——
--   灰豚（该账号是免费档，每天 10 次）配额用尽时，平台按套餐拒绝这次查询，这类失败既不是
--   代码缺陷（BUG），也不该被说成「配置或授权不对」（POLICY_DENIED）。
--   而 005 给 durable_attempts.failure_class 的 CHECK 只认旧的 8 个值。
--
--   后果与 006 同构，不是「少记一条日志」而是：
--     handler 抛确定性失败 → 运行时把 failure_class='USAGE_LIMIT_REACHED' 写进权威 PG
--     → CHECK 拒绝 → 异常从写入点抛出 → 失败路径连收据都落不下来。
--   之所以离线照不到：内存 store 对值域不做任何约束，所有离线测试都用内存 store。
--
-- 语义边界（不改动，只补齐）：
--   USAGE_LIMIT_REACHED 与 POLICY_DENIED 的**动作**相同（FAIL、当天收工、不自动重试），
--   分列一类的唯一理由是**告警措辞**：「配置或授权不对」会把运营指去查配置，而这里
--   该做的是等额度重置或升级套餐。依据见 runtime/sop-runtime/round-notify-policy.mjs
--   与 docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md 第 4 节。
--
-- 幂等：先 DROP IF EXISTS 再 ADD，可重复执行；不触碰任何数据行。
ALTER TABLE durable_attempts
  DROP CONSTRAINT IF EXISTS durable_attempts_failure_class_check;

ALTER TABLE durable_attempts
  ADD CONSTRAINT durable_attempts_failure_class_check
  CHECK (failure_class IS NULL OR failure_class IN (
    'TRANSIENT_EXTERNAL','RESOURCE_BUSY','HUMAN_REQUIRED','CAPABILITY_DEGRADED',
    'EVIDENCE_INVALID','POLICY_DENIED','USAGE_LIMIT_REACHED','COMMIT_UNKNOWN','BUG'));
