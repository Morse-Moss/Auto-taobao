# 迁移 3：FAQ 商品级 fan-out（单商品失败隔离 + 人工队列 + 独立证据）

日期：2026-09-14
对应实施计划：第 5 节「首批流程迁移顺序」第 2 项；阶段 6「FAQ 商品级 fan-out 先做失败隔离，再扩大并发」
本报告是深报告，摘要见 `docs/architecture/PHASE-ARCHIVE.md` 第 7.4 节。

## 1. 这一轮要解决的到底是什么

原实现把**整个周期**当成一个执行单元：

```
runtime/run-faq-operator.mjs
  inspectFaqOperatorStatus()  →  determineFaqOperatorState()  →  一个阶段
  inspectEvidence()           →  只保留第一个未解决的告警作为 blocker
```

`inspectEvidence` 里那行 `if (!productComplete && alert && !alertResolved && !blocker)` 是关键：
一个商品出问题，`blocker` 被填上，整批的 `evidenceComplete` 就是 false。
运营后果：**5 个竞品里 1 个采集失败，另外 4 个已完成的商品被一起卡住**，而且人工只能看到一个 blocker，看不到「另外 4 个其实已经好了」。

要改的就是这件事：让每个商品成为**可独立验证、可独立重试、可独立结算**的执行单元。

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| `skills/xws-faq-operator/scripts/adapter.faq-product.mjs` | 能力 `xws.faq.product-collect@1.0.0` 的实现：把一个商品的本地证据读成一份可独立复验的工件 |
| `skills/xws-faq-operator/manifest.json` | 上述能力的 manifest（只读：`permissions=[filesystem.read]`、`sideEffects=[]`、无外部写 ⇒ 无发布期义务） |
| `skills/xws-faq-operator/tests/adapter-faq-product.test.mjs` | 16 项：契约、8 类拒绝码、合法空证据、parseCsv 逐条对齐、**与 runtime 同义实现的交叉验证** |
| `runtime/sop-runtime/run-faq-fanout.mjs` | 驱动器：读锁定清单 → 构造子项 → 逐个准入 → 逐个执行 → 合并 → 人工队列 → 批次回执 |
| `runtime/sop-runtime/faq-fanout.test.mjs` | 12 项：隔离、空批次、未锁定清单、定向重试、businessKey、重复子项、人类队列构建、回执落盘 |

## 3. 关键决策

### D1 每个商品一条 run，businessKey 带父批次

`businessKey = faq-fanout-<period>:xws.faq.product-collect:<productId>`（复用 `fanout.buildItemBusinessKey`）。
父批次参与拼接，使「本周的这件商品」与「上周的这件商品」在提交账本上是两条记录——否则跨周重跑会被当成已提交而**静默跳过**。

### D2 驱动器只准入、不再次准入（重要约束）

`runTwoStage` 内部会自己 `admitTask`。若 fan-out 先准入子项、再调 `runTwoStage` 跑它，同一商品会产生**两条 run**：两者的 `taskId` 不同（`faq-batch-<period>::cap::<id>` vs `<capabilityId>-<version>`），因此 `idempotencyKey` 也不同，**两条都会被准入** —— 直接违反「重复消费无重复副作用」。

因此：驱动器只做准入（`queue.enqueue`），执行直接走 Worker（`createCapabilityWorker` + `runOnce`）。这与 `runTwoStage` 的采集段是同一段代码路径，能力实现只需要一份。代码里有注释锁住这条约束。

### D3 执行槽占用判据：从「run 状态」改为「attempt 在飞行中」

见 `PHASE-ARCHIVE.md` 的 D7.4。简述：原 `LANE_EXECUTING_STATUSES = [RUNNING, RETRY_WAIT, PAUSED]` 必然把 fan-out 锁死。

- `completeAttempt` 后 `executionStatus` 仍是 RUNNING（等 COMMIT）→ 永久占 lane；
- 失败等人工的 run 是 PAUSED → 一个商品失败会把其余商品全挡在 lane 外。

改为 `policy.occupiesLane(context)` = `executionStatus === 'RUNNING' && leaseStatus === 'HELD'`。
这一条**不是为了让测试变绿**：`beginAttempt` 取 HELD、`completeAttempt`/`failAttempt` 释放 RELEASED，所以 lease 是唯一能表达「正在飞行中」的字段；等待态本来就不该占执行槽。同时新增了一条测试，证明「有一次 attempt 正在飞行中时 lane 依然互斥」，确保安全属性没有放宽。

### D4 一次调用结束必须结算 run（否则永远不终态）

`controller.succeed()` 早就存在，但两条已迁移路径**都没调用过**。于是 run 永远停在 RUNNING，永远算「活跃」。
本驱动器在 `markEvidenceValidated` 之后调用 `succeed()`；`two-stage-runner` 也一并修正（未发布时结算、发布 VERIFIED 后结算、**发布未 VERIFIED 时不结算**）。详见 D7.5。

### D5 商品级能力刻意不声明 completeness / row_count / artifact_integrity

下架商品的证据是 **0 行**，且这是**合法**状态（qa/reviews 均 `EMPTY_SOURCE_ROWS` 且 `unavailableReason` 非空）。
而这三个通用验证器都会拒绝 0 行：

- `validateCompleteness`：`Number(rows) <= 0 → INCOMPLETE_RANGE`
- `validateArtifactIntegrity`：`rowCount <= 0 → ARTIFACT_INCOMPLETE`

若声明它们，真实存在的下架商品会被判成 `EVIDENCE_INVALID`，反而阻塞整批——正好与「失败隔离」的目标相反。
0 行的合法性只能由**能力自检按收据语义**判定：`EMPTY_SOURCE_ROWS` 且原因非空。通用行数验证器无法区分「空且已声明」与「空且漏采」——这是它不该管的事。

该取舍以 `collectContract().omittedValidators` 的形式写在代码里，随 manifest 一起被审查，不是隐式遗漏。

### D6 `complete` 与 `publishable` 分开

| 字段 | 含义 | 回答的问题 |
| --- | --- | --- |
| `complete` | 每个子项都拿到了自己的结论（成功或失败都算） | 这批跑完了没有 |
| `publishable` | 全部成功且无冲突 | 能不能进入周期级汇总 |

合成一个布尔值会同时产生两种误读：「4 成功 1 失败」被读成整批失败（原实现的毛病），或整批成功（更危险）。

### D7 空批次既不是失败，也不等于采集完成

清单锁定且 `outcome=NO_QUALIFIED_CANDIDATES` 时 0 个商品是合法的运营状态。
返回 `empty:true` 且 **`complete:false`**，附 note 指明周期级完成判定归 xws-faq-operator 的空周期旁路。
用 `complete:true` 会让人误以为「本周已采集完毕」。

### D8 人工队列的拒因必须可执行

`DISPATCH_REJECTED` / `EVIDENCE_INVALID` / `COLLECT_FAILED` / `UNSETTLED` / `CONFLICT` 五种，且每条带 `retryable`：

- `BACKPRESSURE`/`RATE_LIMITED`/`CIRCUIT_OPEN`/`UNSETTLED` → `retryable=true`（稍后再试）
- 其余 → `retryable=false`（子项本身有问题，重试无用）

**区分它们是防止调用方把容量问题误判成数据问题去改数据。**

### D9 指定子项必须是清单里真实存在的商品

`--products` 只做过滤，不允许凭空造子项（那等于伪造范围），未知 id → `PRODUCT_NOT_IN_BATCH`。
另外回执里 `manifestSummary` 同时报告 `products`（清单总数）与 `selected`（本次选中数），避免「只重跑了一个」被读成「清单里只有这一个」。

### D10 同义实现 + 交叉验证（刻意的取舍）

适配器**不 import** `runtime/`（实施计划风险表：「Skill 导入 runtime 新模块」= 反向依赖扩大）。
代价：收据契约判定在 `runtime/run-question-library-collection.mjs` 的 `readEvidence` 里有一份同义实现。
防漂移：`adapter-faq-product.test.mjs` 有 11 组夹具同时喂给两份实现，断言**接受/拒绝结论完全一致**；`parseCsv` 另有逐条对齐测试。

被拒绝的替代方案：让适配器 import runtime 的 `readEvidence`。那会把「Skill → runtime」这条反向依赖固化下来，正是计划里点名要冻结的方向。

## 4. 实测收据（真实证据，不是合成夹具）

```
node runtime/sop-runtime/run-faq-fanout.mjs \
  --period-start 2026-09-06 --period-end 2026-09-12 \
  --identity '{"tenantId":"sycm","storeId":"bathtub-flagship","platform":"xws","accountId":"operator","browserProfileId":"local","contractVersion":"xws-16f-v1"}' \
  --no-write
```

结果：

```
total 1  dispatched 1  collected 1  complete true  publishable true  requiresHuman false
outcome: key=678598686014  sha256=d1b3dcaf…  rowCount=0
         evidenceStatus=VALIDATED  executionStatus=SUCCEEDED
businessKey=faq-fanout-2026-09-06_2026-09-12:xws.faq.product-collect:678598686014
```

这个真实商品 `678598686014` 是**已下架**商品：

```
qa.status      = EMPTY_SOURCE_ROWS
reviews.status = EMPTY_SOURCE_ROWS
unavailableReason = 商品已下架：详情页 678598686014 返回 error.item.taobao.com/error/noitem（宝贝不存在，
                    可能已下架或被转移），买家账号 tb452480 登录下验证；淘宝搜索 … 前 25 个在售结果中无此链接。
                    证据截图 unavailable-evidence.png（2026-09-13）。
```

即 D5 那条取舍**不是预防性设计，而是真实数据必需**：如果声明了 `completeness`/`row_count`/`artifact_integrity`，本周期唯一的候选商品会被判成证据无效。

## 5. 验证

```
node --test runtime/sop-runtime/*.test.mjs              → 215 pass / 0 fail（含 faq-fanout 12）
node --test skills/xws-to-feishu-base/tests/*.test.mjs \
           skills/sycm-to-feishu-base/tests/*.test.mjs \
           skills/xws-faq-operator/tests/*.test.mjs      → 171 pass / 0 fail（含 faq-product 16）
node runtime/sop-runtime/build-skill-registry.mjs --check --write
  → 9 manifest 通过；registryDigest=sha256:223ea5af1362506e9adad3826ab7d4c2d9fa6bac98044f99bbab7b8c67b2aa9c
```

registryDigest 由 `18bc50e9…` 变为 `223ea5af…`，属**预期漂移**（新增了一个 manifest）。

## 6. 本轮抓到的真实缺陷（不是测试问题）

1. **执行槽占用按 run 状态判定 → 整批死锁**（D7.4）。测试当场暴露：3 个子项只跑完第 1 个。
2. **run 从不终态**（D7.5）。两条已迁移路径都没调 `succeed()`。
3. **fan-out 与两段式运行器双重准入**会在设计上产生重复消费 → 由 D2 的结构约束避免（这是设计阶段拦下的，不是运行后发现的）。
4. **`skills/xws-export-market-analysis/tests/prepare-flow.test.mjs` 的「bounded settlement deadline」断言自 `4fd523b` 起从未通过**。它用测试自身时钟作基线，而 `deadlineAt = requestedAt + 5min` 且 `requestedAt >= startedAt`，差值恒 > 5 分钟。已改为用意图自身持久化的 `requestedAt` 计算，并保留两条安全断言。
   **比这个 bug 本身更值得注意的是它存活了多久**：该 skill 的长测单文件上千行、上百用例，容易被漏跑。建议后续把长测拆文件或加分层门禁。

## 7. 未做（如实标注，不冒充完成）

- **周期级发布段未迁移**：`问题主库`/`问题库_<period>` 的替换写入仍由 `runtime/publish-faq-detail-enrichment.mjs`（旧 CLI）承担。把它接进两段式需要真实可写目标表 + 单独授权。
- **周期级阶段机未动**：`run-faq-operator.mjs` 仍是周期级编排入口。本轮只新增商品级执行与隔离，不改它的语义——避免一次改动同时动两套语义。
- **并发放大未启用**：`laneLimits` 需要显式容量证据才放宽，本轮没有提供任何证据，因此默认串行（这符合阶段 6 的「先做失败隔离，再扩大并发」）。
- **父批次未落库为 run**：批次父级目前只是确定性标识 `faq-fanout-<period>`（子项各自落库为 run）。要让它成为一条真 run，需要一条「批次」能力或显式 batch 表，属后续工作。
