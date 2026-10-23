# 商品数据链运行报告 · 目标日 2026-10-21（销售1部 8 家）

- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`
- 退出码：**1（本轮失败）**
- runId：`2026-10-21-20261022021253864-e1dbdbf9`
- 开工前锁 `runtime/.workflow-locks/merchant-automation.json` 不存在；HEAD `2a00d98`（1.12.11）
- 耗时 30m32s（02:12:56Z → 02:43:25Z）
- 采集口径：`productDataCollectingShopKeys()` = 8 家（确认不含销售2部 5 家）

## 失败分类
`FAILED / UNCLASSIFIED`，`failedStage=inquiry-import`（链自报）。实测 5 处缺口全在**采集段**。
分类口径本身也有洞：这类「SPA 渲染慢」被判成 `UNCLASSIFIED`，收信人据此分不出要不要人处理（见下「根因」三条）。

## 根因（2026-10-22 查清，逐条附现场证据）

### ① 询单 2 家 —— 判据测错了对象（真 bug，已修）
上一版入口判据是 `body.innerText.includes('商品咨询分析')`：它测的是「这段文案在不在」，
不是「在不在询单页」。

看 `里可林天猫/inquiry.xls.failure.png` 的实际画面：页面**已经在「商品咨询分析」上**、
统计时间显示 **2026-10-21**、三个 Tab 与下载按钮都在、表格有 4+ 行数据 —— 页面是对的时候，
判据读回 `hasInquiry=false` 就判了失败。所以这不是「没进页」，是「进了页但判据认不出」。
10-21（上一轮）把它归成「SPA 菜单未渲染」是误判，以本次画面为准。

`盖文天猫` 另叠加一层：`hasParent=false`（父菜单也没渲出、`readyState=interactive`），
是同一类「读取早于渲染」的另一个出口。

修法（`skills/sycm-inquiry-data/`）：
- `inquiry-core.mjs` 新增 `INQUIRY_PAGE_MARKERS = ['统计时间','询单人数']`、`hasInquiryPageMarker()`、
  `isInquiryPage()`（**结构特征优先于 Tab 文案**，并接受纯日期形态的统计时间）；
- `collect-inquiry-report.mjs` 入口闸门从 `planEntryPollStep(entryState) !== 'done'` 换成 `!isInquiryPage(entryState)`，
  循环体每轮也用它判提前成功；`READ_PAGE_STATE` 的 `hasInquiry` 同样接入结构词表（同一病根的第二出口）。
- `planEntryPollStep` 保留原语义（只管「要不要点父菜单」），与「到没到页」彻底分开 —— 两件事不共用判据。

### ② 推广 3 家 —— 固定睡眠＋单次判据（已修）
`produceTask()` 里 `await sleep(6500)` 之后立刻 `setPlanDimension`，找不到 `.mx-trigger` 就 throw，
单次、无重试。现场（网林天猫）URL 日期正确（`startTime=endTime=2026-10-21`），
但 `DIV=257 / TR=1 / INPUT=None / 维度=0 / dialogs=[]` —— 报表骨架还没渲出来；
对照 10-21 里可林天猫同类成功现场是 `DIV=822 / TR=58 / INPUT=6`，形态完全不同。
⇒ 是**就绪判据**问题，不是选择器失效。

修法：新增 `report-ready-core.mjs`（`planReportReadyStep` / `pollReportReady` / `describeReportReadyFailure`），
`collect-product-report.mjs` 把固定睡眠换成最多 25s 的轮询（每 1.5s 读一次骨架）；
读不到时用 `describeReportReadyFailure` 说清是「不在报表页」「骨架空」还是「等到了空结果」。
**`rows=0` 真无投放必须放行**（有用例钉住），不许把空结果当失败重试。

### ③ 连带 —— 询单失败的两家推广段被整段跳过
同店串行：询单抛错即止，推广段根本没跑到。所以「推广 5/8」里的 3 家里，
盖文天猫、里可林天猫这 2 家是**被上游带掉的**，只有网林天猫是真的推广取数失败。
（口径不变：缺口照实记 5 处，但归因要分清，否则会去修一个没坏的东西。）

## 判据（离线）
- `inquiry-core.test.mjs` 28/28：含逐字取自现场的 `hasInquiry:false` + `statDate:'2026-10-21'` ⇒ 必须判「已在页」。
- `report-ready-core.test.mjs` 60/60：含现场两份读数（失败空壳 / 成功完整）、0 投放放行、轮询次数、接线顺序。
- 突变 5/5 `RED_NAMED`（`tmp/mutate-2026-10-22-product-gaps.mjs`）——
  含一条 M1 首跑 `GREEN_BAD`（只改调用、纯函数没被调用），据此补了「调用侧真的调用了 isInquiryPage」的接线守卫。


## 采集与导入
| 店铺 | 商品底单 | 询单 | 推广 |
|---|---|---|---|
| 里可林淘宝 | 34 | 5 | 16 |
| 网林天猫 | 22 | 2 | 未采集 |
| 盖文淘宝 | 41 | 8 | 16 |
| 盖文天猫 | 51 | 未采集 | 未采集 |
| 科塔淘宝 | 35 | 6 | 20 |
| 网林淘宝 | 34 | 7 | 25 |
| 里可林天猫 | 26 | 未采集 | 未采集 |
| 网林家居 | 2 | 0（源 0，剔除汇总行） | 0（源 0，当日无投放） |
| 合计 | **245** | **28** | **77** |

商品 8/8、询单 6/8、推广 5/8。各店收据 `src == planned`，**重复 0**。

## 独立回读（rcnb 凭据，跑前/跑后各一次；非链自报）
| 表 | 跑前 total/onDate | 跑后 total/onDate | 真实新增 |
|---|---|---|---|
| 商品（统计日期） | 4462 / 0 | 4707 / 245 | **245** |
| 询单（数据日期） | 948 / 1 | 976 / 29 | **28** |
| 推广（日期） | 2460 / 0 | 2537 / 77 | **77** |

与收据 plannedRows 合计逐值一致。询单开工前目标日已有 1 行，非本轮写入。

## 前置闸门
- `feishu-targets-preflight`：OK（rcnb，1 base / 3 表各自凭据都被认）
- 登录预检 b1/b2：`ALL_IN`、`needHuman=[]`（**无一家被踢登录**）
- 视口：8/8 家 1506x642 过闸

## 释放
- b1/b2 `released:true`，两次 listening=0
- 独立确认：28 个登记端口 PowerShell 两遍回读 **READ1_COUNT=0 / READ2_COUNT=0**
- 告警：`SENT`（`product-round-20261021`，ERROR）

## 未做
未改代码/配置、未重跑、未起停任何非本链进程、未删锁。

---

# 后续处置（2026-10-22 同日，按用户「其他按你推荐的解决」）

## 告警文案已改（用户：「需要更加符合问题，而不是卡在第几步」）
新增 `runtime/product-alert-copy.mjs`（纯函数）＋ `runtime/product-alert-copy.test.mjs`（9/9），
`scripts/run-product-data-job.mjs` 的 `notifyFailure` 接线改为调用模块。

同一批 5 处缺口，改前/改后业务段对比：

改前（机读形态，收信人读不懂也做不了）：
```
本轮不完整（5 处）：里可林天猫/询单 未采集：…；盖文天猫/询单 未采集：…；网林天猫/推广 …
```

改后（点名到店、按段分组）：
```
统计日 2026-10-21 缺：询单 2 家缺（里可林天猫、盖文天猫）；推广 3 家缺（网林天猫、里可林天猫、盖文天猫）。
原因归类：采集或导入没有完成，脚本没能自动修好。
```

三点硬约束（都有用例钉住）：
- 业务段**不许出现** `inquiry-import` 这类机读阶段码（那就是「卡在第几步」）；
- `HUMAN_REQUIRED` 时**不许**说「这一轮不需要你在浏览器里做什么」—— 那句话会拦住该去点登录的人；
- 拆不出店/段的缺口**不许被吞掉**（记「另有 N 处未完成」），否则收信人以为只有两段缺。

文案突变 4/4 `RED_NAMED`（`tmp/mutate-2026-10-22-alert-copy.mjs`）。第一次跑四条全 GREEN_BAD，
查明两种成因并都加了防线：① 突变模板与源码差一个字、replace 空转 ⇒ 现在替换前后逐字比对；
② `spawnSync` 未显式 `stdio:['ignore','pipe','pipe']` ⇒ 本机默认继承 stdin 管道会 status=null、输出全空，
「有没有红」一律假绿。这条是既有已知坑（工作记忆里有），本次又踩了一次。

## 补跑三家 —— **未执行，被环境阻塞**
计划：`--shops 里可林天猫,盖文天猫,网林天猫`，不加 `--batches`（一次全起、结束统一释放）。

开工前看锁：`runtime/.workflow-locks/merchant-automation.json` 被
`run-batches:promotion-daily`（pid 89212，11:02:06 起）持有，**进程存活**；
19031-19035 五个店铺端口全部 `LISTEN`（pid 105700/92984/118984/38236/86572）。
⇒ 推广日报链正在跑第一批，此时起商品链会抢同一批浏览器实例。
按纪律**不删锁、不抢锁、不停对方进程**，补跑待该链结束后再做。

## 另有 1 条与本轮无关的既有欠账
`runtime/alert-type-title-guard.test.mjs` 红 1 条：
`skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs:526` 新增的 `KEFU_WEEKLY_OK` / `KEFU_WEEKLY_FAILED`
两个告警类型没在 `runtime/alert-copy.mjs` 的 `ALERT_TYPES` 里登记。
该文件上次提交是 `52617a9`（2026-10-19 18:25，1.12.9），工作区干净、mtime 早于本轮 ⇒
**不是本轮引入**，本轮不碰别人的文件，仅记录。

