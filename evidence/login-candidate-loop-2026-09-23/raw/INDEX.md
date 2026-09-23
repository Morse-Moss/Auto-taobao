# `raw/` 逐份说明（2026-09-23 一次性实例实验的原始输出）

**读法**：每一份输出里都有 `实验 <标签>：源=<profile>` 一行（说明用哪台 profile），
以及 `导航 → <地址>` 一行（**说明这一轮真的打开了哪条地址**）。
**判「这次实验测的是哪条地址」只能读后者** —— 标签是人手写的，地址是程序打的，
两者对不上过一次（见 `../README.md` §3「一张被更正过的矩阵」）。

回收行（`taskkill /PID … /T /F` ＋ `端口 19801 已释放 ✓` ＋ `临时 profile 已删`）在每份末尾，
是「没有留下任何残留」的证据。**六个生产 profile 全程没碰。**

---

## 一次性实例实验（形成 README §3 的矩阵）

| 文件 | 里面的实验（标签） | profile | 打开的地址（输出里 `导航 →`） | 结果 |
|---|---|---|---|---|
| `likelin-havanaone__wanglin-member__keta-member.txt` | `likelin-havanaone` | likelin-home（里可林淘宝） | `login.taobao.com/havanaone/login/login.htm?bizName=taobao` | **填上了**（idAf=true，值非空） |
| 同上 | `wanglin-member` | wanglin-flagship（网林天猫） | `havanalogin.taobao.com/mini_login.htm?...` | 未填（12s 内无任何非空值、`:autofill` 恒 false） |
| 同上 | `keta-member` | shop-j873522735（科塔淘宝） | `havanalogin.taobao.com/mini_login.htm?...` | 未填 |
| `wanglin-havanaone-a__wanglin-member-b__keta-havanaone-a.txt` | `wanglin-havanaone-a` | wanglin-flagship | `…/havanaone/login/login.htm?bizName=taobao` | **填上了** |
| 同上 | `wanglin-member-b` | wanglin-flagship | `havanalogin…/mini_login.htm?...` | 未填（同一台机器第二次，复现） |
| 同上 | `keta-havanaone-a` | shop-j873522735 | `…/havanaone/login/login.htm?bizName=taobao` | **填上了**（点击后 idLen=13 / pwdLen=9） |
| `gwtm-old-url_and_likelin-old-url.txt` | `gwtm-old-url` | gaiwen-flagship（盖文天猫） | `login.taobao.com/member/login.jhtml` | 未填 |
| 同上 | `likelin-old-url` | likelin-home | `login.taobao.com/member/login.jhtml` | **填上了** |
| `old-login-merchant.txt` | `old-login-merchant` | edge-daily-report-profile（商家浏览器） | `login.taobao.com/member/login.jhtml` | **填上了** |
| `merchant-v2.txt` | `merchant-v2` | edge-daily-report-profile | `havanalogin…/mini_login.htm?...`（**带参数**） | 未填 ⇒ 「能被打开 ≠ 会被填」 |
| `merchant-nosync.txt` | `merchant-nosync` | edge-daily-report-profile | `havanalogin…/mini_login.htm?...` | 未填（零点击、点用户名框、点密码框、真实按键，四种全试过） |
| `github-control.txt` | `github-control` | edge-daily-report-profile | `github.com/login` | **填上了**（17 字符 / 14 字符）⇒ 填充机制本身是好的 |

**决定性样本**是 `merchant-nosync.txt` 与 `merchant-v2.txt` 那两次：那份 profile 的凭据里
**就有**一条 `signon_realm=https://havanalogin.taobao.com/`、`times_used=11`、`skip_zero_click=0` 的记录
（`merchant-nosync.txt` 第 9 行的凭据清单里能直接看到），页面也开在它自己的 origin 上，**仍不填**。

## 非一次性实例的辅助输出

| 文件 | 作用 |
|---|---|
| `login-flags-summary.txt` | 六个 profile 的 `logins` 表关键列（`skip_zero_click` / `scheme` / `times_used` / `date_last_used` …），只读、只打账号名 |
| `password-value-length-3way.txt` | **三路复核**密文真实长度（SQL `length(hex(x))/2` ＋ JS `Uint8Array.byteLength` ＋ DDL 声明类型）—— 修「我把密文长度算成 3 字节」那个探针 bug 的那一份 |
| `crypt-prefix.txt` | 密文前缀（`v10` vs 应用绑定 `v20`）。**这份里的「密文 N 字节」是错的**（就是上面那个 bug），只看 `v10` 这个前缀即可 |
| `gesture-poke-19045.txt` / `gesture-poke-19023.txt` | 在**正在跑的**生产浏览器上做只读盘点＋真实点击输入框（**绝不点登录**），用于回答「补手势有没有用」 |
| `tests-adjacent-1.6.0.txt` | 1.6.0 相邻用例（`login-merchant-core` ＋ `check-login-shops-core` ＋ `version-consistency`）的完整 TAP 输出 |
| `mutation-report-run2-final.txt` | 1.6.0 突变验证最终报告（9 条，全部被点名用例抓住、全部逐字节还原） |
| `mutation-report-run1-superseded.txt` | 上一版突变报告（**已作废**：8 条里有一条被标 `skip`，等于一条没有判据的突变；报告里那行 `[跳过]` 就是它） |
