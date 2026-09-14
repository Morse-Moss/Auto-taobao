# Agent SOP Runtime 实施计划

状态：交接执行计划；不代表未完成阶段已经实现。
日期：2026-09-13
适用数据库：Portretag 当前 PostgreSQL
前置阅读：AGENTS.md、docs/architecture/README.md、docs/standards/README.md、agent-sop-runtime-spec.md、SUPERVISOR-AGENT-DESIGN.md

## 1. 交付目标

把当前“业务 Skill 已有、运行状态分散、Agent/Temporal 仍为 POC”的仓库，逐步收敛为：

~~~text
确定性 Workflow/Controller
  -> Capability/Skill
  -> Adapter/Worker
  -> Observation/Artifact
  -> Validator
  -> Idempotent Commit/Reconcile
  -> Publication Receipt

Agent Runtime 只读取 bounded evidence 并生成 proposal。
~~~

第一阶段交付的是可审阅、可回滚的架构目录迁移和零上下文 Spec；不是生产多 Agent 平台，也不是自动执行外部写入。

## 2. 当前到目标差距矩阵

| 领域 | 当前实现/证据 | 目标 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| Context | durable_runs/durable_attempts、Skill 参数、运行收据各自保存状态 | 统一 sop-context-v1、CAS 版本、五条状态轴 | 状态字段和恢复入口未统一 | P0 |
| Checkpoint/Recovery | XWS 有 verified cursor/lock；Temporal POC 是 fake/in-memory | 每步都能从 PostgreSQL 权威状态恢复 | 真实跨进程故障注入未完成 | P0 |
| Side effects | supervisor_commit_records 已有；部分业务有幂等提交 | 所有上传、写入、付费调用统一登记并可对账 | 能力覆盖和 UNKNOWN 路径不统一 | P0 |
| Skill mount | frontmatter 可被原型读取 | manifest schema + Registry + Loader + 依赖/权限校验 | 无统一机器合同和版本兼容检查 | P0 |
| Validation | 各 Skill 有局部字段/行数/哈希/回读校验 | 通用 Validator 组合接口 | 校验器分散、输出格式不统一 | P1 |
| Adapter | 平台脚本和 runtime 入口混合 | 平台细节封装在 Adapter/Worker | skills/ 与 runtime/ 存在双向依赖 | P1 |
| Evidence | evidence/、manifest、events.jsonl 和运行产物并存 | 不可变 Artifact + manifest + evidence index | 原始工件和运行投影边界需加强 | P1 |
| Memory | 文档、experience 表、历史 evidence | Context/Evidence/Verified Fact/Rule/Experience 分层记忆 | 缺少统一作用域、有效期和检索 | P1 |
| Compression | 未见结构化压缩策略 | 保留身份、状态、游标、副作用、下一动作和原文 digest | 缺失 | P1 |
| Concurrency | 当前以账号/profile 物理瓶颈和局部锁为主 | tenant/store/platform/account/profile/capability 分 lane | 资源模型未统一纳入 Controller | P2 |
| Agent | supervisor 规则诊断 + 可选 LLM hook；Temporal activity fake | 真实模型 + 受限只读工具 + proposal validator | 真实性、工具隔离和审计未闭环 | P2 |
| Durable engine | Temporal POC，尚未通过五项验收 | 由故障注入结果选择是否保留 | 尚无生产选型结论 | P2 |

## 3. 模块变更清单

### 3.1 新增

| 模块 | 首要职责 | 首要依赖 | 首批不做 |
| --- | --- | --- | --- |
| context_store | Context、CAS、checkpoint | PostgreSQL | 不保存完整原始工件 |
| workflow_controller | Run/Step/Attempt 状态转移、恢复和人工闸门 | Context、Skill Registry、Validator | 不读 DOM |
| skill_registry | manifest 发现、解析、依赖和权限检查 | 文件系统、schema validator | 不执行 Skill |
| skill_loader | 装载已注册能力 | Registry | 不执行任意路径 |
| compression_service | 结构化摘要和原文引用 | Context、Evidence | 不改变业务状态 |
| memory_store | 事实/规则/经验检索 | PostgreSQL | 不替代当前 Run Context |
| side_effect_ledger | 幂等键、提交状态、UNKNOWN 对账 | PostgreSQL | 不做业务字段解析 |
| validation_framework | 可组合确定性验证器 | 纯函数、Evidence | 不调用 LLM 决定通过 |
| evidence_index | Artifact/manifest/receipt 索引 | PostgreSQL、工件存储 | 不作为恢复状态 |
| resource_lease | 账号/profile/写目标租约 | PostgreSQL、Broker | 不关闭未知 tab |

### 3.2 改造

| 模块 | 改造内容 | 迁移原则 |
| --- | --- | --- |
| skills/* | 增加 manifest；输出结构化 ArtifactRef/ValidationResult；移除跨 Skill 状态源 | 先兼容旧 CLI，再切换 Controller |
| runtime/ | 识别冻结入口、核心库和临时脚本；将长期编排收敛到 Workflow | 不在同一批次清理无关旧入口 |
| runtime/supervisor-agent | 从规则/一次 LLM hook 变为 bounded evidence -> proposal -> validator | Agent 永不直写业务系统 |
| agent-runtime/temporal | 只保留 POC 标识；替换 fake adapter 前先完成 S1 | 不以 SDK/内存测试宣称恢复 |
| db/migrations | 复用 001-003 表，新增本轮 004 架构目录 | 迁移只新增 architecture schema |
| evidence/ | 增加 run/attempt/digest/index 关联 | 不把历史 evidence 当实时输入 |

### 3.3 保留和暂不替换

- 保留共享 web-access Proxy/CDP、每个浏览器动作前重新发现目标、登录/CAPTCHA/风控硬停止。
- 保留 SYCM/XWS/Feishu 现有业务验收规则和授权副本边界。
- 暂不替换 PostgreSQL 作为业务事实和提交账本权威。
- 暂不接 Object Storage；先用现有受控工件路径和 manifest 建立索引缝。
- 暂不让 Temporal、LangGraph、ADK、AutoGen 或 AgentTeams 成为生产前置依赖。
- 暂不重写成熟业务 Skill；先包进 Adapter/Workflow 契约。

## 4. 分阶段实施

### 阶段 0：架构基线和迁移落地

优先级：P0
状态：本轮文件已准备；数据库 apply 由授权同事执行。

关键改动：

- 创建 architecture schema 及 7 张架构元数据表；
- 导入 review version 1、能力状态、模块、缺口、阶段、决策和 evidence refs；
- 发布 Spec、本文和 handoff-to-teammate.md；
- 从 README 入口导航到三份交接文档。

退出标准：

- migration 幂等、可回滚；
- 查询能返回本轮 review、P0 缺口和 0-6 阶段；
- 文档与 SQL 的编码、名称和版本一致。

风险：误把架构目录当运行状态库，或将未跟踪运行产物带入提交。

### 阶段 1：Context、Checkpoint 和恢复

优先级：P0

关键改动：

- 定义 sop-context-v1 JSON Schema；
- 为每个 Run/Step/Attempt 写入统一上下文和五条状态轴；
- 使用 PostgreSQL 事务 + CAS 保存 checkpoint；
- 把当前 XWS verified cursor 和 FAQ 阶段指针映射到统一 Context；
- 明确暂停、恢复、取消、人工批准/拒绝/过期状态；
- 先用一个 XWS 单分片做故障注入，不迁移全部流程。

验收：

- 独立杀掉 worker 后可从最后 verified cursor 恢复；
- checkpoint 不依赖进程内 Set、本地 JSON 或模型记忆；
- 恢复不重复已经确认的 CommitRecord。

风险：旧入口依赖隐式状态；动作成功但 checkpoint 未写时必须走幂等/对账。

### 阶段 2：Side Effect Ledger、幂等和对账

优先级：P0

关键改动：

- 统一写入、附件上传、付费调用和远程任务的 effect_id、idempotency_key、provider reference 和状态；
- 复用 supervisor_commit_records，不创建同义提交表；
- 把 Feishu 写入和 XWS 附件导入接入 READY -> COMMITTING -> COMMITTED -> VERIFIED/UNKNOWN；
- 对 UNKNOWN 建立查询、回读和人工处理路径；
- 为每种副作用定义稳定业务唯一键。

验收：

- commit-before-response 只产生一个业务效果，或稳定进入 UNKNOWN；
- 重试不会重复行、附件或 Provider 任务；
- 对账完成前不推进 cursor/完成态。

风险：外部成功但本地登记失败；外部系统不支持幂等键时必须使用可回读业务唯一键和人工兜底。

### 阶段 3：Skill Manifest、Registry 和 Loader

优先级：P0

关键改动：

- 为现有 SYCM、XWS、FAQ、灰豚和 Feishu 能力增加 manifest；
- 校验名称、版本、输入输出、前置条件、权限、副作用、依赖、验证器和恢复能力；
- 生成 Registry 索引，拒绝缺依赖、循环依赖、未声明副作用和版本不兼容；
- Loader 只装载 Registry 允许的实现；
- 保留旧 CLI 作为兼容入口，但让 Controller 通过能力 ID 调用。

验收：

- 新 Skill 可只新增目录、manifest、实现和测试，不修改核心 Runtime；
- Registry 能按输入/前置条件筛选能力；
- 错误 manifest 在执行前失败。

风险：frontmatter 版本漂移、动态路径逃逸和 Skill 自行持有跨流程状态。

### 阶段 4：Validator 和 Adapter 收敛

优先级：P1

关键改动：

- 抽取身份、周期/范围、字段、行数、连续排名、关系、图片/附件、哈希和发布回读验证器；
- 为 SYCM、XWS、Feishu、浏览器建立 Adapter 接口；
- 把 selector、target ID、下载关联和页面等待封装到 Adapter；
- 统一错误分类和 EvidenceManifest；
- 优先迁移一条 SYCM 导出和一条 XWS 市场分析流程。

验收：

- Workflow 不再直接依赖平台 DOM/API 细节；
- 迁移前后业务验收结果一致；
- Adapter 版本升级不改变权限、Workflow 和 Commit 规则。

风险：抽象过度；应保留平台专属能力，不建立万能 Adapter。

### 阶段 5：Memory 和 Context Compression

优先级：P1

关键改动：

- 分开 Run Context、Evidence、Verified Fact、Rule/Decision、Experience；
- 实现作用域、来源、置信度、有效期、退役和冲突处理；
- 在 token/字节阈值和阶段边界触发结构化摘要；
- 保留授权、身份、状态轴、游标、副作用、阻塞、下一动作和原文 digest；
- 当前 run 证据优先于历史规则和经验；
- 增加摘要完整性和旧证据污染测试。

验收：

- 长任务压缩后能恢复到同一 run/attempt；
- 原始 evidence 可由 digest/URI 追溯；
- 历史经验不能覆盖当前验证结果；
- 摘要缺关键字段时拒绝使用。

风险：压缩丢失外部副作用或把历史事实当当前事实；必须失败关闭。

### 阶段 6：有限多 Agent 与高并发

优先级：P2；若下一轮 SOP 明确需要多 Agent，则前置为 P0/P1。

关键改动：

- 定义 Agent capability manifest、只读工具和 proposal schema；
- 引入任务队列、租约、超时、取消、重试和资源 lane；
- 按 tenant/store/platform/account/browserProfile/capability 隔离；
- FAQ 商品级 fan-out 先做失败隔离，再扩大并发；
- 用故障注入决定是否保留 Temporal；
- 增加限流、背压、平台熔断和结果合并。

验收：

- 同一账号/profile/写目标不发生双写；
- 重复消费无重复副作用；
- Worker 替换、租约过期和人工闸门可恢复；
- Agent 移除后确定性流程仍可运行。

风险：并发放大平台风控、额度消耗和未知提交；并发扩容必须基于资源容量证据。

## 5. 首批流程迁移顺序

1. XWS 单分片：采集 -> 验证 -> EvidenceManifest -> 幂等提交 -> 恢复。
2. FAQ 商品级 fan-out：单商品失败隔离、人工队列和独立证据。
3. XWS SKU：拓扑、关系、dry-run、授权提交和回读。
4. SYCM 搜索排行：周期/字段/连续排名验证和本地工件。
5. SYCM -> Feishu：目标副本、字段映射、幂等写入、回读。
6. 灰豚关键词热度与周报发布。
7. Agent Planner/Reviewer：只在证据和 Policy 边界内做解析、分类、摘要和提案。

每次只迁移一条流程；保留迁移前后的业务验收回执。没有完成阶段 1-3，不进入多 Agent 并发或复杂外部写入。

## 6. 风险登记和应对

| 风险 | 影响 | 触发信号 | 应对 |
| --- | --- | --- | --- |
| 误把 Temporal POC 当生产底座 | 高 | fake adapter、内存 Set、无真实 PG cursor | 保持 prototype 标识，先过 S1 五项验收 |
| 运行状态多头权威 | 高 | local JSON、events、PG 状态不一致 | PostgreSQL/Workflow 唯一权威，投影只诊断 |
| 重复外部写入 | 高 | commit-before-response、UNKNOWN | Side Effect Ledger、幂等键、回读和对账 |
| Skill/runtime 双向依赖扩大 | 中高 | Skill 导入 runtime 新模块 | 冻结反向依赖，迁移到 Adapter/Workflow 接口 |
| manifest/版本漂移 | 中 | 同一 Skill 多处版本不同 | Registry 校验，单一 manifest 来源 |
| 压缩污染恢复 | 高 | 摘要缺 run/attempt/副作用 | 强制 schema/完整性校验，失败关闭 |
| 并发超过外部资源容量 | 高 | Proxy/账号限流、风控、Lease 冲突 | lane、背压、限流、平台熔断 |
| 交接范围扩大 | 中 | 同事顺手重写成熟 Skill/部署 | 以本计划阶段和非目标作为边界，分批审查 |

## 7. 给实现同事的交付检查表

### 阶段 0

- [ ] 阅读并遵守 AGENTS.md 与 docs/standards/README.md。
- [ ] 确认 Portretag 当前连接是 PostgreSQL，沿用 db/migrations 命名和 apply 方式。
- [ ] 审阅 db/migrations/004-architecture-catalog.sql 与 004-rollback.sql。
- [ ] 先在授权环境执行 migration dry-run/事务校验；未授权不要 apply。
- [ ] 检查 architecture 表、约束、索引、种子数据和 Spec 一致。
- [ ] 不暂存本轮之外的 runtime 运行产物、凭据或业务导出文件。

### 后续阶段

- [ ] 每个阶段先更新对应 Spec/contract，再实现代码。
- [ ] 每次改变状态、证据、权限、幂等或外部写入都补失败路径和验收。
- [ ] 真实浏览器、Feishu、PG 和模型调用单独记录环境、授权和回执。
- [ ] 未通过故障注入前，不声称 durable workflow、生产级 Agent 或高并发。
- [ ] 不新增第二套同义 Context、Memory、Commit 或状态表。

## 8. 完成定义

本交接包完成意味着：Spec、实施计划、交接说明和迁移脚本已经落入仓库，迁移尚未由本轮自动执行。后续实现只有在对应阶段的验收证据齐全后，才能把阶段状态从 planned 更新为 done。

