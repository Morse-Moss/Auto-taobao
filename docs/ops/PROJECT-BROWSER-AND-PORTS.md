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

## 1.3 三条路线 × 两个浏览器（权威表在代码里）

2026-09-16 定。这张表的权威版本是 `runtime/browser-ports.mjs` 的 `ROUTES` / `SITE_ACCOUNT` /
`BROWSER_ACCOUNT`，下面这份只是它的可读摘要；两边对不上时**以代码为准**，并由
`runtime/browser-ports.test.mjs` 的六条测试盯着（路线表完整性、站点账号边界、
路线与 `skills/` 双向一致、每个浏览器承载哪些路线、**路线声明的浏览器与它名下脚本引用的端口/身份一致**、
别的项目代理的欠债清单）。

判据不是「哪个 skill 顺手」，而是**站点要哪种账号**：

| 路线 | 站点 | 账号 | 浏览器 | 端口 / profile |
| --- | --- | --- | --- | --- |
| 竞品（小旺神市场分析 / SKU / FAQ / 词库） | `s.taobao.com`、`item.taobao.com`、`detail.tmall.com` | **买家** ＋ 小旺神插件 | 甲 = `competitor` | `9222` ＋ 代理 `3457`，profile `D:/Retire/edge-debug-profile` |
| 关键词·搜索排行 | `sycm.taobao.com`（搜索排行） | **商家** | 乙 = `dailyReport` | `19022` ＋ 代理 `19023`，profile `D:/Retire/edge-daily-report-profile` |
| 日报（生意参谋 ＋ 万相台/阿里妈妈 ＋ 飞书） | `sycm.taobao.com`、`one.alimama.com` | **商家** | 乙 | 同上 |
| 周表粘贴（周表 → 飞书网页） | 飞书 | 独立（飞书自己的账号） | 乙 | 同上 |
| 千牛 / 卖家工作台（**预留**：仓库内暂无调用方） | `myseller.taobao.com`、`qianniu.taobao.com` | **商家** | 乙 | 同上 |
| 关键词·灰豚话题热度 | `xhs.huitun.com`、`dy.huitun.com` | 独立（灰豚自己的账号） | **待定**，见 §1.4 | 现为借用 `3456` |
| 竞品入库（小旺神导出 → 飞书 API） | 飞书 | 独立 | **不需要浏览器**（纯接口） | — |

两句话记住它：

- **甲（买家号 ＋ 小旺神）**：凡是「站在买家视角看淘宝」的活。
- **乙（商家号）**：凡是「以本店身份进后台」的活 —— 生意参谋、千牛、阿里妈妈，飞书跟着乙走。
  灰豚也算乙：它是独立第三方平台、用不了淘宝身份，放乙的唯一理由是**关键词这条路线只开一个浏览器**
  （搜索排行在乙、灰豚也在乙，跑一次关键词不用开两个浏览器）。这是决定，不是必然。

为什么不能省成一个浏览器：一个 profile 只能是一个淘宝身份，而**卖家版账号用不了小旺神**
（商家号登录看不到别家商品详情页 ⇒ 小旺神读不出市场数据）。反过来把买家号登进乙，
生意参谋直接停在登录墙。两边都**不会报错**：点击成功、导航成功、导出成功，
只是拿回来的是错账号下的数据 —— 所以这条只能靠「每条链绑定自己的浏览器」来保证，
不能靠人临场判断。

启动器启动前会念一遍本端口的归属：

```
[browser] 承载路线：账号=buyer 插件=小旺神 路线=competitor；这个 profile 必须是**买家**账号……
```

**这张表说的是「应该去哪」，2026-09-16 已全部接线**：原先 31 处代码/文档默认值指向别的项目的
`3456`，现已逐个改成本登记表的值（清单与守卫见 §1.4）。唯一还需要人做的事是一次性登录：
`D:/Retire/edge-daily-report-profile`（乙）里要**人工登一次灰豚与飞书网页** —— 脚本不代填凭据。

## 1.4 别的项目的代理（3456）：2026-09-16 已清干净

**它是什么**：`3456` 是**另一个项目**的共享 CDP 代理，挂在**使用者日常 Edge** 上，
`/health` 报 `browser.id=edge`。那个浏览器里登的是商家号、**没有小旺神**。

**为什么曾经是欠债**：本项目有 31 处文件把代理默认值指向它（11 个生产链路 ＋ 20 个 `runtime/`
人工维护探针，共同根因＝飞书网页登录态当时挂在日常 Edge 上）。这些地方能不能跑，
取决于「别人的代理此刻活着」＋「那个浏览器里恰好登着我们要的账号」——
别人关掉代理，断的不是他们的流程，是我们的。与 §2「进程必须由本会话启动」是同一个问题的两种形态。

**处置（用户拍板）**：全部迁到本登记表 —— 灰豚与飞书网页归**乙**（`dailyReportProxy`，灰豚是独立
第三方平台、两边都不冲突，放乙是为了「关键词这条路线只开一个浏览器」）；生意参谋搜索排行与
周表粘贴归**乙**；竞品导出归**甲**（`competitorProxy`）。

**守卫**：`runtime/browser-ports.test.mjs` 现在是**正向断言** —— 生产代码与 `SKILL.md` 里
不得再出现带 scheme 的 `http(s)://<host>:3456`；`.mjs` 先去掉注释再匹配，
所以「注释里写清为什么别碰它」这类说明能保留。例外清单
`FOREIGN_PROXY_ALLOWED_FILES` 当前为空，非必要不许加。

**顺带修掉的两个同类残留**（都是「默认值即目标」，坑 35）：
- `xws-export-market-analysis` 的 `XWS_BROWSER_ID` 默认值曾是 `edge`（共享代理时代的身份），
  而甲的代理自报 `edge-isolated` ⇒ 裸跑必被健康检查拦下。已改为登记表。
- 两份 `SKILL.md` 曾写着「用共享 Proxy 3456、要求 `browser.id=edge`」，与现行竞品链矛盾。已改。

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
  本项目 2026-09-16 已把 31 处指向它的默认值全部迁走，并留了一条**正向守卫**：
  生产代码与 `SKILL.md` 里不得再出现带 scheme 的 `http(s)://<host>:3456`（`.mjs` 先去掉注释再判，
  所以「注释里解释为什么别碰它」可以保留）。详见 §1.4。**别去抢这个端口，也别借它当兜底。**
- **9223 / 3458**：2026-09-16 起**已不是本项目在用**的端口（日报链挪到 19022 / 19023）。
  它们是「常见值 ＋ 1」，别的项目会顺手占用，看到它们被占不要去抢。
  2026-09-17 已把仍挂在上面的两个遗留实例停掉（pid 49500 的 `msedge`、pid 49644 的旧日报代理），
  并按登记表把日报浏览器重新起到 **19022**（`node runtime/start-daily-report-browser.mjs`）。
  当时的处置记录见 `DAILY-REPORT-RUN-2026-09-17-FINDINGS.md` §7.6。
- `E:\Two\runtime\edge-debug-profile`：另一个项目的调试配置，**没有小旺神**。
- `C:\Users\Administrator\AppData\Local\Microsoft\Edge\User`（注意**不是** `Edge\User Data`）
  和 Chrome 的 `User Data` 里**也有**小旺神，但那不是本项目在用的配置，别混。

## 4 开跑前的四条判据

1. 启动器没有报 `拒绝启动`（端口上不是另一个 profile 的浏览器）。若它打了 `REUSE`，
   说明这个 profile 的实例已经在跑，直接用即可。
2. `/health` → `connected:true` 且 `browser.id` 与 `XWS_BROWSER_ID` 一致。
3. 页面里小旺神已加载：`document.querySelector('#xws-tblist-box')` 与页面文本含「市场分析」。
4. 登录身份与这条链的归属一致（权威表见 §1.3）：**甲（买家链）**必须是买家向账号
   （本项目专用配置当前是 **`tb452480340`**）——商家号登录会看不到别家商品详情页；
   **乙（商家链）**必须能直接打开生意参谋后台。两条链登错的形态都是**静默**的：
   不报错，只是拿回来的是错账号下的数据。

四条任一不过就停下等人，不要靠重试硬闯（会加速风控）。

## 5 配套环境事实

- 下载目录：`C:\Users\Administrator\Downloads`（`Preferences.savefile.default_directory`）。
- `XWS_DATABASE_URL` 在 `E:/小红书/.env.local`，指向本项目库 `xws_agent@127.0.0.1:5432/xws_automation`。
- 飞书目标与写权限见 `docs/ops/TENANT-MIGRATION-MAP.md` §9。
