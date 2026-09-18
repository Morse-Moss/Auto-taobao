# Agent / 多 Agent 系统：现状对账与剩余计划

日期：2026-09-15
性质：对账 + 排期。**本文不重复既有设计**，只回答三件事：多 agent 到哪了、为什么没到、接下来按什么顺序补。
权威引用（有分歧时以它们为准）：
- `SUPERVISOR-AGENT-DESIGN.md`：S0-S4 分阶段、验收矩阵、Temporal 采用条件、「不做什么」。
- `docs/architecture/agent-sop-runtime-implementation-plan.md`：阶段 0-6、首批 7 条流程迁移顺序。
- `docs/architecture/PHASE-ARCHIVE.md` §12：实施计划完成度逐项对账。
- `docs/architecture/PRODUCTION-READINESS.md`：生产准入四条阻塞线。

---

## 0. 一句话结论

确定性底座（阶段 0-5）已完成，两条业务 SOP 已真实跑通；**Agent 层只做到「判决层」，没有任何一条真实 SOP 走进去过**，所以「单 agent 跑通」这句话目前不成立；「多 Agent 并发」未开始。

没有落地的原因不是单一外部阻塞，主要有三条：① 排序——多 Agent 被定为阶段 6 / P2，且它的前置条件从未被触发；② 硬闸门——设计文档明写「闭环完成前不做 Agent swarm」，而闭环直到 2026-09-14 才收口；③ **机制性缺口——整个 agent 层不在任何自动门禁里**（本轮新发现，见 §5），没有回归压力，放着就会腐烂。另有一处我自己的排期疏漏：用户「先让一个 agent 跑通也行」这个更小的目标**从来没有被单独排期**。

---

## 1. 关于「最终结论是采用 Temporal」这句话

这句需要在记录上更正，否则后续排期会建在一个不存在的前提上。

**能对上的部分**
- `docs/architecture/README.md`（durable engine 一节）写明：「Temporal 是该层的首选 POC 候选」。
- 依赖确实装了：`package.json` 的 4 个 `@temporalio/*` = `1.23.0`。
- POC 代码确实存在：`agent-runtime/temporal/workflows.mjs` + `activities.mjs`，最后改动 `3901192`（2026-09-12）。
- 自述边界很清楚：`agent-runtime/PROTOTYPE.md` 与 `agent-runtime/CLAUDE.md` 都把当前状态标为 **Temporal POC，fake adapter**。

**对不上的部分**
「首选 POC 候选」不等于「已选定的生产架构」。仓库里有三处明文写着相反的约束：
1. `SUPERVISOR-AGENT-DESIGN.md`：采用与否必须由故障注入结果决定，不由框架名称决定；且「不在 S1 之前同时引入 Temporal、LangGraph、ADK、AutoGen 或 AgentTeams」。
2. `agent-sop-runtime-implementation-plan.md`：暂不让 Temporal、LangGraph、ADK、AutoGen 或 AgentTeams 成为生产前置依赖。
3. `docs/standards/README.md`：不引入上述任一运行时框架。

**真正的状态是一个记账缺口**
S1 故障注入**已经用 PostgreSQL 路径跑完（15/15）**，按设计文档本该据此给出「保留 / 弃用 Temporal」的书面结论；实际是「默认由 PostgreSQL 承担、POC 原样留在 `agent-runtime/temporal/`」，而 README 的待决策清单里仍挂着「Temporal 去留」。
⇒ 准确说法：**Temporal 是一个没有下定论的 POC，不是一个已选定的架构。** 结论必须补（见 §6 Step 4）。

另注意一处文档漂移：README 那句话里「尚未落依赖或部署」与 `package.json` 现状矛盾，应一并改正。

---

## 2. 已完成：调研结论与架构选型（都有出处）

调研结论不是「选了哪个框架」，而是**先不选框架**，用确定性底座承担 durable 职责。

| # | 结论 | 出处 |
| --- | --- | --- |
| 1 | durable engine 由 PostgreSQL + 可重启的确定性 controller 承担；框架由故障注入结果决定，不由名字决定 | `SUPERVISOR-AGENT-DESIGN.md`、`docs/architecture/README.md` |
| 2 | 权威源分工：Temporal（若采用）只管「如何执行」，PostgreSQL 管「业务上确认了什么」 | `docs/architecture/README.md` |
| 3 | 模型**永远只拥有 proposal**；Agent 永不直写业务系统、不选租户/店铺/账号/profile/写入目标 | `SUPERVISOR-AGENT-DESIGN.md`、`agent-sop-runtime-implementation-plan.md` |
| 4 | Agent 分权四段：Planner（从**调用方预先批准的候选集**里挑一步）→ 确定性边界检查 → Reviewer（ACCEPT / REJECT / ESCALATE）→ Controller 落点 | `runtime/sop-runtime/agent-planned-run.mjs` 头注释 |
| 5 | 硬不变量：**移除 Agent 后确定性流程仍可运行**；有静态检查 `assertAgentRemovable` 守着 | 同上 |
| 6 | 降级出口：Agent 失败 / 提案非法 / 边界拒绝 / 复核非 ACCEPT，**四种都不抛异常**，退 `RUN_FALLBACK` 或 `PAUSE_FOR_HUMAN` | 同上 |
| 7 | 分阶段路线：S0 事实与边界门禁 → S1 XWS 单分片确定性耐久闭环 → S2 真实 Agent 提案切片 → S3 监督处置闭环 → S4 FAQ 商品级 fan-out（**有限并行，不是无限 swarm**） | `SUPERVISOR-AGENT-DESIGN.md` §9 |
| 8 | 明确不做：多个 LLM 自主对话、互相委派的 Agent swarm；用框架依赖安装代替真实故障注入 | `SUPERVISOR-AGENT-DESIGN.md` §11 |
| 9 | 验收矩阵 19 行 + 「不计入验收」7 条（hardcoded decision、fake adapter、进程内模拟重启、只调 SDK handler、只有模型文本没有 proposal/validator/audit 等） | `SUPERVISOR-AGENT-DESIGN.md` §10 |
| 10 | 「真正 Agent 系统」的完成定义分两组：确定性底座 5 条 + Agent 真实性（真实模型 provider 调用、受限只读工具、proposal 经独立 Validator、审计留痕） | `SUPERVISOR-AGENT-DESIGN.md` §12 |

---

## 3. 当前实际实现状态

### 3.1 已完成（这两周真正做出来的东西）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 阶段 0 架构基线与迁移 | 完成 | `db/migrations/001-007` 全带 rollback，**001-007 已全部 apply**（007＝日报链只追加审计表 `daily_report_push_audit`，2026-09-17）；`architecture` schema 7 表（reviews 1 / capabilities 5 / modules 15 / gaps 9 / phases 7 / decisions 7 / evidence_refs 8）；隔离库预演 **39/39** |
| 阶段 1 Context / Checkpoint / 恢复 | 完成 | `context-schema.mjs` 五条状态轴 + pg-store CAS；跨进程故障注入 **15/15**（子进程被杀 → 另一进程收回过期 lease → 从游标 10 续跑到 20；重复 commit_key 不产生第二行） |
| 阶段 2 Side Effect Ledger / 幂等 / 对账 | 完成（覆盖已接线能力） | 复用 `supervisor_commit_records`，未新增同义表；commit→verify→settle 全链；`reconcileUnknown` **只对账不重试** |
| 阶段 3 Manifest / Registry / Loader | 完成 | 10 个 manifest（能力 8 + 适配器 2）；`registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48`；坏 manifest 在执行前失败 |
| 阶段 4 Validator / Adapter 收敛 | 主体完成 | 11 个验证器（采集期 9 + 发布期 2）；迁移前后业务验收一致（双 profile 输出逐字节相同） |
| 阶段 5 Memory / Context Compression | 完成 | `compression-service.mjs`（缺关键字段 fail-closed + `assertSummaryMatchesRun` 防污染）+ `memory-store.mjs`（五层记忆，当前证据恒优先） |
| 首批 7 条流程迁移 | 7 项全部落地 | XWS 单分片、FAQ 商品级 fan-out、XWS SKU、SYCM 搜索排行、SYCM→Feishu、灰豚关键词热度、Agent Planner/Reviewer |
| 真实业务跑通 | 2 条 | `xws.feishu.import` 游标 1→3；`sycm.feishu.weekly` rows=300 / historyRows=2367；本周（09-13~09-19）竞品周更 8 步真实跑完 |
| 测试基线（2026-09-15 实测） | 全绿 | sop-runtime **355（26 文件）**；`run-test-suite.mjs runtime` **447（64 文件）**；skills **539** |

### 3.2 Agent 层的实际状态（三块，全部不接生产）

**a) sop-runtime 判决层**（`agent-proposal.mjs` / `agent-review.mjs` / `agent-planned-run.mjs`，迁移 7，2026-09-14）
- 四条边界、四个降级出口、14 + 13 例测试都在。
- **没有一条真实 SOP 走进去**；`planNextStep` 的入参只由测试构造。
- `createAgentPort` / `createReviewerPort` **只有测试实例化过**。
- 核心模块逐个核对过：没有任何一个 import 这三者。

**b) supervisor-agent 原型**（`runtime/supervisor-agent/`，最后改动 2026-09-12）
- `diagnose.mjs` 是确定性分诊（7 类失败签名），`llm.mjs` 是「一次 HTTP 诊断钩子」，`--apply` **未接真实动作执行器**。
- `proposal/`（S2 切片）有 `agent-session` / `tool-broker` / `provider-adapter` / `action-intent` / `validator` / `persistence` / `schema`。
- **真实 LLM 通路默认是关的**：`provider-adapter.mjs` 要 `SUPERVISOR_AGENT_LLM_URL` / `_KEY` / `_MODEL` 三个环境变量，未配置直接抛 `AdapterUnavailable` 并 fail-closed 降级。
- 持久化已就位：5 张 `supervisor_*` 表建于 `xws_automation`（DDL 已授权执行）。
- 定位自述：`PROTOTYPE.md` = 「确定性故障分诊原型，不是生产 Agent Runtime」；吃的是**人工拼装的 incident JSON**，不是活着的运行。

**c) Temporal POC**（`agent-runtime/`，最后改动 2026-09-12）
- 3 个文件 + 2 个测试；`observePage` / `executeAction` / `commitArtifact` / `releaseLease` 全是 fake adapter；模块级 Set 进程重启即消失。
- `CLAUDE.md` 的五项验收（独立 worker 被杀恢复、commit-before-response 幂等、人工闸门存活、**真实 Agent 调用**、真实 PG 游标集成）**全部未达成**。
- 真实长跑在 1-40 页的**第 20 页 STALLED**，回执 `LOCAL_READY_EDGE_REBIND_REQUIRED`。

### 3.3 单 agent 是否已跑通：没有

按项目自己写下的判据（`SUPERVISOR-AGENT-DESIGN.md` §12「Agent 真实性」+ §10「不计入验收」），逐条对照：

| 判据 | 现状 |
| --- | --- |
| 真实模型 provider 调用 | ✗ 未配三个环境变量，通路默认关闭 |
| 受限只读工具（Tool Broker） | 代码在（含 `FORBIDDEN_BY_DESIGN`），但只有测试调用过 |
| proposal 落库 + 证据 digest + 模型版本 | 表与代码在，无真实 proposal |
| 独立 Validator 拒绝非法输入 | 代码 + 测试在，未跑过真实输入 |
| 审计留痕 | 表在，无真实记录 |
| 真实 SOP 走进 Agent 判决 | ✗ 一次都没有 |
| 移除模型后确定性流程仍可运行 | ✓ 成立（这正是它至今没接线也不危险的原因） |

唯一真实跑过的 LLM 调用是 `runtime/local-provider-runner.mjs`（真 spawn `claude -p` / `codex exec -` / `workbuddy run`），但它是**由人手工发起的批处理工具**：一次调用、一次输出、只收两个字段、无工具、无循环、无记忆。它不满足上面任何一条「agent」判据。

⇒ 结论：**单 agent 未跑通。** 但系统不是「什么都没做」——确定性底座是完成的，且它的存在正是 agent 能被安全接上的前提。

---

## 4. 尚未推进的原因与阻塞点（五类）

**A. 排序决策（有意为之，但结果就是延迟）**
`agent-sop-runtime-implementation-plan.md` 把「有限多 Agent 与高并发」定为**阶段 6 / P2**，并写下前置：「若下一轮 SOP 明确需要多 Agent，则前置为 P0/P1」。**这条前置条件从未被触发**——09-13~09-15 的实际优先级被「真实跑完全流程」「把 SOP 跑通」「修底下的坑」占满。

**B. 我的排期疏漏（不推给别人）**
用户明确说过「哪怕先让单个 agent 跑通也可以」，但仓库里**没有任何一条**以「最小可用单 agent」为名的任务项、验收或排期。这个更小的目标被阶段 6 这个大桶吞掉了。这是本轮必须承认的一处失误。

**C. 书面硬闸门（设计决定，不是借口）**
- 实施计划第 5 节末：**没有完成阶段 1-3，不进入多 Agent 并发或复杂外部写入**。
- `SUPERVISOR-AGENT-DESIGN.md` §11 第一条：**在上述闭环完成前，不做多个 LLM 自主对话、互相委派的 Agent swarm**。
阶段 1-3 直到 **2026-09-14 才收口** ⇒ 多 agent 在时序上最早只能从 09-14 开始，而 09-14 之后的全部时间被真实跑通 SOP 占掉了。

**D. 真实环境阻塞（外部）**
- Temporal 那条真实长跑卡在第 20 页 `STALLED` / `LOCAL_READY_EDGE_REBIND_REQUIRED` → S1 的「真实单分片」这一层缺可复现输入。
- 09-15 又查出采集链本身还有区段覆盖问题（A 级为 0 的根因是导出只覆盖列表的一个区段）。**底层采集不稳，agent 的输入就不可信**——这是真实的、非推诿的阻塞。

**E. 机制性缺口（本轮新发现，可修，见 §5）**
整个 agent 层不在任何自动门禁里。没有门禁 → 没有失败信号 → 没有人被迫让它活着。

**F. 一笔未关的账**
Temporal 去留无书面结论（`PHASE-ARCHIVE.md` §12.4 第 4 条、`PRODUCTION-READINESS.md`）。记了账，没关。

---

## 5. 本轮新发现：agent 层不在任何门禁里（实测）

这条之前没有任何文档记过，也是「为什么 agent 层一放三天、且没有任何告警」的机制解释。

**事实**
1. `scripts/run-test-suite.mjs` 的测试发现是**非递归**的：`discoverRuntimeTests()` = `listTestFiles('runtime')`，只读 `runtime/` 顶层，不进入子目录。
2. 于是 `runtime/supervisor-agent/supervisor-agent.test.mjs` 与 `runtime/supervisor-agent/proposal/proposal.test.mjs` **不在任何套件里**。
3. 实测证据：`node scripts/run-test-suite.mjs runtime --dry-run` → `runtime: 64`，其中 `supervisor|agent` 命中 **0**。
4. `package.json` 的 `test:all` = `offline + unit + runtime`，**不含 `test:agent-runtime`**；且 `test:agent-runtime` 用的是 shell glob（`agent-runtime/tests/*.test.mjs`），依赖 Node ≥21 的 glob 行为，与 `engines: node >= 18` 不一致。
5. CI（`.github/workflows/ci.yml`）只跑 `test:offline` + `test:runtime` + skill 矩阵。

**后果**
判决层（sop-runtime Agent）、supervisor 原型、Temporal POC —— 三块 agent 代码的测试，**没有一条会被任何自动门禁执行**。这不是「测试写得少」，是「写了也不跑」，所以它们的腐烂是静默的。

**修法**（Step 0）
让 `discoverRuntimeTests()` 递归（或显式加 `runtime/supervisor-agent/**/*.test.mjs`），把两个现有测试文件纳入 runtime 套件；并显式决定 `test:agent-runtime` 的归属（纳入 `test:all`，或标注为「需 Temporal 本地测试服务、不进默关门禁」并写进 CI 注释）。**先确认它们当前是绿的，再纳入**——纳入一个红套件等于给自己造噪音。

---

## 6. 剩余计划：Step 0-5 与退出判据

顺序按依赖排，**每一步的退出判据才是真正的排期门**。

### Step 0　把 agent 层拉回门禁（零外部依赖）
- 做：见 §5 修法。
- 退出判据：`run-test-suite.mjs runtime` 文件数从 64 上升、全绿，且新纳入的用例在报告里可见。
- 为什么必须最先做：不先做这一步，后面每一步做完都会重新腐烂。

### Step 1　incident 源从「人工拼装 JSON」换成活着的运行（零外部依赖）
- 做：以 `runtime/supervise-collection.mjs` 的四个判据输出（进程死活 / 阶段静止超预算 `SUSPECT_STALLED` / 进度签名不推进 / 持久化证据优先）作为 incident 源，替换 `diagnose.mjs` 现在吃的人工 JSON。
- 退出判据：一次真实失败运行（可用一次故意中断的采集构造）**不需要人拼 JSON**，就能生成 incident 并落 `supervisor_*` 表。

### Step 2　让单 agent 真实跑一次 —— 这就是「单 agent 跑通」（零外部依赖，需要凭据）
- 做：配 `SUPERVISOR_AGENT_LLM_URL` / `_KEY` / `_MODEL`，走 `proposal/` 的完整链：`agent-session` → `tool-broker`（只读）→ `provider-adapter` → `validator` → `persistence`。动作只允许两个（照 S2）：`ESCALATE_HUMAN` + 一个固定参数 profile 建议。
- 退出判据（照抄 `SUPERVISOR-AGENT-DESIGN.md` §9 S2，不自行放宽）：
  1. 移除模型后 S1 仍能运行；
  2. 真实模型调用有 provider 证据（非 fake fetch、非 hardcoded decision）；
  3. Agent 不能直接执行任何业务写入；
  4. 用故意返回的「读 Cookie / 删除文件 / 任意 shell / 选择账号」proposal 验证 fail-closed。
- 这一步做完，「单 agent 跑通」才第一次成立。

### Step 3　S3 监督处置闭环（**需要授权**，风险最高）
- 做：proposal 通过后生成 ActionIntent → Policy 检查风险/预算/冷却/Run 身份 → Workflow 取 Lease 执行注册能力 → ActionResult 绑前后 EvidenceManifest → 用 cursor/commit/publication 回读验证改善；失败不写新经验，成功才写带环境与能力版本的经验。
- 分批：**先只放「读动作 + 通知动作」**，写动作一律经人工闸门。
- 前置：Step 2 的四条 fail-closed 用例全绿。

### Step 4　Temporal：定触发条件，而不是现在拍「上/不上」（**需要拍板**，半小时级）

**本文第一版在这里写的是「建议不引入、正式废弃 POC」——该结论已撤回**，理由见 §9。正确做法是「缓议 + 写死触发条件」。

- **不删**：`agent-runtime/temporal/` 与 4 个 `@temporalio/*` 依赖保持原样、继续标 prototype。`docs/architecture/README.md` §4.2 给 Temporal 的是**默认位置**（该层首选 POC 候选），并写明「Restate 等方案只有在相同故障模型下完成对比验证后才能替代它」——弃用它需要先拿出验证过的替代品，不是「现在用不上」。
- **改正一处失效描述**：README 那句「尚未落依赖或部署」已与 `package.json` 矛盾，改为「依赖已装、POC 已存在、未部署」。
- **写死触发条件表**（任意一条成立 ⇒ 启动 Temporal 引入评估，而不是继续靠进程内状态和本地 JSON 顶着）：
  1. 需要 ≥2 台机器或 ≥2 个常驻进程同时跑 worker，且共享限流/熔断状态；
  2. 需要跨天、跨重启存活的长 timer（当前由 `round-state.json` 在承担，见 §9）；
  3. 单条流程的步骤数与重试拓扑增长到 PG + controller 无法安全表达；
  4. 出现一次「因为编排状态丢失而重复干活或漏掉恢复」的真实事故。
- **两个可以先不靠 Temporal 就修掉的缺口**（见 §9）：把 `round-state.json` 的权威化挪进 PG；把限流/熔断从进程内 Map 挪到落库、或明确限制为单进程强约束。修完这两条，触发条件 1 与 2 会被推迟很久。

### Step 5　多 Agent（前置 1-4）
- 对应阶段 6 真正没开始的部分，也对应 S4「有限并行、失败隔离」，**不是无限 swarm**。
- 有一条真实约束必须先解决：并发扩容必须基于**资源容量证据**（实施计划风险表「并发超过外部资源容量」）。单账号 / 单 profile / 单浏览器是物理上限，所以这里「多 agent」的正确形态很可能不是「同时跑更多」，而是**一条流程一个 agent + 一个监督 agent** 的职能划分。
- 形态需用户先定，见 §8。

---

## 7. 时间安排

**按轮次，不给假日历。** 每一步的退出判据是排期门，不是日期。

| 步骤 | 依赖 | 量级 |
| --- | --- | --- |
| Step 0 门禁 | 无 | 一轮内可完成 |
| Step 1 incident 源 | 无 | 一轮内可完成 |
| Step 2 单 agent 真实跑一次 | Step 1 + 模型凭据 | 凭据就绪后一轮内 |
| Step 3 处置闭环 | Step 2 全绿 + 授权 | 需授权后单独一轮 |
| Step 4 Temporal 结论 | 拍板 | 一次拍板 + 文档收口 |
| Step 5 多 Agent | Step 1-4 + 容量证据 | 多轮 |

如果这周有硬时间点（例如某天必须看到单 agent 真实跑一次），给日期，我按它倒排。

---

## 8. 待拍板（5 项，每项都有推荐默认值）

1. **多 agent 指哪种？** 推荐 a。
   a) 一条流程一个 agent + 一个监督 agent（职能划分；尊重单浏览器物理瓶颈）
   b) 多个 agent 并行跑多条流程（受账号/profile 物理上限约束）
   c) 多个 LLM 互相委派（设计文档 §11 明确列为「闭环完成前不做」）

2. **Temporal 怎么办？** 推荐：**缓议（不删、不废弃、也不现在上）**，按 Step 4 写死触发条件表；先做那两条与 Temporal 无关的缺口修复。**不要删代码。**

3. **是否现在做 Step 0 + Step 1？** 两步零外部依赖、对飞书零写入。推荐：先做 Step 0（拉回门禁）。

4. **Step 2 的模型通路指向哪里？** 推荐：先指向本机已有的中转（满足「真实 provider 调用」判据、零新增依赖，但会消耗你的中转额度）。
   备选：先用假 provider 只验链路（零成本，但**不算**「单 agent 跑通」）；或另配一个独立 provider。

5. **这周有没有硬时间点？** 有就给日期，我按它倒排；没有我就按退出判据推进。

---

## 9. 对 Step 4 原结论的更正（2026-09-15 深夜，用户追问「为什么说弃就弃」）

用户的问题戳中了一处真实的判断失误。复查后确认原结论**三处站不住**：

**1. 设计文档给 Temporal 的是「默认位置」，不是「众多选项之一」。**
`docs/architecture/README.md` §4.2 原文：Temporal 是该层**首选 POC 候选**，且「Restate 等方案只有在**相同故障模型下完成对比验证后**才能替代它」。也就是说，弃用它需要先拿出在同等故障模型下验证过的替代品——而不是「当前用不上」。

**2. 「Durable Workflow history」被赋予的权威职责里，有一项当前落在本地 JSON 上。**
README §5 把该层的权威职责定为「执行历史、**定时器、重试**、信号和恢复依据」。
实测 `runtime/sop-runtime/round-runner.mjs:833-834`：生产 CLI 走的是
`createFileRoundState(resolve(workDir, 'round-state.json'))`（`:154` 是它的实现）。
这个文件装三样东西：`completed`（哪一轮跑过）、`days`（当天尝试次数）、`openAlert`（**通知去重与恢复的锚点**）。
这**违反 README §5 自己那一行**：「本地 JSON 是缓存或投影，**不得决定业务恢复位置或业务完成状态**」。
`createFileRoundState` 的注释也已经预见到风险：「状态文件坏了……那会让『今天已经跑过』的记忆消失，于是同一轮重复写一次」——但它选择的是抛错，而不是把权威挪走。

**2026-09-18 补一条更硬的事实：这份「权威」还不在一个稳定路径上。**
`runtime-bootstrap.mjs:46` 的默认值是 `resolve(workDir ?? 'runtime/sop-runtime/${workDirPrefix}-${Date.now().toString(36)}')`
—— 即 `workDir` **每次起进程都是一个新目录**（实证：`runtime/sop-runtime/round-mu6bq6d8/` 是空的，
来自一次在建状态之前就退出的运行；同类的 `two-stage-*` 有十几个）。部署文档 §6.1 的三条命令都**没有传**
`--work-dir`，所以这就是生产路径上的形状。⇒ 后果（**由代码推出的，未端到端实测**）：
机器重启 / 任务计划程序重新拉起之后，`completed` 与 `openAlert` 都从零开始，
于是①同一周期会被重新判一次「该跑」（幂等最终由 DB 的 `businessKey` 准入兜，这一条也**未验证**）；
②**还没收掉的那条告警会被重新通知一次**（去重锚 `openAlert` 没了）——
这正好落在 `LOGIN-RECOVERY-OPTIONS.md` §2.4 点名的那个风险「通知疲劳」上。
本轮新增的轮次账本（`UNATTENDED-AGENT-RUNTIME-PLAN.md` §11.3）**刻意没有跟着这个形状走**：
它的默认路径是 `runtime/.round-history.jsonl`，与进程生命周期无关。

**3. 另有一条已经记账的同类缺口。**
`PHASE-ARCHIVE.md` §9：「限流/熔断不 durable｜刻意取舍｜跨进程一致的限流需要落库或外置，属独立设计」。
实测 `runtime/sop-runtime/task-queue.mjs:47` 的 `createCircuitBreaker` 用进程内 Map + `Date.now()`。

⇒ **准确结论：不是「Temporal 没必要」，而是「还没到必须换引擎的程度，但缺口真实存在、而且有名字」。**
我上一版拿「四条采用条件没有一条被真实需求证明」当否掉的依据，漏掉了「其中两条今天是靠进程内状态和本地 JSON 顶着的」这个事实——把「尚未触发」说成了「不需要」，这是措辞强于证据的老毛病（与 `LESSONS-2026-09-14_15.md` §1 同类）。

⇒ **为什么仍然不建议现在上**（这几条与「是否废弃」是两回事，不要混读）：
- 采用它等于**新增一个有状态服务**（Temporal Server + 它自己的持久化库 + 版本升级 + 备份），而部署目标的形态是单机专用机 / 客户桌面；README 待决策清单里部署区域、凭据托管、SLA/RPO/RTO 三项都还没定。运维边界未定时先引入有状态服务，是把运维风险提前。
- 它**不解决当前真正的卡点**：agent 没有真实模型调用、incident 源是人工拼的 JSON、agent 层不在任何门禁里。这三件事 Temporal 一件都不管。
- 迁移成本不对称：6 条能力已经接在 PG controller 上并真实跑通（`xws.feishu.import` 游标 1→3、`sycm.feishu.weekly` rows=300）；把它们改写成 Temporal workflow 是**重写**，不是接线。且 §5 明写 PG 仍负责业务事实 ⇒ 引入后是**多一个引擎**，不是换一个。
- 设计文档 §9 的采用条件本来就是「当 S1 证明这四条需求确实存在时」——**其中「多 Worker 任务分发」会随多 agent 目标变成真需求**。所以正确动作是把触发条件写成可判定的表，到点就上。

⇒ **立即可做、且与 Temporal 无关的一步**：把 `round-state.json` 的权威化挪进 PG（`sop-runtime` 已有 CAS store 可复用）。这是修一条**违反自身不变量**的缺陷，不引入任何新依赖，也不需要任何授权之外的动作。
