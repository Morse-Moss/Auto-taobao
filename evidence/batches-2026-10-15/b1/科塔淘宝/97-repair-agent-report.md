# 科塔淘宝 · promotion-submit 修复报告（修复 agent）

- 目标日：2026-10-15
- 失败阶段：`promotion-submit`（exit 1）
- 失败符号：`采集失败：阿里妈妈会员名身份读不到（期望「j873522735:小瓜」）`
- 证据目录：`evidence/batches-2026-10-15/b1/科塔淘宝/`
- 结论：**已救回**（底单 2026-10-15 出现「科塔全卫定制」行；本店 11 个阶段全绿）

---

## 1. 现场事实（先读，不重推）

- `97-repair-request.json`：`cause=STAGE_FAILED`、`stage=promotion-submit`、`stageHint=alimama`、
  `retryStage=promotion-submit`、`candidates=[REAPPLY_DATES, RELOAD_PAGE]`、
  `execHint` 的 `--proxy http://127.0.0.1:19044`。
- `98-failure-state.txt`（失败后约 2.6 秒拍的现场快照）：URL 就是目标报表页
  `one.alimama.com/index.html#!/report/account?...startTime=2026-10-15&endTime=2026-10-15...`，
  可见文本含期望身份 `j873522735:小瓜 ID：412070158`。
- `03-promotion-submit.txt`：`exit=1`，stderr 为「身份读不到」；stdout 里**没有** `[身份]` 行
  （读取返回 memberName=null，不是读到了不匹配的值）。
- `02-alimama-date.txt`：落位 `status=APPLIED`，但 `settle-retried reads=12 readFailures=11`
  —— **这一页极难落定**（页头/筛选栏反复读不到），与本店这次的渲染竞态高度一致。
- 权威回读（独立探针）：失败当时底单 2026-10-15 只有 5 行，**无科塔淘宝**。

## 2. 根因（已定位到行）

与 里可林淘宝 **同一处**、同一成因：

- 判据点 `skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs:126 assertAlimamaIdentity`
  （原为 `const identity = await evalOn(args, targetId, alimamaIdentityExpression());`），
  调用点 `collect-promotion-report.mjs:1024`，紧随 `bringToFront`。
- 判据表达式 `alimamaIdentityExpression()`（`collect-core.mjs:727`）读 `document.body.innerText`；
  **单次读、无等待**，而页头是 SPA 异步渲染 ⇒ 「页已在报表路由、字还没画上」时读到 null ⇒
  fail-closed 抛「身份读不到」。
- 快照里页头有期望身份、错误文案是「读不到」（不是「对不上」）+ date 段 `readFailures=11`
  ⇒ 这是渲染竞态，不是身份不匹配。

## 3. 第 0 步：实例

- 检查：19044（本店）**FREE**。后台拉起 `node scripts/start-all-hold.mjs --only 科塔淘宝`：
  `已起 browser pid=35424 / proxy pid=68344`，`起后:ready`。
- 读两遍确认：`19044 LISTEN pid=68344`（两遍相同）。**未碰 网林天猫 19032/19042。**

## 4. 候选动作尝试（按指导书，只从 candidates 挑、先 dry-run）

```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 科塔淘宝 \
  --proxy http://127.0.0.1:19044 --stage promotion-submit --cause STAGE_FAILED \
  --action REAPPLY_DATES --log-dir evidence/batches-2026-10-15/b1/科塔淘宝 --dry-run
# ❌ 未应用：读不到页签（代理连不上）：fetch failed      （exit 3）

node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 科塔淘宝 \
  --proxy http://127.0.0.1:19044 --stage promotion-submit --cause STAGE_FAILED \
  --action RELOAD_PAGE --log-dir evidence/batches-2026-10-15/b1/科塔淘宝 --dry-run
# ❌ 未应用：读不到页签（代理连不上）：fetch failed      （exit 3）
```

说明（如实记录时序）：
- 这两条是在本店链**已重跑成功、批次已释放实例之后**才补跑的 ⇒ 代理已不在，报「代理连不上」。
- 失败**当时**（重启后立即）窗口里只有标识页、无 alimama 工作页；与 里可林淘宝 完全同形
  （里可林那两条候选在实例在位的同一前提下跑出的是 `找不到要修的那一页`）。
- `REAPPLY_DATES` 属**设计上恒不 `applied`** 的动作（`repair-shop-stage.mjs:285 runReapplyDates`
  把落位交给 date 阶段）；`RELOAD_PAGE` 需要窗口里已存在 alimama 页。
- 两个候选都**不是「在目标页上试了没用」**，而是「现场/实例不满足前置」。按交接书纪律不能据此转人。
- 结论：本店与 里可林淘宝 共享**同一个根因、同一份修复**，走「重建工作页 + 重试失败阶段」。

## 5. 修复动作

### 5.1 代码（修根因，最小改动）

见 `97-repair-agent-code-diff.patch`（同步落盘于本目录）。改动与理由同 里可林淘宝：

- `collect-core.mjs` 新增导出 `readAlimamaIdentitySettled`（读不到就重试；仍读不到才交回，
  由 `assertMemberIdentity` fail-closed 抛；read 抛错计入重试，整轮都抛则抛最后一次）。
- `collect-promotion-report.mjs` 的 `assertAlimamaIdentity` 改用它读取会员身份；
  `run()` 中的调用行未动。
- `collect-core.test.mjs` 补两条守卫用例（见 §7）。

### 5.2 重跑本店链

```
node scripts/run-daily-job.mjs --date 2026-10-15 --shops 里可林淘宝,科塔淘宝 \
  --batches 5 --notify-print --auto-repair --mode apply
```

结果：`batch-chain 退出码=0`，全链退出码 0。（用 `--notify-print` 而非 `--notify`：不自行发飞书。）

## 6. 回读与验证

- 重跑后的 `03-promotion-submit.txt`（exit=0）：
  `[身份] 阿里妈妈会员 = "j873522735:小瓜" ID="412070158"｜期望 "j873522735:小瓜" / 412070158 ✓`
  随后 `promotionTaskName = 营销场景报表_20261016_131037`。
- 本店 summary：`status=ok`，11 个阶段 **all-ok**。
- 独立探针回读：底单 2026-10-15 **命中 7 行**（此前 5 行），新增
  `科塔全卫定制 rec=reczz28Nxhm0SJCL`（及里可林家居）。
- `11-readback.txt`：本店询单表行 `2026-10-15 | 科塔淘宝 | 询单量=3 | 同层同行=11`。

## 7. 测试（仓库根，原始数字）

```
node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"
# tests 634 / pass 634 / fail 0
```

新增守卫用例同 里可林淘宝报告 §7（行为用例 + 源码守卫）。**突变验证**：把
`collect-promotion-report.mjs` 临时还原为 HEAD 单次读版本 → 守护用例 `not ok 2`（红）；
还原新版后恢复绿。

## 8. 剩余阻塞 / 回滚

- 无剩余阻塞。本店已完整写回。
- 回滚：`git checkout -- skills/sycm-alimama-daily-report/scripts/collect-core.mjs \
  skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs \
  skills/sycm-alimama-daily-report/scripts/collect-core.test.mjs`（未提交）。
