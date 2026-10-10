# 架构落地 + 推广日报接入调度 + 三流程统一早间调度 · 执行报告

日期：2026-10-10（夜间执行，总执行人：接线员）
规格书：`docs/ops/SYSTEM-ARCHITECTURE-OPTIMIZATION-EXECUTION-SPEC-2026-10-10.md`
提交：`docs/ops/DAILY-FLOW-SCHEDULE.md`（调度定稿）、本报告。

## 一、三项任务的处理结果

### 任务一：落地架构师 spec

完成 P0 / P1 / P2 全部交付物与 P3 的解析器部分，版本 1.8.0（本地提交，未推远端）：

- **P0 工作流登记契约**：新增 `runtime/workflow-catalog.mjs`（零 import、纯字符串配置）+ 测试。四条主流程登记齐（daily-report / promotion-daily / product-daily / weekly-report）；`getWorkflow` 对未登记 id 硬失败、绝不回退日报默认入口；测试钉住「catalog 与 batch-plan 现用链入口逐字一致」。
- **P1 统一运行回执**：新增 `runtime/run-receipt-v1.mjs` + 测试（五条状态轴闭合集、失败分类闭合集、写前校验、非法回执拒写落盘）。run-batches 在写 batches.json 的同一落点生成统一回执（旧格式继续兼容生成）。新增 `runtime/batch-rounds-receipt.mjs` 纯函数映射模块（对抗审查整改产物）：驻留四终态（TIMED_OUT / RESUME_FAILED / NO_HOLD / NO_VERDICT）如实记 FAILED、RESUMED_OK 记 SUCCEEDED；失败店清单只收逐店名单、拿不到就空着（不把整批成功店伪标失败）；apply 轮次 chain 步 publication 记 UNKNOWN（未独立回读不假装 NOT_REQUESTED 也不声称 VERIFIED）；release.observed 恒 false+UNKNOWN（释放只认独立端口回读，回执不假装观察到）。
- **P2 统一入口**：run-batches 与 run-daily-job 均接受 `--mode dry-run|apply`；`--commit` 兼容转换为 `--mode apply` 并打印转换提示；矛盾组合（dry-run + --commit）硬错误；都没给时走 catalog 的 manualDefault（run-daily-job 宿主保持今天的行为＝apply，有测试钉住）。**删掉了 run-batches 原对 promotion-daily 无条件 `--commit` 的隐式强制写入**（spec 明确的修复目标）。run-batches 从 catalog 解析链入口（batch-plan 新增可选 chainFile 参数，缺省行为逐字不变）。CLI 接线守卫 `runtime/run-batches-cli.test.mjs` 真实执行 CLI 钉住四条行为判据；突变验证四处全红点名（校验短路 / 两档无条件 --commit / 缺省硬编码 apply），还原 sha256 自证。
- **P3 运行根目录（部分）**：新增 `runtime/run-root.mjs` + 测试（优先级：`--evidence-root` 实参 > `SYCM_RUN_ROOT` 环境变量 > 机器级默认 `D:\Retire\sycm-automation-runs`）。统一回执与 manifest 落 run-root（已预建目录）；回执 artifacts 记录 batches.json 的相对路径、字节数与 sha256（spec §7.3）。**skill 层下载/截图路径的全面迁移未做**（见遗留）。

**验证**：定向 9 个测试文件 210 项用例全绿；六组 `--print` 基线对比——无旗标调用逐字节一致（仅版本行）、--commit 调用仅多转换提示行、promo 无旗标差异仅为 `--commit` 移除（即修复目标本身）；`npm run check:staged` PASS；全量 unit 套件结论见文末「测试门禁」。

**对抗式审查（3 名子 agent，攻击视角分别为依赖与提交边界 / 行为不变量与回滚 / 明日生产调度推演）**共提出 1 项 P0、7 项 P1、6 项 P2 缺陷，整改落实 10 项（回执三处状态失真、dry-run 下 ensure-inquiry-rows 仍写飞书、`--notify` 静默丢弃、启动自检爆炸半径、help 丢 `--commit`、CHANGELOG 措辞与事实不符、调度命令丢 `--logs`、artifacts 无哈希），其余 3 项低危经核实不修（见遗留）。审查还推翻了两处错误判断并已修正方案：日报「早上有成功实证」实为 UTC 时区误读（07:39Z=15:39 本地），07:00 时段实际零实证；11:45 命令不带 `--logs` 会覆盖日报的批次证据。

### 任务二：推广日报接入定时调度

新建自动化「sycm 推广日报定时（每日 07:00 · 销售1部 8 家）」（ACTIVE）：

```
node scripts/run-batches.mjs --workflow promotion-daily --date yesterday --batch-size 5 --mode apply --notify --logs evidence/promotion-batches-<目标日>
```

- 沿用现有日报流程的调度方式与配置规范（同款口径段落、锁检查、释放两次端口回读、已知故障形态段落）。
- 带「链仍红则只报告不空跑」前置闸：开工前读最近一轮推广证据，若仍死于已知 CDP eval SyntaxError 则跳过本轮（当前推广链带伤，属并行开发线在修，详见遗留 1）。
- `--logs` 必带：不带会覆盖 `evidence/batches-<日>` 里日报链的批次记录（对抗审查抓出的真实风险）。

### 任务三：三条流程统一早间调度（时间在配置与文档双重注明）

| 顺序 | 流程 | 每日时间 | 变化 | 间隔 |
|---|---|---|---|---|
| 1 | 推广日报 | **07:00** | 新建 | — |
| 2 | 商品数据 | **10:00** | 不动（长期验证时段，零风险） | 3 小时 |
| 3 | 日报 | **11:30** | 原 15:30 前移 | 1 小时 30 分 |

时间依据（可核对）：
- 实测耗时：日报 25-60 分钟（最坏 2.4 小时）、商品 11-13 分钟、推广 3-7 分钟；间隔留足冗余。
- 日报放 11:30：已过阿里妈妈推广 CSV 静止点（11:20 硬边界），早上时段内数据成熟度最安全的落点；07:00 时段零实证（原「早上实证」为时区误读）。首轮 1-2 天需人工核对写入值是否偏低。
- 推广放 07:00：链当前带伤且激活受前置闸控制；放最前为失败留全天恢复窗口；其早间数据可用性同样无实证，自动化 prompt 已带首轮核对要求。
- 日报失败转驻留窗口（约 11:30-15:30 持全局锁）不与任何定时任务冲突。
- 配置注明处：三条自动化任务的 rrule（BYHOUR=7 / 10 / 11）+ `docs/ops/DAILY-FLOW-SCHEDULE.md`（调整时两处同步改）。

## 二、改动文件清单（19 个，本地提交，显式路径、未推远端）

新增（10）：
- `runtime/workflow-catalog.mjs` / `.test.mjs`
- `runtime/run-receipt-v1.mjs` / `.test.mjs`
- `runtime/run-root.mjs` / `.test.mjs`
- `runtime/batch-rounds-receipt.mjs` / `.test.mjs`
- `runtime/run-batches-cli.test.mjs`
- `docs/ops/DAILY-FLOW-SCHEDULE.md`

修改（9）：
- `scripts/run-batches.mjs`（catalog 校验、--mode/--evidence-root、删推广无条件 --commit、统一回执接线）
- `scripts/run-daily-job.mjs`（--mode/--evidence-root/--commit 兼容）
- `runtime/batch-plan.mjs` / `.test.mjs`（可选 chainFile，缺省行为不变）
- `runtime/daily-job-plan.mjs` / `.test.mjs`（mode 透传；dry-run 时 ensure-inquiry-rows 不带 --commit）
- `VERSION`、`package.json`（→ 1.8.0）、`CHANGELOG.md`（顶部 1.8.0 条目）

另有仓库外动作：预建 `D:\Retire\sycm-automation-runs`（空目录，run-root 机器级默认）。

## 三、遗留问题

1. **推广链当前带伤（最高优先）**：2026-10-10 全部推广轮次死于 CDP eval SyntaxError（`missing ) after argument list`，evidence/promotion-sales1-2026-10-10* 及 fixed-single 复测均红），历史上 0 绿批次。涉及文件属并行开发线（工作区 modified），本轮未碰。07:00 定时任务带前置闸，链修好并出绿之前每天只会收到「跳过」汇报。
2. **商品日报的统一回执接线推迟**：宿主 `run-product-data-job.mjs` 被并行开发线持有（modified），本轮只在 catalog 登记 product-daily，未接回执。待该线合入后补。
3. **推广链侧无 apply 门控（半个 dry-run）**：run-batches 层 dry-run 只拦飞书导入；链内 submit/fetch 与台账推进（`runtime/promotion-task-ledger.json`）不看 apply。链文件属并行线，本轮未碰。手动 dry-run 推广链时会真实提交平台任务。
4. **promotion 档不转发 `--notify`**：已加显式警告行；链侧通知出口待接线。11:45→07:00 定时任务的失败告警依赖自动化会话汇报。
5. **P3 未完成部分**：skill 层下载/截图/日志的全面 run-root 迁移未做（涉及大量 skills 文件，须按 §8.2 迁移顺序单独做）；统一回执/manifest 的真机落盘仅有离线判据，未经真实 apply 轮次验证（明早 07:00/11:30 首轮即是真机首验）。
6. **不修的已核实低危项**：promotion chainArgs 不转发 --keep-going 等链开关（历史欠账，非本轮回归）；weekly-report defaultBatchSize=5 为占位值（spec 表格「按流程」与 §4.3「正整数」自相矛盾）；run-root 的 envRoot 形参与内部 env 读取重复（死参数）；run-daily-job 两处 --print 文案漂移（「一律释放」「等到当天 12:00」与 1.7.19+/1.7.20+ 实际口径不符，属并行线遗留文案）。
7. **arch-boundary.test.mjs 有 1 红（预先存在）**：三个推广线 skills 文件的跨目录 import 未登记进白名单，属并行线工作区改动，与本轮无关，未碰。
8. **run-batches 不抢全局运行锁**：三条流程目前靠时间间隔保证串行；若有人手动并发触发仍可能撞浏览器资源（spec §13 Browser Broker 重评条件即此）。
9. **离线套件在本沙箱环境下的两个坑（今晚实测）**：① 用例内 `spawnSync` 默认 stdio ⇒ 宿主沙箱 EBUSY ⇒ 退出码 null，skills 半场 11 项假红皆此（换 `stdio:['ignore','pipe','pipe']` 即恢复），沙箱外/CI 不受影响；② `xws-export-market-analysis` 的 `prepare-flow.test.mjs`、`supervisor.test.mjs`（均并行线 10-10 17:13 在飞改动）在沙箱下无限挂死、spawn 无 timeout——套件入口 `run-test-suite.mjs unit` 一旦撞上即整场挂死（本次为取结论强杀了卡死进程，杀进程动作已记录）。另注意 `run-test-suite.mjs` L140：unit＝先 skills 后 runtime 且 **skills 非绿时 runtime 半场不跑**，报套件结论时必须说明只覆盖了哪半场。

## 四、需要你确认的事项

1. **推广链修复排期**：07:00 任务已带前置闸，但链不修就永远只出「跳过」汇报。修复属并行开发线（今晚在飞的那条），请定由谁/何时修。
2. **早间时段首轮核对**：日报 11:30 与推广 07:00 均无历史实证。明早（10-11）两轮的汇报请重点看：写入值量级是否偏低（低值当天无法重推、需先删行）、run-root 统一回执是否真落盘。若 11:30 日报出低值，回退方案＝rrule 改回 BYHOUR=15;BYMINUTE=30（一处配置）。
3. **spec §13 待业务负责人拍板项**（本轮按推荐值实现）：手动默认 dry-run ✅ / 定时显式 apply ✅ / 默认批次 5 ✅ / 证据保留 30/180 天未启用自动删除 ✅ / 推广独立 workflow ✅ / Browser Broker、Temporal 本轮不做 ✅。周报 defaultBatchSize 占位值与 resources 未核实，待你拍板。
4. **推送远端**：本地已提交但未推送（工作区仍有大量并行线未提交改动，无法只推本轮提交；且 spec §2.3 本轮不推送）。交付形态按本仓惯例＝整仓复制。
5. **商品日报回执补接**：待 `run-product-data-job.mjs` 所在开发线合入后，单独一小轮补上（改动面小、口径已定）。

## 五、测试门禁

- `npm run check:staged`：PASS（15 个暂存 .mjs 语法全过）。
- `npm run test:staged`：暂存面涉及共享模块，选择器拖入全量 unit 套件，600 秒预算内无结论（按口径＝无结论，不当绿也不当红）。
- 定向套件（9 文件 210 用例）：全绿。
- 突变验证：4 处突变全部红在预期用例、还原 sha256 自证。
- **全量 unit 套件（skills 半场，官方入口 `run-test-suite.mjs unit --concurrency=1`）**：1086 项 / 1072 过 / 14 红。14 红逐项定性完毕，全部与本轮暂存面无关：
  - 11 项＝EBUSY 环境假红：用例内 `spawnSync` 默认 stdio（含管道 stdin）在宿主沙箱下直接 spawn 失败，退出码 null，报 `null !== 0`（含 validate-output 3 项、search-rank full-flow 3 项、xws-export-market-analysis cli/adaptive/merge 5 项）。已实测复现并解释：同一命令带 `stdio:['ignore','pipe','pipe']` 即恢复正常——沙箱环境问题，不是产品回归。原始输出＝`.workbuddy/tmp-skills-rerun.tap`（913 项截段）。
  - 3 项＝`prepare-flow.test.mjs` 进程卡死后被强杀的余项。该文件与 `supervisor.test.mjs`（单独跑同样 90 秒挂死）均属并行线 10-10 17:13 在飞改动（`xws-export-market-analysis`，未提交），与本轮暂存面零交集。
  - **runtime 半场因 skills 非绿被套件门禁跳过（`run-test-suite.mjs` L140：skills 非 0 不跑 runtime），已单独补跑**：1202 项 / 1201 过 / 1 红。本轮全部暂存测试（chainFile、驻留终态、runId、统一入口 CLI 等）均在该半场真实执行且全绿。唯一红＝`arch-boundary` 守卫点名并行线 3 个推广日报在飞文件（import/run-promotion-daily-report.mjs、run-promotion-sales1.mjs）引用 runtime 模块未登记 SKILLS_TO_RUNTIME 白名单——属并行线待办，非本轮改动。原始输出＝`.workbuddy/tmp-runtime-suite.tap`。
  - **结论：本轮 19 个暂存文件在两层套件中零红。**
