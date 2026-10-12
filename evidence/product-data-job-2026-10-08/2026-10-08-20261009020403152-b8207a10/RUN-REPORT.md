# 商品数据采集与导入 · 执行报告

- 目标日：**2026-10-08**（命令 `--date yesterday`，按 Asia/Shanghai 解析；执行日 2026-10-09）
- runId：`2026-10-08-20261009020403152-b8207a10`
- 命令（原样）：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 时长：13m25s（02:04:03Z → 02:17:25Z）；**退出码 1**
- run-receipt：`status=FAILED`；阶段 product=`COMPLETED` / inquiry=`FAILED` / promotion=`SKIPPED`；
  failure `FAILED/UNCLASSIFIED`：`本轮不完整（1 处）：网林天猫/询单 未采集`；`failedStage=inquiry-import`
- 开工前全局运行锁 `runtime/.workflow-locks/merchant-automation.json` 不存在（未删锁）；跑完锁已释放（目录空）

## 结果

8 家 分 2 批（5+3），两批登录预检均 `ALL_IN`（无人工闸门）；视口 8 家全 1506x642 过闸。

| 店铺 | 商品源行 | 商品新增 | 商品 afterRows | 询单源行 | 询单新增 | 询单 afterRows |
| --- | --- | --- | --- | --- | --- | --- |
| 里可林淘宝 | 38 | 38 | 943 | 4 | 4 | 140 |
| 网林天猫 | 18 | 18 | 961 | — | — | **未采集（失败）** |
| 盖文淘宝 | 47 | 47 | 1008 | 4 | 4 | 144 |
| 盖文天猫 | 48 | 48 | 1056 | 14 | 14 | 158 |
| 科塔淘宝 | 34 | 34 | 1090 | 10 | 10 | 168 |
| 网林淘宝 | 40 | 40 | 1130 | 5 | 5 | 173 |
| 里可林天猫 | 30 | 30 | 1160 | 4 | 4 | 177 |
| 网林家居 | 7 | 7 | 1167 | 0 | 0 | 177（平台空态，不填 0） |
| 合计 | 262 | 262 | — | 41 | 41 | — |

- 重复数 = 0（写前该日 0 行，全部为新增；无同日去重拦截）。
- 推广段 = **SKIPPED**（有意，非缺口）。

## 独立回读（非链自报，脚本 `tmp/readback-oct-sales1-20261005.mjs`）

10 月销售1部 base（baseToken `FhCUbn7vVaEc26sRjMAccQJAn5e`）：

| 表 | 写前 totalRows / onDate | 写后 totalRows / onDate | 真实新增 |
| --- | --- | --- | --- |
| 商品 `tbley1xD9wDfQheX` | 905 / 0 | **1167 / 262** | **+262** |
| 询单 `tblenEzSMpp5RTQb` | 136 / 0 | **177 / 41** | **+41** |

- 独立回读的 totalRows（1167/177）与链自报末店 `afterRows` **逐值一致**。
- 与写前基线（0/0）相减即真实新增 262/41。

## 失败

- **网林天猫 / 询单**：采集段 `collect-inquiry-report.mjs` 抛
  `找不到商品咨询分析入口（轮询 30s 仍未出现）`，`stoppedAt=inquiry-collect`，未落 inquiry.xls ⇒ 未导入。
- 同批另 4 家询单全部正常 ⇒ 差异在该店页面/会话侧，非链本身。
- 分类：链记 `FAILED/UNCLASSIFIED`（`failedStage=inquiry-import`）。
- 未重跑、未改任何参数（按要求只跑这一条命令）。

## 释放（独立确认）

- `release-b1.json` / `release-b2.json`：`released=true`，各 2 次回读 `listening=0`。
- 独立复核（`Get-NetTCPConnection -State Listen` 连读两次，值一致）：
  8 家 16 个店铺端口（浏览器 19031-19035/19050-19052、代理 19041-19045/19060-19062）**全部 free**。
- `runtime/browser-inventory.mjs`：8 家全部「整套缺」；店铺 profile 的 msedge 本轮**零新增**
  （仅 `gaiwen-flagship` 有 2 个 10-08 22:35 的旧残体，端口已 free）。
- 仍监听：**19022/19023**（属日报链 `start-daily-report-browser/proxy`，10:09:23 由本链之外的进程所起，
  非本链分批释放范围，按规则未触碰）。

## 告警

- `--notify` 失败才叫 ⇒ 本轮失败，已投递：`SENT（exit 0）`；载荷落 `alert.json`。

## 期间观察（并发，非本链）

- 开工时 HEAD=`eb4bcda`；跑动中 HEAD 变为 `dffd1e0`（10:05:38 另一会话提交，daily-report 修复）。
- 10:15:16 出现空目录 `evidence/promotion-sales1-2026-10-08/`（推广链，另一会话）。
- 以上均未触碰；本链未改任何代码/配置。

## 结论

- 商品底单：8/8 采集导入成功，+262 行，独立回读佐证。
- 询单：7/8 成功，+41 行；**网林天猫 询单未采集** ⇒ 整轮判 `FAILED`（退出码 1）。
- 释放：每批端口全部释放，独立回读确认。
- 按失败标准：**未达成功标准**（网林天猫/询单 采集文件缺失）。

## 后续（当日 10:2x–11:1x，用户授权「都补吧，开始」）

### 缺口已闭合

- 定向补跑网林天猫询单段：`--shops 网林天猫`，产出
  `evidence/inquiry-backfill-2026-10-08-网林天猫/inquiry.xls`，导入收据
  `inquiry-import/receipt-网林天猫.json`：`sourceRows=4 / plannedRows=4 / existingRows=177 / afterRows=181`
  （`excludedSummaryRows=2`，4 个 recordId 全落）。
- **独立回读**（`tmp/readback-2026-10-08-final.json`，非链自报）：
  询单表 `totalRows=181`、**10-08 = 45 行**（此前 41）⇒ 真实新增 4 行，与收据 `plannedRows` 逐值一致；
  该轮 4 个新 recordId（`reczz28L9pF10Mmp` 等）与收据 `recordIds` 逐字相同。商品表不变（1167 / 262）。

### 根因已修（代码）

- 真机复现：页面 `readyState=interactive`、`bodyLen=32` 时「商品分析」精确命中 **0**；等 `complete`（约 8s）后父菜单命中 1、
  子入口 0；点一下父菜单后同页签立刻出现「商品咨询分析」。⇒ 原版「进循环前**只点一次**父菜单 + 轮询只找子入口、从不重试父菜单」
  第一下点空就必然轮询到超时。
- 修法（`skills/sycm-inquiry-data/`）：
  - `scripts/inquiry-core.mjs` 新增纯函数 `planEntryPollStep({hasInquiry,hasParent})` → `done` / `click-parent` / `wait`；
  - `scripts/collect-inquiry-report.mjs` 轮询体**每轮重判**并按 `click-parent` **重试父菜单**；失败时**先落现场再抛错**：
    `<out>.failure.json` + `<out>.failure.png`（截图单独走裸 fetch，容忍非 2xx）；
  - `scripts/inquiry-core.test.mjs` 新增 3 条判据（纯函数三态 / 接线守卫 / 先落现场后抛错），合计 **7/7 绿**；
  - `SKILL.md` 补「Known intermittent failure」节（成因、病根、现行为、快照文件、恢复方式）。
- 改动面：`4 files changed, 131 insertions(+), 2 deletions(-)`；原文件 18 行中 **1–12 与 15–18 逐字未变**
  （去 CR 口径逐段 md5 相同），仅替换原第 13、14 行。
- 突变验证（`tmp/mutate-inquiry-entry-20261009.mjs`）：A 轮询退回旧写法 / B 决策永不返回 `click-parent` / C 失败不落现场
  —— 三处全 `RED`（exit 1, fail=1），`restored` 全 `true`，还原后基线 **7/7 绿**。
- 真机接线验证（第二次起网林天猫，只动本店）：`normalize` 已归位，修复后采集 `EXIT=0`、5.430s，
  产出 `tmp/verify-collect-20261009/inquiry.xls`，**成功路径无 `.failure.json` 残留**；随后 `stop-all --only 网林天猫` 释放完成。

### 本轮无关但需知

- `runtime/arch-boundary.test.mjs` **1 红**：报的是推广线线程 10-08 23:10 两个提交（`613ac20`/`eb4bcda`）新增的
  `import-promotion-daily-report.mjs` / `run-promotion-daily-report.mjs` 未登记进 `SKILLS_TO_RUNTIME`，
  **早于本轮约 12 小时**，与本次改动无关，未触碰。

### 收尾（11:23）

- 修复已提交 **`4ea8754`**（`fix(inquiry): 入口轮询每轮重试父菜单 + 失败落现场`），只含
  `skills/sycm-inquiry-data/` 下 4 个文件（`4 files, +131 / -2`），显式路径、未带动他人文件。
- 门禁：`check:staged` PASS；`test:staged` PASS（该技能只有 1 个测试文件，7/7，0.31s）。
- 交付状态：`mainline_contains_commit=true` / `remote_contains_commit=false` /
  `worktree_clean=false` / `verdict=NOT_PUSHED`（本仓交付形态＝整仓复制；本地还混着他会话在飞的提交，故不推）。
- 未 bump 版本（VERSION 仍 `1.7.15`）：CHANGELOG 口径为「一个版本 = 一次可交付批次」，当日他会话提交同样未 bump。
