# 商品数据链运行报告 — 目标日 2026-10-20

- **退出码：1（FAILED）** — 本轮失败
- runId：`2026-10-20-20261021020935851-88972158`
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`
- 版本：1.12.11（HEAD `2a00d98`）；开始 10:09:38、结束 10:40:48，耗时 31m13s
- run-receipt：`FAILED / TRANSIENT_EXTERNAL / EXTERNAL_RETRYABLE / failedStage=inquiry-import`
  （product=COMPLETED / inquiry=FAILED / promotion=FAILED）
- 告警：`SENT`，alertId `product-round-20261020`，exit 0

## 前置闸门

| 项 | 结果 |
|---|---|
| 全局锁 `merchant-automation.json` | 开工前不存在（锁目录为空）；跑完仍为空 |
| 环境预检 | ok=true（node v22.22.2 / python 3.12.9 / 28 端口唯一） |
| 飞书目标预检 | ok=true，`10月商品监控表-销售1部` 三表 status=OK（rcnb 凭据，73/39/82 字段） |
| 登录预检 b1 | `ALL_IN`，needHuman=[]；5 家 sycm/alimama 均 LOGGED_IN |
| 登录预检 b2 | `ALL_IN`，needHuman=[] |
| 视口 b1/b2 | 8/8 家 1506x642，failed=[] |

注：b1 归位阶段「盖文淘宝」报 `归位后仍不齐（工作页=0 阿里妈妈=1）`，但探针结论仍为 OK；后续该店底单采集成功、询单失败，见下。

## 采集与导入逐店

| 店铺 | 商品底单 src/planned | 询单 src/planned | 推广 src/planned |
|---|---|---|---|
| 里可林淘宝 | 29/29 | 6/6 | 16/16 |
| 网林天猫 | 22/22 | 4/4 | 13/13 |
| 盖文淘宝 | 39/39 | **未采** | **未采** |
| 盖文天猫 | 56/56 | 15/15 | 26/26 |
| 科塔淘宝 | 36/36 | 12/12 | 20/20 |
| 网林淘宝 | 31/31 | 6/6 | 25/25 |
| 里可林天猫 | 24/24 | 6/6 | **未采** |
| 网林家居 | 4/4 | **未采** | **未采** |
| **合计** | **241/241** | **49/49**（6 家） | **100/100**（5 家） |

重复数：三段全部为 0（src == planned 逐家相等）。

## 独立回读（飞书，跑前/跑后各一次，非链自报）

| 表 | 跑前 total / 目标日 | 跑后 total / 目标日 | 真实新增 |
|---|---|---|---|
| 商品底单（统计日期） | 4221 / 0 | 4462 / 241 | **241** |
| 询单（数据日期） | 891 / 1 | 940 / 50 | **49** |
| 推广（日期） | 2327 / 0 | 2427 / 100 | **100** |

与收据 plannedRows 合计逐值一致。询单开工前目标日已有 1 行为非本轮写入（历史遗留），故 50 − 1 = 49。

## 5 处缺口（全部为采集段，非登录）

1. **盖文淘宝 / 询单**：`找不到商品咨询分析入口（轮询 30s 仍未出现）`，stoppedAt=inquiry-collect。
   现场 `inquiry.xls.failure.json`：工作页 URL 正常、readyState=complete、`shop=盖文全卫定制`、
   `hasParent=false / hasInquiry=false / exactInquiry=0` ⇒ SPA 未渲染出「商品分析」父菜单。非登录问题。
2. **盖文淘宝 / 推广**：同店在询单失败后 `stoppedAt` 提前终止，推广段未执行（连带，非独立故障）。
3. **里可林天猫 / 推广**：`[候选] 商品报表_20261021_103449 第 1 次取不到：商品报表任务下载入口不可见`，
   随后 `CDP 命令超时: Runtime.evaluate`（HTTP 500），exit 1；现场 `promotion-collect/98-failure-*` 已落。
4. **网林家居 / 询单**：`页面状态不满足：{"shop":"网林定制家居","hasInquiry":true,"date":"2026-10-20","daySelected":true,"link":""}`
   ⇒ 入口可见、日期正确，但下载链接为空（页面未渲染完成）。
5. **网林家居 / 推广**：同店在询单失败后提前终止，推广段未执行（连带）。

## 释放独立确认

- b1/b2 两批 `released:true`、`stopExitCode=0`、两次 `checks.listening=0`。
- PowerShell `Get-NetTCPConnection -LocalPort <p> -State Listen` 两遍回读，26 个店铺端口（调试 19031-19035/19050-19052、
  代理 19041-19045/19060-19062）全部 free，两遍一致。
- 19022/19023 两遍 free；`browser-inventory.mjs` 15 个实例全部「整套缺」；锁目录为空。

## 结论

商品底单 8/8 完成、询单 6/8、推广 5/8。飞书写入有独立回读佐证。释放全部确认。
失败分类 `TRANSIENT_EXTERNAL / EXTERNAL_RETRYABLE` 判读成立（三家失败均为平台侧 SPA/导出回吐间歇故障，
无一家登录被踢、无权限错误）。未重跑、未改代码、未起停任何非本链进程。
