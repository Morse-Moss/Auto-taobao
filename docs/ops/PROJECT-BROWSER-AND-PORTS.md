# 项目专用浏览器与固定端口

2026-09-15 定，2026-09-16 改为「登记表驱动」。目的：把「跑采集时要连哪个浏览器、哪个端口」从靠记忆变成靠命令。

## 1 固定下来的四个端口

权威值在 `runtime/browser-ports.mjs`（唯一来源）。启动器、代理启动器、skill 脚本都从这里取；
代码里不得再写第二份端口字面量，`runtime/browser-ports.test.mjs` 有一条静态守卫盯着这件事
（写死的默认值会静默指向错目标 —— 本项目坑 35）。

| 角色 | 端口 | 命令 |
| --- | --- | --- |
| 项目专用调试 Edge（买家号 ＋ 小旺神） | **9222** | `node runtime/start-project-browser.mjs` |
| 项目专用 CDP 代理 | **3457** | `CDP_PROXY_PORT=3457 CDP_BROWSER_PORT=9222 node runtime/isolated-proxy/cdp-proxy.mjs` |
| 运营日报商家 Edge（商家号） | **19022** | `node runtime/start-daily-report-browser.mjs` |
| 运营日报 CDP 代理 | **19023** | `node runtime/start-daily-report-proxy.mjs` |

需要换端口时设 `PROJECT_BROWSER_PORT` / `CDP_PROXY_PORT` / `CDP_BROWSER_PORT`，不要改代码。

为什么日报链从 9223 / 3458 挪到 19022 / 19023：9222/9223 是 Chrome/Edge 远程调试的常见取值，
3456/3457/3458 是本机其他项目也在用的一段 —— 撞号后的表现是「点击和导航都成功，
但操作的是别人的浏览器」。竞品链的 9222 / 3457 保留不动：`evidence/` 与 `runtime/` 下的历史收据
和 manifest 里记着这两个值，改名会让旧证据对不上（坑 37）。

## 1.1 账号前提：两条链不能共用一个浏览器（客户交付必须交代）

- **商家账号**：生意参谋、阿里妈妈、飞书。这条链走 `19022` ＋ `D:/Retire/edge-daily-report-profile`。
- **买家账号**：小旺神插件**只有买家账号能用**（买家视角看市场/竞品数据）。
  这条链走 `9222` ＋ `D:/Retire/edge-debug-profile`（这个 profile 里装着小旺神）。
- 同一个浏览器 profile 不可能同时是商家与买家 ⇒ 两条链必须各自独立实例、独立调试端口、
  独立代理端口。「省一个浏览器」在这里行不通。
- 合并／接错的失败形态是**静默**的：点击、导航、导出都可能返回成功，但操作的是另一个账号的浏览器。

交付前逐台确认：商家号登在日报 profile，买家号登在 `edge-debug-profile`，
且不要把商家号登进 `edge-debug-profile`、也不要把买家号登进日报 profile。

启动器（`runtime/start-project-browser.mjs`）在 spawn 之前会先探一次端口：
- 端口空闲 → 照常启动；
- 端口上已经是**同一个 profile** → 打印 `REUSE`，不重复起实例（重复起只会并入已有进程）；
- 端口上是**另一个 profile** 的浏览器 → 拒绝启动，并把对方的 `product` 与 `profile` 打出来。
  判定依据是 CDP `SystemInfo.getInfo` 的 `commandLine` 里的 `--user-data-dir`（`/json/version`
  给不出 profile，只有它能证明端口归属）。读不出身份时只警告不拦 —— 凭「探针没读到」停线，
  会把一次网络抖动变成一次事故。

## 1.2 浏览器配置目录与身份判据

浏览器配置目录：`D:/Retire/edge-debug-profile`（**里面装了小旺神**，`DevToolsActivePort` 记录的就是 9222）。

运营日报使用独立配置目录 `D:/Retire/edge-daily-report-profile`，只承载生意参谋、阿里妈妈和飞书的商家登录态；不要在这里登录小旺神买家号，也不要把商家号登录进 `edge-debug-profile`。日报代理 `/health` 必须报告 `browser.id=edge-daily-report`。

代理起来后 `/health` 应报：

```json
{"status":"ok","connected":true,"browser":{"id":"edge-isolated","label":"Microsoft Edge (isolated)"},"chromePort":9222}
```

所以跑导出必须同时给两个变量：

```
XWS_PROXY=http://127.0.0.1:3457
XWS_BROWSER_ID=edge-isolated
```

`XWS_BROWSER_ID` 不是可选的：导出器会拿它跟 `/health` 的 `browser.id` 比对，默认值 `edge` 对不上就硬失败。

## 2 为什么必须「固定」+「由本会话启动」

1. **端口本来就该固定**：调试 Edge 用内置的 "Allow remote debugging" 开关时端口是随机分配的
   （实测见过 56320 / 60244），每次重启都变，代理就得跟着改。这里用 `--remote-debugging-port` 钉死。
2. **进程必须由本会话启动，而且父进程要活着**：agent 会话的沙箱只允许连
   「会话开始前就在监听、或本会话自己起的」端口。在沙箱外起的进程活不过那次调用，
   它的端口在本会话里一律 `ECONNREFUSED`（2026-09-15 实测，白折腾了三轮）。
   所以 `start-project-browser.mjs` 除了 `spawn` 之外还要 `setInterval` 保活——
   父进程一退，子进程被回收，端口立刻对会话内不可见。
3. `Start-Process` 启 msedge 在沙箱内**静默失败**（没进程、端口不开、退出码还是 0）。不要用。

## 3 不要碰的东西

- **3456**：别的项目的 CDP 代理，挂在**用户的日常 Edge** 上（`browser.id=edge`）。
  那个浏览器里登录的是**商家账号「盖文旗舰店:阿彦」**，而且**没有装小旺神**——采集在它上面跑不了。
- **9223 / 3458**：2026-09-16 起**已不是本项目在用**的端口（日报链挪到 19022 / 19023）。
  它们是「常见值 ＋ 1」，别的项目会顺手占用，看到它们被占不要去抢。
- `E:\Two\runtime\edge-debug-profile`：另一个项目的调试配置，**没有小旺神**。
- `C:\Users\Administrator\AppData\Local\Microsoft\Edge\User`（注意**不是** `Edge\User Data`）
  和 Chrome 的 `User Data` 里**也有**小旺神，但那不是本项目在用的配置，别混。

## 4 开跑前的四条判据

1. 启动器没有报 `拒绝启动`（端口上不是另一个 profile 的浏览器）。若它打了 `REUSE`，
   说明这个 profile 的实例已经在跑，直接用即可。
2. `/health` → `connected:true` 且 `browser.id` 与 `XWS_BROWSER_ID` 一致。
3. 页面里小旺神已加载：`document.querySelector('#xws-tblist-box')` 与页面文本含「市场分析」。
4. 淘宝登录身份是我们要的那个（本项目专用配置当前是 **`tb452480340`**，买家向；
   商家号登录会看不到别家商品详情页）。

四条任一不过就停下等人，不要靠重试硬闯（会加速风控）。

## 5 配套环境事实

- 下载目录：`C:\Users\Administrator\Downloads`（`Preferences.savefile.default_directory`）。
- `XWS_DATABASE_URL` 在 `E:/小红书/.env.local`，指向本项目库 `xws_agent@127.0.0.1:5432/xws_automation`。
- 飞书目标与写权限见 `docs/ops/TENANT-MIGRATION-MAP.md` §9。
