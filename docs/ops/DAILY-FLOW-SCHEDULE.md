# 日报相关三条流程的统一早间调度（2026-10-10 定稿；2026-10-13 更正日报时间为 11:00）

| 顺序 | 流程 | 每日执行时间 | 命令（定时任务原样执行） | 与上一条的间隔 |
|---|---|---|---|---|
| 1 | 推广日报（promotion-daily） | 07:00 | `node scripts/run-batches.mjs --workflow promotion-daily --date yesterday --batch-size 5 --mode apply --notify` | — |
| 2 | 商品数据（product-daily） | 10:00（维持原时段不动） | `node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5` | 3 小时 |
| 3 | 日报（daily-report） | 11:00 | `node scripts/run-daily-job.mjs --date yesterday --batches 5 --notify --auto-repair --mode apply` | 1 小时 |

时间安排理由（数据可用性与资源竞争双约束）：

- 三条链共用店铺浏览器与商家浏览器，且商品/日报共用同一把全局运行锁（`runtime/.workflow-locks/merchant-automation.json`），必须串行；间隔按各链实测耗时（推广 3-7 分钟、商品 11-13 分钟、日报 25-60 分钟）留足冗余。
- 推广日报放 07:00：三链里最短（3-7 分钟），放最前让昨日推广数据最早落表，人工上午即可核对。早间可用性侧证：日报链（含阿里妈妈推广步骤）在 07:39-09:54 有成功实证（`evidence/daily-job-2026-10-09`）。如实注明的风险：推广链自身历史真实运行均在 12:53 之后，且 07:00 在阿里妈妈推广 CSV 静止点（11:20 硬边界）之前 —— 首轮 1-2 天需人工核对写入值是否偏低（同日低值无法重推，需先删行）。
- 商品数据维持 10:00：该时段已被每日定时任务长期验证，零风险不动。2026-10-16 起该命令不再带 `--skip-promotion`（推广段恢复：导入器已按（店铺, 数据日期）解析 base、批量按部门分组；`--skip-promotion` 只剩人工熔断用途）。若 WorkBuddy 自动化任务里存的是旧命令串，以本表为准同步改。
- 日报放 11:00：避开前两条的浏览器与登录态争用 —— 前两条最晚 10:15 左右收尾（商品 11-13 分钟），全局锁已释放；日报最坏 2.4 小时也在 14:00 前收尾，下午仍有充足时间人工处置。
- **11:00 与阿里妈妈推广 CSV 静止点（11:20 硬边界）的关系**：11:00 早于 11:20，理论上尚未到静止点。2026-10-13 实测已证安全 —— 同一个业务日导出两次「营销场景报表」（11:15:08，早于静止点；11:48:11，晚于静止点），两份 ZIP 内 CSV 的 sha256 **逐字节相同**（`8d0b3326…f603d`），数值逐字段一致；当日 8 家按日低值核对亦全落在 8 日区间内、关键词花费反为最高。证据：`evidence/daily-job-2026-10-12/VERIFICATION-1100-FIRST-RUN.md`（第五、四节）。
- 全部时间在配置处（WorkBuddy 自动化任务的 rrule）与本文件双重注明；调整时两处同步改。

## 宿主调度器的 `success` 字段**不能**当验收判据（2026-10-17 实测确认）

`~/.workbuddy/logs/automation.log` 里 `run finished … success=true` 的含义是
**「这次自动化会话跑完了，没有中断/超时/上游报错」**，不是「这条数据链写成功了」。

- 铁证（同一次运行）：`2026-10-17T02:04:33Z` 派发商品数据轮，`02:09:32Z–02:24:56Z` 作业实际执行，
  `job.log` 收尾「本轮不完整（26 处）… 退出码 1」、`run-receipt.json` 为 `status=FAILED`
  （`failedStage=product-import`，24 次 403/91403），而调度器在 `02:28:45Z` 记 `success=true`。
- 全量日志统计：商品数据轮 7 次里 5 次 `success=true`，2 次 `false` —— 那 2 次都是
  `[CANCELLED] unknown_interrupted` / `[UNKNOWN] … 524`，即**基础设施/会话层问题**；
  从来没有一次是因为数据没收齐而 `false`。也就是说这个字段对「数据对不对」完全不敏感。

判「这一轮到底成没成」只认这三样（按可信度排序）：

1. `evidence/<链>-<日>/<runId>/run-receipt.json` 的 `status` 与 `failure.class`；
2. 飞书告警（链自己在失败时发 `<flow>-round-<日>`，补齐后发 `<flow>-ok-<日>`，
   「发出去了」才是「有人知道了」）；
3. **独立回读**：目标日三张表的行数差额与逐店源行数合计逐项相等。

`success=true` 最多只能用于排除「宿主没跑起来」这一种情况。

