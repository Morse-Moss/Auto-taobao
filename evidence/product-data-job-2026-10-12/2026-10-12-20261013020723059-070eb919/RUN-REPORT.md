# 商品数据定时跑 RUN-REPORT —— 目标日 2026-10-12

- 执行时间：2026-10-13 10:07:23 ~ 10:18:41（Asia/Shanghai），耗时 11m18s
- 命令（原样，未改参数）：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- runId：`2026-10-12-20261013020723059-070eb919`
- **退出码 0**；run-receipt `COMPLETED`、`failure=null`、`failedStage=null`
- 开工前全局运行锁 `runtime/.workflow-locks/merchant-automation.json` 不存在（无冲突）；跑完仍不存在（未删锁）
- 开工前 HEAD `9c11bed`（1.8.10）

## 阶段状态

| 阶段 | 状态 |
|---|---|
| product（商品底单） | COMPLETED |
| inquiry（询单底单） | COMPLETED |
| promotion（推广） | SKIPPED（有意，推广线在 feature/alimama-keyword-report 分支开发中） |

## 8 家店（2 批：b1 5 家 + b2 3 家）

| 店铺 | 批 | 商品 src/planned | 询单 src/planned（剔汇总） |
|---|---|---|---|
| 里可林淘宝 | b1 | 27 / 27 | 4 / 4（剔 2） |
| 网林天猫 | b1 | 14 / 14 | 3 / 3（剔 2） |
| 盖文淘宝 | b1 | 48 / 48 | 8 / 8（剔 2） |
| 盖文天猫 | b1 | 54 / 54 | 17 / 17（剔 2） |
| 科塔淘宝 | b1 | 34 / 34 | 8 / 8（剔 2） |
| 网林淘宝 | b2 | 34 / 34 | 5 / 5（剔 2） |
| 里可林天猫 | b2 | 24 / 24 | 4 / 4（剔 2） |
| 网林家居 | b2 | 4 / 4 | 2 / 2（剔 2） |
| **合计** | | **239** | **51** |

- 商品 planned 合计 239；询单 planned 合计 51。
- 注：网林家居 询单本日 src=2/planned=2（写入成功），即**本日询单 8/8 全成**（历史上的「恒 7/8」缺口本日未出现）。

## 独立回读（base「10月商品监控表-销售1部」，非链自报）

| 表 | 写前 totalRows / onDate | 写后 totalRows / onDate | 真实新增 |
|---|---|---|---|
| 商品表 tbley1xD9wDfQheX | 1914 / 0 | 2153 / 239 | **+239** |
| 询单表 tblenEzSMpp5RTQb | 303 / 0 | 354 / 51 | **+51** |

- 回读脚本：`tmp/readback-oct-sales1-20261005.mjs`；产物 `tmp/readback-2026-10-12-pre.json` / `-post.json`。
- 两阶段独立回读新增数（239 / 51）与 16 份 `plannedRows` 合计**逐值一致**；重复数 0（写前该日 0 行）。
- 链自报 `afterRows`（商品 2153 / 询单 354）与独立回读 totalRows 逐值一致。

## 登录预检 / 视口

- 登录预检 b1/b2 均 `verdict=ALL_IN`，8/8 行 `sites.sycm=LOGGED_IN`、`sites.alimama=LOGGED_IN`、`needsLogin=[]`、`unreadable=[]`、`needHuman=[]`、`unknown=[]`。无人工闸门。
- 视口 b1/b2 全 8 家 1506x642（阈值 1200x600）过闸，`failed=[]`。

## 告警

- `--notify` 为「失败才叫」；本轮成功 ⇒ 未投递（设计行为，非缺口）。

## 释放（独立确认）

- 链自报：`release-b1.json` / `release-b2.json` 均 `released:true`、`stopExitCode=0`。
- 独立回读（PowerShell `Get-NetTCPConnection -LocalPort <p> -State Listen`，两遍，间隔 2s）：
  16 个店铺端口（调试 19031-19035 / 19050-19052，代理 19041-19045 / 19060-19062）
  **两遍全 free**；另 19022/19023 两遍亦 free。产物 `tmp/port-readback-20261013.txt`。
- 残留盘点：店铺 profile 的 msedge = **0**；本仓 node 启动器 = **0**。
  （TOTAL_MSEDGE=24 为默认 Edge 树，非本链，未碰。）

## 未做

- 未改任何代码/配置（runtime/scripts/skills/db/config 下 10:00 后仅新增本轮的 `runtime/start-stop-logs/` 日志）。
- 未起停任何非本链进程；未重跑；未删锁。
- 未触碰销售2部 5 家（整部门停采）。

## 结论

**本轮全绿。** 目标日 2026-10-12 销售1部 8 家商品底单与询单底单两类均完成采集与导入，
真实新增商品 239 行 / 询单 51 行；飞书写入有独立回读佐证；每批浏览器与代理端口全部释放。
推广段 SKIPPED（有意）。
