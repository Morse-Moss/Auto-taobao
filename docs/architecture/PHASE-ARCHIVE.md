# sop-runtime 阶段档案（对抗性审查入口）

日期：2026-09-14
用途：**这是给审查同事的第一份文件。** 它把每个阶段的架构设计、关键决策、实现落点、验证证据和已知缺口集中到一处，并指到对应的深报告。审查时若发现某条决策「不对」，请先按本文的「决策编号」定位它属于哪一层、当时为什么这么定，再判断是否需要推翻。

阅读顺序建议：本文 → `docs/architecture/agent-sop-runtime-spec.md`（不变量）→ `docs/architecture/agent-sop-runtime-implementation-plan.md`（阶段与验收）→ 各阶段深报告。

## 0. 两套编号（先读这一条，否则一定会读错）

本仓库历史上产生了**两套阶段编号**，不要混读：

- **迁移顺序编号**（用于文件名 `PHASE0/3/4/4B/5-REPORT.md`）：按「第几条业务流程被迁移」编号。
- **实施计划阶段编号**（用于 `PHASE6-REPORT.md`）：按 implementation-plan 的 阶段 1/5/6 编号。
- **迁移顺序编号**（`MIGRATION-2-SYCM-WEEKLY-REPORT.md`、本文第 6 节）：按 implementation-plan 第 5 节「首批流程迁移顺序」编号。

`PHASE6-REPORT.md` 这个文件名同时被两种理解命中过，是本仓库最容易读错的地方。本文第 5 节的对照表给出唯一权威映射。

## 1. 不变量（任何改动都不得违反）

| 编号 | 不变量 | 落点 |
| --- | --- | --- |
| I1 | Workflow Controller 是运行状态唯一拥有者；Agent 与 Worker 都不拥有状态 | `workflow-controller.mjs` |
| I2 | 外部副作用必经 Worker → Validator → Commit/Reconcile；「本地调用返回成功」不等于完成 | `publication.mjs`、`side-effect-ledger.mjs` |
| I3 | 五条状态轴取值固定，确定性拒绝不得伪装成 UNKNOWN | `context-schema.mjs`、005 迁移的 CHECK 约束 |
| I4 | 游标只在已验证证据 + 已结算发布上前进 | `workflow-controller.advanceCursor` |
| I5 | 一个能力要写外部，必须在 manifest 声明外部写副作用并声明发布期验证器 | `skill-manifest.mjs`、`publication.assertPublicationDeclared` |
| I6 | 高风险提交前必须有 `humanGateStatus=APPROVED`，闸门在提交路径上再校验一次 | `publication.assertHumanGateApproved` |
| I7 | Agent 只出提案：不得拿写工具、不得改状态轴或身份、断言必须带证据 | `agent-proposal.mjs` |
| I8 | 两段之间只通过工件字节传递数据，不通过进程内内存 | `two-stage-runner.mjs` |
| I9 | 采集期与发布期验证器不混跑 | `validation-registry.mjs` 的 `VALIDATION_STAGE` |
| I10 | 执行槽占用 = **有一次 attempt 正在飞行中**（RUNNING + lease HELD），不是 run 处于某个状态 | `policy.occupiesLane`、`Controller.beginAttempt` |
| I11 | 一次调用做完事就必须把 run 结算到终态；外部写入未结算时**不得**终结 | `two-stage-runner`、`run-faq-fanout` |

## 2. 阶段 0：架构目录与迁移隔离验证

深报告：`runtime/sop-runtime/PHASE0-REPORT.md`
设计：把「架构目录」与「运行状态」分开——004 迁移建架构目录表（能力/模块/缺口/阶段/决策/证据），运行状态仍只由 001-003 的 durable 表承担。
关键决策：
- **D0.1** 不把架构目录当运行状态库；两者用不同的表族，避免「文档表成了第二权威」。
- **D0.2** 迁移必须可隔离预演：新增 `verify-migrations-isolated.mjs`，在临时库里 apply 全部迁移再跑断言，绝不直接改业务库。
证据：`db/migrations/004-architecture-catalog.sql`、`runtime/sop-runtime/verify-migrations-isolated.mjs`、`runtime/probe-db-*.mjs`。

## 3. 阶段 1-2（迁移顺序 3-4B）：manifest/registry/loader 与两段式首例

深报告：`runtime/sop-runtime/PHASE3-REPORT.md`（manifest/registry/loader）、`PHASE4-REPORT.md`（validator/adapter 收敛）、`PHASE4B-REPORT.md`（发布/回读接线）。
关键决策：
- **D3.1** manifest 是单一事实来源：`skills/<name>/manifest.json`，伴随 `<id>.manifest.json`；注册期校验（`build-skill-registry.mjs --check`，退出码 0 通过 / 1 校验失败 / 2 解析缺失）。
- **D3.2** 硬规则：entry 限目录内相对 `.mjs`；禁声明 `credentials.read`/`shell.arbitrary`/`cursor.advance`/`db.write.unbounded`；副作用与权限双向对齐；外部副作用须 `recovery.supported` + `resumeFrom`。
- **D4.1** 验证器分两阶段，采集期在 Worker 内跑（有工件即可判定），发布期必须等回读收据。
- **D4B.1** 发布轴五值 `NOT_REQUESTED/READY/COMMITTED/VERIFIED/UNKNOWN` 被 005 的 CHECK 锁死；确定性拒绝回退 `READY`，不新增状态。

## 4. 阶段 5（迁移顺序）：第一条业务能力两段式迁移

深报告：`runtime/sop-runtime/PHASE5-REPORT.md`
范围：`xws.feishu.import` 1.0.0 → 1.1.0，entry 从 CLI 换成 `scripts/adapter.feishu-import.mjs`；新增专用运行器 `run-feishu-import-two-stage.mjs`。
关键决策：
- **D5.1** CLI 保留为人工运维入口，运行器是运行时入口；两条路并存不互删。
- **D5.2** `createCapabilityPublisher` 有独立人工闸门：风险按 **manifest 声明的副作用**重判（不信任调用方传的 spec），高风险必须 `humanGateStatus=APPROVED`。
- **D5.3** 提交失败按状态码归类（4xx→POLICY_DENIED，5xx/408/429→TRANSIENT_EXTERNAL），不一律归 BUG——BUG 会触发 STOP_AND_ALERT，把一次可配置修复的错误升级成停线。

## 5. 实施计划阶段 1/5/6 与阶段 6 续

深报告：`runtime/sop-runtime/PHASE6-REPORT.md`
文件名的「6」指的是 **implementation-plan 的阶段 6**，不是迁移顺序第 6 条。

内容：跨进程恢复故障注入实证（15/15）、Memory 与 Compression 两个新模块、lane 并发闸门真实化、任务队列（限流/背压/熔断/退避/超时/取消/结果合并）。
关键决策（编号沿用深报告）：
- **D6.1** lane 计数两种口径必须显式区分：`LANE_ACTIVE_STATUSES` 与 `LANE_EXECUTING_STATUSES`。**本项已被 D7.1 与 D7.4 两次修正：`LANE_EXECUTING_STATUSES` 已删除，执行槽占用改由 `policy.occupiesLane` 判定。**
- **D6.2** 队列元数据落 `durable_runs.context.queue`（jsonb），不新增表、不新增列。
- **D6.3** 限流器与熔断器是**进程内** best-effort，重启即复位；代码与报告都如实标注，绝不宣称 durable。跨进程硬约束由 lane 承担。
- **D6.4** 同一个 key 出现两个不同值时记为冲突并要求人工，不静默择一。
- **D6.5** 令牌在准入被拒时归还，避免一次失败永久吃掉配额。

## 6. 迁移 2：通用两段式运行器 + sycm.feishu.weekly

深报告：`docs/architecture/MIGRATION-2-SYCM-WEEKLY-REPORT.md`
内容：把两段式从「一条能力的专用脚本」提升为能力无关驱动；第二条能力（SYCM 周更）成为它的第一个真实用户。
关键决策：D1（缺发布工厂 fail-closed）、D2（采集/发布用不同副作用集合准入）、D3（`collectContract()` 能力自描述）、D4（两段间只传工件字节）、D5（游标量取自证据）、D6（支持 `--database-url` 跑真实 PG）、D7（明确划出「第二个发布单元」边界）、D8（写入端沿用已测 CLI，不重写业务）、D9（回读必须指定 `weeklyTableId`）、D10（移除空转的 `relations` 声明）、D11（工件身份键抬到工件对象表面）。详见该报告。

## 7. 阶段 6 续（A 层）与后续迁移：Agent 提案契约、商品级 fan-out、SYCM 搜索排行

7.1-7.3 为本批（A 层）新增，无独立深报告，记录如下；7.4（迁移 3）与 7.5（迁移 4）各自另有深报告，这里只放审查所需的关键决策与结论。

### 7.1 关键决策 D7.1：修正「准入即占位」

**这是本批最重要的一条，也是对既有决策的推翻，请重点审查。**

原设计：`admitTask` 用 lane 占用做准入闸门（`activeInLane >= laneLimit` → DENY `RESOURCE_BUSY`），口径是 `LANE_ACTIVE_STATUSES`（含 QUEUED），即「准入即占位」。理由当时写的是「同一账号/profile/写目标不重复准入」。

问题（由商品级 fan-out 暴露，测试当场失败）：**同一账号下的多件商品共享同一个 lane**。按原设计，第二件商品连**入队**都不被允许，商品级 fan-out 在结构上无法实现。根因是把「并发约束」错用成了「重复约束」——两件不同商品不是重复。

修正：

- 准入不再判定 lane 占用。`evaluatePolicy` 只回答「能否进队列」，并把 `lane` 与 `laneLimit` 一起返回，供执行期使用。
- lane 占用**只在执行期**判定：`Controller.beginAttempt` 把关。（判据本身在 D7.4 被进一步修正为「有一次 attempt 正在飞行中」，见下。）
- 真正的重复改由 **`idempotencyKey`** 在准入期挡（`buildIdempotencyKey({taskId, identity, capability, scope})`）。按业务范围去重比按 lane 去重**更精确**：同一账号的两件不同商品不重复，同一件事项提交两次才重复。
- 新增拒绝原因 `DUPLICATE_TASK`（`failureClass=POLICY_DENIED`，且只有它带 `duplicateOf`），与 `BACKPRESSURE` 明确区分。
- 去重查询走 `store.listActiveRuns` 过滤 `context.idempotencyKey`，**不新增 store 端口方法**，代价是 O(活动运行数) 扫描，已在代码注释里写明量级假设。

被改动/推翻的旧断言（审查时请确认这些改动是「纠正」而不是「放宽以让测试通过」）：
- `context-schema.test.mjs` 原「lane 饱和返回 RESOURCE_BUSY」→ 改为「策略只给 lane 与上限，占用判定不在准入期做」。
- `workflow-controller.test.mjs` 原「同一 lane 并发准入第二条被拒」→ 拆成两条：同一事项重复准入被拒（DUPLICATE_TASK）；同一 lane 的不同事项都能准入但执行期仍串行（`LANE_SATURATED`）。
- `task-queue.test.mjs` 原「同一 lane 已被占位视为背压」→ 改为「同一 lane 的多个不同任务都能入队；重复任务 DUPLICATE_TASK」。
- `task-queue.test.mjs` 的 refund 用例改用「重复提交」触发准入拒绝（原来依赖 lane 占位）。

**未放宽的部分**：`beginAttempt` 的 lane 闸门一个字没改（判据在 D7.4 才被修正）；写操作 lane 上限恒为 1。所以「同一账号/profile/写目标不会双写」这条安全属性仍然成立，且现在有单测同时覆盖「能排队」与「执行串行」。

### 7.2 关键决策 D7.2：Agent 只出提案

落点：`runtime/sop-runtime/agent-proposal.mjs`
- Agent manifest schema `agent-capability-v1`：必须 `kind=agent`、`tools` ⊆ 只读白名单（`read_context_summary`/`read_evidence`/`read_registry`/`read_policy`/`read_verified_facts`）、不得声明外部写副作用、`proposalKinds` ⊆ `CLASSIFY/PARSE/SUMMARIZE/PLAN/RECOMMEND`、**必须声明 `deterministicFallback`**。
- 提案 schema `agent-proposal-v1`：`runId` 必须与上下文一致、`kind` 必须在 manifest 声明范围内。
- **不得触碰状态轴与身份**：用字段名黑名单在任意嵌套位置拦截（`executionStatus/evidenceStatus/humanGateStatus/leaseStatus/publicationStatus/verifiedCursor/blocker/nextAction/identity/sideEffectRefs/humanGate/riskClass`）；另外只在「像状态的键」（`status/state/axis/phase/nextAction`）上做取值比对。
  - 刻意**不做全文子串匹配**：状态轴取值里有 `READY`/`UNKNOWN`/`NONE`/`HELD` 这类通用词，全文匹配会把正常文本一起误杀，而被误杀的 Agent 层最终会被绕过——比少挡几种情况更危险。有专门的测试锁住「正文出现 READY/UNKNOWN 不误杀」。
- **断言必须带证据引用**：无引用 → `CLAIM_WITHOUT_EVIDENCE`；引用本轮之外 → `EVIDENCE_REF_UNKNOWN`。
- 唯一落点是 `toDecision()` → 只产生 `decisions`（审计记录），**不产生任何状态转移**。
- `createAgentPort` 是唯一调用入口：Agent 抛错或给出非法提案时返回 `fallbackRequired=true` + manifest 声明的兜底路径，**不把异常抛给编排层**。
- `assertAgentRemovable` 做静态检查：核心模块不得 import `agent-*`，保证「拿掉 Agent」不会变成编译期失败。

### 7.3 关键决策 D7.3：商品级 fan-out 先做失败隔离

落点：`runtime/sop-runtime/fanout.mjs`
- `businessKey = parentRunId:capability:itemKey`。**父运行参与拼接**，使「本周的这件商品」与「上周的这件商品」在提交账本上是两条记录；否则跨周重跑会被当成已提交而静默跳过。
- 派发逐个准入，单个子项失败只记录不抛出；拒因区分 `retryable`（BACKPRESSURE/RATE_LIMITED/CIRCUIT_OPEN = 稍后再试）与不可重试（INVALID_SPEC 等 = 子项本身有问题）。**区分它们是防止调用方把容量问题误判成数据问题去改数据。**
- 收集复用 `mergeFanoutResults`：冲突交人工；**缺失子项一律 `requiresHuman=true`**——宁可交人工，也不能把「少了几件」当成「全部成功」。
- `assertNoDuplicateBusinessKeys`：同批内 `businessKey` 必须唯一（重复即意味着会写出重复外部效果）。
- `fanoutLaneLimits`：并发放大必须建立在显式容量证据上，无证据不放大；写操作恒为 1。

### 7.4 迁移 3：FAQ 商品级 fan-out 落地（含两处死锁修正）

落点：`skills/xws-faq-operator/scripts/adapter.faq-product.mjs`（能力 `xws.faq.product-collect@1.0.0`）、`runtime/sop-runtime/run-faq-fanout.mjs`、`skills/xws-faq-operator/manifest.json`。

**要解决的问题**：原 `run-faq-operator.mjs` 把整个周期当一个执行单元，`inspectEvidence` 只保留**第一个**未解决告警作为 blocker，于是「1 个商品采集失败」阻塞另外 4 个已完成的商品。这正是计划里「单商品失败隔离」要消灭的东西。

**D7.4：执行槽占用判据修正（修掉两个真实死锁）**

原判据是 run 状态集合 `LANE_EXECUTING_STATUSES = [RUNNING, RETRY_WAIT, PAUSED]`。它在真实 fan-out 上**必然把整批锁死**，测试当场失败（3 个子项只跑完第 1 个，第 2 个 `LANE_SATURATED`）：

1. `completeAttempt` 只把 `nextAction` 置为 `COMMIT`，`executionStatus` **仍然是 RUNNING**。于是「采集已完成、等提交」的 run 永久占着 lane。
2. 失败进入人工等待的 run 是 PAUSED。于是「一个商品失败 ⇒ 其余商品全部排不进去」——恰好是要消灭的整批停摆。

修正：占用判据改为 `policy.occupiesLane(context)` = `executionStatus === 'RUNNING' && leaseStatus === 'HELD'`。
理由：只有 lease 能表达「有一次 attempt 正在飞行中」（`beginAttempt` 取 HELD，`completeAttempt`/`failAttempt` 释放 RELEASED）。等待态（QUEUED/RETRY_WAIT/PAUSED）与「跑完等下一步」都不占槽。
连带：`LANE_EXECUTING_STATUSES` 已删除（不再有第二个口径）；`task-queue.nextCandidate` 与 `Controller.beginAttempt` 使用同一判据，消除「出队时算能跑、开 attempt 时被拒」的自相矛盾。`LANE_ACTIVE_STATUSES` 保留，但只用于队列深度/背压。
**安全性未放宽**：正在飞行的 attempt 仍严格互斥（有测试：B 持 lease 时 A 开 attempt 仍被拒），写操作 lane 上限恒为 1。

**D7.5：运行终结（修掉「run 永远不终态」）**

两条已迁移路径（专用运行器与通用两段式运行器）**都从不调用 `controller.succeed()`**，因此每次执行结束后 run 永远停在 RUNNING。后果：run 永远算「活跃」（占队列深度，旧口径下还占 lane），且没有任何东西能说「这条 run 结束了」。

修正：
- 一次调用做完该做的事 → `controller.succeed(runId)`（SUCCEEDED + TERMINAL + 释放 lease）。
- 通用两段式运行器：未发布（dry-run / 只读能力）→ 结算；发布 VERIFIED + 游标推进 → 结算；**发布未 VERIFIED → 不结算**（等对账或人工）。把尚未结算外部写入的 run 标成 SUCCEEDED 才是真正的谎报。
- 收据新增 `executionStatus` / `nextAction`，`null` 表示「本次调用没有结算它」。

**D7.6：FAQ 商品级能力刻意不声明三个通用验证器**

`xws.faq.product-collect` 的 manifest 只声明 `source_identity`/`structure`/`digest`，**刻意不声明** `completeness`/`row_count`/`artifact_integrity`。
理由：三者都会把**合法的 0 行证据**判成不完整（`completeness` 与 `artifact_integrity` 都拒绝 `rowCount <= 0`）。而下架商品就是 0 行，且必须被视为**合法**——这不是假设：真实周期 `2026-09-06_2026-09-12` 的唯一候选商品 `678598686014` 就是下架商品（qa/reviews 均 `EMPTY_SOURCE_ROWS` + 详细 `unavailableReason`），2026-09-14 实测该商品在本驱动下 `evidenceStatus=VALIDATED`、`executionStatus=SUCCEEDED`、整批 `publishable=true`。若声明了那三个验证器，这个真实商品会被判成 `EVIDENCE_INVALID` 而阻塞整批。
0 行的合法性只能由**能力自检按收据语义**判定（`EMPTY_SOURCE_ROWS` 且 `unavailableReason` 非空），通用行数验证器无法区分「空且已声明」与「空且漏采」。这条取舍写在 `collectContract().omittedValidators` 里，随 manifest 一起被审查。

**D7.7：fan-out 驱动器只准入、不再次准入**

`runTwoStage` 内部会自己 `admitTask`。如果 fan-out 先把子项准入、又调 `runTwoStage` 跑它，同一商品会有**两条 run**（taskId 不同 → `idempotencyKey` 不同 → 两条都会被准入），直接违反「重复消费无重复副作用」。
因此驱动器只负责准入（queue），执行直接走 Worker（`createCapabilityWorker` + `runOnce`，与 `runTwoStage` 的采集段是同一段代码路径）。驱动器里有一段注释专门锁住这条约束。

**D7.8：`complete` 与 `publishable` 必须分开**

- `complete` = 每个子项都拿到了自己的结论（无论成功失败）。回答「这批跑完了没有」。
- `publishable` = 全部成功且无冲突。回答「能不能进入周期级汇总」。
把两者合成一个布尔值，就会让「4 成功 1 失败」被读成「整批失败」（原 FAQ 的毛病）或「整批成功」（更危险）。

**D7.9：空批次既不是失败，也不等于采集完成**

清单已锁定且 `outcome=NO_QUALIFIED_CANDIDATES` 时 0 个商品是**合法**状态（运营口径：高质量竞品不是每周都有）。驱动器返回 `empty:true` + `complete:false`，并附 note 指明周期级完成判定归 xws-faq-operator 的空周期旁路。用 `complete:true` 表示它会让人误以为「本周已采集完毕」。

**未纳入本驱动器的范围（如实标注）**：周期级的飞书发布（问题主库/问题库替换）是一次外部写入，仍由 `runtime/publish-faq-detail-enrichment.mjs` 承担，**尚未迁移**。因此本次迁移覆盖的是「商品级采集与隔离」，不是「FAQ 全链路」。

**同义实现与防漂移**：适配器不 import `runtime/`（实施计划风险表：「Skill 导入 runtime 新模块」= 反向依赖扩大），代价是收据契约判定在 `runtime/run-question-library-collection.mjs` 的 `readEvidence` 里有一份同义实现。防漂移手段是**交叉验证测试**：11 组夹具（含合法空证据）同时喂给两份实现，必须给出完全一致的接受/拒绝结论。`parseCsv` 也逐条对齐（引号只在单元格为空时开引、`\r`/`\n`/`\r\n` 都算行尾、整行全空丢弃）。

### 7.5 迁移 4：SYCM 搜索排行接入两段式（只读能力，零发布义务）

落点：`skills/sycm-export-search-rank/scripts/adapter.search-rank.mjs`（能力 `sycm.search-rank.export@1.1.0`）、`manifest.json`、`export-search-rank.mjs`（抽出程序化入口）。深报告见 `MIGRATION-4-SYCM-SEARCH-RANK-REPORT.md`。

**要解决的问题**：业务实现（七天窗口、分页 50 行、排名 1..N 连续无重、搜索词不重复、指标非空、CSV/XLSX 配对复验）本来就有测试覆盖，但它**不在运行时里**——manifest.entry 指向 CLI，Loader 拿不到 `adapter`；CLI 成功路径只 `console.log`，没有可复验工件，也没有结构化返回值。子进程复用会丢掉失败分类、attempt 绑定和恢复上下文。

**D7.10：只读能力走「无发布段」路径，而不是导出一个空 publisher**

manifest 的 `sideEffects = [browser_read, local_artifact]` 不含任何外部写，因此 `shouldPublish` 恒为 false：`publicationStatus` 保持 `NOT_REQUESTED`、游标不推进、随后 `succeed()` 终结为 `SUCCEEDED`。
明确拒绝的反面做法：导出一个返回空 handler 的 `createPublisher` 让收据"好看"。那会把一次读操作变成一条 `COMMITTED/UNKNOWN` 待对账的外部写入——制造不存在的对账工作，并破坏「`NOT_REQUESTED` = 从未请求过发布」这一语义。
**本轮 `runtime/sop-runtime/` 未新增任何模块**：通用运行器就是为了让「新能力 = 新目录 + manifest + 实现 + 测试」成立；零外部写的能力连 `two-stage-runner.mjs` 都不需要改。

**D7.11：工件是证据 manifest 的 JSON 字节，不是 CSV**

单看 CSV 说不出「哪个类目页、哪个七天窗口、翻了几页、每页多少行、排名是否连续 1..N」。工件是 JSON（`sycm-search-rank-evidence-v1`），CSV/XLSX 作为**产物**记在里面（路径 + sha256 + 字节数），仍可独立复验。

**D7.12：`range = {start:1, end:rowCount}` 是对事实的陈述**

`contiguous_prefix` 要求 `range.start === verifiedCursor.end + 1`；只读采集不声明预期行数（`expectedRows=null`，`verifiedCursor` 保持空）⇒ `range.start` 必须为 1。这与业务语义一致（搜索排行天然 1..N 连续，流程内已硬校验），不是为了凑验证器。

**D7.13：刻意不声明的三个验证器（同迁移 3 的教训）**

`artifact_integrity`（会在 `rowCount<=0` 时失败，而空排名合法性只能由流程判定）、`digest`（与 `validate()` 的字节摘要复算完全重复）、`completeness`（导出前不知道总行数，声明"预期范围"等于编造）。三者写进 `collectContract().omittedValidators`，并有测试断言「声明为刻意不声明的验证器不得出现在 `manifest.validation` 里」。

**D7.14：失败分类必须显式映射，不能靠默认分类器猜**

默认 `failureClassOf` 只按**英文**关键词猜。本流程的人工提示是中文（"标签页已登录但不在搜索排行页面，请人工…"）→ 会被判成 `BUG`（落态 `FAILED/TERMINAL`），正确结论是 `HUMAN_REQUIRED`（落态 `PAUSED/WAITING_HUMAN`）。同理代理不可达（`fetch failed`）应是可重试的 `TRANSIENT_EXTERNAL`，不是 `BUG`。适配器为此做了两层显式映射（流程错误 → 失败分类；错误码 → 失败分类），各有测试。

**D7.15：CLI 与适配器共用默认参数，并补 `isMain` 闸门**

默认值（类目 `50002411`/普通浴缸、`delayMs=1200`、`maxPages=20`、`period=7d`）原来只写在 `parseArgs()` 里；抽成 `defaultExportArgs()` + `resolveExportArgs()` 让两条路径共用，消除「CLI 与运行时默认值静默分叉」。另外原文件顶层直接 `main()`，**任何 `import` 都会真实导出一次**——适配器必须 import 它，所以补 `isMain` 闸门（有测试）。

**同义实现与防漂移（本能力版本）**：适配器同样不 import `runtime/`；防漂移手段是与 runtime 的 `validateContiguousPrefix / validateStructure / validateCompleteness` 做交叉验证——同一组工件事实两边必须同结论。

**未纳入范围（如实标注）**：本能力**只被夹具流程端到端驱动过，未被真实浏览器驱动过**（需要 Edge 调试实例上的生意参谋登录态）。这是能力缺口，不是"已验证"。

### 7.6 迁移 5：XWS SKU 接入两段式（首个带外部写副作用的迁移）

落点：`skills/xws-sku-collection/manifest.json`（能力 `xws.sku.collection@1.0.0`）、`scripts/adapter.sku-collection.mjs`、`tests/adapter-sku-collection.test.mjs`。深报告见 `MIGRATION-5-XWS-SKU-REPORT.md`。

**要解决的问题**：SKU 入库原本是一条人工值守的 CLI 链（`xws-sku-auth-preflight → capture-xws-sku-payload → collect-live-xws-sku-topology → run-xws-sku-dry-run → apply-xws-sku-manifest`），唯一状态载体是 `batch-index.json` 和操作者的进度记忆。三处结构性缺陷：

1. **授权是命令行开关，不是可审计状态**：`--apply --confirm-record-count N` 同时扮演审批与参数，审批记录不在任何权威库里，重跑也不会撞上「已审批」这道闸门——因为它不存在。
2. **写入有结构性重复窗口**：`batch_create` 只在成功返回后才回写本地回执；进程死在「飞书已创建、本地未记账」之间时，重跑的 `commitKey`（`runId:target:businessKey`）是**新的**（`runId` 变了），幂等键拦不住重复行。
3. **没有可自证、可独立复验的工件**：dry-run 产的 manifest 与回执没有共同的哈希绑定（payload/拓扑/parser 三方摘要）。

**D7.16：能力切在「已审批计划 → 工件」与「工件 → 写入 → 回读」之间，浏览器采集留在既有 CLI**

浏览器点击、剪贴板读取、页面拓扑抓取需要 Edge 会话与真人节奏；塞进 Worker 的 `start/observe` 只会把「可恢复的确定性步骤」重新变成「不可恢复的长事务」。所以 COLLECT 只读六份本地输入（payload / 采集收据 / 拓扑 / 拓扑收据 / 已审批 manifest / parser 字节）并产出可自证工件；PUBLISH 只读**工件字节**完成对账式写入与回读。**与迁移 3（FAQ）完全同构**——这正是它能零改动复用通用运行器的原因。

**D7.17：不复跑解析，改用摘要绑定解析器版本（与迁移 3 相反的取舍）**

FAQ 选择在技能目录内复刻同语义解析（CSV 解析很短），再用交叉验证测试对住。SKU 不能照抄：它的解析链要跨 `competitor-v2-core` 的尺寸候选与空间判定（0.8–1.2m→小户型、1.3–1.8m→常规卫生间、非线性外形与范围值一律转人工核验等），复刻等于制造第二份真相，而两份真相的漂移只会在真实写入时才暴露。

因此改为**哈希绑定**：调用方必须显式给出 `parserFile`，适配器要求 `sha256(parserFile) === manifest.parser.sha256`（dry-run 写 manifest 时就记录了 parser 摘要）。任何解析逻辑改动都会在一个**可审计的点**上失败（`RECEIPT_HASH_MISMATCH` + `side: 'parser'`），而不是悄悄换一套语义。代价写清楚：本能力**不复算** `SKU名称/规格/尺寸/适用空间` 的解释结果，它复算的是「这批证据 ↔ 这份计划」的一致性（见第 9 节）。

**D7.18：目标来自已审批工件，不由调用方决定；两种不一致处理刻意不同**

`appToken` / `skuTableId` 由工件的 `target` 携带，而工件经 `manifestSha256` 绑定到已审批的 dry-run manifest。调用方仍必须显式写出目标，二者必须完全一致：

| 情形 | 处理 | 理由 |
| --- | --- | --- |
| 调用方**没给**目标 | 工厂期抛 `TARGET_REQUIRED` | 调用方缺陷，连凭据都不该去读 |
| 调用方给的**与工件不符** | `handler` 抛 `TARGET_MISMATCH`（`POLICY_DENIED`） | 策略拒绝必须留下可审计的 `REJECTED` 收据；工厂期抛出会穿透运行器，把 run 留在 `RUNNING` 且毫无结算记录 |

「换一个 base 写」因此在结构上需要一次新审批，而不是改一个常量。

**D7.19：写入自身幂等——先对账，再创建**

`handler` 不是无条件 `batch_create`，而是先按 `SKU唯一键` 回读目标表、**只创建缺失的行**。直接消灭上面第 2 条：崩溃后重跑（新 `runId` → 新 `commitKey`）不产生重复行；同批在不同周重复提交时 `toCreate` 自然收敛为 0；`UNKNOWN` 对账也只需一次回读，不必「猜它到底写没写」。

**D7.20：失败分流——确定性拒绝 vs 结果未知**

只有**可能已经落库**的失败才进 `UNKNOWN`：HTTP 5xx、408、429、`ECONNRESET/ETIMEDOUT` 等连接类错误、`AbortError`、以及 `fetch failed / socket hang up / timeout` 这类文本。4xx（参数、权限、字段错误）是确定性拒绝，直接 `REJECTED`，不允许靠重试蒙过去。`isUnknownWriteFailure()` 是纯函数并逐条断言（`500→true`、`400→false`、`403→false`、`ETIMEDOUT→true`、`invalid field name→false`）——这条判定决定「等对账还是可重试」，猜错的代价是重复写入或永久卡死。

**D7.21：行数语义是「工件带全部已解析行」，而不只是 `toCreate`**

`rowCount` = 本批次已解析的 SKU 行数（`toCreate + alreadyPresent`），回读收据的 `rows` 必须等于它。三个好处：`row_count` 验证器仍然有意义且**永不为 0**（不会像迁移 3 那样为「合法的空证据」放弃行数验证）；幂等重跑（`toCreate=0`）不会退化成「空工件 → `INCOMPLETE_RANGE` 假失败」；回读证明的是「这批行的目标状态已成立」，比「本次新建了几行」更接近验收定义。

**D7.22：刻意不声明的验证器**（写进 `collectContract().omittedValidators`，有测试锁住）

`digest`（比较的是 evidenceStore 从同一份字节算出的摘要，恒等、属空转）、`artifact_integrity`（`rowCount > 0` 与 `row_count` 完全重叠，而能力已用「逐行唯一键 + 拓扑组合数一致」做了更强自检）。声明做不到的验证器制造假失败，漏声明制造假通过——两者都必须显式写清楚（迁移 3/4 反复确认过的教训）。

**D7.23：跨 Skill 依赖写进 manifest，并用漂移测试锁住**

Feishu 客户端来自**已登记**的 `adapter.feishu@1.0.0`，做法与 `adapter.feishu-weekly` 一致：可注入的懒加载（`deps.createClient` / `deps.readEnvFile`），默认实现用相对路径 import。因此多一条守卫测试：把注册表里 `adapter.feishu` 的 `entry` 解析路径、适配器里那条相对导入的解析路径、manifest 声明的依赖三者对齐断言——「偷偷 import 一个没登记的模块」在结构上暴露。

**D7.24：`recovery.resumeFrom` 用 `idempotent_commit` 而非 `verified_cursor`**

只读能力（迁移 4）用 `verified_cursor`（恢复点＝已验收的证据范围）。本能力有外部写副作用，恢复点必须是**提交记录**：`UNKNOWN` 只能对账（`reconcileUnknown`），重试必须落在同一个 `commitKey` 上，游标只在 `VALIDATED` 证据 + `VERIFIED` 发布之后才可能推进。

**D7.25：明确记下**两条**写入路径，并如实标注强度差异**

`runtime/apply-xws-sku-manifest.mjs` 仍然存在、不回退、不改写：

| | 运维 CLI | 运行时能力 |
| --- | --- | --- |
| 触发 | 操作者手打 `--apply --confirm-record-count N` | 人工闸门 `humanGateStatus=APPROVED`（`--operator` 记录审批人） |
| 写前 | 立刻重跑 dry-run，并 `assertFreshPlanMatchesManifest` | 不重跑（离线不可用）；靠工件哈希绑定 + 对账式写入 + 回读收敛 |
| 写后 | 循环重跑 dry-run 直到 `toCreate=0 && alreadyPresent=N` | 一次外部回读，逐行核对唯一键/关联/空间 |
| 审批痕迹 | 命令行参数 | `supervisor_commit_records` + Controller 上下文 |

**两者不是同一份实现**，所以「写前新鲜度」的强度**不同**：CLI 有「写前重算」，运行时路径只有「写前绑定 + 写后收敛」。这是本能力当前最强的已知缺口（见第 9 节）。

**结构性结论（本轮最重要的一条）**：`runtime/sop-runtime/` **仍然没有新增任何模块**，`two-stage-runner.mjs` 也**没有改一行**。迁移 2 引入的通用两段式运行器第一次承载了**带外部写副作用**的能力而无需任何特化——它此前只在迁移 1 的专用运行器里被验证过。迁移 2/3/4 的「新能力 = 新目录 + manifest + 实现 + 测试」设计目标至此被两种能力形态（只读、外部写）各自验证过一次。

**本轮抓到的真实缺陷（3 条，均已修并各有测试）**：① `TARGET_MISMATCH` 原本在工厂期抛，异常穿透 `runTwoStage`，把已准入已采集已过闸门的 run 永久留在 `RUNNING`（`publicationStatus` 停在 `READY`）、既无 `REJECTED` 收据也无对账入口（见 D7.18）；② `validate()` 原先把 `artifact.rowCount` 当作必然存在，而它是框架侧从字节内 `skuRowCount` 派生的表面字段——任何「从字节单独重建工件」的第三方复核路径都会被误判 `STRUCTURE_INVALID`；③ 拓扑收据的 `propertyCount` / `validCombinationCount` 没有复验（只比了 `topologySha256`），「拓扑文件被换成结构相同但组合数不同的另一份」会漏到写入行数不符才暴露。

### 7.7 迁移 6：灰豚周度接入两段式（首个「能力级队列 + 外部写 + 异步公式结算」的迁移）

落点：`skills/huitun-to-feishu-keyword-heat/manifest.json`（能力 `huitun.keyword-heat.collect@1.1.0`）、`scripts/adapter.huitun-keyword-heat.mjs`、`tests/adapter-huitun-keyword-heat.test.mjs`。深报告见 `MIGRATION-6-HUITUN-WEEKLY-REPORT.md`。

**要解决的问题**：灰豚回填原本是 `run-huitun-topic-heat.mjs` 一个 CLI 从读队列做到回填（读飞书 A候选 → 浏览器采集灰豚话题浏览量 → dry-run → `--apply` 回填 → 整表回读 + 公式结算）。同样是「授权是命令行开关、一条长事务、无自证工件」，但它与迁移 3/5 有一处形态差异：**队列是能力级的，不是商品级 fan-out**，因此真正要回答的是「0 候选时该怎么办」，而不是「一个子项失败如何隔离」。

**D7.26：能力切在「results.json + 飞书只读 → 工件」与「工件 → 对账写入 → 回读」之间，浏览器采集留在既有 CLI**。浏览器点击与结果稳定判定（loading 过渡 + 两次相同 DOM 签名）需要 Edge 会话与真人节奏；塞进 Worker 只会把可恢复步骤变成不可恢复长事务。与迁移 3/5 同构，因此同样零改动复用通用运行器。

**D7.27：工件携带「计划」而不是「结果文档」**。结果文档只在采集期用来算计划，之后工件只留 `resultsSha256` + 文件路径。把新鲜度策略搬进发布段会误杀「采集时合法、提交时刚好过期」的工作，而新鲜度本来就是**采集期**的性质。

**D7.28：发布段不重算解析，改为重读目标表 + 逐行对账**。CLI 写前重跑完整 dry-run；运行时路径离线不可用，改为「读实况 → 队列指纹 → 逐行身份/守卫/现值 → 只写仍为空的字段」，并把「队列变了」显式写成可审计的 `QUEUE_CHANGED`。**队列指纹的语义必须写准：它只在「确实还要写点什么」时才是硬门**——成功回填会让 `优先级` 公式结算、行离开 A候选 队列，指纹变化是正常收敛。见第 10 节第 15 条。

**D7.29：回读只守「本批行 × 与优先级判定相关的字段」（6 个守卫字段），不复制整表快照**。「无关记录必须原样」没有丢：由「载荷只允许一个字段」+ `assertAuthorizedMutation` 本地守卫 + 回读只认本批行共同保证。

**D7.30：未收敛的回读收据不带 `verifiedAt`**，使「公式没结算 → `UNKNOWN`」不依赖调用方是否传 `expectedRows`。判定依据落在被验证的证据里，而不是调用方参数里。

**D7.31：0 候选 = 确定性拒绝 `NO_CANDIDATES`**，不伪造 0 行发布。框架 `advanceCursor` 要求 `end >= 1`，伪造 1 会把「什么都没做」写成「推进一格」；由驱动器负责「空队列不要发起本能力」。这与迁移 3 的 `DONE_NO_CANDIDATES`（合法结论）是**刻意不同**的取舍：那边「一个商品没有证据」是产品事实，这边「整个队列为空」意味着能力不该被调度。

**D7.32：中文策略结论必须显式映射成确定性 code + failureClass**。`flow.mjs` 抛的是中文提示的普通 `Error`，默认分类器只按英文关键词猜，会把「拒绝覆盖 / 队列已变化」这类策略结论猜成 `BUG`（`FAILED/TERMINAL`），把可修正重跑升级成停线。19 条显式规则 + `FAILURE_CLASS_BY_CODE` 逐条绑定；**未命中规则的异常原样抛出**（不用合理分类藏 bug）。拒绝码有两个观察面（直接调读取函数拿 `code`；经 `runTwoStage` 拿 `receipt.failureClass`），两面都有用例。

**D7.33：刻意不声明的 6 个验证器**（`digest` / `artifact_integrity` / `scope_match` / `contiguous_prefix` / `completeness` / `relations`，各有理由，测试锁住不得出现在 `manifest.validation`）+ 跨 Skill 依赖漂移守卫（`adapter.feishu` 的注册表 entry 解析路径 == 适配器相对导入路径）+ `recovery.resumeFrom = idempotent_commit`。

**D7.34：两条写入路径如实分工**。CLI 保留（含浏览器采集、写前重跑 dry-run、整表比对）；运行时路径不发起任何浏览器动作，靠工件绑定 + 指纹 + 逐行守卫对账 + 一次外部回读。

**未复刻任何既有逻辑**：`scripts/flow.mjs` **一行未改**，来源校验、队列绑定、`AI_REQUIRED` 前置、`Refusing to overwrite`、`assertAuthorizedMutation`、`优先级` 公式预期全部沿用原实现——这是本项目第一条「复用既有纯逻辑模块而不复刻」的迁移，避免了第二份真相。

**结构性结论**：`runtime/sop-runtime/` **仍无新增模块**，`two-stage-runner.mjs` **仍零改动**。「新能力 = 新目录 + manifest + 实现 + 测试」至此被四种形态各验证过一次：只读（迁移 4）、商品级 fan-out（迁移 3）、外部写（迁移 5）、能力级队列 + 外部写 + 异步公式结算（本轮）。

**本轮抓到的真实缺陷（2 条，均已修并各有测试）**：① `validate()` 把「调用方没提供的表面字段」当成撒谎——工件表面字段是框架侧从字节派生的，任何「只拿字节 + 摘要」的路径（第三方复核/跨进程恢复）都会被误判 `STRUCTURE_INVALID`（与迁移 5 缺陷 ② 同类、方向相反）；② 回读对账的队列指纹**无条件**生效，而成功回填必然让行离开 A候选 队列 → `UNKNOWN` 对账（设计里唯一被允许的恢复动作）永远走不到自己的成功状态。见第 10 节第 15 条。

### 7.8 迁移 7：Agent Planner/Reviewer（「Agent 提议什么」与「运行时允许做什么」分开）

落点：新增 `runtime/sop-runtime/agent-review.mjs`、`agent-planned-run.mjs`；修改 `policy.mjs`、`skill-manifest.mjs`、`publication.mjs`、`context-schema.mjs`、`task-admission.mjs`、`workflow-controller.mjs`、`agent-proposal.mjs`、`index.mjs`；新增 `agent-review.test.mjs`(13)、`agent-planned-run.test.mjs`(14)。深报告见 `MIGRATION-7-AGENT-PLANNER-REVIEWER-REPORT.md`。

**要解决的问题**：阶段 6 的验收条款「Agent 移除后确定性流程仍可运行」只做了一半——D7.2 保证了「Agent 不能改状态」，但**没有**保证「Agent 能提议 ≠ 运行时就会执行」。一条格式完全合法的提案可以挑一个带 `feishu_write` 的能力、挑一个未登记的能力、挑一个仓库外的路径当输入，而它在 proposal schema 上完全合法。本轮补的就是这个判决层。

**D7.35 `advanceCursor` 收紧，判据取自上下文里的准入声明**（取消第 9 节原先「有意延后」的欠账）。条件（三条带外部写的能力已接入）早已满足。判据放在 `context.sideEffects`（准入期从 `spec.sideEffects` 抄入）：不依赖 manifest、不依赖调用方是否老实、核心层不必 import Agent 层。只读运行与 dry-run 采集路径（走 `succeed()`）不受影响，同一用例把两侧都钉住。

**D7.36「外部写副作用」清单上移到 `policy.mjs`**，`skill-manifest.mjs` / `publication.mjs` 同源 import（删掉第二份与第三份手抄拷贝）。清单**不是**从 `SIDE_EFFECT_RISK` 等级推出的（等级答「要不要人工」，清单答「要不要走发布段」），但两者必须自洽：清单每项都必须在风险表里且不得是 `LOW`，由单测锁住。

**D7.37 `decisions` 成为唯一审计落点，且接口上写不了状态轴**。`controller.recordDecisions(runId, records)` 的签名里没有可写状态轴的位置；审计记录**自身**也不许夹带状态轴字段（否则 decisions 会变成状态的第二入口）；空写入与终态追加同样被拒。

**D7.38 角色分离写进 manifest 契约**：`role ∈ {planner, reviewer}`，**缺省 planner**（既有 manifest 不带此字段，行为不变，有用例守着）。planner 必须声明 `proposalKinds`，reviewer 必须声明 `reviewVerdicts`。两个端口互为闸门（提案端口只接 planner，复核端口只接 reviewer）——把 reviewer 挂到提案端口上会让「谁提案、谁复核」静默失效。

**D7.39 复核必须绑定到这一份提案**（`proposalDigest` = 键排序序列化 + sha256），挡住「拿上一次的 ACCEPT 给这一次盖章」；**自审禁止按 name 判定**，version 不同也不行（换个版本号就能自审等于没禁）。

**D7.40 有结论就必须有理由与证据，ACCEPT 不豁免**。三种结论同等要求。理由是橡皮图章式通过是最危险的复核产物：无理由的否决至少可追溯，无理由的通过在审计里留下一个看起来正常的空洞。

**D7.41 复核层与提案层共用同一份「禁止字段 / 状态轴泄漏」判定**（私有函数改为导出）。状态轴泄漏只查键名为 `status/state/axis/phase/nextAction` 的位置而非全文匹配——`READY/UNKNOWN/NONE/HELD` 是通用词，全文匹配会误杀正常理由，而误杀会让 Agent 层「看起来总是坏的」并最终被绕过。

**D7.42 步骤的四条边界全部在运行时硬判**：候选集必须由调用方声明（`BOUND_CHECK_REQUIRED`，fail-closed）、必须在候选集内（`STEP_NOT_CANDIDATE`）、必须已登记（`STEP_NOT_REGISTERED`）、声明写外部且未授权不许自动执行（`STEP_REQUIRES_WRITE_AUTHORIZATION`）、输入键白名单 + 标量（`STEP_INPUT_FORBIDDEN`，`baselineCollectInput` 与 step 合并后再判，基线不能偷渡）、路径类输入必须真实存在且在 `allowedRoots` 下（`STEP_INPUT_OUT_OF_ROOT` / `STEP_INPUT_UNRESOLVED`）。**`pathKeys` 的语义是收窄而非开关**：`pathKeys: []` 无法关掉路径检查（回落按键名后缀自动识别），逃生门是把集合换成另一个键。

**D7.43 `planNextStep` 永不抛异常，且把「端口自己抛异常」也包住**。不能假设调用方一定用 `createAgentPort`/`createReviewerPort`：有人塞裸适配器进来时，Agent 层坏掉不能把整条确定性 SOP 带走。有用例喂五种恶意输入并断言收据字段恒等。

**D7.44 ESCALATE 不是失败**：`ESCALATE → PAUSE_FOR_HUMAN`（`humanRequired:true`、`fallbackRequired:false`）；复核者坏掉 → `RUN_FALLBACK`（`humanRequired:false`）；`REJECT → RUN_FALLBACK` 且复核理由进 `errors`。收据字段恒等，失败路径显式给 `humanRequired:false` 而不是省略——见第 10 节第 16 条。

**D7.45 PLAN 提案的表达面收敛为三个 claim**（`next.capability` / `next.collectInput` / `next.reason`）：Agent 能表达的东西必须可以穷举，不能把 `output` 整个当命令用。

**D7.46 复核者看到的是已通过边界的归一化步骤**（`bound.step` 透传到 `runReviewer`），不只是原始提案；否则「复核已通过边界的步骤」这句话在代码里不成立。这条是审查时发现注释与实现不一致后补的。

**D7.47 两条闸门守两种契约，都要有用例**：「agent 只声明 PLAN 却给出 CLASSIFY」→ `KIND_NOT_ALLOWED`（提案阶段）；「agent 声明了 CLASSIFY 并把它当步骤用」→ `PROPOSAL_KIND_NOT_PLAN`（解析阶段）。只留一条会让另一条静默退化。

**结构性结论**：注册表**一个字节都没变**（`registryDigest` 与迁移 6 相同，见第 8 节），skills 套件 500/500 与迁移 6 基线完全一致——本轮加的是**判决层**，不是新能力。这也让「Agent 可分性」从声明变成可测：Agent 层全部住在两个新模块 + `agent-proposal.mjs` 里，核心模块一个都没有 import 它们。

**本轮抓到的真实缺陷（3 条 + 1 处文档不符）**：① `createReviewerPort` 的失败返回路径缺 `humanRequired`，让「明确不需要人」与「这条路径忘了设置」无法区分（返回契约不完整）；② `reviewed.error ?? (…) || '…'` 是 `??` 与 `||` 混用的 SyntaxError（我新写的代码路径，`node --check` 才发现）；③ 测试夹具手抄了 `READ_ONLY_TOOLS` 且顺序写错，而端口把内部断言失败降级成了业务结论（`AGENT_FAILED`），把测试错误伪装成实现错误。见第 10 节第 16 条。

### 7.9 迁移 8：调度侧队列探测（「没有活」不是「失败」）

落点：新增 `runtime/sop-runtime/capability-scheduler.mjs`、`runtime-bootstrap.mjs`、`capability-scheduler.test.mjs`(16)；改 `two-stage-runner.mjs`（装配抽出 + `parseCliArgs({profile})`）、`index.mjs`（具名导出）；`skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs` 新增探测段 + 新增 `tests/queue-probe.test.mjs`(11)。深报告见 `MIGRATION-8-QUEUE-SCHEDULER-REPORT.md`。

**要解决的问题**：第 9 节原先记着「灰豚空队列没有驱动器」。灰豚采集段对 0 候选确定性拒绝 `NO_CANDIDATES`，而它的实现里写明「**由驱动器负责『空队列就不要再发起本能力』**」——但当时没有驱动器。于是调度侧只有两个选择：「照常发起」（每周空队列留一条失败 run，把「本周没有要补的词」写成故障，且与真正的策略拒绝无法区分）或「人工跳过」（跳过没有任何可审计载体）。本轮把「有没有活」做成一等公民：**先探测（只读、不建运行）→ 只有确认有活才发起**。

**D8.1 探测是能力自描述的入口**（`export probeQueue({ collectInput })`），与 `collectContract` / `createPublisher` 同构，**不占 manifest 字段**：探测没有副作用也不扩权，写进 manifest 只会白白移动 `registryDigest`，而那个摘要的变化意味着「能力面变了」，需要重新解释一遍。

**D8.2 五条出口 + 恒等收据**：`RAN` / `PROBED_ONLY` / `SKIPPED_EMPTY_QUEUE` / `PAUSED_FOR_HUMAN` / `PROCEEDED_WITHOUT_PROBE`，全部由**同一个工厂函数**产出，键集合来自 `SCHEDULE_RECEIPT_FIELDS`，工厂自带「漏字段即抛」自检。「字段恒等」因此是结构性成立的，不靠维护者记得补齐。

**D8.3 只在有确定结论时跳过，其余一律照常发起（全模块唯一一处 fail-open）**：`EMPTY` 跳过；`WAITING_HUMAN` 暂停等人工；`UNAVAILABLE`（探测器抛异常/加载失败/返回怪值）与 `NOT_PROBED`（能力没实现探测）**照常发起**。理由是失败方向不同：「多做一次本来会失败的运行」可见，「少做一次本来该做的活」不可见。跳过要求 `probe.probed === true` **且**状态属于 `SKIPPABLE_QUEUE_STATES`（只有 `EMPTY`/`WAITING_HUMAN`，有单测锁住不许扩容）。

**D8.4 探测不做策略判决**：表名、字段类型、队列规模、记录身份全部**原样抛出**，交给真实运行按既有分类判。在探测里复制一份的后果不是更安全，而是**假矛盾**（探测说有活、采集段却拒绝）。真实数据上的证据：一张缺 `内容热度` 的真实表探测得到 `UNAVAILABLE / FIELD_MISSING`（「我没探出来」），而不是「队列为空」。

**D8.5 能力只回三种正向状态**（`READY`/`EMPTY`/`WAITING_HUMAN`）；`UNAVAILABLE` 与 `NOT_PROBED` 是调度器的词。能力不需要回答「我探测失败了吗」。

**D8.6 状态白名单是「能不能跳过」的唯一闸门**：归一化（`normalizeProbeResult`）是**必然**步骤（注入的探测器同样要过），且必须**幂等**（默认实现已归一化过一次）——不幂等会让 `detail` 越套越深，把能力自带的细节（灰豚的 `pendingCount`/`sampleKeywords`/`recordCount`）埋进越来越深的一层里。幂等分支**不放松**判据：状态仍须属于 `QUEUE_STATES`，跳过仍要求 `probed === true`。

**D8.7 `null` 不是 `0`（同类缺陷第 4 次出现）**：`Number(raw.candidateCount)` 会把「未结算、候选数未知」变成「0 个候选」——正好是「假装知道」。修法是把 `null`/`undefined`/`''` 显式挑出来。

**D8.8 探测不要求 `resultsFile`**：探测发生在浏览器采集之前，那时结果文件还不存在；沿用采集段的 `REQUIRED_INPUT_KEYS` 会让探测永远探不出 `READY`，并以「总是 UNAVAILABLE」的形式安静地失败。探测有自己的 `PROBE_REQUIRED_INPUT_KEYS`，单测锁住「不含 resultsFile」。

**D8.10 装配收敛到 `runtime-bootstrap.mjs`（`two-stage-runner.mjs` 自迁移 2 以来首次改动）**：动机不是顺手重构，而是装配里藏着一个**必须两处一致**的默认值——store 是内存还是权威 PG。两个 CLI 各维护一份，早晚出现「一个跑在内存 store、另一个跑在权威库」的静默分叉，而恢复语义（游标/租约/账本/对账）失效时**看起来还是绿的**。同时给 `parseCliArgs` 加 `{profile:'probe'}`：探测不建运行，强制要三件套只会逼调用方传假值。两处都是纯提取/向后兼容，`run` profile 行为一字未改。

**D8.11 CLI 布尔开关必须在调度器层剥掉**：`parseCliArgs` 对任何 `--x` 都要求跟一个值，`--probe-only`/`--force-run` 是布尔开关，直接交给它以「缺值」报错。修法是 `parseSchedulerArgs()` 先剥两个开关再委托。**这条是跑真实 CLI 时才发现的**（单测全绿）。

**D8.13 探测不消除竞态**：探测通过后队列仍可能被清空，真实运行始终是权威。因此收据里两层都在：`queueState`（探测当时说的）与 `run.failureClass`（运行实际判的）。

**真实数据证据（只读）**：对真实关键词库 base 跑三次 `--probe-only`，三张真实表全部 `EMPTY / NO_CANDIDATES`（300~301 行记录、0 个 A 候选）；一张缺字段的真实表 → `UNAVAILABLE / FIELD_MISSING`；错表名 → `UNAVAILABLE / TABLE_MISMATCH`。再跑一次**完整调度**：`outcome=SKIPPED_EMPTY_QUEUE`、`scheduled=false`、`ok=true`、`exit=0`、work-dir 下**没有生成任何运行收据**——即本周真实数据上，「队列为空」从「一条失败的运行」变成了「一条说明为什么没跑的收据 + 退出码 0」。

**本轮抓到的真实缺陷（4 条）**：① `candidateCount` 把 `null` 当 `0`（D8.7，第 4 次同型）；② 归一化不幂等导致 `detail` 被套第二层（真实 CLI 输出里可见）；③ 测试用 `idFactory` 计数冒充「有没有建运行」——`idFactory` 造的是 **attempt id**，断言测的对象与它声称的结论不是一回事，属测试自己制造的假绿候选；④ CLI 布尔开关漏给下游解析器（D8.11）。见第 10 节第 17 条。

## 8. 验证证据（可复现命令与结果）

```
node --test "runtime/sop-runtime/*.test.mjs"
# tests 261  pass 261  fail 0  cancelled 0  skipped 0   EXIT=0
#   其中：task-queue 23、capability-scheduler 16、two-stage-runner 16、agent-planned-run 14、
#        agent-review 13、agent-proposal 13、workflow-controller 13、fanout 12、faq-fanout 12、
#        compression 12、memory 11、lane-concurrency 8，其余为既有模块
#   迁移 7 基线 244 → 迁移 8 之后 261（+16 调度器、+1 运行器 CLI profile）

node scripts/run-test-suite.mjs skills --concurrency=1
# ==> skills: 43 file(s)（迁移 7 为 42：新增 huitun tests/queue-probe.test.mjs）
# tests 511  pass 511  fail 0  cancelled 0  skipped 0   EXIT=0
#   迁移 7 基线 500/42；本轮 +11（灰豚探测 8 + 调度集成 3），其余 500 与基线完全一致 = 无回归

node scripts/run-test-suite.mjs runtime --concurrency=1
# ==> runtime: 59 file(s)
# tests 361  pass 361  fail 0  cancelled 0  skipped 0   EXIT=0
#   覆盖整个 runtime/（sop-runtime 的测试不在这个发现规则内，单独跑，见上面第一条）

# 调度器 CLI 对真实飞书表跑只读探测（不需要授权写，也不建运行）
node runtime/sop-runtime/capability-scheduler.mjs --capability huitun.keyword-heat.collect --probe-only \
  --collect-input '{"envFile":"E:/小红书/.env.local","appToken":"N21Abkg0HakO6AsbCaDckvcwnVd","tableId":"tblN1uT1LpzyqqWx","tableName":"关键词分析 V1（修正版）"}'
# outcome=PROBED_ONLY  queueState=EMPTY  queueCode=NO_CANDIDATES  candidateCount=0  exit=0
# detail: recordCount=301 / fieldCount=26 / candidateMode=A_ONLY（能力自己给的事实，未被信封再套一层）
# 另外三张真实表：09-12 / 09-11 两张同为 EMPTY（300 行）；关键词历史总表 V1 → UNAVAILABLE/FIELD_MISSING（缺 内容热度）
# 错表名 → UNAVAILABLE/TABLE_MISMATCH（「探不出来」，不是「队列为空」）

# 同一条命令去掉 --probe-only（真实表 + 真实身份 + 真实业务键）
# outcome=SKIPPED_EMPTY_QUEUE  scheduled=false  ok=true  humanRequired=false  run=null  exit=0
# work-dir 下没有生成任何运行收据 —— 这就是本轮要买的东西

node --test skills/xws-export-market-analysis/tests/prepare-flow.test.mjs
# tests 36  pass 36  fail 0
#   修复前：第 6 个用例（bounded settlement deadline）断言恒假，从未通过；
#           走「导出成功」路径的 full-flow 用例（第 16 个已实测）不会失败得很快，
#           而是一直轮询到 60 分钟的 final deadline 才报 timeout——看起来像挂死。
#           见第 10 节第 12/13/14 条。

node --test skills/huitun-to-feishu-keyword-heat/tests/adapter-huitun-keyword-heat.test.mjs
# tests 34  pass 34  fail 0
#   真 registry/loader/Controller/证据库/Ledger/runTwoStage 驱动；store 在内存、Feishu 客户端注入假实现
#   （假实现记录调用次数，使「幂等不二次写入」「未开闸时零外部调用」被断言而不是被相信）

node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 10 manifest 通过（能力 8 + 适配器 2）
# registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48
# 告警 5 项，全部是 adapter.browser 显式外部依赖（共享 CDP 代理不在仓库内）
# ↑ 迁移 7 / 迁移 8 前后此摘要完全相同：两轮都没有新增/修改任何 skill manifest
#   （迁移 8 的探测是能力自描述的入口，既无副作用也不扩权，因此不占 manifest 字段）

node runtime/sop-runtime/run-faq-fanout.mjs --period-start 2026-09-06 --period-end 2026-09-12 \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"xws","accountId":"operator","browserProfileId":"local","contractVersion":"xws-16f-v1"}' --no-write
# 真实证据实测：1 个商品（678598686014，已下架、0 行证据）
# → total 1 / dispatched 1 / collected 1 / complete true / publishable true / requiresHuman false
# → evidenceStatus=VALIDATED  executionStatus=SUCCEEDED（0 行证据被正确判定为合法）

node runtime/sop-runtime/recovery-fault-injection.mjs
# 15/15 通过（需 CREATEDB 身份；临时库 sop_fault_*，跑完即删）

# 真实入口跑一遍 sycm.feishu.weekly 的采集段（真实 300 行导出对 + 真实 PG store，不写外部）
node runtime/sop-runtime/two-stage-runner.mjs \
  --capability sycm.feishu.weekly \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"sycm","accountId":"operator","browserProfileId":"local","contractVersion":"sycm-weekly-v1"}' \
  --target 'https://kcne618basvj.feishu.cn/base/HdBhbttB5aScbasWJAMc0gXnpe?table=tblrX0GM7HkVhF85' \
  --business-key sycm-weekly-rehearsal-20260826 --expected-rows 300 \
  --work-dir runtime/sop-runtime/weekly-rehearsal-20260914 \
  --database-url postgresql://xws_agent:<pw>@127.0.0.1:5432/xws_automation \
  --collect-input '<见 §13.4 的完整入参>' --json
# ok=true  runId=5857b2e2-5d47-4282-876b-8d5bc9287c4c  mode=dry-run  exit=0
# collect: 8 个采集期验证器全 ok（source_identity/scope_match/structure/row_count/digest/
#          contiguous_prefix/artifact_integrity/adapter）
#          sha256=501e4dd66c06dcca4d9c22b46d10cac1fb340ba676b7191622dcb6b7316e7da9
#          rowCount=300  artifact=sycm-weekly-source
# publish: NOT_ATTEMPTED（采集段完成；发布段需要 --commit 与人工授权）
# final:  publicationStatus=NOT_REQUESTED  executionStatus=SUCCEEDED  nextAction=TERMINAL
#         cursorAdvanced=false（收据只证明采集段，不冒充发布已验收）

# 真实跑一遍发布段（--commit = 真实外部写入；场地=应用自持沙盒 base，见 §13.6）
node runtime/sop-runtime/two-stage-runner.mjs \
  --capability sycm.feishu.weekly \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"sycm","accountId":"operator","browserProfileId":"local","contractVersion":"sycm-weekly-v1"}' \
  --target 'https://kcne618basvj.feishu.cn/base/G32Lb4s4lauMjnsWP3Oc6TBjneg?table=tbllwOVjo0wH1lvY' \
  --business-key sycm-weekly-publish-drill-20260826 --expected-rows 300 \
  --work-dir runtime/sop-runtime/weekly-publish-drill-20260914c \
  --database-url postgresql://xws_agent:<pw>@127.0.0.1:5432/xws_automation \
  --collect-input '<见 §13.6.2：outputDir/sourceCsv/sourceXlsx/collectionDate=2026-08-26/batchNumber=8/expectedHistoryBefore=2067/category=浴缸/target(沙盒)>' \
  --commit --env-file E:/小红书/.env.feishu-kcne.local --operator user-approved-2026-09-14 \
  --publish-input '{"dryRun":false,"envFile":"E:/小红书/.env.feishu-kcne.local"}' --json
# ok=true  runId=e21c96c9-8fe1-4aa6-bd11-4d3e17c4e2b6  mode=commit  exit=0
# gate:    APPROVED / ALLOW_WITH_APPROVAL / HIGH
# collect: 8 验证器全 ok  sha256=c22591eb17bfec4c8341eb061d7af28c98ab3944a6261dbe627783265317097e  rowCount=300
# publish: verdict=VERIFIED  commitKey=568f8fe8509212295dd8ccd7da936326
#          receipt rows=300  historyRows=2367  weeklyTableId=tbl2lZoEyTfxEfoB
#                  digest=d3d5e59abfcc845f3a04d447cac8c0a18fc1221f7dcd02f91a28ffffc4aafaf6
#          validation: readback:ok  publication:ok（0 失败码）
# final:   publicationStatus=VERIFIED  executionStatus=SUCCEEDED  nextAction=TERMINAL
#          cursorAdvanced=true  verifiedCursor 1 → 300
# 修前同一条命令：verdict=UNKNOWN（外部写入成功、自动回读拿不到凭据），见 §13.6.2
# 独立回读沙盒（不用运行时的客户端）：新周表 300 行 / 历史 2367（批次 8 = 300）/ 编号库 475

node scripts/run-test-suite.mjs skills --concurrency=1
# ==> skills: 44 file(s)
# tests 532  pass 532  fail 0  cancelled 0  skipped 0   EXIT=0
#   §13 收口时 +1（adapter-feishu-weekly 的凭据接线回归用例，22 → 23）；§13 收口前记录的基线为 511/43 文件

# sop-runtime 全量（24 个 .test.mjs）。注意两件事：
#   1) 套件运行器只发现 runtime/*.test.mjs，**不递归** runtime/sop-runtime；
#   2) 本项目约定「显式文件列表优于 shell 通配」（docs/standards/README.md），
#      所以这一步是把那 24 个路径显式传给 node --test。
node --test <runtime/sop-runtime 下 24 个 .test.mjs 的显式列表>
# ==> 24 file(s)
# tests 299  pass 299  fail 0  cancelled 0  skipped 0
#   基线 265；§13.7 新增 run-liveness.test.mjs（16）+ recovery-unresolved.test.mjs（18）= +34

node scripts/run-test-suite.mjs runtime --concurrency=1
# ==> runtime: 61 file(s)
# tests 397  pass 397  fail 0  cancelled 0  skipped 0   EXIT=0

# 真实库只读探针（只有 select；未写入业务库）：验证新增 store 端口 listCommitsByRun
# 一次性脚本（跑完即删，故不随仓库提交）；下面是它的输出原文
node .tmp-probe-listcommits.mjs
# unknownRun: []                     （未知 runId 返回空数组，不抛错）
# byRun: commitKey/runId/status/businessKey 映射正确
# statusDistribution: { COMMITTING: 1, VERIFIED: 2 }   ← 那个 COMMITTING 就是 b4e7e120（§13.7.1 的真实样本）
```

注意：`node --test runtime/sop-runtime`（传目录）在 Node 22 会报 `MODULE_NOT_FOUND`，必须传通配展开后的文件列表。
注意：`--test-timeout=<ms>` 对**整个测试文件**同样生效（文件本身也是一个测试）。给慢套件设 4 分钟会在第 22 个用例处把文件级用例超时取消，表现为「`# pass 22 / # fail 0 / # cancelled 1`」而不是失败——排查时不要把它当成用例失败。

## 9. 已知缺口（审查时请优先看这里）

| 缺口 | 性质 | 为什么还没做 |
| --- | --- | --- |
| 发布段从未对**真实 base** 执行过 `--commit` | 能力缺口（**已部分关闭**） | 2026-09-14 已补做 `xws.feishu.import`：用户授权的一次性演练表（应用自有 base 内新建 `_演练_xws_import_20260914`，16 字段合同、演练后 DELETE），真实提交得 `verdict=VERIFIED` / `commitKey=e4c775a0…` / 回读 rows 3 + attachments 3 / 游标 1→3，独立回读三行内容一致，见 MIGRATION-8 §8。**仍未真实跑过的是 `sycm.feishu.weekly`（见下面两行与 §13.4）、`xws.sku.collection` 与 `huitun.keyword-heat.collect` 的发布段**（这三条各自还差一次同类演练）。注意：用户原本指定的表在租户 `kcne618basvj`，与本应用所属租户 `rcndesfqro3x` 跨租户，飞书自建应用不能被跨租户加为协作者，因此换到应用自己的租户演练。**2026-09-14 晚续**：为 `sycm.feishu.weekly` 搭好「应用自持沙盒 base」（§13.5.1）后真跑，**先撞到一条更靠前的代码侧缺陷**——库约束不接受 `FAILED`，失败路径连收据都写不出来（§13.5.2），已修并验证（§13.5.3）；但该条能力的发布段**仍未跑成**，卡在两个彼此独立的前置上（§13.5.4）。**2026-09-14 深夜续**：两个前置都已清零（006 已 apply、用户在共享浏览器完成飞书登录），`--commit` 真实跑通并要求验收：`verdict=VERIFIED`、回读 `rows=300 / historyRows=2367`、`publicationStatus=VERIFIED`、`cursorAdvanced=true`（游标 1→300）——过程里又抓到一条凭据接线缺陷（§13.6），现已可关闭**本行**；`xws.sku.collection` 与 `huitun.keyword-heat.collect` 两条的发布段仍未真实跑过 |
| `supervisor_commit_records.status` 词表与运行时 `COMMIT_STATUS` 不一致 | **已修并已 apply** | 001 的 CHECK 缺 `FAILED`，运行时账本失败时会写它 → 真实 PG 上抛约束异常、失败路径丢收据。已新增 `db/migrations/006-commit-record-status-vocabulary.sql`（+ fail-closed 回滚）与仓库级守卫 `commit-status-vocabulary.test.mjs`，隔离库 26/26、故障注入 17/17 通过；**2026-09-14 晚经用户授权 apply 到业务库**（备份 `db/backups/pre-006-20260914-225707.sql`，回读：7 值、写 `FAILED` 成功、非法值仍被拒、复跑幂等、数据未动）。见 §13.6.1 |
| 运行的**发布轴没有 `UNKNOWN` 出口** | **已修（§13.7.1）** | `settlePublication(VERIFIED)` 要求 `current === 'COMMITTED'`、`markPublicationCommitted` 只收 `READY \| COMMITTED` → `UNKNOWN` 落在运行上就再也到不了 `VERIFIED`，即使提交记录已通过对账变成 `VERIFIED`（§13.6.5 缺口 A，实测抛 `PUBLICATION_STATE`）。`reconcileUnknown` 只回写提交记录、从不回写运行，缺的正是半截。**2026-09-14 深夜用户答复「都修」后补齐**：新增 `controller.reconcilePublication`，前置状态 `UNKNOWN \| READY`；`verdict='VERIFIED'` 要求真实回读收据 **且** 该运行所有提交记录已 `VERIFIED`（强制「先对账账本、再收敛运行」），`verdict='ABSENT'` 要求具名操作者且无任何提交记录处于「可能已交付」状态。修的过程中在真实库上发现**同源的第三格** `READY + COMMITTING`（崩溃遗留的 `b4e7e120`）——它同样没有任何出口，已一并纳入。见 §13.7 |
| **未终结的运行永久占住幂等键** | **已修（§13.7.2）** | 准入去重走 `listActiveRuns`，`LANE_ACTIVE_STATUSES` 含 `RUNNING`，无 stale 回收；`duplicateOf` 全仓库无人消费（无 resume 通道）。同一幂等键被挡两次（`b4e7e120` 崩溃遗留、`3dae7ad4` 判 UNKNOWN 后），两次都靠 `controller.cancel(runId)` 手动释放，而它的 blocker 语义是 `POLICY_DENIED/cancelled`，与「崩溃/结果未定」都不贴切。**2026-09-14 深夜用户答复「都修」后补齐**：新增 `run-liveness.mjs`（**死活看租约、回收安全性看提交记录，两个判据分开**）、`controller.assessRun` / `reclaimStale` / `reclaimStaleRuns`、store 端口 `listCommitsByRun`（缺则 fail-closed），以及准入可选自动回收（两段式运行器默认开启）。回收被拒不是错误，而是带回 code 的判定结果。见 §13.7 |
| `xws.sku.collection` **写前新鲜度重算**缺失（D7.25） | 能力缺口 | 运维 CLI（`apply-xws-sku-manifest.mjs`）写入前会重跑一次 dry-run 并 `assertFreshPlanMatchesManifest`；运行时路径离线不可用，只有「写前哈希绑定 + 写后回读收敛」。补法是在 COLLECT 里加一次需要 Feishu 只读凭据的新鲜度重算，或把 CLI 的 fresh-dry-run 提升为可复用的只读能力。本轮不做：会引入第二条 Feishu 读路径，而收益（拦截「工件已过期但表状态未变」的窗口）需要先在真实写入中被观测到 |
| `xws.sku.collection` **不复算**解析结论（D7.17） | 刻意取舍 | 能力复算的是「这批证据 ↔ 这份计划」的一致性，不是 `SKU名称/规格/尺寸/适用空间` 的解释结果。解释结果由 `sha256(parserFile) === manifest.parser.sha256` 绑定版本，而不是被重新推导。审查者若要质疑某行的解析是否正确，必须回到 dry-run 环节，而不是指望适配器 |
| `sycm.search-rank.export` 未被**真实浏览器**驱动过 | 能力缺口 | 迁移 4 只把它接到了运行时并用夹具流程端到端驱动（真 registry/loader/adapter/证据库/Controller）。真实跑需要 Edge 调试实例上的生意参谋登录态；本轮没有重新登录 |
| `xws.sku.collection` 未被**真实飞书**驱动过 | 能力缺口 | 同上：端到端测试用真 registry/loader/adapter/证据库/Controller/Ledger，只有 store 在内存、Feishu 客户端是注入的假实现（并记录调用次数，使「幂等写入」被断言而不是被相信） |
| 迁移顺序第 7 项**只完成了一半：判决层已就绪，未驱动真实能力集** | 范围缺口 | 七个迁移项至此全部落地：第 1 项（XWS 单分片）、第 2 项见 7.4、第 3 项见 7.6、第 4 项见 7.5、第 5 项（SYCM→Feishu）见迁移 2、第 6 项见 7.7、第 7 项见 7.8。但第 7 项的交付边界要说准：`agent-review.mjs` / `agent-planned-run.mjs` 把「Agent 提议什么 ≠ 运行时允许什么」的四条出口与四条边界做完了，**却没有一条真实 SOP 走进去**——`planNextStep` 的入参目前只由测试构造。理由：现有能力（迁移 2/3/4/5/6）都是单步或固定 fan-out，没有一条是「需要 Agent 挑下一步」的多步 SOP，先做驱动器只能服务一个虚构场景 |
| 多 Agent 并发（阶段 6 标题里的「高并发」）**仍未开始** | 范围缺口 | 本轮做的是 Agent 侧的分权与降级。并发放大仍受实施计划第 6 节的风险条款约束（必须基于资源容量证据），当前 lane 结论仍是 D7.4 / 阶段 6 lane（写恒 1、只读可放宽） |
| Planner/Reviewer **未接入真实模型** | 有意保留 | 测试里两者都是注入的确定性桩。接真模型前必须先定「模型输出非法时降级到什么」，而那正是本轮交付的四条出口（`RUN_FALLBACK` / `PAUSE_FOR_HUMAN` / `AGENT_FAILED` / `REJECT`）——顺序上先有出口再接模型是对的 |
| `AGENT_REJECTION` 里三个码**无抛出点** | 声明性残留 | `WRITE_EFFECT_FORBIDDEN` / `TOOL_NOT_READ_ONLY` / `FALLBACK_MISSING` 全被 `validateAgentManifest` 折进 `MANIFEST_INVALID`（具体文本只在 `errors[]`），运行期拿不到这三个码。已核对全仓库只有枚举声明与枚举断言引用它们。不是缺陷（注册期拒绝理由本就该收敛），但按码分支会匹配不到，审查者可据此决定删还是让其在运行期生效 |
| `assertAgentRemovable` 的依赖检查是**文本级**的 | 技术债 | 用正则匹配 `agent-(proposal\|port\|runner)`，换文件名即可绕过。真正可靠的做法是解析 import 图；本轮没做，因为注册表构建不跑这个检查（它只在测试里作为静态证明使用） |
| `recordDecisions` 只做**顶层**状态轴检查，不递归 | 刻意取舍 | decisions 是**追加**进 `context.decisions`，不会被应用到上下文上，所以嵌套轴名无论如何改不了状态；顶层检查的实际作用是「不许审计记录*长得像*一个状态载体」。可辩护，但不是「不可能」 |
| `huitun.keyword-heat.collect` 的**空队列调度**（原记：没有驱动器） | **已关闭（迁移 8）** | **D8.1~D8.13**：`capability-scheduler.mjs` 先读队列、确认有活才发起；`EMPTY` 跳过（`ok:true`、退出码 0、不留运行记录）、`WAITING_HUMAN` 暂停等人工，其余一律照常发起。真实表实测：三张真实关键词表全部 `EMPTY` → `SKIPPED_EMPTY_QUEUE` + work-dir 无运行收据。原先担心「会引入第二条飞书读路径」确实发生了，但那条读路径**是能力自己的**（`probeQueue` 复用采集段同一套只读面），且它不做任何策略判决，因此没有长出第二个策略引擎。余下的取舍见下面三行 |
| 调度器**只支持单能力**，没有多能力编排 | 范围缺口 | 本模块是「一问一答一跑」的单能力驱动器。遍历所有已登记能力、按优先级排产属于上层编排；现在做只能凭空设计一个没有使用者的调度器 |
| 探测结果**没有缓存 / TTL** | 刻意取舍 | 每次探测是一次真实飞书只读（约 300~3000 行）。周更频率下不构成成本；若变成高频调度，缓存与退避**必须一起做**，否则「缓存失效」会成为新的静默漏做来源 |
| 探测与 `task-queue` 的队列语义**没有打通** | 刻意取舍 | `task-queue` 管「运行时自己的任务队列有多深」，探测管「外部业务队列有没有活」。混在一起会让「没活」与「拥堵」变成同一个信号 |
| `huitun.keyword-heat.collect` 的浏览器采集段不在运行时路径上 | 有意保留 | 采集仍由 `run-huitun-topic-heat.mjs`（CLI）承担，运行时入口不发起任何浏览器动作（D7.26）。代价是「采集」与「回填审批」之间的断点仍靠操作者对 `results.json` 的处置，而不是靠运行时状态 |
| FAQ 的**周期级发布段**未迁移 | 能力缺口 | 商品级采集与隔离已落地，但「问题主库/问题库替换」仍由 `publish-faq-detail-enrichment.mjs` 这条旧 CLI 承担；把它接入两段式需要真实可写目标表与单独授权 |
| FAQ 的周期级完成判定仍由 `run-faq-operator.mjs` 负责 | 有意保留 | fan-out 只回答「商品级是否全部结算」；周期级阶段机未改，避免一次改动同时动两套语义 |
| `xws-sku-collection` 目录内仍只有适配器，**采集 CLI 未搬入** | 技术债 | `capture-xws-sku-payload` / `collect-live-xws-sku-topology` / `run-xws-sku-dry-run` / `apply-xws-sku-manifest` 留在 `runtime/`，能力只吃它们产出的本地证据。搬迁是纯重构（收益是「Skill 目录内自洽」），风险是改动一条已验证的采集链，留给后续独立一轮 |
| 限流/熔断不 durable | 刻意取舍 | 见 D6.3；跨进程一致的限流需要落库或外置，属独立设计 |
| pg-store 的 `context.queue` 不能单独索引 | 刻意取舍 | 见 D6.2；按队列维度查询只能全表扫描，量级上去需另设计 |
| 迁移 1 的专用运行器未改用通用运行器 | 技术债 | 保留为人工入口（`run-feishu-import-two-stage.mjs`）；迁移 5 已实证通用运行器能承载外部写能力，改用属低风险重构，未排入本轮 |
| **两条能力已登记但未接入运行时**（实施计划阶段 4 的「优先迁移一条 XWS 市场分析流程」未做） | 范围缺口（§12.4 第 1 条补记） | 实测入口：`xws.market-analysis.collect@1.0.0` 的 `entry` = `scripts/run-adaptive-export.mjs`、`xws.faq.raw-collect@1.0.0` 的 `entry` = `scripts/append-faq-event.mjs`，都是旧 CLI 而不是 Worker 契约适配器。10 个 manifest 里 6 个已接线、2 个未接线、2 个是适配器 manifest。未做的原因：这两条是周更 SOP 的**采集前置**，迁移它们不会减少任何外部写风险，收益低于当时在做的外部写与调度侧 |
| **`sycm.feishu.weekly` 仍有裸 `throw new Error(...)`**（阶段 4「统一错误分类」的唯一真缺口；其余 5 条能力都有确定性码表或 error class） | **已关闭（§13.1）** | 原记「8 处」实测为 10 处（源码守卫抓出 `defaultReadRecords` 漏掉的两处）。修法：词表 + `fatalError()` 放能力自己的模块、适配器内两段共用；`policy.mjs` 一行未改。见 §13.1 |
| **`sycm.feishu.weekly` 发布段的 `readBack` 拿不到 handler 造出来的新表 id** | **已关闭（§13.2）** | `side-effect-ledger.mjs:76` 不把 handler 返回值交给 `readBack`。修法：能力内部用闭包把「handler 运行期产生的值」带过去，缺失时抛 `PUBLISH_TARGET_UNKNOWN`；跨进程对账仍要求调用方显式给 `publishInput.weeklyTableId`（写在报错里，不静默降级）。回归由收据层用例锁住，见 §13.3 |
| **`sycm.feishu.weekly` 的发布段仍未对真实目标执行过 `--commit`**（且不是「没入口」，是缺外部前置） | 能力缺口（§13.4） | 两个前置本轮都不具备：① 克隆周表这一步**是浏览器驱动的**（`copy-weekly-table.mjs` 经共享 CDP Proxy 操作飞书前端，不调 OpenAPI），要动用户正在用的浏览器；② 发布段按设计会写 `关键词历史总表 V1`（2067 行 / 批次 1-7）与 `关键词编号库 V1`（475 行）——拿演练写生产表会把假批次 8 灌进真实历史。**先由用户定跑法**（真实生产写入 / 另备一次性演练表 / 先不跑） |
| Temporal 去留**无书面结论** | 记账缺口（§12.4 第 4 条） | S1 故障注入已用 PG 路径完成（15/15），按 spec 本该据此给出保留/弃用结论；实际是「默认由 PostgreSQL 承担、POC 原样留在 `agent-runtime/temporal/`」。README §11 仍列在待决策 |

注：原先记在这里的「`advanceCursor` 前置条件尚未收紧（有意延后）」已在迁移 7 由 **D7.35** 关闭——判据取自上下文里的准入声明（`sideEffects`），而不是 manifest 或调用方参数。

## 10. 历史缺陷清单（「静态审阅发现不了、实测才能抓到」的那一类）

审查同事若想判断这套东西的可信度，看这一节比看设计更快。全部已修，均有测试或实测复现路径。

1. **pg-store 返回 snake_case，端口契约是 camelCase** —— `controller.recover` 读到 `leaseExpiresAt=undefined`，永远不会认领过期 lease（恢复功能静默失效）。
2. **`updateAttempt` 只认 snake_case 白名单** —— `leaseState/endedAt/failureClass` 被静默丢弃，被杀 attempt 没被标记为过期。
3. **`side-effect-ledger.reconcileUnknown` 绕过 `keyOf` 直接读 `record.commit_key`** —— 内存 store 上 `commitKey=undefined`，对账收据丢掉唯一定位键（这是第 1 条的同源残留：只修了主路径、漏了对账分支）。
4. **pg Pool 无 error 监听** —— 数据库重启/临时库 DROP 直接把进程打崩。
5. **`beginAttempt(runId, { write })` 参数遮蔽外层 `write()` CAS 函数** —— `write is not a function`。
6. **`buildSummary` 的 spread 顺序** 让 context 的 schemaVersion 覆盖摘要自己的版本，摘要被自己的校验器判为缺字段。
7. **`collectContract().requiredFields` 声明的键不在被校验对象上** —— `structure` 验证器空转通过。
8. **准入把「并发约束」当「重复约束」用** —— 见 D7.1，商品级 fan-out 无法实现。
9. **`memory-store` 跨层自动退役** —— 用「删掉历史」冒充「当前优先」，已改为只在同层内退役。
10. **执行槽占用按 run 状态判定** —— `LANE_EXECUTING_STATUSES` 含 RUNNING/RETRY_WAIT/PAUSED，于是「跑完一次 attempt、正等 COMMIT」的 run（`completeAttempt` 后仍是 RUNNING）和「失败等人工」的 run（PAUSED）会把 lane 永久占死。在真实商品级 fan-out 上表现为**整批卡在第一个子项之后**（3 个子项只跑完第 1 个，第 2 个 `LANE_SATURATED`），也表现为「一个商品失败 ⇒ 其余商品全部排不进去」。改为 `occupiesLane`（RUNNING + lease HELD），见 D7.4。
11. **run 永远不终态** —— 两条已迁移路径都不调 `controller.succeed()`，`completeAttempt` 之后 `executionStatus` 一直是 RUNNING。后果是 run 永远算活跃（占队列深度、旧口径下占 lane），且没有任何东西能回答「这条 run 结束了没有」。见 D7.5。
12. **`skills/xws-export-market-analysis/tests/prepare-flow.test.mjs` 的「bounded settlement deadline」断言自 `4fd523b` 引入起从未通过过** —— 它用测试自己的时钟 `startedAt` 作基线，而 `deadlineAt = requestedAt + 5min` 且 `requestedAt >= startedAt`（通常差数毫秒），因此差值恒 > 5 分钟。改为用意图自身持久化的 `requestedAt` 计算，并保留「有界」「远短于最终 60 分钟窗口」两条安全断言。**这条比它本身更值得注意：它说明该 skill 的长测（单文件上千行、上百用例）容易被漏跑，缺陷可以静默存活数月。**
13. **`prepare-flow.test.mjs` 的假代理与运行器的导出激活路径脱钩（自 `db4e1c5` 起）** —— `db4e1c5` 把 CSV 导出的激活方式从 CDP 坐标点击（`/clickAt`）改成页面内合成 `MouseEvent` 派发（`/eval`，`clickExportControl`），理由是真实页面里 Element 的 loading mask 会吞掉坐标点击。但**假代理只在 `/clickAt` 分支里写下载产物**，`/eval` 分支没有对应实现且落到了兜底分支（返回一个字符串）。后果链条：
    `clickExportControl` 静默变成空操作（它不检查返回值）→ 下载文件永不出现 → `waitForDownload` 一直轮询到 **60 分钟**的 final deadline → 该用例报 `timeout`。
    表现极具误导性：文件级 36 个用例、`# pass 22 / # fail 0`，真正运行时间却按小时计；实测第 16 个用例（`full flow retries a missed start click and validates the downloaded CSV`）在修复前跑到 30 分钟仍未结束（输出目录为空、意图停在 `OPEN`、`events.jsonl` 里 52 条 `WAITING_FOR_DOWNLOAD`），修复后 27 秒通过。
    这正是第 12 条末尾那句话的实证：**一条成功路径上的用例可以长期不产生任何失败信号**。修法是让假代理在两条激活路径上都产出同一份夹具（抽出 `csvFixture()`，并在 `/eval` 上补一个要求同时出现 `data-xws-export-csv` 与 `dispatchEvent` 的分支——标记阶段的 `/eval` 不含 `dispatchEvent`，不会误入）。

另有三处是**测试期望写错、实现未改**，一并列出以免被误认为实现缺陷：manifest 声明未实现验证器应归 `CAPABILITY_DEGRADED`（能力定义坏了）而非 `EVIDENCE_INVALID`（证据不合格）；队列单测把「已被取走的令牌」当成还有；用容量 1 的限流器测 refund 路径（走不到准入就已被限流挡住）。另外 `lane-concurrency` 里「等提交/等人工不占槽」的新回归测试最初把 `EVIDENCE_INVALID` 的落态写成 PAUSED（实际是 `evidenceStatus=REJECTED`、执行轴仍 RUNNING），也是测试期望写错。`--test-timeout` 的文件级语义（见第 8 节末）也坑了一次：把慢套件的文件级用例提前取消，输出看似「没有失败」。

14. **`prepare-flow.test.mjs` 的 XLSX 菜单用例在 `/eval` 迁移后失去判别力（与第 13 条同源、同一提交 `db4e1c5`）** —— 三处脱钩：
    (a) `xlsxCaretClicks` **只在 `/clickAt` 分支自增**（第 334 行），而 caret 激活自 `db4e1c5` 起改走 `clickExportControl`（`/eval` + 合成 MouseEvent 派发），该分支再也走不到，计数恒为 0。它却是假代理里三条菜单状态判定的**输入**：`send(!staleXlsxMenuVisibleOwned || xlsxCaretClicks >= 1)`（菜单是否已关闭）、`send(xlsxCaretClicks >= 2)`（是否已重新打开）。于是「菜单已关闭」永远为假 → 循环 2 秒后整条 full flow 抛 `existing XLSX menu did not close before activation`。
    (b) 五个用例断言的 `getXlsxCaretClicks()` 具体计数随之全部错位（期望 2/2/1/1，实得 0）。
    (c) 第 6 个 XLSX 用例的 stdout 断言 `/"event":"EXPORT_STARTED","format":"csv","reason":"final"/u` 要求三键**相邻**，而事件记录自 EVIDENCE-CONTRACT.md 起固定携带 `runId/attemptId/seq` 且插在 `event` 之后——该断言**在任何提交上都永远不可能通过**（实测 stdout 里是 `"event":"EXPORT_STARTED","runId":…,"attemptId":…,"seq":12,"format":"csv","reason":"final"`）。
    与第 13 条完全同类：这五个用例此前**不产生任何失败信号**——它们卡在 `waitForDownload` 的 60 分钟轮询上，永远只是 timeout，慢得没人会等下去。
    实测：修复前 `# tests 36 / pass 31 / fail 5`，5 个失败全部由本条造成（且全部耗时 19–24 秒，即「不再挂死、真正跑到断言」之后才暴露）。修法：在 `/eval` 上补一个要求**同时**出现 `data-xws-export-caret` 与 `dispatchEvent` 的计数分支（标记阶段的 `/eval` 只调 `setAttribute`、不含 `dispatchEvent`，不会误入），并把 stdout 断言改为「同一行内出现这三对键值、不要求相邻」。**注意改的是测试而不是实现**：事件记录的形状是契约要求的，`xlsxCaretClicks` 也只是测试夹具的观测点。

15. **回读对账被自己的成功结果挡住（迁移 6）** —— `createPublisher().reconcile()` 把「live 队列指纹 == 工件指纹」当成**无条件**的写前硬门。但这条能力的写入会触发 `优先级` 公式重算，而公式重算会把行**移出 A候选 队列**：一次成功回填之后，live 指纹必然与工件不同。后果是：进程死在「飞书已写、本地未记账」之间 → 重跑对账（`UNKNOWN` 路径，也是这份设计里**唯一**被允许的恢复动作）→ 被判 `QUEUE_CHANGED` → 永远走不到自己的成功状态，且收据给出的原因（「队列变了」）指向错误的方向。
    这条在静态审阅里完全看不出来：代码读起来像一条更严的守卫，只有把「写之后的状态」摆进夹具才会暴露。修法：指纹检查移到逐行对账之后，只在 `stillBlank.length > 0`（确实还要写点什么）时生效。两个方向各有一例——值都已写入 → 0 次写入 + 回读收敛；新增一个 A候选 行（有东西要写）→ `QUEUE_CHANGED` 且一次写入都没发生。同类的前一条（迁移 5 缺陷 ②）是「`validate()` 要求 `rowCount` 必然存在」，本轮又抓到相反方向的一条：`validate()` 要求**全部**表面字段都被提供，于是「只拿字节 + 摘要」的第三方复核路径被判 `STRUCTURE_INVALID`。两条合起来说明一件事：**工件表面字段是框架派生的，任何一侧的「必然存在」假设都会打断跨进程/第三方复核**。

16. **返回收据「少一个字段」被当成契约成立（迁移 7）** —— `createReviewerPort().review()` 的成功路径返回 `humanRequired: verdict === 'ESCALATE'`，而两条失败路径（`AGENT_FAILED`、复核非法）**根本没有这个字段**。代码读起来完全正常：`undefined` 是假值，「失败 ⇒ 不需要人」的语义恰好成立，测试也不会有任何失败信号——除非有人去问「这个字段到底有没有被设计出来」。它真正的代价是**调用方没法区分「明确地不需要人」与「这条路径忘了设置」**，而这两者在将来（比如加一条「复核超时也算需要人」的规则）会导出不同的行为。修法是让返回契约**全量**：每条路径都显式给出 `humanRequired`（失败恒 `false`），`planNextStep` 的 `emptyPlan` 默认形状同样补齐，并把用例改成断言 `Object.hasOwn(result, 'humanRequired')` 而不是 `=== false`。
    同一轮里另外两条同源表现，形态都是「静态读起来没问题」：① `reviewed.error ?? (…).join('; ') || '…'` 是 `??` 与 `||` 混用无括号的 **SyntaxError**——新写的错误消息路径，`node --check` 一眼可见，但整份套件只报「某文件加载失败 + 3 条用例全挂」，失败信号指向别处；② 测试夹具手抄了一份 `READ_ONLY_TOOLS` 且顺序与源不一致，断言在 `runReviewer` 内部抛出后**被端口自己的 catch 收成 `AGENT_FAILED`**——于是「测试写错了」在报告里长得像「合法复核被判失败」。②这条最值得记：**一个把内部异常降级成业务结论的边界，会把测试错误伪装成实现错误**，排查方向会被系统性带偏。

17. **调度收据的三处「读起来没问题」（迁移 8）** —— 三条同源表现，都是**新增了判决层/收据之后**才出现的形态：
    ① `candidateCount` 用 `Number(raw.candidateCount)` 归一化，而 `Number(null) === 0`：能力在「等上游 AI 结算」时明确回 `candidateCount: null`（候选数未知），收据里却变成「0 个候选」。与它相邻的语义是「`EMPTY` 也回 0」，于是**两种完全不同的实况在收据上长得一模一样**。这是项目内第 4 次同型缺陷（validator、ledger 两处 + 迁移 5 的 `rowCount`），修法是把 `null`/`undefined`/`''` 显式挑出来。**结论：「空值不是零」要当成跨模块的默认怀疑对象，每次新增一个会写数字的字段都要重新问一遍。**
    ② 归一化不幂等：`runScheduled` 会对「默认实现已经归一化过的收据」再归一化一次，于是 `detail` 从「能力给的原始事实」变成「上一次的归一化收据」，`pendingCount`/`sampleKeywords`/`recordCount` 被推深一层——真实 CLI 输出里肉眼可见 `detail.detail.*`。修法是加幂等分支（已归一化的信封原样返回，且**不放松**白名单判据）。
    ③ **测试用 `idFactory` 计数冒充「有没有建运行」**：我拿 `createController({ idFactory })` 的计数器来断言「空队列没建运行」，而 `idFactory` 造的是 **attempt id**——断言实际测的对象（跑没跑过 attempt）与它声称的结论（建没建过 run）不是一回事。**这是测试自己制造的假绿候选：断言的措辞比它实际测的东西更强。** 修法是包一层 store 的 `createRun` 直接数创建动作。
    另有一条同轮实现缺陷：`--probe-only` / `--force-run` 是**布尔**开关，而下游的 `parseCliArgs` 对任何 `--x` 都要求跟一个值，于是真实 CLI 一跑就报「`--probe-only` 缺值」。单测全绿、CLI 直接不可用——第 12/13/14 条讲的是「测试不产生失败信号」，这条讲的是「**测试不覆盖真实入口**」。写入档时先跑一次真实入口，成本几乎为零。

## 11. 交付物清单


架构文档：`agent-sop-runtime-spec.md`（不变量与契约）、`agent-sop-runtime-implementation-plan.md`（阶段与验收）、`README.md`、`handoff-to-teammate.md`、本文、`MIGRATION-2-SYCM-WEEKLY-REPORT.md`、`MIGRATION-3-FAQ-FANOUT-REPORT.md`、`MIGRATION-4-SYCM-SEARCH-RANK-REPORT.md`、`MIGRATION-5-XWS-SKU-REPORT.md`、`MIGRATION-6-HUITUN-WEEKLY-REPORT.md`、`MIGRATION-7-AGENT-PLANNER-REVIEWER-REPORT.md`、`MIGRATION-8-QUEUE-SCHEDULER-REPORT.md`。
迁移：`db/migrations/001-006`（各带 rollback），**001-005 已 apply** 到本项目库 `xws_automation`（容器 `xws-adaptive-postgres`，PG 17，127.0.0.1:5432）；`006-commit-record-status-vocabulary.sql` 已在隔离库验证 26/26，**尚未 apply**（关键 DDL 变更待授权，见 §13.5.4）。
运行时：`runtime/sop-runtime/` 共 **32 个模块**（不含 22 个 `.test.mjs`）。模块数在迁移 4/5/6 三轮**零增长**，迁移 7 +2（`agent-review.mjs`、`agent-planned-run.mjs`，都在 Agent 层），迁移 8 +3（`capability-scheduler.mjs`、`runtime-bootstrap.mjs` 两个新模块 + 1 个测试文件；`runtime-bootstrap.mjs` 是从 `two-stage-runner.mjs` 抽出的共用装配）。测试文件数 20 → 22。
**2026-09-14 对账更正（见 §12.4 第 4 条）**：上面这行里的「22 个 `.test.mjs`」与「测试文件数 →22」是**多写了一个**——实测该目录下 `.test.mjs` 为 **21 个**（`git log --diff-filter=D` 无删除记录）。模块数 32 是对的：该目录下 `.mjs` 共 33 个，其中 `recovery-fault-injection.mjs` 是故障注入脚本、不算运行时模块。
`two-stage-runner.mjs` 在迁移 8 首次改动（装配抽出 + `parseCliArgs` 新增 `profile` 选项，均为纯提取/向后兼容，`run` profile 行为不变）；**迁移 8 之前它自迁移 2 起一直未改**——这条记录要保留，因为「新能力不改核心」是这套底座的核心卖点，任何一次改动都该被记下来并解释。
能力：**10 个 manifest 已登记（能力 8 + 适配器 2）**，`registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48`（迁移 7 / 8 前后均未变）。已完成接入运行时的（6 个）：`xws.feishu.import`（两段式带发布）、`sycm.feishu.weekly`（两段式带发布）、`xws.faq.product-collect`（商品级 fan-out 执行单元，只读）、`sycm.search-rank.export@1.1.0`（只读采集，零发布义务）、`xws.sku.collection@1.0.0`（两段式带发布，对账式幂等写入 + 回读）、`huitun.keyword-heat.collect@1.1.0`（两段式带发布，能力级队列 + 对账式写入 + 含公式结算的回读）。
尚未登记（不伪造）：`xws-question-library-collection`（FAQ 采集兼容入口）、`xws-faq-operator` 的周期级发布段（目录内无 `.mjs`，实现在 `runtime/`）。`xws-sku-collection` 已在迁移 5 登记，但目录内仍只有适配器，采集 CLI 留在 `runtime/`（见第 9 节技术债）。`huitun-to-feishu-keyword-heat` 的浏览器采集 CLI 同理留在原处，`manifest.entry` 已指向适配器（D7.26）。
**Agent 层（迁移 7）**：`agent-proposal.mjs`（契约）、`agent-review.mjs`（复核）、`agent-planned-run.mjs`（边界与四步流水）。三者构成一个可整体移除的层：核心模块（`workflow-controller` / `two-stage-runner` / `task-queue` / `validator` / `side-effect-ledger` / `fanout` / `policy` / `context-schema` / `task-admission` / `publication` / `skill-*` / `stores/*`）**没有任何一个 import 它们**（已逐个核对），`assertAgentRemovable` 把这个方向当成静态检查（文本级，见第 9 节）。
唯一 re-export Agent 层的是 `index.mjs`——它是统一出口（barrel），不是核心模块，且删掉那三行 `export *` 不会影响任何核心模块的运行。这是刻意的：调用方需要一个统一入口，而「核心不依赖 Agent」这条不变量针对的是**逻辑依赖**而不是聚合导出。审查者若要更严的口径，可把 Agent 层从 `index.mjs` 挪到独立出口。
**调度层（迁移 8）**：`capability-scheduler.mjs`（探测契约 + 归一化 + 调度决策 + CLI）、`runtime-bootstrap.mjs`（运行器装配的唯一一处）。调度层与 Agent 层**互不知情**：调度器不 import 任何 `agent-*`，Agent 判决层也不 import 调度器。`index.mjs` 里这两个模块用**具名导出**（不是 `export *`）——两者的 CLI 都各自导出了 `main`，而 barrel 里出现一个 `main` 对任何 `import * as sop` 的调用方都是个意外入口。

## 12. 实施计划完成度对账（2026-09-14 晚，逐项实测后记）

对账对象：`agent-sop-runtime-implementation-plan.md` 第 4 节（阶段 0-6）、第 5 节（首批 7 条流程迁移）、第 7 节（交付检查表）。
本节的结论**不是复述报告**，而是逐项回到仓库里查了文件、manifest 入口与测试计数之后写的；
凡「未做」都指到第 9 节，或指到本节 12.4 新记的条目。

### 12.1 阶段 0-6

| 阶段 | 结论 | 证据（可复核） | 未做 / 打折的部分 |
| --- | --- | --- | --- |
| 0 架构基线与迁移落地 | **完成（006 待 apply）** | `db/migrations/001-006` 全带 rollback；001-005 已 apply 到 `xws_automation`；`architecture` schema 7 表回读计数（reviews 1 / capabilities 5 / modules 15 / gaps 9 / phases 7 / decisions 7 / evidence_refs 8）；004 幂等与 rollback 后重放在临时库 17/17；006 隔离库 26/26 通过、待授权 apply | — |
| 1 Context / Checkpoint / 恢复 | **完成** | `context-schema.mjs`（sop-context-v1 五条状态轴）+ pg-store CAS；`recovery-fault-injection.mjs` 跨进程故障注入 **15/15**（子进程被杀→另一进程收回过期 lease→从游标 10 续跑到 20；重复 commit_key 不产生第二行） | — |
| 2 Side Effect Ledger / 幂等 / 对账 | **完成（覆盖到已接线的能力）** | 复用 `supervisor_commit_records`（未新增同义表）；commit→verify→settle 全链；`reconcileUnknown` 只对账不重试 | 计划写「所有上传、写入、付费调用统一登记」——目前真实外部写只覆盖周更族；FAQ 周期级发布段仍走旧 CLI（§9） |
| 3 Manifest / Registry / Loader | **完成** | 10 manifest（能力 8 + 适配器 2）；`build-skill-registry.mjs --check` 退出码 0/1/2；坏 manifest 在执行前失败（6 类错误码）；entry 限目录内相对 `.mjs` | — |
| 4 Validator / Adapter 收敛 | **主体完成，一条优先级迁移未做** | 11 个验证器（采集期 9 + 发布期 2）；`adapter.*` 建立；迁移前后业务验收一致（`tally-weekly-classification` 双 profile 输出逐字节相同、viz dry-run `sourceHash` 相同） | 计划写「优先迁移**一条 SYCM 导出和一条 XWS 市场分析**流程」→ 只做了 SYCM 导出（迁移 4）；`xws.market-analysis.collect` 有 manifest 但 `entry` 仍是旧 CLI（§12.4 第 1 条）。另「统一错误分类」实际覆盖 4/6，见 §12.4 第 2 条 |
| 5 Memory / Context Compression | **完成** | `compression-service.mjs`（sop-summary-v1，缺关键字段 fail-closed，`assertSummaryMatchesRun` 防污染）+ `memory-store.mjs`（五层记忆、作用域/置信度/有效期/退役/冲突判定，当前证据恒优先） | — |
| 6 有限多 Agent 与高并发 | **部分完成** | Agent 侧：`agent-proposal` / `agent-review` / `agent-planned-run` + 四条降级出口 + 五条边界；并发侧：`task-queue.mjs`（限流/背压/熔断/退避/超时清扫/取消/结果合并）、lane 闸门、FAQ 商品级 fan-out 失败隔离；`assertAgentRemovable` 保证 Agent 可整体移除 | **「多 Agent 并发（高并发）」未开始**（§9）。「用故障注入决定是否保留 Temporal」——故障注入做了（走 PG 路径），但**没有把结论写下来**，POC 仍留在 `agent-runtime/temporal/`（§12.4 第 4 条） |

### 12.2 首批 7 条流程迁移（计划第 5 节）

7 项全部落地，逐项对应关系与状态：

| # | 计划项 | 落地位置 | 状态 |
| --- | --- | --- | --- |
| 1 | XWS 单分片：采集→验证→EvidenceManifest→幂等提交→恢复 | 迁移 1 / PHASE5 | 完成（发布段已对真实 base 跑通，2026-09-14） |
| 2 | FAQ 商品级 fan-out | 迁移 3 | 完成（商品级）；周期级发布段未迁移（§9） |
| 3 | XWS SKU：拓扑/关系/dry-run/授权提交/回读 | 迁移 5 | 完成；未被真实飞书驱动过（§9） |
| 4 | SYCM 搜索排行 | 迁移 4 | 完成；未被真实浏览器驱动过（§9） |
| 5 | SYCM → Feishu | 迁移 2 | 完成；发布段未真实跑过（§9） |
| 6 | 灰豚关键词热度与周报发布 | 迁移 6 | 完成；发布段未真实跑过（§9） |
| 7 | Agent Planner / Reviewer | 迁移 7 | **只有判决层**：四条出口与四条边界做完了，但没有一条真实 SOP 走进去，`planNextStep` 入参只由测试构造（§9） |

### 12.3 交付检查表（计划第 7 节）

阶段 0 六项：目标库确认（本项目库 `xws_automation`）、审阅 004/004-rollback、授权前先在隔离库预演、核对 architecture 表/约束/索引/种子与 Spec 一致、只提交本轮范围内的文件——**全部满足**。004 在预演时暴露并修掉了真实缺陷（`risks`/`exit_criteria` 被写成纯文本导致 `invalid input syntax for type json`）。

后续阶段五项：先更新 Spec/contract 再实现（D 系列决策均先落在报告里）、状态/证据/权限/幂等/外部写入的改动都补失败路径与验收、真实浏览器·Feishu·PG 调用单独记录环境与回执（见 MIGRATION-8 §8 与 TENANT-MIGRATION-MAP §5.3/§6.6）、未过故障注入前不宣称 durable/生产级/高并发、不新增第二套同义 Context/Memory/Commit/状态表（队列元数据落 `durable_runs.context.queue`，提交账本复用 `supervisor_commit_records`）——**全部满足**。

### 12.4 对账时新发现的五处记账问题（本轮补记；其中第 2 条是本轮自己先写错、又复核纠正的）

1. **阶段 4 的第二条优先级迁移（XWS 市场分析）没做，也没进 §9 缺口表。** 实测 manifest 入口：`xws.market-analysis.collect@1.0.0` 的 `entry` = `scripts/run-adaptive-export.mjs`（旧 CLI），不是 Worker 契约适配器；`xws.faq.raw-collect@1.0.0` 同样（`entry` = `scripts/append-faq-event.mjs`）。即 **10 个 manifest 里 6 个已接入运行时、2 个已登记但未接线**（另 2 个是适配器 manifest，本就不存在「接线」一说）。这 2 条应当补进 §9。
2. **「统一错误分类」（阶段 4）实际是 5/6，只有 `sycm.feishu.weekly` 还有裸 `throw`。**
   （本节初稿写「4/6」并把 `xws.faq.product-collect` 也算作不达标，**是错的，同日复核后更正**：
   它虽然没有码表常量，但所有 `throw` 都走 `ProductEvidenceError`，构造函数里固定写
   `this.failureClass = 'EVIDENCE_INVALID'` —— **确定性分类是有的**；只是分组口径与 xws 那边不一致，
   `PRODUCT_ID_REQUIRED` 与「缺 `evidenceDir`/`evidenceRoot`」这两类属「调用方没备好」，
   按 xws 的分组应是 `POLICY_DENIED` 而不是 `EVIDENCE_INVALID`。
   教训：用 `grep failureClass` 的**次数**判断达标与否会漏掉「error class 统一赋值」这种写法。）
   有确定性码表的：`xws.feishu.import`（`import-core.mjs` 17 码 + `fatalError`）、
   `xws.sku.collection`、`huitun.keyword-heat.collect`、`sycm.search-rank.export`；
   有确定性分类（error class 固定赋值）的：`xws.faq.product-collect`。
   **真正的缺口是 `sycm.feishu.weekly`：8 处裸 `throw new Error(...)`**
   （`parseBaseUrl` / `requirePositiveInteger` / `requireDate` / `parseTarget` / `prepare` /
   `observe` / `collectArtifact` / `createPublisher`）→ 一旦抛出就退回框架的关键词分类器，
   即 2026-09-14 修掉的那类误判（漏参数被说成疑似 bug 停线）在它身上仍然存在，只是尚未被真实触发。
   补法：词表放能力自己的模块、单点构造入口（可直接复用用户级 skill `capability-owned-failure-codes`）。
   本轮已按此修掉（见 §13）。
3. **`sycm.feishu.weekly` 的发布段在哪**要说明：它的 `entry` 已是 `scripts/adapter.feishu-weekly.mjs`（已接线），但与 `xws.feishu.import` 不同，它没有专用运行器，只能经通用 `two-stage-runner.mjs` 驱动；「发布段未真实跑过」这条缺口指的是「从未对真实可写目标表执行过 `--commit`」，不是「没有入口」。
4. **Temporal 去留仍无书面结论，且 §11 的计数与实际不符。** Temporal POC 仍在 `agent-runtime/temporal/`（`activities.mjs` / `workflows.mjs`，未改动），README §11 仍把它列在「待决策」；S1 故障注入已用 PG 路径完成（15/15），按 spec 本该据此给出保留/弃用结论，实际是「默认由 PostgreSQL 承担、POC 原样留着」——建议要么补一句结论，要么把 POC 标注为已废弃。另：实测 `runtime/sop-runtime/` 为 **33 个 `.mjs`（其中 `recovery-fault-injection.mjs` 是故障注入脚本、不属运行时模块 → 运行时模块 32，与 §11 一致）**，但**测试文件实际 21 个，§11 写 22**（`git log --diff-filter=D -- 'runtime/sop-runtime/*.test.mjs'` 无删除记录，可确认是计数写多了一个）。
5. **`sycm.feishu.weekly` 的发布段在通用运行器下无法完成「写入 + 验收」——这是接线缺陷，不是「还没跑」。**
   实测 `side-effect-ledger.mjs:76` 调 `readBack({ businessKey, commitKey, target })`，
   **不把 handler 的返回值交给它**；而该能力的 `readBack()` 第一件事就是
   `if (!publishInput.weeklyTableId) throw ...`，那个 id 恰恰是 **handler 里 `copy-weekly-table`
   克隆出来的新表 id**、运行前不可能知道。于是真实执行只会有两种结果：默认 `dryRun`（不写、
   什么也没验收），或 `publishInput.dryRun=false`（**真的写进去了，但 readBack 立刻抛错 → 只能落 UNKNOWN**）。
   前几轮把它记成「发布段未真实跑过」，掩盖了「按当前接线跑不通」这个更严重的事实。
   对照：`xws.sku.collection` 与 `huitun.keyword-heat.collect` 的 `readBack()` 全部从**工件**派生
   （`expectedTarget` 来自已审批工件 + `publishInput.target`），不依赖 handler 产物，因此没有这个问题。

### 12.5 一句话结论

**P0（阶段 0-3）与 P1（阶段 4-5）完成；P2（阶段 6）完成了一半**——Agent 分权与队列/并发骨架已就绪，
未开始的是「多 Agent 并发」。首批 7 条流程迁移全部落地，第 7 项只到判决层。
未完成项集中在两类：**真实环境验证**（另外 3 条能力的发布段、
`sycm.search-rank.export` 的真实浏览器、`xws.sku.collection` 的真实飞书）与**范围项**
（多 Agent 并发、FAQ 周期级发布段、XWS 市场分析接线）。
这些全部已在 §9 或本节 12.4 记账，没有「做了但没记」或「记了但说法过强」的项。
§12.4 的第 2 条（失败码表）与第 5 条（`readBack` 接线）已于同日收口，见 §13；
`sycm.feishu.weekly` 的发布段真实 `--commit` 仍缺外部前置（浏览器 + 可写目标），见 §13.4 与 §9。

## 13. 收口（2026-09-14 晚，用户授权「开始收口吧，然后去真实跑一遍」）

本轮把 §12.4 第 2 条（失败码表）与第 5 条（`readBack` 接线）这两笔欠账补掉，
并用**真实数据 + 真实入口 + 真实 PG** 跑了一遍采集段；发布段的真实 `--commit` 卡在一个外部前置上（见 13.4）。

### 13.1 给 `sycm.feishu.weekly` 补确定性失败码表（关闭 §12.4 第 2 条）

- 落点：`skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs`。
  这条能力的采集段与发布段**都在同一个文件里**（不像 `xws.feishu.import` 拆 `import-core.mjs` + 适配器），
  所以词表不需要第二个叶子模块；同族拒绝在 `prepare`/`start` 与 `createPublisher` 两处抛出，共用一份词表
  才保证「同一种拒绝得到同一个 code 与同一个分类」。
- 新增 `export const FAILURE_CLASS_BY_CODE`（12 个 code、四组）与唯一构造入口 `export function fatalError(code, message, details)`；
  **未登记的 code 立刻抛**（`unregistered failure code: ...`），不许悄悄退回框架分类器。

  | 分组 | code | 语义 |
  | --- | --- | --- |
  | `POLICY_DENIED` | `INPUT_REQUIRED` / `SOURCE_NOT_FOUND` / `PERIOD_INVALID` / `NUMBER_INVALID` / `BASE_URL_INVALID` / `TARGET_INCOMPLETE` / `PUBLISH_TARGET_UNKNOWN` | 调用方或目标没准备好；补参数即可重跑，**不是**代码缺陷 |
  | `EVIDENCE_INVALID` | `EXPORT_UNVERIFIED` / `SOURCE_PROOF_MISMATCH` | 证据不符合合同；重跑同一份输入没有意义，要换输入 |
  | `CAPABILITY_DEGRADED` | `STAGE_FAILED` / `COPY_NO_TABLE_ID` | 子进程阶段失败 / 克隆没返回新表 id |
  | `BUG` | `STAGE_ORDER` | 进程内调用顺序被破坏，真 bug |

- 替换掉全部裸 `throw`。**原记账写「8 处」，实测是 10 处**——源码守卫当场抓出 `defaultReadRecords` 里漏掉的两处
  （缺 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`、缺 base app token）。这正是 §12.4 第 2 条的教训复用：
  **靠人眼/grep 数个数会漏，所以判据必须是源码守卫，而不是「数出来的个数」**。
- `policy.mjs` 一行未改：框架只按 `failureClass` 决定下一步。

### 13.2 修 `readBack` 接线（关闭 §12.4 第 5 条）

`side-effect-ledger.mjs:76` 的调用形状是固定的 `readBack({ businessKey, commitKey, target })`，
而本能力的 `readBack` 需要「handler 运行期才产生的值」（`copy-weekly-table` 克隆出的新表 id）。
修法：**在能力内部把这份值从 handler 带到 readBack**——`createPublisher` 里建闭包共享状态
`created.tableId`（初值取 `publishInput.weeklyTableId`），handler 克隆成功后就地写入，`readBack()` 读它；
缺失时抛 `PUBLISH_TARGET_UNKNOWN`。两点必须写清，否则会被误读：

- 同一进程内 `write → readback` 是主路径，靠闭包成立；
- **跨进程对账（`reconcileUnknown`）没有这份内存**，必须由调用方用 `publishInput.weeklyTableId` 显式给出。
  这一点写在报错文本里，**不允许静默降级成「以调用方给的 id 为准」**——那会把「没验收」伪装成「验收了」。
- 账本侧一行未改：`readBack` 的入参形状是运行时契约，不是本能力的私有约定，不能为了迁就一条能力去改它。

### 13.3 三层测试（`skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs`，13 → 22 个用例）

| 层 | 断言什么 | 本轮新增 |
| --- | --- | --- |
| 单元层 | **同一句守卫消息**，裸 `Error` 经 `classifyExternalFailure` 归 `BUG`/`STOP_AND_ALERT`；挂上 `fatalError` → `POLICY_DENIED`/`FAIL`。这既是缺陷的复现，也是修复的证据 | 5 个 |
| 真入口层 | 逐个走 `adapter.prepare` / `adapter.start`，断言每类拒绝各自带 code（含 `defaultReadRecords` 的凭据缺失） | 1 个 |
| 收据层 | 真 registry（`buildRegistryFromDisk`）+ 真 Controller + 真账本 + 真 `createCapabilityPublisher`；断言 `verdict=REJECTED`、`blocker.class=POLICY_DENIED`（**不是** `BUG`）、发布轴停在 `READY` | 1 个 |
| 收据层（接线回归） | **刻意不传** `publishInput.weeklyTableId`，走「同进程 write → readback」主路径，断言发布轴走到 `VERIFIED` 且 `receipt.weeklyTableId` = handler 克隆出的那个 id。这条一红就说明接线又断了 | 1 个 |
| 源码守卫 | 非注释行里含 `\bthrow\b` 的每一行都必须走 `fatalError(`；唯一例外是 `fatalError` 自己那条「code 漏登记」 | 1 个 |

第三个「收据层」用例是**唯一能在 CI 里证明接线修复的观测面**：它跑的是真账本 + 真发布轴，只有 `readBack` 与
`handler` 来自能力本身。前两个收据层用例证明的是分类，第三个证明的是接线，缺一个好话就说不到点上。

本轮实测（改动后重跑，全绿）：

```
node scripts/run-test-suite.mjs skills    # ==> skills: 44 file(s)   # tests 531  pass 531  fail 0
node scripts/run-test-suite.mjs runtime   # ==> runtime: 61 file(s)  # tests 397  pass 397  fail 0
node --test skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs   # tests 22  pass 22  fail 0
```

注意口径：§8 里记的 `skills 43 file(s) / 511` 与 `runtime 59~60 file(s)` 是各自当时的快照，
本轮实测已是 44/531 与 61/397（差额来自同日早前新增的 `skills/xws-to-feishu-base/tests/import-failures.test.mjs`（+11）
与本轮新增的 9 个用例，以及 runtime 侧同日新增的测试文件）；**关键是 `fail 0`，不是绝对数**。

### 13.4 真实跑一遍：采集段跑通，发布段卡在外部前置上

**跑通的（真实数据、真实入口、真实 PG）**：`two-stage-runner.mjs` 驱动 `sycm.feishu.weekly@1.1.0`，
源数据用 2026-08-26 那次真实导出的 300 行（`ordinary-bathtub-week-20260826.csv/.xlsx`，
源文件对证明 `7天 / 2026-08-20 ~ 2026-08-26 / 1-300 / csvSha256=E7D2249D…` 与历史收据逐字一致），
store 走本项目库 `xws_automation` 的 PG `pg-store`。收据落在
`runtime/sop-runtime/weekly-rehearsal-20260914/two-stage-receipt.json`，命令与逐行结果见 §8。

- `ok=true`、`runId=5857b2e2-…`、退出码 0；
- 8 个采集期验证器全部 ok，工件 `sha256=501e4dd6…`、`rowCount=300`；
- `executionStatus=SUCCEEDED` / `nextAction=TERMINAL` / `cursorAdvanced=false`。

**没跑成的一步，以及为什么**：发布段（`--commit`）需要两个外部前置，本轮都不具备：

1. **克隆周表这一步是浏览器驱动的。** `copy-weekly-table.mjs` 不调飞书 OpenAPI，
   而是经共享 CDP Proxy（`http://127.0.0.1:3456`）在飞书前端的 `window.bitableStore` 上
   点「复制数据表」、填表名、勾「仅数据表结构」。当前该 Proxy 上挂着的是**卖家账号**的一批标签页
   （生意参谋 / 天猫卖家 / 本机 8080 控制台），没有飞书 base 标签；而这条能力要靠手动操作
   在用户正在使用的浏览器里开飞书标签，属于会打扰用户现场的操作，未获明确同意不做。
2. **写入目标是生产表。** 这条能力的发布段按设计会写三处：新周表（克隆产物）、
   `关键词历史总表 V1`（追加本批次）、`关键词编号库 V1`（补新词的编号）。
   新租户关键词 base 当前 `关键词历史总表 V1` = 2067 行 / 批次 1-7、
   `关键词编号库 V1` = 475 行。拿一次演练去写这三处，等于把**假批次 8**灌进真实历史表并污染编号库；
   而「用一次性演练表替代」这条路要求临时表**恰好叫** `关键词历史总表 V1` / `关键词编号库 V1`
   （`update-weekly-base.mjs` 按 id 取表但按名字断言），并且要有 ≥1 个批次才能过
   `expectedHistoryBefore ≥ 1`，构造这份「看起来合法」的夹具本身就是一件需要单独设计与授权的事。

因此本轮的真实运行**只到采集段为止**，并且收据里明确写着 `publish: NOT_ATTEMPTED` ——
这是刻意的：让「没发布」和「发布并验收了」在收据上长得不一样。
待用户决定发布段的跑法（真实生产写入 / 另备一次性演练表 / 先不跑）后再补这一步。

### 13.5 真实跑发布段（续）：先撞到一个「发布段根本写不出收据」的缺陷

用户随后授权「现在就跑一次性演练表」+「允许新开飞书标签」，于是把刻意留白的发布段补上。
结果是：**真实跑一次立刻抓到一条代码侧缺陷**，它和「浏览器没登录」是两个独立原因，
而且它在链路上更靠前——发布段压根没走到飞书那一步。

#### 13.5.1 场地：为什么必须在另一张 base 上跑

把「用一次性演练表替代生产表」这条路逐条试完，才知道它走不通，原因是三条硬约束叠在一起：

| 约束 | 实测 |
| --- | --- |
| `assertTable(tables, id, expectedName)` 按 id 取表、按**名字**断言，且 history / library 的名字在 `update-weekly-base.mjs` 里是**硬编码**的 `关键词历史总表 V1` / `关键词编号库 V1` | 演练表必须恰好叫这两个名字 |
| 飞书**不允许重名表** | 在旧词库 base 建重名表 → `1254013 TableNameDuplicated`；只在建表瞬间多出一张都不行 |
| 新应用在**新租户词库 base** 上没有建表权 | `POST /tables` → `91403 Forbidden`（应用在竞品 base 上有，在词库 base 上没有） |

于是「一次性演练表」只能落在**另一张 base** 上。可选的第三条路（新建 base + 只建需要的表）也不行：
周表的字段合同里含 8 个公式字段，`awaitFormulaFields` 要求它们全部结算出非 `#` 值，
而公式/引用字段无法靠 API 从零复刻（跨表引用要重写 tableId）。**必须是一张词库 base 的完整副本。**

最终做法：用 Drive 复制接口让**应用自己**复制新租户词库 base（`POST /drive/v1/files/<token>/copy?type=bitable`，
`folder_token` 取自应用云空间根目录），得到**应用自持**的沙盒 base
`G32Lb4s4lauMjnsWP3Oc6TBjneg`（8 张表、历史 2067 行、编号库 475 行，结构与源逐表相同）。
应用自持这一点是关键：跨租户不能把自建应用加为协作者（§9 已有记录），**应用自己复制的 base 不需要任何协作者授权**。

沙盒上的两处整备（全部只动沙盒，生产表零改动）：

1. `assertCollectionDateAvailable` 会按设计拦下「采集日期已被别的批次占用」——手上唯一合法的真实导出对
   endDate 是 2026-08-26，而它在历史表里属于批次 3（300 行）。处理办法是把**沙盒里**那 300 行的
   `采集日期` 清空（不动批次号、不动行数，历史仍是 2067 行），生产表一行未碰。
2. 链接分享对齐成 `tenant_editable`（与用户已有的竞品 base 同设置），让浏览器里的用户账号能驱动「复制数据表」。

**离线预演**（真实 CLI、真实导出对、不写任何外部）先过了才敢提交：

```
node skills/sycm-to-feishu-base/scripts/update-weekly-base.mjs --base-url https://kcne618basvj.feishu.cn/base/G32Lb4s4lauMjnsWP3Oc6TBjneg \
  --source-csv runtime/weekly-runs/2026-08-26/ordinary-bathtub-week-20260826.csv \
  --source-xlsx runtime/weekly-runs/2026-08-26/ordinary-bathtub-week-20260826.xlsx \
  --weekly-table-id tbllwOVjo0wH1lvY --weekly-table-name '关键词分析 V1（2026-09-12）' \
  --history-table-id tblCtygZpg3ixZ4X --library-table-id tblhk8iP2KbjuLKW \
  --protected-table-id tblg096m3inDQP98 --protected-table-name '关键词分析 V1（2026-08-29）' \
  --collection-date 2026-08-26 --batch-number 8 --expected-source-rows 300 --expected-history-before 2067 \
  --category 浴缸 --env-file E:/小红书/.env.feishu-kcne.local
# EXIT=0  mode=DRY_RUN_READY
# proof: 7天 / 2026-08-20 ~ 2026-08-26 / 1-300 / csvSha256=E7D2249D6765…
# history: priorRows=2067  currentBatchRows=0  expectedAfter=2367
# keywordLibrary: existingRows=475  missingRows=0   ← 本次不会新增任何编号
# plannedPreviousBatchUpdates=0  batchValidity.fieldsToCreate=0
```

#### 13.5.2 真实 `--commit` 撞到的缺陷：库约束不接受 `FAILED`，失败路径写不出收据

`two-stage-runner.mjs` 带上 `--commit --operator … --publish-input '{"dryRun":false,…}'` 一跑，
**没有走到飞书**，先炸在记账上：

```
error: new row for relation "supervisor_commit_records" violates check constraint
       "supervisor_commit_records_status_check"
    at stores/pg-store.mjs:275 (updateCommit)
    at side-effect-ledger.mjs:54  (commit 的 catch 分支)
    at publication.mjs:140        (ledger.commit)
    at two-stage-runner.mjs:215   (runTwoStage)
# exit=4，且 two-stage-receipt.json 根本没生成
```

根因是一处**词表漂移**：`001-supervisor-tables.sql` 给 status 的 CHECK 是 6 个值
（`NOT_REQUESTED/READY/COMMITTING/COMMITTED/VERIFIED/UNKNOWN`），
而运行时 `side-effect-ledger.mjs` 的 `COMMIT_STATUS` 也是 6 个值但**含 `FAILED`、不含 `NOT_REQUESTED`**。
handler 确定性失败时账本写 `status='FAILED'` → 库拒绝 → 异常穿出 `ledger.commit`。

后果比「少记一条日志」严重得多：**失败路径连收据都写不出来**（`two-stage-receipt.json` 未生成），
而 I11 / 收据全量原则要求的正是「失败也要给出可读的结算」。

为什么一直没被发现，三个原因缺一不可：

1. 所有离线测试都用**内存 store**，它的 `updateCommit` 是 `Object.assign(patch)`，对值域不做任何校验；
2. `COMMIT_STATUS` 这个导出**全仓库无人使用、无任何测试盯**（本次是第一次有测试读它）；
3. 已有的真实提交演练（`xws.feishu.import`）走的是**成功路径**（`COMMITTING → COMMITTED → VERIFIED` 都在词表内），
   失败路径从未在 PG 上被走过。

**这也是「发布段从未对真实 base 执行过 `--commit`」的代码侧原因**，与 §13.4 记的外部前置（浏览器无飞书登录态）
是两个彼此独立的原因——修好外部前置也不会有用，因为链路上更靠前的那一层先把异常抛了。

#### 13.5.3 修法与验证

| 动作 | 落点 | 证据 |
| --- | --- | --- |
| 补齐词表（唯一必要的 DDL 变更） | `db/migrations/006-commit-record-status-vocabulary.sql`（+ `006-rollback.sql`） | 只 DROP/ADD `supervisor_commit_records_status_check`，把 `FAILED` 加进词表；不触碰任何数据行 |
| 回滚**刻意 fail-closed** | `006-rollback.sql` | 表里还有 `FAILED` 行时回滚**整体失败**（多语句简单查询按隐式事务回滚，不会留下「已 DROP 未 ADD」的中间态）；该性质已被断言 |
| 仓库级守卫：运行时词表 ⊆ 库约束 | `runtime/sop-runtime/commit-status-vocabulary.test.mjs`（新增，4 用例） | 从 `db/migrations/*.sql` 推导「最终生效」的约束定义并与 `COMMIT_STATUS` 对账；另用内存 store 驱动 `ledger.commit` 断言失败态确实是库接受的那个 |
| 隔离预演 | `runtime/verify-migrations-isolated.mjs` 新增 `[5]` 段 | **26/26 通过**（临时库，角色 xws_runner）。含反例：006 之前 `insert status='FAILED'` 被拒；006 之后可写、非法值仍被拒、重复执行幂等、rollback fail-closed、rollback 后重放 |
| 真实 PG 上的失败路径用例 | `runtime/sop-runtime/recovery-fault-injection.mjs` 新增 `[5]` 段 + 迁移清单补 006 | **17/17 通过**。断言：确定性失败在真实 Postgres 上记为 `FAILED` 且 `failureClass=POLICY_DENIED`，库里 `FAILED` 与 `UNKNOWN` 是两个可区分状态 |

**守卫第一次运行就抓到一条自己的口径错误**，记在这里当教训：`006-commit-….sql` 与 `006-rollback.sql`
按**字典序**排是 rollback 在后，于是「取最后一个 ADD CONSTRAINT」把「回滚后的 6 值」误判成现状。
修法是显式排除 `*-rollback.sql`（回滚脚本是人工撤销入口，不在正向序列里）。
——「文件名顺序 ≠ 应用顺序」这条，之前在迁移 apply 流程里吃过一次，这次在**推导**里又吃了一次。

回归：`sop-runtime` **265/265**（261 + 4 新增，fail 0）；`runtime` **397/397**（fail 0）。
`skills` 本轮未改动，未重跑。

#### 13.5.4 两个仍未关闭的前置（彼此独立，都需要用户侧动作）

1. **006 尚未 apply 到业务库 `xws_automation`**。DDL 属关键变更，按项目约定需要明确授权后再走
   「只读核查 → 隔离预演（已做，26/26）→ pg_dump → 一文件一事务 → 回读核对」。
   在它 apply 之前，任何一次**失败的**发布仍会写不出收据（成功路径不受影响）。
2. **共享 CDP 浏览器没有飞书登录态**。`copy-weekly-table.mjs` 是浏览器驱动的（经飞书前端 `window.bitableStore`
   点「复制数据表」），而实测该浏览器打开 `kcne618basvj.feishu.cn` 直接跳到 `accounts.feishu.cn` 的**扫码登录页**。
   本机 6 个 CDP 端点全部查过（`netstat` 全量扫描 + 逐个探 `/targets`），其余 5 个是本机其他项目的爬虫浏览器，
   都没有飞书会话。扫码登录只能由人完成，脚本侧已按设计抛 `HUMAN_REQUIRED`（exit 2）。

### 13.6 发布段真实跑通：修掉「凭据接线」，并暴露一条更深的运行时缺口

#### 13.6.1 两个前置清零

| 前置 | 处理 | 证据 |
| --- | --- | --- |
| 006 未 apply | 用户授权后应用到业务库（`--single-transaction -v ON_ERROR_STOP=1`），应用前 `pg_dump` 全库备份 | `db/backups/pre-006-20260914-225707.sql`（325KB）。回读：约束 7 值含 `FAILED`；事务内 `update status='FAILED'` → `UPDATE 1`；`'BOGUS'` 仍被 CHECK 拒；复跑幂等；数据未被触碰（仍 1 行 `COMMITTING` = 上次演练遗留） |
| 共享浏览器无飞书登录态 | 用户在共享 CDP 浏览器（`127.0.0.1:3456`）完成扫码登录；先跑 `copy-weekly-table.mjs` 的 dry-run 探测 | dry-run 直接读出源表 `sourceRecordCount=300 / sourceFieldCount=29`、`existingCopyCount=0` —— 说明会话可用、新表名可用。另：全机扫一遍确认**没有**任何残留飞书标签（否则先清掉再开） |

#### 13.6.2 第一次真实 `--commit`：外部写入**成功**，自动回读**失败**

闸门 `APPROVED / ALLOW_WITH_APPROVAL / HIGH`，采集段 8 个验证器全 ok（`sha256=c22591eb…`），
`decisions` 依次记下 `PUBLICATION READY` → `PUBLICATION COMMITTED (commitKey=8507ec71f84e7711f9de92ae69f94a1c)`
→ `PUBLICATION UNKNOWN`，收据 `verdict=UNKNOWN / requiresReconcile=true / nextAction=RECONCILE_COMMIT`。

UNKNOWN 的唯一内容是这一句：

```
read-back not verified: readBack requires FEISHU_APP_ID and FEISHU_APP_SECRET
```

**独立回读沙盒证明写入本身是对的**（发布段真的生效了，只是没被自动验收）：

| 写入点 | 期望 | 实测 |
| --- | --- | --- |
| 新周表（克隆产物） | 300 行、字段结构随克隆保留 | `关键词分析 V1（2026-08-26）` = `tbluj7NGF0NfdN8r`，300 行，29 字段（含 `关键词编号`/`优先级`/`上一有效周*`）|
| `关键词历史总表 V1` | 2067 → 2367，新增批次 8 = 300 行、采集日期 2026-08-26 | 2367 行；批次分布 `1:300,2:267,3:300,4:300,5:300,6:300,7:300,8:300`；批次 8 首行采集日期 = `1787673600000`（= 2026-08-26 CST）|
| `关键词编号库 V1` | 不变（预演已算 `missingRows=0`） | 475 行 |

**根因：发布钩子的凭据接线断在框架与能力之间。**
`two-stage-runner.mjs` 的 `resolvePublishHooks` 调工厂时只传
`{ artifactBytes, evidence, period, target, collectInput, publishInput, manifest }` —— **没有 `env`**；
而本能力的 `readBack` 只认注入的 `env`（`defaultReadRecords(env)` 读 `env.FEISHU_APP_ID/SECRET`）。
同族两条能力（`xws.sku.collection`、`xws.feishu.import`）一直是读 `publishInput.envFile` 的，本能力没有对齐。

**为什么离线测试照不到**：唯一会走这条路径的是「真实网络客户端」。
其余回读用例统一注入 `deps.readRecords`，而 `readRecords` 是在**凭据解析之后**才被用上的那一环——
缝正好开在缺陷的后面。这与 §13.5 的 `FAILED` 词表漂移是同一类：**没有被真实入口走过的分支，等于没有测试。**

#### 13.6.3 修法（能力内，不碰框架）

| 动作 | 落点 |
| --- | --- |
| 凭据来源对齐：注入 `env` 优先，否则从 `publishInput.envFile` 读（文件不存在给 `INPUT_REQUIRED`）；**惰性求值**，工厂保持纯函数（不在装配期碰文件系统） | `skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs` 的 `createPublisher` 内 `resolveReadEnv()` + 本地 `readEnvValues()`（刻意不 import `runtime/` 下的 `parseEnvFile`：能力不得依赖运行时内部模块）|
| 补一道缝让这条路径可断言：`deps.createReadApi` | 同上（参考实现：一次构造客户端、复用给两次读，与生产路径同形）|
| 回归用例（22 → 23） | `tests/adapter-feishu-weekly.test.mjs`：刻意**不传 `env`**、只给 `publishInput.envFile`，断言凭据被读到并原样交给客户端；断 `envFile` 不存在时给确定性拒绝码而不是让 ENOENT 冒出去 |
| 真实数据上对账 | 用修好的 `readBack` 对 `commitKey=8507ec71…` 走 `ledger.verify` → **`VERIFIED`**（`rows=300 / historyRows=2367 / weeklyTableId=tbluj7NGF0NfdN8r / digest=d3d5e59a…`）。这一步刻意**不重跑**：批次 8 已进历史表，盲重试会被 `assertCollectionDateAvailable` 拒——这正是账本要求「UNKNOWN 只对账」的原因 |

顺带把「重新发起一次干净演练」的前置也补掉：新周表删除、批次 8 的 300 行 `batch_delete`，
历史表回 2067（分布与演练前逐字相同），沙盒表数回 7。

#### 13.6.4 修后正向重跑：`VERIFIED` + 游标推进

`run e21c96c9-8fe1-4aa6-bd11-4d3e17c4e2b6`（同一 business key、同一场地、修好的代码）：

```
ok=true  runId=e21c96c9-…  mode=commit  exit=0
gate: APPROVED / ALLOW_WITH_APPROVAL / HIGH
collect: 8 验证器 ok  sha256=c22591eb…  rowCount=300
publish: verdict=VERIFIED  commitKey=568f8fe8509212295dd8ccd7da936326
         receipt: rows=300  historyRows=2367  weeklyTableId=tbl2lZoEyTfxEfoB
                  digest=d3d5e59abfcc845f3a04d447cac8c0a18fc1221f7dcd02f91a28ffffc4aafaf6
         validation: readback ok / publication ok（0 失败码）
         decisions: READY → COMMITTED → VERIFIED
final: publicationStatus=VERIFIED  executionStatus=SUCCEEDED  nextAction=TERMINAL
       cursorAdvanced=true  verifiedCursor 1 → 300
```

**确定性交叉证据**：本次正向写入的 `digest`（`d3d5e59a…`）与 13.6.2 那次（另一张表 id、另一条 run）
**逐字相同**。两次独立运行、两张不同的新表，落到同一份内容摘要 —— 这是「同一源行对 → 同一写入内容」的直接证据，
不是靠单元测试声称的。

至此 `sycm.feishu.weekly` 的发布段**对真实 base 跑通并验收**（§9 那行可以关了）。

#### 13.6.5 顺带暴露的两条运行时缺口（**未修**，属设计决定）

**缺口 A：运行的发布轴没有 `UNKNOWN` 出口。**
`settlePublication(verdict='VERIFIED')` 要求 `current === 'COMMITTED'`；`markPublicationCommitted` 只收
`READY | COMMITTED`。于是 `UNKNOWN` 一旦落在**运行**上就再也到不了 `VERIFIED` —— 哪怕提交记录已经通过对账变成
`VERIFIED`（本次实测：`ledger.verify` 成功、`settlePublication(VERIFIED)` 抛
`PUBLICATION_STATE: publication must be COMMITTED before VERIFIED, got UNKNOWN`）。
结果是「**写入是真的、提交记录也被验收了，但运行永远停在 UNKNOWN / nextAction=RECONCILE_COMMIT**」。
这不是本次引入的：`reconcileUnknown` 只回写提交记录，从不回写运行，所以这条路径本来就缺半截。

**缺口 B：任何未终结的运行会永久占住它的幂等键。**
准入去重走 `store.listActiveRuns`，而 `LANE_ACTIVE_STATUSES` 含 `RUNNING`，且**没有任何 stale 回收**；
`duplicateOf` 这个字段全仓库**无人消费**（即没有 resume 通道）。本次在同一个幂等键上两度被挡：
①`b4e7e120`（§13.5 崩溃遗留）② `3dae7ad4`（本轮判 UNKNOWN 后留下）。
两次都只能用 `controller.cancel(runId)` 手动释放，而 `cancel` 写下的 blocker 是
`POLICY_DENIED / cancelled` —— 与「进程崩了」「结果未定」都不贴切：**缺一条正经的「放弃/终结」迁移与一个 reaper。**

两条都属于运行时语义变更，需要先定策略（UNKNOWN 是否允许在提交记录 VERIFIED 后把运行推成 VERIFIED）；
本轮只把事实、复现路径与证据记在这里，不动状态机。

**2026-09-14 深夜：用户答复「都修」，两条已修，见 §13.7。**

### 13.7 收口：两条运行时缺口已修（2026-09-14 深夜，用户「都修」）

修的边界先说清：**只补出口，不放宽任何准入**。两条缺口都是「状态机缺一条合法迁移」，
不是「判定太严」。所以这次改动里，凡是新加的分支都带**更强的**证据要求，
凡是原本会炸的地方都只是多了一个**必须拿出证据**的出口。

### 13.7.1 缺口 A 的出口：`controller.reconcilePublication`

前置状态是 `UNKNOWN` **与** `READY`（`publication.RECONCILABLE_PUBLICATION`）。

`READY` 这一格是**修的过程中在真实库上发现的第三格**：`b4e7e120`（§13.5 崩溃遗留）的
`publicationStatus=READY`、提交记录停在 `COMMITTING` —— 回收会（正确地）拒绝它，
`settlePublication` 也不收它，于是它和 `UNKNOWN` 一样没有任何出口。把它漏掉就等于只修了半截，
所以两个前置状态走同一个入口。

两个出口，**都必须由调用方拿出证据**，都在 `decisions` 里留 `via: 'RECONCILE'` 的痕迹：

- `verdict='VERIFIED'` —— 必须带真实回读收据（`receipt.verifiedAt`），**且**该运行的**所有**提交记录都已 `VERIFIED`。
  后半条是硬闸门：账本与运行是两个权威，顺序只能是「**先对账账本、再收敛运行**」；
  否则运行会声称 VERIFIED 而账本还停在 `COMMITTING/UNKNOWN`，那就是两处真相打架。
  缺收据同样拒绝 —— 否则 `UNKNOWN` 就成了「免回读」的后门，等于偷偷放宽 VERIFIED 的准入条件。
- `verdict='ABSENT'` —— 操作者**具名**确认「外部效果确实没发生」：发布轴回 `READY`（未提交即未发布），
  本次运行终结以释放幂等键，让重试能开一条新运行。闸门是「**没有任何**提交记录处于可能交付过的状态」
  （`COMMIT_HANDED_OFF`）——记录停在 `COMMITTING/COMMITTED` 时，人也不能声明它没发生。

错误码：`PUBLICATION_STATE` / `RECEIPT_REQUIRED` / `COMMIT_NOT_CONVERGED` / `OPERATOR_REQUIRED` /
`COMMIT_HANDED_OFF` / `COMMIT_RECORDS_UNAVAILABLE` / `PUBLICATION_VERDICT`。

### 13.7.2 缺口 B 的出口：存活判定 + stale 回收 + 准入自动释放

新模块 `runtime/sop-runtime/run-liveness.mjs`（纯函数、无 IO）：`assessRunLiveness` /
`assessReclaimSafety` / `reclaimGuidance`。**两个判据必须分开**，这是这条修复的核心：

- **死活看租约，不看运行状态。** 运行状态描述「它在等什么」（`RETRY_WAIT` 等退避、`PAUSED` 等人工），
  不描述「有没有人在跑它」。把 `PAUSED` 当死运行回收，等于把一条**正在等审批**的运行悄悄杀掉；
  而用「多久没动」判死活会把一次真实的长抓取误杀。判据只能是租约。
- **安全性看外部写入有没有在飞行中。** 回收会释放幂等键，让一个 `runId` 不同的新运行接手；
  而提交键是 `runId:target:businessKey`，新运行拿到的是**新的 commitKey** —— 也就是**再外部写一次**。
  所以「效果可能已经发生」的运行绝不能回收，只能对账。

配套：

- `controller.assessRun`（只读汇报）/ `reclaimStale`（终结并释放幂等键）/ `reclaimStaleRuns`（批量 reaper，
  单条被拒不中断扫描）。
- 新 store 端口 `listCommitsByRun`：**唯一**用途是把 `READY`（已登记意图、从未交付 handler）与
  `COMMITTING`（可能已经写进去了）分开。缺这个端口时 fail-closed（`READY` 判不安全）——
  猜错的代价是一次真实的重复写入，比多要一次人工对账贵得多。
- 准入：`admitTask({ reclaimStale, reclaim, abandonedAfterMs })`，**显式可选**——
  「悄悄终结一条运行」不该是准入的副作用。回收被拒**不是错误**，而是带回 code 的判定结果
  （`reclaimAttempt`），并且无论成败都一并返回 `duplicateOf / duplicateStatus / reclaimable /
  reclaimReason / hint`，让调用方不必靠猜运行状态。两段式运行器默认开启；
  `ADMISSION_STALE_AFTER_MS = 30min` 只用于**没有开放 attempt** 的 `QUEUED`。
- 唯一清单去重：`COMMIT_HANDED_OFF` 住在 `side-effect-ledger.mjs`（账本拥有提交状态词表），
  回收安全判定与 `ABSENT` 闸门**都从它推导**（`COMMIT_NOT_HANDED_OFF` 是它的补集），
  不再各抄一份 `['READY','FAILED']` —— 那正是这次修复要消灭的第二份真相。

### 13.7.3 验收

```
# 新增两组用例（真 Controller / Ledger / admission，只有 store 在内存）
node --test runtime/sop-runtime/run-liveness.test.mjs runtime/sop-runtime/recovery-unresolved.test.mjs
# tests 35  pass 35  fail 0        （run-liveness 16 + recovery-unresolved 19）

# sop-runtime 全量（24 个 .test.mjs；套件运行器不递归 runtime/sop-runtime，必须显式给文件列表）
# tests 300  pass 300  fail 0      （基线 265 + 35）

# runtime 套件（runtime/*.test.mjs，61 文件）
# tests 397  pass 397  fail 0

# 故障注入（本轮改了它加载的 pg-store.mjs，故复跑；隔离临时库，业务库零写入）
node runtime/sop-runtime/recovery-fault-injection.mjs
# === 结果：17/17 通过 ===
```

`sop-runtime` 全量是**显式 24 文件列表**跑的（`scripts/run-test-suite.mjs` 的发现器只扫
`runtime/*.test.mjs`，不递归 `runtime/sop-runtime/`；这也是为什么 34→35 个新用例
不会体现在 runtime 套件的 397 里）。

**真实库只读探针**（`.tmp-probe-listcommits.mjs`，只有 `select`，未写入业务库）：
`listCommitsByRun` 对未知 runId 返回 `[]`、对真实 run 返回字段映射正确的记录（`commitKey/runId/status/businessKey`）；
顺带读出全仓提交记录状态分布 `{COMMITTING: 1, VERIFIED: 2}` ——
那个 `COMMITTING` 就是 `b4e7e120`，正好是 §13.7.1 里 `READY` 那一格的**真实样本**：
说明这条修复不是为假想场景写的。

**修的过程中新增的第 4 条验收口径**（写给下一个改状态机的人）：
凡「只在真实入口才走到的分支」，都要有一条走真实入口的用例。本轮的对应物是
「先 `ledger.verify` 把提交记录推成 `VERIFIED`、再收敛运行」这条**顺序**——
它由 §13.7.1 的 `READY + COMMITTING` 用例端到端锁住，而不是靠单元层注入一个假账本。

**本轮复跑 skills 套件时观察到的一项既有失败**（与本轮改动无因果，记录在此以免下次误判为回归）：

```
node scripts/run-test-suite.mjs skills
# tests 532  pass 524  fail 8        （历史上同套件曾记 532/0）
```

8 条失败全部集中在 `skills/xws-export-market-analysis/tests/prepare-flow.test.mjs` 的浏览器流程用例
（`closes the automation home tab when login verification fails`、`rejects a non-Edge Proxy before target discovery or browser actions`、
`full flow ... XLSX menu ...` 等）。断言形态是**子进程退出码或 stderr 文案不符**
（`expected 2 actual 1` / `expected 0 actual 1` / stderr 未匹配 `/browser mismatch.*edge.*browser-service/iu`），
**不是**连接类错误（无 `ECONNREFUSED`）。

为什么可以判定与 §13.7 无关（依赖链，不是印象）：该测试只 `import ../scripts/export-market-analysis.mjs`，
递归展开其本地 import 闭包共 4 个模块，**没有一个触及 `runtime/sop-runtime/`**；而本轮改动 100% 落在后者。
另外这些用例用 `spawn(process.execPath, [...], { env: { ...process.env, XWS_RUNTIME_DIR } })`
**全量继承会话环境**，且单跑该文件耗时远超整套（整套 44 文件约 9.5 分钟，单跑此文件 12 分钟仍在跑），
指向「某些分支在等超时」——怀疑与本机是否存在可用 Edge / CDP Proxy 状态有关，属**待单独排查项**，
不影响本轮改动自身的验证结论。



