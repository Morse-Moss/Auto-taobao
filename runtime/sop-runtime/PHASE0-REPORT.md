# sop-runtime P0 阶段报告

日期：2026-09-14
范围：确定性运行底座首轮落地（Spec 阶段 1/2/3 的代码基础）
状态：代码已实现并通过单测；数据库迁移**未执行**（阻塞见第 5 节）
报告位置：runtime/sop-runtime/PHASE0-REPORT.md（不写入 docs/architecture/，那里只存架构决策与契约）

## 1. 修改/新增文件

| 文件 | 职责 |
| --- | --- |
| runtime/sop-runtime/context-schema.mjs | sop-context-v1 契约、五条状态轴、CAS 推进、摘要 |
| runtime/sop-runtime/policy.mjs | 风险分级、审批要求、并发 lane、失败分类到动作的确定性映射 |
| runtime/sop-runtime/task-admission.mjs | 任务准入：身份/能力/配额校验，创建 run_id |
| runtime/sop-runtime/workflow-controller.mjs | 运行状态唯一拥有者：begin/complete/fail、人工闸门、游标 CAS、恢复 |
| runtime/sop-runtime/validator.mjs | 7 个可组合验证器（身份/范围/结构/完整性/摘要/关系/发布回读） |
| runtime/sop-runtime/side-effect-ledger.mjs | READY→COMMITTING→COMMITTED→VERIFIED/UNKNOWN；UNKNOWN 仅对账 |
| runtime/sop-runtime/evidence-store.mjs | 工件落盘 + manifest + SHA-256 回读复验 |
| runtime/sop-runtime/worker-adapter.mjs | 能力契约（checkSession…release）+ 确定性 Worker |
| runtime/sop-runtime/store-port.mjs | Store 端口定义与 CAS 冲突错误 |
| runtime/sop-runtime/stores/memory-store.mjs | 内存实现（仅供单测，不具跨进程恢复能力） |
| runtime/sop-runtime/stores/pg-store.mjs | PostgreSQL 实现，复用 durable_runs / durable_attempts / supervisor_commit_records |
| runtime/sop-runtime/*.test.mjs | 27 项测试 |
| db/migrations/005-sop-runtime-context.sql | 增量列/约束/索引（草案，未 apply） |
| db/migrations/005-rollback.sql | 只回滚 005 新增对象（草案，未 apply） |
| runtime/probe-db-state.mjs | 只读核验迁移与表状态 |
| runtime/verify-migration-004-isolated.mjs | 004 隔离库验证脚本（当前因权限跑不通） |

未修改：任何业务 Skill、业务表数据、Feishu、浏览器、Provider 配置。

## 2. 已验证事实

- 数据库连接为 `127.0.0.1:5432/xws_automation`，PostgreSQL 17.10，角色 `xws_agent`（createdb=false，非 superuser）。
- 001 / 002 / 003 均已 apply：`supervisor_proposals`、`supervisor_action_intents`、`supervisor_approvals`、`supervisor_commit_records`、`supervisor_experience`、`durable_runs`、`durable_attempts` 全部存在，`last_heartbeat_at` 已在位。
- `durable_runs` / `durable_attempts` 当前均为 0 行（绿场）。
- `architecture` schema 不存在 → 004 未 apply。
- `createPgStore()` 在当前库上按预期抛 `REQUIRES_MIGRATION_005`（列出缺失列），不静默降级。

## 3. 测试结果

```
node --test runtime/sop-runtime/context-schema.test.mjs            # pass 9  fail 0
node --test runtime/sop-runtime/workflow-controller.test.mjs       # pass 10 fail 0
node --test runtime/sop-runtime/sop-runtime-vertical-slice.test.mjs# pass 8  fail 0
```

覆盖的关键不变量：

- 同一 businessKey 重复提交只产生 1 次业务副作用；重复 commit 被跳过。
- commit-before-response（写后超时）进 UNKNOWN，盲目重试被拒绝，对账回读确认后才 VERIFIED。
- 无 readBack 的 UNKNOWN 对账判定为 REQUIRES_HUMAN，不自动判成功。
- worker 被杀（attempt 仍 RUNNING、lease 已过期）后从权威状态恢复，回收该 attempt，后续分片范围接续已验证游标（11-20），不重复已确认提交。
- EVIDENCE_INVALID 把证据置为 REJECTED 并阻止游标推进。
- TRANSIENT_EXTERNAL 预算内 RETRY_WAIT、耗尽进 FAILED；HUMAN_REQUIRED 进 PAUSED+WAITING_HUMAN 且禁止 beginAttempt。
- 高风险副作用（feishu_write / account_login）准入后必须经人工闸门。
- 同一 lane 并发准入第二条被拒，失败分类 RESOURCE_BUSY。

实现过程中修掉的自身缺陷：

1. `runValidators` 同步展开 async 验证器返回的 Promise，导致坏证据被判为通过（已改为异步聚合）。
2. evidence-store 只写 manifest 不落盘工件，导致无法回读复验摘要（已落盘）。
3. memory-store 缺 `updateCommit` 端口。
4. 提交记录在内存实现与 PG 实现间命名不一致（commitKey / commit_key），已加归一化。

## 4. 迁移状态

| 迁移 | 状态 | 说明 |
| --- | --- | --- |
| 001 / 002 / 003 | APPLIED（核验） | 表与列均存在 |
| 004 | NOT APPLIED | 文件已存在；隔离库验证**未做**（权限不足） |
| 005 | 草案，NOT APPLIED | 纯增量：ADD COLUMN（可空/带默认）+ 约束 + 索引，不删数据；rollback 只删本轮对象 |

005 只新增列，不新建 run/proposal/commit/experience/evidence 主表，符合"不新增平行主表"约束。

## 5. 剩余风险与阻塞

- **阻塞 B1（迁移验证）**：`xws_agent` 无 CREATEDB 权限，无法创建隔离库，004/005 的"语法 + 重复执行 + rollback"三件套验证做不了。需要：授 CREATEDB，或提供一个独立 PG endpoint/库。在此解决前不对任何环境 apply 004/005。
- **阻塞 B2（目标环境不明）**：交接文档写"Portretag PostgreSQL"，但当前配置指向本机 127.0.0.1:5432/xws_automation。两者是否同一环境需用户确认，未确认前不 apply。
- 风险 R1：005 未 apply 前，sop-runtime 只能跑在 memory-store 上，**不具备跨进程恢复能力**，不得声称已满足"worker 被杀可恢复"的生产验收。
- 风险 R2：真实故障注入（杀进程、断浏览器、partial artifact）尚未在真实 XWS/Feishu 环境执行，当前只证明到内存 store 与本地工件层。
- 风险 R3：Side Effect Ledger 的 UNKNOWN 对账依赖各目标系统提供可回读的业务唯一键；Feishu/PG 目标需逐个定义 readBack。

## 6. 下一阶段依赖

1. 解除 B1/B2：确认目标库并拿到隔离库能力 → 完成 004、005 的隔离验证 → 申请 apply。
2. 005 apply 后，用 pg-store 重跑垂直切片，做**真实跨进程故障注入**（kill worker、断网、partial artifact）。
3. 阶段 3：Skill manifest / Registry / Loader（P0），把现有 9 个业务 Skill 纳入能力目录与版本校验。
4. 首批流程迁移第 1 条：XWS 单分片（采集→验证→EvidenceManifest→幂等提交→恢复），保留迁移前后业务验收回执。
