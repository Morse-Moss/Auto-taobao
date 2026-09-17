# 日报模块单独部署到客户电脑：可行性评估与迁移方案

评估日期：2026-09-17 ｜ 范围：**只评估日报链**（`skills/sycm-alimama-daily-report/`），单机、单店铺
｜ 上游文档：交付形态见 [`CLIENT-DESKTOP-DELIVERY-PLAN.md`](CLIENT-DESKTOP-DELIVERY-PLAN.md)，运行内核见 [`UNATTENDED-AGENT-RUNTIME-PLAN.md`](UNATTENDED-AGENT-RUNTIME-PLAN.md)（本文件只处理「日报链能不能单独搬走」，不重复那两份的整体结论）

## 0. 结论

**不能直接交付给不懂技术的人独立使用；但「工程师在场迁过去跑通」今天就能做。**

三条判断：

1. **差的不是功能，是形态。** 功能已经闭环（09-16 全链真跑十步全绿），缺的是打包、常驻、登录体检、通知出口、界面。
   现在跑一天日报要照着 SOP §10.1 打 **十条步骤（八条命令）**，前面还有 §10.0 的 **八项人工确认**（读 `/health`、看 `/targets`、看钟点、开三个页面）。
2. **日报链比整包交付简单一大截，这是本次评估最重要的好消息。**
   它**不需要买家浏览器、不需要小旺神插件**（那条只属于竞品链）——`runtime/browser-ports.mjs:179-186` 的 `dailyReport` 路线只挂 `sycm.taobao.com / one.alimama.com / feishu.cn` 三个站。
   所以「两个 profile 不能合并」这条最大的环境约束，在只交付日报时**不适用**：一台机器、一个商家浏览器就够了。
3. **耦合面比看上去大：这个模块不是自包含的。**
   skill 里的脚本用相对路径往仓库上跳，`REPO_ROOT` 由 `run-daily-report.mjs:16` 推出（`SCRIPT_DIR/../../..`），
   还动态 import 了**另一个 skill** 的文件（`run-daily-report.mjs:284`、`run-inquiry-backfill.mjs:123-124` 取 `skills/xws-to-feishu-base/scripts/feishu-client.mjs`）。
   ⇒ 只拷 `skills/sycm-alimama-daily-report` 一定跑不起来，**必须整仓带走**。

## 1. 现状证据（依赖 / 配置 / 存储 / 耦合）

### 1.1 运行依赖（客户机上要有，且都不在交付包里）

| 项 | 现状 | 证据 |
| --- | --- | --- |
| Node | 代理用**原生 WebSocket** ⇒ 需要 **Node 22+**；而 `package.json` 写的是 `>=18`（两处口径不一致，迁移时统一按 22） | `runtime/isolated-proxy/cdp-proxy.mjs:4`、`package.json:5-7` |
| Python 3 + openpyxl | 源文件解析是 Python：`run-daily-report.mjs:105` 用 `py -3` 调 `extract-sources.py`，后者 `import openpyxl` | `run-daily-report.mjs:105-109`、`scripts/extract-sources.py:10` |
| npm 包 | 只要 `pg`，且**只在配了审计库时才需要**（动态 import）；不配库则完全不需要 | `runtime/daily-report-audit.mjs:128` |
| 浏览器 | Edge，可执行文件路径**写死为 x86 路径** | `runtime/start-project-browser.mjs:40` |
| 账号 | 生意参谋 / 阿里妈妈 / 飞书三处登录态，**必须在那个浏览器里人工扫码** | `skills/.../SKILL.md:15,18` |
| 网络 | `sycm.taobao.com`、`one.alimama.com`、`kcne618basvj.feishu.cn` | `runtime/feishu-targets.mjs:35` |
| 不需要 | 小旺神插件、买家浏览器、PostgreSQL（审计可缺省）、Python 里的 Pillow/python-docx | 日报链 routes 只列三个站；`daily-report-audit.mjs:114-118` 写失败不抛错 |

### 1.2 仓库外前置（客户机上一个都不存在）

| 前置 | 位置 | 能否用环境变量改 |
| --- | --- | --- |
| 飞书自建应用凭据 | `E:/小红书/.env.feishu-kcne.local` | **不能**。日报链只支持 `SYCM_FEISHU_PROFILE` 在两个写死的 profile 间切换，**没有**「换凭据文件路径」的开关（`runtime/feishu-targets.mjs:17-70,172-181`） |
| 审计库连接串 | `E:/小红书/.env.local` | 能（`XWS_DATABASE_URL` / `PG_URL` / `DATABASE_URL`），但取不到就静默跳过 |
| 浏览器 profile | `D:/Retire/edge-daily-report-profile` | 能（`PROJECT_BROWSER_PROFILE`），但默认值写死在登记表 |
| 已登录的 Edge 会话 | 人工成果 | — |

### 1.3 配置面：哪些能配、哪些必须改代码

| 配置 | 现状 | 迁移时的动作 |
| --- | --- | --- |
| 端口 / browser id / label | 登记表唯一来源 + env 覆盖（`PROJECT_BROWSER_PORT` / `CDP_PROXY_PORT` / `CDP_BROWSER_PORT`） | 一般不用改 |
| profile 目录 | 登记表默认值 + `PROJECT_BROWSER_PROFILE` | 客户机没有 D 盘则要改 |
| **飞书 base / 表 id** | 写死在 `runtime/feishu-targets.mjs:48-53`（`dailyReport` 块） | **换客户必须改代码**（或加一个 profile） |
| **飞书凭据文件路径** | 写死在 profile 里 | **必须改代码** |
| 店铺名 | 从 xlsx 数据里读出来（`checks.shopName`），回填用 `--source-shop/--shop` 参数 | 不用改代码，但要让运营知道填什么 |
| 日期 | `--date`；模式按「是否等于站点昨日」推导 | 不用改 |
| Python 解释器 | `SYCM_PYTHON` | 客户机上 `py` 不一定是 3.x 时要设 |

### 1.4 数据存储与权威

- **权威在飞书**（客户 base 的底单/询单表）。重复检测、验收回读都问飞书；本地不存业务状态。
- 本地只落**证据**：`evidence/daily-report-<日期>[-rerunN]/`（在安装目录内，`run-daily-report.mjs:62`）+ 源文件在 Windows 下载目录。
- 审计表 `daily_report_push_audit` 是**只追加的旁证、不是台账**，且**写失败不影响主流程**。
- **幂等键是「目标日 + 店铺」，由飞书那一行回答**（同日重复 = 硬停止）。
  ⇒ 这对无人值守是加分项：不需要本地状态文件，也不存在「本地说跑过了、飞书里没有」的漂移。

### 1.5 交互形态现状

- 唯一入口是命令行，且**下一步要吃上一步打出来的绝对路径**（`--shop-xlsx` / `--promotion-zip`）。
- **没有一条命令跑完全链**，没有编排器；中间的等待（导出任务生成最长 10 分钟）靠人按顺序插别的步骤填。
- **没有界面**：运营台已登记日报链但明确标为不可用，理由是「还没有 operator CLI，也完全没有登录态判定（G2）」
  （`runtime/operator-console/state.mjs:455-457`）。
- **零登录态判定**：整个日报链的登录失效只会表现为采集步骤报错（如 `expected one SYCM shop-performance page, got 0`），
  不会说「登录过期了」。`run-inquiry-backfill.mjs:97` 有一行注释承认了这个缺口。
- **没有通知出口**：只有可插拔通道骨架（`notifyOperator`），没有内置发送实现。

## 2. 五维度评估（含可复用的现有骨架）

| 维度 | 现状 | 可复用的骨架 | 判定 |
| --- | --- | --- | --- |
| 1 外部前置 | Node 22 / Python+openpyxl / Edge / 三个站点登录 / 仓库外凭据 | 端口与 profile 已集中登记（`browser-ports.mjs`） | **缺**：依赖未随包、凭据路径写死 |
| 2 交互形态 | 八条命令 + 八项人工确认 + 参数要吃上一步的输出 | `--locate-only` 排练、`plan.json` 自检、回执 | **缺**：工程术语与参数面 |
| 3 凭据与登录 | 人工扫码；**链内零检测、零引导、零续跑** | `xws-sku-auth-preflight.mjs` 的检测模式、`reopen_login_window` 动作、`LOGIN-STATE-MANAGEMENT.md` | **最缺**：这是客户环境最高频故障 |
| 4 通知 | 无发送实现 | `notifyOperator` 通道 + 去重/恢复已实现 | **缺**：没有任何出口 |
| 5 自愈分档 | 档 1 部分具备（页面被带走会自动回位、取件被浮层挡住会重试、任务未「生成成功」会具名停）；档 2 / 档 3 空白 | 回位与重试刚在 2026-09-17 落地；`diagnose.mjs` 7 类签名 + `actions.mjs` 白名单 | **档 1 部分可用，档 2/3 缺** |

## 3. 要补齐的清单（P0 = 不补不能交付，P1 = 决定客户能否独立用下去）

| 优先级 | 补齐项 | 做什么 | 复用 | 主要风险 |
| --- | --- | --- | --- | --- |
| **P0-1** | 配置外置 | 把「凭据文件路径 / base+表 id / profile 目录 / Edge 路径」收进**一份客户配置**（JSON 或 env），去掉改代码；`SYCM_FEISHU_PROFILE` 之外增加 `FEISHU_ENV_FILE` 一类开关 | 现有登记表 `browser-ports.mjs` 的形状 | 配置漂移＝跑到别的租户/别的店（本项目坑 35 的形态） |
| **P0-2** | 一条命令跑完全链 | `run-daily-report-chain.mjs --date <日>`：体检 → 两站点落位 → 提交导出 → 店铺报表 → 取件 → 干跑 → commit → 回填 → 回读，每步打印预期值与判据 | SOP §10.1 的十条步骤本身就是规格；`--locate-only`、`plan.json`、回执 | 中间那段最长 10 分钟的等待要轮询任务状态，别用死等 |
| **P0-3** | 登录体检 | 三个站点各一组登录标记（**按浏览器分组**），输出 `AUTH_READY / AUTH_REQUIRED / AUTH_UNKNOWN`；放在链的最前面 | `xws-sku-auth-preflight.mjs` 的 CDP 检测模式 | 判据要实测采集并随平台改版维护；`AUTH_UNKNOWN` 不许当成已登录 |
| **P0-4** | 常驻与定时 | 浏览器 + 代理开机常驻（现在靠父进程 `setInterval` 保活，父进程一退就全回收）；任务计划程序每天定点触发；**排在下午**（推广数据上午有未回补窗口，早跑写下的低值同日不可修） | `start-daily-report-browser.mjs` / `start-daily-report-proxy.mjs` | 「该不该跑」交给飞书的同日重复硬停兜底：它会拒绝，但不安静 |
| **P0-5** | 通知出口 | 三级模板（要人动手 / 仅知会 / 无法自愈）+ 去重 + 恢复通知，主用应用消息、群机器人兜底 | `notifyOperator` 通道、已有 dedup | 需要提前申请应用消息权限 |
| **P0-6** | 一键诊断包 | 版本 + 最近回执 + 关键日志 + 出错页截图，一键导出并发送；**必须脱敏**（不含凭据/Cookie/token） | `evidence/` 与回执体系就是最小充分证据 | 脱敏要显式过滤，不能靠「应该没有」 |
| **P1-1** | 界面（本地控制台） | 状态卡 / 一键开始 / 账号体检三盏灯 / 修复与求助；**只读运行时状态** | 运营台 `runtime/operator-console/` 已有骨架与字段规格 | 界面不得成为第二份状态真相 |
| **P1-2** | 自助重登 | 灯红 → 开可见窗口到登录页 → 用户扫码 → 检测到就绪 → 自动续跑 | `reopen_login_window` 动作 | 只扫码、不代填账密 |
| **P1-3** | 人话指引 | 每类故障 1–3 步图文；禁止出现 recordId / generation / dry-run 这类词 | 回执里的 `reasonCode` | 文案要运营看得懂 |
| **P2-1** | 源文件解析去 Python | 把 `extract-sources.py`（119 列 xlsx + zip 里的 GBK CSV）改成 Node 实现，客户机就少一个运行时 | 现有 Python 版就是规格与测试基准 | 换实现要有逐字节对比 |
| **P2-2** | 自动更新与回滚 | 客户端能力热更新（页面改版时唯一出路） | manifest/registry | 更新本身要有回滚路径 |

**依赖顺序**：P0-1 是地基（其它项都要读同一份配置）；P0-2 与 P0-3 可以并行；P0-4 依赖 P0-1；P0-6 依赖 P0-5；P1-1 依赖 P0-4（服务化之后界面才有东西显示）。

## 4. 迁移操作步骤

### 4.1 变体 A：工程师在场，今天就能跑通（不承诺客户自助）

每步都写了验收判据，任一条不成立就停在那一步，别往下走。

1. **量客户机的地基**（5 分钟）
   - `node -v` ⇒ 需 22+；`py -3 -c "import openpyxl; print(openpyxl.__version__)"` ⇒ 需成功；
   - 找 Edge 真实路径（x64 常在 `C:\Program Files\Microsoft\Edge\Application\msedge.exe`，不是脚本里写死的 x86 路径）；
   - 确认盘符与空闲端口：19022、19023 没被别的软件占。
2. **整仓落地**：把 `sycm-automation` 整个目录复制到客户机（例如 `D:\sycm-automation`），在根目录执行 `npm install`。
   **不要只拷 `skills/sycm-alimama-daily-report`** —— 它相对 `../../../runtime` 与 `../../xws-to-feishu-base` 找依赖（`run-daily-report.mjs:16,284`）。
3. **落凭据**：在客户机建目录（如 `E:\小红书\`）并放 `.env.feishu-kcne.local`，内含 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；
   或改 `runtime/feishu-targets.mjs` 的 `envFile` 指向实际路径。验收：`node -e "import('./runtime/feishu-targets.mjs').then(m=>console.log(m.loadFeishuCredentials('kcne').appId.slice(0,6)))"` 能打出前 6 位。
4. **登记飞书目标**：`runtime/feishu-targets.mjs` 的 `dailyReport.{baseToken, sourceTable, sourceView, inquiryTable}` 改成客户实际的 base/表。
   验收：读回来的四个 id 与飞书地址栏里的逐字符一致。若沿用同一个 base 则跳过。
5. **对齐端口与 profile**：客户机没有 D 盘时改 `runtime/browser-ports.mjs:83-84` 的 `dailyReport` profile 路径。
6. **起浏览器（常驻）**：`PROJECT_BROWSER_EXE=<客户机 msedge 路径> node runtime/start-daily-report-browser.mjs`。
   验收：打印 `READY ... on 19022`；**这一步的进程要一直活着**（父进程退出会把浏览器一起带走）。
7. **起代理（常驻）**：`node runtime/start-daily-report-proxy.mjs`。验收：`GET http://127.0.0.1:19023/health` 返回 `connected:true`、`browser.id=edge-daily-report`。
8. **人工登录三个站点（一次性）**：在那个浏览器窗口里分别扫码登录生意参谋、阿里妈妈、飞书，**必须是商家号**。
   验收：两个站点正文能读到自己的店铺名、页面里没有密码框；飞书能打开那个 base。
9. **摆好三个工作页（各恰好一个）**：阿里妈妈停在 `#!/report/download-list`、生意参谋停在 `qos/service/frame/shop/performance/new#/shop`、飞书停在底单 `?table=<底单>&view=<视图>`。
   验收：`GET /targets` 恰好三页、URL 片段各一。**页面会被动消失**（实测过），所以每次开跑前都要重查。
10. **干跑一遍（零写入）**：两站点落位 → 店铺报表 → 提交导出任务 → 取件 → `run-daily-report`（不加 `--commit`）。
    验收：`plan.json` 的 `checks` 十一项齐全、`sourceSelfChecks.allMatchDate:true`、`recordCount` 与底单当前行数一致。
    若报 `duplicate daily report row exists` ⇒ 那天已经推过，**停手**（不是故障）。
11. **真写入**：`--commit` → 询单回填 `--commit` → 独立回读。
    验收：底单 +1 行且能按新 `recordId` 读回、`verifiedFields` 243、两个询单字段就位、`unchangedOtherFields:true`、两张截图。
12. **定时（可选）**：任务计划程序每天 **15:00 之后**触发一个批处理，串起第 10–11 步。
    注意：目前没有幂等键守护的编排层，重复触发靠飞书的「同日重复硬停」兜 —— 它会**明确报错退出**，不会安静跳过。

### 4.2 变体 B：要做到「客户自己用」

在变体 A 跑通的基础上，按 §3 的 P0 顺序补齐：**P0-1 配置外置 → P0-2 一条命令 → P0-3 登录体检 → P0-4 常驻定时 → P0-5 通知 → P0-6 诊断包 → P1-1 界面**，最后才谈「不懂技术的人能独立操作」。
变体 A 的每一步验收判据，正好是变体 B 里那条命令应该自己做的断言 —— 别重写，逐条搬进编排器。

## 5. 风险与注意事项

1. **登错账号是静默失败，不是报错。** 日报链要商家号；如果 profile 里登的是买家号，页面能开、导出能成功、数据却属于另一个人。交付时必须当面交代，并在体检里断言「读到的店铺名 == 配置里的店铺名」。
2. **定时必须排在下午。** 阿里妈妈推广块上午有未回补窗口（实测同一目标日 11:22 导出 `自然流量曝光量=0`、14:41 才变 860），
   而底单查重键是「同一天＋同店铺」⇒ 早跑写下的低值**同一天修不了**，只能人工删那天再重跑。这条直接决定 P0-4 的排期时刻。
3. **Edge 路径写死为 x86。** `start-project-browser.mjs:40` 的默认值是 `C:/Program Files (x86)/...`；64 位机器要用 `PROJECT_BROWSER_EXE` 覆盖，否则浏览器起不来。
4. **父进程一退，浏览器与代理一起被回收。** 启动器靠 `setInterval` 保活（`start-project-browser.mjs:77-80,190`），现在这份「常驻」是给工程师会话用的，不是给客户机用的；做成计划任务/托盘之前，客户机重启即全线不可用。
5. **飞书写权限要先验。** 应用必须被加为该 base 的**可编辑协作者**，否则写入是 `403 / 91403`（实测过，有专门的网页粘贴兜底路径）。迁移到客户 self 的 base 时，这条一定要在开跑前用一次幂等写探针复验。
6. **凭据路径与 base/表 id 现在只能改代码。** 这是本次评估里最"不像交付物"的一点：换一台机器就要改两处源码。P0-1 不补，每次迁移都得工程师动手。
7. **Python + openpyxl 缺失的失败点很靠后。** 解析发生在第 6 步（干跑），前面采集都成功了才炸；体检里要前置检查解释器与 openpyxl。
8. **审计库可有可无，但别让客户以为是故障。** 客户机不配数据库时会打印「未写入（不影响本次结论）」——这是设计（`daily-report-audit.mjs:112-118`），要写进交付说明。
9. **证据目录写在安装目录里。** `evidence/daily-report-<日期>…` 每个目标日一代，跑一年会积累不少；要有归档/清理策略，且升级时要能保留（代次规则见 SOP §6.3）。
10. **页面改版与风控不可自愈。** 任何客户端都修不了自己的选择器；只能「报障 → 服务商更新适配器 → 热更新」。**不要对客户承诺「以后不用找你们」。**
11. **单机单店铺的并发。** 定时触发与人工点「现在跑一次」可能撞车。日报链没有 lane 闸门，靠的是飞书同日重复硬停 —— 那是「会报错的护栏」，不是「安静排队」，界面上要么禁用并发、要么把这次拒绝显示成人话。
12. **时间与日期。** 目标日按 `Asia/Shanghai` 推导（`date-picker.mjs:23,35-55`）；客户机系统时间不对会导致落位到错的一天。体检里顺手校验系统时间与站点时间差。
13. **客户机的企业策略/杀毒**可能拦远程调试端口或写 profile 目录 —— 这类环境类问题属于「可以自助修」的那一档，但要有明确指引。

## 6. 建议实施顺序

1. **今天**：按 §4.1 变体 A 在客户机上跑通一遍（工程师在场）。这一步能把所有环境类风险一次暴露完。
2. **紧接着**：P0-1 配置外置 + P0-2 一条命令 —— 这两项做完，迁移本身就不再需要工程师。
3. **然后**：P0-3 登录体检 + P0-5 通知。客户最高频的故障（登录失效）从此能自己恢复、且系统会主动叫人。
4. **再做**：P0-4 常驻定时 + P0-6 诊断包 + P1-1 界面。
5. **最后**：P2（去 Python、自动更新）。
