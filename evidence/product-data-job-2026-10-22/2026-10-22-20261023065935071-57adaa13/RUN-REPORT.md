# 2026-10-22 商品数据补齐 · 运行报告

- runId：`2026-10-22-20261023065935071-57adaa13`
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 3`
- 目标日：2026-10-22（`yesterday` 由 Asia/Shanghai 解析）
- 覆盖：8 店（`productDataCollectingShopKeys()`），销售2部 5 家未参与（`SHOPS_NOT_COLLECTING_YET`）
- **链的退出码：0**
- 耗时 19m26s（06:59:35Z → 07:18:59Z），3 批（3+3+2），每批跑完即释放

## 收了什么

| 阶段 | 结果 |
|---|---|
| 商品底单 | 8/8 已采集 + 8/8 已写入 |
| 询单 | 8/8 已落盘 + 8/8 已写入 |
| 推广 | 8/8 已采集 + 3 批均已批量写入 |
| 收据 | `status=COMPLETED`、三 stage 全 COMPLETED、`failure=null` |
| 完成提醒 | `alertId=product-ok-20261022`、`delivered=true` |

## 独立回读（跑前一次、跑后一次，相减得真实新增）

底单表 `10月商品监控表-销售1部`，日期字段分别为 商品=统计日期 / 询单=数据日期 / 推广=日期。

| 表 | 跑前 total/onDate | 跑后 total/onDate | 真实新增 |
|---|---|---|---|
| 商品底单 | 4974 / 267 | 4974 / 267 | **+0** |
| 询单 | 981 / 6 | 1026 / 51 | **+45** |
| 推广 | 2553 / 16 | 2670 / 133 | **+117** |

商品底单 +0 是预期：前几轮已 8/8 写入，本轮按（统计日期+商品ID）去重后无新行。

## 释放

26 个店铺端口（13 店 × 调试/代理）用 `Get-NetTCPConnection -LocalPort <p> -State Listen` 回读两遍，
两遍监听数均为 0；链自报每批 `已释放并完成端口二次回读`（b1/b2/b3 各一份 `release-bN.json`）。

## 失败分类

无失败。分类口径下本轮为 **COMPLETED**。

## 本轮修的是什么（1.12.16，提交 78921e92）

前面几轮询单 0/8 的真因不是「页面没渲染」，是判据在测自己：

1. 词表两份拷贝 —— `collect-inquiry-report.mjs` 那份还含 `统计时间`，而每个业绩页都有它
   ⇒ 进轮询前就在总览页判「已在询单页」⇒ 循环一次没进、从不点「商品分析」⇒ 导出按钮恒 0、link 恒空。
   已改为直接 import `INQUIRY_PAGE_MARKERS`。
2. `isInquiryPage` / `planEntryPollStep` 把「商品咨询分析」文案当「报表已加载」，父菜单一展开文案就在；
   现在只认「询单人数」与导出按钮在场，并补 `click-entry`（必须真点开子项）。
3. 同实例两个 sycm 页签时「取第一个」会读到商品排行 `/cc/item_rank`；新增 `pickWorkPage()` 锁业绩页。

## 待办（已记录，未擅动）

- `promotion-import/sales1/receipt.json` 按批覆写，只留最后一批 ⇒ 完成提醒里「商品推广 17 行」
  小于真实写入 117 行。判写入只认独立回读。
- 既有红灯：`runtime/arch-boundary.test.mjs` 第 2 条（`runtime/daily-job-plan.test.mjs` 未登记），
  该文件自 2026-10-20 起未改，与本次改动无关。
