# 运营台（本地控制台）

一个只监听 `127.0.0.1` 的页面：一眼看清两个浏览器 profile 的环境灯、账号卡、FAQ 链跑到哪一步，
并且能**真的**触发几个动作。设计依据是 `docs/ops/OPERATOR-CONSOLE-INTERACTION.md`。

两期的边界：

- **读**（一期）：所有状态从磁盘上的既有文件读，页面自己不算进度、不判登录态。
- **动作**（二期）：只接 FAQ 链的三个动作，且判据在服务端（见下文「动作」）。

## 怎么起

```bash
node runtime/operator-console/server.mjs
# → http://127.0.0.1:19024
```

端口不是这里写死的，取自 `runtime/browser-ports.mjs` 的 `PROJECT_PORTS.operatorConsole`。
要临时换端口用 `OPERATOR_CONSOLE_PORT=19025`；给一个非法值会直接报错，不会静默回落（坑 35）。
服务会**自报实际监听的端口**（`/api/health` 的 `console.port`），登记表里的默认值另列在 `registryPort`。

## 读接口

`GET /api/health`、`GET /api/env`（两个 profile 的端口与配置真探）、`GET /api/accounts`、`GET /api/runs`。

**读接口只收 GET/HEAD**，`POST` 打过来是 405 并告诉你动作该走哪里。
页面渲染五块：今天 / 账号体检 / 启动 / 进度 / 需要你做的事，取不到就显示灰块，
并且**必须**带 `reasonCode` 和「读的是哪个文件」——一个没有理由的灰块等于没有信息。

## 动作（二期）

`POST /api/actions/<动作名>`，`Content-Type: application/json`，body 只允许带周期与 `confirm`。

| 动作 | 会改数据 | 要确认 | 实际执行的东西 |
| --- | --- | --- | --- |
| `preview-faq` | 否 | 否 | `run-flow-orchestrator.mjs --flow faq --dry-run`（只读干跑，状态探测带 `--no-persist`） |
| `refresh-faq-status` | 是（只重写状态收据） | 否 | `run-faq-operator.mjs --status`（刷新运营台看到的「上次检查」） |
| `advance-faq` | 是 | **是** | `run-faq-operator.mjs --advance`（**只推一格**，推完重读状态） |

四条边界，都写死在服务端：

1. **能不能推由调度器说了算**：服务端调用 `run-flow-orchestrator.mjs` 的 `decideFaqStep`，
   不在控制台里抄第二份「哪些阶段安全」的名单（第二份名单就是第二份真相）。后果是：
   浏览器采集（`COLLECT_EVIDENCE`）与人工核验一律拒；**飞书发布一律拒**——发布必须在命令行
   用 `--authorize-publish` 显式授权。拒的时候返回 409 + `reasonCode` + 一句人话。
2. **推进前先探一次真实收据**：判据来自磁盘，不是请求里说的「我现在在第几步」。
   探针带 `--no-persist` —— 只读探测不许改运营可见状态。
3. **一次一个**：动作会改收据，两个并发推进会互相抢同一个目录，所以服务端全局串行（并发请求 409 `ACTION_BUSY`）。
4. **每个动作落审计流水**：`<runtimeRoot>/operator-console/actions.jsonl`，一行一个动作，
   含参数、结果、退出码、用时。动作有副作用却不留收据，是这个项目最不能接受的一种失败。

再加两条保护：请求体上限 8KB（无上限等于开一个免费 OOM 入口）、
子进程用 `spawn(参数数组)` 起（**永不** `shell: true`），脚本路径与 `cwd` 固定用**代码根**，
只有数据根（`runtimeRoot`）可注入——代码根被换掉就找不到脚本了（这个坑真踩过）。

超过 `timeoutMs` 时服务端**只停止等待、不杀子进程**：阶段是「跑到一半会写收据」的，
中途 kill 比晚一点更糟。报文会如实说 `timedOut: true`。

## 页面上的每盏灯都指着一个文件

| 界面元素 | 真相源 |
| --- | --- |
| 分组（甲/乙两列）、端口、profile、路线 | `runtime/browser-ports.mjs`（`PROJECT_PORTS` / `BROWSER_PROFILES` / `BROWSER_LABELS` / `ROUTES`） |
| 进度与阶段清单 | `runtime/faq-analysis/<周期>/operator-status.json`，回落 `evidence/faq-operator-status-<周期>.json` |
| 阶段的判定与顺序 | `runtime/faq-operator-core.mjs`（`determineFaqOperatorState` / `describeFaqStages`）—— 页面不重算顺序 |
| 账号灯 | **暂时没有真相源**：是示例数据，页面上显式标注「示例」 |
| 动作结果 | 动作执行后**重读**上面这些文件，页面不手改状态 |

## 明确没接的东西（页面上也会写出来）

| 缺口 | 页面上的表现 |
| --- | --- |
| 排期器没有生产调用方 | ① 今天：灰块 + `SCHEDULER_NOT_WIRED` |
| 队列探针没有生产调用方 | ③ 启动：灰块 + `QUEUE_PROBE_NOT_WIRED`（「预览/推进」能点，但「今天有没有活」还判不出来） |
| 账号体检只覆盖小旺神/竞品链，且没有「按 profile 探登录态」的探针 | ② 账号体检：横幅声明「示例数据」+ 每张卡 `sample=true` + **一个可点按钮都不给** |
| `AUTH_EXPIRING` / `RISK_BLOCKED` 只在词表里 | ② 页面上单独列出「词表里有、体检还没产出」的状态 |
| 除 FAQ 外没有阶段清单 | ④ 进度：灰块 + `NO_STAGE_LIST_FOR_OTHER_CHAINS`，不给别的链编进度条 |
| 登录后自动续跑 | 未实现，在验收的 `notCovered` 里 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | HTTP 服务。静态文件走固定白名单（不拼接请求路径）；只绑回环；读/动作方法分工 |
| `actions.mjs` | 动作白名单与执行。判据、超时、串行锁、审计流水都在这里 |
| `state.mjs` | 数据加工层：只做「读文件 + 摊平」，不产生新状态 |
| `index.html` / `styles.css` / `app.js` | 页面。只用 `textContent` 渲染数据，不用 `innerHTML` |
| `state.test.mjs` / `server.test.mjs` | 单测（离线，已纳入 `runtime` 套件） |
| `acceptance.mjs` | 真机验收：起真 Chrome 渲染 + 截图，验「取不到就灰」分支与动作契约 |

## 验收

```bash
node runtime/operator-console/server.mjs     # 另开一个终端
node runtime/operator-console/acceptance.mjs --base http://127.0.0.1:19024 \
  --out evidence/operator-console-2026-09-16
```

验收会自己再起一个**进程内**实例（临时 `runtimeRoot`）来验灰灯分支与动作契约 ——
只替换 `runtimeRoot` 是不够的，`evidence/` 里的历史快照会把那块填成绿的；
而 `repoRoot` **不能**跟着换，代码根被换掉就找不到脚本了（这是两个根，别混）。
脚本不启停你已经在跑的那个服务，也绝不对生产实例发动作。
