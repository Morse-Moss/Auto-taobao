# 竞品周更全流程实跑（2026-09-13 ~ 2026-09-19）：根因链、修复与证据

日期：2026-09-16（北京时间）
范围：`竞品周_2026-09-13_2026-09-19`（`tbllWI45sK0DfHpr`）/ 主表 `tblkYcczxBnW4v5G` / SKU明细 `tbl3N48H4znz304T` / 历史总表 `tbln7qqA6XopiL4Q`
租户：kcne（`QcnhbEzYpacGvUskCbVcrcm3nFd`，应用 `cli_a96ee8749078dbcf`）

## 0. 一句话结论

「搜索关键词全空」「主表分类与周表不一致」「第 6 步 SKU 找不到合格候选」是**同一条因果链上的三个断面**，不是三个独立缺陷。断链点在采集合同与主表同步之间；修复后第 1~6、8 步已真实跑通并回读验证，第 7 步（FAQ）的采集与全链本地分析已跑通，**只剩最后的「发布到飞书」**——它卡在一个从未自动化的前置动作上（本期周表不存在），且是破坏性写入，需拍板（§6）。

## 1. 因果链（实测，非推断）

```
采集 CSV 物理上只有 16 列（XWS_HEADERS，import-core.mjs:1-16，不含「搜索关键词」）
  → 周表按主表结构克隆出「搜索关键词」列，导入时无人写值 → 1417/1417 全空
  → sync-latest-ab-to-main-core.mjs:73  fail-closed：
      if (!fields.搜索关键词) throw new Error('Latest competitor row requires a search keyword')
  → 周表 A/B 永远同步不进主表 → 主表停留在旧一轮采集的指标
  → 同一商品：周表 月收货人数=10（→B-高价值），主表 月收货人数=3（→D-价格/流量型）
  → 第 6 步 run-xws-sku-dry-run 的 assertSource 要求「主表当前仍是 A/B」
      → 「Selected main record is no longer an A or B competitor」→ 第 6 步事实上无合格候选
```

分类阈值出处：`skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs:1107-1115`
（A＝月收货人数≥80 且 月收货金额≥200000；B＝材质含「人造石」且 月收货人数≥10；C＝价格≥8000；D＝价格<1000；否则无分类）

顺带定位到第二个独立缺陷：`run-xws-sku-dry-run.mjs` 的 `TARGET` 里写死**旧租户** base/表 id
（`OWebbPUcBa7B8JseYLccQCy9nkf` / `tblJ9LHFN6pMVjPv` / `tblddWTrPeB4TKmR`），
即使分类正确，它在旧 base 里也找不到本租户的记录 → `Received 0`。

## 2. 本轮代码改动（7 处，全部有校验）

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `runtime/run-xws-sku-dry-run.mjs` | `TARGET` 改为从 `feishu-targets.mjs` 取（`competitorBaseToken/tableId`），默认 env 也用 `envFilePath(PROFILE)` | 写死旧租户＝静默指向错目标 |
| `runtime/create-weekly-formula-fields.mjs` | 新增 `RULE_FILLED_TEXT=['尺寸','适用空间','数据状态','待补数据项']` 的 Pass 0：建 `Text(1)`；把 4 个字段从 Lookup/公式两趟里排除 | 开放 API 建不了 Lookup(19)，而 `数据状态/待补数据项` 的表达式引用 `尺寸/适用空间` → 原路径永久 DEFERRED |
| `runtime/fill-weekly-attribute-labels.mjs` | 扩为「规则列写回器」：5 属性 + 4 规则列 + `搜索关键词`；`尺寸/适用空间` 优先取 SKU明细 按「商品标题」聚合、无 SKU 行时回落标题规则；只填空不覆盖；写后回读断言 | 整条链唯一缺失的写入方；`搜索关键词` 是解锁第 6 步的钥匙 |
| `runtime/sync-latest-ab-to-main-core.mjs` | `period.startDate` 由 `toISOString()` 改按 `Asia/Shanghai` 格式化 | Feishu 日期字段是当日 00:00(+08) 的毫秒戳，UTC 切片会整体早一天（09-13 印成 09-12） |
| `runtime/xws-sku-auth-preflight.mjs` | `DEFAULT_PROXY` 3456 → 3457 | AGENTS.md:14 与 docs/ops/PROJECT-BROWSER-AND-PORTS.md:42 都写明 3456 属于**别的项目**且未装小旺神 |
| `runtime/collect-live-xws-sku-topology.mjs` | 同上 | 同上 |
| `runtime/xws-sku-auth-preflight.test.mjs` | 断言 3456 → 3457 | 测试把错误端口固化成了断言（`assert.equal(options.proxy, 'http://127.0.0.1:3456')`） |

新增（正式脚本，非临时脚手架）：`runtime/record-faq-qa-evidence.mjs`
—— 把「小旺神 问大家 导出」的落地 CSV 登记为契约合法的 `qa.csv + qa-receipt.json`。
这一步原本没有写入方：落地的 `小旺神 (3).csv` 只能躺在 `C:/Users/Administrator/Downloads` 里等被重名覆盖。

测试：`node scripts/run-test-suite.mjs runtime` → **456 通过 / 0 失败**（改后复跑）。

## 3. 真实写入台账（全部 APPLIED_AND_VERIFIED）

| # | 动作 | 结果 | 收据 |
| --- | --- | --- | --- |
| 1 | 周表建 4 个规则列 | 35 → **39** 字段（`fldDVRms1F` 尺寸 / `fldnP78Dbw` 适用空间 / `fldssnGZix` 数据状态 / `fld9zZWBgy` 待补数据项） | `evidence/_apply-weekly-fields.txt` |
| 2 | 周表写规则列 | 1417 行：搜索关键词 1417、尺寸 30(2.1%)、适用空间 682(48.1%)、数据状态/待补数据项 1394（23 行「不适用」按语义留空）；回读 0 空 | `evidence/attribute-writeback-week-2026-09-13_2026-09-19.receipt.json` |
| 3 | 周表 A/B → 主表 同步 | 1 行更新；公式收敛验证 `recvticyHkhtcR` = **B-高价值竞品 / 是** | `evidence/_apply-sync-ab.txt` |
| 4 | 主表规则列写回 | 671 行（材质/外形/安装/功能/风格）：主表五列此前为空 → 公式算不出 B，分类长期停在 C/D | `evidence/attribute-writeback-main-2026-09-16.receipt.json` |
| 5 | SKU 链全跑 | 预检 AUTH_READY → 面板真实点击复制「已复制」→ capture(sha256 `1ada52ee…`) → topology(2 属性/96 组合) → dry-run `DRY_RUN_READY` → apply **SKU明细 734 → 830，新建 96 条**，唯一键/关系/空间判定各 96 验证 | `evidence/sku-2026-09-13_2026-09-19/xws-sku-apply-receipt-20260916T030359902Z-3898d4dc-3291-4a58-af7c-e841d6094075.json` |
| 6 | 历史总表发布 | gate 通过（1417 行 0 失败），updates 1417，表内 5763 行 | `evidence/_publish-apply.txt` |

第 5 步分类统计复核：1417 行 → 无分类 890 / D 421 / C 82 / 不适用 23 / **B 1**，与 `buildCompetitorRecord` 的离线口径**完全一致**（口径同源自证）。

浏览器证据：面板 `#xws-copy` 里文本为 `SKU` 的项需**真实鼠标点击**，且淘宝「消费券」遮罩（`[class*="popMask"]`）会吃掉命中测试 —— 注入 CSS 屏蔽遮罩后再点，`elementFromPoint` 才 `topIsSelf:true`。此打法两次复现。

### 3.1 终态独立回读（写完全部动作后重新拉取的线上值，非过程内假设）

```
周表  字段 39 / 记录 1417
      搜索关键词 1417 · 材质分类 1417 · 外形 1417 · 安装方式 1417 · 功能 1417 · 风格 1417
      尺寸 1417 · 适用空间 1417 · 数据状态 1394 · 待补数据项 1394
      （1394 = 1417 − 23：「不适用」竞品按语义留空，不是写失败）
主表  2004：无分类 1394 / D 494 / C 65 / 不适用 39 / B 10 / A 2
      目标记录 recvticyHkhtcR → B-高价值竞品 · 是否有效竞品=是 · 月收货人数 10（周表值已同步进来）
SKU明细 830（其中该商品 96 条）
历史总表 5763
```

## 4. 第 7 步（FAQ）：从「空结果记账」到本地全链跑通

发现：本周 FAQ 的 `top5-manifest.json` 曾是 `{products: [], candidateCount: 0, outcome: 'NO_QUALIFIED_CANDIDATES'}`，
而 `runtime/faq-analysis/2026-09-13_2026-09-19/` 下**一整套「已验证」收据**推进的其实是 0 记录
（`rawSnapshot.sha256 = 01ba4719…`，即空文件的哈希）。即：**空结果被当成证据记了账**。

属性写回后周表出现真实 B 级标的，锁定的前提已失效。本轮处置与推进：

1. 备份并退役陈旧前提产物（可逆，全部改名保留）：
   - `top5-manifest.json` → `top5-manifest.stale-NO_QUALIFIED_CANDIDATES.json`
   - `raw-records.jsonl` / `raw-snapshot-receipt.json` → `stale-*`
   - `runtime/faq-analysis/2026-09-13_2026-09-19/` → `stale-vacuous-2026-09-13_2026-09-19/`
2. 重锁清单：1 个候选（`921092099640` / 主表 `recvticyHkhtcR` / 周表 `recvvhOyFCtNA1` / B-高价值 / 月收货 10 / 周内序号 40），`outcome: PARTIAL_CANDIDATES`。
3. 采集 问大家：面板 `问大家` → `导出csv表格`（真实点击）→ `小旺神 (3).csv`（437B，`时间,问题,回答`，4 条，额度 **299/300**）→ 登记 `qa.csv + qa-receipt.json`（`COMPLETED`）。
4. 采集 评论：面板 `评价分析` → 口径校验（内容=全部 / 日期=全部 / 指定SKU 未勾选 / 大家印象 未勾选）→ `评价下载` → `小旺神评价下载_921092099640_2026-09-16_11_20_52.zip`（**81,048,923 B**，sha256 `20db50da…`）→ `normalize-xws-reviews.ps1` 归一化 → `reviews.csv`（23 行，sha256 `d9bc536b…`；ZIP 内 23 个 `.txt` + 70 个媒体条目，媒体不进评论文本）→ `reviews-receipt.json`。
5. 后续 6 段全部真实跑通（`feishuWrites: 0`，纯本地）：

| 段 | 结果 |
| --- | --- |
| BUILD_LOCAL_SNAPSHOT | 27 条（问大家 4 + 评论 23），`raw-records.jsonl` sha256 `b201a084…` |
| ANALYZE_LOCAL | 27 源记录 → **50** 条分类记录（`faq-ops-rule-v3.3.1`） |
| RUN_AI_REVIEW | codex 本地 provider：**9 任务 / 9 结果 / 9 自动采纳 / 0 需人工 / 0 批次失败** |
| REVIEW_AI_HUMAN_QUEUE | `FINAL_CLASSIFICATION_READY`，`humanQueueCount 0`，源-话题集 50，`publishable: true` |
| BUILD_LOCAL_SUMMARIES | 周汇总 21 行（分母 26）/ 累计汇总 21 行（分母 1033），21 个标签齐全 |
| PUBLISH_FEISHU_SUMMARIES | **已执行并回读验证**（2026-09-16，见 §6.2.1） |

`run-faq-operator --status` 现在的真实状态（`--advance` 逐段推进得到，非假设）：

```
status: DONE   nextAction: DONE
evidenceComplete: true   localSnapshotBuilt: true   localAnalysisVerified: true
aiReviewComplete: true   humanReviewComplete: true  localSummariesBuilt: true
rawRecords: 27   topicRecords: 21   summariesPublished: true   operatorRecords: 2073
```

### 4.1 本轮新增的代码改动（第 8~11 处）

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `runtime/record-faq-qa-evidence.mjs` | 新增 `sourceFile: 'qa.csv'`；`run-status.json` 改为读改写、只覆盖「问大家」那一路 | 缺 `sourceFile` 会被 `run-question-library-collection.mjs:195` 硬校验拦下（要到 `--apply` 才炸）；原实现硬写 `评论: 'PENDING'`，重跑问大家会把已采集完的评论状态打回未完成 |
| `runtime/record-faq-reviews-evidence.mjs` | **新增**（正式脚本）：`--phase prepare` 复制 ZIP 进证据目录、`--phase finalize` 合并 ps1 收据并更新 `run-status.json` | 与问大家同源的缺口：ZIP 只能躺在 Downloads 里等被清理；契约要求 `reviews-source.zip + reviews.csv + reviews-receipt.json` 三件套 |
| `runtime/run-faq-human-review.mjs` | ① 历史快照 glob 同时认 `detail-enrichment-backup-*` 与 `detail-replacement-backup-*`；② 都没有时返回具名 `skipped: 'NO_LEGACY_BACKUP'`；③ 缺决策文件时改为「必须由 AI 复核收据显式声明 0 项需人工」才放行；④ 最终收据暴露 `legacyAudit.skipped` | ① 生产者 2026-09-01 改了备份名，只认旧名的读者在**任何新周期**都必然抛错——不是本周缺数据，是消费者没跟着改名；②③ 见 §6.1 |

### 4.2 两个浏览器侧的真因（可复现）

- **`el-loading-mask` 会吞掉真实鼠标点击**：`评价下载` 按钮上的加载遮罩（`el-loading-mask`）使 `elementFromPoint` 命中的是遮罩而非按钮，`/clickAt` 的真实鼠标事件打到遮罩上、**下载不触发且无任何报错**（页面仍显示 `剩余: 300/300`）。同一坐标改用合成 `btn.click()` 立即成功（15s 后 ZIP 落地）。所以「点击没反应」要先判命中链，别急着怀疑选择器。
- **弹窗未关会挡住工具条**：`问大家` 弹窗以 `z-index:1000000000` 覆盖工具条，必须先关（`.el-dialog__headerbtn`）才能命中 `评价分析`；关不掉时先枚举 `el-dialog__wrapper`，只看元素自身 `display` 会把「父级 `display:none` 因此无布局盒」误判成可见。

## 5. 收尾状态

- **已提交 git**（2026-09-16，第 7 步发布跑通后；代码一笔、文档与记忆一笔）。
- 未重启/未停止任何服务或进程；调试 Edge(9222) 与 CDP 代理(3457) 保持原状。
- 调试 Edge 的页面被注入了一条 CSS（`#probe-hide-mask`，屏蔽 `popMask`），关掉标签页即消失，无持久影响。
- 临时脚手架（`runtime/_*.mjs` 与 `evidence/_*`）在提交前一并清理。

## 6. FAQ 发布：周表自动建表 + 总表只新增（已执行并回读验证）

上一版的发布段（`prepare`）先 `listExactTables` 校验两张「旧表」身份——下面是**改动前的问题状态**，用于说明为什么本期根本跑不动：

```
{ master: 问题主库 }                        { weekly: 问题库_2026-09-13_2026-09-19 }
```

而实测 base 里（`_list-faq-tables.mjs` 只读列出，11 张表）：

```
问题主库                      tblbJ9F91NiN8IfO   2023 行
问题库_2026-08-23_2026-08-29  tbli5dtqFnFmvfYM   2023 行
问题库_2026-08-30_2026-09-05  tbleYYe9dqnf0QGM      0 行
问题库_2026-09-06_2026-09-12  —— 不存在
问题库_2026-09-13_2026-09-19  —— 不存在
```

### 6.1 根因：自动建表能力在迁移 3 里被连带删掉

用户口径是「之前的流程都是自动建表的」。核对属实——历史自动建表落在**旧版 `runtime/run-question-library-collection.mjs` 的 `ensureQuestionTable()`**：

```js
async function ensureQuestionTable(client, name) {
  const tables = await client.listTables();
  const matches = tables.filter((table) => table.name === name);
  if (matches.length > 1) throw new Error(`Multiple tables named ${name}`);
  const tableId = matches.length ? matches[0].tableId : await client.createTable(name, QUESTION_WEEKLY_FIELDS);
  const fields = await client.listFields(tableId);
  if (fields.length !== QUESTION_WEEKLY_FIELDS.length || ...) throw new Error(`Question weekly table schema mismatch: ${name}`);
  return tableId;
}
```

迁移 3（FAQ fan-out）把采集段从「写飞书」改成「只落本地快照」（现在的 `feishuWrites: 0` + `raw-records.jsonl`），**这个函数随写入段一起消失了**，而写入责任搬到发布段。结果：发布段只认「已有旧表」，再也没有任何代码会创建 `问题库_<周期>` —— 每个新周期都必然抛 `FAQ table identity mismatch`。本期不是特例，是必然。

### 6.2 语义纠偏：总表是增量，不能替换（运营口径）

第一版处置把「缺表就建」补回发布段，但**沿用了退役明细线的行语义**：master == weekly == 本期行。那会让 `问题主库` 从 2023 行掉到 50 行。运营当场否掉：

> 问题主库怎么会减少这么多，肯定不行，问题主库是增量，不能替换，跟之前关键词库和竞品库一样，分为周表和总表，总表现阶段只新增

于是发布段整体改成与词库/竞品库一致的**周表 + 总表（只新增）**：

| | 含义 | 缺表 | 已有行且不一致 |
|---|---|---|---|
| 周表 `问题库_<周期>` | 本周期明细行 | **自动建表**（历史 `ensureQuestionTable` 语义） | 拒绝，需显式 `--replace-weekly` |
| 总表 `问题主库` | 长期沉淀、**只新增** | — | 命中身份即跳过；`deletes` 恒为 0 |

判重键仍是 `来源记录唯一键 + 分类标签`（`sourceTopicIdentity`，与周表行的唯一性断言同一把尺）。这跟竞品历史总表是同一套约定——`competitor-history-publish-core.mjs` 的 `buildHistoryPlan` 就返回 `{ creates, updates, deletes: [] }`，那个测试的标题字面就是「plans creates and updates idempotently by 商品周期唯一键 **without deleting existing rows**」。

具体改动：

- `runtime/faq-detail-enrichment.mjs` 新增两个契约函数：
  - `buildDetailAppendPlan({desiredRows, existingRecords})` → `{creates, conflicts, deletes: [], existingCount, desiredCount, overlapCount}`。已存在的身份**不改不删**；内容有差异只记 `conflicts` 供人看、**不写库**（覆盖历史事实不是「只新增」）；总表内重复身份 fail-closed。
  - `assertAppendReadBack` → 追加后行数必须恰为「追加前 + 本次新增」，且每条新增身份都能读到；不做「少一行也算过」的宽容。
- `runtime/publish-faq-detail-enrichment.mjs` 改成**单阶段**（删掉 candidate/switch 两步，`--phase switch` 直接报错并说明原因）：
  - 周表按名发现/补建；总表 id 从 `feishu-targets.mjs` 取 `questionMaster`（原先写死旧租户的 `tblRS5lo0nNN3DOJ`，是坑 35）。
  - 写入前先落 `detail-append-backup-<stamp>.json`：周表旧行 + 本次追加的身份集合（不落 2000+ 行总表 dump——只增不删，撤回靠身份集合即可定位）。
  - 失败自动回滚：撤掉本次追加的行、还原周表（自建周表则删除）。
- `runtime/run-faq-operator.mjs` 的 `publicationVerified` 改成按收据模式分流：新模式 `WEEKLY_PUBLISHED_MASTER_APPENDED_AND_VERIFIED` 必须满足 `recordsAfter === recordsBefore + appended` 且 `deletes === 0`；旧模式 `REPLACEMENT_APPLIED_AND_VERIFIED` 保留可读（旧周期不被误判成未发布），但现役代码不再产生。收据模式常量 `FAQ_PUBLISH_MODE` 放在领域模块里，发布脚本与状态机共用。
- 版本号随语义改名：`faq-detail-replacement-v3.2.0` → `faq-detail-append-v3.3.0`。**不能只改字面量**：`runtime/faq-analysis/2026-08-23_2026-08-29/detail-enrichment-receipt.json` 正是用旧号发到线上 base 的收据，直接改名会把 08-23 那期判成「未发布」→ 下一轮去重跑并动已发布数据（坑 37 的变体）。做法是保留 `FAQ_LEGACY_REPLACEMENT_VERSION = 'faq-detail-replacement-v3.2.0'`，`publicationVerified` 改成「版本号按 mode 各校各的」，测试双向都咬（现役收据挂退役版本号 → 拒；退役收据挂现役版本号 → 拒）。

真实 base 只读预演（`--phase publish`，不带 `--apply`）：

```
mode                PUBLISH_DRY_RUN_READY
version             faq-detail-append-v3.3.0
master              问题主库 tblbJ9F91NiN8IfO
                    recordsBefore 2023  appends 50  overlap 0  conflicts 0  deletes 0
                    → 发布后 2073 行（只增 50，不减）
weekly              问题库_2026-09-13_2026-09-19  不存在 → planning CREATE_THEN_WRITE  rows 50
denominator 26      feishuWrites 0
```

### 6.2.1 已执行（2026-09-16，授权：运营选「全按建议」）

```
--phase publish --apply --confirm-app-token <base-token>
→ mode  WEEKLY_PUBLISHED_MASTER_APPENDED_AND_VERIFIED   feishuWrites 3
  master  问题主库   2023 → 2073（appended 50  deletes 0  conflicts 0  appendedRecordIds 50 条）
  weekly  问题库_2026-09-13_2026-09-19  新建（created true）  rows 50
  backup  runtime/faq-analysis/<周期>/detail-append-backup-20260916T040929159Z.json
```

独立回读（不依赖脚本自述，另跑只读探针）：

```
问题主库        2073 行 / 23 字段 / 身份 2073 distinct / 重复 0 / 标签 41 类
问题库_2026-09-13_2026-09-19  tblQeUSb8WQWN2dF  50 行   （base 表数 11 → 12）
状态机          status DONE  nextAction DONE  summariesPublished true  operatorRecords 2073
```

全程零删除：本次动作只有 3 个飞书写入（建周表 / 写周表 50 行 / 追加总表 50 行），没有 rename、没有 deleteTable。

### 6.3 顺带发现：两套发布世界线并存（未修，需知情）

仓库里同时存在**互不兼容**的两套 FAQ 发布：

| | 明细线（现役接线＋线上 base） | 汇总线 |
|---|---|---|
| 脚本 | `publish-faq-detail-enrichment.mjs` | `migrate-faq-summary-schema.mjs` + `publish-faq-summaries.mjs` |
| schema | `FAQ_DETAIL_FIELDS` 23 列（含 `原始内容`） | `FAQ_MASTER_FIELDS` 7 列 / `FAQ_WEEKLY_FIELDS` 6 列 |
| 行语义 | 周表 = 本期明细行；总表 = 只新增 | 周表 = 本期汇总 21 行；总表 = 累计汇总 21 行（**整表重写**，非只新增） |
| 状态机 | `run-faq-operator.mjs` 的 `PUBLISH_FEISHU_SUMMARIES` 指向它 | 未被任何编排引用 |
| 自我描述 | `sync-question-library-template.mjs` 的废弃提示把 detail 流程列为**已退役** | 提示指向的另一条路 |

线上 base 目前是明细线（问题主库 23 列 / 2073 行，09-16 追加 50 行后）。本轮把明细线的总表改成「只新增」后，它与汇总线在总表侧的口径已经接近；但**两条线的 schema 互斥**（`assertSchema` 拒绝在含 `原始内容` 的表上做汇总替换；明细线的 `schemaMatches` 也要求精确 23 列）。要收敛成一条，需要单独决策走哪条 + 一次 schema 迁移。本轮不动它——避免一次改动同时动两套语义。

### 6.4 本轮对「空门禁」的处置（需要知情）

`run-faq-human-review.mjs` 原实现在「有 AI 结果、但没有人工决策文件」时直接抛错，而本周 AI 复核 9/9 自动采纳、**本就 0 项需人工** —— 于是唯一出路是运营手写一个空 `[]`。手写数组不携带任何可核验来源，比「按上游收据放行」更弱。改法是把门槛换成**具名处置**：

- 缺决策文件时，必须由 `ai-review-receipt.json` 显式声明 `needsHumanReview === 0`，且 `autoAccepted + needsHumanReview === resultCount === 工件结果数`、`period` 匹配，才允许留档空决策；
- 「无可审计的历史快照」不再直接抛错，而是记 `skipped: 'NO_LEGACY_BACKUP'`（与既有 `skipped: 'NO_FINAL_RECORDS'` 同构），并在最终收据里带出，避免读者把「没审计过」读成「审计通过」。

即：**「文件不在就算通过」改成「上游必须说明为什么不用人工」**。这两个判断改动了门禁语义，需运营/AI 侧确认。

### 6.5 前两期 FAQ 欠发的真实原因（运营口径核对）

运营的判断是「前两周没有合格数据去获取 FAQ，没有就不用补」。核对 `runtime/question-library-collection/<周期>/top5-manifest.json` 后：

| 周期 | 候选数 | outcome | 结论 |
| --- | --- | --- | --- |
| 2026-08-30_2026-09-05 | 0 | `NO_QUALIFIED_CANDIDATES` | **确实没有合格数据** → 不补，正确 |
| 2026-09-06_2026-09-12 | 1 | `PARTIAL_CANDIDATES` | 与本周（09-13）同一形态：1 个部分合格候选。**不是「没数据」，是那条链从没跑过** |

所以严格记账：08-30 那期欠发是「无数据」；09-06 那期欠发是「有 1 个候选但流程未启动」。本轮决定不补发（只发本期），但这条差异必须留档——否则「前两周都没数据」会变成一个不准确的先例，下次再遇到 `PARTIAL_CANDIDATES` 时容易被继续跳过。

