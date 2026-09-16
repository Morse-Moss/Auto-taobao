# 运营台一期实录（2026-09-16）

范围：把批准的五条落成真实代码 —— ①只用 FAQ 链做最小切片 ②补 `ACCOUNT_MISMATCH`/`AUTH_UNKNOWN`
③本地控制台（浏览器打开 `127.0.0.1`）不用桌面壳 ④自动续跑只针对「因登录暂停」 ⑤先出一版可点的空壳页。

设计依据：`docs/ops/OPERATOR-CONSOLE-INTERACTION.md`。页面说明书：`runtime/operator-console/README.md`。

---

## 1. 落成了什么

| 批准项 | 落点 | 证据 |
| --- | --- | --- |
| ⑤ 控制台端口进登记表 | `runtime/browser-ports.mjs`（`PROJECT_PORTS.operatorConsole = 19024`） | `runtime/browser-ports.test.mjs` 端口去重断言 |
| ② 补两个状态码 + 身份判据 | `runtime/xws-sku-auth-preflight.mjs`（`AUTH_UNKNOWN` / `ACCOUNT_MISMATCH` + `--expected-account`/`--account-selector` 强制成对 + `ALERT_BY_STATUS`） | 该文件测试 6 → 10 例；两文件合跑 26/26 |
| ⑤ 空壳页面（可点、假数据但标注） | `runtime/operator-console/`（server / state / index / styles / app） | 真机验收 25/25，见 §2 |
| ① 只用 FAQ 链做最小切片 | 进度块只渲染 FAQ 的 8 阶段，其余三链显式写「没有阶段清单」 | 验收「阶段清单与接口逐条一致」+ `NO_STAGE_LIST_FOR_OTHER_CHAINS` |
| ③ 本地控制台只监听回环 | `server.mjs` 把 `127.0.0.1` 写死，不给开关 | 验收「控制台在运行且只读」；协议层拒绝所有写方法 |
| ④ 自动续跑只针对登录暂停 | **本期未实现**（需要 loginSession + operator CLI，见 G3/G4）；本期只做到「页面不许把暂停渲染成失败」的前提条件 | 见 §3 未覆盖 |

顺带把状态机的阶段表与「摊平成阶段外观」抽成一份实现（`faq-operator-core.mjs` 导出
`ORDERED_STAGES` / `describeFaqStages`）：空发布豁免（`rawRecords === 0`）这条规则只能有一份，
页面自己实现一份就会把一个已经 DONE 的周期画成「还差最后一步」。

另外把测试发现逻辑抽成 `scripts/test-suite-discovery.mjs`，并加了一条守卫：
**runtime/ 下每个含 `.test.mjs` 的目录必须被某个套件认领**，否则新加的目录会「测试写了但没人跑」
而套件仍然全绿。守卫做过突变验证（临时塞一个 `runtime/tmp-guard-probe/` 会红）；
第一次写的时候它把平铺的 `runtime` 当成了前缀匹配、于是永远不红 —— 突变验证抓到了这个。

---

## 2. 真机验收（25/25）

```bash
node runtime/operator-console/server.mjs
node runtime/operator-console/acceptance.mjs --base http://127.0.0.1:19024 \
  --out evidence/operator-console-2026-09-16
```

证据在 `evidence/operator-console-2026-09-16/`：`results.json`、四个接口的真响应
（`api-*.json`）、渲染后的 DOM（`page-main.html` / `page-grey.html`）、三张截图。

判据里最要紧的四条（不是「页面能打开」）：

1. **页面不许自己算**：页面显示的 8 个阶段名与 `/api/runs` 给的逐个逐序相同；账号卡与
   `/api/accounts` 给的逐张相同；两列与登记表的 `BROWSER_PROFILES` 键相同。
2. **取不到就灰 + 带理由**：临时实例（同时替换 `runtimeRoot` 与 `repoRoot`）下，第 ④ 块渲染出
   `NO_STATUS_FILE_IN_PERIOD_DIR` 的灰块、写明「应该读：…/operator-status.json（不存在）」，
   并且**一个阶段都不渲染**（不许出现「8 步全绿」的假象）。
3. **示例数据必须自曝**：`/api/accounts` 自报 `probed: false`，6/6 张卡带 `sample=true`，
   页面上有「示例数据」横幅；预留的千牛卡是灰灯不是绿灯（假绿灯比红灯危害大）。
4. **一期只读**：页面上可点按钮 0 个；`POST/PUT/PATCH/DELETE` 一律 405 并附人话。

---

## 3. 验收没有覆盖什么（别把 25/25 读成「什么都验过了」）

- 「甲列登出后乙列不受影响」：需要真实体检接线（G1/G2），一期账号灯是示例数据。
- 「登录后自动续跑」与「探队列三种脸」：分别缺 loginSession（G3）与队列探针的生产调用方（G4）。
- `AUTH_EXPIRING` / `RISK_BLOCKED`：词表里有、体检还没产出，页面上单独列出以示未覆盖。

---

## 4. 过程中踩到并修掉的三个坑（都属于「看起来跑完了、其实没有」）

1. **`spawnSync` + 进程内服务 = 死锁。** 验收脚本要在同一个进程里既起控制台实例、又开 Chrome
   渲染它。`spawnSync` 阻塞事件循环 → 那个实例无法应答 Chrome → Chrome 等页面、脚本等 Chrome。
   实测表现为「脚本挂住 4 分钟不退出」，而日志停在截图那一行、看不出是死锁。改成异步 `spawn` +
   超时自杀。**这条对以后任何「同进程起服务 + 开浏览器验它」的脚本都适用。**
2. **灰灯场景只替换 `runtimeRoot` 会被 `evidence/` 回落填成绿的。** 第一次跑这个分支时
   三个断言全红，原因是真实仓库的 `evidence/faq-operator-status-*.json` 被当成回落源，
   于是「取不到」的周期变成了 available。灰灯用例**必须同时替换 repoRoot**。
3. **`--dump-dom` 的正则漏了数字。** 阶段名 `LOCK_TOP5` 含数字，`[A-Z_]+` 静默少算一个阶段，
   让「页面 7 个 / 接口 8 个」这条断言差一点因为数量对上而假绿。

另外：`class="spacer-y"` 是 12px 高的**占位块**，被误当内容容器用，第一次渲染时第 ③ 块所有行
挤在 12px 里互相压住 —— 截图看出来才发现的（渲染出来看一眼这条纪律的价值）。

---

## 5. 发现两个既有缺陷（**本轮未改**，需要拍板）

**缺陷：`orchestrateFaq` 收了 `runtimeRoot` 却从不把它传给子进程。**

- `runtime/run-flow-orchestrator.mjs:181` 用 `runtimeRoot` 定位自己的 events 文件，
  但 `:184` / `:194` / `:205` 三处 `spawn(FAQ_OPERATOR, [...])` 的参里**没有** `--runtime-root`。
- 后果：`--runtime-root` 看起来生效（事件写到你指定的地方），实际子进程永远打默认的
  `runtime/` rel 到 cwd —— 典型的「参数看起来生效、实际打错目标」（坑 35）。

**它的症状已经发生过：跑测试会改写运营看的运行态文件。**

- `runtime/run-flow-orchestrator.test.mjs:259`（"CLI dry-run against the real completed FAQ period…"）
  用默认根调用真编排器 → `run-faq-operator.mjs --status` → `persistStatus`（`:318-322`）会**写**文件。
- 实测：`runtime/faq-analysis/2026-08-23_2026-08-29/operator-status.json` 的 mtime 与 `checkedAt`
  都是 `2026-09-16T13:06:24Z`，正是本轮第一次跑全量 `runtime` 套件的时刻；同一秒还写了
  `runtime/orchestrator/faq-2026-08-23_2026-08-29/events.jsonl`。
- 两个目录都在 `.gitignore`（`runtime/faq-analysis/`）或未被忽略但内容恰巧未变，所以 `git status`
  看不出来 —— 这类「测试污染运营可见状态」不会自己暴露。
- 影响：运营看到的「检查时间」会被测试运行顶成刚刚，一个没人看过的周期看起来像刚检查过。
- 为什么要谨慎修：把子进程改成认 `--runtime-root` 是行为保持的（默认值就是 `runtime`），
  但**测试那一侧**要真正隔离就得把两处收据目录搬进临时根，而
  `runtime/faq-analysis/2026-08-23_2026-08-29` + `runtime/question-library-collection/2026-08-23_2026-08-29`
  合计约 **2 GB**，不能直接拷。需要一个别的设计（只搬小体积的收据 JSON，或让纯 `--status` 不落盘）。

---

## 6. 下一步（按依赖排序，不改状态机与采集口径）

1. **接真实体检**（G1 剩下一半 + G2）：把每日链/生意参谋/阿里妈妈/灰豚/飞书四套判据接到
   `/api/accounts`，页面上的「示例」标与本条一起消失（改一处会红一片，是有意的）。
2. **给日报/周更/竞品各补一个 operator CLI**（G6），进度块才会从「只有 FAQ」变成「各链都有」。
3. **登录会话对象 + 自动续跑**（G3/§5.4）：先落恢复点再开窗；续跑复用幂等的 `--advance`。
4. **上面 §5 那个缺陷**：建议连同它的测试隔离方案一起处理（单独一轮，别混进界面工作）。
