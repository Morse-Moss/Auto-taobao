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

## 8. 验证证据（可复现命令与结果）

```
node --test "runtime/sop-runtime/*.test.mjs"
# tests 244  pass 244  fail 0  cancelled 0  skipped 0   EXIT=0
#   其中：task-queue 23、two-stage-runner 15、agent-planned-run 14、agent-review 13、
#        agent-proposal 13、workflow-controller 13、fanout 12、faq-fanout 12、
#        compression 12、memory 11、lane-concurrency 8，其余为既有模块
#   迁移 7 之前基线 215 → 之后 244（+29：agent-review 13 + agent-planned-run 14 +
#   workflow-controller 11→13）

node scripts/run-test-suite.mjs skills --concurrency=1
# ==> skills: 42 file(s)
# tests 500  pass 500  fail 0  cancelled 0  skipped 0   EXIT=0
#   迁移 6 基线同为 500/42 —— 迁移 7 未改动 skills/ 下任何文件，这是「没有回归」的证据

node scripts/run-test-suite.mjs runtime --concurrency=1
# ==> runtime: 59 file(s)
# tests 361  pass 361  fail 0  cancelled 0  skipped 0   EXIT=0
#   覆盖整个 runtime/（含 sop-runtime 的 244），新测试由目录发现自动纳入，不需要改文件列表

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
# ↑ 迁移 7 前后此摘要完全相同：本轮没有新增/修改任何 skill manifest（只加判决层）

node runtime/sop-runtime/run-faq-fanout.mjs --period-start 2026-09-06 --period-end 2026-09-12 \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"xws","accountId":"operator","browserProfileId":"local","contractVersion":"xws-16f-v1"}' --no-write
# 真实证据实测：1 个商品（678598686014，已下架、0 行证据）
# → total 1 / dispatched 1 / collected 1 / complete true / publishable true / requiresHuman false
# → evidenceStatus=VALIDATED  executionStatus=SUCCEEDED（0 行证据被正确判定为合法）

node runtime/sop-runtime/recovery-fault-injection.mjs
# 15/15 通过（需 CREATEDB 身份；临时库 sop_fault_*，跑完即删）
```

注意：`node --test runtime/sop-runtime`（传目录）在 Node 22 会报 `MODULE_NOT_FOUND`，必须传通配展开后的文件列表。
注意：`--test-timeout=<ms>` 对**整个测试文件**同样生效（文件本身也是一个测试）。给慢套件设 4 分钟会在第 22 个用例处把文件级用例超时取消，表现为「`# pass 22 / # fail 0 / # cancelled 1`」而不是失败——排查时不要把它当成用例失败。

## 9. 已知缺口（审查时请优先看这里）

| 缺口 | 性质 | 为什么还没做 |
| --- | --- | --- |
| 发布段从未对**真实 base** 执行过 `--commit` | 能力缺口 | `VERIFIED` + 游标推进这条链只有单测覆盖。涉及三条能力：迁移 1 的 `xws.feishu.import`、迁移 5 的 `xws.sku.collection`、迁移 6 的 `huitun.keyword-heat.collect`。需要单独授权 + 一个可写的目标表 + 可回滚的空表准备。**这是全项目唯一一个「代码已就绪但从未真实跑过」的关键路径。** |
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
| `huitun.keyword-heat.collect` 的**空队列调度**没有驱动器 | 能力缺口 | 采集段对 0 候选确定性拒绝 `NO_CANDIDATES`（D7.31），但运行时侧**还没有**一个「先读队列、空则不发起本能力」的驱动器：目前只能由操作者看 `POLICY_DENIED` 收据后决定。补法是在周更驱动器里加一次「队列预读」，或把 `NO_CANDIDATES` 显式登记为「能力未被调度」而非「能力拒绝」。本轮不做：会引入第二条飞书读路径 + 一个跨能力的调度语义，收益要先在真实周更里被观测到 |
| `huitun.keyword-heat.collect` 的浏览器采集段不在运行时路径上 | 有意保留 | 采集仍由 `run-huitun-topic-heat.mjs`（CLI）承担，运行时入口不发起任何浏览器动作（D7.26）。代价是「采集」与「回填审批」之间的断点仍靠操作者对 `results.json` 的处置，而不是靠运行时状态 |
| FAQ 的**周期级发布段**未迁移 | 能力缺口 | 商品级采集与隔离已落地，但「问题主库/问题库替换」仍由 `publish-faq-detail-enrichment.mjs` 这条旧 CLI 承担；把它接入两段式需要真实可写目标表与单独授权 |
| FAQ 的周期级完成判定仍由 `run-faq-operator.mjs` 负责 | 有意保留 | fan-out 只回答「商品级是否全部结算」；周期级阶段机未改，避免一次改动同时动两套语义 |
| `xws-sku-collection` 目录内仍只有适配器，**采集 CLI 未搬入** | 技术债 | `capture-xws-sku-payload` / `collect-live-xws-sku-topology` / `run-xws-sku-dry-run` / `apply-xws-sku-manifest` 留在 `runtime/`，能力只吃它们产出的本地证据。搬迁是纯重构（收益是「Skill 目录内自洽」），风险是改动一条已验证的采集链，留给后续独立一轮 |
| 限流/熔断不 durable | 刻意取舍 | 见 D6.3；跨进程一致的限流需要落库或外置，属独立设计 |
| pg-store 的 `context.queue` 不能单独索引 | 刻意取舍 | 见 D6.2；按队列维度查询只能全表扫描，量级上去需另设计 |
| 迁移 1 的专用运行器未改用通用运行器 | 技术债 | 保留为人工入口（`run-feishu-import-two-stage.mjs`）；迁移 5 已实证通用运行器能承载外部写能力，改用属低风险重构，未排入本轮 |

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

## 11. 交付物清单

架构文档：`agent-sop-runtime-spec.md`（不变量与契约）、`agent-sop-runtime-implementation-plan.md`（阶段与验收）、`README.md`、`handoff-to-teammate.md`、本文、`MIGRATION-2-SYCM-WEEKLY-REPORT.md`、`MIGRATION-3-FAQ-FANOUT-REPORT.md`、`MIGRATION-4-SYCM-SEARCH-RANK-REPORT.md`、`MIGRATION-5-XWS-SKU-REPORT.md`、`MIGRATION-6-HUITUN-WEEKLY-REPORT.md`、`MIGRATION-7-AGENT-PLANNER-REVIEWER-REPORT.md`。
迁移：`db/migrations/001-005`（各带 rollback），全量已 apply 到本项目库 `xws_automation`（容器 `xws-adaptive-postgres`，PG 17，127.0.0.1:5432）。
运行时：`runtime/sop-runtime/` 共 **29 个模块**（不含 20 个 `.test.mjs`）。模块数在迁移 4/5/6 三轮**零增长**，到迁移 7 才 +2（`agent-review.mjs`、`agent-planned-run.mjs`）——而且这 2 个都住在**Agent 层**，核心模块一个没动：迁移 7 加的是判决层，不是新特化。`two-stage-runner.mjs` 自迁移 2 起至今未改。测试文件数 18 → 20。
能力：**10 个 manifest 已登记（能力 8 + 适配器 2）**，`registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48`（迁移 7 前后未变）。已完成接入运行时的（6 个）：`xws.feishu.import`（两段式带发布）、`sycm.feishu.weekly`（两段式带发布）、`xws.faq.product-collect`（商品级 fan-out 执行单元，只读）、`sycm.search-rank.export@1.1.0`（只读采集，零发布义务）、`xws.sku.collection@1.0.0`（两段式带发布，对账式幂等写入 + 回读）、`huitun.keyword-heat.collect@1.1.0`（两段式带发布，能力级队列 + 对账式写入 + 含公式结算的回读）。
尚未登记（不伪造）：`xws-question-library-collection`（FAQ 采集兼容入口）、`xws-faq-operator` 的周期级发布段（目录内无 `.mjs`，实现在 `runtime/`）。`xws-sku-collection` 已在迁移 5 登记，但目录内仍只有适配器，采集 CLI 留在 `runtime/`（见第 9 节技术债）。`huitun-to-feishu-keyword-heat` 的浏览器采集 CLI 同理留在原处，`manifest.entry` 已指向适配器（D7.26）。
**Agent 层（迁移 7）**：`agent-proposal.mjs`（契约）、`agent-review.mjs`（复核）、`agent-planned-run.mjs`（边界与四步流水）。三者构成一个可整体移除的层：核心模块（`workflow-controller` / `two-stage-runner` / `task-queue` / `validator` / `side-effect-ledger` / `fanout` / `policy` / `context-schema` / `task-admission` / `publication` / `skill-*` / `stores/*`）**没有任何一个 import 它们**（已逐个核对），`assertAgentRemovable` 把这个方向当成静态检查（文本级，见第 9 节）。
唯一 re-export Agent 层的是 `index.mjs`——它是统一出口（barrel），不是核心模块，且删掉那三行 `export *` 不会影响任何核心模块的运行。这是刻意的：调用方需要一个统一入口，而「核心不依赖 Agent」这条不变量针对的是**逻辑依赖**而不是聚合导出。审查者若要更严的口径，可把 Agent 层从 `index.mjs` 挪到独立出口。
能力：**10 个 manifest 已登记（能力 8 + 适配器 2）**，`registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48`。已完成接入运行时的（6 个）：`xws.feishu.import`（两段式带发布）、`sycm.feishu.weekly`（两段式带发布）、`xws.faq.product-collect`（商品级 fan-out 执行单元，只读）、`sycm.search-rank.export@1.1.0`（只读采集，零发布义务）、`xws.sku.collection@1.0.0`（两段式带发布，对账式幂等写入 + 回读）、`huitun.keyword-heat.collect@1.1.0`（两段式带发布，能力级队列 + 对账式写入 + 含公式结算的回读）。
尚未登记（不伪造）：`xws-question-library-collection`（FAQ 采集兼容入口）、`xws-faq-operator` 的周期级发布段（目录内无 `.mjs`，实现在 `runtime/`）。`xws-sku-collection` 已在迁移 5 登记，但目录内仍只有适配器，采集 CLI 留在 `runtime/`（见第 9 节技术债）。`huitun-to-feishu-keyword-heat` 的浏览器采集 CLI 同理留在原处，`manifest.entry` 已指向适配器（D7.26）。
