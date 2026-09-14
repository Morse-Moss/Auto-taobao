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

## 7. 阶段 6 续（A 层）：Agent 提案契约、商品级 fan-out、准入语义修正

本批新增，无独立深报告，记录如下。

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

## 8. 验证证据（可复现命令与结果）

```
node --test runtime/sop-runtime/*.test.mjs
# tests 215  pass 215  fail 0
#   其中：task-queue 23、two-stage-runner 15、agent-proposal 13、fanout 12、faq-fanout 12、
#        compression 12、memory 11、lane-concurrency 8，其余为既有模块

node --test skills/xws-to-feishu-base/tests/*.test.mjs \
           skills/sycm-to-feishu-base/tests/*.test.mjs \
           skills/xws-faq-operator/tests/*.test.mjs
# tests 171  pass 171  fail 0   （xws 84 + sycm 71 + faq-product 16）

node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 9 manifest 通过（能力 7 + 适配器 2）
# registryDigest=sha256:223ea5af1362506e9adad3826ab7d4c2d9fa6bac98044f99bbab7b8c67b2aa9c
# 告警 5 项，全部是 adapter.browser 显式外部依赖（共享 CDP 代理不在仓库内）

node runtime/sop-runtime/run-faq-fanout.mjs --period-start 2026-09-06 --period-end 2026-09-12 \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"xws","accountId":"operator","browserProfileId":"local","contractVersion":"xws-16f-v1"}' --no-write
# 真实证据实测：1 个商品（678598686014，已下架、0 行证据）
# → total 1 / dispatched 1 / collected 1 / complete true / publishable true / requiresHuman false
# → evidenceStatus=VALIDATED  executionStatus=SUCCEEDED（0 行证据被正确判定为合法）

node runtime/sop-runtime/recovery-fault-injection.mjs
# 15/15 通过（需 CREATEDB 身份；临时库 sop_fault_*，跑完即删）
```

注意：`node --test runtime/sop-runtime`（传目录）在 Node 22 会报 `MODULE_NOT_FOUND`，必须传通配展开后的文件列表。

## 9. 已知缺口（审查时请优先看这里）

| 缺口 | 性质 | 为什么还没做 |
| --- | --- | --- |
| 发布段从未对**真实 base** 执行过 `--commit` | 能力缺口 | `VERIFIED` + 游标推进这条链只有单测覆盖。需要单独授权 + 一个可写的目标表 + 可回滚的空表准备。**这是全项目唯一一个「代码已就绪但从未真实跑过」的关键路径。** |
| 迁移顺序第 3/4/6/7 项未开始（XWS SKU、SYCM 搜索排行、灰豚周度、Agent Planner/Reviewer） | 范围缺口 | 第 2 项（FAQ 商品级 fan-out）已完成，见 7.4 |
| FAQ 的**周期级发布段**未迁移 | 能力缺口 | 商品级采集与隔离已落地，但「问题主库/问题库替换」仍由 `publish-faq-detail-enrichment.mjs` 这条旧 CLI 承担；把它接入两段式需要真实可写目标表与单独授权 |
| FAQ 的周期级完成判定仍由 `run-faq-operator.mjs` 负责 | 有意保留 | fan-out 只回答「商品级是否全部结算」；周期级阶段机未改，避免一次改动同时动两套语义 |
| 限流/熔断不 durable | 刻意取舍 | 见 D6.3；跨进程一致的限流需要落库或外置，属独立设计 |
| `advanceCursor` 前置条件尚未收紧 | 有意延后 | 计划要求在第三个能力迁完后收紧（现在 2 个） |
| pg-store 的 `context.queue` 不能单独索引 | 刻意取舍 | 见 D6.2；按队列维度查询只能全表扫描，量级上去需另设计 |
| 迁移 1 的专用运行器未改用通用运行器 | 技术债 | 保留为人工入口；改用通用运行器属于低风险重构，未排入本轮 |

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

另有三处是**测试期望写错、实现未改**，一并列出以免被误认为实现缺陷：manifest 声明未实现验证器应归 `CAPABILITY_DEGRADED`（能力定义坏了）而非 `EVIDENCE_INVALID`（证据不合格）；队列单测把「已被取走的令牌」当成还有；用容量 1 的限流器测 refund 路径（走不到准入就已被限流挡住）。另外 `lane-concurrency` 里「等提交/等人工不占槽」的新回归测试最初把 `EVIDENCE_INVALID` 的落态写成 PAUSED（实际是 `evidenceStatus=REJECTED`、执行轴仍 RUNNING），也是测试期望写错。

## 11. 交付物清单

架构文档：`agent-sop-runtime-spec.md`（不变量与契约）、`agent-sop-runtime-implementation-plan.md`（阶段与验收）、`README.md`、`handoff-to-teammate.md`、本文、`MIGRATION-2-SYCM-WEEKLY-REPORT.md`。
迁移：`db/migrations/001-005`（各带 rollback），全量已 apply 到本项目库 `xws_automation`（容器 `xws-adaptive-postgres`，PG 17，127.0.0.1:5432）。
运行时：`runtime/sop-runtime/` 共 27 个模块（不含测试）。
能力：9 个 manifest 已登记（能力 7 + 适配器 2），其中 2 个（`xws.feishu.import`、`sycm.feishu.weekly`）完成两段式迁移，1 个（`xws.faq.product-collect`）为商品级 fan-out 的执行单元。
尚未登记（不伪造）：`xws-question-library-collection`（FAQ 采集兼容入口）、`xws-sku-collection`、`xws-faq-operator` 的周期级发布段（目录内无 `.mjs`，实现在 `runtime/`）。
