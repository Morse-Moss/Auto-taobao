# 商品数据每日采集与导入 — 运行报告

- 目标日（Asia/Shanghai）：**2026-10-13**（执行日 2026-10-14，`--date yesterday`）
- runId：`2026-10-13-20261014020428881-1e580743`
- 命令（原样，未改任何参数）：
  `node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 耗时：11m46s；**退出码 0**
- 开工前 HEAD `13009d4`（VERSION 1.8.14）；开工前锁文件不存在（无锁冲突，未删锁）

## 结论

**全绿。** 8 家（销售1部参与采集口径）商品底单与询单两阶段均完成采集与导入，飞书写入有独立回读佐证，两批浏览器与代理端口全部释放。

## 链自报（run-receipt.json）

- `status=COMPLETED`、`failure=null`、`failedStage=null`
- stages：product=`COMPLETED`、inquiry=`COMPLETED`、promotion=`SKIPPED`（有意跳过）
- completionNotice：`delivered=true`、`suppressed=false`、alertId `product-ok-20261013`

## 独立回读（base＝10月商品监控表-销售1部，非链自报）

| 表 | 写前 total / 该日 | 写后 total / 该日 | 真实新增 |
|---|---|---|---|
| 商品底单 | 2153 / 0 | 2392 / 239 | **+239** |
| 商品询单 | 354 / 0 | 397 / 43 | **+43** |

写后 totalRows 2392/397 与 16 份收据 `afterRows` 末值逐值一致；写前基线为当场实测（非历史常量）。

## 分店明细（源行数 / 计划写入 / 重复）

底单（product-import/receipt.json）与询单（inquiry-import/receipt-<店>.json）：

| 店铺 | 底单 src/planned | 询单 src/planned | 询单剔除汇总行 |
|---|---|---|---|
| 里可林淘宝 | 25 / 25 | 4 / 4 | 2 |
| 网林天猫 | 17 / 17 | 5 / 5 | 2 |
| 盖文淘宝 | 48 / 48 | 8 / 8 | 2 |
| 盖文天猫 | 50 / 50 | 14 / 14 | 2 |
| 科塔淘宝 | 32 / 32 | 4 / 4 | 2 |
| 网林淘宝 | 39 / 39 | 4 / 4 | 2 |
| 里可林天猫 | 23 / 23 | 3 / 3 | 2 |
| 网林家居 | 5 / 5 | 1 / 1 | 2 |
| **合计** | **239 / 239** | **43 / 43** | 16 |

sourceRows 与 plannedRows 逐家相等 ⇒ **重复数 0**（目标日为新日，无同日重复行）。8 家询单全成，历史「恒 7/8」（网林家居缺）本轮未出现。

## 批次与闸门

- 2 批：b1＝里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝；b2＝网林淘宝、里可林天猫、网林家居。
- 登录预检 b1/b2 均 `ALL_IN`，8/8 家 `sycm=LOGGED_IN`、`alimama=LOGGED_IN`，`needHuman=[]`、`unknown=[]` ⇒ **无人工闸门**。
- 视口 b1/b2 8/8 家 1506x642 全过闸（阈值 1200x600）。
- 底单串行、询单并行，两批均「采集→导入→释放」完整走完；盖文天猫底单第 1 次尝试未取到文件、第 2 次成功（采集脚本自带重试，非缺口）。

## 推广段

`SKIPPED`（`--skip-promotion` 有意跳过，推广线在 `feature/alimama-keyword-report` 分支开发中）。**不是缺口，未重跑**。

## 释放（独立确认，非只信释放脚本退出码）

- 批次收据 release-b1/release-b2：均 `stopExitCode=0`、两次端口检查 `listening=0`、`released=true`。
- 我自己的独立回读：PowerShell `Get-NetTCPConnection -State Listen` 对 29 个登记端口两遍**全 free**。
- `browser-inventory.mjs`：15 个声明实例**全部「整套缺」**（浏览器与代理都没起来）。
- 店铺 profile 的 msedge = **0**；本仓启动器 node = **0**（残留 16 个 msedge 全属用户默认 Edge 树，非本链）。

## 其他

- 告警投递：`status=SENT`、`channel=app`、`ok=true`、target `ou_e254...`（完成提醒，非失败告警）。
- 未改任何代码/配置：运行窗口内 `scripts/runtime/skills/db/config` 无文件被改（仅新增本链 `runtime/start-stop-logs/`）。
- 未起停任何非本链进程；锁目录跑完仍为空（未删任何锁文件）。
- 销售2部 5 家（`SHOPS_NOT_COLLECTING_YET`）未纳入、未触碰、未计入成败。
