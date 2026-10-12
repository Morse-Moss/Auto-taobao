# 商品数据采集与导入报告 — 目标日 2026-10-06

结论先行：成功。8/8 家两阶段（商品底单 + 询单）全部采集并写入飞书，退出码 0，
run-receipt `status=COMPLETED`、`failure=null`，无任何失败分类。推广段 SKIPPED（有意）。
每批浏览器与代理端口均已独立复核释放。本次未改任何代码/配置，未起停任何非本链进程。

## 一、基本信息

- 目标日：2026-10-06（Asia/Shanghai，由 `--date yesterday` 解析，命令未写死日期）
- runId：`2026-10-06-20261007021033227-cbeef1b1`
- 命令（原样，一字未改）：
  `node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 起止：2026-10-07T02:10:33Z → 02:20:37Z（10m04s）；退出码 0
- 分批：批1 = 里可林淘宝 / 网林天猫 / 盖文淘宝 / 盖文天猫 / 科塔淘宝（5 家）；
  批2 = 网林淘宝 / 里可林天猫 / 网林家居（3 家）
- 开工前全局运行锁 `runtime/.workflow-locks/merchant-automation.json` 不存在（无占用）

## 二、环境预检 / 登录预检 / 视口

- `environment-preflight.json`：ok=true（node v22.22.2 / python 3.12.9 / 凭据 `E:/小红书/.env.feishu-kcne.local` / 端口唯一 / 根目录正确）
- `login-preflight-b1.json`：`verdict=ALL_IN`，5/5 家 OK，全部 `sycm=LOGGED_IN`、`alimama=LOGGED_IN`，`needHuman=[]`、`unknown=[]`
- `login-preflight-b2.json`：`verdict=ALL_IN`，3/3 家 OK，同上
- 人工闸门：无（无登录/验证码/风控/权限/改版拦截）
- `viewport-b1.json` 5/5、`viewport-b2.json` 3/3：全部 1506x642，过 1200x600 阈值，`failed=[]`

## 三、采集与导入（各店源行数 / 新增 / 重复）

| 店铺 | 商品源行 | 商品新增 | 商品重复 | 询单源行 | 询单新增 | 询单重复 |
|---|---|---|---|---|---|---|
| 里可林淘宝 | 35 | 35 | 0 | 3 | 3 | 0 |
| 网林天猫 | 12 | 12 | 0 | 2 | 2 | 0 |
| 盖文淘宝 | 47 | 47 | 0 | 6 | 6 | 0 |
| 盖文天猫 | 40 | 40 | 0 | 7 | 7 | 0 |
| 科塔淘宝 | 33 | 33 | 0 | 6 | 6 | 0 |
| 网林淘宝 | 33 | 33 | 0 | 2 | 2 | 0 |
| 里可林天猫 | 28 | 28 | 0 | 9 | 9 | 0 |
| 网林家居 | 5 | 5 | 0 | 1 | 1 | 0 |
| **合计** | **233** | **233** | **0** | **36** | **36** | **0** |

- 8 家 × 2 类 = 16 份收据全部存在，`mode=apply`，`plannedRows == sourceRows` ⇒ 本日无重复行被去重闸门拦下（
  说明写前 base 内没有 10-06 行）
- 询单每店 `excludedSummaryRows=2`（合计行按设计剔除，非缺口）

## 四、独立回读（10月商品监控表-销售1部，不经链自身断言）

baseToken `FhCUbn7vVaEc26sRjMAccQJAn5e`；脚本 `tmp/readback-oct-sales1-20261005.mjs`，
落盘 `tmp/readback-2026-10-06.json`：

- 商品表 `tbley1xD9wDfQheX`：`totalRows=681`，`onDate(2026-10-06)=233`
- 询单表 `tblenEzSMpp5RTQb`：`totalRows=100`，`onDate(2026-10-06)=36`
- 写前该日 0 行（10-06 为本轮新目标日，此前 base 仅含 8~9 月残留 1 行 + 10-04 行 + 10-05 行）
  ⇒ **真实新增 = 商品 233 / 询单 36**
- 交叉核对（链自报总行数变化 vs 独立回读逐日计数）：
  - 商品：写前 448 → 写后 681（+233），与回读 onDate 233 逐值一致；
    681 = 1(残留) + 204(10-04) + 243(10-05) + 233(10-06)，完全对平
  - 询单：写前 64 → 写后 100（+36），与回读 onDate 36 逐值一致；
    100 = 1(残留) + 28(10-04) + 35(10-05) + 36(10-06)，完全对平
- 链自报 `plannedRows` 合计（233 / 36）与独立回读逐值一致

## 五、推广段

`SKIPPED`（有意：推广线在 `feature/alimama-keyword-report` 分支开发中，本阶段不跑）。
收据 `stages.promotion.status = "SKIPPED"`。**非缺口，不计入失败，也不为它重跑。**

## 六、告警

`--notify` 按脚本口径「失败才叫人」（成功不叫，与日报链同一口径）。
本次 `status=0` ⇒ 未投递告警，属设计行为，非缺口。

## 七、释放（独立复核，不信脚本退出码）

- 16 个店铺端口（19031-19035 / 19050-19052 浏览器 + 19041-19045 / 19060-19062 代理）
  两次 `Get-NetTCPConnection -LocalPort <p> -State Listen` 回读：**全部 free**
- `runtime/browser-inventory.mjs`：8 家店铺实例「整套缺」（浏览器 free、代理连不上），与端口回读一致
- `release-b1.json` / `release-b2.json`：`released=true`，两次 checks `listening=0`（与独立复核一致）
- 本次跑窗口（10:05 之后）新建 msedge 数 = **0**（进程盘点）

## 八、失败分类

**COMPLETED**。无 `TRANSIENT_EXTERNAL` / `HUMAN_REQUIRED` / `UNKNOWN_WRITE` / `FAILED`。
`run-receipt.json`：`stages=[product:COMPLETED, inquiry:COMPLETED, promotion:SKIPPED]`，`failure=null`。

## 九、残留（既存，本次未动）

- `19022` / `19023` 日报共享商家浏览器：开工前即在监听（属既存进程，未碰）
- msedge 残体：`edge-daily-report-profile` 17 个、`login-agreement-1006-h16lhs` 17 个，
  创建时间均为 10-06 22:2x，**非本次产生**
