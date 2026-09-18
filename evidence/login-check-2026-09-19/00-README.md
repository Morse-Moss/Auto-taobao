# 四台店登录态只读检测（2026-09-19 凌晨）

## 起因

用户 2026-09-19 05:1x 原话：「之前我都登录过一次了，而且我去看盖文和科塔都登录了」。
上一轮我请他人工登录「盖文淘宝」与「科塔淘宝」两台。他要的是「能跑了」，所以先核实事实。

## 命令（**必须带 `--proxy`**，见下面第一个发现）

```powershell
node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --shop 里可林淘宝 --proxy http://127.0.0.1:19041
node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --shop 网林天猫   --proxy http://127.0.0.1:19042
node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --shop 盖文淘宝   --proxy http://127.0.0.1:19043
node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --shop 科塔淘宝   --proxy http://127.0.0.1:19044
```

不带 `--commit` ⇒ 只读检测（导航去验、回读、截图，**不提交任何表单**，撞到登录墙也不惊动人）。

## 结果

| 店 | 代理 | 生意参谋 | 阿里妈妈 | verdict |
|---|---|---|---|---|
| 里可林淘宝 | 19041 | 已登录 | 已登录 | `ALREADY_LOGGED_IN` |
| 网林天猫 | 19042 | 已登录 | 已登录 | `ALREADY_LOGGED_IN` |
| 盖文淘宝 | 19043 | 已登录 | 已登录 | `ALREADY_LOGGED_IN` |
| 科塔淘宝 | 19044 | 已登录 | **未登录**（被踢回 `one.alimama.com/index.html#!/login/index`） | `NO_SAVED_CREDENTIAL`（**这个结论不可信，见下**） |

「已登录」的判据是 `siteLoggedIn`：**导航到只有登录态才进得去的那一页 → 等 5 秒 → 回读
`location.href`**，没被踢回登录页才算。所以「用户说登录了」与「判据读到登录了」在这台上是一致的；
科塔的阿里妈妈那条则是**被当场踢回登录页**。

⇒ **「四家都能跑」不成立**：科塔淘宝的阿里妈妈需要人工登录一次。

## 发现一：`--shop` 不改变探测目标 ⇒ 不配 `--proxy` 会「假测四台」

第一轮我按 `--shop` 逐店跑了四条（没给 `--proxy`），**四份输出逐字相同**，`proxy` 全是 `19023`
（商家共用浏览器）。原因是 `login-merchant-core.mjs` 里 `--proxy` 的默认值是日报链代理，
而 `--shop` 的唯一用途是**让告警点名哪家店**。

危险之处在于它的表现是**全绿** —— 看着像「四家都查过了」，其实同一台机器查了四次。
**判据：四份输出的 `proxy` 字段必须各是各的店。**

已补进 SOP §11 与 SKILL.md。

## 发现二：科塔那条 `NO_SAVED_CREDENTIAL` 是**假阴性**

脚本第二步会去开一个顶层淘宝登录页、再看浏览器自动填充有没有生效。而输出里：

```
"login": {
  "targetId": "A96F1421C332D7D93F1B7EEAD7087BE9",
  "opened": true,
  "urlBefore": "https://myseller.taobao.com/home.htm/QnworkbenchHome/",   ← 千牛页，不是登录页
  "autofill": { "id": null, "password": null },
  "shots": "evidence\\login-check-2026-09-19\\login-no-autofill.png"
}
```

`urlBefore` 是「打开登录页后 2.5 秒，那个标签页上实际的 `location.href`」，它读到的是**千牛工作台**；
`login-no-autofill.png` 截图里也是千牛页（时间戳 05:13:55，页面是「科塔全卫定制」的千牛首页）。

原因（按 SOP §11.3 第 1 条记过的那个形态）：**淘宝主站会话有效时，访问登录页会被重定向到千牛工作台**。
于是脚本在千牛页上当然找不到 `#fm-login-id`，就报成了「没存密码」——
**它既不能说「密码库里没有凭据」，也不能说「需要人去存密码」**。

判别方法：看 `login.urlBefore` / `login.shots` 那一页**是不是千牛**。是千牛就是踩到这条。
真实结论只看 `sites.alimama.loggedIn`（那条走的是导航 + 回读 URL，路径不同、可信）。

⚠️ **尚未修**：修法应该是「打开登录页后若落到千牛（`myseller.taobao.com`），
判成『淘宝主站已登录、该站点需单独登录』，而不是 `NO_SAVED_CREDENTIAL`」。
本轮只记录与补文档，没有改代码（改它要有判据 + 突变）。

## 顺带观察

- 里可林淘宝与科塔淘宝的窗口标签页**又不在**（这已是第三次：三次都是 `/new` 新建出来的那两台消失，
  复用的那两台一直健在）。原因仍未查明，不编解释。
- 科塔窗口现在有**两个千牛页**（`myseller.taobao.com`）—— 一个原本就有，一个是上面这条假阴性
  过程里被重定向落下来的。按 SOP §1.3 的清理口径「千牛只留一个」，可用
  `node runtime/shop-window-label.mjs --prune --commit` 清（**本轮未清**）。
