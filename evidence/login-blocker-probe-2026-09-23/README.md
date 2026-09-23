# 2026-09-23 · 「自动登录到底做不到吗」——三家店三种成因

用户原话（本轮唯一指令）：

> 「做不到自动登录吗？？？」

这一份就是那句话的答案。**结论：做得到，而且它一直在做；本轮实测里卡住的都不是「自动化」这一侧，
而是三件各自不同的具体事**（一条凭据的网址废弃了、一台机器上有两条互相打架的凭据、
一个页签停在旧地址被误当成掉登录）。

上一轮（同日早前）已经落地并提交了「真去登、登不进才发飞书」这条口径（`3bc208a`，1.5.0）。
本轮**没有改任何产品代码** —— 全部是只读取证 + 一次真机自动登录尝试。

---

## 一、实测：五家店 + 商家浏览器，逐台说清

### 1) 网林天猫（19032 / 19042）——**根本不用登**，之前是我读错了

`check-login-shops.mjs --login` 的逐店回执（`auto-login-attempt.json`）：

```
"shop": "网林天猫", "verdict": "OK",
"scriptVerdict": "ALREADY_LOGGED_IN",
"href": { "sycm": "https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop",
          "alimama": "https://one.alimama.com/index.html" }
```

它之前那个页签停在 `sycm.taobao.com/custom/login.htm`，被当成了「掉登录」。
**那是「页签被留在旧地址」，不是会话过期** —— 探针一导航，它就落回真正的报表页。
两种形态在只读观测（URL／标题／ready／正文长度）下**完全同形**，唯一的区分办法就是导航一次。

⇒ 这一家不需要人去动。我在上一轮汇报里把它列进「要你手工登」是**假红**，这里更正。

### 2) 盖文天猫（19035 / 19045）——真掉登录，且**自动登录注定填不上**（凭据网址已废弃）

```
"shop": "盖文天猫", "verdict": "NEEDS_LOGIN",
"sites": { "sycm": "LOGGED_OUT", "alimama": "LOGGED_OUT" },
"scriptVerdict": "NO_SAVED_CREDENTIAL",
"notify": { "status": "SENT", "alertId": "sycm-login-盖文天猫-sycm-alimama-20260923" }
```

`NO_SAVED_CREDENTIAL` ＝ 脚本**真的打开了登录页、真的补了可信手势，但值没落地**。
不是"点了没反应"，也不是"提交失败" —— 是**浏览器压根不允许填**。

根因（`creds-gaiwen-tmall.txt`，只读密码库）：

```
脚本打开的登录页 origin = https://login.taobao.com
  origin=https://havanalogin.taobao.com/mini_login.htm
      账号="盖文旗舰店:阿彦"  用过=1  ❌ origin 不同（填不上）
  ⇒ 同 origin 的凭据 0 条
```

Chromium 的自动填充判据是「保存凭据的 `origin_url` 的 origin == 当前页 origin」。
这台机器**只有一条**凭据，而它挂在 `havanalogin.taobao.com` 上，与脚本打开的那一页是**两台主机**。
⇒ 再跑一百次也是 `NO_SAVED_CREDENTIAL`。**这是缺一条能用的凭据，不是自动化做不做得到的问题。**

> 顺带证伪一条嫌疑（同一轮的另一份证据）：`#fm-agreement-checkbox` **点得中**
> （`evidence/login-agreement-probe-2026-09-23/`：`elementFromPoint(539,576)` 就是它，
> `/clickPoint` 一点 `false→true`）。所以「协议勾不上导致提交被拒」这条**不成立**，
> 以后不必再往这个方向查。

### 3) 商家浏览器（19022 / 19023）——掉登录，但**故意没有自动登**

只读体检（`merchant-browser-checkonly.txt`）：

```
sycm: loggedIn=false  https://sycm.taobao.com/custom/login.htm?_target=...
alimama: loggedIn=null  expected one 阿里妈妈 page, got 0
```

窗口里此刻只有 2 个页签：生意参谋（停在登录页）+ 飞书底单页；**没有**阿里妈妈页签
（`merchant-browser-tabs.txt`）。**也没有登录页** ⇒ 当时没人在那个窗口里手输，脚本不会踩到人的输入。

那为什么不动手？因为**这台机器上有两条同 origin 的凭据，而它们属于两家不同的店**
（`creds-merchant-browser.txt`）：

```
脚本打开的登录页 origin = https://login.taobao.com
  origin=https://login.taobao.com/member/login.jhtml        账号="盖文旗舰店:阿彦"  用过=10  ✅ 会被填
  origin=https://login.taobao.com/havanaone/login/login.htm 账号="里可林家居:阿彦"  用过=0   ✅ 会被填
  origin=https://havanalogin.taobao.com/mini_login.htm      账号="盖文旗舰店:阿彦"  用过=11  ❌ 填不上
  origin=https://havanalogin.taobao.com/mini_login.htm      账号="随心品质定制:阿彦" 用过=1  ❌ 填不上
  ⇒ 同 origin 的凭据 2 条 ⇒ 浏览器自己挑一条，**有可能登成别人**
```

**这是这一轮最贵的一条发现。** 自动登录一旦在这台上跑到"填值"那一步，浏览器可能填
**里可林家居:阿彦** —— 于是商家浏览器被**悄悄登成另一家店**：页面照开、导出照成、
数字看起来都对，而每一个数字都属于那家店，**链上没有任何一步会发现**。
「登录失败」是响亮的安全失败；「登成了别人」是静默的、更贵的那种。

所以这一台我**没有**自动登。要让它能安全自动登，得先让「一个浏览器 = 一个淘宝身份」成立
（见下面第四节）。

### 4) 盖文淘宝（19033 / 19043）——同一个隐患，只是还没暴露

```
  origin=https://login.taobao.com/member/login.jhtml        账号="盖文旗舰店:阿彦"  用过=0  ✅
  origin=https://login.taobao.com/member/login.jhtml        账号="随心品质定制:阿彦" 用过=1  ✅
  ⇒ 同 origin 的凭据 2 条
```

它现在在登录态，所以没事。**一旦掉了，同样有概率被登成盖文天猫那家。**

---

## 二、关键旁证：`mini_login.htm` 不是死页，是**缺参数**才死

上一轮的说法是「`havanalogin.taobao.com/mini_login.htm` 是死页」。这句话**只对了一半**，
本轮用并排对照把它改准（`mini-login-toplevel.txt`，一次性实例 19937/19947，跑完已释放）：

| 打开的地址 | 账号框 | 密码框 | 登录按钮 | 正文 |
|---|---|---|---|---|
| 带参数（平台自己给的 iframe src） | visible | visible | visible | 「忘记登录密码？ 登录 免费注册」 |
| 裸 URL（同名同路径、无参数） | 无 | 无 | 无 | 「非法请求 [appNameError]」 |

带参数那一条是**从盖文天猫窗口里那个真的登录页上只读读出来的**
（`gaiwen-tmall-login-frame.json`：生意参谋登录页内嵌的 iframe `src`）。

⇒ **这条 origin 上没有"死"，它上面有一个可用的顶层登录页** ——
而这正是盖文天猫那条凭据所属的 origin。这给出一条**不用人工**的修法（见第四节 ①）。

---

## 三、本轮顺带发现的两个缺陷（都不是本轮改出来的）

1. **`DEDUPED` 在这条路径上是句空话。** `check-login-shops-core.mjs` 的措辞表写着
   「同一天、同一家店已经叫过一次了，本次不重复发（去重按告警编号）」，
   但 `login-merchant.mjs` 直接调 `runtime/notify-feishu.mjs`，**那条 CLI 里没有去重**
   （全仓 `DEDUPED` 的生产者只有 `runtime/xws-sku-auth-preflight.mjs` 与
   `runtime/sop-runtime/round-runner.mjs`）。实测：同一分钟内连跑两次，
   两次收据都是 `SENT`（`auto-login-console.txt` 与上一版逐字相同）。
   ⇒ 要么补去重，要么把那句话改掉 —— **不能留一句"说得像有、其实没有"的注释**。
2. **驱动脚本自己印错过一行。** `run-auto-login.mjs` 第一版读 `row.receipt.login.opened`
   —— 那个字段不存在（父脚本的行由 `judgeShopReceipt` 拍平，子进程回执不嵌套在里面），
   于是每家都印成「(未走到那一步)」，而盖文天猫**真的走到过登录页**。
   已修（只印确实存在的字段），并重跑复核。

---

## 四、怎么修（三条，按「值不值得做」排序）

① **盖文天猫：让脚本对这台改用凭据所属 origin 上那条带参数的登录地址。**
   平台自己给了地址（§二），实测顶层可用 ⇒ 浏览器会填上那条已有的
   `盖文旗舰店:阿彦` ⇒ **零人工**。
   代价：改的是登录入口 URL（最敏感的一条路径），得加判据 + 真机复核 + 一个版本。
   注意**不能简单地把全局 URL 换掉**：网林天猫只有 `havanaone` 那条、盖文淘宝只有
   `member/login.jhtml` 那条，换了会把它们弄坏。
   正确形态是「一团候选地址，逐条试到 `:autofill === true` 为止」。

② **商家浏览器 / 盖文淘宝：把不属于自己的淘宝凭据删掉，让「一个浏览器 = 一个身份」成立。**
   删完这两台的密码库里就只剩本店那一条同 origin 凭据 ⇒ 自动登录既填得上、也不会登错人。
   动的是浏览器数据，**需要明确授权**。
   ⇒ **逐条清单已出**：`CREDENTIAL-CONVERGENCE-LIST.md`（2026-09-23 晚补，六台 profile 全量审计；
   必删 2 条、可选删 3 条；并记下「商家浏览器开着微软账号同步 ⇒ 直接改库会被拉回来」这条坑）。
   另：**盖文天猫的人工兜底已经做掉了** —— 用户 2026-09-23 晚手工登过一次，
   `gaiwen-flagship` 现在有 1 条同 origin 凭据（`member/login.jhtml` → 盖文旗舰店:阿彦，用过 3），
   所以 §1.2 里「同 origin 0 条」那条已经过期（见 `credential-audit-all-profiles.txt`）。

③ **盖文天猫的人工兜底（若不做 ①）：在脚本已经打开的那一页上登一次并点「保存密码」。**
   那一页此刻**就开在那个窗口里**（19045 的第 2 个页签：
   `https://login.taobao.com/havanaone/login/login.htm?bizName=taobao`）—— 一次性动作，
   做完之后这台以后也能自动登。

---

## 五、产物清单（都能独立复核）

| 文件 | 是什么 | 怎么复核 |
|---|---|---|
| `run-auto-login.mjs` | 真机自动登录尝试的驱动（只对两家天猫店） | `node evidence/login-blocker-probe-2026-09-23/run-auto-login.mjs` |
| `auto-login-attempt.txt` / `.json` | 那一轮的原始 stdout 与结构化回执 | — |
| `auto-login-console.txt` | 同一轮的人话摘要 | — |
| `merchant-browser-checkonly.txt` | 商家浏览器只读体检（`--check-only --notify off`） | `node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --check-only --notify off --proxy http://127.0.0.1:19023` |
| `peek-merchant-tabs.mjs` / `merchant-browser-tabs.json` | 只读：那台窗口开着哪些页签、有没有人在手输 | `node evidence/login-blocker-probe-2026-09-23/peek-merchant-tabs.mjs` |
| `peek-taobao-credentials.mjs` | 只读（**不读密码**）：某个 profile 的淘宝凭据分别是哪家店的账号 | `node …/peek-taobao-credentials.mjs D:/Retire/edge-profiles/gaiwen-flagship` |
| `audit-all-profiles.mjs` | 只读：**六台 profile 一次全扫**，并把「同 origin 几条」直接算成人话（2026-09-23 晚补） | `node …/audit-all-profiles.mjs <输出文件>` |
| `credential-audit-all-profiles.txt` | 上面那次全扫的原始报告 | — |
| `peek-sync-state.mjs` / `sync-state-profiles.txt` | 只读：profile 有没有开微软账号同步（决定「删掉的会不会被拉回来」） | `node …/peek-sync-state.mjs <profile…> --out <文件>` |
| `CREDENTIAL-CONVERGENCE-LIST.md` | **决策件**：该删哪几条、该留哪条、为什么（只列不删） | — |
| `creds-*.txt` | 四台机器各自的凭据审计输出 | 同上 |
| `peek-gaiwen-tmall-login-frame.mjs` / `gaiwen-tmall-login-frame.json` | 只读：盖文天猫窗口里登录页内嵌的 iframe `src`（平台自己给的地址） | `node …/peek-gaiwen-tmall-login-frame.mjs` |
| `probe-mini-login-toplevel.mjs` / `mini-login-toplevel.txt` / `shots/` | 一次性实例（19937/19947）并排对照：带参数 vs 裸 URL | `node …/probe-mini-login-toplevel.mjs`（约 1 分钟，自带释放与端口回读） |
| `raw-mini-login-http.txt` / `raw-loginpage-probe.txt` | 两个登录页的原始 HTTP 响应（上一轮留下，本轮移进这里） | — |
| `probe-login-page-text.mjs` / `login-page-text.json` | 只读：两个天猫窗口的页签账（跑前跑后逐窗口相同＝没动过页面） | `node …/probe-login-page-text.mjs` |
| `_git-state.txt` | 动手前的仓库状态（`3bc208a`，ahead 4） | — |

**纪律自查：** 本轮所有探针要么是纯只读（`/targets` + `/eval`），要么跑在**未登记端口 + 临时 profile**
的一次性实例上；一次性实例跑完都 `taskkill /T` ＋端口回读（两次都是 `浏览器=null 代理=null`）
＋ 临时 profile 删除（`true`）。**没有起停任何存活服务。**
凭据审计**只读 `username_value`，不读也绝不打印 `password_value`**。
