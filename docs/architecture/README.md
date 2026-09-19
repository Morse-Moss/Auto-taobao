# 运营自动化系统架构基线

状态：目标架构基线，当前仓库尚未完整实现。

本文件是 `docs/architecture/` 的唯一入口。该目录只保存稳定的目标架构、已批准的架构决策和跨流程契约；不保存单次运行回执、临时调查、实现教程或平台页面快照。新增决策或契约前，必须先更新本文件的边界，再按约定新增文件。当前不预建空的专题目录；未来只有在决策正式批准后才新增 `decisions/NNNN-short-title.md`，跨流程契约具备可执行 schema 后才新增 `contracts/`。

该目录允许存在**提案类文件**（文件名带 `-PROPOSAL`，首段以「状态：提案（PROPOSAL）」开头）：它们是稳定目标架构的补充或待批决策的草稿，**可以在本目录里被阅读和引用，但不得被当作已批准决策**。引用时必须带上状态。提案被批准后，把其中的决策拆成 `decisions/NNNN-*.md`，提案本身降级为背景材料或删除。当前已有一份：[可扩展性与部署灵活性：架构提案](EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md)（2026-09-19，待批）。

本项目当前的架构落地交接包：

- [Agent SOP Runtime Spec](agent-sop-runtime-spec.md)：Context、状态轴、Memory、压缩、Skill Registry、Proposal、Adapter、Validator 和 Commit 契约。
- [Agent SOP Runtime 实施计划](agent-sop-runtime-implementation-plan.md)：当前到目标的差距、模块改造、阶段优先级、风险和退出标准。
- [同事交接说明](handoff-to-teammate.md)：本项目业务库（xws_automation）迁移、验证、范围边界和回报格式。
- `db/migrations/004-architecture-catalog.sql`：架构元数据 schema 与 review version 1 种子数据；只提供迁移文件，不在本轮自动 apply。
- [可扩展性与部署灵活性：架构提案](EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md)（**提案，待批**）：七条架构决策（含 Browser Broker 的最小切片与边界、单点真相的封杀规则、配置层「无配置即逐字不变」的不变量、三档部署形态与容器化的真实边界），以及九阶段落地顺序与「判据从变体 A 搬到编排器」的逐条对账表。**它不是已批准决策**；要拍板的五条在该文件 §11。

**当前完成度对账**（审查者先看这里，再看上面三份文档）：
[`PHASE-ARCHIVE.md`](PHASE-ARCHIVE.md) §12 按实施计划的阶段 0-6、首批 7 条流程迁移、交付检查表逐项给出结论与可复核证据，
并列出「未做 / 打折」的部分；§9 是已知缺口表，§10 是实测才发现的历史缺陷清单。
生产准入的专项评估（四条阻塞线、本文件 §10 十一条架构验收的逐条实测状态、通往生产的最小路径）见 [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md)。
一句话口径：P0（阶段 0-3）与 P1（阶段 4-5）完成，P2（阶段 6）完成一半，未完成项集中在**真实环境验证**与**多 Agent 并发**两类。
同日收口（§13）：`sycm.feishu.weekly` 的失败码表与 `readBack` 接线缺陷已修并用三层测试锁住；该能力的采集段已用真实数据 + 真实入口 + 真实 PG 跑通，**发布段的真实 `--commit` 仍缺外部前置**（浏览器驱动的克隆步骤 + 会写生产历史/编号库），见 §13.4。
收口的第二部分（§13.5）：为发布段搭好「应用自持沙盒 base」后真跑，**先撞到一条更靠前的代码侧缺陷**——
`supervisor_commit_records.status` 的 CHECK 不接受运行时会写的 `FAILED`，导致**失败路径连收据都写不出来**（成功路径不受影响，所以此前的成功演练照不出来）。
已加 `db/migrations/006-commit-record-status-vocabulary.sql`（+ fail-closed 回滚）与仓库级守卫 `commit-status-vocabulary.test.mjs`；隔离库 26/26、故障注入 17/17 通过。
收口的第三部分（§13.6，2026-09-14 深夜）：两个前置清零后（**006 已 apply 到业务库**、用户在共享浏览器完成飞书登录），
`sycm.feishu.weekly` 的发布段**真实跑通并验收**：`verdict=VERIFIED`、回读 `rows=300 / historyRows=2367`、
`publicationStatus=VERIFIED`、`cursorAdvanced=true`（游标 1→300）。过程中又抓到一条**凭据接线缺陷**
（运行器的发布钩子工厂从不传 `env`，而本能力的 `readBack` 只认 `env` → 外部写入成功、自动回读却拿不到凭据，
发布段被判 `UNKNOWN`）；已对齐同族能力改读 `publishInput.envFile` 并补回归用例。
同时暴露两条**运行时缺口**：①运行的发布轴没有 `UNKNOWN` 出口（提交记录对账成 `VERIFIED` 也不行）；
②任何未终结的运行会永久占住它的幂等键，且没有 stale 回收 / resume 通道（本次两度靠 `controller.cancel` 手动释放）。
收口的第四部分（§13.7，2026-09-14 深夜用户答复「都修」）：**两条缺口均已修**，只补出口、不放宽任何准入——
①新增 `controller.reconcilePublication`（前置 `UNKNOWN`/`READY`；`VERIFIED` 要真实回读收据 **且** 该运行所有提交记录已 `VERIFIED`，强制「先对账账本、再收敛运行」；`ABSENT` 要具名操作者且无记录处于「可能已交付」状态）；
②新增 `run-liveness.mjs`（**死活看租约、回收安全性看提交记录，两个判据分开**）、`assessRun` / `reclaimStale` / `reclaimStaleRuns`、store 端口 `listCommitsByRun`（缺则 fail-closed）与准入可选自动回收。
修的过程中在真实库上发现**同源的第三格** `READY + COMMITTING`（崩溃遗留的 `b4e7e120`）——它同样没有任何出口，已一并纳入。
验证：sop-runtime **24 文件 / 300 通过 / 0 失败**（基线 265，+35 个新用例），runtime 套件 **397/61 文件**不变，故障注入 **17/17** 无回归，skills **532/44 文件**（其中 8 条为该套件并发下的 flaky：单跑涉及文件 36/36 全绿，见 §13.7.3）。
`xws.sku.collection` 与 `huitun.keyword-heat.collect` 两条的发布段仍未真实跑过。
004/005 迁移已在本项目库 apply（2026-09-14，经用户授权），上面第 12 行「不在本轮自动 apply」是交接时的原始状态。

## 1. 定位

本项目的长期目标是面向多个租户、店铺、平台账号和运营任务的任务执行平台。它包含 Agent 能力，但不是 Agent 聊天系统，也不是自由演化的 Agent swarm。

系统必须同时满足：

- 任务可以暂停、恢复、取消和审计。
- 店铺、平台账号、浏览器会话和写入目标相互隔离。
- 登录失效、验证码、风控、权限和额度问题进入明确的人工状态。
- 外部写入在重复执行、超时或进程崩溃后不会重复产生业务副作用；写入必须经过 dry-run、精确授权、白名单、幂等键和回读验收。
- 每个业务结果都可以追溯到原始输入、验证证据和版本信息。
- 平台页面变化只影响对应的适配器，不传播到工作流和业务状态。

## 2. 非目标

当前阶段不把以下内容当作已经完成的能力：

- 长期无人值守运行。
- 十几或几十家店铺的生产级并发。
- 永久有效的登录态或平台页面兼容性。
- 绕过登录、验证码、风控、权限或平台限制。
- 由 Agent 直接写入 PostgreSQL、飞书或其他业务系统。
- 通过增加脚本 supervisor 继续扩展通用调度、重试和恢复能力。
- 在没有故障注入 POC 前承诺最终采用 Temporal、LangGraph、ADK、AutoGen 或 AgentTeams。

## 3. 核心资源

以下对象是长期系统的一等资源：

- `Tenant`：权限、配额、审计和数据隔离边界。
- `Store`：经营主体及其平台数据边界。
- `PlatformAccount`：平台账号、登录态、额度和风控边界。
- `BrowserProfile`：浏览器 profile、会话和运行环境。
- `Capability`：可执行业务能力及其版本。
- `Policy`：权限、风险、数据和发布规则。
- `Quota`：租户、店铺、账号、平台和能力的并发/速率/预算限制。
- `Workflow`：可复用的业务流程定义。
- `Run`：一次不可混淆的流程执行实例。
- `Step`：流程中的逻辑阶段。
- `Attempt`：某个阶段的一次执行尝试。
- `Lease`：浏览器、账号、写目标等稀缺资源的短期占用。
- `Approval`：人工批准、拒绝或补充信息。
- `Observation`：外部页面、请求、响应和诊断中观察到的事实。
- `Artifact`：原始或派生文件工件。
- `EvidenceManifest`：工件来源、范围、时间、大小、哈希和验证结果。
- `Decision`：规则或 Agent 基于证据产生的结构化判断。
- `CommitRecord`：业务事实提交账本。
- `PublicationReceipt`：外部发布后的回读和验收回执。

身份必须在“租户、店铺、平台、账号、业务实体、周期和采集合同”的作用域内稳定、唯一和幂等。标题相似度不能替代显式的跨平台身份映射。

## 4. 分层

```text
运营人员 / API / 定时触发器
                |
                v
任务与策略入口
                |
                v
控制平面
租户、店铺、账号、能力、权限、配额、人工任务
                |
                v
唯一 Durable Workflow 层
超时、重试、心跳、暂停、恢复、取消、信号、审计
                |
       +--------+---------+----------+---------+
       |                  |          |         |
 Browser Worker       API Worker  Agent     Validator
       |                            Worker      |
 Browser Broker                                  |
       |                                           v
淘宝 / SYCM / XWS / 灰豚                  Commit / Publication
                                                   |
                              PostgreSQL + Object Storage + Feishu
```

### 4.1 控制平面

控制平面管理租户、店铺、平台账号、浏览器 profile、能力目录、能力版本、策略、配额、任务准入、人工任务和审计查询。它负责资源 admission 和权限判断，不重复实现 durable timer、重试历史或崩溃恢复。

### 4.2 Durable Workflow 层

系统只能有一个耐久工作流事实拥有者。它管理 Workflow、Run、Step、Attempt、Timer、Retry、Pause/Resume、Cancellation、Human Gate 和执行历史。

Workflow 定义必须保持可重放和可验证；外部副作用放在 Activity/Worker 中，并使用幂等键、提交账本和补偿机制。Activity 至少一次执行是正常情况，不能把一次执行假设成 exactly-once。

Temporal 是该层的首选 POC 候选，但尚未落依赖或部署。Restate 等方案只有在相同故障模型下完成对比验证后才能替代它。当前仓库的 XWS supervisor 是实验性流程实现，不是该层的最终实现。

### 4.3 Browser Broker

Browser Broker 负责 BrowserProfile、PlatformAccount、CDP session、tab 和 lease 的生命周期：

- 发放和续期短期资源租约。
- 保证同一账号/profile 的互斥使用。
- 登记创建、认领、释放和孤儿清理的所有权。
- 处理登录、验证码和人工接管。
- 施加平台、账号、profile 和浏览器容量限制。
- 不向 Agent 暴露 Cookie、token、浏览器存储或认证头。

Worker 只能操作获准 lease 范围内的资源，不能扫描并关闭未知 tab。

### 4.4 Adapter 与 Worker

SYCM、小旺神、灰豚、淘宝和飞书分别实现 Adapter/Capability。上层工作流只依赖业务能力，不依赖 DOM selector、target ID、按钮文本或平台内部请求格式。

推荐的能力接口形态为：

```text
checkSession()
prepare(input)
start(input)
observe()
collectArtifact()
validate(artifact)
release()
```

浏览器导航、请求关联、插件诊断、弹窗处理、下载和最后一公里 DOM 操作都属于对应 Adapter 的内部实现。

平台变化时，通过新 Capability 版本、probe、contract test 和小范围 canary 发布；失败时标记 `CAPABILITY_DEGRADED` 或进入 `HUMAN_REQUIRED`，不能让 Agent 自动修改生产 selector。

### 4.5 Agent Runtime

Agent 只负责概率性或语义性工作：

- 将自然语言目标转换为结构化任务建议。
- FAQ、关键词、产品方向等模糊分类、摘要和解释。
- 异常分诊和人工队列候选。
- 在既定证据和策略范围内提出下一步建议。

Agent 输出必须是带 schema 的 proposal，至少包含：

```text
proposal
- task / input
- evidence references
- prompt version
- model version
- confidence
- requested action
- risk classification
```

Agent 不得选择店铺、账号、浏览器或飞书目标，不得判定周期有效性，不得推进业务游标，不得授予写权限，不得绕过平台控制，不得以自然语言“成功”替代验证证据。

LangGraph 和 ADK 只能二选一作为 Agent 内部运行时：LangGraph 偏通用推理图与中断恢复，ADK 适合明确采用 Gemini/Google Cloud/A2A 生态。AutoGen 适合离线研究、模拟和评测。AgentTeams 可作为未来的人机协作界面，但不拥有业务状态、浏览器租约或提交账本。未完成 POC 前不同时引入这些框架。

## 5. 权威数据和证据链

权威职责必须分开：

| 数据 | 权威职责 |
| --- | --- |
| Durable Workflow history | 执行历史、定时器、重试、信号和恢复依据 |
| PostgreSQL | 业务事实、verified cursor、租约、人工任务、幂等提交账本和审计索引 |
| Object Storage | 不可变原始文件、图片、ZIP、截图、trace、manifest 和大工件；当前仓库尚未实现此层 |
| Feishu | 运营工作台、人工编辑界面和发布投影 |
| 本地 JSON | 缓存或投影，不得决定业务恢复位置或业务完成状态 |

不要同时把 Workflow history、PostgreSQL 事件和完整 Event Sourcing 都设计成同一状态的权威源。Temporal 负责“如何执行”，PostgreSQL 负责“业务上确认了什么”。

统一证据链：

```text
Observation
    -> Candidate Artifact
    -> Validated Artifact
    -> Decision
    -> Idempotent Commit
    -> Publication Receipt
```

- `Observation` 只表示观察到的事实。
- `Candidate Artifact` 尚未证明归属、范围或完整性。
- `Validated Artifact` 必须通过身份、范围、结构、行数、哈希和完整性验证。
- `Decision` 必须引用输入证据、规则/模型及其版本。
- `Idempotent Commit` 才能推进业务状态或游标。
- `Publication Receipt` 必须包含外部系统回读结果。

未知、缺失、未核验和未完成不得写成 `0`、空成功或完成状态。

## 6. 统一状态与失败模型

执行、证据、人工和发布状态不能压缩成一个含义模糊的 `status`。最低限度应分别表达：

- Execution：`QUEUED / RUNNING / RETRY_WAIT / PAUSED / SUCCEEDED / FAILED`
- Evidence：`NONE / CANDIDATE / VALIDATED / REJECTED`
- Human gate：`NONE / WAITING_HUMAN / APPROVED / DENIED / EXPIRED`
- Resource lease：`WAITING / HELD / EXPIRED / RELEASED`
- Publication：`NOT_REQUESTED / READY / COMMITTED / VERIFIED / UNKNOWN`

失败分类：

- `TRANSIENT_EXTERNAL`：在明确预算内重试。
- `RESOURCE_BUSY`：回队列等待，不创建重复执行。
- `HUMAN_REQUIRED`：暂停等待人工。
- `CAPABILITY_DEGRADED`：停止该能力版本，进入维护或回退流程。
- `EVIDENCE_INVALID`：拒绝工件，不重试同一坏证据。
- `POLICY_DENIED`：终止并记录原因。
- `COMMIT_UNKNOWN`：进入对账，不能盲目重写。
- `BUG`：告警并停止自动化。

`STALLED` 只能描述阶段或分片未继续推进，不等于 `DONE`。只有目标范围被验证工件完整覆盖并成功提交，流程才能进入完成态。

## 7. 并发与租户隔离

“增加 Agent 数量”不等于提高系统并发。调度至少按以下维度分 lane：

```text
tenant / store / platform / account / browserProfile / capability
```

- 同一账号或 browser profile 默认并发为 1。
- 同一店铺的写操作默认串行。
- 不同店铺可以并行。
- API、本地解析和浏览器任务分别限流。
- 租户有独立并发、速率和预算配额。
- 平台异常按平台维度熔断。
- 使用带权公平队列和背压，避免单店铺占满资源。
- 不使用覆盖所有店铺的进程级全局锁作为并发模型。

## 8. 现有业务能力的落位

现有业务按能力而不是按脚本组织：

- `sycm.search-rank.collect`
- `xws.market-analysis.collect`
- `xws.sku.capture`
- `xws.faq.collect-raw`
- `faq.normalize`
- `faq.classify`
- `keyword.normalize`
- `keyword.classify`
- `keyword.decision`
- `huitun.topic-heat.collect`
- `report.weekly.generate`
- `feishu.publish`

上层工作流可以组合这些能力，但每个能力保留自己的数据和业务合同。

### 8.1 SYCM 周流程

```text
账号准入
 -> SYCM Adapter 采集
 -> 周期/字段验证
 -> source snapshot 提交
 -> 本地关键词分析
 -> 可选 Agent 复核
 -> 灰豚精确匹配
 -> 决策计算
 -> Feishu 发布
 -> 周报生成
```

### 8.2 XWS FAQ

```text
周期和 TOP5 snapshot 锁定
 -> 按商品 fan-out 原始采集
 -> 原始证据验证
 -> 本地解析与跨周去重
 -> 规则分类
 -> Agent/人工复核
 -> 汇总
 -> 独立发布
```

### 8.3 XWS SKU

```text
竞品 snapshot
 -> 商品级 browser lease
 -> raw payload 捕获
 -> 确定性拓扑与解析
 -> hash/唯一键/关系验证
 -> dry-run
 -> 授权提交
 -> 回读验收
```

### 8.4 XWS 市场分析

```text
采集分片
 -> 连续前缀验证
 -> part 幂等提交
 -> 从 PostgreSQL cursor 继续
 -> 最终 CSV/XLSX/图片/ZIP/行数验证
 -> DONE 提交
 -> 可选独立 Feishu import
```

## 9. 迁移路线

1. 冻结 TaskSpec、Capability、Evidence、Artifact、Approval、Lease、CommitRecord 和失败分类。
2. 停止向现有 XWS supervisor 增加通用调度、重试和恢复特判。
3. 用 XWS 单分片完成“采集 -> 验证 -> EvidenceManifest -> 幂等提交 -> 恢复”的故障注入垂直切片。
4. 验证 Worker 被杀、浏览器断开、重复回调、partial artifact、retry 耗尽和资源释放。
5. 用 FAQ 商品级 fan-out 验证并行、单商品失败隔离和人工队列。
6. 再迁移 SKU、SYCM 周流程、灰豚和周报发布。
7. 最后加入 Agent Planner/Reviewer；初期 Agent 只能读、分类、规划和提案。

不一次性引入 Kafka、Kubernetes、Redis、多个 Agent 框架和完整协作平台。每个基础设施组件都必须对应已验证的容量、故障或治理需求。

## 10. 架构验收

底座至少必须证明：

1. Worker 被杀后可以恢复，且不重复提交业务副作用。
2. 浏览器断开或插件停滞不会把页面进度当作完成。
3. partial artifact 不会推进错误游标。
4. retry budget 耗尽后进入明确终态。
5. 同一账号/profile/写目标不会并发双写。
6. 失败和人工介入路径释放资源并保留可恢复状态。
7. Feishu 暂时不可用时，已验证源工件不需要重新采集。
8. 两个店铺并行时不会串账号、数据或浏览器 tab。
9. Adapter 版本变化不会修改工作流、租户权限或业务提交逻辑。
10. 移除 Agent 后，确定性采集、解析、验证和提交仍可运行。
11. 每个发布字段可以追溯到 source snapshot、validator evidence 和 commit record。

## 11. 待决策

以下问题会影响实现参数和部署方式，但不改变本架构分层：

- 租户、店铺和平台账号的真实拓扑，以及跨店共享规则。
- 部署区域、凭据托管、数据留存、PII 和删除要求。
- 目标 SLA、RPO/RTO、人工响应窗口和失败通知渠道。
- 第一阶段及目标阶段的店铺、账号、任务和并发规模。
- 各平台 API 与浏览器的合规边界。
- Feishu 是否仅作投影，还是允许受控人工修改回写业务事实。
- 跨平台商品、SKU 和关键词的主数据映射规则。
- Agent 使用的模型供应商、预算、延迟、数据出境和审批阈值。
- Temporal 与其他 durable engine 的 POC 结果。

在这些决策明确前，不承诺生产级无人值守规模、上线日期或长期平台兼容性。
