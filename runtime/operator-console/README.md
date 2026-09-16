# 运营台（本地控制台，一期）

一个只监听 `127.0.0.1` 的**只读**页面：一眼看清两个浏览器 profile 的环境灯、账号卡、
以及 FAQ 链跑到哪一步。设计依据是 `docs/ops/OPERATOR-CONSOLE-INTERACTION.md`。

## 怎么起

```bash
node runtime/operator-console/server.mjs
# → http://127.0.0.1:19024
```

端口不是这里写死的，取自 `runtime/browser-ports.mjs` 的 `PROJECT_PORTS.operatorConsole`。
要临时换端口用 `OPERATOR_CONSOLE_PORT=19025`；给一个非法值会直接报错，不会静默回落（坑 35）。

## 一期只做三件事，也只做这三件

1. **读**：`/api/env`（两个 profile 的端口与配置真探）、`/api/accounts`、`/api/runs`、`/api/health`。
2. **渲染**：五块 —— 今天 / 账号体检 / 启动 / 进度 / 需要你做的事。
3. **说清楚自己不知道什么**：取不到就显示灰块，并且**必须**带 `reasonCode` 和「读的是哪个文件」。

**不做的**：不写任何文件（协议层拒绝 `POST/PUT/PATCH/DELETE`，405 并附一句人话）、
不代填凭据、不后台轮询登录态（轮询是风控加速器）、不做第二份状态真相。

## 页面上的每盏灯都指着一个文件

| 界面元素 | 真相源 |
| --- | --- |
| 分组（甲/乙两列）、端口、profile、路线 | `runtime/browser-ports.mjs`（`PROJECT_PORTS` / `BROWSER_PROFILES` / `BROWSER_LABELS` / `ROUTES`） |
| 进度与阶段清单 | `runtime/faq-analysis/<周期>/operator-status.json`，回落 `evidence/faq-operator-status-<周期>.json` |
| 阶段的判定与顺序 | `runtime/faq-operator-core.mjs`（`determineFaqOperatorState` / `describeFaqStages`）—— 页面不重算顺序 |
| 账号灯 | **暂时没有真相源**：一期是示例数据，页面上显式标注「示例」 |

## 一期明确没接的东西（页面上也会写出来）

| 缺口 | 页面上的表现 |
| --- | --- |
| 排期器没有生产调用方 | ① 今天：灰块 + `SCHEDULER_NOT_WIRED` |
| 队列探针没有生产调用方 | ③ 启动：「预览」「开始」不可点 + `QUEUE_PROBE_NOT_WIRED` |
| 账号体检只覆盖小旺神/竞品链 | ② 账号体检：整块横幅声明「示例数据」+ 每张卡 `sample=true` |
| `AUTH_EXPIRING` / `RISK_BLOCKED` 只在词表里 | ② 页面上单独列出「词表里有、体检还没产出」的状态 |
| 除 FAQ 外没有阶段清单 | ④ 进度：灰块 + `NO_STAGE_LIST_FOR_OTHER_CHAINS`，不给别的链编进度条 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | HTTP 服务。静态文件走固定白名单（不拼接请求路径）；只绑回环 |
| `state.mjs` | 数据加工层：只做「读文件 + 摊平」，不产生新状态 |
| `index.html` / `styles.css` / `app.js` | 页面。只用 `textContent` 渲染数据，不用 `innerHTML` |
| `state.test.mjs` / `server.test.mjs` | 单测（离线，已纳入 `runtime` 套件） |
| `acceptance.mjs` | 真机验收：起真 Chrome 渲染 + 截图，验「取不到就灰」分支 |

## 验收

```bash
node runtime/operator-console/server.mjs     # 另开一个终端
node runtime/operator-console/acceptance.mjs --base http://127.0.0.1:19024 \
  --out evidence/operator-console-2026-09-16
```

验收会自己再起一个**进程内**实例（临时 `runtimeRoot` + 临时 `repoRoot`）来验灰灯分支 ——
只替换 `runtimeRoot` 是不够的，`evidence/` 里的历史快照会把那块填成绿的。
脚本不启停你已经在跑的那个服务。
