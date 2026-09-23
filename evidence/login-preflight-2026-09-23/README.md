# 跑前登录态体检：真机取证（2026-09-23）

承接上一批 `evidence/cold-start-rehearsal-2026-09-23/`。那一批的 §七「本批次没做的事」第一条是：

> - **没造登录态体检能力**（已获授权，是下一件事）。本批的第 07 份是**手工**逐店跑的
>   `login-merchant.mjs`，一次性、没进仓库、没接进定时链。

本批就是「那件事」。用户对上一轮末尾三条待拍板事项的回复是 **「按你推荐的来」**，
其中第 2 条逐字是：

> 2. 造「跑前登录态体检」的能力（把 tmp 里那些一次性探针收编进 runtime/ 并接进定时链第一步之后）？
>    推荐做 —— 这是「关再续跑」能站住的前提。**只改代码，不碰你在跑的东西。**

**本批次只改代码 + 只读探测**：没有停/起任何进程、没有写飞书、没有真跑采集。

## 一、结论（七条）

1. **能力建成了**：一条命令 `skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs`
   把「五家店 × 两个后台（生意参谋 + 阿里妈妈）」一次问清，并直接说清「哪家店的哪个后台
   该用哪个会员名去登」。它**自己不实现探测** —— 探测只有一份，在
   `login-merchant.mjs --check-only` 里；连「哪个平台该显示哪个名字」也只有一份
   （`shop-identities.mjs`）。这一条链上**没有第二份**「未登录 URL 长什么样」的判据。
2. **补上了一个「只读检测其实会写」的洞**：原来的 `login-merchant.mjs` 在掉登录现场会
   `ensureLoginPage()` —— 也就是 `/new` 一个淘宝登录页。⇒ 加了 `--check-only`，
   让它在读完登录态之后立即返回（**在 `ensureLoginPage()` 之前**）。该开关**默认关**，
   不带它时行为与从前逐字相同。
3. **真机全绿**：五家店 × 两个平台 = 10 项，逐项「在登录态」，退出码 **0**
   （`03-live-five-shops.txt`）。
4. **「只读」这条卖点有可复核的账**：跑体检**之前**与**之后**，五个窗口的页签条数
   **逐个相同**（3 / 3 / 3 / 3 / 3 → 3 / 3 / 3 / 3 / 3），退出码 0
   （`02-tab-count-unchanged-retry.txt`）。见 §三。
5. **接进定时链第②步**：`ensure-instances → login-preflight → chain`（三步）。
   这一步的 `blocking: false` —— **它不是闸门**，掉登录会把结论写进日志、但**不会**挡住后面的链，
   和从前「照样开跑、采集阶段才炸」相比，差别只在「日志里现在会先写一句人话」。
6. **退出码是四个、失败方向各自不同**（刻意没糊成「非 0」）：
   `0`＝十项都正面确认在登录态；`2`＝有后台**明确掉登录**；`3`＝**这一层没有结论**
   （读不到 / 子进程失败）；`4`＝参数或用法错。`3` 与 `0` 分开的理由见 §四。
7. **一次瞬断，已定因、已处置**：第一次跑本批的证据脚本时，`after` 那一次快照的第一家店报
   `fetch failed / ECONNRESET`。四条互相独立的证据把它定为**瞬断**而不是故障（§五），
   处置是给快照函数加**一次**重发、且**只在没拿到任何 HTTP 应答时才重发**。
   原始失败留档在 `01-…`，重跑成功在 `02-…` —— 两条都在，不删。

## 二、过程与原始输出

| # | 是什么 | 输出 | 关键行 |
|---|---|---|---|
| — | 「没有多/少页签」的可复核脚本（自定位 `REPO_ROOT`） | `repro-tab-count-unchanged.mjs` | 跑前 / 跑后各读一次 `/targets`，中间调一次体检 |
| 01 | 第一次跑那个脚本（**含一次 ECONNRESET**，留档不删） | `01-tab-count-unchanged.txt` | `EXIT=1`，栈里 `read ECONNRESET` |
| 02 | 加了「只在没拿到应答时才重发」之后重跑 | `02-tab-count-unchanged-retry.txt` | 五家店 `—— 没变`；`体检退出码=0`；`EXIT=0` |
| 03 | 真机跑一次体检（五家店，人读格式） | `03-live-five-shops.txt` | `[判据] 5 家店、10 个平台都在登录态 —— 可以开跑。`，`EXIT=0` |
| 04 | 单店 + `--json`（结构完整性） | `04-one-shop-json.txt` | `verdict=ALL_IN`、`scriptVerdict=ALREADY_LOGGED_IN`、`childExitCode=0` |
| 05 | 体检之后实例是否还在位（只读对账） | `05-inventory-after-preflight.txt` | `[判据] 全部 7 个实例就位`，`EXIT=0` |

第 04 份里那两个 `href` 是这一层唯一能拿来做现场核对的事实，它们落在**链本来就期望**的
地址片段内：

```
"href": {
  "sycm":    "https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop",
  "alimama": "https://one.alimama.com/index.html"
}
```

（离线用例里有一条专门钉这个：探针地址必须落在 `date-picker` 那一步的 `urlFragment` 之内 ——
否则「体检过了」与「链真的能跑」就是两件事。）

## 三、「只读」是怎么被判的

这条能力的卖点是「**一个页面都不碰**」。而在这台机器上，「只读」不是一眼能看出来的 ——
体检唯一的动作是「把该站点那一页导航到探针地址、读最终 URL」，它**看起来**也像在动页面。

所以判据落在**页签账**上：跑之前与跑之后，每个窗口的页签条数必须**逐个相同**。
第 02 份逐字（`before` 与 `after` 同）：

```
=== 体检之后 ===
  里可林淘宝: 3 个页签（之前 3）—— 没变  ["https://sycm.taobao.com/.../performance/new#/shop","about:blank","https://one.alimama.com/index.html"]
  网林天猫:   3 个页签（之前 3）—— 没变  [...]
  盖文淘宝:   3 个页签（之前 3）—— 没变  [...]
  盖文天猫:   3 个页签（之前 3）—— 没变  [...]
  科塔淘宝:   3 个页签（之前 3）—— 没变  [...]

[判据] 每个窗口的页签条数都没变；体检退出码=0（0＝十项全在登录态）
```

要注意这条判据**只管条数**，不管 URL。会变的是 URL（导航到探针地址再读，这是设计如此）；
「URL 是不是链期望的那两个」由 `runtime/shop-pages.mjs` 单独判（期望页面恰好各一个）。

## 四、接进定时链（三步），以及「3 与 0 为什么要分开」

`runtime/daily-job-plan.mjs` 从两步变三步（`scripts/run-daily-job.mjs --print` 实打）：

```
ensure-instances   （幂等；起完就退；blocking=false）
login-preflight    （跑前登录态体检，只读；blocking=false）   ← 本批新增
* chain            （run-multi-shop-day.mjs；blocking=true）
```

- **`/TR` 只拉起一个入口**这条不变量仍然成立：`runtime/daily-job-plan.test.mjs` 的断言
  已扩成「三步里的任何一个文件都不许出现在 `/TR` 里」。
- 这一步**不投递任何告警**（内部用 `--notify off`）。同一次故障再发一条飞书，只会让那条通道
  更不可信；真正的告警仍由链失败时那一条负责。
- **`3` 与 `0` 必须分开**：定时链那一步拿退出码当「跑前那一眼」的记录。若「读不到」也回 `0`，
  日志里这一行就与「体检真的过了」长得一模一样 —— 那正是本仓库反复在治的那种静默。
- 反过来，`4`（参数错）也刻意与结论分开：免得把「店名打错字」读成「掉登录」。
  为此 `parseCheckShopsArgs` 对未知参数**当场抛错**并列出合法店名。

## 五、一次 ECONNRESET，以及为什么它是瞬断

第 01 份的失败长这样：

```
TypeError: fetch failed
    at async tabsOf (.../repro-tab-count-unchanged.mjs:22:20)
  [cause]: Error: read ECONNRESET  { errno: -4077, syscall: 'read' }
```

四条互相独立的证据把它定为**瞬断**而不是「某个代理死了」：

1. 它发生在 `before` 五家全部读完、**体检自己报 10/10 全绿之后**；
2. 紧接着 `runtime/browser-inventory.mjs` 报 **7/7 就位**（代理都在听）；
3. 报的是 `ECONNRESET` —— **一个 HTTP 应答都没拿到**；
4. 成因是 keep-alive：`before` 那 5 条连接挂在连接池里，体检跑了十几秒，
   代理那边先把空闲连接关掉，`after` 复用了那条已经死掉的 socket。

**处置**：`fetchTabs` 加**一次**重发，且**只在「没拿到任何 HTTP 应答」时才重发** ——
拿到 4xx/5xx 就说明对端活着且明确拒绝了，**不重发**（那是一种结论，不是一个瞬断）。
原始失败与重跑成功两份都留着。

## 六、离线用例（本批新增/改动的三条套件都实跑过）

| 套件 | 结果 | 考什么 |
|---|---|---|
| `skills/…/scripts/check-login-shops-core.test.mjs` | **16 pass / 0 fail** | 词表、判据、渲染；含两条**接线**判据：探针地址必须落在 `date-picker` 的 `urlFragment` 内；主脚本必须带 `--check-only`、必须用登记表 `proxyPort`、必须 `--notify off`、必须 `spawn(process.execPath, …)` |
| `runtime/daily-job-plan.test.mjs` | **11 pass / 0 fail** | 三步顺序 + `login-preflight` 的 `blocking=false` + `/TR` 里不许出现任何一个入口文件 |
| `runtime/arch-boundary.test.mjs` | **3 pass / 0 fail** | 两个 skills 文件跨目录读 `runtime/browser-ports.mjs` 已登记（各带理由） |

## 七、复核命令

```bash
# 1) 跑一次体检（只读：不开页面、不点任何东西）
node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs

# 2) 只体检指定几家店 / 要机器可读的输出
node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --shops 盖文淘宝,科塔淘宝
node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --json

# 3) 「没有多/少页签」这条账（只读；exit 1 = 有窗口变了）
node evidence/login-preflight-2026-09-23/repro-tab-count-unchanged.mjs

# 4) 看定时链现在是不是三步（只打印，不执行）
node scripts/run-daily-job.mjs --print

# 5) 三条件套件
node --test skills/sycm-alimama-daily-report/scripts/check-login-shops-core.test.mjs \
            runtime/daily-job-plan.test.mjs runtime/arch-boundary.test.mjs
```

## 八、本批次没做的事（别当成漏了）

- **没真机验过故障路径**。第 1 条结论里的「掉登录 / 读不到」这两类现场，本批只有**离线用例**
  与代码路径覆盖 —— 真机上五家店当时都是绿的，没有掉登录可以复现。
  （制造掉登录要动登录态，那超出本批授权。）
- **不是闸门**。这一步 `blocking:false`：它把结论写进日志，**不阻断**后面的链。
  「要不要把它变成闸门」是一个**独立决定**，本批没有做。
- **没覆盖商家浏览器**（dailyReport，19022/19023）。它用的是同一批账号、而它的两个页面
  （生意参谋 + 飞书底单页）与五家店的采集无关 —— 它掉了登录会在日报那一侧的失败里直接露出来。
  这一层刻意只覆盖「一店一实例」那五个。
- **体检层本身一个字没改**：`runtime/xws-platform-health-preflight.mjs` 仍是
  `port / pages / egress` 三层，`IDENTITY / SESSION / END_TO_END` **仍然没有检查过**。
  本批新增的是**另一条独立的**跑前那一眼，不是往那个文件里加层。
- **没把「关再续跑」切进任何自动化**：本批只造了它的前提能力。
