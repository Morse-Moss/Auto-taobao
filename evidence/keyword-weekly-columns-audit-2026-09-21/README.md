# 关键词库「近2周…达标次数为空 / 是否重点词=待数据」根因审计（2026-09-21）

## 结论（一句话）

**没统计的原因不是公式坏了、不是字段缺了、也不是权限问题，而是关键词链第 1.6 步「决策历史同步」（`sync-decision-history.mjs --apply`）对 09-19 那期从未跑过。**

三个 `近2周…达标次数` 列的公式是「**上一有效周X达标**（基数）+ 本期增量」的自增式。基数项是一个独立数字字段，**唯一写入方**就是 1.6。基数全空 ⇒ 公式第一层 `IF(ISBLANK(基数),"", …)` 直接返回空 ⇒ 整列 0/300。`是否重点词=待数据` 是同一条链的下游现象：该公式在「搜索热度=高 且 交易热度∈{中,高}」时要读 `近2周重点达标次数`，读到空就落 `待数据`。

## 判据链（每条都有实测依据）

| # | 判据 | 实测 | 依据文件 |
| --- | --- | --- | --- |
| 1 | 三列公式的**基数项**是独立数字字段「上一有效周重点达标/探索达标/A级达标」，不是同名公式字段 | 09-12 与 09-19 两张表公式原文引用的是**同一组 field id**（`fld6QYE7Ym`/`fld99UH4yN`/`fldHz4m1fP`），字段类型 `2(数字)` | `field-alignment.txt` §A |
| 2 | 基数空 ⇒ 整列空 | 各期「基数填充」与「目标列填充」逐期一一对应 | `field-alignment.txt` §B |
| 3 | 基数项的唯一写入方是 1.6 | `sync-decision-history.mjs:425-471` 的 `currentUpdates`；取值只可能是 0/1（`keyWordTarget`/`priorityATarget`/`exploreTarget` ⇒ `planWrite(maximum=1)`），与实测分布 `0×293 1×7` 吻合 | `sync-decision-history.mjs` |
| 4 | 1.6 自 09-13 起**再没 apply 过** | `runtime/keyword-analysis-backups/decision-history-before-*.json` 最近一个是 `20260913T022227Z`；`writeBackup` 在每次 `--apply` 开头必写（`flag:'wx'`） | Glob `runtime/keyword-analysis-backups/*decision-history*` |
| 5 | 交叉证实：最后一次跑 1.6 是「批次 7 那期」 | 历史表 `本期标记` 是建字段时写死 batch 的公式：批次 7 = `是×300`、批次 8 = `否×300` ⇒ 公式里的 batch 仍是 7 | `history-batch-state.txt` |

## 逐期对照（「上星期的表」vs 本期）

| 表 | 批次 | 上一有效周重点/探索/A级达标（基数） | 近2周重点/探索/A级达标（公式结果） | 是否重点词 |
| --- | --- | --- | --- | --- |
| `tblmU1n3SO8Mz7Ub` 修正版 | 1 | 0/301 · 0/301 · 0/301 | 0/301 · 0/301 · 0/301 | 否×268 **待数据×32** |
| `tbl21H07eQTFk2iq` 08-15 | 3 | 300/300 · **65/300** · 300/300 | 300/300 · **0/300** · 300/300 | 否×296 是×4 |
| `tbllvjvv3POBT5yS` 08-26 | 4 | **0/300** · **0/300** · **0/300** | **0/300** · **0/300** · **0/300** | 否×293 **待数据×7** |
| `tbluOczztfu03Ag2` 08-29 | 5 | 300/300 · 300/300 · 300/300 | 300/300 · 300/300 · 300/300 | 否×294 是×6 |
| `tblHjA9BcVpAUNtZ` 09-11 | 6 | 300/300 · 300/300 · 300/300 | 300/300 · 300/300 · 300/300 | 否×293 是×7 |
| `tblrX0GM7HkVhF85` **09-12（上星期）** | 7 | 300/300 · 300/300 · 300/300 | 300/300 · 300/300 · 300/300 | 否×294 **是×6** |
| `tblZsUns9353w3nl` **09-19（本期）** | 8 | **0/300 · 0/300 · 0/300** | **0/300 · 0/300 · 0/300** | 否×295 **待数据×5** |

⇒ 基数为空 ⇒ 目标列为空，**7 期里 7 次一一对应，零反例**。
⇒ 08-26 那期犯的是同一个漏跑（批次 4 历史快照也是后来才补的），说明这是**反复出现的缺口**。
⇒ 08-15 的「探索」列空是**另一个成因**（`内容热度` 字段当时整列为空，公式第二条件直接返回空），不属于本次这一条。

## 本期「待数据」的 5 行是什么（逐行重算，`field-alignment.txt` §D）

公式分支落点：否 249 行（搜索非高/交易非中高）＋ 否 46 行（品牌词）＋ **待数据 5 行**。

5 行全部命中「搜索热度=高 且 交易热度=中、而 `近2周重点达标次数` 为空」这一支：

```
{搜索词: 浴缸,          关键词分类: 大词,   搜索热度: 高, 交易热度: 中, 近2周重点达标次数: "", 判定: 待数据}
{搜索词: 浴缸家用小户型, 关键词分类: 场景词, 搜索热度: 高, 交易热度: 中, 近2周重点达标次数: "", 判定: 待数据}
{搜索词: 浴缸家用成人,   关键词分类: 场景词, 搜索热度: 高, 交易热度: 中, 近2周重点达标次数: "", 判定: 待数据}
{搜索词: 浴缸家用,       关键词分类: 场景词, 搜索热度: 高, 交易热度: 中, 近2周重点达标次数: "", 判定: 待数据}
{搜索词: 亚克力浴缸,     关键词分类: 材质词, 搜索热度: 高, 交易热度: 中, 近2周重点达标次数: "", 判定: 待数据}
```

09-12 那期同样有 6 行命中这一支，但列有值 ⇒ 判「是」。**同一个公式、同一类行，差别只在基数有没有值。**

## 修法（dry-run 验证 → 2026-09-21 已补跑 → 回读通过）

跑 1.6 补这一期：

```
node skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs \
  --base-url https://kcne618basvj.feishu.cn/base/HdBhbttB5aScbasWJAMc0gGXnpe \
  --current-table-id tblZsUns9353w3nl --current-table-name "关键词分析 V1（2026-09-19）" \
  --previous-table-id tblrX0GM7HkVhF85 --previous-table-name "关键词分析 V1（2026-09-12）" \
  --history-table-id tbl7HbH11JsQx6FL --history-table-name "关键词历史总表 V1" \
  --current-batch-number 8 --expected-current-rows 300 --expected-history-rows 2367
```

dry-run 实测（`sync-decision-history-dryrun.txt`，exitCode=0）：

- `historySnapshotsToWrite: 300` —— 历史表批次 8 的 300 行 × 6 字段（重点达标 / A级达标 / 探索达标 / 标准归并词 / 是否重点词 / 优先级）
- `currentCountsToWrite: 300` —— 09-19 分析表 300 行 × 3 字段（上一有效周重点达标 / 探索达标 / A级达标）
- `historyFieldsToUpdate: 1` —— 「本期标记」公式的 batch 从 7 改到 8
- **`pending: 0 / 0`** —— 300 行全部可算，没有一行缺输入；批次 8 已是「有效」故 `historyValidityToWrite: 0`
- `latestBatchNumbers: [7, 8]`、`ignoredBatchNumbers: [2]`（批次 2 = 无效-周期错误，被正确忽略）

⇒ 补跑是干净的 300/300 全覆盖；脚本自带写前 backup、写后回读校验与幂等断言，失败 fail-closed。

### 补跑执行（2026-09-21 22:04，用户授权「1.补跑吧」）

第一次 `--apply`：`APPLIED_AND_VERIFIED`，写前备份 `runtime/keyword-analysis-backups/decision-history-before-20260921T140429Z.json`；
`historyRecordsWritten: 300`、`currentRecordsWritten: 300`、`historyFieldsUpdated: 1`（本期标记 7→8）。
输出＝`sync-decision-history-apply.txt`，回执＝`sync-decision-history-apply-receipt.json`。

回读发现**第二处问题**：历史表批次 8 的 `是否重点词` 快照是 `否×295 待数据×5`，与源表现值（`否×296 是×4`）不一致。
成因：脚本先写历史快照（`sync-decision-history.mjs:1032`）再写当期基数（`:1033`），快照采的是**基数生效前**的源表读数；
而脚本的幂等断言只比「它计划写的那些字段」，照不到这种「随公式变动的纯快照列」。

第二次 `--recalculate-existing-snapshots --apply`：只修这 5 格。
`historySnapshotsToWrite: 5`（只有 `是否重点词`）、`currentCountsToWrite: 0`，`APPLIED_AND_VERIFIED`，`historyRecordsWritten: 5`。
输出＝`sync-decision-history-recalc-apply.txt`，回执＝`sync-decision-history-recalc-receipt.json`。

### 最终回读（换一套独立实现，`verify-after-apply.txt`）

| 位置 | 结果 |
| --- | --- |
| 09-19 表 三个「上一有效周*达标」 | 300/300 · 300/300 · 300/300 |
| 09-19 表 三个「近2周…达标次数」 | 全 300/300（重点 `0×293 2×4 1×3`；探索 `0×282 2×13 1×5`；A级 `0×300`） |
| 09-19 表 `是否重点词` | `否×296` + **`是×4`**（`待数据` 已消失） |
| 历史表 批次 8 | `本期标记` **是×300**；6 个快照字段全 300/300；`是否重点词` `否×296 是×4` |
| 历史表行数 | 2367（未变） |
| 批次 1–7 | 逐一比对，未被改动 |

两个回执文件（脚本自产）与两份回读产物都在本目录，可逐项对照。

## 产物清单（全部只发 GET）

| 文件 | 内容 |
| --- | --- |
| `audit.txt` | 7 张「关键词分析」表的字段定义 + 目标列/上游列填充统计（第一版，按字段名索引） |
| `field-alignment.txt` | 修正版：每表全部字段（含重名）、公式引用字段还原、基数项填充分布、09-19 逐行重算 |
| `history-batch-state.txt` | 历史总表按批次分组：批次有效性 / 本期标记 / 三个快照字段 / 可视化快照 |
| `sync-decision-history-dryrun.txt` | 1.6 补跑的 dry-run 输出（零写入） |

脚本（已随证据一起归档到本目录，不再只留在 `tmp/`）：`keyword-columns-audit-2026-09-21.mjs`、`keyword-field-alignment-v2-2026-09-21.mjs`、`history-batch-state-2026-09-21.mjs`、`run-sync-decision-history-dryrun-2026-09-21.mjs`、`run-sync-decision-history-apply-2026-09-21.mjs`、`run-sync-decision-history-recalc-dryrun-2026-09-21.mjs`、`run-sync-decision-history-recalc-apply-2026-09-21.mjs`、`verify-after-apply-2026-09-21.mjs`

## 审计过程中踩到并修掉的坑

**`records.fields` 的 key 是字段名，不是 field_id。** 第一版脚本（`field-alignment.txt` 的初稿）用 `record.fields[field_id]` 取数，全部取到 `undefined`，于是把 09-19 逐行重算成了「300 行全部落到 内容热度空」——**一个完全虚假的结论**。改用字段名索引后才是本文的正确结果（249 + 46 + 5 = 300）。凡是读飞书记录，一律按**字段名**索引；`fields` 接口返回的 key 才是 `field_id`。

## 边界

本目录下所有脚本只发 GET，**未对飞书做任何写入**。1.6 的 dry-run 也**未写入**（`!apply` 分支直接 return）。
