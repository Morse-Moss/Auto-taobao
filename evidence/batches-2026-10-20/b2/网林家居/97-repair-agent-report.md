# 网林家居 · 2026-10-20 · 第 2 层修复 agent 报告

- 目标业务日：**2026-10-20**（Asia/Shanghai）
- 失败阶段：`push`（第 7 步，第一次写飞书）；成因 `STAGE_FAILED`
- 最终结论：**needs-human（口径缺口）—— 修复动作全部试过，agent 修不动**
- 是否改仓库代码：**没有改**（无 `97-repair-agent-code-diff.patch`，因为 diff 为空）
- 是否动锁/进程/浏览器：**没有**。未删 `runtime/.workflow-locks/merchant-automation.json`、未杀 pid 95844、未 start/stop 任何实例、未做任何飞书写入（不含发告警、不含增删行）

---

## 0. 一句话根因

失败**不在页面、不在登录、不在底单**，而在**源数据内容闸门**：

- 店铺工作簿 `店铺日报_20261021_defbfd5f1fef2520bec4b10726fe5a41.xlsx` → `matches:true`（含 2026-10-20 恰好 1 行，`workbookRows:2 / uniqueDates:1`）；
- 推广 CSV `营销场景报表_20261021_082925.csv` → `rowCount:0 / empty:true / matches:false`（**只有表头，0 条数据行**）；
- `assertSourceDates()`（`skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs:272`）要求两侧都命中目标日 ⇒ 结构性拦下，**在写飞书之前就停了**。

⇒ 页面级修复动作（`REAPPLY_DATES` / `RELOAD_PAGE`）与这个闸门**没有因果关系**，试过也无效（下面第 3、4 节有实测）。
⇒ 这是「0 行 vs 0 元」的**口径**问题，只有人能拍板（仓库里已有开关 `--allow-empty-promotion`，v1.12.11，**默认关**，本次**未加、未开**）。

---

## 1. 现场复核（我自己的读，不是转述）

| 事实 | 我读到的 |
|---|---|
| 失败原文（自修第 1 次） | `07-push.txt:8` 与 `08-push.txt:8` **逐字相同**：`source date self-check failed for 2026-10-20（shop={…"matches":true}；promotion={"csvName":"营销场景报表_20261021_082925.csv","observedDates":[],"rowCount":0,"targetRowCount":0,"empty":true,"state":"empty","matches":false}）` |
| 自修真的试过 | `07-push.txt`（00:30:09Z）与 `08-push.txt`（00:30:14Z）是同一条 `run-daily-report.mjs` 调用的两次，exit 都是 1 ⇒ 脚本自修那一层确实试过、且是同一错 |
| 推广 zip 本身 | `C:\Users\Administrator\Downloads\营销场景报表_20261021_082925.zip` = **577 bytes**；解包唯一成员 `营销场景报表_20261021_082925.csv` = **884 bytes，只有表头一行，0 条数据行** |
| 下载环节是成功的 | `06-promotion-fetch.txt`：`exit=0`，`日期范围等于 2026-10-20 的任务共 1 条`，`目标任务行 = 第 1 行｜生成成功 营销场景报表_20261021_082925`，`新文件：…（577 bytes）` ⇒ **不是取件失败、不是下错文件** |
| 提交环节 | `03-promotion-submit.txt`：`promotionTaskName = 营销场景报表_20261021_082925（列表里恰好多出 1 条）` ⇒ 任务是我方正常提交的，日期范围 `startTime=2026-10-20&endTime=2026-10-20` |
| 感知层截图 | `98-failure-state.txt`：URL 停在瓴羊 One 报表预览页、`遮挡层：无`、可见按钮只有「下载报表／加入我的报表／加入在线表格」⇒ 与本次成因无关（**以请求单 `cause`/`stage` 为准**，截图只作辅助） |

---

## 2. 第 0 步：实例体检（只读）

`97-repair-request.json` 的 `instancePrecondition.checkCommand` = `curl -s -m 5 http://127.0.0.1:19023/targets`（`push` 跑在共用商家浏览器上）。原文见 `97-agent-01-instance-check.txt`。

```
$ curl -s -m 5 http://127.0.0.1:19023/targets    # 共用商家浏览器：在听
页签数= 3
  - | 生意参谋 - 零售电商大数据产品平台 | https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
  window-label | 商家浏览器（日报共用） · 日报采集窗口 | file:///…/shop-window-label.html?shop=商家浏览器（日报共用）…
  飞书底单页 | … | https://rcnbpuvafkct.feishu.cn/base/RqzrbD4zIalzjxsSGcbcUPTpnKc?table=tbl6EDMzzaYUVvVC&view=vewwg0rh…

$ curl -s -m 5 http://127.0.0.1:19062/targets    # 该店自己的实例：在听
页签数= 5（生意参谋工作页 / 网林家居·日报采集窗口 / 阿里妈妈报表页 / 店铺日报_20261021…预览 / edge://downloads-hub/）

$ cat runtime/.workflow-locks/merchant-automation.json
{"version":1,"name":"merchant-automation","owner":"daily-report","runId":"95844-1792540911631","acquiredAt":"2026-10-21T00:01:51.631Z","pid":95844}
```

⇒ 两台都在（**没有执行 `start-all-hold.mjs`**，因为不需要；也没有 stop/restart 任何东西）。全局锁由驻留持有者 `daily-report`/pid 95844 持有 —— **不是我的，全程未碰**。

---

## 3. 候选动作（只从 `candidates` 里挑，共 2 个，全部试过）

### 3.1 `REAPPLY_DATES`（第 1 个候选）

排练（`--dry-run`，一个写请求都不发）：

```
$ node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林家居 --proxy http://127.0.0.1:19023 \
    --stage push --cause STAGE_FAILED --action REAPPLY_DATES --log-dir evidence/batches-2026-10-20/b2/网林家居 --dry-run
[修复] 目标页 = https://rcnbpuvafkct.feishu.cn/base/RqzrbD4zIalzjxsSGcbcUPTpnKc?table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo
[修复] ❌ 未应用：排练（--dry-run）：会执行 REAPPLY_DATES 于 <同一 URL>，一个写请求都不发
```

目标页判据：打出来的是**飞书底单页 URL**（`/base/…?table=tbl6EDMzzaYUVvVC`），**不是** `label.html` 标识页、不是登录页 ⇒ 页对了。

真跑（`97-agent-02-reapply-dates.txt`）：

```
[修复] REAPPLY_DATES｜网林家居@http://127.0.0.1:19023｜阶段 push
[修复] 目标页 = https://rcnbpuvafkct.feishu.cn/base/RqzrbD4zIalzjxsSGcbcUPTpnKc?table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo
[修复] ❌ 未应用：日期需要重新落位（feishu）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位
```

回读（`97-repair-REAPPLY_DATES.json`）：`applied=false`、`exitCode=1`、`evidence={"needsRetryStage":"sycm-date"}`。

判读：这个动作在 `push`（`stageHint=feishu`）阶段**结构上无从落地** —— 飞书底单页没有日期筛选可「重落」，脚本本身也如实说明「本动作不重复实现落位」。

### 3.2 `RELOAD_PAGE`（第 2 个候选）

排练：目标页同上（飞书底单页），`applied=false`、仅排练（`97-agent-03-reload-page-dry.txt`）。

真跑（`97-agent-03-reload-page.txt`）：

```
[修复] RELOAD_PAGE｜网林家居@http://127.0.0.1:19023｜阶段 push
[遮挡] 已重载页面（Docs）—— 在新现场上再走一遍
[修复] ✅ 已应用：页面已重载并就绪
```

回读（`97-repair-RELOAD_PAGE.json`）：`applied=true`、`exitCode=0`、
`evidence={"before":{"href":"https://rcnbpuvafkct.feishu.cn/base/RqzrbD4zIalzjxsSGcbcUPTpnKc?table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo","readyState":"complete"},"reloadSettled":true}`。

⇒ `applied===true`，按纪律**必须重试失败那一步**（见第 4 节）。

---

## 4. 重试 `push`

### 4.1 按指导书形状重试（`run-daily-job.mjs`）→ 被全局锁挡住（预期）

```
$ node scripts/run-daily-job.mjs --date 2026-10-20 --shops 网林家居 --only push --mode apply --commit
[mode] --mode apply（显式给定）
[2026-10-21T00:36:10.741Z] 运行锁冲突：workflow lock busy: merchant-automation；持有者={"version":1,…, "owner":"daily-report","pid":95844}
exit=1
```

`WORKFLOW_LOCK_BUSY` —— 这是**驻留正持有全局锁**导致的预期结果（`97-agent-05-retry-job-lock.txt` 全文），**不是新故障**。按指示**没有反复重试**，也没有去删锁/杀进程。

### 4.2 改用「只重跑失败那一步」的叶子命令（不碰锁）

用 `07-push.txt` 里那条**逐字相同**的调用（同一份 xlsx、同一份 zip、同一个代理），只跑 `push` 这一步（`97-agent-06-push-retry-after-reload.txt`）：

```
$ node run-daily-report.mjs --date 2026-10-20 --proxy http://127.0.0.1:19023 --shop-key 网林家居 --commit \
    --shop-xlsx …\店铺日报_20261021_defbfd5f1fef2520bec4b10726fe5a41.xlsx --promotion-zip …\营销场景报表_20261021_082925.zip
Error: source date self-check failed for 2026-10-20（shop={"matchedRowDate":"2026-10-20","workbookRows":2,"uniqueDates":1,"targetRowCount":1,"matches":true}；promotion={"csvName":"营销场景报表_20261021_082925.csv","observedDates":[],"rowCount":0,"targetRowCount":0,"empty":true,"state":"empty","matches":false}）
    at assertSourceDates (run-daily-report.mjs:272:11)
exit=1
```

⇒ `RELOAD_PAGE` 之后**同一条错、同一处、exit 1**。该报错发生在 `assertSourceDates`（写飞书之前），**本次重试没有产生任何飞书写入**。
⇒ 候选 2/2 试完，仍失败。

---

## 5. 只读判断「是不是平台没出数」（关键，决定结论口径）

只读探针 `tmp/probe-alimama-report-page.mjs`（只导航 + 读 DOM，**不点任何按钮**；输出全文见 `97-agent-04-report-page-read.txt`）：

```
$ node tmp/probe-alimama-report-page.mjs http://127.0.0.1:19062 2026-10-20
页签 7847177377EE5C77A2C751251D281FF8 | 当前 …#!/report/download-list
url = https://one.alimama.com/index.html#!/report/account?rptType=account&startTime=2026-10-20&endTime=2026-10-20…
title = 营销场景报表_万相台无界版
hasNoDataText = true
```

页面正文（同一次回读）逐字包含：

- 身份：`网林定制家居:小瓜 ID：1731780198`（**是这家店，没串店**）
- **花费数据汇总**：`账户总花费 0.00`／`关键词推广花费 0.00元 占比0.00%`／`人群推广花费 0.00元`／`货品全站推广花费 0.00元`／`店铺直达花费 0.00元`／`内容场景花费 0.00元`／`线索推广花费 0.00元`
- 明细区：`营销场景数据明细 数据范围为：2026-10-20至2026-10-20` ⇒ **`暂无数据 共 0 项数据`**
- 表格结构：`tableCount=4`，两张主表 `bodyRows = 0`（表头在、数据行 0）
- 周环比基期（对照）：`2026-10-20对比2026-10-13` ⇒ `展现量 -`、`点击量 -`、`花费(元) -`（基期 29.93）

⇒ **平台侧对 2026-10-20 这家店确实是空数据**；`577 bytes / 0 行` 的导出是**忠实反映**，不是导出竞态、不是筛选失效、不是实例页问题。
⇒ 与 10-19 那次（`evidence/daily-job-2026-10-19/RUN-REPORT-2026-10-20-0900.md`：两次独立生成任务、两份 CSV sha256 完全一致、报表页「暂无数据」、花费全 0.00）是**同一形态**；业务上也连续：10-17=40.13 → 10-18=12.77 → 10-19 空 → 10-20 空。

（按边界要求，**没有**去重新提交推广任务、**没有**点任何页面业务按钮。）

---

## 6. 飞书底单只读回读（确认现场，不是自证）

用仓库自己的独立回读通路（CDP → 页面 bitable 模型，仅读；产物 `independent-readback.json`、`feishu-source-table-*.png`）。跑了**两遍**，结论一致（`97-agent-07-readback-after.txt`）：

```
底单: recordsNum=2440  loaded=2440  命中 2026-10-20 = 7 行
询单表: recordsNum=2602 loaded=2602 命中 2026-10-20 = 13 行
页面已留在：https://rcnbpuvafkct.feishu.cn/base/RqzrbD4zIalzjxsSGcbcUPTpnKc?table=tbl6EDMzzaYUVvVC&view=vewwg0rhjo
```

逐行核对 2026-10-20 的 7 行（`店铺` 是 Lookup 派生列，页面模型不带 ⇒ 用同表权威可读列 `店铺名称`）：

| # | 店铺名称 | recordId |
|---|---|---|
| 1 | 里可林家居 | reczz28PrBf5AJo8 |
| 2 | 盖文旗舰店 | reczz28PrLNjfGUt |
| 3 | 里可林旗舰店 | reczz28PrXDZuq9U |
| 4 | 盖文全卫定制 | reczz28PrIE0GcAK |
| 5 | 网林家居旗舰店（= 网林天猫） | reczz28PrEzkbz5K |
| 6 | 网林全卫定制（= 网林淘宝） | reczz28PrU9CUJ2d |
| 7 | 科塔全卫定制（= 科塔淘宝） | reczz28PrOR55x7t |

- 网林家居的平台全称是 **`网林定制家居`**（`shop-identities.mjs:345`）⇒ **7 行里没有它，该店 2026-10-20 确实一行都没有**（不是「只缺推广字段」，是整行没写）。
- 其余 7 家都在（与「7 家已成功写入」一致）。表总行数 2440（10-19 那轮是 2425，差额来自别的批次，与本店无关）。

---

## 7. 最终结论：`needs-human`（口径缺口），agent 修不动

| 项 | 结果 |
|---|---|
| 试过的候选 | `REAPPLY_DATES` → `applied=false`（feishu 阶段无日期可重落）；`RELOAD_PAGE` → `applied=true`，重试 `push` 仍 `exit 1` 同一错 |
| 候选是否试完 | 是（请求单只给了这 2 个，未发明动作名，未绕过 `repair-shop-stage.mjs`） |
| 根因是否页面问题 | **否**。平台对该店 2026-10-20 无数据（报表页 0 项、花费全 0.00），导出忠实反映 |
| 重试是否被锁挡 | 是（`WORKFLOW_LOCK_BUSY`，驻留 pid 95844 持有，**预期**） |
| 是否改代码 | **否**。根因是口径，不是代码缺陷 |
| 当前底单状态 | 2026-10-20 共 7 行，**缺 网林家居**（该店整行未写） |

### 需要人拍板的只有一件事

**「该店 2026-10-20 推广 CSV 0 行」要不要按「推广族字段留空」落一行？**

- **选项 A（放行）**：人明确同意后，用仓库已有的 `--allow-empty-promotion`（v1.12.11，默认关）**只跑 `push` 这一个阶段**补写该行；`assertSourceDates` 之后会打 `[留空] 推广报表 0 行且已显式放行`，推广族字段留空、其余字段照写。整条链的接线已有单测钉住（`runtime/daily-job-plan.test.mjs:924` 断言 `push.argv` 带/不带这个开关）。
- **选项 B（不放行）**：维持现状 —— 该日该店缺行，下一轮继续观察是否恢复投放。
- 两条都**不是 agent 能自己选的**；也**绝不能**把 0 行当 0 元填进飞书。

⚠️ 提醒 team-lead：**10-19 也是同一家店、同一形态缺行**（见 `evidence/daily-job-2026-10-19/RUN-REPORT-2026-10-20-0900.md` 待决第 1 条），这个口径已经**连续卡了 2 天**（10-19、10-20），且今天 10-20 这一轮又在同一个点上失败 ⇒ 建议作为**一条口径决策**一次性拍板，而不是每天救一次。

---

## 8. 代码改动：无

- `git log -1` = `2a00d98 feat(daily-report): 把 --allow-empty-promotion 接进整条定时链`（我在这个 HEAD 上作业）。
- **我没有改任何仓库代码/配置**，因此没有 `97-repair-agent-code-diff.patch`。
- 工作区里已有的那些 `M`（`docs/ops/DAILY-FLOW-SCHEDULE.md`、`runtime/product-report-reuse-wiring.test.mjs`、`failure-perception.*`、`sycm-promotion-data/*`）**不是我的**，一个字没碰。
- 本次我在仓库里**只新增** `evidence/batches-2026-10-20/b2/网林家居/` 下的证据文件（该目录本来就是本轮失败现场目录）。

---

## 9. 证据清单（都在 `evidence/batches-2026-10-20/b2/网林家居/`）

| 文件 | 是什么 |
|---|---|
| `07-push.txt` / `08-push.txt` | 失败原文（两次，同一错） |
| `03-promotion-submit.txt` / `06-promotion-fetch.txt` | 推广任务提交与取件（都 exit 0；zip 577 bytes） |
| `97-repair-request.json` | 请求单（cause/stage/candidates/instancePrecondition） |
| `98-failure-state.{json,txt,png}` | 失败瞬间现场（仅辅助） |
| `97-agent-01-instance-check.txt` | 实例体检 + 全局锁读音（只读） |
| `97-agent-02-reapply-dates-dry.txt` / `97-agent-02-reapply-dates.txt` | `REAPPLY_DATES` 排练 / 真跑原文 |
| `97-repair-REAPPLY_DATES.{json,txt}` | `REAPPLY_DATES` 结果（`applied=false`） |
| `97-agent-03-reload-page-dry.txt` / `97-agent-03-reload-page.txt` | `RELOAD_PAGE` 排练 / 真跑原文 |
| `97-repair-RELOAD_PAGE.{json,txt}` | `RELOAD_PAGE` 结果（`applied=true`，含 before href / readyState） |
| `97-agent-05-retry-job-lock.txt` | `run-daily-job.mjs` 重试 → `WORKFLOW_LOCK_BUSY` 原文 |
| `97-agent-06-push-retry-after-reload.txt` | 重载后重跑 `push` → 同一错、exit 1 |
| `97-agent-04-report-page-read.txt` | 阿里妈妈「营销场景报表」2026-10-20 只读回读（暂无数据 / 花费全 0.00） |
| `97-agent-07-readback-after.txt` + `independent-readback.json` | 飞书底单独立回读（两遍：7 行 / 2440） |
| `feishu-source-table-after-agent-after.png` | 底单截图存证 |

---

## 10. 时间线（CST）

| 时刻 | 动作 | 结果 |
|---|---|---|
| 08:29:11 | 链自己跑 `promotion-submit` | exit 0，任务 `营销场景报表_20261021_082925` |
| 08:29:56 | 链自己跑 `promotion-fetch` | exit 0，落盘 **577 bytes** |
| 08:30:09 / 08:30:14 | 链自己跑 `push`（自修 1 次 → 共 2 次） | 两次都 `source date self-check failed`（推广 0 行）、exit 1 |
| 08:30:11 | 写 `97-repair-request.json` | candidates = REAPPLY_DATES / RELOAD_PAGE |
| 08:35:4x | 我：`REAPPLY_DATES` 排练 + 真跑 | `applied=false`（feishu 无日期可落） |
| 08:36:0x | 我：`RELOAD_PAGE` 排练 + 真跑 | `applied=true`（reloadSettled=true） |
| 08:36:10 | 我：`run-daily-job.mjs … --only push` 重试 | `WORKFLOW_LOCK_BUSY`（驻留 pid 95844）→ 不重试 |
| 08:36:1x–08:36:3x | 我：叶子命令重跑 `push` | 同一错、exit 1（写飞书之前拦下） |
| 08:36:31 | 我：只读回读阿里妈妈报表页 2026-10-20 | 「暂无数据 共 0 项数据」+ 花费全 0.00 |
| 08:37:2x | 我：飞书底单独立回读（第 1 遍） | 7 行 / 2440，缺网林家居 |
| 08:37:29 | 我：实例体检落盘（只读） | 19023 / 19062 都在听 |
| 08:37:4x | 我：飞书底单独立回读（第 2 遍） | 与第 1 遍一致：7 行 / 2440 |
| — | **未做**：删锁 / 杀进程 / start-stop 实例 / 飞书写入 / 改代码 / 开 `--allow-empty-promotion` | — |
