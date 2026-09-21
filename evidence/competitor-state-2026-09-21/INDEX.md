# 竞品链现状取证 2026-09-21

## 为什么取这组证

多份文档对同一批飞书字段记了互相矛盾的数字：

- `docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md` §1 表与 §3 P1-2：`搜索关键词`「全空、未修」，周表 35 字段
- `docs/ops/WEEKLY-RUN-2026-09-13_2026-09-19-FINDINGS.md` §3：同一列 1417/1417 已写满
- `docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` §3.2：第 7 步产物无消费者（推断，非实测）

⇒ 本轮**不采信任一份文档**，改为直接写只读探针发 GET 实测。

## 方法与边界

两个探针**只发 GET**（`listTables` / `listFields` / `listRecords`），未创建、未更新、未删除任何记录或字段。
运行时间 2026-09-21 09:2x（+08:00）。凭据取自 `runtime/feishu-targets.mjs` 解析出的
`E:/小红书/.env.feishu-kcne.local`，base `QcnhbEzYpacGvUskCbVcrcm3nFd`（profile kcne）。

## 文件清单

| 文件 | 是什么 |
| --- | --- |
| `competitor-weekly-state.mjs` | 探针一：单期明细（最新周表 / 竞品主表 / SKU明细 的字段类型 + 有值率） |
| `competitor-weekly-state.txt` | 探针一输出 |
| `weekly-tables-across-periods.mjs` | 探针二：**四期竞品周表 + SKU 周表跨期有值率对比** |
| `weekly-tables-across-periods.txt` | 探针二输出 |
| `inventory-2026-09-21.txt` | 端口/实例只读盘点（竞品链 9222/3457 当时整缺） |
| `now.txt` | 本次取证的实测时间（`current_time` 是会话开始快照，不可用） |

## 结论（详见 `docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` §七）

1. **本期（09-13~09-19）是四期里唯一写满的一期**：12 个关键字段 10 个 100%、`数据状态`/`待补数据项` 98.4%、
   只有 `商品ID` 是 0/1417。**真正全空的是 08-30 与 09-06 两期**（除公式列外全 0）。
2. 周表 `搜索关键词` = **1417/1417（100%）** ⇒ `WEEKLY-SUPERVISION` P1-2 已过时，
   `sync-latest-ab-to-main-core.mjs:79` 那道 fail-closed 本期是通的。
3. 主表 `尺寸`/`适用空间` **仍是 Lookup(19)、15/2004＝0.7%**；周表已改 Text 100%。
4. **SKU 周表全 base 只有 1 张**（`SKU周_2026-08-23_2026-08-29`），本期从未创建。
5. 第 6 步硬阻塞＝买家号登录态；竞品链浏览器当时整缺。

---

## 追加：尺寸链根因取证（2026-09-21 09:5x）

### 起因

用户指出「尺寸是判定为 A/B 再去小旺神单独获取」，并要求「查彻底、固定到流程」。
第一轮探针查的是 SKU明细 里**不存在**的字段名 `尺寸`，把「字段不存在」误读成「字段全空」——
这是探针 bug，不是数据事实。本轮补两个精确探针。

### 追加文件

| 文件 | 是什么 |
| --- | --- |
| `sku-size-fields.mjs` / `.txt` | 探针三：SKU明细 / SKU周 / 竞品周 的**全字段**清单 + 有值率 + 尺寸族样本值 |
| `title-join-check.mjs` / `.txt` | 探针四：周表与 SKU明细 按「商品标题」的**交集**，以及周表「尺寸」列取值分布 |
| `attribute-writeback-week-2026-09-13_2026-09-19.receipt.json` | 写周表属性的收据（关键时间戳 `02:59:19Z`，`尺寸.skuBacked=3`） |
| `xws-sku-apply-receipt-20260916T030359902Z-*.json` | 第 6 步 apply 收据（`03:03:59Z`，`734→830`，96 行全验证） |
| `inv-recheck.txt` | 浏览器复盘点（7 实例全就位，竞品链 9222/3457 ok） |

### 实测结论

1. **尺寸能力完好**：`SKU明细` 830 行的 `SKU尺寸`、`尺寸汇总` 均 **100% 有值**；
   `尺寸汇总` 取值即截图那类格式 —— `1.2m-1.7m` / `1.3m-1.8m` / `1.4m-1.7m`。
   `SKU周_2026-08-23_2026-08-29`（734 行）同样 100%。
2. **09-16 刚跑通过**：apply receipt `APPLIED_AND_VERIFIED`，`beforeSkuRecordCount 734 → after 830`，
   `verifiedUniqueKeys/verifiedRelations/verifiedSpaceDecisions` 各 96。
3. **断点在「写回」而非「采集」，且是时序问题**：
   - `2026-09-16T02:59:19Z` 跑 `fill-weekly-attribute-labels.mjs` 写周表 10 列 →
     `尺寸` 列 `skuBacked` **仅 3**、`none`（无注明）**1364**、`na 23`。
   - `2026-09-16T03:03:59Z` 才跑第 6 步 SKU 采集 apply（+96 行带 `1.4m-1.7m`）。
   - 即：**写回比采集早 4 分 40 秒**，写回时 SKU 数据还没进来。
4. **「只填空不覆盖」把错误结果锁死**：fill 的 `if (text(f[name])) { skipped += 1; continue; }`
   使那 1364 行的「无注明」写进去后**重跑也修不回来**。
5. **聚合键选错（真正的设计缺陷）**：fill 与主表 Lookup 都用「商品标题」做跨表联接键。
   实测：周表(09-13) 去重标题 **1359** 个，SKU明细 去重标题仅 **14** 个，**交集只有 3**。
   ⇒ 竞品每周采到的商品不同，跨周标题联接**天然几乎必然落空**。
   稳定键 `商品ID` 存在（`SKU唯一键 = 商品ID|SKU ID`），但**周表 `商品ID` 列 0/1417**（导入时未写）。
6. **最终可见口径**：周表 `尺寸` 列是 SKU 格式的行数 = **0 / 1417**；
   主表 `尺寸`（Lookup(19)，`SKU明细.商品标题 = 本表.商品标题` 取 `SKU明细.SKU尺寸`）只有 **15/2004 = 0.7%**。

### 尺寸链的正式口径（代码级）

- **谁做**：`竞品分类` ∈ {A-爆款竞品, B-高价值竞品} 且 `是否有效竞品=是`。
  判据（`skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs:1107-1111`，与飞书公式 `:817` 同源）：
  A = 月收货≥80 且 月收货金额≥200000；B = 材质含「人造石」且 月收货≥10；
  C = 价格≥8000；D = 价格<1000。
  `:1135` 明确 `if (['A-爆款竞品','B-高价值竞品'].includes(competitorClass)) addPending('SKU尺寸', ...)`。
- **从哪来**：商品页 → 小旺神一键复制 SKU → `runtime/xws-sku-payload-parser.mjs:123`
  `summarizeSkuDimensions()` → `尺寸汇总`（`:169`）；每行 `SKU尺寸`（`:168`，= `dimension.payloadValue`）。
- **空间判定**：`competitor-v2-core.mjs:222` `classifySkuSpace` —— 0.8m–1.2m→`小户型`，
  1.3m–1.8m→`常规卫生间`，其余/范围/冲突→`需人工核验`。
- **回落**：`classifyDimensions(title)`（`competitor-v2-core.mjs:1094`）从**商品标题**提尺寸，
  拿不到即 `无注明` —— 这就是那 1364 行的来源。

---

## 追加：尺寸链固定（2026-09-21 10:0x，方案与口径见 `docs/ops/SIZE-CHAIN-FIXED-2026-09-21.md`）

### 本轮新增的实测（补上第二节缺的那一块）

第二节只查了「标题键」，没查「链接键」，也没查「本期到底有几个 A/B」。本轮补上：

| 观测 | 数字 | 来源 |
| --- | --- | --- |
| 周表 `商品链接` 能否提出商品 id | **1417 / 1417**（提不出 0） | `linkid-join.txt` |
| 周表链接id ∩ SKU明细商品ID | **2**（另一条是 `无分类` 行） | 同上 |
| 竞品周_2026-09-13_2026-09-19 的 **A/B 行数** | **1** | 同上 |
| 那一行 | `B-高价值竞品`，id `921092099640`，周表 `尺寸` = `无注明` | 同上 |
| 同一商品在 SKU明细 侧 | `尺寸汇总 = 1.4m-1.7m`、`适用空间 = 常规卫生间`（96 行） | 同上 |

**这条推翻了第二节的第 5 条结论的适用范围**：对**本期那唯一一个 A/B** 而言，标题键其实是能命中的
（`title-join-check.txt` 里「周表 A/B 竞品 1 条，命中=是」）。所以本期那行尺寸为空，
**不是键的问题，而是顺序 + 未编排 + 幂等锁死三件事**。键的问题只在扩展到其他商品时才会显形。
（`商品ID` 做键这条仍然要做，理由从「本期落空」改成「跨周/跨商品必然落空」。）

### 本轮改动（代码）

| 文件 | 改动 |
| --- | --- |
| `runtime/fill-weekly-attribute-labels-core.mjs` | **新建**：判据层 —— `extractProductId` / `isAbClass` / `RECOMPUTABLE_COLUMNS` / `decideWrite` |
| `runtime/fill-weekly-attribute-labels-core.test.mjs` | **新建**：9 条测试 |
| `runtime/fill-weekly-attribute-labels.mjs` | 接入 core；联结键改「商品链接里的 id」（主）/「商品标题」（兜底）；新增 `--recompute-ab`；收据升 v3（含 `recomputed` / `joinKeys`） |

### 本轮留证清单

| 文件 | 是什么 |
| --- | --- |
| `linkid-join.mjs` / `.txt` | 探针五：链接 id 做键的命中情况 + 本期 A/B 逐行清单 |
| `fwal-dry-base.json` | 写回 dry-run（**不带** `--recompute-ab`）：`plannedRows = 0` ← 锁死现场 |
| `fwal-dry-recompute.json` | 写回 dry-run（带 `--recompute-ab`）：`plannedRows = 1`，`primaryHit = 1 / fallbackHit = 0` |
| `fwal-dry-recompute2.json` | 接完 core 之后复跑，与上一次逐字同结论（防重构改行为） |
| `mutation-fwal-core.txt` | **突变验证报告：CAUGHT 10/10**，还原 sha256 逐字节一致 |

### 验证（跑在 `0a1cc8d` 之后 + 本次未提交改动）

- `node --check` × 2：通过
- `runtime/fill-weekly-attribute-labels-core.test.mjs`：**9 pass / 0 fail**
- `node scripts/run-test-suite.mjs runtime --concurrency=1`：**86 files / 761 tests / 761 pass / 0 fail**
- 突变验证：**CAUGHT 10/10**，MISSED 0，SKIP/NOOP 0

### 本轮**没有**做的（边界）

- **未回填** 09-13 期周表（按指令：历史周表不回填）。dry-run 只证明「就绪、会写 1 行」。
- **未做编排入口**（按指令：先完整跑通再固定），所以「先采集、后写回」的顺序目前靠文档约束。
- **未扩大采集队列**：第 6 步仍只吃主表 A/B（现覆盖 14 个商品），周表每期 A/B 数会变。


