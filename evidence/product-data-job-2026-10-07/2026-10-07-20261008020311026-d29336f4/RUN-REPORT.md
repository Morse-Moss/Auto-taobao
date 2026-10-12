# 商品数据采集与导入 运行报告

- 目标日：2026-10-07（`--date yesterday`，按 Asia/Shanghai 解析；执行日 2026-10-08）
- runId：`2026-10-07-20261008020311026-d29336f4`
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 版本次：仓库 HEAD `3268a6f`，VERSION `1.7.15`
- 退出码：**0**；run-receipt `status=COMPLETED`、`failure=null`、`failedStage=null`
- 耗时：10m54s（10:03:11 → 10:14:04 +08）

## 结论

成功。8/8 家两阶段（商品底单、询单）全部完成采集与导入；独立回读与链自报逐值一致；两批浏览器与代理端口全部释放。

## 阶段状态

| 阶段 | 状态 |
| --- | --- |
| product | COMPLETED |
| inquiry | COMPLETED |
| promotion | SKIPPED（有意，推广线在分支开发） |

## 开工前检查

- 全局运行锁 `runtime/.workflow-locks/merchant-automation.json`：**不存在**（两种方法各确认一次）⇒ 无并发、未删锁。
- environment-preflight：node v22.22.2 / python 3.12.9 / 飞书凭据 `E:/小红书/.env.feishu-kcne.local` / 端口唯一性 / project-root 全 ok。

## 分批与人工闸门

- 第 1 批（5 家）：里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝 → 登录预检 `ALL_IN`，5/5 `OK`（sycm、alimama 均 LOGGED_IN）。
- 第 2 批（3 家）：网林淘宝、里可林天猫、网林家居 → 登录预检 `ALL_IN`，3/3 `OK`。
- 两批 `roundNotify=SKIPPED`、`needHuman=[]`、`unknown=[]` ⇒ **无人工闸门**（本次 3 家首次跑商品链的店也未触发登录/风控）。
- 视口回读：8/8 = 1506x642（阈值 1200x600），`failed=[]`。

## 各店源行数与写入

| 店铺 | 商品 源/写入 | 商品 写后累计 | 询单 源/写入 | 询单 写后累计 |
| --- | --- | --- | --- | --- |
| 里可林淘宝 | 28 / 28 | 709 | 3 / 3 | 103 |
| 网林天猫 | 13 / 13 | 722 | 2 / 2 | 105 |
| 盖文淘宝 | 40 / 40 | 762 | 6 / 6 | 111 |
| 盖文天猫 | 50 / 50 | 812 | 10 / 10 | 121 |
| 科塔淘宝 | 35 / 35 | 847 | 7 / 7 | 128 |
| 网林淘宝 | 26 / 26 | 873 | 1 / 1 | 129 |
| 里可林天猫 | 26 / 26 | 899 | 7 / 7 | 136 |
| 网林家居 | 6 / 6 | 905 | 0 / 0 | 136 |
| 合计 | 224 / 224 | 905 | 36 / 36 | 136 |

收据字段：每店 `plannedRows == sourceRows`，无重复（existingRows 逐店递增 681→905 / 100→136）。

## 独立回读（不经过链自己的断言）

工具：`tmp/readback-oct-sales1-20261005.mjs`（10 月销售1部 base，baseToken `FhCUbn7vVaEc26sRjMAccQJAn5e`，商品表 `tbley1xD9wDfQheX`，询单表 `tblenEzSMpp5RTQb`）。

| 时点 | 商品表 totalRows | 商品表 2026-10-07 | 询单表 totalRows | 询单表 2026-10-07 |
| --- | --- | --- | --- | --- |
| 写前 10:03:40 | 681 | 0 | 100 | 0 |
| 写后 10:14:45 | 905 | 224 | 136 | 36 |

- 真实新增：**商品 224 行、询单 36 行**（+681→905 = 224；100→136 = 36）。
- 与 16 份 `plannedRows` 合计 **224 / 36 逐值一致**；与链自报写后 `afterRows` 905 / 136 逐值一致。

## 释放确认（不信释放脚本退出码）

- `release-b1.json` / `release-b2.json`：`released=true`、两次 checks `listening=0`。
- 独立端口回读：8 家 16 个端口（19031/19041、19032/19042、19033/19043、19034/19044、19035/19045、19050/19060、19051/19061、19052/19062）**两遍全 free**。
- `runtime/browser-inventory.mjs`：15 个声明实例全部「整套缺」（浏览器与代理都没起来）。
- 8 个店铺 profile 的 msedge 进程独立扫描 = **0**（系统共 21 个 msedge，均不属本链 profile）。

## 告警

`--notify` 仅在失败时投递 ⇒ 本轮成功、未投递（设计行为，非缺口）。

## 已知缺口（非本轮新缺陷）

- 网林家居 询单 `sourceRows=0 / plannedRows=0`（源文件 2 行为汇总行，`excludedSummaryRows=2`）。这是长期存在的「询单恒 7/8」现象：该店询单表多数日期无数据，属平台空态，按口径不填 0。8 家名单完整（有测试钉住），非采集失败。

## 口径说明

- 原任务描述里「回读 2026-10-04 行数、与写前基线（1 行 / 1 行）相减」是 2026-10-05 那轮的旧措辞；本轮实际目标日为 2026-10-07，基线按 2026-10-07 现测（0 / 0）计算。

## 未做的事

- 未改任何代码或配置（mtime 核查：`scripts/`、`runtime/`、`skills/`、`db/`、`config/` 无一文件在 10:00 后被改；`VERSION`/`CHANGELOG.md`/`package.json` 停在 10-07 21:29）。
- 未起停任何非本链进程；未重跑；未删锁；未反复重试登录。
