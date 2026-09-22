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

配额用尽（该账号是免费档，每天 10 次）时抛确定性 code `USAGE_LIMIT_REACHED`：运行时侧映射成**单列**的失败分类 `USAGE_LIMIT_REACHED`（`retryAutomatically:false` ⇒ 当天收工、不会每 15 分钟白重试），CLI 侧退出码 2 且保留本次页签。此前它没有 code，会落到兜底分类 `BUG` → `STOP_AND_ALERT`（把「平台按套餐拒绝了」报成「疑似代码缺陷、停线」）。2026-09-21 修，证据＝`evidence/huitun-usage-limit-fix-2026-09-21/`（端到端复核 + 突变）+ `evidence/usage-limit-class-and-lock-isolation-2026-09-21/`（分类单列 + 测试隔离）[核]
注意首轮把它并进了 `POLICY_DENIED`（动作相同），**本轮改为单列一类**：那一类的告警标题是「配置或授权不对，已拒绝执行」，会把运营指去查配置，而这里该做的是等额度重置或升级套餐 —— 这条链的触发条件是 `优先级=A候选`，肯定会跑到额度墙。分类口径表＝`docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md` §4

### 1.6 决策历史同步：独立段（第二个发布单元）

`skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`，默认 dry-run；把已达标批次快照进历史并回写三个 `上一有效周...达标` 输入（依据：sync-decision-history.mjs 的 `classifyHistoryBatches` / `planVerifiedBatchPromotion`）[核]

**这一步没跑的后果（2026-09-21 实测，不是推断）**：本期三个 `近2周…达标次数` 列整列为空 —— 那三列的公式是「上一有效周X达标（基数）+ 本期增量」，基数空则公式第一层 `ISBLANK` 直接返回空；同时 `是否重点词` 会在「搜索热度=高 且 交易热度∈{中,高}」的行上落 `待数据`。09-19 期（批次 8）就是这样：三列 0/300、`是否重点词` 待数据×5；历史侧批次 8 的 6 个快照字段同样全空、`本期标记` 仍指向批次 7。
08-26 期（批次 4）漏过同一步。⇒ 这一步**目前没有任何东西兜住「跑没跑」**。
为什么没有：`adapter.feishu-weekly.mjs:10-15` 把「克隆 + 导入」定为第一个发布单元，明确把它排除在同一次 publish 之外（依赖非确定性外部结算），并声明 CLI 仍是**人工运维入口、未被替代**。
补跑命令与前后回读数字＝`evidence/keyword-weekly-columns-audit-2026-09-21/README.md`（2026-09-21 已补跑：源表三列 300/300、历史批次 8 快照 300/300，且未改动批次 1–7）。

**2026-09-21 变更：这一步已被接进本地分析入口**（`runtime/run-keyword-weekly-local-analysis.mjs` 的第三段，见 §3.4）。
用法＝那条命令加 `--history-table-name` ＋ `--previous-table-name` ＋ `--expected-history-rows`（真写再加 `--confirm-history-table`）。
它先只读问「缺不缺」，缺才写；已同步整段零写入（09-19 期实测 `ALREADY_SYNCED`）。

**这一步天然要写两遍（2026-09-21 实测，不是推断）**：`sync-decision-history.mjs` 的写入顺序是「先写历史快照（`:1032`）、后写本期基数（`:1033`）」，
而历史快照里的 `是否重点词` 读的是 `近2周重点达标次数` —— 基数还没写进去时它是 `待数据`。
于是第一遍快照进历史表的 `是否重点词` 必然是中间态（09-19 期实测：历史表 `否×295 待数据×5`，而源表现值 `否×296 是×4`），
要靠第二遍 `--recalculate-existing-snapshots` 补（它只改不一致的格；09-19 期写了 5 格）。
入口把这件事也收进了同一条命令：写完回读比对，不一致才跑第二遍。取证＝`evidence/keyword-weekly-tail-entry-2026-09-21/`。

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

### 3.4 关键词链的 1.6（决策历史同步）：承接者已有，但**只在带参数时生效，且仍没进排期**

2026-09-21 之前的结论是「没有承接者，靠人记得跑」。2026-09-21 起这句话只对了一半：
`sync-decision-history.mjs` 已被接进 `runtime/run-keyword-weekly-local-analysis.mjs` 的**第三段**，
一次调用跑完「规则段 → 内容热度 → 决策历史同步」，并且自带「先只读问缺不缺 / 写完自己回读 / 不一致自动补第二遍」。
（依据：该文件头用法与 `runDecisionHistoryStage`；真机只读取证＝`evidence/keyword-weekly-tail-entry-2026-09-21/`）[核]

**但仍然会缺，因为它是 opt-in 的**：不给 `--history-table-name` 就与从前逐字相同（只跑前两段），
只是会在尾部打一句「这一跳没跑会缺什么、怎么补」。所以「本期基数有没有回写」这件事，
现在取决于**调用者有没有带参数**，而不是取决于有没有人记得另跑一条命令 —— 这是进步，不是终点。
要真正做到「跑一次就对」，还差两件：① 把它挂进排期（`runtime/round-schedule.json` 原本没有关键词周更这一条；
**2026-09-22 补上了前半段**，见 §9.7 —— 但那条排期覆盖的是 `sycm.feishu.weekly` 的**采集 + 第一发布单元**
（§1.1~1.3），**本节这个 1.6 仍然不在排期里**：它跟着本地分析段走，而本地分析段还不是一个已登记能力）；
② 排期前先按 `scheduler-wiring-needs-registered-capability` 确认调度器认得这个能力标识（已确认，见 §9.7）。

后果不是报错，而是**静默的空**：本期三个 `近2周…达标次数` 整列为空、`是否重点词` 出现 `待数据`，同时历史表对应批次的 6 个快照字段也一起空着。
已实测漏过两次：08-26 期（批次 4）、09-19 期（批次 8）。这是同一个病的第三例（前两例是 §3.1 / §3.2）。
（依据：`evidence/keyword-weekly-columns-audit-2026-09-21/`）[核]

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

---

## 七、2026-09-21 跨期实测：竞品链「跑到哪一步了」

背景：多份文档对同一批字段记了互相矛盾的数字（见 §六），所以这轮**不采信任一份文档**，直接写只读探针发 GET 实测。

探针与产物（都只发 GET，未写任何东西）：
- `D:/Retire/probe-live/competitor-weekly-state.mjs` → `competitor-weekly-state.txt`（单期明细：字段类型 + 有值率）
- `D:/Retire/probe-live/weekly-tables-across-periods.mjs` → `weekly-tables-across-periods.txt`（四期周表 + SKU 周表跨期对比）

### 7.1 四期竞品周表跨期对比（关键结论：本期是四期里唯一写满的一期）

| 期 | 字段数 | 行数 | 搜索关键词 | 尺寸 | 适用空间 | 五列属性 | 数据状态 | 商品ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 08-23~08-29 | 39 | 1461 | 100% | Lookup(19) **0.8%** | Lookup(19) **0.8%** | **54.1%** | Formula(20) 98.4% | 100% |
| 08-30~09-05 | 35 | 1423 | **0%** | **缺字段** | **缺字段** | **0%** | 缺字段 | **0%** |
| 09-06~09-12 | 35 | 1462 | **0%** | **缺字段** | **缺字段** | **0%** | 缺字段 | **0%** |
| 09-13~09-19 | 39 | 1417 | 100% | **Text 100%** | **Text 100%** | **100%** | Text 98.4% | **100%** |

⇒ **08-30 与 09-06 两期才是真正什么都没写进去的**（除公式列外全 0）；09-13~09-19 这期 12 个关键字段里 **12 个都满了**（11 个 100%、`数据状态`/`待补数据项` 98.4%），
`商品ID` 那一列当时是 0%，已由 **2026-09-21 的补写补到 1417/1417 = 100%**（2026-09-22 复核，见 §八）。
⇒ 「竞品链跑不通」这个说法与本表不符：采集→导入→属性写回→分类→发布这一段**本期通**，卡住的是末端（见 7.3）。

### 7.2 主表 / SKU 明细 / SKU 周表（实测类型与有值率）

- 竞品主表 `tblkYcczxBnW4v5G`（36 字段 / 2004 行）：`尺寸`、`适用空间` **仍是 Lookup raw_type=19，只有 15/2004（0.7%）**；`数据状态`、`待补数据项` **仍是 Formula raw_type=20**；`搜索关键词` 100%；`商品ID` **2004/2004（100%）**（2026-09-21 补写后；2026-09-22 复核，见 §八）。
- SKU明细 `tbl3N48H4znz304T`（17 字段 / 830 行）：`适用空间`、`竞品分类`、`商品ID` 全 100%；`尺寸`、`搜索关键词`、五列属性全 0%（**该表本来就不承担这些列**）。
- **SKU 周表全 base 只有 1 张**：`SKU周_2026-08-23_2026-08-29 tblTgQo1OtQMDA4X`（23 字段 / 734 行，`SKU唯一键`/`商品ID`/`适用空间`/`竞品分类` 全 100%）。⇒ 本期 SKU 周表**从未创建**，与 `runtime/sku-weekly-storage-decision-20260825.md` 的「每周新建一张」不符。

### 7.3 竞品链真正断在哪（按因果强度）

1. **第 6 步 SKU 富化的硬阻塞＝买家号登录态**。`evidence/sku-step6-2026-09-20/preflight-01.txt`：`STALLED` exit 3，商品页被重定向到 `login.taobao.com/havanaone/`（普通登录墙，无风控字样），密码库无该账号凭据 ⇒ 只能人扫码。且 2026-09-21 盘点（`D:/Retire/probe-live/inventory-2026-09-21.txt`）显示**竞品链浏览器整缺**（`9222=free`、`3457` 连不上）。
2. **主表 `尺寸`/`适用空间` 仍是 Lookup(19)、0.7%**。这是平台枷锁（开放 API 建不了/改不了 Lookup 联接），不是脚本写错；本期用「周表改 Text 写满」绕行，解决了「数据在不在」，**没解决「能不能流进主表那一列」** ⇒ 第 6 步产物的落点仍不完整。
   > **2026-09-22 晚更正**：本条把两件事混了。①「API 建不了 Lookup」只适用于**新建的表**（周表），不适用于主表现存那两列；
   > ② 主表那两列实测**正常工作**，0.7% 的来源是「全库只采过 14 个商品」。见 §8.7。
3. **这条链没有单一编排入口**（§2.1 结论不变）：八步仍靠人按文档顺序逐个跑 `runtime/*.mjs`。
4. **agent 层不在任何门禁里**：`scripts/run-test-suite.mjs` 的 `listTestFiles('runtime')` 非递归 ⇒ `runtime/supervisor-agent/*.test.mjs` 与 `runtime/supervisor-agent/proposal/*.test.mjs` 一条都不会被跑。

### 7.4 本轮更正的三条文档记录（都以代码/实测为准）

| 旧记录 | 位置 | 实测事实 |
| --- | --- | --- |
| 第 2 步「`竞品周_09-13` 35 字段」 | `WEEKLY-SUPERVISION-...md:22` | **39 字段**（探针实测） |
| 第 4 步「STILL MISSING (4): 尺寸, 适用空间, 数据状态, 待补数据项」 | 同上 `:24` | 周表这 4 列**已在场且为 Text**（09-13 期全 100%/98.4%）；`create-weekly-formula-fields.mjs` 的 dry-run 是对**主表**（那里才是 Lookup） |
| P1-2「周表与历史总表的 `搜索关键词` 全空 —— 未修」 | 同上 `:79` 附近 | **1417/1417 100%**，已由 `runtime/fill-weekly-attribute-labels.mjs` 写满 ⇒ 该行已过时 |
| `sync-latest-ab-to-main-core.mjs` fail-closed 在 `:73` | `WEEKLY-RUN-...-FINDINGS.md:16` | 实际在 `:79`；且其读的源是**最新竞品周表**（`sync-latest-ab-to-main.mjs:55` 的 `latestWeeklyTable(tables,'竞品')`，`historyTableId` 未给时的默认）⇒ 命名叫 `historyRecords` 是历史遗留 |
| 「`run-xws-sku-dry-run.mjs` 的 `TARGET` 写死旧租户 base/表 id」 | 同上 §2 | **已参数化**（该文件 `:21-27` 已改为从 `feishu-targets.mjs` 读 `competitorBaseToken`/`tableId`） |

⇒ **A/B 同步那道 fail-closed 本期是通的**（周表 `搜索关键词` 100%），不再构成阻塞。§3.2「第 7 步产物无消费者」的结论仍然成立（Lookup 建不了 + SKU 周表本周不存在），本轮实测只是把它从「推断」升格为「实测」。

---

## 八、2026-09-22 复核：只读实测

背景：§七 之后又有两批改动落地（09-21 的 `商品ID` 补写、09-21 把 1.6 接进本地分析入口），
所以 §7.1 / §7.2 里几个数字已经过时。这轮不采信任一版记录，直接用项目里既有的只读探针重测一次。

探针（全部只发 GET，未写飞书、未启停任何进程）与全部产物：`evidence/weekly-status-2026-09-22/`。

### 8.1 对 §七 的两处更正

| §七 原写法 | 2026-09-22 实测 |
| --- | --- |
| §7.1 表格：09-13 期 `商品ID` **0%** | **1417/1417 = 100%** |
| §7.2：主表 `商品ID` 1461/2004（**72.9%**） | **2004/2004 = 100%** |

两处都是 2026-09-21 那次补写的效果，不是新问题。

### 8.2 关键词段：1.6 那次接线确实落地了

`关键词分析 V1（2026-09-19）`（300 行）：

- 三个 `上一有效周…达标` **300/300**；三个 `近2周…达标次数` **300/300**；`是否重点词` 否(296) 是(4)
- `内容热度` 300/300（中200 低60 高40）
- **仍缺**：`灰豚话题浏览量` 1/300（长期未跑）、`已有有效批次数` 0/300（上一期也是 0/300 ⇒ 不是本期才缺）

⇒ §1.6 那句「这一步没跑的后果」**对 09-19 期已经不成立了**（已被补回），
但 §3.4 的结论仍然成立：它是 opt-in，而且没进排期。

### 8.3 竞品段：断点仍是第 6 / 第 7 步

> **2026-09-22 晚更正**：本节对第 6 步的判断**已被 §8.5 的真跑推翻**（那是只读复核，今天改成真跑了）。
> 保留原文是为了留下「只读复核会得出什么结论」的对照；现行结论看 §8.5。

- 第 6 步 SKU 富化：**全 base 只有 1 张 SKU 周表**（`SKU周_2026-08-23_2026-08-29`，734 行），09-13 期**从未创建** ⇒ 第 8 段对本期没跑。
- 第 7 步落点：主表 `尺寸`/`适用空间` 仍是 Lookup、**15/2004 = 0.7%**（同 §7.2，未变）。
- 问题库：只有 2 张（08-23 期、09-13 期），中间两期缺。**未取证，不给原因。**
- 竞品历史总表：5763 行 / 4 个周期（08-23、08-30、09-06、09-13 起），`批次有效性` **全标「有效」**。

### 8.4 顺手修掉的两处悬空/错位引用（2026-09-22）

本节第一次落笔时，本文件里有两条引用是坏的，一并修掉了：

| 位置 | 原来写 | 改成 | 为什么 |
| --- | --- | --- | --- |
| §七 开头 | 「见 §八」 | 「见 §六」 | §七 在 09-21 落笔时本文件里**没有 §八**（原文到 §7.4 结束）⇒ 悬空引用。它想指的内容是「多份文档记了互相矛盾的数字」，而那是 §六「文档与实现不一致清单」。 |
| §7.1 结论句 / §7.2 表格 | 「见 §九」 | 「见 §八」 | 这两条是我在 09-22 加的复核指向，当时把新增章节编成了 §八、引用却写成了 §九 ⇒ 自己和自己对不上。 |

教训很小但值得记：**章节号是引用的一半**，加一节就顺手把所有指向它的引用改到位，
否则下一个人会以为「§九」真的存在，或者把 §八 当成那句引用所指的内容。

### 8.5 竞品段第 6 步：阻塞已解除（2026-09-22 真跑，不是只读）

§8.3 那句「断点仍是第 6 步」今天被一次**真跑**推翻了。全程留证在 `evidence/sku-step6-2026-09-22/`：

| 段 | 做什么 | 结果 |
| --- | --- | --- |
| 0 | 在买家浏览器（9222，代理 3457）后台打开商品页 921092099640 | 打开成功，标题是真实商品名，**无登录重定向** |
| 1 | `xws-sku-auth-preflight.mjs` | **AUTH_READY / exit 0**（`pluginPresent=true`、`skuControlPresent=true`）|
| 2 | 真实鼠标点 `#xws-copy` 里文本恰为 `SKU` 的项 → `capture-xws-sku-payload.mjs` | 页面出现可见「已复制」；payload sha256 `1ada52ee…`、1331 字节 |
| 3 | `collect-live-xws-sku-topology.mjs` | 2 个属性 / **96 个有效组合** |
| 4 | `run-xws-sku-dry-run.mjs` | `DRY_RUN_READY`，**`toCreate 0` / `alreadyPresent 96` / `conflict 0` / 重复键 0** |
| 5 | apply | **没跑，也不需要跑**：没有新行可写 |

两个结论要分开记，别合成一句：

1. **链路通了**（第 1–4 段全绿，含一次真实剪贴板采集）。推翻的是「第 6 步被登录态卡住」这个**阻塞判断**——
   卡了两天的那一关（买家号登录 + 商品页在位）现在过去了。
2. **本期没有待采的东西**：`summarize-xws-sku-queue.mjs --weekly` 报本期（09-13~09-19）`ab 1 / ready 1 / pending 0`。
   那唯一的 A/B 商品 921092099640 的 96 行早在 09-16 就写进去了，所以 `toCreate=0` 是**正确结果**，不是失败。
   它顺带把幂等现场证明了：96 个唯一键全部 `alreadyPresent`、0 重复、0 冲突。

**仍然成立的**（§8.3 的另外两半，今天没动）：

- SKU 周表 09-13 期**仍未创建**（全 base 只有 `SKU周_2026-08-23_2026-08-29`）⇒ 第 8 段（周快照）对本期仍没跑。
- 第 7 步落点：主表 `尺寸`/`适用空间` 仍是 Lookup、0.7%。今天新增一条事实：`SKU明细` 830 行里已有
  **14 个商品**带尺寸数据 ⇒ 缺口不在采集侧，在写回/联接键那一侧（同 §7 的分析）。
  > **2026-09-22 晚更正：这句归因错了。** 实测 Lookup 是通的，14/2004 的真正来源是「全库只采过 14 个商品」。
  > 见 §8.7。

### 8.6 排期这一侧的实测与一处更正（2026-09-22，只读）

`round-runner.mjs --show-plan` 的原始输出见 `evidence/sku-step6-2026-09-22/08-schedule-plan.txt`。
两条事实：

1. `round-schedule.json` 里**只有一条**排期（`weekly-competitor`，`enabled:false`）。
   **关键词周更要的条目根本不存在** ⇒ §3.4 的「没进排期」是**事实，不是推测**。
   **（2026-09-22 晚更正）** 那条排期已改名改述为 `weekly-keyword` 并声明了 `collectInputResolver`
   ⇒ 它现在**就是**关键词周更、且入参能在运行时算出来（见 §9.7），本条第二句已不成立。
   `enabled` 仍是 `false`；下面那段「竞品周更没有自己的能力」的结论**不变**。
2. 对 §3.4 与 `round-schedule.json` notes 里那句「就算填了 URL 也跑不起来」作一处**精确化**：
   `round-runner.mjs:949` 是**会读**排期条目里的 `collectInput` 的（`publishInput` 在 `:968`）。
   机制在，缺的是**按名解析每周入参**（源周表 id、批次号、克隆前历史行数每周都变）。
   现在只能靠人每周去 JSON 里手改 —— 那不是「跑不起来」，是「跑起来要靠人记得改」，
   而且是**静默的**：改漏了不报错，只会写错周期。两者要修的东西完全不同，别混。
   **（2026-09-22 晚更正）这条缺口补上了**：`runtime/weekly-round-input.mjs` 现在会按周期算出
   `collectionDate` / 本期与上一期表名，并按名解析源周表 id / 历史总表 / 编号库 / 受保护表，
   再读历史表算出批次号与克隆前历史行数 —— 见 §9.7（含只读实测：算出的值与 09-19 期人工手抄的逐项吻合）。

现状能力登记（`skills/*/manifest.json` 的 `name`，今天用登记表复核）：
`sycm.search-rank.export`、`sycm.feishu.weekly`、`xws.feishu.import`、`xws.market-analysis.collect`、
`xws.sku.collection`、`xws.faq.raw-collect`、`xws.faq.product-collect`、`huitun.keyword-heat.collect`
—— **竞品周更没有自己的能力**（同 §3.4，今天以登记表为准复核过）。

### 8.7 更正 §7.3 与 §8.5 对「主表 Lookup 0.7%」的归因（2026-09-22 晚，只读实测）

§7.3 第 2 条与 §8.5 最后一段都把 0.7% 归因成「平台枷锁 / 写回与联接键那一侧没接上」。**这个归因是错的**，
本轮把 Lookup 的 formula 直接读出来之后可以下结论：那两列在**正常工作**，0.7% 的真正来源是**分母**。

探针（只发 GET，不写飞书、不启停任何进程）：`tmp/_probe-lookup-coverage-v2.mjs`；
产物 `tmp/_probe-lookup-coverage-v2.json`。读了三样东西：主表字段定义、SKU明细字段定义、两张表的全部记录。

1. **主表 `尺寸` / `适用空间` 的 Lookup 定义（读 `GET /tables/tblkYcczxBnW4v5G/fields` 的 property.formula）**：

   ```
   bitable::$table[tbl3N48H4znz304T]
     .FILTER(CurrentValue.$column[fld5fPwTIG] = bitable::$table[tblkYcczxBnW4v5G].$field[fldrsnjSju])
     .$column[fldMjPnCtC].LISTCOMBINE().UNIQUE()
   ```

   按字段 id 映射回列名：源表 `tbl3N48H4znz304T` = **SKU明细**；
   过滤条件是 **SKU明细.商品标题 = 主表.商品标题**；取值列是 **SKU明细.SKU尺寸**
   （`适用空间` 同形，取 SKU明细.适用空间）。
   ⇒ 它是「按商品标题把 SKU明细 里那一行的尺寸拉过来」，**不是断的**。
   ⚠️ 顺带记一条脆弱点：联接键是**商品标题**，不是商品 ID。标题一改（多一个后缀、空格、emoji），
   这一行的尺寸就会掉 —— 这是以后「明明采过却看不到」的第一嫌疑，别再去怀疑 Lookup 没接上。

2. **两个数字（同一时刻实测）**：

   | | 行数 | 有值行 | 涉及商品数 |
   | --- | --- | --- | --- |
   | SKU明细 `tbl3N48H4znz304T` | 830 | `SKU尺寸` 830/830、`尺寸汇总` 830/830 | **14 个商品** |
   | 竞品主表 `tblkYcczxBnW4v5G` | 2004 | `尺寸` 15、`适用空间` 15 | 15 个商品 |

   交叉核对：主表那 15 行里，**14 个**的商品 ID 正好就是 SKU明细 的 14 个商品。
   ⇒ 这 14 个不是「Lookup 没拉过来」，是「**本来就只采过这 14 个商品的 SKU**」。

3. **所以真正的瓶颈在 §8.5 的第 8 段（C6 的覆盖面），不在第 7 步（C4 的落点）**：
   2004 个商品里只有 14 个采过 SKU ⇒ 主表那两列的上限就是 14/2004 ≈ 0.7%。
   要让运营在飞书看到的尺寸列变满，要动的是「每期多采多少商品的 SKU」，不是去修 Lookup。

**同一轮更正的第二处**：§七、§八 里反复出现的「开放 API 建不了 Lookup(19)」是**真的**，
但它的适用面只是「用 API 在**新建的表**上创建 Lookup」（`create-weekly-formula-fields.mjs` 三变体实测全 99992402）。
主表现存那两列是更早时候**在飞书界面上建的**，一直可用。两句不要混：一句说「建不了新的」，一句被误读成「现有的坏了」。

---

## 九、2026-09-22 对齐记录：用户口径 + 施工顺序

以下四条是**用户本人拍板的**，与本文档其它章节冲突时**以本节为准**。

### 9.1 最终目的（以后所有取舍的判据）

用户原话：「我的最终目的就是系统可以定时自动跑周报流程，然后运营就可以直接去飞书查看相关数据，
而不需要在意中间的过程，如果出现问题，业务人员也可以自己解决，比如像登录这种问题。」

⇒ 判据是三条：① 定时自动跑完整周报；② 运营只去飞书看结果、不关心中间过程；③ 出问题**业务人员能自救**。
⇒ 于是「要人」的地方必须分两类读：
**业务人员能自己解决的**（登录、扫码、在飞书里领某个模块权限）＝可以保留人工，但**告警必须写成他照着能做完的动作**；
**只有开发能解决的**（接线缺失、没有编排入口、参数要人手改）＝必须消灭。
机制上限见 `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md`。

### 9.2 更正：登录**不是**「必然要人」，商家侧已经自动化（用户指出，代码复核成立）

用户原话：「登录我前几天都是可以做到自动登录的，只要每个店铺隔离开，保存了相对应的登录信息，日报那边是做到了自动化。」

复核结论：**成立**。现役实现＝`skills/sycm-alimama-daily-report/scripts/login-merchant.mjs`
（纯逻辑在 `login-merchant-core.mjs`），三处硬事实：

- **凭据不经过我们**：来自浏览器自己的密码库（`<profile>/Default/Login Data` 的 logins 表，列名 `password_value`）。
  脚本只驱动浏览器自己的自动填充，**不读、不写、不传密码**。
- **每店隔离是前提**：`runtime/browser-ports.mjs:123` `SHOP_BROWSERS` 给五家店各一份 profile
  （`D:/Retire/edge-profiles/<名>`）＋ 独立调试端口 ＋ 独立代理端口。一个 profile 只能是一个淘宝身份。
- **判据是「补一次可信手势之后回读有值」**，不是 `:autofill`（预览态与落地态都为 true，不能当判据）。
- fail-closed 三态：`NO_SAVED_CREDENTIAL` / `CAPTCHA_REQUIRED` / `LOGIN_NOT_CONFIRMED`；
  需要人时复用 `runtime/notify-feishu.mjs` 发飞书，口径 `--notify auto`（只有真试过且没成才叫人）。
- 附带一条纪律：**告警里不给 http 链接**（点链接走系统默认浏览器，到不了目标 profile 的 Edge 实例）。

**所以本文档其它地方把「登录」列为硬阻塞的写法，只在一种情况下才对：那份 profile 的密码库里没有该账号的凭据。**
**竞品段（买家号，`9222` / `D:/Retire/edge-debug-profile`）目前属于这种情况** ——
`SITES` 只登记了 `sycm` 与阿里妈妈两个**商家**站点，没有买家站点，所以竞品段仍然是「cookie 过期就要人」。
补齐方式是**复用已有机制**（把买家号凭据存进那个 profile 的密码库 + 照商家那套判据做一遍），不是新造一套。

### 9.3 K5 → K8：AI 字段改由本地分析产生，再传回飞书（用户口径）

用户原话：「转换成我们分析完再上传到飞书，可以在 WorkBuddy 或者接入 LLM 的 key 去做分析。」

现役两半都已在仓库里，缺的是**中间那一段组装**：

- 生产端：`runtime/run-weekly-local-analysis.mjs`（入口）＋ `runtime/weekly-local-analysis.mjs`（core）。
  它按 provider（`cc` / `codex` / `workbuddy`）算 `ANALYSIS_REGISTRY` 里两个 `owner:'llm'` 的字段
  （`内容热度`、`对应产品方向`，各带提示词），产出 status **`PUBLISH_READY`** 的 `analysis-artifact.json`。
- 消费端：`skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs --publish-artifact <那份 artifact>`
  （校验 `status==='PUBLISH_READY'` + `publishPlan` + `evidence{source,providerDigest,promptDigest}`，然后写回飞书）。
- **缺口＝输入组装**。`run-weekly-pre-ai.mjs:197-210` 落的是
  `{collectionDate, batchNumber, category, sourceRows, target:{appToken, sourceTableId, sourceTableName,
  newTableName, historyTableId, libraryTableId}}`；
  而 `run-weekly-local-analysis.mjs` 要的是
  `{appToken, currentTable{tableId,tableName,recordCount}, fields[], records[], historyRecords[],
  historyTable{}, libraryTable{}, libraryRecords[], collectionDate, batchNumber, sourceEvidence, huitunResults?}`。
  两者的**行来源根本不同**：前者是导出 CSV 的行，后者是**飞书当前周表里的记录**（带 `record_id`）。
  ⇒ 顺序上**必须先 K4 导入、再从飞书读回来**，本地分析要插在 K4 之后、发布器之前。
- 形状模板（**旧租户**时期的实物，只当形状参考，值不要用）：
  `runtime/weekly-runs/2026-08-26/pre-ai-20260827T110840Z/enriched-input-three-tables.json`
  （顶层键：`appToken / currentTable / fields / records / historyRecords / historyTable / libraryTable /
  libraryRecords / collectionDate / batchNumber / sourceEvidence`）。那一期是靠人手工拼这份东西跑通的。

### 9.4 已定的两处口径（不再重复确认）

- **C6 覆盖面＝本期 A/B 候选全采**（用户：「这个之前已经跟你对过确定了的」）。现在全库只采过 14 个商品（见 §8.7）。
- **C4 不动**（见 §8.7：Lookup 是通的，瓶颈在 C6 的覆盖面）。

### 9.5 施工顺序（2026-09-22 初版 → 当日被 §9.6 推翻并改序，以 §9.6 为准）

> **这条已经不成立。** 初版把「K8 接线」排在第一位，理由是「K5 是关键词段唯一一处硬性人工闸门」。
> 落地前复核发现**关键词表上根本没有 AI 字段**（见 §9.6），K5 这个闸门不存在，K8 也就不必为它而做。
> 改后的顺序见 §9.6 末段。

### 9.6 落地前复核：K5 不存在，K8 不是第一步（2026-09-22，只读实测）

初版 §9.3 / §9.5 建立在「关键词表里有两个 AI 字段、现在靠人在飞书页面结算」之上。这个前提**错了**。

探针（只发 GET）：`tmp/_probe-keyword-local-fields.mjs` → `tmp/_probe-keyword-local-fields.json`。
对象：关键词库 base `HdBhbttB5aScbasWJAMc0gGXnpe` 的当期表 `关键词分析 V1（2026-09-19）` = `tblZsUns9353w3nl`（300 行）。

**一、那张表上一个 AI 字段都没有。**

| 字段 | type / ui_type | property | 谁在算 | 实测有值 |
| --- | --- | --- | --- | --- |
| `内容热度` | 1 / Text | `null` | **外部写入方＝我们的本地分析** | 300/300 |
| `对应产品方向` | 20 / Formula | 只有 `formatter` + `formula_expression`，**无任何 AI property** | 飞书公式 | 300/300 |
| `优先级` / `是否重点词` / `搜索热度` / `交易热度` / `近2周…达标次数` | 20 / Formula | 同上 | 飞书公式 | 300/300 |

`对应产品方向` 的公式原文（读出来就是它，不是猜的）：

```
IF(ISBLANK(上一有效周重点达标), "",
  IF(上一有效周A级达标 >= 2, "主推方向（已有优势放大）",
    IF(上一有效周探索达标 >= 2, "增长方向（未来新品）",
      IF(上一有效周重点达标 >= 2, "探索方向（验证市场）", "暂无"))))
```

⇒ 它读的是那三个「上一有效周…基数」，**纯粹是公式**，跟 AI 无关。
⇒ `ANALYSIS_REGISTRY` 里把它标成 `owner:'llm'` 是**本地分析设计**侧的口径（那条设计本来要自己算它），
跟飞书表上这一列的现行实现不是一回事。两者不能混读。

**二、`内容热度` 由本地写，已被实测钉死。** 除了「它是 Text + property 为 null」之外，
还有一个精确吻合：`run-keyword-weekly-local-analysis.mjs:189-191` 记载「2026-09-19 期 `细分标签` 290/300 有值，
剩下 10 行本地也判不出」，而本轮实测 `细分标签` 正是 **290/300**。
⇒ 那 5 个 `LOCAL_ANALYSIS_FIELDS`（4 个规则字段 + `内容热度`）确实是本地分析写进去的，且已写满。

**三、`adapter.feishu-weekly.mjs:9-12` 那句「克隆+导入之后还要等飞书 AI 结算」与现行表结构不符。**
现状是：决策类字段已改成公式（对应的是 `runtime/apply-weekly-decision-formulas.mjs` 那批工作，
而 `runtime/retired-keyword-decision-writer.test.mjs` 断言它**已退役**），AI 只剩 `内容热度` 一个、
且已本地化。⇒ K5 在 09-19 期**不存在**；它是一条**过期的设计边界说明**，应当改掉（本轮未改，留给下一步）。

**四、「每周入参按名解析」比 §9.5 说的完成得多。** `run-keyword-weekly-local-analysis.mjs:380-388`
的 `resolveTable(tables, {tableName, tableId})` 已经做「按名解析 + 名字与 id 同时给时必须一致」。
真正还靠人的只剩**这几个数字/名字要手写**：`--collection-date`、`--table-name`、`--previous-table-name`、
`--batch-number`、`--expected-history-rows`。而它们**全部可由周期推导** ⇒ 这一步的边界比原先写的小得多。

**改后的施工顺序（2026-09-22 定，按此推进）：**

1. **关键词段进排期**：把周期（`PREVIOUS_WEEK_SUN_SAT`）推导成上面那几个入参，
   再改 `runtime/round-schedule.json` 现存那条排期（**改名改述，不能新增**，`enabled` 保持 `false`）。
   关键词段每一步都已通，它缺的只是「被叫醒 + 不用人手写参数」。
2. **竞品段编排入口 + 能力登记**：八步合成一条命令（登记表里目前没有竞品周更能力）。这是剩下最大的一块。
3. **买家号凭据入库**：让竞品段也能像商家侧一样自动登录（见 §9.2 末段）。
4. **灰豚段跑满**：当期 `灰豚话题浏览量` 只有 **1/300**，而 `优先级` 的 A 档判定依赖它。
5. ~~K8 接线~~ **降级为可选**：它只在「关键词段收敛到单一发布器」这个架构目标下才需要；
   按用户的目的（定时自动跑、运营看飞书）不做也行，现状的本地入口已直接写飞书。
   要做的话是**独立一批**，不要混进上面四条。

### 9.7 第 1 步落地：关键词周更的「每周入参」解析（2026-09-22，含只读实测）

§9.6 施工顺序第 1 条（「关键词段进排期」）的前置那一半做完了：**把周期算成入参**。
本步**没有真跑过一轮**（那会写飞书），交付的是「排期算得出入参 + 算错就停」。

**改了什么**

| # | 落点 | 说明 |
| --- | --- | --- |
| 1 | `runtime/weekly-round-input.mjs`（新） | 周期 → 入参。纯推导那半（采集日 / 本期与上一期表名 / 按名解析 / 批次号 / 克隆前历史行数）不含任何 I/O，reader 是**注入**的，所以离线可测。 |
| 2 | `runtime/weekly-round-input-reader.mjs`（新） | 凭据与 base 的来源。`baseUrl`/`appToken` 由 profile 推（`feishu-targets.mjs` 是单一事实来源），**不写进排期配置** —— 手写一份就会与 profile 各自漂移。 |
| 3 | `runtime/sop-runtime/round-runner.mjs` | 接线：条目声明 `collectInputResolver` 才解析；**不声明 = 这一层不存在**，行为与从前逐字相同。解析结果与条目里手写的同名键冲突时抛 `COLLECT_INPUT_CONFLICT` 停跑（两份真相源早晚漂移，而漂移不报错）。 |
| 4 | `runtime/round-schedule.json` | 唯一那条排期**改名改述**（`weekly-competitor` → `weekly-keyword`，原名与它实际借用的能力不符），`enabled` 保持 `false`。 |

顺带修掉的三处过期说明（都属「文档没跟上」）：
- `skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs` 顶部那句「克隆 + 导入之后还要等飞书 AI 结算」
  ⇒ 按 §9.6 的实测改写（决策类已是公式，唯一的 AI 字段 `内容热度` 已本地化）。
- `skills/sycm-to-feishu-base/manifest.json` 的 `description` 还写着「依赖飞书 AI 结算的决策历史同步」
  ⇒ 改成「依赖本期分析值（决策类字段是飞书公式、内容热度由本地分析产出）落定」。
  同一个过期前提活在**两处**（适配器注释 + manifest 描述），只改一处就是新的不一致。
- `runtime/run-keyword-weekly-local-analysis.mjs` 的 `FeishuReader` 改为**导出**（复用，不复制第二份飞书客户端）。

**实测：解析出来的值 = 人过去手抄的值**

只读探针 `evidence/weekly-round-input-2026-09-22/probe-resolve-weekly-input.mjs`（只发 GET、不启浏览器、不写飞书）对
09-13~09-19 这个真实周期跑了一遍：

| 项 | 解析结果 | 旁证 |
| --- | --- | --- |
| `collectionDate` | `2026-09-19` | = 周期结束日（该周周六） |
| `sourceTableId`（克隆源 = 上一期） | `tblrX0GM7HkVhF85` | 与 09-19 期人工传的 `--previous-table-id` **逐字相同** |
| 本期表 id | `tblZsUns9353w3nl` | 与 09-19 期人工传的 `--table-id` **逐字相同** |
| `historyTableId` / `libraryTableId` | `tbl7HbH11JsQx6FL` / `tblDEZY8RkwoHLEX` | 按名解析（该 base 共 9 张表） |
| `batchNumber` | `9` | 历史表 2367 行、批次 1~8 齐（09-19 期用的是 8） |
| `expectedHistoryBefore` | `2367` | = 历史表里**非本批次**的行数 |

⇒ 这几个值过去**每周靠人从上一期抄**，抄漏不报错、只写错周期。现在由排期自己算。

**刻意没做：`protectedTableName` 不推导**

它的语义是 `update-weekly-base.mjs:788-789` 那句断言里的 "Protected previous-week analysis table"，
即**上一有效周**的分析表；而「有效」的判据住在 `skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs` 里，
本仓库还没把它提出来。`PHASE-ARCHIVE.md` 里那次演练 weekly=09-12 而 protected=08-29（**两者并不相邻**）
⇒ 它**不是**简单地取上一期。猜错只会让它去保护一张不该保护的表，而那条断言**不会报错** ——
所以按 §9.6 的纪律：推不出来就不猜，改成排期配置里显式给出。

**它是这条排期唯一的待补项。** 补上即可打开 `enabled`；不补则**在解析阶段**就停（这是刻意的）：

```
Error: keyword weekly resolver is missing stable config: protectedTableName
    at resolveKeywordWeeklyCollectInput (runtime/weekly-round-input.mjs:197)
    at resolveDeclaredCollectInput (runtime/sop-runtime/round-runner.mjs:998)
    at optionsForEntry (round-runner.mjs:1006) → main (round-runner.mjs:1209)
```

这条 fail-closed 发生在 `listTables` **之前** ⇒ 不读飞书、不启浏览器、不写任何东西。

**验证跑了什么**（原始输出：`evidence/weekly-round-input-2026-09-22/`）

| 跑的东西 | 结果 | 输出文件 |
| --- | --- | --- |
| `runtime/weekly-round-input.test.mjs` | **23/23/0** | `weekly-round-input-tests.txt` |
| 突变验证（4 个突变） | 逐个点名红 → 还原 → `sha256` 逐字节一致 | `mutation-checks.txt` |
| `skills` 全量 | **786/786/0**（1226.6 秒） | `skills-suite.txt` |
| `runtime` 全量 | **844/844/0** | `runtime-suite.txt` |
| `runtime/sop-runtime/*.test.mjs` | **398/398/0** | `sop-runtime-suite.txt` |
| `skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs` | **23/23/0** | `adapter-feishu-weekly-tests.txt` |
| 真解析一次（只发 GET） | 解析值 = 09-19 期人工手抄值 | `live-resolve-real-period.txt` |
| 真 CLI 缺 stable 项（fail-closed） | EXIT=1，停在解析期、零网络 | `live-fail-closed-missing-stable.txt` |
| 真 CLI 坏 resolver id | EXIT=1，点名 `Unknown collectInputResolver` | `live-fail-closed-unknown-resolver.txt` |

`skills` / `runtime` 两次全量跑在 `manifest.json` 描述那次改写**之前**，而它们覆盖的代码文件此后一字未动；
所以改完单独重跑了覆盖该 manifest 的用例文件（`adapter-feishu-weekly-tests.txt`，23/23）。

**怎么复核这一批**（全部只读或离线）：

```
node --test runtime/weekly-round-input.test.mjs                  # 23 用例全绿
node evidence/weekly-round-input-2026-09-22/mutate-weekly-round-input.mjs   # 改坏→点名红→还原→逐字节一致
node runtime/sop-runtime/round-runner.mjs --schedule-file runtime/round-schedule.json --show-plan
node evidence/weekly-round-input-2026-09-22/probe-resolve-weekly-input.mjs  # 真解析一次（只发 GET）
```

**还没做的部分（明确交接）**：排期目前只到「算得出入参」。真正打开 `enabled` 之前还要
① 补 `protectedTableName`；② 用 `--force` 排练一轮；③ 后段仍未进排期 ——
本地分析段（第一发布单元跑完之后才轮到它）与灰豚段（§9.6 第 4 条，当期 `灰豚话题浏览量` 只有 1/300）；
④ 竞品段仍没有自己的周更能力（§9.6 第 2 条）。
