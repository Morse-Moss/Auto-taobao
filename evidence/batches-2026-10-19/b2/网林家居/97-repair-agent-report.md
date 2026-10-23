# 网林家居 · 2026-10-19 · 修复 agent 报告

- 修复 agent：repair-agent-1019（后台）
- 目标业务日：2026-10-19
- 店铺：网林家居（平台店名「网林定制家居」，会员 `网林定制家居:小瓜`，member id 1731780198）
- 修复阶段：第 7 步 `push`｜请求单 cause=`STAGE_FAILED`
- **最终结论：`needs-human`（平台侧当日无推广数据）**
- **飞书底单有没有真写进去：没有。** 修复前后独立回读都是 7 行（表 2425 行），`网林家居` 这一行**不存在**；本次 agent 一个飞书写请求都没发出去。

---

## 0. 一句话根因

不是底单查不到行，也不是页面状态坏了 —— 是**阿里妈妈对 `2026-10-19` 这个账户根本没有出数据**：

- 平台报表页（只读回读）「营销场景数据明细 / 数据范围为：2026-10-19至2026-10-19」⇒ **「暂无数据 共 0 项数据」**，同一页「花费数据汇总」= **账户总花费 0.00 / 关键词推广 0.00 / 人群推广 0.00**；
- 两次独立生成的任务（08:33:52、08:47:09）导出的 CSV **解包后内容哈希完全相同**（`eda669d6…cac06`）—— 都是「表头 752 字节 + 空行」，0 条数据行；
- 店铺侧源数据没问题：`店铺日报_20261020_defbfd5f1fef2520bec4b10726fe5a41.xlsx` 的 `统计日期=2026-10-19` 自检 `matches:true`。

链的源数据自证要求「推广 CSV 里**恰好一天**且就是目标日」，0 行永远不可能满足 ⇒ 这家店这一天在这条链上**结构性过不去**，换页面、换实例、重取都无效。

## 1. 时间线（每步命令 + 每步结果）

时间为本机 2026-10-20（UTC+8）。所有输出已落盘在同目录，文件名见括号。

| # | 时间 | 动作 | 结果 | 证据文件 |
|---|---|---|---|---|
| 1 | 08:40 | 读 `97-repair-request.json` / `98-failure-state.{json,txt}` / `07-push.txt` / `08-push.txt` / `03` / `06` | cause=`STAGE_FAILED`、stage=`push`、candidates=[`REAPPLY_DATES`,`RELOAD_PAGE`]、`stageHint=feishu`、execHint→19023。截图（`98-failure-page.png`）拍的是**店铺标识页**（已知感知缺陷），不作判因依据 | 原文件 |
| 2 | 08:41 | 实例体检（只读）：`curl -s -m 5 http://127.0.0.1:19023/targets`、`…:19062/targets` | 两台都在听。19023=「商家浏览器（日报共用）」、19062=「网林家居」。**未做任何 start/stop** | 本次输出 |
| 3 | 08:44 | 只读核实旧 zip：解包 `营销场景报表_20261020_083352.zip` | CSV 884 字节 = 表头(752)+空行，**0 条数据行** | 本次输出 |
| 4 | 08:46 | **重新提交**一次推广任务：`collect-promotion-report.mjs --phase submit --date 2026-10-19 --proxy 19062 --expect-…` | 身份核对通过（会员/ID ✓）；新任务 `营销场景报表_20261020_084709`；提交途中有全屏遮挡层，脚本自己消掉后才点「下载报表」 | `97-agent-01-resubmit.txt` |
| 5 | 08:47 | 等 75s（等它「生成成功」）后取件：`--phase fetch` | 列表 6 条任务，日期范围=2026-10-19 的共 2 条；取第 1 行新任务 → `营销场景报表_20261020_084709.zip`（**577 bytes**，与旧 zip 同大小） | `97-agent-03-refetch.txt` |
| 6 | 08:49 | 只读解包新 zip + 哈希比对 | 新 CSV 884 字节 = 表头+空行，**0 行**；解包后 CSV sha256 与旧 zip 内 CSV **完全一致**（`eda669d674449e478627d5c3faad43b7aa62ce5d582e7f604ca74503bddcac06`）⇒ 不是「生成太快的竞态」，平台两次给的都是空表 | 本次输出 |
| 7 | 08:50 | **只读**回读平台报表页本身（`tmp/probe-alimama-report-page.mjs`，仅导航 + 读 DOM，不点任何按钮） | 「暂无数据 共 0 项数据」；账户总花费 0.00；关键词/人群/货品全站/店铺直达/内容/线索 全 0.00 ⇒ **平台侧当日确实没数据**（导出是忠实反映，不是导出 bug） | `97-agent-04-report-page-read.txt` |
| 8 | 08:51 | 候选 `REAPPLY_DATES`：先 `--dry-run` | 目标页 = `https://rcnbpuvafkct.feishu.cn/base/RqzrbD4z…&table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo`（**是飞书底单页，页对了**） | 本次输出 |
| 9 | 08:51 | 候选 `REAPPLY_DATES`：真跑（`--proxy 19023`） | **applied=false**｜「日期需要重新落位（feishu）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位」，`needsRetryStage=sycm-date` ⇒ 该动作对 feishu 阶段是**结构性空转** | `97-repair-REAPPLY_DATES.txt` |
| 10 | 08:52 | 候选 `RELOAD_PAGE`：先 `--dry-run` | 同上，目标页是飞书底单页 | 本次输出 |
| 11 | 08:52 | 候选 `RELOAD_PAGE`：真跑 | **applied=true**｜「页面已重载并就绪」（`reloadSettled:true`，before href = 同一张底单页） | `97-repair-RELOAD_PAGE.txt` |
| 12 | 08:52 | applied=true ⇒ 按纪律重试失败的那一步（**换成新 zip**） | 仍然同一条错：`source date self-check failed … promotion={"observedDates":[],"rowCount":0,"targetRowCount":0,"matches":false}`，exit=1。**报错发生在写飞书之前**（`assertSourceDates` 在 `buildCombinedFields` / API 写入之前），因此这次重试一个写请求都没发 | `97-agent-05-push-retry.txt` |
| 13 | 08:53 | 独立回读飞书底单（`readback-2026-10-12-daily.mjs 2026-10-19`，OpenAPI 只读） | **7 行**，表共 **2425** 行；`2026-10-19` 没有 `网林家居` | `97-agent-06-readback-after.txt`（修复前基线：`97-agent-02-readback-before.txt`，同为 7 行 / 2425） |

## 2. 候选动作试过哪些、applied 是 true 还是 false

| 候选 | 目标页（排练打出的 URL） | applied | 说明 |
|---|---|---|---|
| `REAPPLY_DATES` | 飞书底单 `…/base/RqzrbD4z…?table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo` | **false** | 脚本自身判定：feishu 阶段没有「日期落位」这件事，`needsRetryStage=sycm-date`；不是代理/页面错 |
| `RELOAD_PAGE` | 同上 | **true** | 页面真重载了就绪；但重载治不了源数据 |

两个候选都**没有**把这一家修好 —— 因为它们作用在「页面状态」上，而这次的断点在「源数据不存在」。这是我判 `needs-human` 而不是「再试一个动作」的原因。

## 3. 回读到的底单（硬证据）

```
=== 底单 2026-10-19 命中 7 行（表共 2425 行）===
  2026-10-19 | 里可林家居    | rec=reczz28PSfW9mf5q
  2026-10-19 | 网林家居旗舰店 | rec=reczz28PSj2QVTUa
  2026-10-19 | 盖文全卫定制   | rec=reczz28PSmVJ38Vx
  2026-10-19 | 盖文旗舰店     | rec=reczz28PSqCsjCbj
  2026-10-19 | 科塔全卫定制   | rec=reczz28PStxzkbeo
  2026-10-19 | 网林全卫定制   | rec=reczz28PT1erXrRv
  2026-10-19 | 里可林旗舰店   | rec=reczz28PT4a4hI2i
```
（`网林家居` 缺口的就是第 8 行；其余 7 家不受影响，本 agent 没碰任何一行。）

## 4. 为什么**没有**硬凑一个 0 值进去

1. 「推广 CSV 0 行」与「平台还没出数」在数据上同形，链的 `assertSourceDates` 刻意 fail-closed —— 我如果绕过它写 0 值，等于把「不知道」写成「当天花费 0 元」，这正是本链反复吃过的亏；
2. 现有口径里 0 行 ≠ 0 值：底单里 `场景ID` / `人群推广*` 这一整族字段都来自推广 CSV，0 行时这些字段没有可信来源；
3. 边界也是这么写的：只允许「让网林家居 2026-10-19 真正写入」，不许改数据口径。

## 5. 旁证 / 值得人看一眼的两件事（**不改变本次结论，但会影响「0 行算不算正常」的判断**）

1. **这家店的花费在断崖式下降**：近四天底单里 `精准人群推广花费` = 38.86（10-15）→ 48.69（10-16）→ 40.13（10-17）→ **12.77（10-18）**，`关键词推广花费` 一直是 0。所以 10-19 掉到 0.00 是**业务上说得通**的（投放停了），不是不可能的事件。
2. **同一天两次导出曾经不一致**（10-18 的教训，建议人核）：`营销场景报表_20261019_083803.zip`（10-19 08:38 生成）解包是 **2 行**：关键词推广 花费 50.00、人群推广 花费 150.00；而当天最终写进底单的 `营销场景报表_20261019_085841.zip` 只有 **1 行**（人群推广 12.77）。同一天同账户，20 分钟口径差了 15 倍。本次我没有改这条链的任何口径，只是把它记下来 —— **如果 10-19 的「0.00」也要这样看，那它可能还没静止**。

## 6. 需要人做的决定（三选一，我给的是判据不是猜测）

| 选项 | 做法 | 代价 / 前提 |
|---|---|---|
| **A. 确认停投，按 0 值落一行**（推荐先问业务） | 人确认 10-19 这家店确实没投放 ⇒ 需要一次**口径决定**：允许「推广 CSV 0 行 ⇒ 推广族字段按 0 落值」。这是改口径，不是修 bug，必须人拍板后我再改代码 | 现链 fail-closed 会一直拦；不拍板就永远补不上这一天 |
| **B. 等静止点再看一次** | 11:20 之后重跑一次取件，看是否出现数据行（参考第 5 节第 2 条） | 只是确认，不保证有数；命令见下 |
| **C. 接受这一天缺行** | 底单 10-19 少一行，周/月汇总按缺行处理 | 需要人确认下游报表能接受缺口 |

### B 选项的现成命令（**本 agent 没有跑**，交给主流程/人）

```bash
# 1) 重新提交 + 取件（还在持锁窗口内不要跑 run-daily-job，会撞 WORKFLOW_LOCK_BUSY）
node skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs --phase submit \
  --date 2026-10-19 --proxy http://127.0.0.1:19062 \
  --expect-shop 网林定制家居 --expect-member 网林定制家居:小瓜 --expect-member-id 1731780198
# 等它「生成成功」后
node skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs --phase fetch \
  --date 2026-10-19 --proxy http://127.0.0.1:19062 \
  --expect-shop 网林定制家居 --expect-member 网林定制家居:小瓜 --expect-member-id 1731780198
# 2) 按 zip 的 mtime 挑最新那个，再看有没有 2026-10-19 的数据行

# 3) 有数据行 ⇒ 只跑 push 这一步（leaf，不碰运行锁）
node skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs --date 2026-10-19 \
  --proxy http://127.0.0.1:19023 --shop-key 网林家居 --commit \
  --shop-xlsx "C:\Users\Administrator\Downloads\店铺日报_20261020_defbfd5f1fef2520bec4b10726fe5a41.xlsx" \
  --promotion-zip "<新 zip 的绝对路径>"

# 4) 回读
node D:/Retire/probe-live/readback-2026-10-12-daily.mjs 2026-10-19
```

> ⚠️ 整链重跑（`run-daily-job.mjs --date 2026-10-19 --shops 网林家居`）**不要在本轮持锁窗口内跑**（`runtime/.workflow-locks/merchant-automation.json` 仍在，runId=101228-1792454485255，pid=101228；本 agent 既没删锁也没杀进程）。

## 7. 代码改动

**无。** 本次没有改仓库代码，因此没有 `97-repair-agent-code-diff.patch`。
`git log -1` = `52617a9 2026-10-19 18:25:04 +0800 feat(kefu): 客服聊天记录链加自动登录（1.12.9）`。
工作区里 `failure-perception.mjs` 等文件是**别的会话**在改，本 agent 一个字都没碰。

只读探针脚本（未提交、不属仓库产物）：
- `tmp/probe-alimama-page-readonly.mjs`（读任一页签的可见文本/表格）
- `tmp/probe-alimama-report-page.mjs`（导航到「账户报表+目标日」后读表；**只读 DOM，不点任何按钮**）

## 8. 本次 agent 的边界自检

- 没有停/起任何进程、容器、浏览器；19023/19062/19022/19052 与 hold 进程全程未动；
- 没有删运行锁；没有跑 `run-daily-job.mjs`；
- 飞书只读：两次独立回读（修复前/后）都用 OpenAPI 只读探针，结果都是 7 行；
- 平台侧只做了「提交一次下载任务 + 取件一次」（这正是这条链每天的正常动作，非新增副作用），台账已如实记录；
- 没动销售2部 5 家店，没动其余 7 家已成功的行。
