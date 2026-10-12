# 推广日报 2026-10-10 数据抢救 · 收尾交接（2026-10-11）

面向对象：接手重构对齐的架构师。
一句话：10-11 早 07:00 的推广日报自动化报了"8 家全失败"，实际是**链的提交结果判定把成功当失败**；8 家数据当天已全部补齐入库，但暴露出 7 个流程级缺陷。

---

## 1. 事件时间线

| 时间(+08) | 事件 |
|---|---|
| 10-11 07:00 | 自动化轮 `run-batches --workflow promotion-daily --date yesterday --batch-size 5 --mode apply` 开跑 |
| 07:25 | 2/2 批失败（chainStatus=1），8 家全部报「报表提交任务无法唯一确认 added=[]」；窗口按策略全部释放 |
| 07:35 | 人工拉起网林家居核查，任务列表实测：关键词 072240、人群 072251 **均"生成成功"**，业务日 2026-10-10 ⇒ 判定为误报 |
| 07:46 | 定位：推广链入口只有 101 行，未接任何失败处理能力（见 §5 问题 7） |
| 08:00–09:00 | 抢救：逐家取件 + 导入，完成 6/8 |
| 09:00 | 系统重启，浏览器实例全部清空；同时本机断网（系统代理 127.0.0.1:7897 无服务） |
| 09:47 | 用户启动代理，网络恢复；重试仍失败（发现§5 问题 2：错误页被当有效页） |
| 09:53 | 因 10:00 商品数据定时需占用同一批窗口，主动停止抢救 |
| 10:23–10:40 | 商品任务跑完后重起窗口，完成最后 2 家 ⇒ **8/8 全部入库** |

---

## 2. 最终结果（8/8 已入库）

表：关键词表 `tblbSGMO2apOKuAZ` / 人群表 `tblyjD5058Mjbmcv`（租户 kcne，目标表由链内 `import-promotion-daily-report.mjs` 决定）。

| 店铺 | 关键词行 | 人群行 | 备注 |
|---|---|---|---|
| 网林家居 | 0 | 12 | 关键词为平台空表（77 列无数据行），按口径未填 0 |
| 里可林淘宝 | 43 | 19 | |
| 网林天猫 | 11 | 15 | |
| 盖文淘宝 | 22 | 18 | |
| 盖文天猫 | 75 | 86 | |
| 科塔淘宝 | 52 | 23 | |
| 网林淘宝 | 53 | 22 | |
| 里可林天猫 | 50 | 21 | |
| **合计** | **306** | **216** | |

覆盖口径＝`collectingShopKeys()` 8 家（销售1部）；销售2部 5 家整部门停采，未涉及。

---

## 3. 根因

**链的提交结果判定把"提交成功"一律报成失败。**

`judgeSubmitOutcome`（`promotion-task-ledger.mjs`）用"提交前后任务名差集"判断本次提交产生了哪一条任务；实测该差集恒为空 ⇒ `added=[]` ⇒ 判「平台可能没接受这次提交」⇒ 整店失败。

但平台上任务确实已生成、状态"生成成功"、日期范围正是目标日。今日累计发作 ≥6 次（10-10 晚 final-b2、10-11 早 8 家、抢修中的 2 次补提交、盖文淘宝/盖文天猫、网林淘宝），**全部为误报**。

后果放大链：
1. 误报 ⇒ 该店 `failed`，后续阶段（取件、导入）不再执行；
2. 链不产出 `gaveUp`/`unfixable` 信号 ⇒ `run-batches.mjs:488` 的 `unfixableShopsOf` 恒空 ⇒ 释放策略永远判「没有需要人看现场的失败」⇒ **照旧释放窗口**，人工想核查时现场已无；
3. 链入口不转发 `--notify` ⇒ **飞书零告警**；
4. 转 agent 只在 WorkBuddy 会话内可用，`run-daily-job.mjs` 是 shell 子进程 ⇒ **无人被自动唤醒**；
5. 唯一出口＝自动化轮的文字汇报，而该轮汇报把方向判成了「平台早间不接受提交」（错误，已纠正）。

---

## 4. 本轮抢修路径（可复用的应急手法）

跳过链的提交段，直接"取件 + 导入"：

1. 只读读列表确认该店目标日的任务名（按「日期范围」列认业务日，不按任务名）：
   `collect-promotion-report.mjs` 的读列表表达式，或直接 CDP `/eval`。
2. 取件（**显式给任务名 + `--no-duplicate-retry`**，绕开"换通道"兜底）：
   ```
   node skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs \
     --phase fetch --date 2026-10-10 --report-kind <keyword|audience> --shop-key <店> \
     --proxy http://127.0.0.1:<代理口> --expect-member <会员名> --expect-member-id <ID> \
     --task <任务名> --no-duplicate-retry
   ```
3. 导入：`import-promotion-daily-report.mjs --date --shop --keyword <zip> --audience <zip> --evidence <目录> --apply`
   （该脚本**强制要求两个文件都给齐**，缺一类就无法入库——这是"缺人群则一条都进不去"的原因。）
4. 判据：一律看回执的 `beforeRows`/`plannedRows`/`afterRows` 与源文件 `rows`，不看退出码。

一次性驱动脚本（临时产物，未纳入版本控制）：`tmp/rescue-promotion-2026-10-10.mjs`、`tmp/fetch-named.sh`、`tmp/probe-submit-diff.sh`。

---

## 5. 待修问题清单（按优先级，交架构师）

1. **added 差集判定误报（最高优先）**：判「提交是否成功」不能只靠"名字差集"。今日 6 次全部误报。
   建议方向：差集为空时**回查该业务日的候选任务**（按「日期范围」列 + 状态），而非直接判失败；或把"读不到"与"没有新增"分成两种结论（现在被合并成同一个 `added=[]`）。
2. **错误页被当成有效页**：加载失败后（断网等），CDP `/targets` 的 `url` 仍返回原 alimama 地址，
   `ensureOneAlimamaTab` 因此判"已有可用页"、不新建，后续所有 navigate/读列表落在坏页上，读数恒空。
   ⇒ 页签可用性判据必须包含"页面真的加载成功"，不能只看 URL。
3. **`spawnSync` 带 stdin 管道在本机恒 EBUSY**（禁用沙箱同样复现）：
   - 已修：`import-promotion-daily-report.mjs` 的 `readZip()`（`stdio:['ignore','pipe','pipe']`）。
   - **未修**：`run-promotion-daily-report.mjs` 的 fetch 分支同样病根，表现为「共享日报取件流程失败」且无任何输出。
4. **"换通道"兜底误触发/误报**：网林淘宝任务明明可取（手动 `--no-duplicate-retry` 一次成功），
   脚本先失败、再走换通道补提交、最后报「核不清」。
5. **`--notify` 不转发**：`run-batches --notify` 进不了链，失败零飞书告警。
6. **释放策略对推广链等于没接**：链不产出 `gaveUp`/`unfixable` ⇒ 永远"不需要人看现场"⇒ 释放窗口。
   建议：链失败且拿不到 unfixable 信号时，默认**保守托住**而非释放。
7. **推广链未复用日报链的失败处理内核**（用户反复强调的点）：
   - `run-promotion-sales1.mjs`：101 行，`escalation` 0 / `repair` 0 / `notify` 0 / `自修` 0 / `unfixable` 0 / `gaveUp` 0
   - `run-multi-shop-day.mjs`：2655 行，`escalation` 6 / `repair` 31 / `notify` 29 / `自修` 5 / `unfixable` 2 / `gaveUp` 10
   ⇒ 1.8.0 只把"统一入口/批次/回执"这三样外壳接到了推广链，失败处理内核没跟过来。

---

## 6. 本轮改动与工作区状态

**本轮的代码改动只有 1 处**：
`skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs` → `readZip()` 的 `spawnSync` 加 `stdio: ['ignore','pipe','pipe']`（修问题 3 的一半）。未提交。

⚠️ **工作区存在大量非本轮改动**：`git diff --stat` 显示 **43 个文件、+1112/−166**，绝大部分属于并行开发线未提交的产物（`xws-*` skills、adaptive/supervisor 等），**与本轮无关**。
提交时请走**显式路径**，不要 `git add -A`，否则会把并行线的半成品一起带上。

`HEAD = a211adb feat(1.8.0): 架构 spec 落地——workflow-catalog / run-receipt-v1 / run-root / 统一入口 --mode / 推广日报调度接入`。

---

## 7. 证据索引

- 自动化轮原始证据：`evidence/promotion-batches-2026-10-10/`（`batches.json`、`batches.log`、`login-preflight-b1/b2.json`）
- 统一回执：`../sycm-automation-runs/promotion-daily/2026-10-10/promotion-daily-2026-10-10-51ab47c3-54ff-4fed-aeaa-7bc7360434cf/run-receipt.json`
  （`execution=FAILED`、`failureClass=null`——失败分类轴未填）
- 抢修证据：`evidence/promotion-rescue-2026-10-10/<店>/receipt.json`（8 家）
- 前置对照：`evidence/promotion-sales1-2026-10-10-repair/final-b2/batches.json`（10-10 晚同族误报）
- 逐日实录：`.workbuddy/memory/2026-10-11.md`

---

## 8. 遗留 / 未做

- 网林家居关键词 0 行需业务侧确认（当天是否真无关键词投放）。
- 网林淘宝、里可林天猫的店铺浏览器实例在本轮结束时仍开着（未擅自停）。
- 未提交任何代码；未改系统代理、未启动用户代理软件；未动销售2部 5 家。
- 自动化 prompt 建议增加一条：失败时不要只"读日志汇报"，要"起一家店核查 + 托住现场"——本轮若这么做，真相在 07:10 即可拿到。
