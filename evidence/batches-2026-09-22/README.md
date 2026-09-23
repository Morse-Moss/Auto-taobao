# 批次驱动的真机排练（2026-09-23）

本目录同时是两件事的证据：

1. **批次驱动（`scripts/run-batches.mjs`）第一次真机跑**的原始产物（`batches.log` / `batches.json` / `b1/`）；
2. 这一跑撞上的**真实故障**（六个实例的淘宝会话全失效）的取证，以及它连带引出的三条异常的对账（`probes/`）。

命令（排练模式：采集是真的，两个写入方干跑，**不写飞书**；跑成会释放）：

```bash
node scripts/run-batches.mjs --shops 里可林淘宝 --batch-size 1
```

本批目标日 = `yesterday` → `2026-09-22`（所以目录名带的是目标日，不是执行日）。

---

## 一、机制全部按设计工作（逐段退出码）

`batches.log` 里逐字（时间戳为 UTC）：

| 段 | 命令 | 退出码 | 证据 |
|---|---|---|---|
| `ensure-shared` | `start-all.mjs --only dailyReport` | 0 | 起前 `browser-missing`（代理在、浏览器没了）→ 起后 `ready` |
| `start` | `start-all.mjs --only 里可林淘宝` | 0 | 同上，起了 pid=63988 |
| `label:里可林淘宝` | `shop-window-label.mjs --commit --front --only 里可林淘宝` | 0 | **原地接管空白页** `adoptedBlank:true`、`pinned:true`、`fronted:true`、窗口标题「里可林淘宝 · 日报采集窗口」 |
| `chain` | `run-multi-shop-day.mjs --date yesterday --shops 里可林淘宝 --notify-print --logs evidence\batches-2026-09-22\b1` | **1** | 见 §三 |
| `stop` | — | **跳过** | 见 §二 |

三个细节值得单独记：

- **`--logs` 是按批分配的**（`b1/`），所以「后一批把前一批的明细盖掉」这件事从结构上不会发生。
- **`ensure-shared` 只起不停**：整轮只起一次商家浏览器（推送段与回读段都跑在它上面），
  批次里永远不含它 —— 这与 `runtime/batch-plan.mjs` 的 `SHARED_INSTANCE_KEYS` 一致。
- **打印的与执行的逐字相同**：`batches.log` 里那几行 `--- chain：…` 就是真正 spawn 的那条命令行。

## 二、这一跑走通的是**失败支路**（这是本次唯一完整走通的分支）

链退出码 1 之后，释放判决按用户第 5 条（失败优先解决问题）**不释放**，并如实落日志：

```
--- stop：跳过 —— 这一批没跑成（链退出码 1）—— 不主动释放（失败优先解决问题）；
    处理完后用 node scripts/stop-all.mjs --yes --only <本批店铺> 释放
    （留窗口的前提：本批的 start 是 scripts/start-all.mjs（起完就退）：宿主要在命令结束时
     回收整棵进程树，所以**这批窗口活不过本轮命令**，「不释放」只是「我不去停它」。…）
[批次] 这一批不主动释放：…
=== 分批跑结束：0/1 批成功；释放 0 批；… ===
```

**成功支路（链成功 → 真停 → 回读确认）没有在真机上整条走通**（原因见 §三，要人）。
它的两半各自有真机证据：链确实能跑出退出码（这次拿到 1），以及
`stop-all.mjs --yes` 的「5/5 已停 ＋ 停后盘点到 `missing`」见
`evidence/cold-start-rehearsal-2026-09-23/02-stop-five-shops-exec.txt`。

## 三、链为什么失败：**不是页面问题，是掉登录**（要人）

链在第 0 步（商家浏览器体检）就整轮不跑。原始输出在
`b1/00-health-check-daily.txt`，逐字是：

```
[归位] 生意参谋工作页：ambiguous-drift      ← 「不敢动」：它找到的页 URL 与期望不符
[阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里
       （按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）
```

「找到 0 个」容易被读成「页面没开」。真实原因在同一个文件的 `normalize.actions` 里写着：
它找到了 **2** 个页，但两个的 URL 都是

```
https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
```

—— 即**淘宝把目标地址弹回了登录页**，而归位正确地**不敢**把这种页当成工作页（fail-closed）。

把这个推断变成判据的，是 `probes/probe-merchant-navigate-once.txt`：**真的导航一次**，
16 秒内三次回读，页面稳定停在 `custom/login.htm?_target=<目标地址>`：

```
=== 导航到目标地址一次 ===
  再等 3000ms/5000ms/8000ms 后：{"href":"https://sycm.taobao.com/custom/login.htm?_target=…","title":"生意参谋","ready":"complete","bodyLen":301}
=== 判据 ===
  落在登录页？ 是 ⇒ **会话已失效**（淘宝把目标地址弹回了登录页）⇒ 需要人工登录一次
```

（`ready:complete` ＋ `title:生意参谋` ＋ 正文 301 字 = 那是一张**真的加载完成的登录页**，
不是空白、也不是网络故障。）

五家店用**只读**的跑前登录体检逐个问了一遍（`probes/check-login-shops-readonly.txt`，
`verdict: NEEDS_LOGIN`、`unknown: []`、`checked: 5`）：

| 店 | sycm | alimama |
|---|---|---|
| 里可林淘宝 | `LOGGED_OUT` | `UNREADABLE`（窗口里没这一页） |
| 网林天猫 | `LOGGED_OUT` | `LOGGED_OUT` |
| 盖文淘宝 | `LOGGED_OUT` | `UNREADABLE` |
| 盖文天猫 | `LOGGED_OUT` | `LOGGED_OUT` |
| 科塔淘宝 | `LOGGED_OUT` | `UNREADABLE` |

工具自己的措辞是「**被踢回登录页**」。加上商家浏览器那一份（上面已由真导航判据定案）——
**六个实例的淘宝会话全部失效**。

**飞书侧不用登**（`probes/probe-merchant-feishu-login.txt`）：底单页标题是
「各店铺日报 - 飞书云文档」，正文里读得到真实内容（店铺数据看板 / 底单 / 1月数据表）
与登录用户「奈何妨」，URL 也没被弹走。

⇒ 待办（要人）：**把这六个浏览器窗口里的人登录一次**（生意参谋 ＋ 阿里妈妈；淘宝的
`custom/login.htm` 上点一次「保存密码」，下次就不用了 —— 这正是 `NO_SAVED_CREDENTIAL`
那条告警文案里写的处置）。

## 四、三条异常的定因（先查清，不猜）

**① 整轮只花 9 秒**（`probes/rehearsal-timing.txt`）：不是计时异常，是链在第 0 步就停
（`ensure-shared` 2.5s ＋ `start` 2.5s ＋ `label` 0.5s ＋ `chain` 3.1s）。
「冷启动 ＋ 十一阶段」那个量级只在链真跑起来时才成立。

**② 同一轮里出现两个 `runtime/start-stop-logs/<时间戳>/` 目录**：不是重复起。
`03-14-35/` 里只有 `dailyReport-browser.log`（`ensure-shared` 那一步起的商家浏览器），
`03-14-37/` 里只有 `里可林淘宝-browser.log`（批次 `start` 那一步起的店浏览器）。
两步各起一个实例 ⇒ 各建一个目录。代理那两个文件不在这里，是因为两个代理**本来就在跑**
（`selectActions` 对已就位的角色一个进程都不起）。

**③ 浏览器全没了** —— 这是**两层不同的事**，必须分开说：

- **我这一轮起的窗口**：命令在 `11:14:43.70` 结束，`11:14:43.96` 里可林那个代理就记了
  「连接断开」（`probes/log-mtimes.txt`）—— 相差 **0.26 秒**。符合仓库已有的那条本机事实
  （见 `scripts/start-all-hold.mjs` 头部与 `evidence/browser-restart-2026-09-19/`）：
  **宿主要在命令结束时回收整棵进程树**，而 `start-all.mjs` 是「起完就退」。
  本次两条启动器日志里**没有任何 `msedge exited` 行**，正是「被连根拔掉」而不是「自己退出」的样子。
  ⇒ 已落成 `releaseAfterBatch` 的 `caveat`、写进 `docs/ops/CLIENT-MACHINE-CAPACITY.md` §4。
- **更早那七个长驻实例**：启动器与代理的出生时间是 `10:15:02–10:15:10`（五家店）与
  `10:18:36–10:18:38`（竞品 ＋ 商家浏览器）（`probes/proc-created.txt`），都由两个**现在仍然活着**的
  `start-all-hold.mjs` 托着；而它们的**浏览器在 `10:47:02–10:47:11` 这 9 秒内全部以
  `exited code=0` 退出**（`probes/launcher-logs-scanned.txt` 与 `probes/log-mtimes.txt`）。
  定性：① 那一刻**没有**任何 `start-all` / `stop-all` 目录（`stop-all` 也不建目录、且它会先断代理，
  而代理全都活着）；② 仓库里没有任何代码会这样关浏览器（全仓搜 `taskkill|Stop-Process|pkill|process.kill`
  只命中 `stop-all.mjs` 与三个探活处，`probes/kill-search-repo-wide.txt`）；
  ③ 当下的进程快照里**自动化实例的 msedge 一个都没有，而启动器与代理的 node 全在**
  （`probes/proc-now.txt`，已裁掉与本项目无关的行）。
  ⇒ 这是一次**来自本仓库之外**的事件，**具体是谁没有证据，不下结论**。
  一条可用的旁证：`11:14` 冷启动后恢复出来的页签地址就是登录页，说明淘宝会话在这之前就已经失效。

## 五、没做到的事（别当成漏了）

- **成功支路没整条走通**：需要六个实例重新登录（要人），见 §三。
- **`11:40` 那一次定时跑一定会失败**：链第 0 步就会被同一件事阻断。
  它在第 ② 步会把「哪家店哪个后台掉登录」写进日志，但**发出去的那条告警文案仍然是
  「页面不齐，把这两页各开一个」** —— 真因是掉登录时，开页面不会好。这是已知的交接瑕疵，
  已记进 `CHANGELOG.md` 的「已知未完成」，修法要动告警载荷的传递路径。
- **`--no-release` / `--keep-going` / `--notify`（真投递）这三条开关本次没跑过真机**
  （离线各有用例）。

## 六、复核命令

```bash
# 1) 只读对账：实例在不在（进程 / 端口 / profile 三处一致）
node runtime/browser-inventory.mjs

# 2) 只读登录体检：五家店 × 两个后台（不开页面、不点任何东西）
node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --json

# 3) 只读体检商家浏览器（页面齐不齐）
node runtime/xws-platform-health-preflight.mjs --browser=dailyReport --route=dailyReport

# 4) 本目录里的两个探针（需要商家浏览器在 19022/19023 上；只读/只导航一页）
node tmp/probe-merchant-navigate-once.mjs      # 会把 sycm 那页导航一次，判定会话存亡
node tmp/probe-merchant-pages-actual.mjs       # 纯读：每个页自报的 href/title/ready

# 5) 重跑本批（链仍会因为掉登录而失败，直到人登录）
node scripts/run-batches.mjs --shops 里可林淘宝 --batch-size 1

# 6) 突变验证：把 5 条判据各自改坏一次，确认真的会红、且红在点名的那一条上，再还原自证 sha256
node evidence/batches-2026-09-22/mutate-batch-2026-09-23.mjs
```

> 第 6 步的原始产物就在本目录：`mutation-report-2026-09-23.json`（结构化）与
> `mutation-report-2026-09-23.txt`（本次跑出来的 stdout）。
> 脚本是从 `tmp/` 收进来的（`tmp/` 被 gitignore，声明要有随目录提交的证据）——
> **收进来时改了它算仓库根的基准**：`tmp/` 那份写 `../`（它在仓库根下一层），
> 照抄进 `evidence/<批次>/` 会把仓库根解析成 `evidence/` 然后跑不动。
> 现在是 `../..`，并且**这份副本自己在证据目录里跑过一遍**（产物就是上面两个文件）。
> 另：一次改坏会临时动到 `runtime/daily-job-plan.mjs` / `runtime/batch-plan.mjs` /
> `package.json`，所以**别跟全量套件同时跑**（会造成一条与本改动无关的假红）。

> 探针脚本在 `probes/` 下有一份副本，路径都是相对仓库根写的（`tmp/…`），
> 所以要从**仓库根**运行；副本与其当时产出的 `.txt` 同名配对，便于复核。
>
> **启动器日志本身不在仓库里**：`runtime/**/*.log` 被 `.gitignore` 排除
> （`.gitignore:31`），所以 `runtime/start-stop-logs/<时间戳>/` 下的原始日志无法随本目录提交 ——
> 从它们里抽出来的关键行就是 `probes/launcher-logs-scanned.txt`，清单一律以那份为准。
>
> **一个失败的探针也留档**：`probes/probe-merchant-sycm-login.mjs` / `.txt` 是第一次尝试 ——
> 它用 `GET /new` 新建页再读 `location.href`，结果读回 `about:blank`（后台新页没真正加载完），
> 而**同一时刻 `GET /targets` 却报着目标 URL**。它没给出结论，但给出了两条教训：
> ① 判「实际在哪个地址」只能用页面自报的 `location.href`，不能用 `/targets` 的 `url` 字段；
> ② 只读一次不够、要看多次。所以后面才换成「导航已有页 ＋ 3/5/8 秒三次回读」。
