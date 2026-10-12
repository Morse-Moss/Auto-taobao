# 商品数据补跑报告 — 目标日 2026-10-09

结论：成功（COMPLETED）。8 家（参与采集口径）商品底单与询单两阶段均完成采集与飞书写入，
独立回读佐证新增 254（商品）+ 45（询单）行，每批浏览器与代理端口全部释放，退出码 0。
本轮为补跑：今天 10:00 因登录侧改代码被人工停掉，2026-10-09 目标日此前无 evidence。

## 运行标识
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- runId：`2026-10-09-20261010023731455-5388c124`
- date 解析：`--date yesterday` → **2026-10-09**（Asia/Shanghai）
- 起始提交：`db686e8`（1.7.17，登录滑块判据认同源 iframe）
- 开工锁：`runtime/.workflow-locks/merchant-automation.json` 不存在 → 无冲突
- 运行区间：2026-10-10T02:37:31Z → 02:49:05Z（约 11 分 35 秒）
- 退出码：**0**

## 两阶段逐店（源行数 / 新增 / 重复）
商品底单（product，串行采集、逐店导入）：

| 店铺 | sourceRows | 新增 | 重复 |
|---|---|---|---|
| 里可林淘宝 | 31 | 31 | 0 |
| 网林天猫 | 15 | 15 | 0 |
| 盖文淘宝 | 51 | 51 | 0 |
| 盖文天猫 | 56 | 56 | 0 |
| 科塔淘宝 | 37 | 37 | 0 |
| 网林淘宝 | 38 | 38 | 0 |
| 里可林天猫 | 21 | 21 | 0 |
| 网林家居 | 5 | 5 | 0 |
| **合计** | **254** | **254** | **0** |

询单（inquiry，显式 --out、逐店导入）：

| 店铺 | sourceRows | 新增 | 重复 |
|---|---|---|---|
| 里可林淘宝 | 6 | 6 | 0 |
| 网林天猫 | 3 | 3 | 0 |
| 盖文淘宝 | 6 | 6 | 0 |
| 盖文天猫 | 12 | 12 | 0 |
| 科塔淘宝 | 8 | 8 | 0 |
| 网林淘宝 | 5 | 5 | 0 |
| 里可林天猫 | 5 | 5 | 0 |
| 网林家居 | 0 | 0 | 0 |
| **合计** | **45** | **45** | **0** |

说明：网林家居询单 sourceRows=0 属**平台空态**（导出只有表头/提示行），按口径不补 0、不算缺口。

## 推广段
SKIPPED（有意跳过）：`推广线在分支开发中（feature/alimama-keyword-report），本阶段有意跳过`。

## 飞书回读（独立，非链自证）
飞书落点：base `10月商品监控表-销售1部`（baseToken `FhCUbn7vVaEc26sRjMAccQJAn5e`）。
- 商品底单表 `tbley1xD9wDfQheX`：开工前 2026-10-09 = 0（总 1167）；跑后 = **254**（总 1421）→ 真实新增 **+254**。
- 询单底单表 `tblenEzSMpp5RTQb`：开工前 2026-10-09 = 0（总 181）；跑后 = **45**（总 226）→ 真实新增 **+45**。
基线为当日实测（非固定常量），探针：`D:/Retire/probe-live/baseline-product-2026-10-09.mjs`；
跑前结果 `baseline-product-2026-10-09.pre.json`，跑后 `product-data-2026-10-09.readback.json`。

## 登录与视口
- 第 1 批（里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝）：首次预检网林天猫 阿里妈妈 UNREADABLE →
  触发补页 → 复查 ALL_IN，5/5 OK。
- 第 2 批（网林淘宝、里可林天猫、网林家居）：首次 ALL_IN，3/3 OK。
- 两批视口回读均通过：全部 1506x642（阈值 1200x600）。

## 释放（独立端口回读）
- 批 1 `release-b1.json` / 批 2 `release-b2.json`：`released:true`、两次回读 listening=0。
- 独立复核（PowerShell `Get-NetTCPConnection -State Listen` 两次）：
  16 个端口（19031/19041、19032/19042、19033/19043、19034/19044、19035/19045、19050/19060、19051/19061、19052/19062）
  两次读取 **listeningCount 均为 0**（`product-data-2026-10-09.ports.json`）。
- `browser-inventory.mjs` 复核：8 家浏览器=free、代理=连不上。

## 收据与失败分类
- `run-receipt.json`：status **COMPLETED**；stages product=COMPLETED / inquiry=COMPLETED / promotion=SKIPPED；
  failure=null，failedStage=null。
- 无 `alert.json`（成功路径不告警）。

## 覆盖口径
参与采集 8 家＝`collectingShopKeys()`（销售1部），与 `PRODUCT_DATA_MONTH_BASES['2026-10:sales1']` 一致。
销售2部 5 家（`SHOPS_NOT_COLLECTING_YET`）本部门停采，未触碰、未计入成败。
