# 生意参谋到飞书自动化

项目根目录：本仓库根。**下文所有命令都在仓库根目录下执行，路径一律相对仓库根书写。**
（早先这里写的是本机绝对路径 `D:\Retire\sycm-automation\...`，换一台机器就整段失效 —— 已改掉。）

## 目录

- `skills/sycm-export-search-rank`：生意参谋搜索排行采集、CSV/XLSX 输出与校验。
- `skills/xws-export-market-analysis`：从淘宝首页运行小旺神市场分析，监管慢速采集并校验 CSV/XLSX 竞品数据。
- `skills/xws-to-feishu-base`：提取小旺神 XLSX 内嵌商品图，通过飞书 API 写入授权副本，并维护竞品分类、公式和 AI 提示词合同。
- `skills/xws-sku-collection`：v1.9.0，从真实淘宝商品页点击小旺神 SKU 控件，原子读取 Windows 剪贴板、按商品独立维护 `batch-index.json` 并生成可复现 dry-run，在精确授权后写入飞书 `SKU明细` 与回读验收。
- `skills/xws-faq-operator`：v3.1.0，面向运营的 FAQ 周更总入口，通过自然语言检查状态、断点续跑并发布 `问题主库` 与周期周表。
- `skills/xws-faq-raw-collection`：锁定最新竞品周 A/B TOP5，保存小旺神问大家与评论原始证据到本地。
- `skills/xws-question-library-collection`：兼容入口，将已验证原始证据生成本地 raw snapshot。
- `skills/sycm-to-feishu-base`：飞书副本字段检查、TSV 构建、真实粘贴与导入验收。
- `skills/huitun-to-feishu-keyword-heat`：读取飞书 `A候选` 队列，在灰豚红薯版采集完全同名话题浏览量，并只回填 `灰豚话题浏览量`；`内容热度`由上游流程提供。已登记运行时能力 `huitun.keyword-heat.collect@1.1.0`（采集段独立复验 `results.json` 与队列绑定，发布段对账式写入并由含 `优先级` 公式结算的回读收场）。
- `evidence/stability-20260804`：三轮 267 行稳定性验证文件。
- `runtime`：后续项目专用运行入口。`runtime/sop-runtime/` 是确定性运行底座（Controller 唯一拥有状态、两段式采集/发布、Agent 判决层、调度侧队列探测、一轮运行的生命周期），入口见 `runtime/sop-runtime/index.mjs`，阶段档案见 `docs/architecture/PHASE-ARCHIVE.md`。`runtime/notify-feishu.mjs`（+ `notify-feishu-core.mjs`）是无人值守方案的告警投递出口：stdin 进告警 JSON、stdout 出投递收据，主通道自建应用消息、群机器人兜底，未送达一律非零退出。`runtime/sop-runtime/round-runner.mjs`（+ `round-notify-policy.mjs`）把「体检 → 探队列 → 两段式执行 → 收尾 → 自愈 → 通知」串成一轮：判定表决定「该不该打扰人」（默认安静、未登记的理由一律按通知处理），去重与恢复成对，同一业务幂等键当天不重复跑。`runtime/sop-runtime/round-schedule.mjs`（+ `runtime/round-schedule.json`）回答「什么时候跑、跑哪个周期」：排期是配置文件、不是某一台机器上的触发器，宿主（常驻 `--serve` / 外部定时器 / 人工点击）只负责叫醒，「该不该跑」始终由配置判定；到期口径是「只有触发日当天」，不跨天自动补跑，要补跑用 `--force`。
- `docs/architecture/README.md`：多租户运营任务执行平台的目标架构、分层边界、权威数据和迁移原则。
- `docs/standards/README.md`：跨模块工程规范、状态与证据、测试、安全和交付边界。
- `docs/project-knowledge.md`：当前已验证能力、验证证据与对外表述边界；目标架构以 `docs/architecture/README.md` 为准。
- `docs/references/revolution-knowledge-patterns.md`：从 Revolution 知识库迁移并本地化的证据治理方法。
- `docs/references/COMPETITOR-FIELD-REFERENCE.md`：竞品分析表**全表头字段参考手册**（每个字段的线上下类型、来源、参考公式或 AI 提示词、周表是否有），附「外形/安装方式/功能/风格为什么是 AI 推的」「周表为什么曾经是 35 字段、2026-09-15 怎么修成 40」的实测结论。
- `docs/references/COMPETITOR-FIELD-REFERENCE-CLIENT.md`（+ 同名 `.docx`）：上文的**对外交付版**，照《浴缸关键词最新字段_公式与AI提示词》的体裁写成「字段处理矩阵 → 飞书公式 → AI 提示词 → 受控词表 → 使用边界」，隐去租户应用、base/table id 与内部证据引用。docx 由 `runtime/generate-competitor-field-reference-docx.cjs` 渲染；md 是唯一内容源，改内容要改 md 再重跑脚本。
- `docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md`：面向「单机单店铺、客户自助操作」的交付评估与改造方案（登录体检与扫码登录、飞书提醒、傻瓜修复的三档边界、P0-P2 优先级）。
- `docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md`：无人值守运行方案（定时调度落地方式、一轮运行的生命周期、「出故障才提醒」的判据表、自愈的能做什么与做不到什么、飞书消息通道选型）。
- `docs/ops/LOGIN-STATE-MANAGEMENT.md`：登录态管理设计（失效机制清单、身份/环境/会话/端到端四层检查、判据分级与话术、参考 `E:\小红书` 的实现取舍、与现有预检代码的接线点）。
- `docs/architecture/PRODUCTION-READINESS.md`：生产准入评估（四条阻塞线 + README §10 十一条架构验收的逐条实测状态）。
- `docs/ops/SYSTEM-OVERVIEW-AND-DEPLOYMENT.md`：**全系统总览与部署方案**（架构组成、依赖关系、运行环境与部署条件、风险与待完善项、三种部署形态的执行步骤与验收判据）。要「把这套东西装到另一台机器上」先看这一份；只交付日报链另见 `DAILY-REPORT-STANDALONE-DEPLOYMENT.md`。

## 外部依赖

- 共享 `web-access` Skill 和 CDP Proxy：`D:\codex\skills\web-access`
- 已登录的 Edge 用户会话
- 外部飞书应用凭据文件：当前位于 `E:\小红书\.env.local`，仅向导入命令传入路径，不复制凭据值

账号密码、Cookie、浏览器用户目录和安全验证数据不属于项目资产，不复制到本目录。

全局 Skill 入口 `D:\codex\skills\sycm-*`、`D:\codex\skills\xws-*` 和 `D:\codex\skills\huitun-*` 是指向本项目 `skills` 目录的目录联接，不是第二份代码。

## 竞品分析 V2

`竞品主表`保留小旺神 16 个源字段和真实图片附件。`是否有效竞品`由商品标题的明确证据自动重算；类目仍原样保留，但配件也可能挂在浴缸类目下，因此不作为有效性依据。只有“是”才计算或分析后续字段；“否”和“待确认”只保留原始数据与状态。有效竞品的七个 AI 字段空值回填为`无注明`，`否`和`待确认`统一回填为`不适用`，已有非空分析值不覆盖。`排除原因`同样由公式输出。`竞品分类`为单一公式结果 `A-爆款竞品/B-高价值竞品/C-差异化竞品/D-价格/流量型竞品/无分类/不适用`，按 `A > B > C > D` 优先级输出；价格缺失时为`不适用`，C 类固定为`价格>=8000`，不再使用主图、异形或造型特殊判断。`待补数据项`检查月收货人数和全部七个 AI 字段，`无注明`与`不适用`都视为缺少证据；`数据状态`对有效竞品输出`可用`或`部分待补`，非有效和待确认留空。`PMMA、高分子、绮美石、可丽耐、杜邦石、亚克力人造石`统一归入人造石，普通亚克力仍归亚克力。

已有授权副本通过 `migrate-competitor-v2-analysis.mjs` 受控升级：9 个确定性字段全部由飞书实时公式生成并回读验证，迁移脚本不会把本地分类器结果写入记录。执行顺序固定为“公式/选项更新 -> 飞书回读收敛 -> 仅按回读的`是否有效竞品`生成 AI 哨兵值 -> 只写 7 个 AI 字段 -> 再回读验证”。本轮飞书 AI 无额度时，AI 字段只允许空值哨兵回填：有效竞品为`无注明`，`否`/`待确认`为`不适用`；已有非空值不覆盖。迁移脚本不点击、不运行飞书 AI，`aiRunTriggered=false`。

## FAQ 周更

运营只使用 `xws-faq-operator`，飞书最终只保留累计主表 `问题主库` 和每周分类汇总表 `问题库_开始日期_结束日期`。原始证据、分类明细、跨周去重、周汇总和累计汇总全部保存在 `runtime/question-library-collection` 与 `runtime/faq-analysis`。TOP5 固定从最新有效竞品周的 A-爆款竞品与 B-高价值竞品中，按月收货人数计算值降序、序号升序锁定。分类使用运营固定目录的版本化多标签规则，出现次数和占比由本地确定性计算，不调用飞书 AI。

统一入口为 `runtime/run-faq-operator.mjs`：`--status` 只读检查（默认写 `operator-status.json`，调度器这类「看一眼」的调用方加 `--no-persist`），`--advance` 每次只推进一个阶段；浏览器采集遇到登录、验证码、风控、额度或下载失败时停在当前商品并保留告警。发布前必须显式提供 `问题主库` 与当前周表的 table ID。发布语义是**总表只追加**：明细线 `runtime/publish-faq-detail-enrichment.mjs --phase publish` 按 `来源记录唯一键＋分类标签` 增量追加，`deletes` 恒为 0；只有当前周表需要整体覆盖时才用 `--replace-weekly` 显式声明，并执行备份、替换、回读和失败补偿。明细线没有「替换总表」这一动作。

## 周更边界

周更前半程使用 `run-weekly-pre-ai.mjs`：每次从生意参谋首页进入搜索排行后显式选择并验收 `7天`，以 `collection-date` 作为七天区间结束日；单日、区间不完整或回执无法证明七天的数据会在任何飞书写入前被拒绝。显式复用既有数据时必须同时提供 CSV/XLSX，脚本会回读验证页、逐字段比较并锁定两个文件哈希，不能只凭 CSV 文件名跳过采集。随后生成携带当前表、上一周表、历史表、批次和行数精确上下文的 `pre-ai-manifest.json`，停在 `LOCAL_INPUT_READY` —— 这一步**不做任何飞书写入**；复制上一周结构与追加本周表/历史是两个独立的远端写入段。飞书 AI 字段由运营在表内结算，随后由 `sync-decision-history.mjs` 做决策历史同步；灰豚（`huitun-to-feishu-keyword-heat`）是独立的一段。注意 `run-weekly-post-ai.mjs` 不是这条链的下一步：它只吃 `PUBLISH_READY` 工件（`--publish-artifact`），并会明确拒绝 `--pre-ai-manifest`。`是否重点词`不依赖内容热度，`对应产品方向`由三个近两周达标次数按“主推 > 增长 > 探索 > 暂无”自动计算。灰豚返回 `AI_REQUIRED` 时整链停止且不会同步历史；`DONE_NO_CANDIDATES` 会跳过灰豚写入并继续历史同步。

三个 `近2周...达标次数` 是飞书实时公式，不再由周更脚本硬写。历史同步只冻结有效批次的 `0/1` 证据，并按永久关键词编号向本周表写入三个 `上一有效周...达标` 数字快照；本周搜索、交易、内容或灰豚数据变化后，近2周次数、重点词、优先级和产品方向会连续重算。缺少上一周或本周证据时只保留对应结果为空，`A候选`不能按未达标 `0` 处理。

固定可视化只读取 `关键词历史总表 V1`，不为每周数据新建仪表盘。历史同步会把有效周分析表的 `标准归并词`、`是否重点词`、`优先级`冻结为文本快照，并维护公式字段 `本期标记`；只有“当前批次编号且批次有效性=有效”的记录为“是”。所有图表统一筛选 `本期标记=是` 和 `批次有效性=有效`。每周成功同步后只需更新一次该公式中的当前批次号，图表自动切换；当前批次快照不完整时禁止切换。

当前授权 Base 的两周依据为批次 `[1,3]`：`关键词分析 V1（修正版）`对应批次 1，`关键词分析 V1（2026-08-15）`对应批次 3；批次 2 是已确认的单日周期错误数据，只保留审计并排除。旧批次有效性为空时不得自行纳入；只有显式给出上一周表、目标批次与预期行数，并通过永久关键词编号集合完全一致校验后，才允许把该批次受控提升为`有效`。

```powershell
node "skills\sycm-to-feishu-base\scripts\run-weekly-post-ai.mjs" `
  --publish-artifact "<analysis-artifact.json>" --apply `
  --confirm-base <app-token> --confirm-current-table <current-table-id> `
  --confirm-history-table <history-table-id> --confirm-library-table <library-table-id>
```

工件必须是 `status=PUBLISH_READY`，带 `publishPlan` 与完整的 `evidence`（`source` / `providerDigest` / `promptDigest`）。

## 最小离线验证

Node **22** 或更新版本。`package.json` 的 `engines.node` 现在是 `>=22`（CDP 代理 `runtime/isolated-proxy/cdp-proxy.mjs` 用原生 `WebSocket`，Node 22 起才稳定可用），所以 `npm ci` 在更低版本上会以 `EBADENGINE` 拒绝安装。

最低离线 self-test 入口：

```powershell
npm ci --ignore-scripts
npm run test:offline
```

该入口只运行三个确定性 `--self-test`，不发现测试文件，不访问真实浏览器/CDP Proxy、PostgreSQL、飞书、平台账号或外部凭据。它不是全仓库回归，也不证明 Python、外部环境或真实业务流程可用。

完整业务流程仍依赖已登录 Edge、共享 CDP Proxy、PostgreSQL 和外部飞书凭据。两个 `runtime/generate-competitor-v2-*.cjs` 入口依赖未声明的 `docx`；Python 路径依赖 `openpyxl`、Pillow、`python-docx`，部分报告还依赖仓库外的 `table_geometry`。

## 验证

（以下命令同样在仓库根目录下执行 —— 换机器后不用改任何一行。）

```powershell
node "skills\sycm-export-search-rank\scripts\export-search-rank.mjs" --self-test
node --test "skills\sycm-export-search-rank\scripts\full-flow.test.mjs" "skills\sycm-export-search-rank\scripts\output-publish.test.mjs"
node --test "skills\sycm-export-search-rank\scripts\source-period-proof.test.mjs"
node --test "skills\sycm-export-search-rank\scripts\adapter.search-rank.test.mjs"
node --test "skills\xws-sku-collection\tests\adapter-sku-collection.test.mjs"
node "skills\sycm-to-feishu-base\tests\build-paste-tsv.test.mjs"
node "skills\sycm-to-feishu-base\tests\inspect-fields.test.mjs"
node --test "skills\sycm-to-feishu-base\tests\copy-weekly-table.test.mjs" "skills\sycm-to-feishu-base\tests\update-weekly-base.test.mjs"
node --test "skills\sycm-to-feishu-base\tests\sync-decision-history.test.mjs" "skills\sycm-to-feishu-base\tests\run-weekly-pre-ai.test.mjs"
node --test "skills\sycm-to-feishu-base\tests\run-weekly-post-ai.test.mjs"
node --test "runtime\keyword-decision-formulas.test.mjs" "runtime\apply-weekly-decision-formulas.test.mjs"
node --test "runtime\sop-runtime\*.test.mjs"
node "runtime\sop-runtime\build-skill-registry.mjs" --check
node --test "skills\xws-export-market-analysis\tests\flow.test.mjs" "skills\xws-export-market-analysis\tests\cli.test.mjs" "skills\xws-export-market-analysis\tests\validate-output.test.mjs" "skills\xws-export-market-analysis\tests\prepare-flow.test.mjs"
node "skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" --self-test
py -3 "skills\xws-export-market-analysis\scripts\validate-output.py" --self-test
node --test "skills\xws-to-feishu-base\tests\*.test.mjs"
py -3 -m unittest "skills\xws-to-feishu-base\tests\extract_xws_xlsx_test.py"
node --test "skills\huitun-to-feishu-keyword-heat\tests\adapter-huitun-keyword-heat.test.mjs"
node --test "skills\huitun-to-feishu-keyword-heat\tests\*.test.mjs"
node "skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" --self-test
```

上面是逐条的入口。全仓回归用目录发现的套件运行器（新测试自动纳入，不需要改文件列表）：

```powershell
node "scripts\run-test-suite.mjs" unit --concurrency=1
node "scripts\run-test-suite.mjs" skills --concurrency=1
node "scripts\run-test-suite.mjs" runtime --concurrency=1
```

`--concurrency=1` 不是可选项：`xws-export-market-analysis` 的用例会拉起真实 CLI 打假代理，并含 stall/deadline 计时断言，机器有负载时会假失败。`--dry-run` 打印各套件解析出的文件清单，用于核对离线/集成分区。

**套件运行器的发现是非递归的**（runtime 只发现 `runtime/*.test.mjs`、skills 只发现 `skills/*/{tests,scripts}`），
所以 `runtime/sop-runtime/` 下的用例不在上面 `runtime` 那一套里，必须单独跑一遍——漏跑一次就是 300+ 条用例无声地不进回归：

```powershell
node --test "runtime\sop-runtime\*.test.mjs"
```

调度侧入口（只读探测，不创建运行）：

```powershell
node "runtime\sop-runtime\capability-scheduler.mjs" `
  --capability huitun.keyword-heat.collect --probe-only `
  --collect-input '{"envFile":"E:\\小红书\\.env.local","appToken":"<app-token>","tableId":"<table-id>","tableName":"<table-name>"}'
```

排期入口（「什么时候跑、跑哪个周期」写在配置文件里，改配置不用改代码）：

```powershell
# 1) 先看计划：只读，不碰数据库，不创建任何运行
node "runtime\sop-runtime\round-runner.mjs" `
  --schedule-file "runtime\round-schedule.json" --show-plan

# 2) 手工跑一条（已到点才跑；没到点会原样跳过并说明下一次什么时候）
node "runtime\sop-runtime\round-runner.mjs" `
  --schedule-file "runtime\round-schedule.json" --round weekly-competitor

# 3) 常驻叫醒（机器基本不关时用）；外部定时器（任务计划程序 / WorkBuddy 定时任务）跑第 2 条命令即可，等价
node "runtime\sop-runtime\round-runner.mjs" `
  --schedule-file "runtime\round-schedule.json" --serve --interval-seconds 60
```

`--show-plan` 会同时给出 `triggerAt` / `isLastTriggerToday` / `hoursSinceTriggerAt` / `nextTriggerAt`。
为什么必须显示这几个：到期口径是「只算触发日当天」，所以**周一没开机就真的不会自动补跑**——
不显示出来，「漏了」在计划里看不出来，而「漏跑可见」正是选这个口径的前提。补跑是显式动作：加 `--force`。

去掉 `--probe-only` 并补上 `--identity` / `--business-key` 即为完整调度：队列为空时跳过且
**不创建任何运行**（退出码 0），因此「本周没有要补的词」不会被记成一条失败。退出码约定：
`0` 完成/无可做之事、`2` 运行未通过、`3` 需要人工（含等上游结算）、`4` 调用方缺陷。
探测只读、不要求 `results.json`、不做策略判决；探测失败一律照常发起（宁可多做一次会失败的运行，
也不静默漏做）。详见 `docs/architecture/MIGRATION-8-QUEUE-SCHEDULER-REPORT.md`。
