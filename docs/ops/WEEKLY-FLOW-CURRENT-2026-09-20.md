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
要真正做到「跑一次就对」，还差两件：① 把它挂进排期（`runtime/round-schedule.json` 目前没有关键词周更这一条）；
② 排期前先按 `scheduler-wiring-needs-registered-capability` 确认调度器认得这个能力标识。

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
