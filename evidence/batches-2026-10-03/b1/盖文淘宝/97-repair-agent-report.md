# 修复 agent 报告 · 盖文淘宝（目标日 2026-10-03）

- agent：repair-agent-1003
- 报告生成时间：2026-10-04T15:57:28+08:00
- 证据目录：evidence/batches-2026-10-03/b1/盖文淘宝/
- 请求单：97-repair-request.json（cause=SHOP_BLOCKED，stage=health-check，retryStage=health-check，proxy=http://127.0.0.1:19043）
- 候选动作（来自请求单，闭集内）：RESET_PAGES / RELOAD_PAGE

## 结论

**修不动 ⇒ 转人。** 根因是**该店登录态已失效**（且实例已释放），不是页面渲染类故障。
页面类候选动作（RESET_PAGES / RELOAD_PAGE）**无法**修好登录态，且当前连实例都不在，故未执行任何写动作。

## 事实基座（只读实测）

### 1. 端口存活探测（实测）

命令 A：
```
node runtime/browser-inventory.mjs
```
回读：三家目标店全部「缺 / 浏览器=free / 代理=连不上」，其中
`盖文淘宝  浏览器:19033=free(free)  代理:19043=连不上`。

命令 B（独立 TCP 探测，node net.connect，超时 1500ms）：
```
node -e "…net.connect 127.0.0.1:<port>…"
```
回读：
```
盖文淘宝 CDP     127.0.0.1:19033  ERR:ECONNREFUSED
盖文淘宝 proxy   127.0.0.1:19043  ERR:ECONNREFUSED
商家浏览器 CDP    127.0.0.1:19022  OPEN        ← 对照：说明探测方法本身有效
商家浏览器 proxy  127.0.0.1:19023  OPEN
```
⇒ **盖文淘宝的实例与代理都已不在**（本轮是 `--batches` 形态，跑完即释放）。
按作业指导书：实例已释放 ⇒ 页面类动作必然连不上，不硬试。

### 2. 现场事实（失败那一刻）

`98-failure-state.txt` 回读：页面=「?」、URL=「?」、可见元素 0 个（感知层未取到有用页）。

`98-failure-state.json` 回读：感知层实际落在
`file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?...&state=需要登录`，
可见文本含「**需要登录** 请在本窗口…登录上面这家店的账号」。即感知层拍到的是**该店的窗口标签页**，其状态字段写着「需要登录」。

`summary.json`（b1）里本题 `failureOutput` 回读（决定性证据）：
```
归位：归位后仍不齐（生意参谋工作页=0  阿里妈妈报表页=1）
  [阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里…
```
`recovery` 段回读：回位后 `生意参谋工作页` 仍是 0 个；foreign 页签里有
`https://sycm.taobao.com/custom/login.htm?...`、`https://login.taobao.com/havanaone/login/login.htm?...`
⇒ 生意参谋工作页被弹回**登录页**，所以「找不到工作页」。

旁证 `evidence/batches-2026-10-03/login-preflight-b1.json` 回读：
```
"shop":"盖文淘宝","verdict":"NEEDS_LOGIN",
"sites":{"sycm":"LOGGED_OUT","alimama":"LOGGED_OUT"},
"scriptVerdict":"NO_SAVED_CREDENTIAL",
"needHuman":[{"shop":"盖文淘宝","sites":["sycm","alimama"]}]
```
且本轮已在 07:34:35 发出飞书登录提醒（alertId=sycm-login-round-20261004）。

### 3. 候选动作为何不执行

- `RESET_PAGES`：脚本里该动作调 `runtime/page-normalize.mjs`，必须连 CDP（19033）。实例不在 ⇒ 必然连不上；即便连上，工作页是被服务端弹回登录页，归位也变不出登录态（本轮脚本自己第 1 轮已跑过 RESET_PAGES，applied=false）。
- `RELOAD_PAGE`：脚本里该动作先 `GET /targets` 定位目标页；代理 19043 不在 ⇒ 必然 `读不到页签（代理连不上）`，`applied=false`。

两者都不可能改变「登录态失效」这个根因，因此按指导书「动作没落地⇒不重试阶段」与「实例已释放不硬试」，**均未执行**（未发任何写请求）。

## 需要人做什么

1. 在**盖文淘宝专属窗口**（CDP 19033，会员名 随心品质定制:小瓜）手工登录 sycm 与 alimama；
   按浏览器提示**保存密码**，保存时地址栏要停在 `login.taobao.com` 开头的登录页。
2. 登录后重跑该店：`node scripts/run-daily-job.mjs --date 2026-10-03 --shops 盖文淘宝`。

## 代码变更

无。未改动仓库任何代码，故无 code-diff.patch。

## 时间线

- 15:5x 只读读 97-repair-request.json / 98-failure-state.* / summary.json / login-preflight-b1.json
- 15:5x `node runtime/browser-inventory.mjs` → 盖文淘宝 19033 free / 19043 连不上
- 15:5x 独立 TCP 探测 19033/19043 → ECONNREFUSED（19022/19023 OPEN 作对照）
- 15:5x 判定：根因=登录态失效 + 实例释放 ⇒ 候选动作无法执行且无法修根因 ⇒ 转人
