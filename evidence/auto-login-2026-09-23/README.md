# 自动登录接线（2026-09-23）—— 取证与证据

对应版本 `1.2.0`。用户原话：「**2.可以自动登录把项目规则改了**」＋
「**为什么会掉cookie？**我这些店铺全部都手动登录过……为什么不能自动登录」。

本目录回答两件事，并给出一条改动的全部验证。

---

## 一、为什么掉 cookie（**不是推测，是读出来的**）

`cookies-cdp.mjs` → `cookies-cdp-out.txt`（**只读**：CDP `Storage.getCookies`，
不新建页签、不导航、不点任何东西）。

六个浏览器**无一例外**：淘宝/阿里妈妈的关键登录键都是**会话级 cookie**——

| 键 | 域 | session | expires |
| --- | --- | --- | --- |
| `cookie2` | `.taobao.com` | **true** | 1969-12-31（＝无到期时间） |
| `_tb_token_` | `.taobao.com` / `one.alimama.com` | **true** | 1969-12-31 |
| `sn` / `lgc` / `cookie2` / `_tb_token_` / `sgcookie` / `t` | `.alimama.com` | **true** | 1969-12-31 |

持久的那些（`cna` 2027-10、`sgcookie` 2027-09、部分店的 `t` 2026-12）**是访问标记，不是登录态**。

⇒ **会话级 cookie 随浏览器进程一起消失。** 所以「掉登录」是**每次重启都会发生的常态**，
不是偶发事故；也和「密码有没有保存」**毫无关系**。

### 为什么用户看到的「账号密码都还在」和这条不矛盾

`Login Data`（密码库）是**磁盘上的文件**，`Cookies` 是**运行期的会话**，两者独立。
用户看浏览器还能自动填账号密码 ⇒ 说明 `Login Data` 在（这正确），
但**登录态（cookie）已经丢了**。这是两件事，不是矛盾。

### 一条被证伪的老办法

`ck-probe.py` 原本想直接读 profile 的 `Cookies` 库，**失败**：
`PermissionError: [Errno 13]`（文件被运行中的 Edge 独占锁）。改成走 CDP 之后
既绕开锁、又是只读。`ck-probe-out.txt` 保留了这次失败——
它记的是「不要再去读那个文件」这条结论。

## 二、为什么「不能自动登录」

**能力早就造好了，但从来没有接进任何自动化路径。**
`login-merchant.mjs --commit`（借浏览器自己的密码库 + 一次可信手势）实测四家全自动登成、零验证码，
可是全仓 grep 只有 SOP 与人工命令在调它；日报链的 11 步里**没有这一步**，默认值也是关的。

⇒ 所以「今天早上那一轮定时自动化不需要人工参与」的真相是：**那几轮的会话恰好还在**，
不是「不需要登录」。一旦重启浏览器，就该掉、就掉了。

**本目录对应的改动就是把这条接上**（默认值 + 两个宿主 + 规则文档）。

---

## 三、验证（四类，分开说，别混成一句）

### 1. 离线判据 —— 逐个报分母，不给合计数

| 文件 | 结果 | 原始输出 |
| --- | --- | --- |
| `check-login-shops-core.test.mjs` | **21 / 21 / 0** | `t-check-login-shops-core.test.mjs.txt` |
| `runtime/daily-job-plan.test.mjs` | **24 / 24 / 0** | `t-daily-job-plan.test.mjs.txt` |
| `runtime/batch-plan.test.mjs` | **17 / 17 / 0** | `t-batch-plan.test.mjs.txt` |
| `runtime/version-consistency.test.mjs` | **6 / 6 / 0** | `t-version-consistency.test.mjs.txt` |
| `run-multi-shop-day.test.mjs`（受牵连，一并跑） | **55 / 55 / 0** | `t-run-multi-shop-day.test.mjs.txt` |
| `runtime/arch-boundary.test.mjs`（受牵连，一并跑） | **3 / 3 / 0** | `t-arch-boundary.test.mjs.txt` |

合计 **126 / 126 / 0**，六个文件各自 `exit 0`。

### 2. 真跑宿主 `--print`（不是源码扫描）

「函数全绿、没人调」是本仓库吃过三次亏的形态，所以接线必须**真跑一遍入口**：

- `host-run-daily-job-print.txt` —— 默认那一档，打出来的是
  `check-login-shops.mjs --login --json`（**默认会自己登**）。
- `host-run-daily-job-print-no-auto-login.txt` —— 加 `--no-auto-login` 后
  变成 `check-login-shops.mjs --json`（**退回只读，`--json` 不能跟着一起丢**）。
- `host-run-batches-print.txt` —— 分批驱动，`login-preflight` 那一步带着
  `--login --shops 里可林淘宝,网林天猫,盖文淘宝,盖文天猫,科塔淘宝 --json`。

三份**都不起任何进程**（`--print`），产物里各自带着 `# exit=` 行。

### 3. 突变验证 —— 10 处，全部红在点名的那一条上

脚本 `run-mutations.mjs`，产物 `mutation-report.json` / `mutation-report.txt`。
**10 / 10**：施加突变 → 点名的那条用例红 → 还原 → sha256 逐字节一致。

覆盖的是这批改动里**错了也不会抛错**的地方：
权威字段退回 `loggedIn`（把成功报成掉登录）／`autoLogin` 的两个措辞约束被拿掉（只读说假话）／
入口开关 `--login` 消失／两种模式不再分叉（自动登录变成空转）／静默期消失／
带 `--login` 走并行（风控加速器）／计划层不带 `--login`／`--no-auto-login` 失效／
分批那一档口径分叉。

### 4. 真机 —— **没有**

**带 `--login` 的定时链与分批链没有真机记录。** 取证当天
（`inv-now.txt` / `tabs-now-1229.txt`）六个实例的淘宝会话全部失效，
「掉登录 ⇒ 自己登回来」这条成功支路要等人先登一次、或等下一轮自然重启后才有机会走通。

⇒ 本版读作「**接线完成、仅离线判据 ＋ 真机现场快照**」，不读作「真机验过」。

---

## 四、仍然是欠账的（别当成已做）

1. **「同一账号连续 2 次失败当天不再试」的熔断没实现**（`MULTI-SHOP-AND-INTERACTION-DECISION.md`
   §5.1 表里的第 3 条边界）。今天靠「一天最多一轮」的调度兜着。
   将来要一天多轮，**先补这条，而不是把 20 秒调小**。
2. L0/L2 判据（账号标识选择器、会话到期语义）仍然没做
   ⇒ 「未登录」还不能被**提前**查出，只能等采集撞到登录墙。
3. 交付专用 profile 的密码库是空的（刻意的，见 §5.3.1）
   ⇒ 在客户机上会落 `NO_SAVED_CREDENTIAL` 并走叫人。**本机能用 ≠ 客户机能用。**
