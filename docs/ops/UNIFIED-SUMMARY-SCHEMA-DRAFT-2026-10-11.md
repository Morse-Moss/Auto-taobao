# 统一 summary schema 草案（三链对齐 P1 蓝图）

日期：2026-10-11
作者：schema-drafter（按《三链对齐与系统重构方案》P1-5 起草）
状态：**已拍板，进入施工**（2026-10-11 用户确认七项全按推荐）。本轮只出文档，不改任何代码。
配套文档：`docs/ops/THREE-CHAIN-ALIGNMENT-AND-REFACTOR-PLAN-2026-10-11.md`（口径以它为准，本文不发明新口径，只把「统一 summary schema」这一条展开成可施工的字段表与迁移步骤）。

---

## 一、目标与动机

### 1.1 2026-10-11 07:00 推广轮事故的机理链条

那一轮 8 家店全败，而系统给出的表现是「没有失败、照常释放」：

1. **无告警**：推广链当时零飞书出口（P0-2 之前的现状，`run-promotion-sales1.mjs` 那时没有 `--notify`）。失败只往 stdout 打逐店 JSON，除了日志没有任何东西知道这一轮失败了。
2. **无托住**：`scripts/run-batches.mjs` 的释放判定链是——`stop` 步先算判决（run-batches.mjs:527-536）→ `batchUnfixableShops`（run-batches.mjs:228-236）→ 读本批 `--logs 根/summary.json` → 交给 `unfixableShopsOf`（runtime/hold-and-resume-plan.mjs:204-225）。而**推广链当时根本不落 summary.json** ⇒ `readBatchSummary` 返回 `null` ⇒ `unfixableShops` 恒为空数组 ⇒ `releaseAfterBatch`（runtime/batch-plan.mjs:336）落在「这一批没跑成，但**没有需要人看现场的失败** ⇒ 照旧释放」那一档 ⇒ 两批窗口全放，现场被清。
3. **判定失明的根因不是 bug，是契约缺位**：`unfixableShopsOf` 读的是 `summary.shops[].autoRepair.gaveUp` / `repairRequest.candidates` / `repairRequest.noActionRequired`——这些是**日报链私有字段路径**，却事实上成了跨链接口。任何不产这些字段的链接进来，释放判定就恒判「无失败」。方案文档冲突点 7（P1｜释放/托住信号契约不存在）说的就是这件事。

P0-3 已止血：`run-promotion-sales1.mjs` 的 `buildPromotionSummary`（run-promotion-sales1.mjs:131-140）现在落 `--logs 根/summary.json`，失败店带 `repairRequest: { candidates: [] }`（空菜单＝「脚本修不动 ⇒ 需要人看现场」的判据语义）。但那是**仿日报链的形状**，不是三链共享的契约。

### 1.2 为什么必须三链共用一个 schema

方案文档 P1-5 的原话：**统一 summary schema 是所有下游能力的前提**。三链产出同一 schema 之后：

- `unfixableShopsOf`（驻留判据第二路 + 释放判定 + 统一回执的 unfixable 名单）只认 schema，不认链私有路径；
- 托住（hold）、告警（notify）、回执（run-receipt-v1）从「按链各写一套读取逻辑」变成「读同一份契约」；
- 「失败出口四问」验收门（方案文档第四节）里那一问「summary 里有没有 unfixable 信号」才有统一的检验对象；
- 新链接入＝写判据＋写步骤＋按 schema 落 summary，不写机制（方案文档的核心不变量）。

本文的交付：统一 schema 的**字段表**（第三节）、把它落到三条链的**迁移步骤**（第四节）、钉住它的**守卫**（第五节）、以及需要用户拍板的开放问题（第六节）。

---

## 二、现状矩阵

以下字段全部来自实际读到的代码，逐一标注出处。商品链现状已按 `scripts/run-product-data-job.mjs` 核实，无猜测项。

### 2.1 日报链（daily-report）

**写入方**：`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`（summary 对象构建于 :1985，整轮被挡时落盘于 :2027，正常收尾落盘于 :2413）。
**落盘路径**：`--logs 根/summary.json`。直跑＝`evidence/multi-shop-<日>/summary.json`；分批＝`evidence/batches-<日>/b<N>/summary.json`（`run-batches.mjs` 传 `--logs`，见 runtime/batch-plan.mjs:283-285 的注释：一批一个子目录，防互相覆盖）。

**顶层字段**（现状基线）：

| 字段 | 类型 | 现状语义 |
|---|---|---|
| `date` | string | 业务日 |
| `mode` | string | commit / rehearse / verify |
| `startedAt` | string | ISO 时间戳 |
| `round` | object | 整轮级体检结论，见下 |
| `shops` | object | 店名 → 逐店记录的 map |
| `finishedAt` | string | 收尾时间戳 |

`round.healthCheckDaily`（:2000-2022）的字段：`status` / `logPath` / `ok` / `blocking`（code 数组）/ `blockingDetails` / `normalize` / `normalizeChanged` / `roundCause`（`ROUND_LOGIN_WALL`｜`ROUND_BLOCKED`｜null）/ `missingPages`。

**shops 逐店记录**（键＝店名，记录里**没有** `shop` 字段）：

| 字段 | 类型 | 出现条件 | 语义 |
|---|---|---|---|
| `status` | string | 恒有 | `ok` / `failed` / `pending`（初值，:2047）/ `waiting`（运营账号暂缓，runtime/daily-report-shop-gates.mjs:33-47） |
| `stages` | array\<object\> | 恒有 | 逐阶段收据：`{stage, status, skipped, logPath, argv, blockingDetails, blockingCodes, pageNormalize}`（:2190-2200） |
| `source` | object | 恒有 | 采集段产物路径（`shopXlsx` / `shopReportManifest` / `promotionZip` / `promotionManifest`） |
| `failedStage` | string | 失败时 | 停在哪一步（:2143） |
| `error` | string | 失败时 | 驱动包的那句错误（:2271） |
| `failureOutput` | string | 失败时 | 子进程 stdout+stderr 尾部 4000 字符（:2148）——分类器靠它看 `[BLOCKED_BY_OVERLAY …]` 这类标记 |
| `blockingDetails` | array | 体检拦下时 | 人话明细 |
| `perception` | object | 失败时 | 感知层结论（98-failure-state.json 的摘要与 `files` 路径） |
| `repairRequest` | object | 失败时 | 修复请求单（:434-494）：`at` / `shopKey` / `stage` / `cause` / `error` / `statePath` / `stateTextPath` / `screenshotPath` / `stateSummary` / **`candidates`** / `planNote` / `stageHint` / **`noActionRequired`** / `retryStage` / `execHint` / `instancePrecondition` / `path` / `writeError` |
| `autoRepair` | object | 开了 `--auto-repair` 且失败时 | 回环记录（:1741-1742）：`enabled` / `cause` / `stage` / `maxRounds` / `rounds[]` / `rescued` / **`gaveUp`**（string） / `error` |
| `relogin` | object | 撞登录墙且开了 `--relogin-on-wall` 时 | 补登一次的结论（:1859-1860） |
| `evidenceIncomplete` | array | 回读 exit 4 时 | 「数据已核对、仅截图缺失」，不判失败（:2088-2092） |
| `recovery` | object | 回位发生时 | 页面回位记录 |

**waiting 记录**（runtime/daily-report-shop-gates.mjs:33-47）：`{ status:'waiting', state:'WAITING_OPERATOR_ACCOUNT', resumable:true, failedStage:'shop-report', reason, owner, resumeWhen, stages:[], source:{}, shop }`。注意它**带** `shop` 字段。

### 2.2 推广链（promotion-daily）

**写入方**：`skills/sycm-alimama-daily-report/scripts/run-promotion-sales1.mjs` 的 `buildPromotionSummary`（:131-140，P0-3 当天加的）。
**落盘路径**：`--evidence`（别名 `--logs`）根下的 `summary.json`（:179-182）；分批形态即 `evidence/batches-<日>/b<N>/summary.json`——与 run-batches 释放判定读的路径对齐。

**顶层字段**：`version`（`'promotion-sales1-summary-v1'`）/ `date` / `shops`。**没有** `mode` / `startedAt` / `round` / `finishedAt`。

**shops 逐店记录**（:155-174，记录里**有** `shop` 字段）：

| 字段 | 类型 | 出现条件 | 语义 |
|---|---|---|---|
| `batch` | number | 恒有 | 第几批 |
| `shop` | string | 恒有 | 店名 |
| `status` | string | 恒有 | **初值即 `'failed'`**（fail-closed 默认，:155），全走通才翻 `'ok'`（:171） |
| `stages` | array\<string\> | 恒有 | 已完成的阶段名序列：`keyword-submit` / `audience-submit` / `keyword-fetch` / `audience-fetch` / `import` |
| `error` | string | 失败时 | catch 到的 message（:172） |
| `recovery` | object | 台账有待补任务时 | `{keywordPending, audiencePending}`（:161） |
| `repairRequest` | object | **仅失败店** | P0-3 起为 `{ candidates: [] }`——推广链没有脚本自修能力，任何失败按「空菜单」语义走 |

### 2.3 商品链（product-daily）

**写入方**：`scripts/run-product-data-job.mjs`。**核实结论：商品链不落 summary.json，没有任何 `shops[].{status, autoRepair, repairRequest}` 形状的逐店结论文件。** 它的「收据」是另外三样：

| 产物 | 路径 | 形状 | 出处 |
|---|---|---|---|
| `run-receipt.json` | `evidence/product-data-job-<日>/<runId>/` | **workflow-receipt schema**（另一套契约，方案文档 P1-4 点名的分裂项）：`{version:1, workflow:'product-data', runId, date, status(RUNNING/COMPLETED/FAILED), startedAt, stages:[{name, status(PENDING/COMPLETED/FAILED/SKIPPED)}], shops, failure:{class,reason,message}, failedStage, finishedAt}` | runtime/workflow-receipt.mjs:16-18 + run-product-data-job.mjs:392/473-475 |
| `collection.json`（分批时另有 `collection-b<N>.json` 与全轮聚合版） | 同上目录 | 原始结果数组：`[{shop, product, productFile, inquiry, inquiryFile, promotion, promotionFile, stoppedAt, error}]`。`stoppedAt` 是粗档（`login` / `product-collect` / `inquiry-collect` / `promotion-collect`，run-product-data-job.mjs:279-302） | run-product-data-job.mjs:237/306/441 |
| `release-*.json` / `environment-preflight.json` / `job.log` / `alert.json` | 同上目录 | 释放收据 / 预检 / 日志 / 告警载荷 | run-product-data-job.mjs:410/430-431/87-103 |

**关键差异**：商品链**自管释放**——分批时每一批跑完**无条件** release（run-product-data-job.mjs:421-436），不经过 `releaseAfterBatch`，也没有任何 unfixable 判定；告警只带整轮级 `failure.class/failedStage`（`classifyWorkflowError` 的四分类：`TRANSIENT_EXTERNAL` / `HUMAN_REQUIRED` / `POLICY_DENIED` / `UNKNOWN_WRITE` / `FAILED`，runtime/workflow-receipt.mjs:5-14），不带逐店失败清单。

### 2.4 消费方清单（谁读哪个字段、读了干什么）

| 消费方 | 位置 | 读的字段 | 干什么 |
|---|---|---|---|
| `unfixableShopsOf` | runtime/hold-and-resume-plan.mjs:204-225 | `shops` 全体、`status`、`repairRequest.noActionRequired`、`autoRepair.gaveUp`、`repairRequest.candidates` | 驻留判据第二路（「脚本自修没救回来、且需要人看现场」的店）。`noActionRequired===true` 先剔除；`gaveUp` 非空字符串 **或** `repairRequest.candidates` 为空数组 ⇒ 入列 |
| `failedShopsOf` | scripts/hold-and-resume.mjs:209-213 | `shops` 全体、`status!=='ok'`、`shopFailureCause(record)`（它再读 `failedStage` / `failureOutput` / `blockingCodes`）、`failedStage` | 驻留点名哪几家、续跑从哪一步起 |
| 驻留的整轮被挡判据 | scripts/hold-and-resume.mjs:295-311 | `round.healthCheckDaily.ok===false`、`round.healthCheckDaily.roundCause` | 判「整轮挂住等人」还是「逐店失败」 |
| `batchUnfixableShops` | scripts/run-batches.mjs:228-236（内部调 `unfixableShopsOf`） | 同 `unfixableShopsOf` | **释放判定**（`releaseAfterBatch` 的入参）与**逐店失败转驻留**（run-batches.mjs:642-648） |
| `batchRoundBlockOf` | runtime/batch-plan.mjs:394-401 | `round.healthCheckDaily.{ok, roundCause, missingPages}` | 整轮被挡 ⇒ 剩余批次收手 |
| `buildRunReceiptFromRounds` | runtime/batch-rounds-receipt.mjs（由 run-batches.mjs:736-746 喂） | 每批 `unfixable` 名单（来自 `unfixableShopsOf`） | 统一回执 run-receipt-v1 的失败店清单 |
| `roundFailureSummary` / `buildRoundFailureAlert` / `planAlertDeferral` | run-multi-shop-day.mjs:626-681 / :961 / :668 | `shops`、`status`、waiting 过滤、`round.healthCheckDaily.*` | 链级失败告警文案、agent 派单延迟闸门 |
| `classifyShopEscalation` | runtime/escalation-plan.mjs:176-213 | `status!=='ok'`、`repairRequest.candidates`（空/非空）、`autoRepair.gaveUp` | 判这家能不能交给修复 agent；生成 `escalation-handoff.json`（带 `repairRequestPath` / `statePath` / `candidates` 动作名清单） |
| 修复 agent 会话侧 | docs/ops/REPAIR-AGENT-HANDOFF.md「触发条件」 | `summary.json`：店 `status!=='ok'` 且（`autoRepair.gaveUp` 非空 **或** `repairRequest.candidates` 为空）；或直接读 `escalation-handoff.json` 的 `targets[]` | 决定要不要派后台修复 agent |

**矩阵小结**：九个消费方全部长在日报链私有字段路径上；推广链 P0-3 起勉强喂饱了其中读 `candidates` 的那几个；商品链一个都喂不到。

---

## 三、统一 schema 字段表（核心交付）

### 3.1 设计原则（从现状矩阵直接推出）

1. **以日报链现状为基线**（方案文档 P1-5 与本任务口径）：它字段最全、消费方最多。统一 schema＝日报链字段的「归一化超集」，不是另起炉灶。
2. **消费方先行**：每个字段必须答「谁读它」。没有任何消费方的字段不进 schema。
3. **链内扩展放行但不约束**：三链语义不同的字段（如 `stages` 的形状）标为「链内扩展」，schema 不校验其内部形状，只要求不与统一字段重名。
4. **判据只有一处来源**：schema 字段的值（如 `noActionRequired`）仍来自 skills 侧的分诊表等既有判据，schema 只规定「落在哪个字段」，不复制判据本身。

### 3.2 顶层字段

| 字段 | 类型 | 语义 | 日报链现状 | 推广链现状 | 商品链现状 | 迁移动作 |
|---|---|---|---|---|---|---|
| `version` | string（建议 `'unified-summary-v1'`，**待拍板**） | schema 版本，守卫靠它分流新旧格式 | 无 | 有（`'promotion-sales1-summary-v1'`） | 无 | 三链统一补 |
| `workflow` | string（`daily-report` / `promotion-daily` / `product-daily`，与 runtime/workflow-catalog.mjs 的 id 同源） | 哪条链写的。驻留续跑（`--workflow`，P0-3）与回执已经需要它，summary 里目前只能靠目录名猜 | 无（目录名隐含） | 无（同左） | 无 | 三链统一补 |
| `date` | string | 业务日 | 有 | 有 | 有（在 run-receipt 里） | 不动 |
| `mode` | string | commit / rehearse 等 | 有 | 无（`--commit` 即 mode，不落） | 无（run-receipt 不记） | 补齐即可，消费方目前没人读它 |
| `startedAt` / `finishedAt` | string | 起止时间戳 | 有 | 无 | 无（run-receipt 有 `startedAt`/`finishedAt`） | 补齐 |
| `round` | object \| null | 整轮级体检结论（`healthCheckDaily.*`）。**推广/商品链没有共享商家浏览器体检，恒 null**（run-batches.mjs:454「promotion-daily：不启动日报共享商家浏览器」） | 有 | 无 | 无 | schema 定为可选；推广/商品不补 |
| `shops` | object（店名 → 记录） | 逐店结论 | 有 | 有 | **无（这是本链最大缺口）** | 商品链新增生成 |

顶层**不新增** `rounds` 聚合数组：分批形态下每批一份独立 summary.json 是现状设计（防覆盖，runtime/batch-plan.mjs:283-285），全轮聚合已由 `batches.json` 与 run-receipt 承担。是否要跨批聚合进 summary，列为待拍板项 6.5。

### 3.3 `shops[]` 统一字段（核心表）

每行：类型 / 语义 / 三链现状 / 消费方 / 迁移动作。

| 字段 | 类型 | 语义 | 日报链 | 推广链 | 商品链 | 谁读它 | 迁移动作 |
|---|---|---|---|---|---|---|---|
| `shop` | string | 店名。要求：**既做 map 键，也在记录内**，且两者一致（校验器查这条不变量） | 无（键即店名） | 有 | collection.json 有 | 全体消费方按键遍历；`classifyShopEscalation`/告警按店名点名 | 日报链补字段值＝键 |
| `status` | enum：`ok` / `failed` / `pending` / `waiting` | 逐店终态。`pending`＝轮没收尾时的初值；`waiting`＝运营账号暂缓（日报链现状，runtime/daily-report-shop-gates.mjs:23） | 有（四值都在用） | 有（`ok`/`failed`；初值即 `failed`，fail-closed） | run-receipt 无逐店 status，仅 `stoppedAt` 粗档 | `unfixableShopsOf`、`failedShopsOf`、`roundFailureSummary`、`classifyShopEscalation`、REPAIR-AGENT-HANDOFF | 商品链从 `stoppedAt`＋导入 exit code 归并出 `ok`/`failed` |
| `error` | string \| null | 失败时的错误一句话。**只作人读摘要，判据不建立在它的措辞上**（本仓 `.includes` 教训，见 shopFailureCause 用 `failureOutput` 不用 `error.message` 的理由，run-multi-shop-day.mjs:420-431） | 有 | 有 | collection.json 有 `error` | 告警文案、agent 概览 | 三链已有，落位即可 |
| `failureClass` | string \| null | **成因代号**（如 `BLOCKED_BY_OVERLAY` / `SOURCE_NO_ROW_FOR_DATE` / `STAGE_FAILED` / `NEEDS_LOGIN`）。失败必有、成功必无 | **不物化**：藏在 `repairRequest.cause`，消费方读时由 `shopFailureCause(record)` 从 `failedStage`+`failureOutput`+`blockingCodes` 推导 | 无 | 无（`classifyWorkflowError` 的四分类是整轮级，不逐店） | `failedShopsOf`（经 `shopFailureCause`）、分诊/修复候选表、告警的成因行 | **物化**：日报链在写 summary 时把分类结果落到记录上（推导仍用同一个 `shopFailureCause`，只是从「读时现算」变「写时落定」）；推广链补一个最小分类器（先全部落 `STAGE_FAILED` 档也行，字段不能缺）；商品链从 `stoppedAt` 映射。详见待拍板项 6.1 |
| `autoRepair` | object \| null | 自动修复回环结论。**没跑过修复就是 null**（不许 `{}`——`gaveUp` 判据会把「没跑」读成「跑过没救回来」，unfixableShopsOf:218-222 的判据靠 `typeof gaveUp === 'string'` 区分，schema 把这个口头约定写成硬约束） | 有（`{enabled, cause, stage, maxRounds, rounds[], rescued, gaveUp, error}`） | 无（恒 null） | 无（恒 null） | `unfixableShopsOf`（读 `gaveUp`）、`classifyShopEscalation` | 推广/商品链落 null；日报链不动形状 |
| `autoRepair.attempted` | boolean | **本轮是否真的发起过至少一次修复尝试**。现状判「发起过」＝`autoRepair` 存在且（`rounds.length>0` 或 `gaveUp` 非空），这是隐式推导，schema 把它显式化（P0-3 的推广链空菜单场景：attempted=false 而 gaveUp 语义在 candidates 上） | 隐式（无此字段） | 无 | 无 | 审计/回执（区分「修过没救回来」与「压根没修」）；现状无消费方硬读它，**为回执与告警文案准备** | 三链补显式布尔 |
| `autoRepair.gaveUp` | string \| null | 放弃原因（非空＝脚本自修没救回来）。判据原文：unfixableShopsOf:221 | 有 | 无（恒 null） | 无（恒 null） | `unfixableShopsOf`、`classifyShopEscalation`、REPAIR-AGENT-HANDOFF | 推广/商品链落 null |
| `repairRequest` | object \| null | 修复请求单。**失败店必有**（哪怕空菜单——P0-3 的形态 `{candidates:[]}` 正是契约）；成功店必须无 | 有 | 失败店有（P0-3） | 无 | `unfixableShopsOf`、`classifyShopEscalation`、REPAIR-AGENT-HANDOFF | 商品链失败店补最小请求单（先 `candidates:[]`＋`cause`） |
| `repairRequest.candidates` | array | 修复候选动作清单。**空数组＝「脚本不知道怎么修，交给人/agent」**，这是 unfixableShopsOf 的第二判据（:219-222），也是 REPAIR-AGENT-HANDOFF 的触发条件之一。非空时元素形状链内自理（日报链是 `planRepair` 的对象契约） | 有 | 有（恒空） | 无 | 同上 | 商品链补 |
| `noActionRequired` | boolean | **这条失败需不需要任何人做任何事**。值来自分诊表 `notifyLevel === 'silent'`（run-multi-shop-day.mjs:458-468，唯一来源在 skills 侧，schema 不复制名单）。true ⇒ `unfixableShopsOf` 剔除（防「驻留 4 小时等一个不存在的人」，2026-10-05 网林家居案） | **长在 `repairRequest.noActionRequired`**，不在顶层 | 无（失败店无此字段 ⇒ 按 false 语义处理） | 无 | `unfixableShopsOf`（:217）、分诊 | **位置有分歧，待拍板项 6.3**。草案推荐：提升到 shops[] 顶层、与 `repairRequest` 解耦（「谁都不用动」与「怎么修」是两件事，且商品链的最小请求单不需要背这个字段） |
| `evidence` | string | 该店证据目录（相对仓库根）。现状靠约定：日报链＝`<--logs 根>/<店名>`（run-multi-shop-day.mjs:2039）、推广链＝`<--evidence 根>/<店>`（run-promotion-sales1.mjs:168）、商品链＝`<runId 目录>/<店>`（run-product-data-job.mjs:280）。agent 到场第一件事就是找这个目录（REPAIR-AGENT-HANDOFF 第 0-2 步），现状全靠人拼路径 | 无（约定俗成） | 无（同左） | 无（同左） | 修复 agent（`statePath`/`screenshotPath` 已在 repairRequest 里，但那是失败店；成功店与 waiting 店的取证目录现在没有任何字段指路）、事后复盘 | 三链补 |

**允许保留的链内扩展字段**（schema 不校验、但保留）：日报链的 `failedStage` / `failureOutput` / `stages` / `source` / `perception` / `relogin` / `evidenceIncomplete` / `recovery` / `blockingDetails`；推广链的 `batch` / `stages`(string[]) / `recovery`。**注意**：`stages` 三链形状不同（日报对象数组、推广字符串数组、商品无），刻意不统一——它的消费方（告警里「停在第几步」）各自取材，硬统一收益为零、破坏面极大。

### 3.4 schema 不变量（校验器逐条钉）

1. `shops` 的键与 `record.shop` 必须一致且非空。
2. `status === 'ok'` ⇒ `error`/`failureClass`/`repairRequest`/`autoRepair` 必须缺席或 null。
3. `status !== 'ok'`（且 ≠ `waiting`）⇒ `failureClass` 必须是非空字符串；`repairRequest` 必须存在且 `candidates` 是数组（允许空）。
4. `autoRepair` 若存在：`gaveUp` 是 string|null；`attempted` 是 boolean；`gaveUp` 非空 ⇒ `autoRepair` 存在。
5. `noActionRequired === true` 只允许出现在 `status !== 'ok'` 的记录上。
6. `version` 与 `workflow` 必须是非空字符串且在登记词表内。
7. `waiting` 记录允许缺 `error`/`failureClass`/`repairRequest`（它不是失败，是暂缓——现状 `waitingOperatorAccountRecord` 只有 `failedStage:'shop-report'` 占位）。

---

## 四、兼容与迁移策略（绞杀者模式）

方案文档已定的纪律：**schema 统一先加字段后删旧路径，两轮观察期**（第五节风险控制 3）；行为不变量＋`--print` 基线逐字节对比；一个能力一个 commit、git revert 即回滚。**禁止一次切换**——九个消费方读着旧路径，一次切换等于九个静默失效点同时引爆。

| 步骤 | 内容 | 涉及文件（不扩面） | 消费方改动 | 回滚点 | 怎么验证 |
|---|---|---|---|---|---|
| 1 | schema 校验器（纯函数）＋守卫测试落库（见第五节）。**不动任何生产代码** | 新增 `runtime/unified-summary-schema.mjs` ＋ `runtime/unified-summary-schema.test.mjs` | 无 | 删两个新文件即回滚，零生面影响 | 校验器对三链**真实历史 summary**（evidence/ 下的样本）全过；对故意改坏的样本逐条红 |
| 2 | 日报链「并写」：落盘时**新增**统一字段（物化 `failureClass`、补 `shop`/`evidence`/`workflow`/`version`、`autoRepair.attempted`、顶层 `noActionRequired`），**旧字段一个不动**（`repairRequest.noActionRequired` 等原样保留） | `run-multi-shop-day.mjs`（summary 构建段 ：1985 与失败路径 ：2270-2326 附近） | 无——所有消费方继续读旧路径 | 单 commit revert | `--print` 基线不变；真跑一轮后新旧字段并存且自洽（守卫测试对新产物跑绿） |
| 3 | 推广链并写：`buildPromotionSummary` 补 `workflow`/`version`/`shop`（已有）/`evidence`/`failureClass`/`noActionRequired:false`/`autoRepair:null`——`repairRequest.candidates:[]` 保留 | `run-promotion-sales1.mjs` | 无 | 同上 | 同上（buildPromotionSummary 是导出纯函数，离线用例先钉） |
| 4 | 商品链新增 summary.json：在 `main` 收尾处（run-product-data-job.mjs:441 聚合 collection.json 旁边）按统一 schema 生成。**不动 run-receipt.json / collection.json**（回执统一是 P1-6 的活，不在这轮搅） | `run-product-data-job.mjs`（＋一个可离线测试的纯函数构造器） | 无（商品链目前没有 summary 消费方） | 单 commit revert，产物只是多一个文件 | dry-run 一轮：summary 与 collection.json/gaps 逐店一致 |
| 5 | 消费方逐个切换到新字段。顺序按「谁最便宜」排：① `roundFailureSummary`（链内、同文件，测试最全）→ ② `classifyShopEscalation` → ③ `unfixableShopsOf`（**一次只切一个判据分支**：先 `noActionRequired` 顶层、再 `gaveUp`、再 `candidates`——每切一个分支跑全量定向套件）→ ④ `failedShopsOf`（`failureClass` 物化后 `shopFailureCause` 变直读，删推导）→ ⑤ REPAIR-AGENT-HANDOFF 会话侧（改文档判据） | 对应各消费方文件 | 每个消费方一个 commit；切换期间**双读**：新字段优先、旧字段回退（旧字段在观察期内仍在并写，所以回退读得到） | 每步独立 revert | 突变验证：把新字段改坏，必须红在**点名那个消费方**的用例上（仓库纪律：改坏必须红在点名用例） |
| 6 | 观察期：满两个调度轮（07:00/10:00/11:30 天然是验收窗口）且六轮全绿后，删旧路径（`repairRequest.noActionRequired` 等）并删双读回退 | 步骤 2-5 涉及文件 | grep 确认全仓无引用后才删（`grep -rn "noActionRequired" runtime/ scripts/ skills/ docs/` 逐处过目） | 删除本身也是单 commit，可 revert | 删后再跑一轮真机，守卫测试对产物仍绿 |

**为什么并写期间不算「两份事实」**：新旧字段同值同源（同一个构造点写出），守卫测试钉住自洽；真正危险的是两处**各自计算**——那是本草案第 2 步刻意不做的（`failureClass` 物化只是把 `shopFailureCause` 的结果从读时算挪到写时算，函数只有一份）。

---

## 五、守卫设计

### 5.1 落点

- **校验器**：`runtime/unified-summary-schema.mjs`——一个 `validateSummary(summary) → { ok, errors[] }` 纯函数。**只依赖 node 内建、不 import skills**（runtime/arch-boundary.test.mjs 的既有纪律，与 hold-and-resume-plan.mjs 文件头同款约束）；schema 里不出现任何业务判据（分诊表、修复表都不进来），只有形状与不变量。
- **测试**：`runtime/unified-summary-schema.test.mjs`，与 `runtime/version-consistency.test.mjs` 同层、同跑法（node 测试文件，被既有定向套件收录）。测三类样本：
  1. **三链真实历史样本**：从 `evidence/` 挑最近一轮的日报 summary、推广 summary（P0-3 之后必有）、商品 collection（在步骤 4 之前用「按草案手工构造的等价 summary」钉住契约，步骤 4 之后换真产物）；
  2. **最小合法夹具**：每链一份手写最小 summary（含成功店/失败店/空菜单/waiting 店），这是「三链都能通过同一份 schema」的直接证据；
  3. **反例夹具**：违反 3.4 每条不变量的样本各一份，逐条点名红。
- **fail-closed 的含义**：校验红＝合并门禁红。守卫挡的是「schema 被人改漂」与「某条链忘了落新字段」，不是运行期闸门。

### 5.2 写入时校验（二期，随步骤 2 一起评估）

链在落 summary.json 前调 `validateSummary`：不过 ⇒ **照样落盘**（证据优先，不许因为校验失败把失败现场弄丢）＋ stderr 醒目警告 + 守卫测试随后会红。不做成「校验不过就拒绝落盘」——那会把「格式问题」升级成「丢整轮结论」，方向反了。

### 5.3 突变验证（仓库既有纪律）

步骤 1 交付时同场做一个突变脚本：把校验器某条不变量注释掉，确认测试红在**点名那条**的用例上（mutation-verification-harness 手法）；把日报链样本的 `failureClass` 删掉，确认红在「日报链夹具」那条——证明守卫真的在咬，而不是全绿摆设。

---

## 六、待拍板项（每项给选项＋推荐，可一键回答）

> **拍板结果（2026-10-11 16:30，用户确认「全按推荐」）**：6.1-A 写时物化｜6.2-A 四值枚举 ok/failed/pending/waiting｜6.3-A `noActionRequired` 提升 shops[] 顶层｜6.4-A 三链同串 `'unified-summary-v1'`｜6.5-A 不加顶层 rounds 聚合｜6.6-A 商品链 summary 落 `evidence/product-data-job-<日>/<runId>/summary.json`｜6.7-A 写入时校验随迁移第 2 步一起上。七项全部生效，按第四节绞杀者六步施工。

### 6.1 `failureClass` 物化还是读时推导？

- A（推荐）：**写时物化**。链落 summary 时调既有 `shopFailureCause` 算好落进记录。理由：`failedShopsOf`/`classifyShopEscalation`/告警从此读同一个值，不再各自现算；「同一失败两个读者两种归因」的漂移面被删掉。代价：日报链要加一个写入点＋用例。
- B：保持读时推导，schema 不收此字段。理由：零迁移成本。代价：推广/商品链永远没有成因，`failureClass` 这一条对它们是空文，后续分诊/修复候选接不进来。
- C：过渡期两者并存（物化＋消费方仍可推导），观察期后删推导。比 A 多挂一层，仅在担心写入点漏算时值得。

### 6.2 `status` 枚举收多少？

- A（推荐）：`ok / failed / pending / waiting` 四值——全部是日报链**现存**取值，不发明新词；`waiting` 保留是因为它是真实业务态（运营账号暂缓），塞进 `failed` 会让驻留判「需要人」（它不需要）。
- B：收敛到 `ok / failed` 两值，waiting 移到顶层名单。改动面更大（`isWaitingOperatorAccountStatus` 及其消费方全要动），不推荐在这轮做。

### 6.3 `noActionRequired` 放哪层？

- A（推荐）：**shops[] 顶层**，与 `repairRequest` 解耦。理由：语义上它是「这条失败要不要人管」，与「怎么修」（repairRequest）正交；商品链的最小请求单可以不背它；`unfixableShopsOf` 少读一层。
- B：维持现状（`repairRequest.noActionRequired`）。理由：`unfixableShopsOf:217` 已经这么读，零改动。代价：商品链/推广链成功店的 null-repairRequest 语义要额外解释（「没有请求单」vs「请求单里说不用管」两种 null 靠上下文猜——正是 schema 要消灭的东西）。
- 若选 A，迁移第 5 步里 `unfixableShopsOf` 的这一条判据分支单独成一个 commit 切换。

### 6.4 `version` 字段口径？

- A（推荐）：`'unified-summary-v1'`，三链同串。守卫按它分流「新旧格式」；推广链现值 `'promotion-sales1-summary-v1'` 在并写期后废弃。
- B：各链保留自己的版本串（`version` 记格式、`workflow` 记链）。多一层心智，且守卫无法单靠 version 判断「这是不是统一契约产物」。

### 6.5 分批形态要不要顶层 `rounds` 聚合？

- A（推荐）：不要。每批一份 summary 是防覆盖的既有设计；全轮聚合已由 `batches.json`（run-batches.mjs:689-708）与 run-receipt 承担，再造一份=第三份全轮结论，迟早漂。
- B：要（例如驻留想读全轮名单时方便）。目前没有消费方提出这个需求，按「消费方先行」原则不加。

### 6.6 商品链 summary 落盘位置？

- A（推荐）：`evidence/product-data-job-<日>/<runId>/summary.json`，与 collection.json 同目录。理由：一次 run 一份，重跑不覆盖（runId 已经天然防了）；消费方（未来的托住/回执）从 batches.json 式索引或 run-receipt 找 runId。
- B：固定路径（如 `evidence/product-data-job-<日>/summary.json`）。与 runId 防覆盖设计冲突，重跑互相盖——推广链 P0-3 之前「stdout 打 JSON 不落盘」的教训同源。

### 6.7 写入时校验（5.2）现在就上还是二期？

- A（推荐）：随迁移第 2 步一起上（日报链先上，推广/商品链接 summary 时各自带）。成本低（一次函数调用＋一行警告），收益是漂移当场暴露而不是下一轮调度才被守卫咬。
- B：只在测试层守。真机上第一份漂的 summary 会静默活到下一次跑测试——按本仓「静默失效最贵」的价值观不推荐。

---

## 附：本文档核实过但方案文档未展开的发现

1. **`failureClass` 在日报链现状中不存在为字段**——分类藏在 `repairRequest.cause`，且消费方（`shopFailureCause`）依赖 `failureOutput` 全文与 `blockingCodes` 读时推导（run-multi-shop-day.mjs:420-431 的 2026-10-10 缺陷修复正是因此）。物化不是「加个字段」而是「挪一个判据的执行时机」，需要用例钉住「写时算的与读时算的一致」。
2. **`noActionRequired` 现在长在 `repairRequest` 里**，方案文档 P1-5 的字段清单把它列在 shops[] 层——位置与现状不一致，见待拍板项 6.3。
3. **`status` 有四个现存取值**（含 `pending`/`waiting`），且推广链记录初值即 `failed`（fail-closed）、日报链初值 `pending`——默认值口径三链不同，schema 必须显式声明允许集而不是假设两值。
4. **`stages` 三链形状互不兼容**（对象数组/字符串数组/无），消费方各自取材——schema 刻意不统一它，见 3.3。
5. **商品链的「托住」缺的不只是 schema**：它自管释放、每批无条件放（run-product-data-job.mjs:421-436），即使统一 schema 落地，要把托住接到商品链还需要把它的释放改成走 `releaseAfterBatch` 同源判据——那是 P1 之后的独立一步，本文不展开。
6. **`escalation-handoff.json` 是 summary 的旁路派单文件**（classifyShopEscalation 生成、REPAIR-AGENT-HANDOFF「更快的一条」直读），迁移第 5 步切 `classifyShopEscalation` 时它会跟着变，需要一起过用例。
