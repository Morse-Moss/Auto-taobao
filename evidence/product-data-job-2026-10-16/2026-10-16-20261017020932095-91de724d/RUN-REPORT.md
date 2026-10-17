# 商品数据定时跑 · 2026-10-16 · 运行报告

- 命令（原样执行，未加任何额外参数）：
  `node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`
- 目标日：**2026-10-16**（执行日 2026-10-17 10:09，Asia/Shanghai 解析 `yesterday`）
- runId：`2026-10-16-20261017020932095-91de724d`
- 耗时：15m24s（10:09:32 → 10:24:56）
- **退出码 1**；run-receipt `status=FAILED`、`failedStage=product-import`
- 告警：`SENT`（`alertId=product-round-20261016`，severity ERROR）
- 开工前 `runtime/.workflow-locks/merchant-automation.json` 不存在；结束后亦不存在（未删锁）

## 结论

**采集全成、写入全灭。** 8 家店 × 3 段（商品底单/询单/推广）**24 份采集产物全部生成**，
但 **24 次导入全部 403**，飞书上一个字没写。根因不在本链逻辑，而在
**「商品/推广链的飞书 base 已在 2026-10-16 换到外组织 rcnb，写入口却仍用本组织 kcne 凭据」**——
即 `evidence/credential-landmine-20261016/README.md` 已记录在案的「凭据地雷」，本轮是它第一次真机发作。

## 采集（8/8 全成，code=0）

| 店铺 | 商品底单源行 | 询单源行 | 推广源行 | 推广日期自证 |
| --- | --- | --- | --- | --- |
| 里可林淘宝 | 20 | 5 | 16 | 2026-10-16 |
| 网林天猫 | 23 | 3 | 13 | 2026-10-16 |
| 盖文淘宝 | 49 | 6 | 16 | 2026-10-16 |
| 盖文天猫 | 44 | 11 | 26 | 2026-10-16 |
| 科塔淘宝 | 27 | 6 | 20 | 2026-10-16 |
| 网林淘宝 | 43 | 5 | 25 | 2026-10-16 |
| 里可林天猫 | 28 | 1 | 17 | 2026-10-16 |
| 网林家居 | 5 | 0 | 4 | 2026-10-16 |
| **合计** | **239** | **37** | **137** | |

- 源行数是本轮用三个导入器**自己的解析函数**从产物文件里数出来的（导入未成 ⇒ 没有 import 收据可读），
  口径与导入一致（商品 38 列表头＋统计日期过滤；询单 `parseInquiryRows`；推广 `validatePromotionReport`）。
- 网林家居 / 询单 0 行＝历史已知现象（汇总行被剔除，`src=0`），非本轮新缺陷。
- 推广段 8/8 采到且导出文件里的日期全是 2026-10-16（不是 10-17，日期没错位）。

## 导入（24/24 全失败，403 91403）

- 每个失败点都是同一句：`Error: Feishu API failed: 403 91403 Forbidden`。
  商品/询单停在 `feishu-client.listRecords()`；推广停在 `listFields()`（取目标表字段名）。
  **都在「读既存去重」这一步就死了，一行都没写。**
- 证据目录下**零 import 收据**（`find … -name 'receipt*'` 空），与「未写入」一致。

## 独立回读（rcnb 组织应用凭据，非链自报）

| 表 | 日期字段 | 跑前（10-16 行数 / 总行数） | 跑后（10-16 行数 / 总行数） | 真实新增 |
| --- | --- | --- | --- | --- |
| 商品底单 `tblvmGJfOL4OBYek` | 统计日期 | 0 / 3486 | 0 / 3486 | **0** |
| 询单底单 `tblb1uK5zQYd8yOq` | 数据日期 | 1 / 774 | 1 / 774 | **0** |
| 推广底单 `tblDxXenp3vSg2SM` | 日期 | 0 / 1916 | 0 / 1916 | **0** |

- 落盘：`tmp/product-baseline-2026-10-16-pre.json` / `-post.json`（总行数逐表相同，确认零写入）。
- 询单那张 10-16 的 1 行是**跑前就有**的（空骨架），不是本轮写的。
- ⚠️ 回读脚本第一版把询单/推广的日期字段写成了「统计日期」，两张表都量出 0 行而它们各有上千行历史
  ⇒ 已按实测字段名（商品=统计日期 / 询单=数据日期 / 推广=日期）改正并复测。「量不到」不等于「没有」。

## 凭据实测（本轮当场取，非引用旧结论）

| 表 | kcne 应用 `cli_a96ee8749078dbcf` | rcnb 应用 `cli_aa5b5b983dfadc2c` |
| --- | --- | --- |
| 商品底单 | 403 91403 | OK 3486 行 |
| 询单底单 | 403 91403 | OK 774 行 |
| 推广底单（商品链） | 403 91403 | OK 1916 行 |
| 推广日报关键词 / 人群 | OK 516 / 666 | OK 516 / 666 |

⇒ kcne 对「10月商品监控表-销售1部」这张 base **连读都不行**（不是只读、是完全无权）。
`af63b71`（2026-10-16 17:54）把商品 base 换到 rcnb 组织，而三个写入口
（`import-product-data.mjs:24`、`import-inquiry-data.mjs:13`、`import-promotion-data.mjs:17`）
仍是 `loadFeishuCredentials('kcne')` ⇒ 本轮必然全灭。

环境预检为什么没拦住：`environment-preflight.json` 的 `feishu-credentials` 只验「凭据文件存在」，
不验「这张 base 认不认这份凭据」。

## 闸门与释放

- 登录预检：b1/b2 均 `verdict=ALL_IN`，`needHuman=[]`、`unknown=[]`；两批都做了页面归位（工作页 0→1、报表页 0→1）。**无人工闸门**。
- 视口：b1 5 家 / b2 3 家 全部 1506x642 ≥ 阈值 1200x600，`failed=[]`。
- 释放：`release-b1.json` / `release-b2.json` 均 `released:true`、两次 `listening=0`；
  **独立复核**（`tmp/port-readback-20261017.txt`）：16 个店铺端口（19031-19035 / 19041-19045 / 19050-19052 / 19060-19062）
  两轮 `Get-NetTCPConnection` 全 free，`listening_lines=0`；`browser-inventory.mjs` 判 8 家「整套缺」。
- `19022/19023`（日报链商家浏览器/代理）仍占用，**非本链所起、未碰**。

## 失败分类

- 链自报：`FAILED / UNCLASSIFIED`，`failedStage=product-import`。
- 按文档口径的**正确分类应是 `HUMAN_REQUIRED`（权限）**：403/91403 是权限闸门，不是瞬时外部故障、也不是未知写入。
  ⇒ `classifyWorkflowError` 的成因表里缺「飞书 403/91403 ⇒ HUMAN_REQUIRED」这条映射（本轮未改代码）。

## 未做（纪律）

- 未改任何代码/配置（10:00 后仅 `runtime/alert-throttle.json` 被链自己写，属告警节流状态）。
- 未重跑、未改参数、未加 `--skip-promotion`。
- 未起停任何非本链进程；未删锁；未动销售2部 5 家（`PRODUCT_DATA_STOPPED_SHOPS` 范围内，本就未列入本轮）。
- 新增文件仅在 `tmp/`（探针与回读脚本），不属于交付代码。

## 修法（待授权，本轮未动手）

1. `runtime/feishu-targets.mjs`：给 `PRODUCT_DATA_MONTH_BASES['2026-10:sales1'/'2026-10:sales2']` 与
   `PROMOTION_DAILY_MONTH_BASES['2026-10:sales1']` 各加 `envFile: 'E:/小红书/.env.feishu-rcnb.local'`。
2. 新增按 target 解析凭据的访问器（把 `dailyReportCredentials` 泛化成 `targetCredentials(target)`）。
3. 三个写入口（商品/询单/推广）从 `loadFeishuCredentials('kcne')` 切过去；推广日报入口同理。
4. **先探针后切换**：每张 base 跑一次幂等写探针（把某行某字段原样写回），`200/code 0` 才算通。
5. 三个失败分类补 403/91403 ⇒ `HUMAN_REQUIRED`。
