# 网林天猫「登不了」诊断（2026-09-25 22:4x，只读）

问题：用户判断「网林在浏览器里肯定保存了账号密码」，要查清为什么登不上。
结论：用户说对了 —— 凭据确实在，而且被真的填进了登录框、账号也核对过、登录按钮也点了；
**是服务端没放行**。不是「没有凭据」，也不是「页面没归位」。

## 时间线（同一天，全为 +08）

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 08:14–12:12 | 7 次登录预检，网林天猫全部 `ALREADY_LOGGED_IN` | evidence/daily-job-2026-09-24/job.log |
| 11:59:32 / 12:00:20 | 09-24 的网林家居旗舰店 push 成功、网林天猫 backfill 成功 | 审计表 id 98 / 99 |
| 12:12 之后 | 网林的登录态没了（它自己的生意参谋被弹回登录页） | 19:18 那次预检 |
| 19:18:31 | 第一次自动登录：`LOGIN_NOT_CONFIRMED` | evidence/batches-2026-09-24/batches.log |
| 19:25:51 | 第二次：`LOGIN_NOT_CONFIRMED` | 同上 |
| 20:01:19 | 第三次：`LOGIN_NOT_CONFIRMED` | 同上 |
| 21:14:50 | 第四次：`LOGIN_NOT_CONFIRMED` | evidence/batches-2026-09-24/login-preflight-b2.json |
| 21:06 | 09-24 清理删掉网林那一行（它 11:59 写的那行 recvwcx3XcTNK5）；21:13 那轮它没重写 | evidence/daily-report-2026-09-24-clear-rerun2/post-delete-verification.json |

同一天四次自动登录，四次同一个结论。四家正常店在同样的时段里全部 `ALREADY_LOGGED_IN`
（它们**没有走登录流程**，只是会话还在），所以「自动登录对别人管用」这件事今天没有证据；
唯一一次真机命中是 2026-09-23 商家浏览器那次。

## 凭据侧：确实存在，且完全可用（只读密码库，未读密码）

profile `D:/Retire/edge-profiles/wanglin-flagship` 的 `Default/Login Data`：

- 淘宝相关凭据 1 条，origin = `https://login.taobao.com/havanaone/login/login.htm`
- 与脚本打开的候选登录页 **origin 逐字相同** ⇒ 会被填充
- 账号 = `网林家居旗舰店:阿彦`（正是这家店）
- 密码字段非空（只读长度，未读内容）
- 未拉黑（`blacklisted_by_user = 0`），同 origin 恰好 1 条 ⇒ 不存在「浏览器自己挑错一条」的风险
- `times_used = 1`，最后一次使用 2026-09-22（**注意：`times_used` 不是「填进去了」的证据**）

完整对照见 `credential-audit.json`。

## 登不成的判据链（读源码得到，不是推测）

`login-merchant.mjs` 只有在走完下面每一步之后才会给出 `LOGIN_NOT_CONFIRMED`：

1. 页面上账号框与密码框都可见（否则换下一条候选）
2. `:autofill` 为真 —— 这个 origin 上有凭据（否则 `NO_AUTOFILL`）
3. 补一次可信手势后，账号框与密码框的值长度**都 > 0**（否则 `NO_VALUE_LANDED`）
4. 读一次账号框，与这家店登记的名字逐字比对一致（否则 `WRONG_ACCOUNT` / `EMPTY`）
5. 没有滑块/验证码显形（否则 `CAPTCHA_REQUIRED`）
6. 找到「登录」按钮的位置并点了（找不到会报 `STOP_AND_ALERT`）
7. 等 6 秒后再读一次地址 —— **仍是淘宝登录页** ⇒ `LOGIN_NOT_CONFIRMED`

也就是说：值落地了、账号对了、协议勾了、按钮点了，服务端没有放行。

## 三种可能，脚本把它们合并成了同一句话

`LOGIN_NOT_CONFIRMED` 的文案是「可能是密码不对，也可能是平台要求额外验证」。实际能产生它的成因有三种：

1. 保存的那份密码已经不对（改过密码 / 子账号密码被重置 / 该子账号异常）
2. 平台在页内要求额外验证（短信、实人、安全提醒），且停留在登录页上没有跳转
3. 脚本自己的点击没落到「登录」按钮上（页面堆叠/坐标漂移），也就是**压根没提交**

这三种在只读数据里**分不出来**。能分开它们的是「提交之后页面上的那一句话」——
而那一次跑没有留下这个证据：`login-merchant` 的回执里有 `urlAfter`、两个框的落地长度、
协议勾选状态、`guard` 判定、是否弹验证码，但 `check-login-shops.mjs` 只取 verdict 与 detail，
**回执没落盘**；跑的时候也没带 `--shots`，所以连截图都没有。
（可改：把子进程回执整份写进 `evidence/batches-*/<店>/` —— 一条路径就能让下一次可复盘。）

## 侧证：它的登录态是真的没了（不是「页面没归位」的假象）

只读各 profile 的 `Cookies` 库（不读值）：

| profile | taobao/tmall/alimama cookie 数 | `.taobao.com` 上的 `unb` / `sn` |
| --- | --- | --- |
| 网林天猫 | 45 | **都没有** |
| 里可林淘宝 | 94 | 都有 |
| 盖文淘宝 | 96 | 都有 |
| 盖文天猫 | 95 | 都有 |
| 科塔淘宝 | 95 | 都有 |
| 商家浏览器 | 87 | 有 |

（`sn` = 主账号:子账号、`unb` = 数字账号 id，是两个站点的身份键。）
网林连身份键都没有，且完全没有 tmall 系的 cookie ⇒ 它的会话是真的不在了。
其余四家磁盘上仍有身份键 —— 这**暗示**它们下次启动可能仍是登录态，但那是预测，不是事实：
真正算数的是启动后由预检读出来的结果。

## 不能做 / 不该做

- **不要再自动重试登录**：今天已经 4 次失败提交，脚本自己也刻意不重试（连试会把账号锁住）。
- **不要拿「删掉再重跑」当解法**：网林缺数据的原因在链的第 0 步（登录），不在采集。
  删完重跑，网林仍然缺；而且四家好行会被删掉一次再重采。

## 需要人做的一件事（一句话就能定性）

去「网林天猫 · 日报采集窗口」里手动登一次，**看页面提示的那一句话**：

- 提示「密码错误 / 账号或密码不正确」⇒ 属于成因 1：密码变了。登录成功后 Edge 会问要不要更新保存的密码，点更新即可（否则下次自动填充还是旧的）。
- 出现短信/实人/滑块等验证 ⇒ 属于成因 2：做完验证就行，下次会话就能用。
- 什么提示都没有、两个框里还留着刚填的账号密码 ⇒ 属于成因 3：脚本点击没生效，那是我们这一侧要修的。

## 23:00 实测：窗口已拉起并停在登录页，成因 1（没凭据）已被排除

用户同意后执行（**未提交表单**），四步都是可回读的：

1. `scripts/start-all-hold.mjs --only 网林天猫` 拉起窗口：browser pid 61912、proxy pid 39484；
   独立复核 `runtime/browser-inventory.mjs` ⇒ `网林天猫 浏览器:19032=occupied(profile 一致) 代理:19042=在`。
2. `runtime/shop-pages.mjs --open` 归位：生意参谋页落到
   `sycm.taobao.com/custom/login.htm?_target=…`、万相台页落到 `one.alimama.com/index.html#!/login/index`
   —— 两个后台**各自的**会话都真的没了（不是页面没归位）。
3. `login-merchant.mjs --proxy 19042 --shop 网林天猫 --notify off --shots …`（**不带 --commit**）
   在候选 `havanaone` 上开出顶层淘宝登录页并推到前台，回执：

   ```json
   { "verdict": "READY_TO_GESTURE",
     "login": { "candidate": "havanaone", "opened": true,
                "autofill": { "id": true, "password": true },
                "expectedMember": "网林家居旗舰店:阿彦", "gesturePoint": [672, 321] } }
   ```

   截图 `wanglin-manual-login/login-before-commit.png`：账号框里**已经显示**「网林家居旗舰店:阿彦」，
   密码框是点状占位 —— 这就是 Chromium 的填充**预览态**（值不进 DOM）。

结论修正：`autofill.id === true && autofill.password === true` 说明
**这个 origin 上有凭据、浏览器也肯填** ⇒ 「密码库里没凭据 / origin 不匹配」这条被实测排除。
剩下两种（密码已变、提交后要求额外验证）加上第三种（我们那次点击没落到按钮），
仍然只能在**同一次提交之后**看页面上那句话来区分 —— 现在人就在这一页上，登一次即可。

回执原文 `wanglin-login-page-receipt.json`、回车后页签清单 `wanglin-tabs-after.json`。
**这一次没有提交**：全程 `commit: false`，没有补手势、没有点登录按钮，
今天那 4 次失败提交没有被变成第 5 次。

## 23:15 结论修正：卡点是「确认登录」这一步，不是密码

用户回报：点完登录还要点一下同意协议，点了就进去了。据此重查，**那个页面我抓到了**。

### 一、你那次手动登录是成功的（事实，不是推测）

浏览器还在跑（主进程 62080，窗口标题「登录 和另外 3 个页面」，4 个页签），所以 profile 的
`Cookies` 库是锁着的（`copyfile` EBUSY）——改用浏览器自己的 CDP `Storage.getCookies`（只读查询）：

| 项 | 22:41（登录前） | 23:12（登录后） |
| --- | --- | --- |
| taobao/tmall/alimama cookie 总数 | 45 | **82** |
| `.taobao.com` 上的 `unb` / `sn` | 都没有 | **都有** |
| `cookie2` / `sgcookie` / `_tb_token_` | 部分 | `.taobao.com`、`.tmall.com`、`.tmall.hk`、`.alimama.com` 齐 |

紧接着跑 `login-merchant.mjs --check-only`（这一档不开登录页）：

```json
{ "verdict": "ALREADY_LOGGED_IN",
  "sites": { "sycm":    { "loggedIn": true, "href": "https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop" },
             "alimama": { "loggedIn": true, "href": "https://one.alimama.com/index.html" } } }
```

⇒ 两个后台现在都在登录态。**网林天猫的登录问题已经解开**，不需要再登一次。

### 二、「同意协议」那一页的真实结构（现场取证）

`probe-login-detail.mjs`（只读）抓到的当场：

- `location.href` = `https://login.taobao.com/havanaone/login/login.htm?bizName=taobao` —— **与密码表单那一屏逐字相同**
- `#login` 的 class = `width-vertical login-label-icon login-view-hasLogin taobao_pc`
- 内层块 `.has-login.cm-has-login`，矩形 `[712,235,370,338]`，文案 `确认登录 / 网**彦 / 快速进入 / 使用其他账号登录`
- `#container` = `login-box loading`（页面标题下那句「自动登录中…」就是它）
- `passwordForm = { id:false, password:false, agreement:false, submit:true }`、`checkboxCount = 0`
  ⇒ 这一屏上**没有**账号框/密码框/协议勾选框，只剩一个 `button.fm-submit`
- 页面内嵌配置里带着协议清单：`"registerAgreementCheck": true`、
  `agreements.title = "服务协议及隐私保护"`、
  `agreements.subtitle = "为了更好地保障您的合法权益，请您阅读并同意以下协议"`，
  条目是《淘宝平台服务协议》《法律声明》《支付宝及客户端服务协议》
  ⇒ 这就你说点的那个「同意协议」；它是登录页的第二屏，不是一个独立的 URL。
- 截图：`wanglin-confirm-login-view.png`（右边一块橙色「快速进入」，头像旁边写着 `网**彦`）

### 三、为什么四次自动登录都停在同一处（机制）

`login-merchant.mjs` 提交之后**唯一的成败判据**是这一行：

```js
const hrefAfter = await evalOn(args, targetId, 'location.href');
if (hrefAfter && isTaobaoLoginUrl(hrefAfter)) { verdict = 'LOGIN_NOT_CONFIRMED'; … }
```

而「确认登录 / 快速进入」这一屏**地址不换**（它只是把同一页切成 `login-view-hasLogin`）。
⇒ 提交成功也好、还差一下确认也好，这一行都判成「还在登录页」⇒ `LOGIN_NOT_CONFIRMED`
⇒ 文案写「可能是密码不对，也可能是平台要求额外验证」——**两句都不对**，真因是「还差一下确认」。
⇒ 那一步从来没被完成过 ⇒ 下一次（自动或人工）只能从头再走一遍
⇒ 表现成「每次都要求同意协议」。**不是平台反复无常，是我们每次都停在它面前没点。**

### 四、不能证的部分（不许糊过去）

19:18 / 19:25 / 20:01 / 21:14 那四次，页面在提交后到底是「确认登录」还是「协议浮层」还是别的中间态，
**没有证据可查**：驱动方 `check-login-shops.mjs` 只取 `verdict` + `detail`，子进程那份回执
（`urlAfter`、两个框落地长度、`guard`、是否弹验证码）被丢掉，也没带 `--shots`。
上面第三节是**机制解释**（判据本身对这两种现场都失效），不是那四次的现场记录。

### 五、能不能自动化

- 「快速进入」：纯确认，建议自动 —— 判据用结构（`.cm-has-login` / `login-view-hasLogin` 且含「快速进入」），
  点完**再回读**地址与两个站点。
- 「同意协议」：技术上一样能点，但那是**替这个账号接受一份法律文本**。
  默认建议**不自动同意**，而是给这一步一个专属结论（如 `AGREEMENT_REQUIRED`）并说准卡在哪一步；
  要全自动的话，回执里必须留下「什么时间同意了哪一份协议」。
- 两条不变的底线：验证码/滑块一露面就交人；不重复提交（今天已 4 次失败，不要变成第 5 次）。
- 落地时要遵守仓库纪律：改状态机前读 `docs/ops/LESSONS-2026-09-14_15.md`，
  改完在**未登记端口 + 临时 profile** 的一次性实例上真跑一次留证，并加离线用例钉住新判据。

### 六、前瞻风险（按仓库既有实测口径写，不拿它当预判）

现在这套身份键 cookie（`unb` / `sn` / `cookie2`）在 CDP 读出来**全是会话级**。
但**不许把它当成「关浏览器就会掉」的预判**：`LOGIN-NOTES.md` 里记着 09-23 的实测 ——
**冷启动后盖文淘宝的会话还在**，而那次商家浏览器掉登录恰恰发生在重启**之前**。
⇒ 明天 08:14 那轮冷启动网林是什么状态，**只能实测**，不能推断。

要记的是另一件事：**万一它掉了**，自动登录仍然会卡在「确认登录」这一步（第五节那条修复未做之前）。
所以「今天好了」不等于「以后都会好」。
