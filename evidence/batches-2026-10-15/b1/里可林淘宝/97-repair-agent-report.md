# 里可林淘宝 · promotion-submit 修复报告（修复 agent）

- 目标日：2026-10-15
- 失败阶段：`promotion-submit`（exit 1）
- 失败符号：`采集失败：阿里妈妈会员名身份读不到（期望「里可林家居:小嘉」）`
- 证据目录：`evidence/batches-2026-10-15/b1/里可林淘宝/`
- 结论：**已救回**（底单 2026-10-15 出现「里可林家居」行；本店 11 个阶段全绿）

---

## 1. 现场事实（先读，不重推）

- `97-repair-request.json`：`cause=STAGE_FAILED`、`stage=promotion-submit`、`stageHint=alimama`、
  `retryStage=promotion-submit`、`candidates=[REAPPLY_DATES, RELOAD_PAGE]`、
  `execHint` 的 `--proxy http://127.0.0.1:19041`。
- `98-failure-state.txt`（失败后约 2.6 秒拍的现场快照）：URL 就是目标报表页
  `one.alimama.com/index.html#!/report/account?...startTime=2026-10-15&endTime=2026-10-15...`，
  标题「营销场景报表_万相台无界版」，**可见文本里明明白白有期望身份**
  `里可林家居:小嘉 ID：2350600069`。
- `03-promotion-submit.txt`：`exit=1`，stderr 就是上面那句「身份读不到」；stdout 里**没有** `[身份]` 行
  （说明读取返回的 memberName 为 null，而不是读到了不匹配的值）。
- `02-alimama-date.txt`：落位 `status=APPLIED`，`settled` 一步干净（无 `readFailures`）。
- 权威回读（独立探针）：失败当时底单 2026-10-15 只有 5 行，**无里可林淘宝**。

## 2. 根因（已定位到行）

判据点：`skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs:126 assertAlimamaIdentity`
（原 `const identity = await evalOn(args, targetId, alimamaIdentityExpression());`），
调用点 `collect-promotion-report.mjs:1024`（在 `run()` 里，紧随 `bringToFront`）。

- 判据表达式 `alimamaIdentityExpression()`（`collect-core.mjs:727`）读的是 `document.body.innerText`，
  用正则 `主账号:子账号 ID：数字` 抓会员名/ID。
- **它是单次读、没有任何等待/重试**，而页头（账号块）是阿里妈妈 SPA **异步渲染**的。
  promotion-submit 一开跑就读，撞上「页已经在报表路由上、但页头还没画进 innerText」的时序竞态
  ⇒ 读到 null ⇒ fail-closed 抛「身份读不到」。
- 与「身份对不上」是两回事：快照（约 2.6 秒后）里页头正好有期望身份，且错误文案是「读不到」而非
  「对不上」。
- 旁证：本轮修复后重跑的 `03-promotion-submit.txt` 里，`[身份]` 之后紧接着 submit 段打印
  `正文 0 字符` —— 即同一页在身份核对后一小段时间内 `innerText` 仍是空的，直接印证 innerText 渲染竞态。

## 3. 第 0 步：实例

- 检查：`curl/Get-NetTCPConnection` 显示 19041（本店）**FREE**（全部店铺实例在本批跑完已被释放）。
- 拉起：后台跑 `node scripts/start-all-hold.mjs --only 里可林淘宝`（run_in_background）。
  输出：`已起 browser pid=132880 / proxy pid=121052`；`起后:ready`。
- 读两遍确认：`19041 LISTEN pid=121052`（两遍相同）。**未碰 网林天猫 19032/19042。**

## 4. 候选动作尝试（按指导书，只从 candidates 挑、先 dry-run）

重启后窗口里**只有标识页** `file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?...里可林淘宝`，
alimama 工作页尚未建立。于是：

```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 里可林淘宝 \
  --proxy http://127.0.0.1:19041 --stage promotion-submit --cause STAGE_FAILED \
  --action REAPPLY_DATES --log-dir evidence/batches-2026-10-15/b1/里可林淘宝 --dry-run
# ❌ 未应用：找不到要修的那一页：窗口里找不到符合「one.alimama.com」的页   （exit 3）

node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 里可林淘宝 \
  --proxy http://127.0.0.1:19041 --stage promotion-submit --cause STAGE_FAILED \
  --action RELOAD_PAGE --log-dir evidence/batches-2026-10-15/b1/里可林淘宝 --dry-run
# ❌ 未应用：找不到要修的那一页：窗口里找不到符合「one.alimama.com」的页   （exit 3）
```

说明：
- `REAPPLY_DATES` 属于**设计上恒不 `applied`** 的动作（`repair-shop-stage.mjs:285 runReapplyDates`：
  它只如实报「日期需要重落」、把落位交给 date 阶段，不在自身重复实现落位）。
- `RELOAD_PAGE` 需要窗口里已存在 alimama 页才能定位目标页；重启后只有标识页 ⇒ `TARGET_PAGE_MISSING`。
- 这与证据目录里 `97-repair.json` / `97-repair.txt` 一致（最后一次为 RELOAD_PAGE 的排练结论）。
- 两个候选都**不是「试了没用」**，而是「现场（alimama 工作页）尚不存在」——按交接书纪律，这属于
  「动作还没在目标页上试过」，不能据此判转人。

因此先**重建工作页**：重跑本店链（从落位阶段起，会把标识页导航到报表页，并重试 promotion-submit
及其之后的阶段）。本轮修复的正是根因，故重跑即为有效修复。

## 5. 修复动作

### 5.1 代码（修根因，最小改动）

见 `97-repair-agent-code-diff.patch`（同步落盘于本目录）。

- `collect-core.mjs`：新增导出 `readAlimamaIdentitySettled(read, {attempts=12, intervalMs=1000, delay})`
  ——「读不到就重试若干次，仍读不到才把值交回」。闸门语义未变：最终仍由 `assertMemberIdentity`
  fail-closed 抛错（身份未知照样停止）。read 抛错也计入重试；整轮都在抛则抛最后一次（区分「读不到页」）。
- `collect-promotion-report.mjs`：`assertAlimamaIdentity` 改用它读取身份（与 date-picker 的 settle 同尺子）。
  调用点 `run()` 里的 `await assertAlimamaIdentity(args, targetId)` 一行**未动**（源码守卫依赖它）。
- `collect-core.test.mjs`：补两条守卫用例（见 §6）。

影响面：仅阿里妈妈身份读取这一处；读不到时的最坏等待由「0」变为「12×1s」，失败方向不变。
兄弟脚本 `run-promotion-daily-report.mjs` 有同形单次读，但不在本链路径上，**本轮未动**（避免扩大改动面）。

### 5.2 重跑本店链（重建页面 + 重试失败阶段及其后）

```
node scripts/run-daily-job.mjs --date 2026-10-15 --shops 里可林淘宝,科塔淘宝 \
  --batches 5 --notify-print --auto-repair --mode apply
```

> 用 `--notify-print`（而不是任务书命令里的 `--notify`）：本轮已修好，无需发飞书；
> 即使失败也只打印、不打扰人（遵守「不要自己发飞书」边界）。

结果：`batch-chain 退出码=0`，全链退出码 0。

## 6. 回读与验证

- 重跑后的 `03-promotion-submit.txt`（exit=0）：
  `[身份] 阿里妈妈会员 = "里可林家居:小嘉" ID="2350600069"｜期望 "里可林家居:小嘉" / 2350600069 ✓`
  随后 `promotionTaskName = 营销场景报表_20261016_130722`。
- 本店 summary：`status=ok`，11 个阶段 **all-ok**（health-check/alimama-date/promotion-submit/
  sycm-date/shop-report/promotion-fetch/push/sycm-reset/sycm-date-again/backfill/readback）。
- 独立探针回读：`node D:/Retire/probe-live/readback-2026-10-12-daily.mjs 2026-10-15`
  → 底单 2026-10-15 **命中 7 行**（此前 5 行），新增 `里可林家居 rec=reczz28NxeUnECiA`
  与 `科塔全卫定制 rec=reczz28Nxhm0SJCL`。
- `11-readback.txt`：本店询单表行 `2026-10-15 | 里可林淘宝 | 询单量=5 | 同层同行=6`。

## 7. 测试（仓库根，原始数字）

```
node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"
# tests 634 / pass 634 / fail 0
```

新增守卫（`collect-core.test.mjs`）：
1. 行为用例：`readAlimamaIdentitySettled` 在第 N 次读到即停（`reads=3`、两次空读间各睡一次）；
   始终读不到 ⇒ `settled=false` 原样交回；read 抛错计入重试、全抛则抛最后一次；抛一次后读到仍成功。
2. 源码守卫：「阿里妈妈脚本的身份读取必须走 `readAlimamaIdentitySettled`；`assertAlimamaIdentity`
   里不许再出现裸 `await evalOn(... alimamaIdentityExpression())`」。

**突变验证（旧代码会红）**：把 `collect-promotion-report.mjs` 临时还原为 HEAD 的单次读版本，跑
`--test-name-pattern "settle 重试"` → `not ok 2`（源码守卫红，报「没有走 readAlimamaIdentitySettled」）；
还原新版后该用例恢复绿（`# pass 2 / # fail 0`）。

## 8. 剩余阻塞 / 回滚

- 无剩余阻塞。本店已完整写回。
- 回滚：`git checkout -- skills/sycm-alimama-daily-report/scripts/collect-core.mjs \
  skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs \
  skills/sycm-alimama-daily-report/scripts/collect-core.test.mjs`（未提交，改动全部留在工作区与
  本报告附带的 patch 里）。
