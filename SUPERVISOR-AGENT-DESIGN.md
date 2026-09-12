# 真正 Agent 系统设计：确定性执行层 + 受限提案层

> 状态：架构设计与实施路线，**不是已完成能力声明**。
> 日期：2026-09-12
> 适用范围：运营自动化中的 XWS、FAQ 及后续同类流程。

## 0. 结论先行

当前系统的问题不是“Agent 不够多”，而是**没有一条从权威状态到可验证结果的闭环**。现有代码已经有不少可靠的业务能力：XWS 有 PostgreSQL 状态、游标、租约和重试合同；FAQ 有阶段状态、人工队列和发布回读；多个 Skill 有 CSV/XLSX 校验和 dry-run。但这些能力仍由脚本分别拥有，彼此之间没有统一的耐久运行合同。

因此，当前仓库中的“监督 Agent”必须准确定位为：

> `runtime/supervisor-agent/` 是一个确定性故障分诊原型，带有可选的单次 LLM 诊断钩子；它不是生产 Agent Runtime，也不是 Durable Workflow。

这个判断由代码事实直接推出：

- [runtime/supervisor-agent/diagnose.mjs](runtime/supervisor-agent/diagnose.mjs) 的经验匹配和规则分类是普通确定性函数，不是 Agent。
- [runtime/supervisor-agent/llm.mjs](runtime/supervisor-agent/llm.mjs) 目前只是一次 HTTP 请求，没有受限工具、proposal 持久化、独立策略闸门或会话恢复。
- [runtime/supervisor-agent/supervisor-agent.mjs](runtime/supervisor-agent/supervisor-agent.mjs) 的 executor 依赖注入适合测试；CLI 没有接入真实动作执行器，`--apply` 不能自行产生生产动作闭环。
- [agent-runtime/temporal/activities.mjs](agent-runtime/temporal/activities.mjs) 中的 `observePage`、`executeAction`、`commitArtifact`、`releaseLease` 是 fake adapter；其 `Set` 和模块级变量在进程重启后全部消失。
- [agent-runtime/temporal/workflows.mjs](agent-runtime/temporal/workflows.mjs) 只接受单页、内存拼装输入，不能证明真实浏览器采集、真实 PostgreSQL cursor、真实工件校验或恢复。
- [runtime/run-flow-orchestrator.mjs](runtime/run-flow-orchestrator.mjs) 能推进 FAQ/XWS 的确定性流程，但子进程失败目前主要变成抛错或终止报告，并没有把完整故障证据交给一个可恢复的监督控制循环。

真正的目标不是让模型“接管流程”，而是建立下列边界：

1. **确定性代码拥有状态、资源、验证和写入。**
2. **模型只读取已授权证据，并产生结构化 proposal。**
3. **独立的 Schema、Evidence、Policy Validator 决定 proposal 是否可被采纳。**
4. **Workflow 根据已批准的 action intent 调用注册能力，Agent 永远不直接执行业务动作。**
5. **任何恢复都从进程外权威状态和已验证游标开始，而不是从模型记忆、内存 checkpoint 或日志猜测。**
6. **没有真实模型调用、受限工具、越权拒绝和进程故障证据，就不能称为“真正 Agent 系统”。**

---

## 1. 先定义问题：运营自动化到底需要什么

运营人员真正要完成的不是“和多个 Agent 聊天”，而是：

- 在指定周期和指定业务范围内采集数据；
- 识别数据是否属于本次任务、是否完整、是否可验证；
- 在平台需要登录、验证码、风控或授权时停下来交给人；
- 在浏览器断开、下载延迟、插件卡停或进程崩溃后，从正确位置继续；
- 把验证过的结果以幂等方式写入指定目标，并能证明写入结果；
- 对无法用规则判断的语义问题给出分类、摘要或故障解释；
- 下一次遇到同类故障时少走弯路，但不把一次错误经验永久固化。

其中只有最后一部分中的“语义判断”和“异常解释”天然适合概率模型。采集、游标、校验、锁、提交和发布不是智能问题，而是**一致性问题**。把一致性问题交给 LLM，会把原来的可测试错误变成不可审计的随机错误。

### 1.1 成功的最小定义

一个流程只有在以下条件全部满足时才算成功：

```text
目标范围已明确
  + 本次工件身份归属已验证
  + 工件完整性已验证
  + 业务决策引用了验证证据
  + 外部副作用有幂等 CommitRecord
  + 外部系统回读与预期一致
  + 权威游标已 CAS 推进
  + 租约已确认释放
= 可审计的成功
```

“页面显示完成”“子进程 exit code 为 0”“本地有一个 JSON”“模型说成功”“tab 还开着”都不能单独证明成功。

---

## 2. 第一性原理：从物理事实推导架构

### 公理 1：外部平台是不可靠且持续变化的

Edge、CDP Proxy、淘宝/SYCM/XWS/灰豚页面、插件请求和下载通道都可能变化。当前 XWS 真实运行在第 20 页 `STALLED`，且共享 Proxy 的 `browser.id` 与安全合同不一致，这已经证明“代码测试通过”不等于“真实外部世界可用”。

**推论：**平台细节必须封装在 Adapter/Worker 内。工作流只能依赖 `prepare/start/observe/collect/validate/release` 等业务能力接口，不能依赖 selector、按钮文本、target ID 或插件内部请求格式。页面变化只能使能力版本降级或进入人工状态，不能让 Agent 自动修改生产 selector。

### 公理 2：任何进程都可能在任意两条指令之间死亡

崩溃可能发生在“文件已写入、响应未返回”“Feishu 已提交、回执未收到”“租约已持有、释放未记录”的瞬间。

**推论：**必须有进程外的权威状态。当前最小可行组合是：

- PostgreSQL：Run、Step、Attempt、verified cursor、Lease、Approval、Proposal、CommitRecord 和审计索引；
- 不可变工件：CSV/XLSX/JSONL、图片、截图及其 digest；
- 本地 `events.jsonl`：诊断投影，不是恢复权威；
- Feishu：运营工作台和发布投影，不是恢复位置权威。

恢复的定义是“重新读取权威状态，找到最后一个已验证且已提交的边界，再从下一个合法位置继续”，不是“重跑上一次命令”。

### 公理 3：观察不等于事实，单次观察也不可信

文件名可能过期，页码选择器可能先变而表格仍在渲染旧数据，下载可能属于上一轮请求，页面行数可能与文件行数不一致。

**推论：**所有结果必须经过统一证据链：

```text
Observation
  -> Candidate Artifact
  -> Validated Artifact
  -> Decision
  -> Idempotent Commit
  -> Publication Receipt
```

每一层都必须有不可混淆的身份、范围和 digest。没有验证的候选工件不能推进游标，也不能触发发布。

### 公理 4：外部写入是副作用，至少一次执行是常态

Worker 可能在提交成功后、收到响应前崩溃；重试时无法直接知道第一次是否完成。

**推论：**不能追求“调用一次所以只写一次”，而要设计为“调用可至少一次，但业务效果幂等”：

- 生成稳定的 `idempotencyKey`；
- 提交前写入或预留 CommitRecord；
- 外部写入使用幂等键或可回读的业务唯一键；
- 结果不确定时进入 `COMMIT_UNKNOWN` 对账；
- 禁止盲目重写；
- 只有回读验证通过后才推进业务游标。

### 公理 5：人工不是异常，而是系统组成部分

登录、验证码、扫码、风控、权限、额度和发布授权都需要人参与。绕过它们既不安全，也不符合业务现实。

**推论：**人工闸门必须是一等持久化状态：

```text
NONE -> WAITING_HUMAN -> APPROVED
                    \-> DENIED
                    \-> EXPIRED
```

人工处理后只恢复当前 Run/Step/Attempt，不创建新身份、不重置已验证游标、不重复写入已确认提交。

### 公理 6：模型输出是概率性的

同一输入不能假设得到同一文本；模型可能漏字段、捏造证据、误解故障或提出越权动作。

**推论：**模型不拥有业务状态。模型只能：

- 读取最小化、已授权、边界明确的结构化证据；
- 进行语义分类、摘要、异常解释或人工队列候选；
- 输出带 schema、版本、证据引用、置信度和过期时间的 proposal。

独立 Validator、Policy 和 Workflow 才能决定是否采纳。

### 公理 7：物理瓶颈通常是一个，而不是多个

当前是一个 Edge profile、一个共享 CDP Proxy、一个已登录账号和有限平台额度。增加 10 个 Agent 不会产生第二个浏览器、第二份登录态或第二份额度。

**推论：**并发按资源 lane 设计，而不是按 Agent 数量设计：

```text
tenant / store / platform / account / browserProfile / capability
```

同一账号/profile 默认串行；浏览器采集、API 操作和本地 CPU 分开限流；FAQ 只有在明确独立资源和失败隔离后才做商品级 fan-out。

### 公理 8：运营人员不应承担机器内部复杂度

输入应能是自然语言或少量明确参数，输出应说明“现在是什么状态、为什么停、下一步需要谁做什么”。

**推论：**需要一个薄的翻译层，但翻译层不是状态拥有者：

```text
自然语言 -> 结构化任务建议 -> 确定性准入/状态机
权威状态 -> 结构化结果 -> 人话报告
```

模型可以协助解析和解释，但不能用自然语言决定周期有效性、写入目标或完成状态。

---

## 3. 对现有 SUPERVISOR 设计的纠偏

### 3.1 “三级诊断”不是三级 Agent

当前设计把“经验匹配 → 规则诊断 → LLM 诊断”称为三级降速，这个描述容易造成概念污染：

| 当前层 | 本质 | 是否 Agent |
|---|---|---:|
| 经验签名匹配 | 确定性查表 | 否 |
| `ruleTriage()` | 正则与状态规则 | 否 |
| `llmTriage()` | 一次模型调用 | 是，但目前只是模型适配器原型 |

经验匹配和规则诊断应保留，因为它们便宜、可测试、可解释；但只有第三层在真实调用模型并受工具、schema 和策略约束时，才是 Agent 的概率内核。

### 3.2 `executor` 依赖注入不是生产动作系统

当前 `handleIncident()` 接受 `executors`，测试可以注入桩函数，这很好地支持单元测试；但生产系统不能把“调用方传入一个函数”当作权限边界。真正的生产动作必须有：

- 版本化 Capability Registry；
- Workflow 生成的 `runId/stepId/attemptId` 上下文；
- 资源 Lease 和作用域检查；
- 参数 JSON Schema、数值范围和字段白名单；
- 幂等 ActionIntent/CommitRecord；
- 预算、超时和取消；
- 独立的动作结果验证；
- 全链路审计。

Agent 可以请求 `RETRY_EXPORT`，不能自行调用导出函数。它可以请求“提高导出等待上限到预注册的 120 秒档位”，不能传入任意命令行、任意路径或任意 selector。

### 3.3 本地 `experience.json` 不能成为记忆权威

经验可以从本地 JSON 起步作为**版本化候选策略快照**，但不能承担并发写入、审计和恢复责任。生产经验需要至少绑定：

```text
signature
failureClass
capabilityVersion
environmentFingerprint
observedEvidenceDigest
remedyVersion
success/failure history
confidence
needsReview / retired
createdAt / expiresAt
```

经验命中只能提供 hint，不能绕过当前证据验证。应用失败必须降权；环境、浏览器或能力版本变化时必须进入待复核，而不是继续自动使用。

### 3.4 `events.jsonl` 只能是投影

事件流对诊断很有用，但它可能因进程崩溃、磁盘失败、缓冲未 flush 或双写顺序而不完整。若 PostgreSQL 和事件文件不一致，不能挑一个“看起来更合理”的结果；应记录 `EVIDENCE_UNKNOWN`，进入对账或人工状态。

事件流应包含：

- `runId/stepId/attemptId`；
- 单调递增 sequence；
- 事件类型和 schema 版本；
- 关联 artifact/commit digest；
- 产生者和时间；
- 是否已由权威状态确认。

### 3.5 “重启流程”不是通用修复

当前设计中的 `restart_flow_with_params` 过于宽泛。重启可能改变身份、重复采集、覆盖正确游标或扩大对外压力。生产中应将其拆成预注册动作，例如：

```text
RETRY_SAME_ATTEMPT_RANGE
RETRY_EXPORT_WITH_TIMEOUT_PROFILE_V2
RESUME_FROM_VERIFIED_CURSOR
OPEN_HUMAN_LOGIN_GATE
RECONCILE_UNKNOWN_COMMIT
```

每个动作都有固定参数 schema、适用故障类别、最大次数、冷却时间和验证条件。Agent 不能请求“执行任意脚本”“清理所有 tab”“删除旧数据”“重置数据库”“重新选择账号”。

### 3.6 “状态改善”不能只看 status

`status` 从 `STALLED` 变成 `RUNNING` 不足以证明修复成功。至少应证明：

- 同一 `runId` 的新 `attemptId` 已创建；
- 使用了合法且仍有效的 Lease；
- 新尝试的工件属于目标范围；
- artifact digest 通过验证；
- verified cursor 按 CAS 推进；
- 没有新增重复 CommitRecord；
- 若存在外部写入，PublicationReceipt 回读一致；
- 最终租约释放已确认。

---

## 4. 真正 Agent 系统的最小拓扑

```text
运营人员 / API / 定时触发器
              |
              v
      Task Admission + Policy
              |
              v
   Durable Run Controller
   （唯一运行状态拥有者）
      |       |       |       |
      v       v       v       v
 Browser   API    Validator  Commit /
 Worker   Worker              Reconcile
      |                       |
      v                       v
 Browser/API Adapter       Publication
      |                       |
      +----------+------------+
                 v
              Human Gate
                 ^
                 |
       Agent Runtime（仅 proposal）
          |       |       |
          v       v       v
    只读证据工具  真实模型  Proposal Validator

PostgreSQL：Run/Step/Attempt/Cursor/Lease/Approval/Proposal/CommitRecord/Audit
不可变工件：CSV/XLSX/JSONL/图片/截图 + EvidenceManifest + SHA-256
Feishu：运营工作台与发布投影，不是恢复权威
```

### 4.1 Task Admission + Policy

负责把运营意图绑定到已经授权的能力和资源：

- 确认周期、业务范围和目标能力；
- 确认允许使用的店铺、账号、profile 和目标表；
- 创建不可混淆的 `runId`；
- 检查并发 lane、额度、权限和人工授权要求；
- 拒绝缺少范围、目标或授权的任务。

它不执行浏览器动作、不调用模型来决定权限，也不接受 Agent 自己选择的账号或写入目标。

### 4.2 Durable Run Controller

这是唯一能推进执行状态的组件。可以先由 PostgreSQL + 可重启的确定性 controller 实现；是否使用 Temporal 必须由故障注入结果决定，而不是由框架名称决定。

它拥有：

- `Run/Step/Attempt` 生命周期；
- 心跳、超时、重试、暂停、恢复和取消；
- Lease 获取与释放；
- Human Gate；
- proposal 到 action intent 的批准转换；
- 对每个阶段设置恢复点。

它不拥有 DOM 细节，也不把模型输出直接当成状态转移。

### 4.3 Adapter/Worker

Adapter 负责平台特有交互，Worker 负责执行一次受授权的能力调用。推荐接口：

```text
checkSession()
prepare(input, lease)
start(input, lease)
observe(attempt)
collectArtifact(attempt)
release(attempt, lease)
```

所有输出都是结构化 Observation 或 ArtifactRef；不能只返回“成功/失败”字符串。Worker 只能使用 controller 发放的 Lease，不能扫描、关闭或认领未知浏览器资源。

### 4.4 Validator

Validator 必须独立于 Agent 和采集 Worker。最少验证：

- 任务、账号、周期、平台和采集合同归属；
- 页码/范围和已验证游标关系；
- 文件存在、大小、格式、ZIP/XLSX 可读性；
- 行数、连续唯一排名、关键字段、图片数量；
- SHA-256 和 manifest 一致性；
- 数据是否已被当前尝试产生；
- 提交前后的内容与 schema；
- 发布后的外部回读。

### 4.5 Commit/Reconcile

提交组件把已验证工件变成业务事实。它必须区分：

```text
NOT_REQUESTED -> READY -> COMMITTING -> COMMITTED -> VERIFIED
                                  \-> UNKNOWN -> RECONCILING
```

`UNKNOWN` 不是失败，也不是成功；必须先通过幂等键、查询接口或回读对账确定结果，再决定继续、补偿或人工处理。

### 4.6 Agent Runtime

Agent Runtime 只拥有一次**受限提案会话**：

1. 接收 controller 提供的任务上下文和证据引用；
2. 通过只读工具查看限定范围内的证据；
3. 真实调用模型；
4. 生成 proposal；
5. 保存 proposal 原文摘要、digest、模型/提示版本和结果；
6. 交给独立 Validator/Policy；
7. 只返回 `VALIDATED`、`REJECTED` 或 `NEEDS_HUMAN`。

Agent Runtime 不直接调用浏览器、飞书、PostgreSQL 写接口、凭据文件或任意 shell。

---

## 5. Agent 合同：Proposal 而不是命令

### 5.1 最小 Proposal Schema

下面是概念合同；实现时应落成 JSON Schema 并版本化：

```json
{
  "schemaVersion": "agent-proposal-v1",
  "proposalId": "proposal-<stable-id>",
  "runId": "<controller-assigned-run-id>",
  "stepId": "<controller-assigned-step-id>",
  "attemptId": "<controller-assigned-attempt-id>",
  "taskType": "xws.failure_triage",
  "evidenceRefs": [
    {
      "evidenceId": "evidence-<id>",
      "kind": "postgres_receipt",
      "digest": "sha256:<digest>",
      "scope": "same-run-attempt"
    }
  ],
  "promptVersion": "supervisor-triage-prompt-v1",
  "model": "<provider/model>",
  "modelVersion": "<provider-version-or-snapshot>",
  "confidence": 0.0,
  "riskClass": "LOW|MEDIUM|HIGH|HUMAN_REQUIRED",
  "requestedAction": "ESCALATE_HUMAN|RETRY_EXPORT_PROFILE_V2|RECONCILE_COMMIT",
  "parameters": {},
  "reason": "结构化、可审计的简短理由",
  "expiresAt": "2026-09-12T00:00:00.000Z"
}
```

### 5.2 Proposal 不变量

- `runId/stepId/attemptId` 由 Controller 提供，模型不能创建或替换。
- 每个 `evidenceRef` 必须存在于授权范围，digest 必须匹配；自由文本不能作为证据引用。
- `requestedAction` 必须来自 Capability Registry，未知 action 直接拒绝。
- `parameters` 只能符合该 action 的 JSON Schema；未知字段、任意路径、任意命令和任意 selector 直接拒绝。
- proposal 只能处于 `PROPOSED/VALIDATED/REJECTED/APPROVED/EXPIRED`，不能直接把 Run 置为完成。
- 低置信度、证据不足、平台控制、登录、写入和发布风险默认进入人工闸门。
- 同一输入 evidence digest、prompt version、model version 和 proposal payload 重放时，Validator 结果必须一致。
- 保存模型输出时只保存审计所需的最小内容，不能保存密码、Cookie、Token、认证头或完整敏感页面 payload。
- proposal 必须有过期时间；过期 proposal 不能在新 Attempt 中复用。

### 5.3 Agent 允许和禁止的工具

**允许的只读工具：**

```text
getRunSummary(runId, stepId, attemptId)
getRecentEvents(runId, limit <= 50)
getDiagnosticSummary(attemptId)
getArtifactManifest(evidenceId)
getValidatorResult(evidenceId)
getHistoricalExperience(signature, capabilityVersion)
```

**禁止的工具：**

```text
browser.click / browser.evaluate / browser.close
readCredentials / readCookie / readBrowserStorage
feishu.write / postgres.write / filesystem.delete
chooseAccount / chooseStore / chooseTarget
runShell / executeArbitraryScript / modifySelector
approveOwnProposal / advanceCursor / markDone
```

工具层还必须强制：调用次数上限、响应大小上限、字段脱敏、run/attempt 作用域和只读数据库账号。仅仅在 system prompt 中写“不要做危险动作”不构成安全边界。

---

## 6. 监督控制循环

```text
1. load authoritative state
2. detect anomaly from DB heartbeat/cursor/attempt + independent process signals
3. collect bounded evidence snapshot
4. lookup experience as a hint
5. run deterministic triage
6. invoke real Agent only for unknown/semantic cases
7. validate proposal: schema + evidence + policy + budget
8. create ActionIntent or HumanGate
9. Workflow executes registered action with lease and idempotency
10. verify cursor/artifact/commit/publication against authority
11. record postmortem and experience outcome
12. wait for next event or durable timer
```

### 6.1 检测条件

检测不能只看一个信号。最小信号源：

- PostgreSQL receipt 的 heartbeat、execution 状态和 verified cursor；
- Attempt 是否仍有合法 Lease；
- Worker/process 是否存活；
- `events.jsonl` 是否有新的、可关联的进度投影；
- 关键工件是否按合同落盘；
- 是否出现 `HUMAN_REQUIRED`、`PARTIAL_EXPORT_FAILED`、`COMMIT_UNKNOWN` 等明确事件。

应区分：

- `STALLED`：某阶段没有进展；
- `FAILED`：已确定失败；
- `HUMAN_REQUIRED`：需要人工，不是系统异常；
- `UNKNOWN`：证据不足，不能推断成功或失败。

“两个信号同时异常触发 triage”可以作为降低误报的默认策略，但不能用它掩盖权威状态缺失；没有 DB 权威状态时，应直接进入 `UNKNOWN/HUMAN_REQUIRED`。

### 6.2 诊断优先级

```text
环境/数据一致性检查
  -> 已验证经验提示
  -> 确定性故障分类
  -> 真实模型语义分诊
  -> 人工
```

经验和规则可以直接决定 `ESCALATE_HUMAN`，但任何自动修复都必须再次经过当前 Run 的证据、策略和预算检查。模型不能因为“历史上这么修过”绕过当前验证。

### 6.3 ActionIntent

Proposal 通过 Validator 后仍不等于可执行。Controller 需要创建独立的 ActionIntent：

```json
{
  "intentId": "intent-<idempotent-id>",
  "proposalId": "proposal-<id>",
  "runId": "<run>",
  "attemptId": "<attempt>",
  "action": "RETRY_EXPORT_PROFILE_V2",
  "parameters": { "profile": "download-120-stall-900" },
  "policyDecision": "APPROVED|HUMAN_REQUIRED|DENIED",
  "idempotencyKey": "<run>:<attempt>:<action>:<profile>",
  "expiresAt": "..."
}
```

ActionIntent 是 Workflow 的输入，不是 Agent 的直接调用出口。

### 6.4 修复后的验证

自动修复只有在以下证据全部成立时才算成功：

```text
同一 Run 的新 Attempt 已登记
  + 合法 Lease 已取得
  + 目标范围未扩大
  + 新观察与工件已产生
  + Validator 通过
  + cursor CAS 从 old 推进到 new
  + CommitRecord 没有重复业务效果
  + PublicationReceipt（若适用）回读一致
  + Lease release 已确认
```

否则：

- 不写入新经验；
- 将当前经验标记为应用失败并降权；
- 保存 postmortem；
- 进入人工或 `COMMIT_UNKNOWN` 对账；
- 停止继续扩大请求量。

---

## 7. 状态、权威和恢复合同

### 7.1 状态必须拆开

禁止用一个模糊的 `status` 表达所有含义。最少拆成：

| 维度 | 状态 |
|---|---|
| Execution | `QUEUED / RUNNING / RETRY_WAIT / PAUSED / SUCCEEDED / FAILED` |
| Evidence | `NONE / CANDIDATE / VALIDATED / REJECTED` |
| Human Gate | `NONE / WAITING_HUMAN / APPROVED / DENIED / EXPIRED` |
| Lease | `WAITING / HELD / EXPIRED / RELEASED` |
| Publication | `NOT_REQUESTED / READY / COMMITTING / COMMITTED / VERIFIED / UNKNOWN` |

失败分类至少包括：

```text
TRANSIENT_EXTERNAL
RESOURCE_BUSY
HUMAN_REQUIRED
CAPABILITY_DEGRADED
EVIDENCE_INVALID
POLICY_DENIED
COMMIT_UNKNOWN
BUG
```

### 7.2 权威职责

| 数据 | 权威职责 | 当前定位 |
|---|---|---|
| Durable Workflow history | timer、重试、暂停、恢复和执行历史 | 尚需真实故障注入证明 |
| PostgreSQL | 业务事实、verified cursor、Lease、Approval、CommitRecord | XWS 已有可复用模式 |
| 不可变工件 | 原始文件、图片、截图和 manifest | 本地先做，后续可换 Object Storage |
| Feishu | 运营工作台、人工编辑、发布投影 | 不能决定恢复位置 |
| `events.jsonl` | 诊断和进度投影 | 丢失或冲突时不能当权威 |
| 本地 JSON | 临时缓存或输出快照 | 不得决定业务完成或恢复位置 |

### 7.3 恢复规则

恢复必须按下列顺序：

1. 通过 `runId` 读取 PostgreSQL 权威状态；
2. 校验 Run 的租户/店铺/平台/账号/合同身份；
3. 找到最后一个已验证、已提交的 cursor；
4. 查询对应 Attempt、artifact digest 和 CommitRecord；
5. 如果提交状态为 `UNKNOWN`，先对账，不采集、不重写；
6. 如果 Lease 过期，按资源合同重新申请，不认领未知资源；
7. 只从下一个授权范围开始；
8. 新 Attempt 产生新事件和新 artifact，不能覆盖旧证据；
9. 释放旧 lease 的结果必须可验证。

---

## 8. 与当前代码的落地映射

### 8.1 保留并复用

- [runtime/run-flow-orchestrator.mjs](runtime/run-flow-orchestrator.mjs)：保留 FAQ/XWS 的确定性状态决策、阶段预算和事件投影；不能改成 LLM 调度器。
- [skills/xws-export-market-analysis/scripts/postgres-state.mjs](skills/xws-export-market-analysis/scripts/postgres-state.mjs)：复用其 PostgreSQL 状态、CAS、verified cursor 和租约思想，抽出稳定的 Run/Attempt 合同。
- XWS 的 `validate-output.py`、CSV/XLSX 校验和现有 candidate/publication receipts：作为 Validator 的事实基础。
- FAQ 的 operator status、人工 review queue、AI review artifact 和发布回读：作为人工闸门和语义 Agent 的事实基础。
- [runtime/supervisor-agent/diagnose.mjs](runtime/supervisor-agent/diagnose.mjs)：保留为 `deterministic-triage`，补充输入校验和结构化故障 evidence，不称为 Agent。
- [runtime/supervisor-agent/actions.mjs](runtime/supervisor-agent/actions.mjs)：保留白名单和预算的纯策略部分；把生产动作改为预注册 Capability/ActionIntent，不允许任意 executor 形成隐性写路径。

### 8.2 必须重新设计的部分

1. **监督输入**：不再只读一个人工拼装的 incident JSON；由 Controller 根据权威 Run/Attempt 生成有 digest 的 EvidenceSnapshot。
2. **Agent 调用**：`llm.mjs` 从一次 HTTP 诊断钩子演进为 provider adapter + 只读 tool broker + proposal persistence。provider 可是 OpenAI-compatible 或其他端点，但协议必须被独立适配器隔离。
3. **Proposal Validator**：新增独立模块，执行 schema、证据引用、能力注册、参数范围、风险和过期校验；Agent 输出非法时整体拒绝。
4. **持久化**：经验、proposal、action intent、approval、commit 和验证结果不能只靠文件；先在 PostgreSQL 建最小表或明确的现有表扩展，任何迁移先形成可执行 schema 和回滚路径。
5. **故障入口**：Controller 捕获子进程退出、心跳超时和状态异常后创建 Incident/EvidenceSnapshot，再调用监督流程；不把异常抛出后就结束。
6. **执行边界**：监督模块只创建 `ActionIntent` 或 `HumanGate`，由确定性 Workflow 执行预注册动作。
7. **现有 Temporal POC**：在替换 fake adapter 前，先按下文 S1 的真实验收逐项补证据；在此之前文件必须持续标注 prototype。

### 8.3 当前实现不能作为验收证据的项目

以下都不能单独证明系统已实现 Agent 或 Durable Workflow：

- `runLocalVerticalSlice()` 的内存 checkpoint；
- `commitKeys = new Set()` 的幂等模拟；
- 模块级 `leaseReleased`；
- `fake.browser.export` capability；
- 测试中注入的 `fakeFetch`；
- 仅调用 Temporal SDK handler；
- 进程内 shutdown/restart；
- 只看子进程退出码；
- 一份没有与当前代码版本绑定的历史 verification receipt；
- 模型输出“成功”的自然语言。

---

## 9. 分阶段实施：先闭环，再智能化

### S0：事实、边界和门禁

**目标：**让系统状态可信，而不是增加模型。

工作：

- 冻结现有 XWS/FAQ 可用入口和 CLI 合同；
- 明确 `runtime/` 是编排与运维入口，不是业务权威；
- 将 `agent-runtime/`、Temporal 和当前 supervisor 标为 prototype；
- 定义 Run/Step/Attempt/Evidence/Approval/CommitRecord 的最小 schema；
- 统一 `test:unit`、`test:runtime`、`test:integration` 和离线入口；
- 为 `events.jsonl` 增加 run/attempt/sequence/digest 关联约定；
- 不接新 LLM 框架，不引入 Agent swarm，不修改飞书字段和现有业务合同。

**完成条件：**任何文档、测试或命令都不会把原型称为生产能力；变更能通过离线和确定性回归门禁。

### S1：XWS 单分片确定性耐久闭环

**目标：**在没有 Agent 的情况下证明“能真实执行、验证、提交、恢复”。

垂直路径：

```text
Task Admission
  -> PostgreSQL Run/Attempt/Lease
  -> 真实 XWS Adapter 采一个授权分片
  -> 真实 CSV/XLSX Validator
  -> EvidenceManifest
  -> 幂等 CommitRecord
  -> 外部回读/PublicationReceipt
  -> cursor CAS
  -> lease release
```

必须做的故障注入：

- 独立 Worker 进程在采集前、采集后、验证后被杀；
- commit-before-response 后重复调用；
- 浏览器断开和 Proxy health 不满足；
- Lease 过期、孤儿资源和重复认领；
- partial artifact、迟到下载和错归属文件；
- retry budget 耗尽；
- commit 状态未知后的对账；
- 验证失败时 cursor 不得推进。

**完成条件：**每一项有真实外部进程/数据库/文件证据；进程内 fake adapter 不计入。

### S2：真实 Agent 提案切片

**目标：**在已经有真实故障证据的 XWS 单分片上证明 Agent 的真实性和边界。

实现：

- 只读 Tool Broker 只允许读取 bounded evidence；
- 真实调用配置的模型 provider；
- 保存 proposal 的 schemaVersion、证据 digest、prompt/model version 和结果；
- 独立 Validator 拒绝非法 JSON、未知证据、越权 action、越界参数和过期 proposal；
- 先只允许两个 action：`ESCALATE_HUMAN` 和一个固定参数 profile 建议；
- 用故意返回的“读 Cookie”“删除文件”“任意 shell”“选择账号”等 proposal 验证 fail-closed；
- 模型不可用时走规则或人工，不影响确定性业务流程。

**完成条件：**移除模型后 S1 仍能运行；真实模型调用有 provider 证据；Agent 不能直接执行任何业务写入。

### S3：监督处置闭环

**目标：**让已验证 proposal 能在确定性 Workflow 中安全转化为动作。

实现：

- Proposal Validator 通过后生成 ActionIntent；
- Policy 检查风险、预算、冷却和当前 Run 身份；
- Workflow 获取 Lease 并执行注册能力；
- ActionResult 与前后 EvidenceManifest 绑定；
- 通过 cursor/commit/publication 回读验证改善；
- 失败不写新经验，已有经验降权；
- 成功才写入带环境和能力版本的经验；
- 所有人工、拒绝、未知和预算耗尽路径可恢复、可审计。

### S4：FAQ 商品级 fan-out

**目标：**验证有限并行、失败隔离和人工审查，而不是建立无限 Agent swarm。

前提：S1-S3 已经证明 Run/Attempt/Lease/Approval/Commit 合同。每个商品任务有独立 Attempt 和证据，单个商品失败不能污染其他商品；同一浏览器/profile 仍遵守并发 1；FAQ AI review 继续是语义 proposal/结果，经质量门和人工队列后才进入发布。

### Temporal 的采用条件

Temporal 不是“真正 Agent”的定义。只有当 S1 证明以下需求确实存在时才引入或保留它：

- Worker 跨进程部署和替换；
- 长时间 timer、暂停和恢复；
- 多 Worker 的任务分发；
- 复杂重试拓扑无法由当前 PostgreSQL + controller 安全表达。

即使采用 Temporal，PostgreSQL 仍负责业务事实、verified cursor、Lease、CommitRecord 和发布回读；模型仍只拥有 proposal。

不在 S1 之前同时引入 Temporal、LangGraph、ADK、AutoGen 或 AgentTeams。框架数量不能替代故障模型和证据。

---

## 10. 真实验收矩阵

| 场景 | 必须看到的证据 | 正确结果 |
|---|---|---|
| 正常单分片 | validated artifact、CommitRecord、cursor CAS、release receipt | `SUCCEEDED + VERIFIED` |
| Worker 被杀 | 独立进程退出；重启后读取 PG | 从最后 verified cursor 恢复，不重复提交 |
| commit-before-response | 外部写入与响应故意分离 | 重试只有一个业务效果，或进入对账 |
| 浏览器断开 | Proxy/Adapter 失败证据 | `TRANSIENT_EXTERNAL` 或 `HUMAN_REQUIRED`，不伪造完成 |
| 登录/验证码/风控 | 页面/Adapter 明确控制证据 | 持久化 Human Gate，禁止绕过 |
| 迟到/错归属下载 | 文件 digest、时间、attempt 绑定失败 | `EVIDENCE_INVALID`，不推进 cursor |
| partial artifact | 行数/范围/结构校验失败 | 拒绝工件，不重试同一坏证据 |
| Agent 正常提案 | 真实 provider、proposal、证据 digest | 进入 Validator，不直接执行 |
| Agent 非法 action | proposal 含未知工具/任意路径/写操作 | 整体 `REJECTED`，审计拒绝理由 |
| Agent 证据越权 | 引用其他 run 或不存在 digest | 整体 `REJECTED` |
| LLM 超时/非法 JSON | provider timeout/parse failure | 规则兜底或人工，不阻塞确定性路径 |
| 低置信度 | confidence 和风险策略 | `WAITING_HUMAN` |
| 预算耗尽 | action ledger、retry count、cooldown | 停止自动动作并升级人工 |
| 经验命中 | 当前 evidence 仍通过；版本/环境匹配 | 可提供固定 hint，仍需验证 |
| 经验应用失败 | 前后验证证据 | 降权/退役，不继续循环 |
| 人工批准 | PG Approval、操作者和时间 | 只恢复原 Run/Attempt 的允许动作 |
| 人工拒绝/过期 | 持久状态和审计 | 终止或重新申请，不自动猜测 |
| 发布未知 | CommitRecord `UNKNOWN` | 先对账，禁止盲目重写 |
| 租约过期 | Lease owner、expiry、release receipt | 不认领未知资源，重新申请 |

以下不计入验收：

- hardcoded decision；
- fake adapter；
- 进程内模拟重启；
- 仅调用 SDK handler；
- 仅检查 exit code；
- 只有模型文本没有 proposal/validator/audit；
- 只有“状态变了”没有 artifact、cursor 和 commit 证据。

---

## 11. 不做什么

在上述闭环完成前，明确不做：

- 多个 LLM 自主对话、互相委派的 Agent swarm；
- 让 Agent 直接采集、点击、关闭 tab、写 PostgreSQL、写 Feishu 或发布；
- 让 Agent 选择租户、店铺、账号、浏览器 profile 或写入目标；
- 让 Agent 自动修改生产 selector 或绕过登录、验证码、风控、权限和额度；
- 把 `events.jsonl`、本地 checkpoint 或模型记忆当作恢复权威；
- 用更多 retry、timeout 和 DOM 特判掩盖没有权威状态的问题；
- 为“未来几十家店铺”提前建设控制平面、对象存储和复杂配额系统；
- 用 Temporal/LangGraph/ADK/AutoGen 的依赖安装代替真实故障注入；
- 用一次真实成功回执宣称长期无人值守或生产级稳定。

---

## 12. 最终完成定义

“真正 Agent 系统”只有在以下条件全部满足时成立：

### 确定性底座

- 移除模型后，XWS/FAQ 的确定性流程仍可执行；
- 权威 Run/Attempt/cursor/Lease/Approval/CommitRecord 可在进程外恢复；
- 真实单分片已完成采集、验证、幂等提交、回读和租约释放；
- Worker 被杀、响应丢失、浏览器断开和人工闸门都有可执行验收；
- 未验证或未知状态不会被写成 0、空成功或 DONE。

### Agent 真实性

- 有真实模型 provider 调用，而不是硬编码决策或 fake fetch；
- Agent 通过受限只读工具读取 bounded evidence；
- 输出是持久化的、带 schema/version/evidence digest/confidence/risk 的 proposal；
- 独立 Validator/Policy 能拒绝非法、越权、过期和证据不一致的 proposal；
- Agent 无法直接调用浏览器、凭据、数据库写入、Feishu 发布或游标推进。

### 生产安全

- Proposal 到 ActionIntent 到执行到验证有完整审计链；
- action 有能力注册、Lease、预算、冷却和幂等键；
- `COMMIT_UNKNOWN` 先对账，不盲写；
- 经验只在验证通过后入库，且绑定环境/能力版本并可降权、退役和过期；
- 登录、验证码、风控、权限、额度和高风险发布默认回到人工。

最终判断标准只有一句话：

> **模型可以被拔掉，业务仍然安全可运行；模型接入后，只增加语义判断能力，不增加任何未经验证的写权限。**
