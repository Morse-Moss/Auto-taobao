# 自动登录到底卡在哪：2026-09-23 晚的真机对照矩阵

**一句话结论**：Chromium/Edge 的密码自动填充**在这台机器上是好的**；卡点是两件事 ——
① 淘宝那条 `havanalogin.taobao.com` 登录地址上的凭据**不会被填充**（同源也不填，实测 0/3）；
② **值只在一次真实鼠标点击之后才落下**，不在页面加载时落下。
其中「盖文天猫登不进去」的**真正成因是它那个 profile 在 `https://login.taobao.com/` 上一条凭据都没有** ——
不是先前写的「凭据 origin 与登录页 origin 不同」。

---

## 1. 这轮要回答什么

用户 2026-09-23 的原话是「做不到自动登录吗？？？」。上一轮的答案是「改成一组候选地址逐条试」，
理由是「Chromium 按 origin 匹配凭据，各机器凭据的 origin 不一样」。**这个理由被本轮的对照推翻了**，
所以本轮先不写代码，先把「到底哪一环不出手」量清楚。

要分开的三种可能（修法完全不同，症状却一样）：

| 可能 | 症状 | 修法 |
|---|---|---|
| 这条凭据是死的 | 只有某一家填不上 | 让那家重新保存一次密码 |
| 密码填充整体坏了 | 五家全是「一过期就要人」 | 换机制（自己填、或去别处取凭据） |
| 页面在对抗填充 | 平台页能填、人一登录就变 | 改地址/改手势时机 |

## 2. 方法（为什么这些结论可信）

- **一次性实例**：复制一份 profile 到 `D:/Retire/tmp-autofill2-*`，在**未登记端口 19801** 起一个
  只属于本次实验的 Edge（`--remote-debugging-port=19801`），跑完 `taskkill /PID x /T /F` +
  端口回读 + 删临时目录。**六个生产 profile 全挂在正在跑的浏览器上，一律不碰。**
- **判据取自页面自身**，不看页面文字有没有变：`value.length`、`el.matches(':autofill')`、
  `document.elementFromPoint(点击点)`。
- **25ms 采样 + setter 挂钩**：`Page.addScriptToEvaluateOnNewDocument` 在任何页面脚本之前注入，
  挂钩 `HTMLInputElement.prototype.value` 的 setter（含调用栈），并按 25ms 采样状态变化。
  这一条是本轮唯一抓住「页面自己清空输入框」的手法 —— 所有「两秒后读一次」的旧探针都错过去了。
- **补齐公平条件**：走代理的登录流程每次建 session 都会 `Emulation.setFocusEmulationEnabled`
  （`runtime/isolated-proxy/cdp-proxy.mjs:215`），旧版探针没开这一项，本轮补上。

## 3. 实测矩阵（逐格都能指到留档的原始输出）

「✓」＝采样里出现过账号与密码同时非空、且 `:autofill=true`。失败样本一律是
「12 秒内**从未**出现任何非空值，`:autofill` 恒 false」。
原始输出全部在 `raw/`，逐格对应见 `raw/INDEX.md`；**每份输出的「导航 → …」那一行才说明它真的打开了哪条地址。**

| 打开的地址 | 里可林 | 网林 | 科塔 | 盖文天猫 | 商家浏览器 | 命中 |
|---|---|---|---|---|---|---|
| `login.taobao.com/havanaone/login/login.htm?bizName=taobao` | ✓ | ✓ | ✓ | — | — | **3/3** |
| `login.taobao.com/member/login.jhtml` | ✓ | — | — | ✗ | ✓ | 2/3 |
| `havanalogin.taobao.com/mini_login.htm?...`（**带参数**） | — | ✗ ✗ | ✗ | — | ✗ ✗ | **0/5**（3 台机器各试了 1–2 次） |
| 对照组 `github.com/login`（同一个商家 profile） | — | — | — | — | ✓ | 1/1 |

**决定性的一格是「商家浏览器 + `havanalogin`」那两次**（`raw/merchant-nosync.txt`、
`raw/merchant-v2.txt`）：那台机器的凭据里就有一条 `signon_realm=https://havanalogin.taobao.com/`、
`times_used=11`、`skip_zero_click=0` 的记录，页面也开在它自己的 origin 上 —— **仍不填**。
所以「同源就会填」在这条主机上不成立（硬事实 1）。
网林/科塔那几次在 `havanalogin` 上失败不足以单独支撑这条结论（它们的凭据不在那个 origin 上），
列出来是为了让「这条地址在多少台机器上试过、结果如何」可见。

### ⚠️ 一张被更正过的矩阵（原始输出才是凭据，标签不是）

初版这张表里 `member/login.jhtml` 那一行写的是「商家 ✓ 里可林 ✓ 网林 ✗ 科塔 ✗ → 2/4」，
`havanalogin` 那一行写的是 0/3。**回读 `raw/` 里的「导航 → …」才发现那两次「网林/科塔 + member」
实际打开的是 `havanalogin` 那条地址**（命令漏传 `--url`，`--label` 却按 member 写了）
⇒ 两个失败样本**归错了行**。更正后：`member` 2/3、`havanalogin` 0/5。

这条更正**没有改变任何结论**（候选表顺序 = 3/3 的那条排第一、`havanalogin` 整条删除，两条都不受影响），
但它值得留在这里当一条判据：**引用「哪次实验是什么结果」时，去读输出里的「导航 → …」，
不要读标签** —— 标签是人写的，地址是程序打的。同理，跑这类实验时输出**按 run 命名**，
别复用同一个临时文件名（本轮有若干次就是因为复用而被后续覆盖，只能靠上面的并排文件凑齐）。


## 4. 四条硬事实（每条都排除了一个曾被写进注释的错误解释）

1. **`havanalogin.taobao.com` 上的凭据是死的。** 商家浏览器的库里明明有一条
   `signon_realm=https://havanalogin.taobao.com/`、`times_used=11`、`skip_zero_click=0`、
   `blacklisted_by_user=0`、密文 40 字节（`v10`）的凭据，**开在它自己的 origin 上也不填**。
   ⇒「同源就会填」在这条主机上不成立。该候选已从表里删除。
2. **值只在一次真实点击之后才落下。** 所有成功样本的形状都是
   「加载后 `:autofill=true`、值为空 → 真实点击（`Input.dispatchMouseEvent`）→ 值出现
   （账号 8 或 13 字符、密码 9 字符）」。**加载后不出现值，等 12 秒也不出现。**
   ⇒ 主脚本的闸门必须保持「`:autofill` 判定 + 补手势 + 回读」，不能只在加载后读一次。
3. **Chromium 的填充本身是好的。** 对照组：同一个复制件打开 `github.com/login`，
   加载后 `:autofill=true`，真实点击后 **17 字符账号 / 14 字符密码**落地。
   ⇒ 不许再拿「这台机器的填充坏了」当解释。
4. **平台页面自己会清空输入框。** `x.alicdn.com/vip/havana-nlogin/0.10.37/index.js` 的
   `clear()` 在导航后 ~150–650ms 往两个框各写一次空字符串：

   ```
   setter:fm-login-id 写入长度=0
     调用栈：HTMLInputElement.set [as value] (<anonymous>)
        <- Object.te [as clear] (x.alicdn.com/vip/havana-nlogin/0.10.37/index.js)
        <- n.value (...) <- https://x.alicdn.com/vip/havana-nlogin/0.10.37/index.js:1:620588
   ```

   它解释「为什么不能指望零点击填充留在页面上」，但**不是**「Chromium 不出手」的成因
   —— 全程没有任何一帧出现过非空值，说明出手环节就没发生。

## 5. 被排除的解释（省下下一轮的时间）

| 曾经的猜测 | 排除依据 |
|---|---|
| `origin_url` 与登录页 origin 不同 | 开在凭据自己的 origin 上照旧不填（事实 1） |
| 应用绑定加密（`v20`）解不开 | 14 条淘宝凭据前缀全是 `v10`；密文 37–47 字节，长度合法 |
| 密码列是空的 | **我自己的探针 bug**：把 `substr(password_value,1,3)` 的十六进制长度当成了密文长度，报「3 字节」。真实值 37–47 字节（`peek-password-value-length.mjs` 三路复核） |
| `skip_zero_click` 被置 1 | 14 条凭据全是 0 |
| `blacklisted_by_user` | 14 条凭据全是 0 |
| 页面不可见 / 没有焦点 | `document.hasFocus()=true`、`visibilityState=visible`；代理侧本来就开 focus emulation |
| `date_last_filled` 判「这条凭据死了」 | 六个 profile 全部为 0 ⇒ 该列在本版 Edge 上不维护，不可用作判据 |
| `--disable-sync` 关掉了填充 | A/B：不带它也照样不填（事实 3 的对照组也没带） |
| `times_used` 说明「填充工作过」 | 它在 09-22/09-23 每次跑登录时都被刷新，而值从未落地 ⇒ 它是「命中并决定提供」的记账，不是「填进去了」的证据 |
| 页面是 iframe 里的表单 | 顶层文档（`window.top === window.self`），`document.querySelector('form')` 有值 |

## 6. 还剩什么没解释、以及它影响什么

- **为什么 `havanalogin.taobao.com` 这条主机不被装饰**：只知道现象（`:autofill` 恒 false），
  不知道 Blink 侧的原因。**不影响行动**：这条地址已从候选表删除。
- **`member/login.jhtml` 为什么是 2/4**：它会跳到 `havanaone/login/login.htm`，
  跳转链上的表单时序与直接打开第一条不同。**留作第二候选**，不排第一。
- **盖文天猫怎么办**：它的 profile 在 `https://login.taobao.com/` 上**一条凭据都没有**
  （只有一条 `havanalogin`，而那条主机是死的）。候选表造不出凭据 ⇒ 需要人去那台机器上
  用 `login.taobao.com/havanaone/login/login.htm?bizName=taobao` 登录一次并保存密码（一次性）。
- **盖文淘宝的歧义**：它在 `https://login.taobao.com/` 上有**两条**凭据
  （`盖文旗舰店:阿彦` 与 `随心品质定制:阿彦`）。浏览器会自己挑一条 ⇒ **可能静默登成另一家店**。
  这正是身份守卫（`judgeFilled` 的 `WRONG_ACCOUNT`）拦的那一类。

## 7. 本目录的产物

| 文件 | 作用 |
|---|---|
| `peek-login-realm.mjs` / `realm-gaiwen-tmall.txt` | 盖文天猫那条凭据的整行（只读账号名） |
| `probe-autofill-why.mjs` / `autofill-why.txt` | 页面侧现状 + 重载后各时刻（2/4/6/8s） |
| `peek-fill-history.mjs` / `fill-history.txt` | 六个 profile 的 `times_used` / `date_last_filled` |
| `peek-login-flags.mjs` | 加读 `skip_zero_click` / `scheme` / `date_last_used` / `actor_login_approved` |
| `peek-crypt-prefix.mjs` | 密文前缀（`v10` vs 应用绑定 `v20`） |
| `peek-password-value-length.mjs` | 三路复核密文真实长度（**修上面那个探针 bug 的那一份**） |
| `probe-gesture-fill.mjs` | 在**活浏览器**的登录页上做真实点击（只点输入框，绝不点登录） |
| `probe-throwaway-autofill.mjs` | 一次性实例 v1：加载后 / 点击后各读一次 |
| `probe-throwaway-autofill2.mjs` | **一次性实例 v2（主力）**：25ms 采样 + setter 挂钩 + `--url` 可换地址 |
| `shots/` | 各次实验的截图（Chromium 的密码下拉是原生控件、不进 DOM，截图是唯一能看见它的方式） |
| `raw/` ＋ `raw/INDEX.md` | **各次一次性实例实验的完整原始输出**（含每份的「导航 → …」），以及逐格对应表 |
| `mutate-login-guard-1.6.0.mjs` | 1.6.0 的突变验证（9 条，全部被点名用例抓住并逐字节还原）。**脚本自己的输出路径＝`mutation-report.txt`**（本目录下） |
| `raw/mutation-report-run2-final.txt` | 同一份报告的**控制台捕获**（比上面那份多一行 `EXIT=0`，其余逐字节相同） |
| `raw/mutation-report-run1-superseded.txt` | 上一版突变报告（8 条里有一条被标 `skip`，等于一条没有判据的突变）——**留档说明它为什么被重写** |

跑突变验证（**必须在仓库根跑**，脚本自己会定位仓库根、报告写在脚本旁边）：

```
node evidence/login-candidate-loop-2026-09-23/mutate-login-guard-1.6.0.mjs
```

`probe-throwaway-autofill2.mjs` 的用法：

```
node probe-throwaway-autofill2.mjs --source=D:/Retire/edge-profiles/<名> --label=<标签> \
  [--url=<登录地址>] [--disable-sync]
```
