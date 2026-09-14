# 迁移 5：XWS SKU（复验 + 授权写入 + 回读，首个带外部写副作用的迁移）

日期：2026-09-14
对应实施计划：第 5 节「首批流程迁移顺序」第 3 项（XWS SKU：拓扑、关系、dry-run、授权提交和回读）
本报告是深报告，摘要见 `docs/architecture/PHASE-ARCHIVE.md` 第 7.6 节。

## 1. 这一轮要解决的到底是什么

SKU 入库原本是一条**人工值守的 CLI 链**：

```
xws-sku-auth-preflight → capture-xws-sku-payload → collect-live-xws-sku-topology
  → run-xws-sku-dry-run → apply-xws-sku-manifest
```

每一步都是独立进程，唯一的状态载体是 `batch-index.json` 和操作者的进度记忆。这条链的成熟度不低（预检、剪贴板原子读、拓扑契约、A/B 资格、逐字段 dry-run、`batch_create` + 回读收敛、可恢复写错误分类，全都有测试）。它缺的是三件事：

1. **授权是一个命令行开关，不是一个可审计的状态。** `--apply --confirm-record-count N` 同时扮演「人工审批」和「调用参数」。审批记录不在任何权威库里，事后无法回答「这 36 行是谁在什么时候批准的」；重跑也不会撞上「已审批」这道闸门，因为它不存在。
2. **写入有一个结构性的重复窗口。** 写入是 `batch_create`，本地只在成功返回后才写回执。进程在「飞书已创建、本地未记账」之间崩溃时，重跑的 `commitKey`（`runId:target:businessKey`）是**新的**——因为 `runId` 是新的——因此单靠幂等键拦不住重复行。
3. **没有可自证、可独立复验的工件。** dry-run 产出的是 manifest + 回执两个 JSON，但它们没有共同的哈希绑定（payload / 拓扑 / parser 三方摘要），第三方拿到其中一份无法判断它是否属于这批证据。

要改的就是这三件事：把「复验 + 写入 + 回读」变成一条**能被确定性运行时驱动**的能力，并且**不虚构也不缩小**任何一道闸门。

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| `skills/xws-sku-collection/manifest.json` | 新：能力 `xws.sku.collection@1.0.0`（`sideEffects = [local_parse, feishu_write]`，声明 `publication` + `readback`，`recovery.resumeFrom = idempotent_commit`，依赖 `adapter.feishu@^1.0.0`） |
| `skills/xws-sku-collection/scripts/adapter.sku-collection.mjs` | 新：7 方法 Worker 契约（采集段独立复验本地证据 + 已审批计划）+ `createPublisher`（对账式幂等写入 + 外部回读）。**不 import runtime/ 下任何模块** |
| `skills/xws-sku-collection/tests/adapter-sku-collection.test.mjs` | 新：26 项：manifest 对齐、真 registry 驱动的端到端采集与端到端**提交**、13 条确定性拒绝码、工件篡改自检、目标不一致、幂等写入、UNKNOWN/REJECTED 分流、人工闸门、回读归一化、跨 Skill 依赖漂移守卫 |
| `skills/xws-sku-collection/SKILL.md` | 改：新增「运行时入口」一节（第 6 节），说明能力边界与两条写入路径的分工 |

`runtime/sop-runtime/` **仍然没有新增任何模块**，`two-stage-runner.mjs` 也**没有改一行**。这是本轮最重要的一条结构性结论：迁移 2 引入的通用两段式运行器第一次承载了**带外部写副作用**的能力，而它不需要为这条能力做任何特化——它此前只在迁移 1 的专用运行器（`run-feishu-import-two-stage.mjs`）里被验证过。

## 3. 关键决策

### D1 能力切在「已审批计划 → 工件」与「工件 → 写入 → 回读」之间；浏览器采集留在 Skill 的既有 CLI

浏览器点击、剪贴板读取、页面拓扑抓取需要 Edge 会话与真人节奏，把它们塞进 Worker 的 `start/observe` 只会让「可恢复的确定性步骤」重新变成「不可恢复的长事务」。因此能力的边界是：

- **COLLECT（无外部写）**：读六份本地输入（payload / 采集收据 / 拓扑 / 拓扑收据 / 已审批 manifest / parser 字节），独立复验三方哈希与逐行契约，产出可自证工件；
- **PUBLISH（外部写）**：只读**工件字节**（不读进程内状态）完成对账式写入与回读验收；
- 采集段由 Skill 的既有 CLI 完成，本能力不发起任何浏览器动作。

这条边界与迁移 3（FAQ）完全同构，这正是它能零改动复用通用运行器的原因。

### D2 不复跑解析，改为**用摘要绑定解析器版本**

FAQ 适配器选择在技能目录内复刻一份同语义解析（CSV 解析很短），再用交叉验证测试对住。SKU 不能照抄这个结论：它的解析链要跨 `competitor-v2-core` 的尺寸候选/空间判定（约 100 行，含 0.8–1.2m→小户型、1.3–1.8m→常规卫生间、非线性外形与范围值一律转人工核验等规则）。复刻它等于制造第二份真相，而两份真相的漂移只会在真实写入时才暴露。

因此改为**哈希绑定**：调用方必须显式给出 `parserFile`（解析器模块本身），适配器要求 `sha256(parserFile) === manifest.parser.sha256`（dry-run 在写 manifest 时就记录了 parser 摘要）。任何解析逻辑改动都会让哈希不一致，从而在一个**可审计的点**上失败（`RECEIPT_HASH_MISMATCH` + `side: 'parser'`），而不是悄悄换一套语义。

代价与边界必须写清楚：本能力**不复算** `SKU名称/规格/尺寸/适用空间` 的解释结果，它复算的是「这批证据 ↔ 这份计划」的一致性。把这一条记进 PHASE-ARCHIVE 第 9 节。

### D3 目标来自**已审批工件**，不由调用方决定

`appToken` / `skuTableId` 由工件的 `target` 携带（而工件本身经 `manifestSha256` 绑定到已审批的 dry-run manifest）。调用方仍必须在 `publishInput.target` 里显式写出目标，二者**必须完全一致**。

两种不一致的处理刻意不同：

| 情形 | 处理 | 理由 |
| --- | --- | --- |
| 调用方**没给**目标 | 工厂期直接抛 `TARGET_REQUIRED` | 调用方缺陷，连凭据都不该去读 |
| 调用方给的**与工件不符** | `handler` 抛 `TARGET_MISMATCH`（`POLICY_DENIED`） | 策略拒绝，必须留下可审计的 `REJECTED` 收据；若在工厂期抛出，异常会穿透运行器，把这条 run 留在 `RUNNING` 且毫无结算记录 |

「换一个 base 写」因此在结构上需要一次新审批，而不是改一个常量。

### D4 写入自身必须幂等：**先对账，再创建**

`handler` 不是无条件 `batch_create`，而是先按 `SKU唯一键` 回读目标表、只创建缺失的行。这是对 D-第 1 节第 2 条的直接修复：

- 崩溃后重跑（新 `runId` → 新 `commitKey`）不会产生重复行；
- 同一批次在不同周重复提交时，`toCreate` 自然收敛为 0；
- `UNKNOWN` 对账路径也只需要一次回读，不需要「猜它到底写没写」。

### D5 写入失败必须区分「确定性拒绝」与「结果未知」

只有**可能已经落库**的失败才进 `UNKNOWN`：HTTP 5xx、408、429、`ECONNRESET/ETIMEDOUT` 等连接类错误、`AbortError`、以及 `fetch failed / socket hang up / timeout` 这类文本。4xx（参数、权限、字段错误）是确定性拒绝，直接 `REJECTED`，不允许靠重试蒙过去。

`isUnknownWriteFailure()` 是纯函数并有逐条断言：`500 → true`、`400 → false`、`403 → false`、`ETIMEDOUT → true`、`invalid field name → false`。这条判定直接决定「这条 run 是等对账还是可以重试」，猜错的代价是重复写入或永久卡死。

### D6 行数语义：工件带**全部**已解析行，而不只是 `toCreate`

`rowCount` = 本批次已解析的 SKU 行数（`toCreate + alreadyPresent`），回读收据的 `rows` 必须等于它。这样有三个好处：

- `row_count` 验证器仍然有意义，且**永远不为 0**（解析器不会产出 0 行组合，计划里 0 行也会在采集段被拒），不会像迁移 3 那样需要为「合法的空证据」放弃行数验证；
- 幂等重跑（`toCreate = 0`）不会退化成「空工件 → `INCOMPLETE_RANGE` 假失败」；
- 回读要证明的是「这批行的目标状态已经成立」，这比「本次新创建了几行」更接近验收的定义。

### D7 刻意**不**声明的验证器（写进 `collectContract().omittedValidators`，并有测试锁住）

| 验证器 | 为什么不声明 |
| --- | --- |
| `digest` | 它比较的是 evidenceStore 自己从同一份字节算出的摘要，恒等，属于空转 |
| `artifact_integrity` | 它的 `rowCount > 0` 判定与 `row_count` 完全重叠，而能力已经用「逐行唯一键 + 拓扑组合数一致」做了更强的自检 |

声明了做不到的验证器只会制造假失败，漏声明会制造假通过。两者都必须显式写清楚——这是迁移 3/4 反复确认过的教训。

### D8 跨 Skill 依赖写进 manifest，并用漂移测试锁住

Feishu 客户端来自**已登记**的 `adapter.feishu@1.0.0`（`skills/xws-to-feishu-base/scripts/feishu-client.mjs`）。做法与同仓库 `adapter.feishu-weekly` 一致：**可注入的懒加载**（`deps.createClient` / `deps.readEnvFile`），默认实现用相对路径 import。

因此多了一条守卫测试：把注册表里 `adapter.feishu` 的 `entry` 解析路径、适配器里那条相对导入的解析路径、以及 manifest 里声明的依赖三者对齐断言。这条测试的存在使「偷偷 import 一个没有登记的模块」在结构上暴露。

### D9 `recovery.resumeFrom` 用 `idempotent_commit`，而不是 `verified_cursor`

只读能力（迁移 4）用 `verified_cursor`：恢复点是「已验收的证据范围」。本能力有外部写副作用，恢复点必须是**提交记录**：`UNKNOWN` 只能对账（`reconcileUnknown`），重试必须落在同一个 `commitKey` 上，而游标只在 `VALIDATED` 证据 + `VERIFIED` 发布之后才可能推进。

### D10 与既有运维 CLI 的关系（**明确记下两条写入路径**）

`runtime/apply-xws-sku-manifest.mjs` 仍然存在，并且不回退、不改写：

| | 运维 CLI | 运行时能力 |
| --- | --- | --- |
| 触发 | 操作者手打 `--apply --confirm-record-count N` | 人工闸门 `humanGateStatus=APPROVED`（`--operator` 记录审批人） |
| 写前 | 立刻重跑一次 dry-run，并 `assertFreshPlanMatchesManifest` | 不重跑（离线不可用）；靠工件哈希绑定 + 对账式写入 + 回读收敛 |
| 写后 | 循环重跑 dry-run 直到 `toCreate=0 && alreadyPresent=N` | 一次外部回读，逐行核对唯一键/关联/空间 |
| 审批痕迹 | 命令行参数 | `supervisor_commit_records` + Controller 上下文 |

**两者不是同一份实现**，因此「写前新鲜度」这件事在两条路径上的强度**不同**：CLI 有「写前重算」，运行时路径只有「写前绑定 + 写后收敛」。这是本能力当前最强的已知缺口，已记入 PHASE-ARCHIVE 第 9 节；补法是在 COLLECT 里加一次需要 Feishu 只读凭据的「新鲜度重算」，或把 CLI 的 fresh-dry-run 提升为可复用的只读能力。本轮不做，因为它会引入第二种 Feishu 读路径，而收益（拦截「工件已过期但表状态未变」的窗口）需要在真实写入中先被观测到。

## 4. 验证

```
node --test skills/xws-sku-collection/tests/adapter-sku-collection.test.mjs
  # tests 26 / pass 26 / fail 0

node runtime/sop-runtime/build-skill-registry.mjs --check --write
  # 发现 manifest 10 个，注册条目 10 个（能力 8，适配器 2）
  #   xws.sku.collection@1.0.0
  # Registry 校验通过，registryDigest=sha256:4fd5f0a17b7b00563519b294fa5e62c856137953028601335661de0a7689ea49

node --test runtime/sop-runtime/*.test.mjs              # 215 / pass 215（通用运行器未被本轮改动）
node scripts/run-test-suite.mjs skills                  # 见 PHASE-ARCHIVE 第 8 节
```

端到端那两条测试用的是**真 registry + 真 loader + 真 adapter + 真证据库 + 真 Controller + 真 Ledger**，只有 store 在内存里、Feishu 客户端是注入的假实现（并记录调用次数，让「幂等写入」被断言而不是被相信）。断言里包含：

- 采集段：`publicationStatus=NOT_REQUESTED`、`cursorAdvanced=false`、`executionStatus=SUCCEEDED`、工件表面带齐 `collectContract().requiredFields`；
- 提交段：`gate.status=APPROVED`、`publish.verdict=VERIFIED`、`publicationStatus=VERIFIED`、`verifiedCursor={start:1,end:2,version:1}`、`batch_create` 恰好一次且只含缺失行；
- 回读不收敛 → `UNKNOWN` + `requiresReconcile=true` + `executionStatus=null`（**未结算的运行不许自称成功**）；
- 未登记 `--operator` → 停在 `HUMAN_REQUIRED`，且 `listRecords/batch_create` 调用次数均为 0（一次外部调用都没发生）。

## 5. 本轮抓到的真实缺陷（3 条，均已修并各有测试）

1. **`TARGET_MISMATCH` 原本在工厂期抛出，会把运行留在 `RUNNING`。** 首版把「请求目标与工件不符」当作工厂期错误抛出，异常穿透 `runTwoStage`，结果是：一条已准入、已采集、已过人工闸门的 run 永远停在 `RUNNING`（`publicationStatus` 停在 `READY`），既没有 `REJECTED` 收据也没有对账入口。改为在 `handler` 内抛出（`POLICY_DENIED` → `REJECTED`），两种不一致的语义分离见 D3。
2. **工件缺 `rowCount` 时自检误判。** `validate()` 原先把 `artifact.rowCount` 当作必然存在，而 `rowCount` 是框架侧从 `skuRowCount` 派生的表面字段、并不在工件的字节里。任何「从字节单独重建工件」的复验路径（正是第三方复核要做的事）都会被判 `STRUCTURE_INVALID`。改为「字节里的 `skuRowCount` 必查；调用方给了 `rowCount` 才比较」。
3. **拓扑收据的计数没有被复验。** 首版只比较了 `topologyReceipt.topologySha256`，而 `propertyCount` / `validCombinationCount` 两个计数（runtime 侧 `buildSkuEvidence` 是会校验的）没有对住。补齐后，「拓扑文件被替换成结构相同但组合数不同的另一份」这类改动会在采集段被拒，而不是等到写入行数不符才暴露。

## 6. 未做项（刻意不做，避免范围膨胀）

| 未做项 | 原因 |
| --- | --- |
| 真实执行一次 `--commit` 写入飞书 `SKU明细` | 需要人工授权（`--operator`）与真实目标表；**本能力从未对真实 base 执行过发布段**，只被注入式假客户端端到端驱动过。必须如实记录 |
| 把浏览器采集 CLI（`capture-xws-sku-payload` / `collect-live-xws-sku-topology` / `run-xws-sku-dry-run` / `apply-xws-sku-manifest`）搬进技能目录 | 它们是运维入口，本轮不动；能力只吃它们产出的本地证据。搬迁是纯重构，收益是「Skill 目录内自洽」，风险是改动一条已验证的采集链，留给后续独立一轮 |
| 写前新鲜度重算（D10） | 见 D10：需要引入第二条 Feishu 读路径，收益需先在真实写入中观测到 |
| `xws-question-library-collection`（FAQ 兼容入口）、`xws-faq-operator`、`xws-sku-collection` 之外的未登记技能 | 按迁移顺序推进，逐个登记 |
| 收紧 `advanceCursor` 前置条件 | 计划要求第三个能力迁完后收紧。本能力是第一个**带外部写**的迁移，`publicationStatus` 前置已由 `createCapabilityPublisher` + `settlePublication` 保证；收紧动作仍留给下一轮（迁移 7 Planner/Reviewer 前后） |
