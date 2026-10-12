# 商品数据每日采集与导入 — 执行报告

- 目标日：2026-10-11（命令 `--date yesterday`，Asia/Shanghai 解析；执行日 2026-10-12）
- runId：`2026-10-11-20261012021018839-414b7a23`
- 命令（原样，未改任何参数）：
  `node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 口径：参与采集 8 家＝里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝、网林淘宝、里可林天猫、网林家居（`collectingShopKeys()`）。销售2部 5 家未参与。
- 飞书落点：`10月商品监控表-销售1部`（baseToken `FhCUbn7vVaEc26sRjMAccQJAn5e`）
- 开工前全局锁：`runtime/.workflow-locks/merchant-automation.json` 不存在 ⇒ 无冲突；跑完锁目录仍为空（未删锁）。
- 耗时：02:10:19 → 02:21:39（约 11m20s）
- 退出码：**1（FAILED）**
- 告警：`alert.json` ERROR，`product-data-2026-10-11`；job.log 记「告警投递：SENT（exit 0）」

## 结论

7/8 家两阶段（商品底单＋询单）采集并成功写入飞书，独立回读佐证；**唯一缺口＝里可林天猫/商品底单**（采集阶段「下载超时」，两阶段均未跑）。
推广段＝SKIPPED（有意，非缺口）。两批浏览器与代理端口全部释放（独立端口回读复核）。

## 两阶段逐店（源行数 / 新增数）

| 店铺 | 商品底单 源行 → 新增 | 询单 源行 → 新增 | 备注 |
|---|---|---|---|
| 里可林淘宝 | 29 → 29 | 4 → 4 | 询单剔汇总行 2 |
| 网林天猫 | 17 → 17 | 3 → 3 | 询单剔汇总行 2 |
| 盖文淘宝 | 40 → 40 | 4 → 4 | 询单剔汇总行 2 |
| 盖文天猫 | 46 → 46 | 14 → 14 | 询单剔汇总行 2 |
| 科塔淘宝 | 37 → 37 | 7 → 7 | 询单剔汇总行 2 |
| 网林淘宝 | 42 → 42 | 2 → 2 | 询单剔汇总行 2 |
| 里可林天猫 | — 未采集 | — 未采集 | 停 product-collect |
| 网林家居 | 4 → 4 | 0 → 0 | 询单源 2 行汇总行全剔除（已知现象） |
| **合计** | **215 → 215** | **34 → 34** | 重复 0 |

- 「新增数」＝各店 `product-import/receipt.json` / `inquiry-import/receipt-*.json` 的 `plannedRows`，合计 215/34。
- 重复数：`existingRows` 逐店增量恰好等于 `plannedRows`（无去重跳过）⇒ 重复 0。

## 独立回读（非链自报，同一脚本 `tmp/readback-oct-sales1-20261005.mjs`）

| 时点 | 商品 totalRows / 当日 | 询单 totalRows / 当日 |
|---|---|---|
| 写前（基线） | 1673 / **0** | 266 / **0** |
| 写后 | 1888 / **215** | 300 / **34** |

⇒ 真实新增 **商品 215 行 / 询单 34 行**，与 16 份收据 `plannedRows` 合计逐值一致。
写后 totalRows 1888/300 与链自报 `afterRows`（1888/300）逐值一致。

## 登录 / 视口 / 分批

- 登录预检：b1（5 家）`verdict=ALL_IN`、b2（3 家）`verdict=ALL_IN`；逐店 sycm/alimama 均 `LOGGED_IN`。**无人工闸门**。
  （盖文天猫 sycm href 带 `custom/login.htm?_target=`、alimama href 带 `#!/login/index`，但探针判定 `LOGGED_IN`、该店最终采集与写入均成功。）
- 视口：b1 5 家、b2 3 家全 `1506x642`，过闸（阈值 1200x600）。
- 分批：b1＝里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝；b2＝网林淘宝、里可林天猫、网林家居。每批跑完即释放。

## 推广段

`promotion = SKIPPED`（有意；推广线在 `feature/alimama-keyword-report` 分支开发中）。**非缺口，未重跑。**

## run-receipt 状态与失败分类

- `status=FAILED`；stages：product=FAILED / inquiry=COMPLETED / promotion=SKIPPED。
- `failure.class=FAILED`、`reason=UNCLASSIFIED`、message＝「本轮不完整（1 处）：里可林天猫/底单 未采集」。
- 收据 `failedStage=product-import`，但实际停在 **product-collect**（`collection-b2.json` 记 `stoppedAt:"product-collect"`）——与既往同类误标一致。
- 按文档口径归因：非登录/验证码/风控/权限/页面改版（登录预检全绿、身份闸门与「日」按钮/下载按钮就绪判据均通过），属**平台导出未在 30s 内回吐文件**一类间歇性故障（与既有缺陷 ⑤ 同族）。链未自行重试该店。**未重跑**（按任务要求只跑给定一条命令）。

## 释放复核（不只看退出码）

- `release-b1.json` / `release-b2.json`：`released:true`，各两次 `listening:0`。
- 独立复核：PowerShell `Get-NetTCPConnection -LocalPort <p> -State Listen` 对 28 个登记端口（含 19022/19023）**两遍回读全 free**。
- 未起停任何非本链进程；未改任何代码/配置（10:00 后 scripts/runtime/skills/db/config 无文件被改，`runtime/alert-throttle.json` 为告警节流状态）。
