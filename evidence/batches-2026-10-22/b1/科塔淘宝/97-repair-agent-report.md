# 修复 agent 报告 — 科塔淘宝 / promotion-fetch / 2026-10-22

- 修复 agent：repair-agent-1022（后台会话）
- 目标日：2026-10-22（Asia/Shanghai）
- 停在哪一步：`promotion-fetch`（第 6 步），exit 1
- 请求单：`97-repair-request.json`｜cause=`STAGE_FAILED`｜stage=`promotion-fetch`
- 结论：**blocked-by-lock**（页面已复位并回读确认；重试被外层 run-daily-job 持有的运行锁挡住，未硬跑）

---

## 1. 只读现场（时间线起点）

读了：`97-repair-request.json`、`98-failure-state.json/.txt`、`06-promotion-fetch.txt`、`07-promotion-fetch.txt`、`99-recovery.txt`、`03-promotion-submit.txt`（截图 `98-failure-page.png` 仅作辅助，判据以请求单 cause/stage 为准）。

现场事实（原文摘录）：

- `98-failure-state.txt`
  - `页面：首页_万相台无界版`｜`URL：https://one.alimama.com/index.html`
  - 遮挡层 2 个：`DIV rect=219,72,1062x550`（「添加商品 3/30 …」面板）、`DIV rect=219,622,1062x65`（「立即下单」条）
  - 可见文本里有 `j873522735:小瓜 ID：412070158`（身份对）
- `06-promotion-fetch.txt`（exit=1）
  - `[遮挡] 已重载页面（下载任务管理_万相台无界版）—— 在新现场上再走一遍`
  - `[fetch] 列表读到 0 条任务（目标日按「日期范围」列认，不按任务名认）`
  - stderr：`采集失败：取件前核对未通过：列表里读到 0 条任务名，但没有一条能读出「日期范围」列 ⇒ 判据失效（页面结构可能变了）…`
- `07-promotion-fetch.txt`（exit=1，脚本自修后重试那次）
  - `[遮挡] 已重载页面（万相台无界版）—— 在新现场上再走一遍` ← **标题里「下载任务管理」没了 = 重载把 hash 路由丢了、落回首页**
  - 仍然 `[fetch] 列表读到 0 条任务`
- `03-promotion-submit.txt`（exit=0）：提交成功，`promotionTaskName = 营销场景报表_20261023_082019`，且当时「列表里恰好多出 1 条」⇒ **任务本身是提交成功的**。
- `99-recovery.txt`：停手时 5 个页签，阿里妈妈报表页 1 个；回位只对生意参谋页做了归位。

判读：失败不是「日期落位错」，也不是「提交没成功」，而是**取件段读列表读到 0 行**，随后把 0 行读成「判据失效」。

## 2. 实例前置条件（没起任何实例）

- `curl -s -m 5 http://127.0.0.1:19044/targets` → 返回 4 个 target（label 页 / `下载任务管理_万相台无界版` `#!/report/download-list` / 生意参谋 `#/shop` / `edge://downloads-hub/`）
  ⇒ 代理在听、目标页在，**未执行 startCommand，未起 start-all / start-all-hold**。
- 目标页定位按阶段提示 `alimama` 解析到 `3AB6B15A8ED73AF608D83F0226EB4E7A`（`https://one.alimama.com/index.html#!/report/download-list`）。

## 3. 候选动作（按顺序试，动作全部走 repair-shop-stage.mjs，未绕过）

### 3.1 REAPPLY_DATES

排练：

```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 科塔淘宝 --proxy http://127.0.0.1:19044 \
  --stage promotion-fetch --cause STAGE_FAILED --action REAPPLY_DATES \
  --log-dir evidence/batches-2026-10-22/b1/科塔淘宝 --dry-run
```

回读：`[修复] 目标页 = https://one.alimama.com/index.html#!/report/download-list`、`EXIT=0`（排练只定位，不写）。

真跑（去掉 `--dry-run`）：

```
[修复] REAPPLY_DATES｜科塔淘宝@http://127.0.0.1:19044｜阶段 promotion-fetch
[修复] 目标页 = https://one.alimama.com/index.html#!/report/download-list
[修复] ❌ 未应用：日期需要重新落位（alimama）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位
EXIT=1
```

回读：`applied=false`（该动作按设计只回报「日期需要重落」、交给 `alimama-date` 阶段，本身永不为 true），证据另存 `97-repair.REAPPLY_DATES.json/.txt`。
⇒ 按指导书「applied!==true ⇒ 换下一个候选」，换 RELOAD_PAGE。

### 3.2 RELOAD_PAGE

排练：同上命令换 `--action RELOAD_PAGE --dry-run` → 目标页同上，`EXIT=0`。

真跑：

```
[修复] RELOAD_PAGE｜科塔淘宝@http://127.0.0.1:19044｜阶段 promotion-fetch
[修复] 目标页 = https://one.alimama.com/index.html#!/report/download-list
[遮挡] 已重载页面（下载任务管理_万相台无界版）—— 在新现场上再走一遍
[修复] ✅ 已应用：页面已重载并就绪
EXIT=0
```

回读：`applied=true`；**这次重载后标题仍是「下载任务管理_万相台无界版」**（路由没丢），证据另存 `97-repair.RELOAD_PAGE.json/.txt`。

### 3.3 动作后页面回读（只读 eval，未做任何写）

```
{"href":"https://one.alimama.com/index.html#!/report/download-list",
 "title":"下载任务管理_万相台无界版",
 "rows":41,
 "named":["营销场景报表_20261023_082019","营销场景报表_20261022_112440","营销场景报表_20261022_081835",...],
 "hasRange":true}
```

且正文含：`生成成功 营销场景报表_20261023_082019 30天累计数据 2026-10-22至2026-10-22 2026-10-23 下载 删除`
⇒ **目标日那一笔任务在页面上、状态「生成成功」、日期范围 2026-10-22 至 2026-10-22**，即取件段要做的事现在有页可做。

## 4. 重试那一步：未执行（撞锁）

`runtime/.workflow-locks/merchant-automation.json` 仍被外层持锁：

```
{"name":"merchant-automation","owner":"daily-report","runId":"126236-1792713786427",
 "acquiredAt":"2026-10-23T00:03:06.427Z","pid":126236}
```

`tasklist /FI "PID eq 126236"` → `node.exe 126236` 存活。

按本轮硬约束：未删锁、未停/杀任何进程、未并发硬跑 `node scripts/run-daily-job.mjs --date 2026-10-22 --shops 科塔淘宝`（该命令此刻必然 `WORKFLOW_LOCK_BUSY`）。

**待办（驻留结束 12:21 之后或宿主回收后执行一次）**：

```
node scripts/run-daily-job.mjs --date 2026-10-22 --shops 科塔淘宝
```

跑完用 OpenAPI 回读底单 2026-10-22 该店行数确认写入（本轮未做，因为重试没跑）。

## 5. 根因（现场证据指向，已按根因改代码）

两段日志合起来是一条完整的因果链：

1. `openTaskList()` 的动作序列是 `navigateTo(download-list)` → sleep 7s → **真重载** → **立刻读一次** `readTaskRows`。
2. 重载的判据只是 `document.readyState === 'complete'`，而任务表格是**重载之后异步拉的** ⇒ 紧接着读的那一次读到 **0 行**（06 就是这样：标题还在列表页，行是 0）。
3. 0 行被上层读成「判据失效（页面结构可能变了）」⇒ 整店 `STAGE_FAILED`，**而任务早已 `生成成功`**（本报告 3.3 已回读到）。
4. 另一条同形分支：重载偶尔把 hash 路由丢掉、落回首页（07 的标题从「下载任务管理_万相台无界版」变成「万相台无界版」）⇒ 那一屏再怎么读都是 0 行。

改法（最小面）：`openTaskList` 读到 0 行时**等一屏再读**（最多 5 次 × 2s），并在确认路由不是 `download-list` 时**补一次导航**（只补一次，不无限重导航）。不改判据口径、不改提交段逻辑、不动动作闭集。

- 改动文件 1：`skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs`（`openTaskList`，接口与返回值形状不变：仍返回行数组）
- 改动文件 2：`skills/sycm-alimama-daily-report/scripts/promotion-fetch-wait.test.mjs`
  - 原「读之前必须真重载」那条守卫的函数体截取从固定 900 字窗口改成「独占一行的 `}`」，否则加循环后 `readTaskRows(` 会被切到窗口外而误判；
  - 新增守卫：`openTaskList` 里必须至少读两次、循环条件必须盯 `rows.length === 0`、必须认得出路由丢到首页、补导航必须在重载之后。
- 测试回读：`node --test skills/sycm-alimama-daily-report/scripts/promotion-fetch-wait.test.mjs` → `# tests 5 / # pass 5 / # fail 0`
- `node --check` 该模块 → OK
- 完整 diff：同目录 `97-repair-agent-code-diff.patch`（102 行）
- 影响面：只影响 promotion 取件段/提交段读列表这一处；正常有行的情形（首读即 >0）行为完全不变，只在「读到 0 行」时多等最多约 10s（或补一次导航）。
- 是否要回滚：不需要；若要回滚，`git checkout -- skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs skills/sycm-alimama-daily-report/scripts/promotion-fetch-wait.test.mjs` 即可（这两个文件本轮之前是干净的，`git log -1` = `1cfde8b`）。

## 6. 为什么不是 REAPPLY_DATES

`REAPPLY_DATES` 在 `repair-shop-stage.mjs` 里是「如实回报日期需要重落、请重试 `alimama-date` 阶段」，`applied` 恒为 false；本次失败现场也**没有日期漂移的迹象**（任务行日期范围就是 2026-10-22 至 2026-10-22，提交段 URL 的 `startTime/endTime` 也对）。真正卡住的是列表读不到行，所以有效动作只有 RELOAD_PAGE，根因修在读取时机上。

## 7. 边界声明

- 未改 `.workbuddy/` 下任何东西。
- 未重启/停止任何进程、容器、浏览器；未起任何新实例。
- 未写飞书（写飞书只能由链的 push 步骤做）。
- 动代码前已 `git log -1` = `1cfde8b fix(promotion): 取件段读任务列表前补真重载（同 URL navigate 是空操作）`；只改了本轮之前干净的两个文件，未碰其他会话在改的文件。
