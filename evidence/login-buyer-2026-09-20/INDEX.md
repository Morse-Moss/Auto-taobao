# evidence/login-buyer-2026-09-20

竞品链（买家号 ＋ 小旺神）登录页已**主动拉起**，供人工登录。

## 现场事实

| 项 | 值 |
| --- | --- |
| 浏览器 | 竞品链调试 Edge，调试端口 `9222` / CDP 代理 `3457`（来自 `runtime/browser-ports.mjs`） |
| profile | `D:/Retire/edge-debug-profile`（对账读出的 `--user-data-dir` 与登记表一致） |
| 起页前页签 | 仅一个 `about:blank` |
| 拉起后 URL | `https://login.taobao.com/havanaone/login/login.htm?bizName=taobao`（由 `login.taobao.com/member/login.jhtml` 跳转） |
| 标题 | 登录 |
| 页签标签 | `买家号登录页`（`/label`） |
| 已钉住 | 是（`/pin` ⇒ 闲置不回收、代理退出也不关） |
| 已置前 | 是（`/bringToFront`） |
| 判定 | 显示的是**登录表单**（扫码 + 密码/短信），不是「已登录」页 ⇒ 这个 profile 当前没有买家号登录态 |

## 本次动作

1. `GET /targets` 盘点（1 个 `about:blank`）
2. `GET /navigate?target=<该页签>&url=https://login.taobao.com/member/login.jhtml` —— 等加载
3. `GET /label?target=…&label=买家号登录页`
4. `GET /pin?target=…` —— 钉住，避免闲置 15 分钟被回收（本项目坑：不钉的页会「晚上补好、早上没了」，且全程不报错）
5. `GET /bringToFront?target=…`
6. `GET /eval` 读回 `location.href` / `document.title` 复核
7. `GET /screenshot?…&file=…` 留图 → `login-page.png`

## 没做的事（刻意）

- **没有**登录、没有代填任何凭据、没有点过任何按钮、没有碰登录墙。
- **没有**起停任何进程或容器 —— 全程只是在**已经在跑的**浏览器里开了一页。
- **没有**动商家浏览器（`19022/19023`）—— 它与竞品链是两个 profile、两种账号，合并会静默失败。

## 这份证据证不了什么

- 它不证明买家号已经登录；恰恰相反，截图显示的是**未登录**的登录页。
- 它不证明 `70cm`、小旺神面板或任何采集动作可用 —— 那些要等登录完成后另跑。
- 页签被钉住意味着它不会被自动回收；**如果要关它，得显式关**（本项目「关页是人决定的事」）。
