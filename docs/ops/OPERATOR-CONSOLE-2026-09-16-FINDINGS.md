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

## 2. 真机验收（一期 25/25；接上动作层之后 33/33）

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

## 5. 发现的两个既有缺陷（**同日已修**，改动与判据在下面）

### 5.1 `orchestrateFaq` 收了 `runtimeRoot` 却从不把它传给子进程

- `runtime/run-flow-orchestrator.mjs:181` 用 `runtimeRoot` 定位自己的 events 文件，
  但 `:184` / `:194` / `:205` 三处 `spawn(FAQ_OPERATOR, [...])` 的参里**没有** `--runtime-root`。
- 后果：`--runtime-root` 看起来生效（事件写到你指定的地方），实际子进程永远打默认的
  `runtime/` rel 到 cwd —— 典型的「参数看起来生效、实际打错目标」（坑 35）。

**修法**：`orchestrateFaq` 现在把 `path.resolve(runtimeRoot)` 的结果拼进 `baseArgs`，
`--status` 与 `--advance` 两跳都带上（一处改，两跳都覆盖）；顺带把它绝对化 ——
相对路径会分别按「调度器的 cwd」和「子进程的 cwd」解析成两个地方。
help 文本也改了，并明确写出「xws 流的 runtimeRoot 只决定 events 写在哪，那一条流的真相是
PostgreSQL + checkpoint」——原来那句话让人以为两个流语义一样。

### 5.2 `--status` 这个「只读探测」会写运营可见状态

这条是上一轮的**真正病灶**，比 5.1 更隐蔽：`persistStatus` 在 `--status` 路径上也会写
`operator-status.json`，所以「看一眼」会改运营看到的检查时间。

- `runtime/run-flow-orchestrator.test.mjs:259`（"CLI dry-run against the real completed FAQ period…"）
  用默认根调用真编排器 → `run-faq-operator.mjs --status` → `persistStatus` 会**写**文件。
- 实测：`runtime/faq-analysis/2026-08-23_2026-08-29/operator-status.json` 的 mtime 与 `checkedAt`
  都是 `2026-09-16T13:06:24Z`，正是本轮第一次跑全量 `runtime` 套件的时刻；同一秒还写了
  `runtime/orchestrator/faq-2026-08-23_2026-08-29/events.jsonl`。
- 两个目录都在 `.gitignore`（`runtime/faq-analysis/`）或内容恰巧未变，所以 `git status`
  看不出来 —— 这类「测试污染运营可见状态」不会自己暴露。
- 影响：运营看到的「检查时间」会被测试运行顶成刚刚，一个没人看过的周期看起来像刚检查过。

**修法（不搬那 2GB）**：与其把两处收据目录拷进临时根（合计约 2 GB，不现实），不如
**让只读探测真的只读**：

1. `run-faq-operator.mjs` 新增 `--no-persist`，`main()` 只在允许落盘时才写状态。
2. 并且 **`--no-persist` 与 `--advance` 同时出现直接报错**：推进却不落收据 = 真动了数据又不留证据，
   那是最坏的一种组合，所以做成 fail-closed 而不是「看调用方自觉」。
3. 调度器的状态探测（循环里每次轮询都跑）一律带 `--no-persist`；推进那一跳不带，
   所以运营台看到的 `checkedAt` 含义是「运营侧最后一次真的检查/推进」，而不是「调度器第 N 次轮询」。
   每轮决策仍落在 `events.jsonl` 里，追溯不受影响。
4. 那条污染测试拆成三条，且都不写生产：
   - 子进程必须收到**绝对** `--runtime-root`，且状态探测必须带 `--no-persist`（断言子进程实参）；
   - CLI 干跑指向临时根：判定必须来自临时根（`DRY_RUN` 而不是 `DONE`），**且仓库里的收据与
     事件流一个字节都没动**（比 (存在性, 字节数, mtime) 三元组）；
   - 「真实已完成周期报 DONE」这条覆盖保留，但改用**纯读**函数 `inspectFaqOperatorStatus`，零写入。

**突变验证**（「测试全绿」不证明判据有效，只证明没人碰过它）：

| 突变 | 结果 |
| --- | --- |
| 去掉子进程的 `--runtime-root`（回到缺陷态） | 抓到了，2 条红（含「隔离」那条） |
| 去掉状态探测的 `--no-persist`（回到会写状态） | 抓到了，1 条红 |

还原后文件 sha256 前 12 位与改动前一致，复跑 18/18 绿。

---

## 6. 二期：把按钮真接线（同日完成）

一期验收里有一条「页面上没有可点的按钮」。二期把它换掉了 —— 不是把按钮点亮，而是
**把动作层做出来**：`runtime/operator-console/actions.mjs`。

三个动作，只覆盖 FAQ 链（与最小切片一致）：

| 动作 | 改数据 | 要确认 | 干什么 |
| --- | --- | --- | --- |
| `preview-faq` | 否 | 否 | 编排器 `--dry-run` 只读干跑，把「接下来会执行什么」原文拿出来 |
| `refresh-faq-status` | 是（只重写状态收据） | 否 | `run-faq-operator.mjs --status`，刷新运营台看到的检查时间 |
| `advance-faq` | 是 | **是** | `run-faq-operator.mjs --advance`，**只推一格**，推完重读状态 |

四条边界（都写死在服务端，页面只是触发器）：

1. **能不能推由调度器说了算**：服务端 import `decideFaqStep`，不在控制台里抄第二份阶段名单。
   后果是浏览器采集与人工核验拒（`HUMAN_STAGE`）、**飞书发布一律拒**
   （`EXTERNAL_WRITE_NEEDS_AUTHORIZATION`，发布只能去命令行带 `--authorize-publish`）。
   拒绝返回 409 + `reasonCode` + 一句人话；被拒不动任何数据。
2. **推进前先探真实收据**（带 `--no-persist`）：判据来自磁盘，不是请求里说的「我在第几步」。
   而且**确认前后各判一次** —— 从「给出预览」到「人来点确认」之间收据可能已经变了。
3. **一次一个**：动作会改收据，并发推进会互相抢同一个目录 ⇒ 全局串行，并发请求 409 `ACTION_BUSY`。
4. **每个动作落审计流水** `<runtimeRoot>/operator-console/actions.jsonl`（参数/结果/退出码/用时）。
   动作有副作用却不留收据，是这个项目最不能接受的一种失败。

另外三条工程约束：请求体上限 8KB；子进程一律 `spawn(数组)`（永不 `shell:true`）、
脚本路径与 `cwd` 固定用**代码根**（只有数据根可注入 —— 一开始我用可注入的 `repoRoot` 当 cwd，
验收脚本为了隔离把它换成临时目录后脚本就找不到了，这才分清两个根是两个东西）；
超时**只停止等待、不杀子进程**（阶段是跑到一半会写收据的，中途 kill 比晚一点更糟）。

顺带修掉一个「服务说自己没在听的端口」：`/api/health` 与 `/api/env` 原来报的是登记表默认值，
在 19025/19026 起实例时就会对运营报 19024。现在报**实际监听端口**，登记表值另列 `registryPort`。

**验收 33/33**（原 25 条 + 8 条新的：按钮↔动作登记表一致性、灰按钮必须真 disabled、
推进被标为需确认、POST 预览真的跑了干跑、不带确认必被拒且什么都没发生、
动作端点不收 GET、未登记动作 404、自报端口与实际一致）。

`notCovered` 同步加严：**「点确认之后真的推进一格」不在验收里跑**（它会真的执行阶段脚本）；
那一条由 `server.test.mjs` 的临时根用例覆盖（断言子进程真有退出码、审计真有行），
验收里只验到「不带确认一定被拒」。另外「点击」这个动作本身没有模拟 —— headless dump-dom 不做交互，
所以两步确认验的是服务端契约，不是鼠标事件。

---

## 7. 下一步（按依赖排序，不改状态机与采集口径）

1. **接真实体检**（G1 剩下一半 + G2）：把每日链/生意参谋/阿里妈妈/灰豚/飞书四套判据接到
   `/api/accounts`，页面上的「示例」标与本条一起消失（改一处会红一片，是有意的）。
2. **给日报/周更/竞品各补一个 operator CLI**（G6），进度块与动作层才会从「只有 FAQ」变成「各链都有」。
3. **登录会话对象 + 自动续跑**（G3/§5.4）：先落恢复点再开窗；续跑复用幂等的 `--advance`。
4. **多实例**：动作层的串行锁是**进程内**的，两个控制台实例同时推进同一周期不会互相阻塞。
   要么在锁里加文件级互斥，要么约定只跑一个实例（当前约定是后者）。
