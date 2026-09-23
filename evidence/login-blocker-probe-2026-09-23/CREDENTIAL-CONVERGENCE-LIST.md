# 需要收敛的淘宝凭据清单（2026-09-23 晚 · **只列不删**）

用户原话（本轮唯一指令）：

> 「1.已登录
> 2.你列出来」

第 1 条＝盖文天猫已人工登过一次（`gaiwen-flagship` 的密码库现在确实多了一条可用凭据，见下）。
第 2 条就是本文件：**把「哪几条淘宝凭据不该待在这个 profile 里」逐条列出来**，等一句话再动手。

原始输出（可独立复核）：

- `credential-audit-all-profiles.txt` —— 六台 profile 全量审计（`audit-all-profiles.mjs`）
- `sync-state-profiles.txt` —— 四台的同步状态（`peek-sync-state.mjs`）

**一句话结论：六台里四台干净，两台有隐患；必删只有 2 条，另有 3 条是「填不上、只制造混淆」的死重。**

---

## 一、判据（为什么「几条」这件事是致命的）

Chromium 的密码自动填充只有一个判据：**保存凭据的 `origin_url` 的 origin == 当前登录页的 origin**
（**只比 origin，不比路径**）。于是同一个 origin 下有几条凭据，直接决定两件事：

- **0 条** ⇒ 一定填不上（脚本判 `NO_SAVED_CREDENTIAL`）
- **1 条** ⇒ 能填，且**填的一定是它**
- **≥2 条** ⇒ **浏览器自己挑一条，脚本控制不了** ⇒ 可能**悄悄登成另一家店**

第三种是唯一「静默」的那种：页面照开、导出照成、数字看起来都对，而每个数字都属于另一家店，
**链上没有任何一步会发现**。它比「登录失败」贵得多 —— 后者是响亮的失败，前者是安静的错数据。

本仓已经为它加了一道闸（1.6.0 的 `WRONG_ACCOUNT` 身份守卫：填进来的账号不是这家店的 ⇒ 绝不提交），
但**守卫只会拒付，不会把凭据变成一条** ⇒ 要让自动登录真的能用，还是得收敛。

---

## 二、六台 profile 的实测全貌

同 origin ＝ `https://login.taobao.com`（两条候选地址都在这个 origin 下）。

| profile | 本店 | 淘宝凭据 | **同 origin 条数** | 判定 |
|---|---|---|---|---|
| 里可林淘宝 `likelin-home` | 里可林家居 | 2 | **1** | ✅ 干净（两条都是本店） |
| 网林（天猫）`wanglin-flagship` | 网林 | 1 | **1** | ✅ 干净 |
| 盖文天猫 `gaiwen-flagship` | 盖文旗舰店 | 2 | **1** | ✅ 干净（**人工登过之后已补齐**） |
| 科塔淘宝 `shop-j873522735` | j873522735 | 2 | **1** | ✅ 干净 |
| **商家浏览器** `edge-daily-report-profile` | （日报共用） | 4 | **2** | ⚠️ **有隐患** |
| **盖文淘宝** `suixin-custom` | 随心品质定制 | 4 | **2** | ⚠️ **有隐患** |

逐条（原文见 `credential-audit-all-profiles.txt`）：

```
商家浏览器 D:/Retire/edge-daily-report-profile        （本库 47 条，其中淘宝 4 条）
  login.taobao.com/member/login.jhtml        【外来】盖文旗舰店:阿彦    用过=10   ✅ 会被填
  login.taobao.com/havanaone/login/login.htm 【外来】里可林家居:阿彦    用过=0    ✅ 会被填
  havanalogin.taobao.com/mini_login.htm      【外来】盖文旗舰店:阿彦    用过=11   ❌ 填不上
  havanalogin.taobao.com/mini_login.htm      【外来】随心品质定制:阿彦  用过=1    ❌ 填不上
  ⇒ 同 origin 2 条 ⇒ 可能登成别家

盖文淘宝 D:/Retire/edge-profiles/suixin-custom        （本库 4 条，全是淘宝）
  login.taobao.com/member/login.jhtml        【外来】盖文旗舰店:阿彦    用过=0    ✅ 会被填
  login.taobao.com/member/login.jhtml        【本店】随心品质定制:阿彦  用过=1    ✅ 会被填
  havanalogin.taobao.com/mini_login.htm      【外来】盖文旗舰店:阿彦    用过=0    ❌ 填不上
  havanalogin.taobao.com/mini_login.htm      【本店】随心品质定制:阿彦  用过=4    ❌ 填不上
  ⇒ 同 origin 2 条 ⇒ 可能登成盖文天猫那家
```

---

## 三、必删（2 条，**不删就不能给这两台自动登录**）

| # | profile | 删哪条（origin + 账号） | 删完变成 |
|---|---|---|---|
| 1 | **商家浏览器** | `login.taobao.com/havanaone/login/login.htm` → **里可林家居:阿彦** | 同源剩 1 条（盖文旗舰店:阿彦）⇒ 能填、且一定填对 |
| 2 | **盖文淘宝** | `login.taobao.com/member/login.jhtml` → **盖文旗舰店:阿彦** | 同源剩 1 条（随心品质定制:阿彦，本店）⇒ 能填、且一定填对 |

## 四、可选删（3 条，删不删都不影响功能）

这 3 条挂在 `havanalogin.taobao.com` 上。**那个主机实测 0/5 次填充**（见 `login-candidate-loop-2026-09-23/`），
两条候选地址也都不在它上面 ⇒ 它们**永远填不上**，留着只会让人下次审计时再数错一次。

| # | profile | origin + 账号 |
|---|---|---|
| 3 | 商家浏览器 | `havanalogin…/mini_login.htm` → 盖文旗舰店:阿彦（用过 11） |
| 4 | 商家浏览器 | `havanalogin…/mini_login.htm` → 随心品质定制:阿彦（用过 1） |
| 5 | **盖文淘宝** | `havanalogin…/mini_login.htm` → 盖文旗舰店:阿彦 —— 这条**同时是外来凭据**，建议跟第 2 条一起删 |
| 6 | 科塔淘宝 | `havanalogin…/mini_login.htm` → j873522735:阿彦（本店，用过 2，死重） |

---

## 五、动手之前必须先知道的一件事：**同步会把删掉的拉回来**

`sync-state-profiles.txt`：

```
商家浏览器  edge-daily-report-profile   已登录同步账号 1074083863@qq.com   有 Sync Data（11 个文件）  ⚠️
盖文淘宝    suixin-custom               未登录微软账号  sync.requested=false  有 Sync Data（7 个文件）
盖文天猫    gaiwen-flagship             已登录同步账号 1074083863@qq.com   有 Sync Data（6 个文件）   ⚠️
里可林      likelin-home                未登录微软账号  sync.requested=false  有 Sync Data（7 个文件）
```

- **商家浏览器**开着微软账号同步 ⇒ 直接改 `Login Data` 库，条目可能被云端**再拉回来**：删完回读是 0 条，
  下次启动又变 2 条，**而且没有任何一步会报错**。
- **盖文淘宝**没登录微软账号、`sync.requested=false` ⇒ 改库是稳的。

于是有两条路，建议**按 profile 分开走**（不追求一种方法通吃）：

- **商家浏览器 → 用 Edge 自带的密码管理页删**（`edge://settings/passwords`，手点两下）。
  浏览器自己会把「删除」这个动作**同步上去**，不用停浏览器、不用碰生产文件、也不用担心运行中的窗口把库覆盖回去。
  代价：要人点两下（这是唯一需要人的一步）。
- **盖文淘宝 → 我可以直接改库**（那台现在没在跑）。规矩照旧：整库备份（含 `-wal` / `-shm`）
  → 删 → **回读自证**（同 origin 条数必须从 2 变 1）→ 写下恢复办法。

---

## 六、待授权（两条，等你一句话）

1. **商家浏览器该留哪一家的账号？** 我推荐**留「盖文旗舰店:阿彦」**（它在那台机器上用过 10 次，是当前在用的身份），
   删掉「里可林家居:阿彦」（用过 0 次，是历史上五家共用这台机器时的残留）。
   如果你确认商家浏览器不该是盖文旗舰店，那就得**两条都删**、然后人工登一次。
2. **盖文淘宝那台，授权我改库吗？**（那台没同步、没在跑，风险最低；改前整库备份、改后回读自证。）

以上两条之前，**我不动任何一条凭据**。
