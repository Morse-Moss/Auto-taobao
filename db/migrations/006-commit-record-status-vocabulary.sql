-- 006：把 supervisor_commit_records 的提交状态约束补齐到运行时词表。
--
-- 背景（真实运行发现，2026-09-14 晚）：
--   001 给 status 列的 CHECK 是 6 个值
--     (NOT_REQUESTED, READY, COMMITTING, COMMITTED, VERIFIED, UNKNOWN)，
--   而运行时 runtime/sop-runtime/side-effect-ledger.mjs 的 COMMIT_STATUS 是
--     (READY, COMMITTING, COMMITTED, VERIFIED, UNKNOWN, FAILED)。
--   两边差一个 FAILED。后果不是「少记一条日志」，而是：
--     handler 确定性失败 → ledger.commit 的 catch 分支写 status='FAILED'
--     → 权威 PG 用 CHECK 拒绝 → 异常从 ledger.commit 抛出 → two-stage-runner 直接退出，
--       连 two-stage-receipt.json 都写不出来（失败路径丢收据）。
--   之所以一直没被发现：内存 store 的 updateCommit 是 Object.assign(patch)，
--   对值域不做任何约束；所有离线测试都用内存 store，照不到这条。
--
-- 语义边界（不改动，只补齐）：
--   FAILED  = 确定**未发生**外部写入的失败，可修正后重试；
--   UNKNOWN = 结果未知，只能对账，禁止盲目重试。
--   这两者的区分是 policy.classifyExternalFailure 存在的理由，不能合并成一个值。
--
-- 幂等：先 DROP IF EXISTS 再 ADD，可重复执行；不触碰任何数据行。
ALTER TABLE supervisor_commit_records
  DROP CONSTRAINT IF EXISTS supervisor_commit_records_status_check;

ALTER TABLE supervisor_commit_records
  ADD CONSTRAINT supervisor_commit_records_status_check
  CHECK (status IN ('NOT_REQUESTED','READY','COMMITTING','COMMITTED','VERIFIED','UNKNOWN','FAILED'));
