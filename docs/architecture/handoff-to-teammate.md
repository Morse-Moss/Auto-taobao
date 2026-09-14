# 同事交接说明：Agent SOP Runtime 架构落地

## 任务目标

在 D:/Retire/sycm-automation 内完成 Agent SOP Runtime 的第一阶段落地：把本轮架构分析转成可审阅、可回滚、可查询的项目资产，并为后续 Context、Checkpoint、幂等、Skill Registry 和故障注入实现固定边界。

本交接包不等于生产多 Agent 系统。当前 agent-runtime/temporal/ 仍是 fake-adapter POC，必须保持 prototype 表述，直到真实故障注入验收通过。

## 目标数据库（2026-09-14 实测更正）

本文件原先多处写「Portretag PostgreSQL」，那是**未经核实的假设**——写架构时没有实际检查过本机的 PostgreSQL。实测结论如下，后续一律以本节为准：

- 目标环境就是**本项目自己的业务库**：容器 `xws-adaptive-postgres`（postgres:17，17.10-1.pgdg13+1），映射 127.0.0.1:5432，库名 `xws_automation`，数据在命名卷 `xws-adaptive-postgres-data` 上。001/002/003 已 apply，`durable_*` 仍为 0 行。
- 本机不存在名为 Portretag 的实例。若外部确有该环境，需要由知道它的人给出并确认；在确认之前**不对外部环境做任何操作**。
- 本机另有其它项目的 PostgreSQL（`xws-postgres-test` PG16/55432、`sub2api-postgres` PG18、`maps-crawler-postgres` PG17/5434）。**禁止把任何其它项目的数据库当成目标库**，包括测试实例——跨项目写库会污染别人的数据，且 PG16 与业务库 PG17 大版本不同，验证结论不可迁移。
- 角色注意：库内 `xws_agent`（无 superuser、无 createdb）与 `xws_runner`（容器超级用户）并存。项目配置文件用的是 `xws_agent`，它**无法创建隔离库**；隔离验证需要用有 CREATEDB 的角色。

## 交接硬边界

- 尚未在本项目业务库执行 004 migration、实现运行时模块或部署。
- 可开始单 Agent、确定性 Worker、Validator、Commit/Reconcile 和简单 SOP；暂不可宣称多 Agent 生产编排或高并发能力。
- `architecture.*` 仅保存架构审查快照和设计目录，不是运行时状态、Skill Registry、Evidence Store 或业务事实表。
- Agent Runtime 只能输出结构化 proposal；Workflow Controller 是运行状态唯一拥有者；外部副作用必须经过确定性 Worker、Validator 和 Commit/Reconcile。

## 模块责任矩阵

| 模块 | 负责 | 不负责 | 依赖 |
|---|---|---|---|
| Task Admission | 任务准入、租户和能力校验 | 外部操作 | Policy、Workflow Controller |
| Policy | 风险、审批、权限、并发和幂等规则 | 外部操作 | Control Plane |
| Workflow Controller | run/attempt 状态、租约、恢复、重试 | DOM 解析、业务提交细节 | Policy、Worker、Validator、Commit/Reconcile |
| Control Plane | 路由、队列、lane、限流 | 业务事实提交 | Policy、Workflow Controller |
| Agent Runtime | 读取 bounded evidence、生成 proposal | 直写 DB、Feishu、浏览器、Provider | Evidence Reader、Proposal Store |
| Proposal Store | 保存 proposal、intent、审批关联 | 执行 proposal | Agent Runtime、Proposal Validator |
| Proposal Validator | schema、权限、风险、幂等校验 | 外部操作 | Policy、Proposal Store |
| Browser/API Worker | 平台交互、原始观测、产物保存 | 拥有运行状态、提交业务事实 | Workflow Controller、Evidence Store |
| Validator | 导出、导入和外部结果确定性校验 | 未批准数据修改 | Workflow Controller、Evidence Store |
| Commit/Reconcile | 幂等提交、UNKNOWN 对账、发布回执 | 生成 Agent 决策 | Validator、Policy |
| Memory Service | 跨会话记忆及作用域、保留策略 | 替代 run、commit、evidence | Agent Runtime、PostgreSQL |
| Skill Registry | Skill 版本、兼容性、权限、动态挂载 | 架构审查快照 | Policy、Agent Runtime |
| Architecture Catalog | 审查快照、缺口、阶段、决策 | 运行时控制流 | 只读查询 |

## 004 migration 执行前检查

在本项目业务库（见「目标数据库」一节）执行前，确认 001、002、003 已按顺序完成；核对目标数据库、角色、`architecture` schema 及 7 张表的列、约束、外键和索引。记录 004 文件 checksum，并先在隔离库执行。

预期 seed 数量：`reviews=1`、`capabilities=5`、`modules=15`、`gaps=9`、`phases=7`、`decisions=7`、`evidence_refs=8`。重复执行不得产生重复数据；rollback 只能影响本轮新增表。`review_version=1` 是不可覆盖快照，后续修订必须新增版本。证据引用只允许项目相对路径，禁止写入凭据、cookie、`.env.local` 或用户目录。

## 本轮已落地文件

- docs/architecture/agent-sop-runtime-spec.md：目标分层、Context、Memory、Compression、Skill Registry、Proposal、Adapter、Validator、Commit 和并发契约。
- docs/architecture/agent-sop-runtime-implementation-plan.md：当前到目标的差距、模块变更、阶段计划、验收、风险和迁移顺序。
- db/migrations/004-architecture-catalog.sql：本项目业务库的 architecture schema、架构元数据表、索引和 review version 1 种子数据。
- db/migrations/004-rollback.sql：只回滚 004 创建的架构目录表，不使用 DROP SCHEMA CASCADE。

## 需要同事执行的动作

1. 阅读 AGENTS.md、docs/standards/README.md、docs/architecture/README.md 和上述两份 Spec。
2. 按项目现有迁移规范在授权的本项目业务库环境对 004 migration 做事务内 dry-run/语法校验。
3. 确认 migration 不修改现有 supervisor_proposals、supervisor_commit_records、durable_runs、durable_attempts 或业务表。
4. 由有权限的操作者决定是否 apply；本交接包本身不授权数据库 apply。
5. apply 后查询 architecture.reviews、architecture.capabilities、architecture.modules、architecture.gaps、architecture.phases、architecture.decisions、architecture.evidence_refs。
6. 核对 review version 1、能力状态、P0/P1/P2 阶段和 Spec 中的名称一致。
7. 只提交本轮明确文件；不要把 runtime/*-runs、CSV/XLSX、截图、凭据或其它 dirty changes 一并暂存。
8. 回报 migration 版本、数据库 schema/table 清单、种子记录数量、校验命令和未解决阻塞。

## Apply 后验证查询

在授权的本项目业务库连接中执行以下只读查询：

~~~sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'architecture'
ORDER BY table_name;

SELECT
  (SELECT count(*) FROM architecture.reviews) AS reviews,
  (SELECT count(*) FROM architecture.capabilities) AS capabilities,
  (SELECT count(*) FROM architecture.modules) AS modules,
  (SELECT count(*) FROM architecture.gaps) AS gaps,
  (SELECT count(*) FROM architecture.phases) AS phases,
  (SELECT count(*) FROM architecture.decisions) AS decisions,
  (SELECT count(*) FROM architecture.evidence_refs) AS evidence_refs;

SELECT project_key, review_version, conclusion_status,
       can_start_simple_sop, can_start_multi_agent_sop
FROM architecture.reviews
WHERE project_key = 'sycm-automation' AND review_version = 1;

SELECT gap_code, priority, status
FROM architecture.gaps
WHERE review_id = '10000000-0000-4000-8000-000000000001'
ORDER BY priority, gap_code;
~~~

预期表数量为 7；初始种子计数为 reviews=1、capabilities=5、modules=15、gaps=9、phases=7、decisions=7、evidence_refs=8。迁移文件中的 SQL 字符串已按 PostgreSQL 单引号规则转义；验证失败时先停止，不要手工修改业务表。

## 不要做的事

- 不要把 architecture schema 当成 Run/Attempt/Commit 的运行状态库。
- 不要新增第二套 proposal、commit、durable run、memory 或 context 表。
- 不要执行 Feishu 写入、浏览器动作、付费 Provider 调用、部署、push 或凭据读取。
- 不要把 Temporal POC、内存 Set、fake adapter、单次成功回执或模型文本写成生产能力。
- 不要把本地 JSON、events.jsonl 或页面显示进度当恢复权威。
- 不要在未完成阶段 1-3 前引入高并发、多 Agent swarm 或复杂基础设施。

## 初始结论

~~~text
project_key: sycm-automation
review_version: 1
conclusion_status: partial
can_start_simple_sop: true
can_start_multi_agent_sop: false

context_management: 部分具备 / P0
context_compression: 缺失 / P1
cross_session_memory: 部分具备 / P1
dynamic_skill_mounting: 部分具备 / P0
modularity: 部分具备 / P1
~~~

## P0 准入门槛

多 Agent、跨会话恢复、复杂外部写入或高并发 SOP 进入开发前，必须完成：

- 统一 sop-context-v1 和 PostgreSQL checkpoint/CAS；
- Side Effect Ledger、稳定幂等键和 COMMIT_UNKNOWN 对账；
- Skill manifest、Registry、Loader 和版本/依赖/权限校验。

单 Agent、短链路、只读或本地导出型 SOP 可以先做，但也必须遵守现有 Skill、证据和外部平台硬停止规则。

## 第一批实现顺序

1. XWS 单分片故障注入垂直切片；
2. FAQ 商品级 fan-out 和失败隔离；
3. XWS SKU；
4. SYCM 导出；
5. SYCM -> Feishu；
6. 灰豚与周报发布；
7. 受限 Agent Planner/Reviewer。

每批只迁移一条流程，保存迁移前后验收回执。删除或替换成熟业务逻辑前，先补迁移和回滚证据。

## 完成回报格式

~~~text
状态：READY / BLOCKED / APPLIED / VERIFIED
迁移文件：...
迁移版本：...
数据库：本项目业务库 xws_automation（容器 xws-adaptive-postgres / PostgreSQL 17；不回报连接串或秘密）
Schema/Table：...
种子记录：reviews=?, capabilities=?, modules=?, gaps=?, phases=?, decisions=?, evidence_refs=?
验证：命令 + 结果
未完成：...
未触碰：业务数据 / 凭据 / 外部平台 / push / deploy
~~~

