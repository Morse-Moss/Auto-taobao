# 周报当前全流程（2026-09-20 实机核对）

状态：这是**实测快照**，不是设计意图。口径：周报 = 两段，先关键词收集，后竞品收集。

每条结论后面都带 `（依据：文件:行）`。标 **[核]** 的是我读过代码的；标 **[未核]** 的是按脚本命名或文档推断、没有代码依据的 —— 后者不要拿去当依据用。

**改状态机、发布路径或采集口径之前，先读这份并把它一起改掉。** 这份文档存在的理由：项目里同一件事的记录已经漂成好几份，而跑的时候只认代码。

---

## 一、关键词收集（先跑）

### 1.0 人工前置：把分类点对

导出脚本**只校验、不设置**分类。页面停在别的类目时，`waitForPath('/mc/free/market_rank', { cateId, category })` 永远不成立，表现为「等 market_rank 超时」——一个会被误读成「页面坏了」的假故障。
正确类目：`浴缸/淋浴房` → `浴缸 > 普通浴缸`，`parentCateId=201833101/201833103`、`cateId=50002411`。
（依据：skills/sycm-export-search-rank/scripts/full-flow.mjs 的 `enterSearchRankFromHome`；2026-09-20 实测，见 `evidence/sku-step6-2026-09-20/keyword-export-2026-09-19*.txt`）[核]

### 1.1 COLLECT：导出七天搜索排行，产出可复验工件（无外部写入）

- 入口：`skills/sycm-export-search-rank/scripts/export-search-rank.mjs`，由 `run-weekly-pre-ai.mjs` 以 `--from-home --period 7d --date <结束日>` 调用（依据：run-weekly-pre-ai.mjs:173-178）[核]
- 落 CSV + XLSX 成对，并自校验 rank 连续唯一（依据：export-search-rank.mjs 的 `validateRows`，约 :503-542）[核]
- 源证明：重开 XLSX 要求 `period=7天 / dayCount=7 / endDate=结束日`（依据：source-period-proof.mjs 的 `verifyExportPair`）[核]
- 已知竞态：页大小 10→50 时控件先更新、表格后填满 ⇒ 立即取数会丢 11-50 名，报 `Ranks are not contiguous 1..N`。这是**保护**，重试即可（依据：2026-09-20 实测 run2 失败 / run3 成功；AGENTS.md 也有这条）[核]

### 1.2 本地落盘，停在人工闸门（无外部写入）

- 入口：`run-weekly-pre-ai.mjs`；产出 `input-snapshot.json` + `pre-ai-manifest.json`，`status=LOCAL_INPUT_READY`（依据：run-weekly-pre-ai.mjs:197-257）[核]
- 这里的 `--apply` **只表示写本地清单**，不代表任何飞书写入。不加 `--apply` 直接 `PLAN_ONLY`，连导出都不跑（依据：同文件:142-151）[核]
- `COPY_SCRIPT` / `UPDATE_SCRIPT` 两个常量定义了但**从未被调用**（依据：同文件:22-23）[核]

### 1.3 PUBLISH#1：克隆周表 + 导入本周行（真写飞书）

架构上这是「第一个发布单元」，两件事：克隆上周周表 → 导入本周行 → 回读新表与历史表验收（依据：adapter.feishu-weekly.mjs:6-7）[核]

- 克隆：`copy-weekly-table.mjs` —— 走**浏览器**（商家侧飞书页，读 `window.bitableStore`），仅数据表结构、0 记录，等 base revision 推进才算完成（依据：copy-weekly-table.mjs 的 `duplicateStructure` / `isCopyCloudSettled`）[核]
- 导入：`update-weekly-base.mjs` —— 走**飞书 OpenAPI**；复用或新建编号库、写周表、历史追加批次 N、写前备份、回读幂等校验（依据：update-weekly-base.mjs 的 `main` 全段）[核]
- 谁触发：`adapter.feishu-weekly.mjs`（能力 `sycm.feishu.weekly`）在 publish 路径上以子进程 spawn（依据：adapter.feishu-weekly.mjs:40-41、:437-464）；CLI 仍是人工运维入口，未被替代（依据：同文件:14-15）[核]

**2026-09-20 实跑一次的结果（写给下一个要跑的人）**：

- 克隆段**成功**：新表 `tblZsUns9353w3nl` / `关键词分析 V1（2026-09-19）`，29 字段 / 12 公式 / 300 记录 / 1 视图。字段清单已用 API 正面核对：与源表无缺无多，12 处差异全部只是公式里的自表引用被飞书重写成新表 id（属预期）。
- 导入段**第一次被飞书权限挡住、修好后跑通**：`POST /tables/tblDEZY8RkwoHLEX/records/batch_create 403 91403 Forbidden`。
  已定位到 **base 级**、不是应用 scope、不是表级：同一个应用对**竞品库**与**各店铺日报**两个 base 读写都通（写探针 HTTP 200），只有**关键词库这个 base** 写被拒（4/4 表都是 91403，含新建的空表）。
  处置在飞书侧（把该应用在这张 base 里从「可阅读」改成「可编辑」），**代码一行没改**；改完原样重跑即通过。
- 最终 `APPLIED_AND_VERIFIED`：编号库 475→**494**（+19 个新词）、周表 **300 行**（排名 1-300 连续唯一）、历史 2067→**2367**（批次 8 = 300）；上一张表未动、旧批次改动 0、`采集日期` 无代填。
- 失败时是 fail-closed：第一次写就停，复跑 dry-run 与写入前逐项一致，**无半截数据**。
- 留证：`evidence/keyword-weekly-write-2026-09-20/`（含两次尝试的原始输出、权限探针、独立回读）。
- **同一条链上有两个长得一样的 91403，别混**：这次的 91403 是**真权限**；代码里 `envFile` 默认值指向旧租户那一类是**假故障**（本轮修了 4 处）。分型手法见技能 `feishu-api-permission-triage`。

### 1.4 人工 AI 结算（非确定性，必须单独一个发布单元）

飞书表里的 AI 字段由运营在页面内结算。架构上明确：这一步依赖非确定性外部结算，**不能塞进同一次 publish**（依据：adapter.feishu-weekly.mjs:9-12）[核]

### 1.5 灰豚：独立段

`skills/huitun-to-feishu-keyword-heat`，默认干跑 `--apply --confirm-table` 才写；`AI_REQUIRED`（存在 `优先级=待数据` 的行）即停（依据：该技能 flow.mjs 的失败分类；huitun-candidate-contract.md）[核]

### 1.6 决策历史同步：独立段（第二个发布单元）

`skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`，默认 dry-run；把已达标批次快照进历史并回写三个 `上一有效周...达标` 输入（依据：sync-decision-history.mjs 的 `classifyHistoryBatches` / `planVerifiedBatchPromotion`）[核]

### 1.7 旁路：本地分析（目前是孤岛 —— 见第三节）

`runtime/run-weekly-local-analysis.mjs`，用法 `INPUT_JSON OUTPUT_DIR <cc|codex|workbuddy>`，产出 `analysis-artifact.json`（依据：run-weekly-local-analysis.mjs:53-66）[核]

---

## 二、竞品收集（后跑）

### 2.1 结论：这条链没有单一编排入口

- 唯一的调度器只认 `faq` / `xws` 两流，且只覆盖采集段（依据：runtime/run-flow-orchestrator.mjs:340）[核]
- 排期里的 `weekly-competitor` 条目是 `enabled:false`，条目自述跑不起来，且它的 capability 写的是**关键词链**的 `sycm.feishu.weekly`（依据：runtime/round-schedule.json:22-40）[核]
- ⇒ 现状是人工按顺序逐个跑 `runtime/*.mjs`，顺序依据只在文档（依据：docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:19-28）[核]

### 2.2 八步（顺序来自文档，脚本本身各自独立）[未核顺序]

1. 采集：`runtime/run-weekly-collection.mjs` —— **必须分块**，每段 4 页约 150 行/150 图。理由写在脚本头：卡顿会把结算窗口从 60 分钟砍到 5 分钟，5 分钟内做不出 878 行 + 878 图的 xlsx，那一段就只剩 CSV，图片丢了（依据：run-weekly-collection.mjs:1-18）[核]
2. 建周表：`runtime/prepare-weekly-competitor-table.mjs` [未核]
3. 派生字段：`runtime/create-weekly-formula-fields.mjs` [未核]
4. 导入：`skills/xws-to-feishu-base`（`import-competitor-v2.mjs`）[未核]
5. 规则列回填：`runtime/fill-weekly-attribute-labels.mjs`（旧 `fill-weekly-material-labels.mjs` 已被它取代）[未核]
6. 分类统计：`runtime/tally-weekly-classification.mjs` [未核]
7. SKU 富化：`skills/xws-sku-collection` 五段链（预检 → 抓 payload → 采集拓扑 → dry-run → 应用），中间带人工闸门 [核，本轮踩过]
8. 发布：`runtime/publish-competitor-visualization.mjs` + `runtime/sync-weekly-sku-history.mjs`；`runtime/audit-weekly-sync.mjs` 只读审计 [未核]

---

## 三、当前真正断掉的三处（同一个病：建好了，没接线）

### 3.1 关键词链的本地分析段没有消费者，也没有输入

- `run-weekly-local-analysis.mjs` 要一个 `INPUT_JSON`，里有 `records / fields / currentTable / historyTable / libraryTable / libraryRecords / sourceEvidence`（依据：run-weekly-local-analysis.mjs:30-44）[核]
- `pre-ai` 产出的 `input-snapshot.json` 是**另一个形状**：`sourceRows / target.{appToken,sourceTableId,...}`，没有 `records`、没有 `fields`、没有库记录、没有 sourceEvidence（依据：run-weekly-pre-ai.mjs:197-204）[核]
- **全仓没有任何脚本调用它，也没有任何脚本生成它的输入**（依据：`run-weekly-local-analysis|weekly-local-analysis.mjs` 全仓 grep，命中只剩它自己、它的测试、和 import 其函数的 post-ai 与 analysis-doc 生成器）[核]
- ⇒ 关键词链目前实际走的是 1.2 → 1.3 → 1.4（人工在飞书里跑 AI）→ 1.6。**「本地 provider AI 出 AI 字段」这条路是孤岛**，2026-08-26 那次是手工组装 `enriched-input-three-tables.json` 跑通的（产物仍在 `runtime/weekly-runs/2026-08-26/`）。

### 3.2 竞品链第 7 步的产物没有可到达的消费者

`尺寸/适用空间` 写进哪、谁读：飞书开放 API 建不了 Lookup(type 19)，SKU 周表本周不存在。跑了也是一张暂时没人读的表。（依据：本轮预检与 `docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:136-139`）[核]

### 3.3 两段之间没有数据接口

竞品采集的关键词是 **CLI 参数 `--keyword`，无默认值、不读任何表**；竞品周表的 `搜索关键词` 列由**常量**写入，默认「浴缸」（依据：skills/xws-export-market-analysis/scripts/export-market-analysis.mjs:56、scripts/flow.mjs:138；runtime/fill-weekly-attribute-labels.mjs:11,45,50）[核]

⇒ 用户口径里的「先关键词、后竞品」在人排的顺序上成立，**但在代码里不是一条数据链**。文档自己已经把它记为缺口，并建议「采集段在 merged CSV 补一列固定关键词」（依据：docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:79-83,130-134）[核]

---

## 四、验收判据在哪

| 链 | 判据 | 位置 |
| --- | --- | --- |
| 关键词 | rank 连续唯一 | `export-search-rank.mjs` `validateRows` |
| 关键词 | 七天周期证明 | `source-period-proof.mjs` `verifyExportPair` |
| 关键词 | 字段合同 / 历史累计 / 编号唯一 | `update-weekly-base.mjs` `assertWeeklyFieldContract` / `assertHistoryFieldContract` / `buildLibrarySeed` / `countHistoryBatches` / `planExistingRecords` |
| 关键词 | 计划与回读一致 | `runtime/weekly-local-analysis.mjs` `validatePublishPlan` / `validatePublishReadback` |
| 竞品 | 周表门禁（行数/重复商品ID/周期） | `runtime/competitor-history-publish-core.mjs` `assessCompetitorWeeklyGate` |
| 竞品 | 历史唯一键 | 同文件 `buildHistoryPlan` |

---

## 五、运行时依赖：哪些步骤需要活着的浏览器 / 代理

- 关键词链 1.1（导出）与 1.3 的**克隆段**需要**商家侧**（`19022`/`19023`）；1.3 的**导入段**（`update-weekly-base.mjs` 走飞书 OpenAPI）只需要网络与凭据，**不需要浏览器**。1.5 灰豚同样需要商家侧浏览器。
- 竞品链的采集与 SKU 富化需要**买家侧**（`9222`/`3457`）。
- 测试也有活体依赖，但它被**分在两个套件**里，报数时不要混：
  - `node scripts/run-test-suite.mjs skills`（= 离线技能套件，**54 个文件**）**明确排除**了
    `skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs`
    （依据：scripts/run-test-suite.mjs:40-49 的 `EXCLUSIONS`）。⇒ 这个套件的数**与代理在不在无关**。
  - 活体依赖的那批走 `node scripts/run-test-suite.mjs integration`，其中
    `paste-endpoint.test.mjs` 直连 `127.0.0.1:19023`（`PROJECT_PORTS.dailyReportProxy`），
    代理不在时以 `ECONNREFUSED` 判 **fail**（不是 skip）。

  **掉过的坑（记下来）**：直接对目录跑 `node --test skills/sycm-to-feishu-base/tests/`
  **会带上**那个被排除的活体文件，于是「同一个改动，一个数说全绿、另一个数说 1 红」。
  两个分母不同，不是回归。

2026-09-20 实测记录（同一天内两种状态）：

| 时刻 | 事实 |
| --- | --- |
| 07:59 | 离线技能套件 **714 / 0 fail**（当时 `19023` 是否可用**没有留下同期探活记录**；那 714 里**不含** `paste-endpoint`，所以它证明不了该文件的状态） |
| 09:26 与 09:38 | 复查 15 个端口（`9222` / `3457` / `19022` / `19023` / `19024` / `19031-19035` / `19041-19045`）**全部 DOWN**（`127.0.0.1` 直连探活两次，只读，**未启动任何进程**；留证 `evidence/sku-step6-2026-09-20/port-probe-all-down.txt`） |
| 09:26→09:46 | 离线技能套件 **715 / 0 fail**（54 文件；新增 1 条判据 ⇒ 714+1，且**与端口全 DOWN 无关**，因为活体文件不在这个套件里） |
| 09:46 | `integration` 套件：17 测试 / 8 pass / **1 fail** / 8 skip；那 1 fail 就是 `paste-endpoint.test.mjs`（`ECONNREFUSED 127.0.0.1:19023`，预期内） |
| 09:46 | 单独直跑该文件复现同一条 `ECONNREFUSED` |
| 09:50→10:10 | 补完 `sync-decision-history.mjs` 那处（第 4 处同类修复，+1 条判据）后复跑：离线技能套件 **716 / 0 fail**（54 文件）。**这是本轮最终数。** |

⇒ **「无人值守」仍然不成立**：这套东西活不过发起它的那个会话。这也是为什么「排练全绿 ≠ 真跑能跑」这条纪律要一直挂着 —— 排练时那些页面是热的。

## 六、文档与实现不一致清单

本轮已核对并改正：

- `skills/sycm-to-feishu-base/SKILL.md`：post-ai 的入口与职责（原写 `--pre-ai-manifest`，且声称它内部跑公式/灰豚/历史同步）；`READY_FOR_AI` → `LOCAL_INPUT_READY`；step 9 里同一句旧说法（声称 post-ai 会执行灰豚与历史同步）也已改正
- `README.md`：同上两处
- `docs/project-knowledge.md:46,53`：同上两处
- `skills/huitun-to-feishu-keyword-heat/SKILL.md:103`：原写「被 `run-weekly-post-ai.mjs` 调用、由它接着做历史同步」→ 改为**独立段，无编排器**
- `runtime/huitun-candidate-contract.md:45`：同上
- `docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md:36`：命令 `--pre-ai-manifest` → `--publish-artifact`，并补上「发布器只写三件事」
- `PROJECT-HANDOVER-ANALYSIS.md:140`：去掉「含公式迁移、灰豚回填、历史同步」

**依据（本轮实测）**：`run-weekly-post-ai.mjs` 全文 grep `huitun|灰豚|sync-decision-history` **零命中**；`runPostAiWorkflow`（同文件:187-241）只做 library creates / current updates / history updates + 回读。

同一类缺陷（跨租户凭据默认值）本轮共修 **4 处**，并在 `runtime/arch-boundary.test.mjs` 登记了新增的跨目录依赖：

| 脚本 | 属于哪一段 |
| --- | --- |
| `skills/sycm-to-feishu-base/scripts/run-weekly-pre-ai.mjs` | 1.2 本地落盘 |
| `skills/sycm-to-feishu-base/scripts/update-weekly-base.mjs` | 1.3 导入 |
| `skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs` | 1.4 之后发布 |
| `skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs` | 1.6 决策历史同步 |

四处统一改为 `envFilePath(activeProfileName())`；各配一条**源码级**判据（断言默认值来自访问器 + 源码里不再有写死的 `E:/` 字面量）。突变验证 **6/6** 全部被点名拦住并逐字节还原。

**同一类、但本轮没动的还有 5 个**（都是 `runtime/` 下的一次性/遗留工具，`PROJECT-TECH-DEBT-GOVERNANCE-PLAN.md:95,319` 已把它记为待办）：

- `runtime/apply-weekly-decision-formulas.mjs:33` —— 注意：`runtime/retired-keyword-decision-writer.test.mjs` 断言它是 **RETIRED**，别当成现役
- `runtime/apply-legacy-feishu-writeback.mjs:28`
- `runtime/verify-weekly-decision-formulas-live.mjs:223`
- `runtime/run-legacy-feishu-prompt-analysis.mjs:41`
- `runtime/fix-legacy-content-heat.mjs:9`（整个文件被压成单行）

它们的默认值同样指向旧租户。之所以没跟着改：它们是一次性修复/核验工具、不在周更链上，正确处置（按那份治理计划是「改必填参数 + 环境变量」）需要单独一批，不宜和本轮混在一起。
