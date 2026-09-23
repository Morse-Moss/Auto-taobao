# 凭据收敛 + 真机复核（2026-09-23 晚 23:0x–23:5x）

用户原话（本轮指令）：

> 「商家浏览器这个，是哪个商家就留哪一个
> 授权给你，确保明天的定时自动化顺利」

第 1 条＝按「这台实际属于哪个商家」收敛商家浏览器的凭据；第 2 条＝授权我把明天 11:40 定时链的
前置条件做实。本文件是这两件事的收尾记录。

---

## 一、结论先行

1. **六台 profile 全部收敛到「本店账号、同 origin 恰好一条」**：删了 4 条凭据（两台各 2 条），
   删前整库备份，删后回读自证，商家浏览器又**起了一次浏览器让它同步**，**没有被云端拉回来**。
2. **商家浏览器已登录**（生意参谋真在报表页上），凭据填充填进来的是 **`盖文旗舰店:阿彦`**。
3. **盖文淘宝真机复核**：它**根本不需要登录** —— `--check-only` 判 `ALREADY_LOGGED_IN`
   （生意参谋 `loggedIn=true`、阿里妈妈 `loggedIn=true`）。我先前两次 `--commit` 是多余的。
4. **今晚一共发了 3 条飞书告警，全是假红**（详见第三节）——这一条比收敛本身更值得记。
5. **商家浏览器没有任何一步会自动登它** ⇒ 它一旦不在（或掉登录），明日整轮会在链的第 0 步停。
   这一个是**明天唯一的真风险**，处理办法见第五节。

---

## 二、动了什么（逐条）

判据：Chromium 的自动填充只比 **origin**（不比路径）；同 origin 有几条凭据决定了
「能不能填」与「会填成谁」。≥2 条时浏览器自己挑一条 ⇒ 可能**静默登成别家**。

| profile | 删掉的凭据（origin → 账号） | 删前/删后同 origin 条数 | 备份 |
| --- | --- | --- | --- |
| 商家浏览器 `edge-daily-report-profile` | `havanaone/login/login.htm` → **里可林家居:阿彦**（用过 0）<br>`havanalogin…/mini_login.htm` → **随心品质定制:阿彦**（用过 1） | 2 → **1** | `D:/Retire/edge-profile-backups/edge-daily-report-profile-2026-09-23T14-59-14` |
| 盖文淘宝 `suixin-custom` | `member/login.jhtml` → **盖文旗舰店:阿彦**（用过 0）<br>`havanalogin…/mini_login.htm` → **盖文旗舰店:阿彦**（用过 0） | 2 → **1** | `…/suixin-custom-2026-09-23T14-59-24` |

- 判「商家浏览器属于哪个商家」的依据不是印象：**文档口径＝`盖文旗舰店:阿彦`**
  （与盖文天猫同一账号，`MEMORY.md` 里 09-23 用户已拍板「按 A」）＋ **实测该条用过 10 次**
  （里可林那条用过 0 次＝历史残留）。收敛后它库里只剩 `盖文旗舰店:阿彦` 两条（一个 origin 各一条）。
- 工具＝`converge-credentials.mjs`（**默认干跑**、`--commit` 才写、逐条 fail-closed：命中 0 或 ≥2 就停、
  删前整库备份含 `-wal`/`-shm`、删主表同时删按 id 一一对应的 `sync_entities_metadata` / `logins_edge_extended`、
  删完回读自证）。删除目标写在 `specs-merchant-browser.json` / `specs-suixin-custom.json` 里
  **用文件而不是命令行传**——Windows 下命令行里的中文会过宿主控制台码页，参数可能在到达脚本前就坏了。
- 原始输出：`converge-*-dryrun.txt`（干跑）、`converge-*-commit.txt`（真删）。收敛后全量重扫＝
  `credential-audit-after-converge.txt`（六台**全部**同 origin＝1，且每台那一条都是本店账号）。

### 「同步会不会把删掉的拉回来」——实测答案：这次没有

`peek-sync-state.mjs` 加了一段更硬的判据：**密码库自己身上的 `sync_entities_metadata`**。
商家浏览器 `logins=47 / sync_entities_metadata=47` ＝ **每条都带同步元数据**（这个 profile 确实在同步），
盖文淘宝 `0`（本地库，不参与同步）。

**删完 → 起浏览器 → 跑一次真机登录 → 再读：`logins=45`、`sync_entities_metadata=45`，没有回来。**
复核输出＝`after-converge-recheck.txt`。

> ⚠️ 这只是「这一次没回来」，不等于「永远不会回来」：云端仍留着那份副本。
> 判据留在 `peek-sync-state.mjs` 里，下次审计直接跑它就能再验一遍。

---

## 三、今晚发出去的 3 条飞书告警**全是假红**（比收敛更值得记的一条）

| # | 触发 | 实际事实 | 为什么是假红 |
| --- | --- | --- | --- |
| 1 | 商家浏览器 `--commit` 登录后 `verdict=PARTIAL` | 生意参谋 **`loggedInAfter=true`**（`hrefAfter` 已是报表页） | 被判「没进去」的是**阿里妈妈** —— 而那只是「那个页签还没开」，不是掉登录 |
| 2 | 盖文淘宝 `--commit` 第 1 次 `verdict=MAIN_SESSION_ONLY` | 页面停在 `about:blank`（冷启动那一拍的旧读） | 判据把「读不到」当成了「掉了」 |
| 3 | 盖文淘宝 `--commit` 第 2 次 `verdict=MAIN_SESSION_ONLY` | 页面落到 `myseller.taobao.com` ⇒ **主站会话还在** | 「会话在、只是页面没开」被报成要人处理 |

紧接着的只读体检给了反证：`login-merchant.mjs --check-only --shop 盖文淘宝 --proxy …19043`
判 **`ALREADY_LOGGED_IN`**（两个后台都 `loggedIn=true`），`notify`＝`SKIPPED（verdict_needs_no_human）`
—— 同一个实例、同一分钟内，一个说「没进去、叫人」，另一个说「本来就在登录态、不叫人」。

⇒ 两条待修（都属于「假红比不报更坏」这一类，**本轮未改代码**）：
- **`PARTIAL` / `MAIN_SESSION_ONLY` 不该直接叫人。** 两种情形里都有一种是「页面还没开／还没归位」，
  而那正是链的第 0 步会自己修好的事。应当在叫人之前先区分「会话没了」与「页面不在」。
- **去重仍然是空的（已知欠账，这次拿到了新证据）**：第 2、3 条告警的 `alertId` **完全相同**
  （`sycm-login-盖文淘宝-sycm-alimama-20260923`），仍然两条都 `SENT` ⇒ 「同日同店不重复发」那句话
  在这条路径上依旧不成立。

---

## 四、真机复核：1.6.0 的候选表 + 身份守卫在真机上跑通了

对**真的掉了登录**的商家浏览器（`--check-only` 先判 `NEEDS_LOGIN`、生意参谋被踢回登录页）跑
`login-merchant.mjs --commit`（不给 `--shop`，默认代理就是它）：

```
"opened": true, href=…/havanaone/login/login.htm?bizName=taobao
"autofill": { "id": true, "password": true }        ← 候选表第一条就命中了
"afterGesture": { "idLen": 8, "passwordLen": 9 }    ← 可信手势之后值真的落地了（8 = 「盖文旗舰店:阿彦」）
"guard": { "verdict": "UNKNOWN", "expected": null, "filled": "盖文旗舰店:阿彦" }
"urlAfter": "https://myseller.taobao.com/home.htm/QnworkbenchHome/"
sites.sycm: loggedIn false → loggedInAfter true, hrefAfter = …/shop/performance/new#/shop
```

- **候选表第一条（`havanaone`）在真机上命中**，值在补手势后落地 —— 与一次性实例矩阵一致。
- **守卫判 `UNKNOWN` 而不是 `ACCEPT`**，原因是**没给 `--shop` ⇒ 没有期望值**（`guardBasis: no_expected_member`）。
  这是设计里的第三条出口（「这条守卫没有依据」），不是失败；但它也说明
  **对共享实例的登录，身份守卫目前是空转的** —— 之所以这次敢跑，是因为同 origin 只剩一条凭据
  （收敛之后「填错人」在物理上不可能）。
- 唯一的 `--shop` 与 `--proxy` 配对约束（`judgeShopTarget`）使得「给共享实例一个有期望值的守卫」
  现在做不到：给 `--shop 盖文天猫` 就会要求代理是 19045。这是第六节那条建议要解决的事。
- 原始输出：`merchant-auto-login-22xx.txt`、`merchant-checkonly-22xx.txt`。

---

## 五、明天（09-24 11:40）的前置条件清单

| 条件 | 现状 | 谁保证 |
| --- | --- | --- |
| 五家店各自的浏览器能登进去 | 六台凭据都已「本店账号、唯一一条」 | 链自己的 `login-preflight --login` 自动登 |
| 盖文天猫（唯一曾缺凭据的） | 用户 09-23 手工登过，库里现有 1 条同 origin 凭据 | 同上 |
| 盖文淘宝 | 实测 `ALREADY_LOGGED_IN`；且冷启动后主站会话仍在 | 同上 |
| **商家浏览器在位且有登录态** | **已登录、正在跑（19022/19023）；飞书底单页与生意参谋工作页各 1 个** | **没有任何自动步骤** ← 唯一缺口 |
| 页面齐 | 商家浏览器 `生意参谋工作页=1 飞书底单页=1`；其余四家没起、由链的第 0 步「归位」补 | 链的 `normalizePages` |

**商家浏览器为什么是缺口**：`check-login-shops.mjs` 刻意只覆盖五家店（`--shop` 与 `--proxy` 必须配对），
批次计划里 `SHARED_INSTANCE_KEYS` 只有「起」没有「登」。它一旦不在，链的第 0 步
（`run-multi-shop-day.mjs:1046`，与 `--keep-going` 无关）就会以 `TARGET_PAGE_MISSING` 停掉整轮。

**今晚的处理**：把它起着、登着（19022 `occupied(profile 一致)`、19023 代理在）。
⚠️ **它挂在本会话的后台托住进程上** —— 关掉 WorkBuddy、或重启机器，它就没了。
最稳的三条路（见第六节）。

---

## 六、顺带发现的第二个缺陷：`stop-all` 会把「读不到」当成「没在跑」

真机上 `node scripts/stop-all.mjs --only 盖文淘宝` 两次输出：

```
[警告] 读进程表失败（spawnSync C:\WINDOWS\system32\cmd.exe EBUSY）⇒ 找不到父子关系，只能直接停浏览器主进程
· 盖文淘宝
    没有在跑，无需处理
```

而同一时刻 `runtime/browser-inventory.mjs` 明确读得到 `19033=occupied(profile 一致)`、`19043=在`。
⇒ **进程表读不出来时它宣称「没有在跑」**，此时就算加 `--yes` 也什么都不做、还报告成功。
这与本项目一直在治的「读不到 ≠ 不存在」是同一类错，而且是**释放路径**上的：
按批次释放时若碰上这个，会静默漏掉一个实例（而日志看起来完全正常）。

本轮绕开的办法（记下来）：`Get-NetTCPConnection -LocalPort <端口>` 拿 PID →
`Get-CimInstance Win32_Process` 核对命令行里确实有该 profile → `Stop-Process` → **端口回读**；
只停今晚为复核起的那一个（PID 24292，命令行 `--user-data-dir=D:/Retire/edge-profiles/suixin-custom`），
没有碰商家浏览器。

---

## 七、产物与复核命令

| 文件 | 是什么 | 怎么复核 |
| --- | --- | --- |
| `converge-credentials.mjs` | 收敛工具（默认干跑；备份＋fail-closed＋回读自证） | `node … --profile <p> --specs-file <json>`（不带 `--commit` 即为干跑） |
| `converge-merchant-browser-{dryrun,commit}.txt` | 商家浏览器 干跑/真删 两份原始输出 | — |
| `converge-suixin-custom-{dryrun,commit}.txt` | 盖文淘宝 同上 | — |
| `specs-merchant-browser.json` / `specs-suixin-custom.json` | **删了哪几条**（可逐条核对） | — |
| `credential-audit-after-converge.txt` | 收敛后六台全量重扫 | `node …/audit-all-profiles.mjs <输出文件>` |
| `after-converge-recheck.txt` | 起过浏览器之后的同步复核（45/45，没回来） | `node …/peek-sync-state.mjs <profile> --out <文件>` |
| `merchant-checkonly-22xx.txt` / `merchant-auto-login-22xx.txt` | 商家浏览器：体检（要登）→ 真登（成功） | `node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --check-only [--commit]` |
| `suixin-auto-login-22xx.txt` / `suixin-auto-login-retry-22xx.txt` / `suixin-checkonly-after-open.txt` | 盖文淘宝：两次多余的 `--commit` ＋ 反证它本来就在登录态 | `… --check-only --shop 盖文淘宝 --proxy http://127.0.0.1:19043` |
| `shop-pages-readonly-22xx.txt` / `shop-pages-open-22xx.txt` | 补页前后（商家浏览器 飞书底单页 0→1；盖文淘宝 两页 0→1） | `node runtime/shop-pages.mjs [--open]` |

**纪律自查**：只读/写都落在自己起的那两个实例上；改密码库前先备份、改完回读；
收尾只留商家浏览器一个在跑（用户要求「跑完释放」）；`盖文淘宝` 用 `Stop-Process` 释放并用**端口回读**确认
（`19033`/`19043` 已 free），**没有碰任何别的进程**。
