# Agent SOP Runtime Spec

状态：实施前冻结的架构与跨流程契约草案；不代表这些目标能力已经全部实现。

日期：2026-09-13
项目：sycm-automation
数据库：本项目业务库 PostgreSQL（xws_automation，容器 xws-adaptive-postgres，PG 17，127.0.0.1:5432）
作用域：SYCM、XWS、FAQ、灰豚、飞书及后续同类 SOP

本文是给实现同事使用的零上下文 Spec。它细化 docs/architecture/README.md 已批准的分层，并吸收 SUPERVISOR-AGENT-DESIGN.md、PROJECT-SYSTEM-DESIGN-ANALYSIS.md 与 PROJECT-HANDOVER-ANALYSIS.md 的结论。它不替代 AGENTS.md、docs/standards/README.md 或各 Skill 合同；发生冲突时，以更高层级规则为准。

## 1. 目标和边界

### 1.1 目标

建立一条“确定性执行底座 + 受限 Agent 提案层”的最小可落地架构，使新 SOP 能够：

- 用统一的任务上下文、阶段状态和检查点暂停、恢复、取消和审计；
- 在浏览器、API、文件和飞书等外部系统不可靠时保持身份、范围、证据和幂等边界；
- 将采集、验证、提交和发布与平台 DOM/API 细节隔离；
- 让 Agent 只读取已授权证据并输出可拒绝的结构化 proposal；
- 支持有限并发、资源租约、租户/店铺隔离和外部副作用对账；
- 在移除 Agent 后，确定性采集、解析、验证和提交仍可运行。

### 1.2 非目标

本 Spec 不授权或承诺：

- 本轮直接执行 PostgreSQL migration、Feishu 写入、浏览器操作、凭据读取、部署或推送；
- 一次性引入 Temporal、LangGraph、ADK、AutoGen、AgentTeams、Kafka、Kubernetes、Redis 或对象存储；
- 多个 LLM 自主互相委派、共享写权限或组成无边界 swarm；
- 生产级无人值守、几十家店铺并发或永久登录态；
- 让 Agent 选择租户、店铺、平台账号、浏览器 profile、写入目标或推进业务游标；
- 用本地 JSON、events.jsonl、页面显示进度、子进程退出码或模型文本替代权威状态和验证证据。

## 2. 当前基线和事实口径

### 2.1 已有资产

| 资产 | 当前事实 | 目标中的处理 |
| --- | --- | --- |
| skills/ | 已有 9 个业务能力 Skill，部分有真实运行证据和字段/文件校验 | 保留能力合同，增加机器可读 manifest，收敛跨 Skill 依赖 |
| runtime/ | 事实上的业务编排层，入口多，和 skills/ 存在双向依赖 | 保留冻结运行面，逐步收敛为 Workflow/领域编排，不再扩大隐式状态 |
| db/migrations/001-supervisor-tables.sql | 已有 proposal、action intent、approval、commit record、experience 表 | 复用，不重复创建第二套 proposal/commit/experience 表 |
| db/migrations/002-durable-run-tables.sql | 已有 durable_runs、durable_attempts | 作为当前耐久状态最小实现，后续由 Workflow Controller 统一拥有 |
| db/migrations/003-durable-attempt-heartbeat.sql | 已有 attempt 心跳字段 | 复用并纳入租约回收和故障注入验收 |
| agent-runtime/temporal/ | Temporal POC，activity 为 fake adapter，内存状态不能证明进程恢复 | 继续标注 prototype；是否保留由 S1 故障注入结果决定 |
| docs/architecture/README.md | 目标架构、权威数据和迁移路线入口 | 继续作为目标架构唯一入口；本 Spec 为实现契约 |
| docs/standards/README.md | 目录所有权、状态/证据不变量和测试门禁 | 继续作为工程治理权威 |
| evidence/ | 历史验证输出 | 只作为证据源，不作为当前运行状态或未验证输入 |

### 2.2 本轮判断

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 上下文管理 | 部分具备 | Skill、运行参数、收据和数据库状态各自保存部分上下文，缺少统一 Context 契约 |
| 上下文压缩 | 缺失 | 没有结构化摘要、保留字段和压缩后校验 |
| 跨会话记忆 | 部分具备 | 文档、规则、experience 和 evidence 分散存在，缺少统一作用域、检索和有效期 |
| Skill 动态挂载 | 部分具备 | 可按目录和 frontmatter 发现，但没有完整 Registry、依赖、权限和版本校验 |
| 模块化 | 部分具备 | 业务 Skill 边界较清楚，但 runtime/ 与 skills/ 双向依赖，运行状态和平台细节尚未完全隔离 |

## 3. 设计原则和不变量

1. 确定性代码拥有状态。Workflow、Validator、Commit/Publication、Lease 和游标推进不交给模型。
2. 平台细节只在 Adapter/Worker。工作流不能依赖 selector、按钮文本、target ID 或内部请求格式。
3. 观察不等于事实。所有结果必须经过 Observation -> Candidate Artifact -> Validated Artifact -> Decision -> Idempotent Commit -> Publication Receipt。
4. 至少一次执行是正常情况。所有外部写入必须有稳定幂等键；提交结果未知时进入对账，禁止盲目重写。
5. 人工是持久状态。登录、验证码、风控、权限、额度和高风险发布进入 WAITING_HUMAN，不能绕过。
6. Agent 是受限提案者。Agent 只能读取 bounded evidence 并生成带 schema、版本、证据引用、置信度和过期时间的 proposal。
7. 本地投影不是权威。本地 JSON、事件日志和页面进度只能辅助诊断，不能决定恢复位置、游标或完成状态。
8. 同一物理资源默认串行。同一平台账号或 browser profile 默认并发为 1；不同店铺、独立 API 任务和本地 CPU 任务才可并行。
9. 移除 Agent 仍可运行。Agent 只能增加语义判断、摘要、分诊和提案，不得成为确定性流程的单点依赖。

## 4. 目标拓扑

~~~text
运营人员 / API / 定时触发器
              |
              v
      Task Admission + Policy
              |
              v
      Workflow Controller
      (唯一运行状态拥有者)
       |       |        |       |
       v       v        v       v
   Browser   API     Validator  Commit /
   Worker   Worker              Reconcile
       |                         |
       v                         v
  Browser/API Adapters       Publication
       |                         |
       +------------+------------+
                    v
                Human Gate
                    ^
                    |
        Agent Runtime (proposal only)
          |          |          |
          v          v          v
       Read-only   Real model  Proposal
       evidence                validator

PostgreSQL: Run/Attempt/Lease/Approval/Proposal/Intent/Commit/Audit
Artifacts: CSV/XLSX/JSONL/图片/截图 + manifest + SHA-256
Feishu: 运营工作台和发布投影，不是恢复权威
~~~

## 5. 模块职责和依赖边界

### 5.1 Runtime 模块

| 模块 | 唯一职责 | 允许依赖 | 禁止依赖 |
| --- | --- | --- | --- |
| task_admission | 校验任务范围、授权、资源和配额，创建 run_id | Control Plane、Policy、Context Store | 浏览器 DOM、模型文本、外部写入 |
| workflow_controller | 推进 Run/Step/Attempt，管理暂停、恢复、取消、重试、人工闸门和 checkpoint | Context Store、Skill Registry、Validator、Commit/Reconcile | DOM selector、模型自行决定的状态、直接写平台 |
| context_store | 持久化当前运行上下文、阶段和版本，提供 CAS 更新 | PostgreSQL | evidence 原文、平台 DOM、LLM 记忆 |
| compression_service | 按规则压缩历史上下文并保留关键字段和原文引用 | Context Store、Evidence Store | 改变业务状态、删除原始证据 |
| memory_store | 保存和检索跨会话事实、规则、失败模式和偏好 | PostgreSQL、Evidence 索引 | 直接触发外部动作、替代当前运行状态 |
| skill_registry | 发现、校验、版本选择和依赖解析 Skill manifest | 文件系统、Schema Validator | 执行 Skill、访问平台资源 |
| skill_loader | 按已校验 manifest 装载能力实现 | Skill Registry | 任意动态代码、未声明副作用 |
| evidence_store | 保存不可变工件、manifest、摘要和验证引用 | 本地工件/未来 Object Storage、PostgreSQL 索引 | 决定恢复位置、修改原始工件 |
| side_effect_ledger | 登记写入、上传、付费调用和未知结果，提供幂等键 | PostgreSQL、Commit/Reconcile | 业务字段解析、Agent 决策 |
| validation_framework | 执行身份、范围、结构、行数、哈希、关系和回读验证 | 纯函数、Evidence Store | 修改业务状态、调用模型决定通过 |

### 5.2 Adapter 和业务模块

| 模块 | 唯一职责 | 依赖边界 |
| --- | --- | --- |
| browser_broker | 发放/续期/释放 BrowserProfile、账号、CDP session、tab 的短租约 | PostgreSQL、共享 Proxy；不暴露 Cookie/Token |
| browser_worker | 在获准 lease 内执行一次浏览器能力调用 | Browser Broker、Capability Adapter |
| sycm_adapter | 封装 SYCM 页面发现、分页、下载和源工件采集 | Browser Worker；输出 Observation/ArtifactRef |
| xws_adapter | 封装小旺神市场分析、SKU 和 FAQ 采集 | Browser Worker/API Worker |
| feishu_adapter | 封装授权副本的 schema 读取、写入、回读 | API Worker、Commit/Reconcile；不拥有任务状态 |
| workflow/* | 组合业务能力，定义阶段和领域验收 | Skill 接口、Context、Validator；不读 DOM |
| agent_runtime | 读取 bounded evidence，调用真实模型并持久化 proposal | 只读工具、Proposal Store、Proposal Validator |

依赖方向固定为：

~~~text
Workflow -> Capability/Skill -> Adapter/Worker -> External System
                 |
                 +-> Validator -> Commit/Reconcile -> Publication

横切能力：Context / Memory / Compression / Evidence / SideEffect Ledger
~~~

业务 Skill 不得直接持有数据库连接、全局运行状态或跨 Skill 状态源。现有 skills/ -> runtime/ 反向依赖应在迁移阶段逐步收敛；迁移前不得再扩大该依赖。

## 6. 统一 Context 契约

### 6.1 最小模型

~~~json
{
  "schemaVersion": "sop-context-v1",
  "taskId": "sop-<stable-id>",
  "runId": "<controller-assigned-uuid>",
  "parentRunId": null,
  "workflow": "xws.market-analysis",
  "capability": "xws.market-analysis.collect",
  "identity": {
    "tenantId": "<opaque-id>",
    "storeId": "<opaque-id>",
    "platform": "taobao",
    "accountId": "<opaque-id>",
    "browserProfileId": "<opaque-id>",
    "contractVersion": "<version>"
  },
  "stage": "COLLECT",
  "stepId": "collect-part-18",
  "attemptId": "attempt-<id>",
  "executionStatus": "RUNNING",
  "evidenceStatus": "CANDIDATE",
  "humanGateStatus": "NONE",
  "leaseStatus": "HELD",
  "publicationStatus": "NOT_REQUESTED",
  "verifiedCursor": { "start": 1, "end": 17, "version": 4 },
  "artifacts": [],
  "evidenceRefs": [],
  "sideEffectRefs": [],
  "decisions": [],
  "blocker": null,
  "nextAction": "COLLECT_PART_18",
  "contextVersion": 5,
  "updatedAt": "2026-09-13T00:00:00.000Z"
}
~~~

taskId 表示业务任务，runId 表示一次不可混淆的执行，attemptId 表示某阶段的一次尝试。模型不能创建或修改这些身份字段。

### 6.2 状态轴

执行、证据、人工、租约和发布必须分别表达：

~~~text
Execution: QUEUED / RUNNING / RETRY_WAIT / PAUSED / SUCCEEDED / FAILED
Evidence: NONE / CANDIDATE / VALIDATED / REJECTED
Human: NONE / WAITING_HUMAN / APPROVED / DENIED / EXPIRED
Lease: WAITING / HELD / EXPIRED / RELEASED
Publication: NOT_REQUESTED / READY / COMMITTED / VERIFIED / UNKNOWN
~~~

STALLED 只能作为阶段/分片诊断，不代表完成。COMMIT_UNKNOWN 必须经过对账才能转为确认状态。

### 6.3 Checkpoint 规则

每个步骤按以下顺序执行：

~~~text
读取 Context (带版本)
 -> 读取/申请合法 Lease
 -> 执行一次确定性动作
 -> 写入 Candidate Artifact / Observation
 -> Validator 验证
 -> 在事务中登记 checkpoint、证据引用和已确认副作用
 -> CAS 推进 verified cursor 或下一阶段
 -> 释放/续期 Lease
~~~

动作先发生而 checkpoint 后写是允许的；因此必须依赖幂等键和对账。checkpoint 不能只写本地文件。

## 7. 证据、记忆和上下文压缩

### 7.1 证据链

~~~text
Observation
  -> Candidate Artifact
  -> Validated Artifact
  -> Decision
  -> Idempotent Commit
  -> Publication Receipt
~~~

每个 Artifact/Receipt 至少绑定 runId、attemptId、范围、来源、生成时间、大小、SHA-256、验证结果和 schema 版本。原始大文件存工件位置，数据库只存索引和摘要。

### 7.2 记忆分层

| 类型 | 作用域 | 权威性 | 保存内容 |
| --- | --- | --- | --- |
| Run Context | 单次 run | 当前运行权威 | 阶段、游标、租约、下一动作、阻塞 |
| Evidence | 单次尝试/历史运行 | 事实证据 | 原始工件、manifest、验证收据 |
| Verified Fact | 项目/能力/平台 | 可复用事实 | 已验证字段、页面行为、接口事实 |
| Rule/Decision | 项目/用户/能力 | 治理规则 | 策略、偏好、架构决策和有效期 |
| Experience | 故障签名/能力版本/环境 | 候选提示 | 根因、修复、成功历史、置信度、退役状态 |

Evidence 不是 Memory，Memory 也不能覆盖当前运行证据。检索顺序必须是当前 run 证据 -> 项目规则 -> 已验证事实 -> 历史 experience。

### 7.3 压缩策略

压缩触发条件由 Context token/字节预算或阶段边界决定。压缩输出必须是结构化摘要，至少保留：

- 用户目标和授权范围；
- taskId/runId/stepId/attemptId；
- 当前五条状态轴；
- 已完成步骤和最后一个已验证游标；
- 已验证事实和 evidence 引用；
- 外部副作用及其 commitKey/provider reference；
- 人工闸门、阻塞原因和重试预算；
- 下一步唯一动作；
- 原始上下文 URI/digest、摘要版本和生成时间。

普通聊天、重复日志和已被 manifest 覆盖的原文可丢弃。压缩后必须执行 schema 校验和关键字段完整性校验；失败时保留原上下文并进入人工/维护状态。

## 8. Skill Manifest、Registry 和 Proposal

### 8.1 Skill manifest 最小字段

~~~yaml
name: xws.market-analysis.collect
version: 1.0.0
kind: capability
description: 采集小旺神市场分析分片
inputs:
  - name: report_window
    type: date_range
    required: true
outputs:
  - name: artifact
    type: artifact_ref
preconditions:
  - logged_in_taobao
  - edge_proxy_health
permissions:
  - browser.read
sideEffects:
  - local_artifact
dependencies:
  - adapter.xws@^1.0.0
validation:
  - source_identity
  - contiguous_prefix
  - artifact_integrity
recovery:
  supported: true
  resumeFrom: verified_cursor
~~~

Registry 必须在装载前校验名称、版本、输入输出、依赖、权限、副作用和验证器；缺失依赖、循环依赖、未声明副作用和 manifest/实现不一致都拒绝加载。Loader 只能装载已注册能力，不能执行任意路径或任意脚本。

### 8.2 Agent Proposal

Agent 输出只能是 proposal，最小字段为：

~~~json
{
  "schemaVersion": "agent-proposal-v1",
  "proposalId": "proposal-<stable-id>",
  "runId": "<controller-assigned>",
  "stepId": "<controller-assigned>",
  "attemptId": "<controller-assigned>",
  "taskType": "xws.failure_triage",
  "evidenceRefs": [{ "evidenceId": "<id>", "digest": "sha256:<digest>" }],
  "promptVersion": "supervisor-triage-prompt-v1",
  "model": "<provider/model>",
  "modelVersion": "<snapshot>",
  "confidence": 0.0,
  "riskClass": "LOW|MEDIUM|HIGH|HUMAN_REQUIRED",
  "requestedAction": "RETRY_EXPORT_PROFILE_V2|RECONCILE_COMMIT|ESCALATE_HUMAN",
  "parameters": {},
  "reason": "可审计的结构化理由",
  "expiresAt": "2026-09-13T00:00:00.000Z"
}
~~~

supervisor_proposals、supervisor_action_intents、supervisor_approvals 和 supervisor_commit_records 是现有持久化候选，新增实现应复用它们，不再创建同义表。Proposal Validator 必须独立检查 schema、run/attempt 作用域、证据 digest、动作注册、风险、权限、预算、过期时间和参数白名单。

Agent 允许的工具只能是 bounded read：运行摘要、最近事件、诊断摘要、Artifact manifest、Validator 结果和限定范围的历史经验。禁止浏览器点击/关闭、凭据读取、数据库写入、Feishu 写入、账号/店铺选择、游标推进、任意 shell 和 selector 修改。

## 9. 持久化职责和本轮迁移边界

### 9.1 权威分工

| 数据 | 权威存储 |
| --- | --- |
| Workflow history、timer、retry、signal | Durable Workflow 层（当前仍在 POC/演进） |
| Run、Attempt、verified cursor、Lease、Approval、Proposal、Intent、CommitRecord、审计索引 | 本项目业务库（xws_automation @ 127.0.0.1:5432） |
| CSV/XLSX/JSONL/图片/截图/trace 等不可变原始工件 | 当前本地工件；未来可接 Object Storage |
| Feishu 表和视图 | 运营工作台/发布投影 |
| 本地 JSON 和 events.jsonl | 诊断或缓存投影 |
| 本 Spec、架构决策和缺口目录 | docs/architecture/ + architecture schema |

### 9.2 004-architecture-catalog.sql 只保存架构元数据

本轮迁移新增独立 architecture schema，保存审查报告、能力评估、目标模块、架构缺口、实施阶段、决策和证据引用。它不重复 durable_runs、supervisor_commit_records 或业务表，也不成为运行时恢复权威。迁移文件为 db/migrations/004-architecture-catalog.sql，回滚文件为 db/migrations/004-rollback.sql。

### 9.3 数据治理

- 架构目录只保存最小必要事实、相对路径、摘要和 digest；不写密码、Cookie、Token、认证头或完整页面 payload。
- 初始审查记录使用固定 UUID 和 ON CONFLICT DO NOTHING，重复执行不会覆盖同事的后续修订。
- 回滚只删除本迁移创建的表，保留 architecture schema，避免误删未来表。
- 真实 apply 由被授权的同事在项目指定 PG 环境执行；本轮只提交迁移文件和 Spec。

## 10. 并发、恢复和失败处理

调度 lane 至少包含：

~~~text
tenant / store / platform / account / browserProfile / capability
~~~

- 同一账号/profile 默认并发 1；同一店铺写操作默认串行。
- 不同店铺、独立 API 和本地 CPU 任务可并行，但都必须绑定自己的 run/attempt/lease。
- Lease 必须有 owner、过期时间、心跳和释放回执；不认领未知 tab 或未知资源。
- Worker 被杀后从 PostgreSQL 的最后一个已验证且已提交边界恢复；不要从模型记忆、页面进度或本地 checkpoint 猜测。
- TRANSIENT_EXTERNAL 在预算内重试；RESOURCE_BUSY 回队列；HUMAN_REQUIRED 暂停；EVIDENCE_INVALID 拒绝工件；COMMIT_UNKNOWN 先对账；POLICY_DENIED 终止；BUG 告警并停止。
- Feishu 暂时不可用时，已验证源工件必须可复用，不得强制重新采集。

## 11. 最小接口形态

### 11.1 Capability/Adapter

~~~text
checkSession(context)
prepare(input, lease)
start(input, lease)
observe(attempt)
collectArtifact(attempt)
validate(artifact, context)
release(attempt, lease)
~~~

所有返回值必须是结构化 Observation、ArtifactRef、ValidationResult 或 ActionResult，不能只返回“成功/失败”字符串。

### 11.2 Validator

~~~text
validateIdentity(context, observation)
validateScope(context, artifact)
validateStructure(artifact, contract)
validateCompleteness(artifact, expectedRange)
validateDigest(artifact, manifest)
validateRelations(artifact, contract)
validatePublication(receipt, expected)
~~~

Validator 是纯确定性边界，不能被 Agent 绕过，也不能自行推进游标。

### 11.3 Commit/Reconcile

~~~text
prepareCommit(context, artifact, idempotencyKey)
commit(context, preparedCommit)
verifyCommit(context, commitRecord)
reconcileUnknown(context, commitRecord)
~~~

状态为 UNKNOWN 时只能进入 reconcileUnknown 或人工闸门；禁止直接重试写入。

## 12. 验收门槛

### 12.1 本轮 Spec/迁移验收

- 三份交接文档存在，且从架构 README 可导航到它们；
- 004-architecture-catalog.sql 只新增 architecture schema 对象，不修改现有业务表；
- SQL 使用显式约束、唯一键、外键、索引和幂等种子数据；
- 004-rollback.sql 按子表到父表顺序删除本迁移对象，不使用 DROP SCHEMA ... CASCADE；
- 文档没有把 POC 或目标能力写成已实现能力；
- git diff --check 通过，未跟踪运行产物不被加入本次变更。

### 12.2 后续实现验收

1. Worker 被杀后可以从 PostgreSQL 恢复，且不重复业务副作用。
2. commit-before-response 故障只产生一个业务效果，或进入可对账 UNKNOWN。
3. 浏览器断开、登录、验证码、风控和权限问题进入正确失败/人工状态。
4. partial artifact、错归属下载和错误范围不推进游标。
5. 同一账号/profile/写目标不会并发双写。
6. Agent 有真实 provider、受限只读工具、持久化 proposal 和独立 Validator；非法或越权 proposal 被拒绝。
7. 移除 Agent 后，采集、解析、验证和提交仍可运行。
8. Adapter 版本变化不修改 Workflow、权限或业务提交逻辑。
9. 每个发布字段可追溯到 source snapshot、validator evidence、commit record 和 publication receipt。

## 13. 暂缓决策

以下问题影响参数或部署方式，但不阻塞本 Spec 的边界：

- Temporal 是否在 S1 故障注入后保留；
- Object Storage 的供应商、留存和删除策略；
- 真实租户/店铺/账号拓扑和目标并发规模；
- Feishu 是否允许受控人工修改回写业务事实；
- Agent provider、模型版本、预算、数据出境和审批阈值；
- PII 分类、跨境、RPO/RTO、SLA 和通知渠道。

在这些决策完成前，不把 POC、单次成功回执或文档设计表述为生产级稳定能力。

