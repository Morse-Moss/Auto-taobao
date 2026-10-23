# 修复 agent 报告 —— 里可林淘宝 @ alimama-date（目标日 2026-10-17）

- 派单来源：`evidence/batches-2026-10-17/batches.log`（第 1/2 批，链退出码 1，脚本自修没救回来，批次不释放、转驻留）
- 修复请求单：`97-repair-request.json`（cause=STAGE_FAILED，stage=alimama-date，candidates=[REAPPLY_DATES, RELOAD_PAGE]）
- 现场事实：`98-failure-state.json` / `98-failure-state.txt` / `98-failure-page.png`（失败时刻 07:05:39，本地时间 UTC+8）
- 实例：`http://127.0.0.1:19041`（本店自己的实例；`alimama-date` 属非共用阶段，`--proxy` 与 `--shop` 一致）
- 仓库基线：`git log -1` = `fa6852d evidence：10-17 07:00 日报定时（目标日 10-16）2/2 批全绿、8/8 店`
- 全局运行锁：`runtime/.workflow-locks/merchant-automation.json` = `{owner: daily-report, pid: 85056, runId: 85056-1792278126041, acquiredAt: 2026-10-17T23:02:06Z}`（**全程未动，未跑 run-daily-job / run-batches**）

## 结论（一句话）

**fixed**：不是权限墙，是**阿里妈妈会话在跑前预检之后掉了登录**；`--relogin-on-wall` 的判据（`loginWallOf` 只认登录页 URL）漏掉了「报表路由被换成『页面不存在或无权访问』页」这一形态，于是脚本只拿到两个页面级候选动作、修不到会话。本 agent 补登一次（浏览器自带密码库自动填充，无验证码、身份闸门 ACCEPT=里可林家居:小嘉）后**同一阶段同一命令直接通过**（exit 0 / status=APPLIED / settled 2026-10-17）。**后续 3~11 步（含 push/readback）未跑，需由驻留/补跑继续，未自行推飞书。**

## 时间线（命令 + 回读）

| 时刻(本地) | 动作 | 回读结果 |
|---|---|---|
| 07:05:39 | 链内部：`date-picker.mjs --site alimama --date 2026-10-17 --proxy http://127.0.0.1:19041`（`02-alimama-date.txt`） | exit 1；`alimama: state did not settle to 2026-10-17（读 16 次，全部读不到）; lastReadError=HTTP 400 alimama filter bar not ready; triggers=0`；trace 里 navigate 落在报表路由 |
| 07:05:38–07:03:16 | 链跑前 `login-preflight`（`batches.log` L126-L215） | 该店 `verdict: OK`，`sycm: LOGGED_IN`、`alimama: LOGGED_IN`（href=`https://one.alimama.com/index.html`）⇒ **07:03 时阿里妈妈登录态还在** |
| 07:06:02 | 感知层抓现场（`98-failure-state.json`） | URL=报表路由；可见文本=「抱歉，您查看的页面不存在或无权访问。如果您使用淘宝子账号登录，可能因权限不全导致落到本页面……」；遮挡层 0；可见元素仅「回到首页」「返回上一页」；`tables: []` |
| 07:06:35–07:06:58 | 脚本自修：REAPPLY_DATES、RELOAD_PAGE（`03-alimama-date.txt`、`batches.log` L534-L538） | 两个动作都没救回来，同一条 `triggers=0` 报错 |
| 07:18 | `curl -s -m 5 http://127.0.0.1:19041/targets`（第 0 步：实例在位） | 3 个页签全在（sycm 工作页 / 阿里妈妈报表页=报表路由 / 店铺标识页），**实例未被释放**，无需 `start-all-hold.mjs` |
| 07:19 | `node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --check-only --proxy http://127.0.0.1:19041 --shop 里可林淘宝 --notify off` | `verdict: NEEDS_LOGIN`；`sycm.loggedIn=true`（href=工作页）；`alimama.loggedIn=false`（href=`https://one.alimama.com/index.html#!/login/index`）；`tech.browserProfile=D:/Retire/edge-profiles/likelin-home` |
| 07:21 | 只读回读该页正文（`POST /eval`） | `url=#!/login/index`、`title=万相台无界版`、正文首段「首页 / 立即登录 / …」、`input` 数量 = 0 ⇒ 公开着陆页，不是「已登录但无权限」的报表页 |
| 07:24:31 | `node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --commit --proxy http://127.0.0.1:19041 --shop 里可林淘宝 --notify off`（**仅此一次**，`97-relogin-attempt.json`） | `verdict: LOGGED_IN`；候选 `havanaone`；`autofill.id/password=true`；`afterGesture.idLen=8 / passwordLen=8`；`guard.verdict=ACCEPT`、`expected/filled 均为「里可林家居:小嘉」`；`captcha=false`；`agreementChecked=true`；`urlAfter=https://myseller.taobao.com/home.htm/QnworkbenchHome/`；`alimama.loggedInAfter=true`、`hrefAfter=https://one.alimama.com/index.html` |
| 07:25:22 | `node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 里可林淘宝 --proxy http://127.0.0.1:19041 --stage alimama-date --cause STAGE_FAILED --action RELOAD_PAGE --log-dir evidence/batches-2026-10-17/b1/里可林淘宝 --dry-run` | `目标页 = https://one.alimama.com/index.html`（**不是标识页、不是登录页**）；`❌ 未应用：排练`；`97-repair.json` / `97-repair.txt` 如实记「未应用（--dry-run）」 |
| 07:25:29 | 重试失败那一步（阶段原命令，未起第二个 run-daily-job）：`node skills/sycm-alimama-daily-report/scripts/date-picker.mjs --site alimama --date 2026-10-17 --proxy http://127.0.0.1:19041`（`97-retry-alimama-date.json`） | **exit 0**；`status: APPLIED`；`observedAfter: " 昨日"`；trace `enter-report-route.landed.t = 营销场景报表_万相台无界版`、`settled.applied = 2026-10-17`；`filters` 读到完整筛选栏（关键词推广/人群推广、末次点击归因、30天累计数据、昨日、分日、全部计划、周环比、展现量、维度 营销场景、20条/页） |
| 07:26 | 复查 `/targets` | sycm 工作页 1、阿里妈妈报表页 1（报表路由、`isRequestedQztDefaultSet=1`）；另有登录流程留下的「千牛商家工作台」页 1（`myseller.taobao.com`）与店铺标识页 1 |

## 「权限墙 vs 掉登录」的判定依据（这是本次唯一的分叉点）

派单口径假设「权限不足 ⇒ 只能人上」。实测**否掉了这个假设**，依据三条，缺一不可：

1. **同一账号、同一店铺、两天前是通的**：`evidence/daily-report-2026-10-16-里可林淘宝/` 有完整产物（`plan.json` / `receipt.json` / `independent-readback.json` / 两张飞书截图），说明该子账号对 `onebpSearch`/`onebpDisplay` 场景报表**本来就有权限**；一次掉线不可能改变授权。
2. **修复后同一条命令直接成功**：补登后 `date-picker` 落在「营销场景报表_万相台无界版」并读到完整筛选栏、`settled 2026-10-17`。权限不足的话这一步不会因为「重新填了一次密码」而变好。
3. **探针/页面自己说的话**：
   - 跑前预检 07:03 判 `alimama: LOGGED_IN`（href 停在首页 `index.html`），07:05:39 阶段失败时页面已换成「无权访问」页 ⇒ 掉登录发生在这 2 分钟内，是**会话事件**，不是配置事件；
   - `--check-only` 探针把该页导航到站点首页后落在 `#!/login/index`，正文是「首页 / 立即登录」的**公开着陆页**（`input=0`）；同一探针、同一时刻在**同一浏览器的生意参谋页**读到 `LOGGED_IN` ⇒ 排除机器级代理/网络原因，变量只剩「阿里妈妈这一份会话」。
   - 对照口径取自技能 `parked-tab-vs-expired-session` 第四节之二（同一 probeUrl × 不同实体）与第二节（只读观测分不开两种成因，必须真导航一次再读）。

⚠️ 两点必须如实记下：

- **`--check-only` 不是「一个页面都不碰」**：`login-merchant.mjs:164` 的 `siteLoggedIn()` 会把已有页签 `navigate` 到 `probeUrl`（阿里妈妈=首页）再读 `location.href`，与文件头注释（第 36 行「纯读：连登录页都不开」、第 51 行「一个页面都不碰」）**不一致**。我的探针因此把失败现场那页从「报表路由」改成了「首页→login/index」。失败现场本身没有丢失（`98-failure-state.json` 早于探针落盘），但这意味着**探针之后无法再从该页复读原始失败形态**。这条列为「需代码修复（建议，本次未改）」。
- 探针的 `loggedIn=false` **不能直接当「必须人工」**：按上面的技能口径，它只说明「这一份会话要重新走一遍登录」；实际 `--commit` 一次就进（密码库自动填充，无验证码），**没有升级到人工**。

## 试过哪些候选、applied 真假

| 候选 | 谁执行 | applied | 回读 |
|---|---|---|---|
| REAPPLY_DATES | 脚本自修（07:06，`batches.log` L534/L537） | 否（阶段仍 exit 1） | 仍 `alimama filter bar not ready; triggers=0` |
| RELOAD_PAGE | 脚本自修（07:06） | 否（阶段仍 exit 1） | 同上 |
| RELOAD_PAGE | 本 agent，`--dry-run`（07:25:22） | 否（排练，按设计不发写请求） | 目标页辨认正确 = `https://one.alimama.com/index.html`；**未真跑**，因为根因不在页面层（会话层），补登后阶段自愈 |
| REAPPLY_DATES | 本 agent | 未执行 | 同上理由；阶段重跑本身已 `settled 2026-10-17`，不需要再落位 |

未发明任何动作名；未绕过 `repair-shop-stage.mjs` 直接操作浏览器；**未**再起第二个 `run-daily-job` / `run-batches`（锁被 pid 85056 持有）；**未**推飞书、**未**写任何飞书值。

## 顺带发现的现场状态（留给后续）

- 登录流程在 19041 里留下 1 个「千牛商家工作台」页签（`https://myseller.taobao.com/home.htm/QnworkbenchHome/`）。关闭页签**不在修复动作闭集**里（`DISMISS_OVERLAYS`/`RESET_PAGES`/`RELOAD_PAGE`/`REAPPLY_DATES` 都不含「关掉某个多余页签」），所以本 agent 没有动它。`alimama-date` 与 `health-check` 的归位只按期望清单保证「各恰好一个」，多余页签按既有口径只报不删（对照 `99-recovery.txt` 对店铺标识页的处理）。**如影响后续阶段，请由人或驻留的归位流程处理，本 agent 不停任何东西。**
- 店铺标识页 URL 里 `state=需要登录` 是 07:05 那次登录态判断留下的字面值，本次补登**没有**重写它（重写标识页属于窗口标识流程，不在本单范围）。

## 需代码修复（建议，本次未改）

**症状**：会话掉了，但链的 `--relogin-on-wall` 没触发，脚本只拿得到页面级候选动作，最终被判 `STAGE_FAILED` 并走「自修没救回来」路径。

**根因（已定位到行）**：`run-multi-shop-day.mjs:2163` 的补登闸门依赖 `loginWallOf()`（`:643-661`），而它只在**页签 URL 命中 `SITES[].loggedOut` 正则**（`login/index`、`member/login`、`login.htm`）时才返回登录墙。本次失败时 URL 是正常的报表路由（`#!/report/account?...`），只是**页面内容**换成了「页面不存在或无权访问 / 子账号权限不全」——URL 判据读不到，`wall=null`，补登分支整段跳过。

**建议改法（最小面）**：在 `result.status !== 0 && args.reloginOnWall` 那条分支里，`wall` 为 null 时再做一次**只读**判定——同一个 `--proxy` 上跑一次 `login-merchant --check-only`（或等价地读该站点 `probeUrl` 的落地 URL），`verdict=NEEDS_LOGIN` 才补登。理由：单凭「无权访问」几个字直连补登会把**真实的子账号权限墙**（如 2026-09-21 科塔那次）也当成掉登录反复试，锁号风险不可接受；而「只读探一次再决定」把两者分开，且与 `parked-tab-vs-expired-session` 的处置顺序一致（先让一层登录流程跑一次，再谈人工）。
**另一处（文档级）**：`login-merchant.mjs:36/51` 声称 `--check-only` 一个页面都不碰，实际 `siteLoggedIn()` 会 navigate。要么改注释，要么改成「已存在页签只读 `location.href`、不 navigate」（后者会让「页签漂移」判不出来，需另配一个判据，别直接删）。

**影响面 / 回滚**：本次**未修改仓库任何代码/配置**（`git status` 里只有 `evidence/` 下的新增文件），因此无需回滚，也没有 `97-repair-agent-code-diff.patch`。

## 待办（交回 team-lead）

1. 该店 **3~11 步未跑**（`promotion-submit` … `readback`）。锁仍由 pid 85056 持有，需由驻留/补跑用既有入口续跑（续跑范围见 `batches.log` L690），**不要**在本 agent 之外再起第二个 run-daily-job。
2. 续跑后确认飞书底单该店那一行确实写入（本 agent 未推、未写）。
