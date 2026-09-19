# 系统总览与部署方案

编制日期：2026-09-17 ｜ 范围：**整个仓库**（10 个 Skill ＋ runtime ＋ db ＋ scripts ＋ docs），不是单条链
｜ 读者：项目所有者、接手同事、部署执行人
｜ 性质：**总览 + 部署方案**。它不新增架构决策，把已有证据按「架构 / 依赖 / 环境 / 风险 / 怎么装到别的机器」重新组织。

上游权威（本文只做汇总与部署推导，不覆盖它们）：

| 想知道的 | 看哪份 |
| --- | --- |
| 目标架构、分层、11 条架构验收、9 项待决策 | [`docs/architecture/README.md`](../architecture/README.md) |
| 工程治理、文档权威矩阵、证据链不变量、门禁 | [`docs/standards/README.md`](../standards/README.md) |
| 生产准入（四条阻塞线、验收逐条实测状态） | [`docs/architecture/PRODUCTION-READINESS.md`](../architecture/PRODUCTION-READINESS.md) |
| 技术债分类与分阶段治理 | [`PROJECT-TECH-DEBT-GOVERNANCE-PLAN.md`](../../PROJECT-TECH-DEBT-GOVERNANCE-PLAN.md) |
| 客户自助交付的形态改造 | [`CLIENT-DESKTOP-DELIVERY-PLAN.md`](CLIENT-DESKTOP-DELIVERY-PLAN.md) |
| 无人值守运行内核 | [`UNATTENDED-AGENT-RUNTIME-PLAN.md`](UNATTENDED-AGENT-RUNTIME-PLAN.md) |
| 端口与两个浏览器 | [`PROJECT-BROWSER-AND-PORTS.md`](PROJECT-BROWSER-AND-PORTS.md) |
| 登录态四层检查 | [`LOGIN-STATE-MANAGEMENT.md`](LOGIN-STATE-MANAGEMENT.md) |
| 登录失效后怎么恢复（三条路线逐条落地分析） | [`LOGIN-RECOVERY-OPTIONS.md`](LOGIN-RECOVERY-OPTIONS.md) |
| 只交付日报链 | [`DAILY-REPORT-STANDALONE-DEPLOYMENT.md`](DAILY-REPORT-STANDALONE-DEPLOYMENT.md) |
| 执行期的踩坑与纪律 | [`LESSONS-2026-09-14_15.md`](LESSONS-2026-09-14_15.md)（动状态机/发布路径/采集口径前必读） |

## 0. 结论速览

1. **系统能跑，而且多数能力有真实回执。** 竞品周更、FAQ 周更、关键词周更、日报四条链都在真实浏览器 + 真实飞书上跑通过。但这是**受控内用**档（单机、单租户、人工在环），不是生产级无人值守档。
2. **它不是「一个软件」，是「一台已经调好的机器 ＋ 一套必须照着走的 SOP」。** 部署的难点不在安装，在**环境前提**：两个互斥的浏览器身份、一个仓库外的凭据文件、三个站点的登录态、一个固定端口的调试代理。这些东西一个不对，失败形态都是**静默**的（点击成功、导出成功，数据是错的）。
3. **换机器要改代码的地方还剩两处**（飞书凭据路径、base/表 id 在 `runtime/feishu-targets.mjs` 里写死），其余配置都能用环境变量覆盖。
4. **仓库的耦合结构与文档宣称的分层不一致**：`skills/` 与 `runtime/` 是**双向依赖**，实测 `skills` 下有 20 余个生产文件反向 import `../../../runtime/`。所以「只拷一个目录」在任何一条链上都不成立，**必须整仓带走**。
5. **部署有三条路，成本差一个数量级**：A 工程师旁站（今天可做，不改代码）；B 单机客户自助（需补 P0 六项）；C 服务器侧无人值守（需先做 Browser Broker，当前明确列为非目标）。

## 1. 系统定位

一句话：**用本机已登录的真实浏览器，把商家后台（生意参谋/阿里妈妈）、第三方数据源（小旺神/灰豚）的数据取下来，经确定性验证后写入飞书，供运营使用。**

它不是 Agent 聊天系统，也不是自由演化的 swarm。明确非目标（[`docs/architecture/README.md`](../architecture/README.md) §2）：长期无人值守、十几家店铺并发、永久登录态、绕过登录/验证码/风控、由 Agent 直接写数据库或飞书。

运营者画像：传统电商运营，此前手工收集数据。所以系统的正确交互形态是「体检 + 一键」，不是「配置 + 参数」。

## 2. 架构组成

### 2.1 目标分层 vs 当前实现

目标架构有六层（[`docs/architecture/README.md`](../architecture/README.md) §4）。逐层对照当前仓库：

| 层 | 目标职责 | 当前实现 | 状态 |
| --- | --- | --- | --- |
| 控制平面 | 租户/店铺/账号/能力/权限/配额/人工任务 | 无。由配置与脚本约定承担 | **未实现**（已列为非目标） |
| 唯一 Durable Workflow 层 | 运行历史、定时器、暂停恢复、取消、重试、人工闸门 | `runtime/sop-runtime/` 承担（PostgreSQL 为状态权威） | **已落地**（Temporal 仍是 POC，未落依赖） |
| Browser Broker | profile/账号/CDP session/tab/lease 生命周期 | 无。租约与互斥由 lane 闸门近似；**没有** profile 生命周期的所有权登记与孤儿清理 | **未实现** |
| Adapter / Worker | 各平台交互封装 | 10 个 Skill 的 `scripts/` | **已实现**（但依赖方向未理顺，见 §3.1） |
| Agent Runtime | 概率性/语义性工作，只出 proposal | `runtime/supervisor-agent/`（含 `diagnose.mjs` 7 类签名 + `actions.mjs` 白名单）、`runtime/faq-ai-review.mjs` | **部分实现**，三块全部**不接生产** |
| 人工层 | 人工闸门是一等状态 | `HUMAN_REQUIRED` / `PAUSED` / `blocker` 分类 | **已落地** |

「已经实现」与「已经生产可用」是两件事。`PRODUCTION-READINESS.md` 的四条阻塞线仍然成立，其中两条是范围性的（真实环境验证未闭环、平台范围项未实现）。

### 2.2 四条业务链

判断一条链属于谁，判据不是「哪个 skill 顺手」，而是**目标站点要哪种账号**（权威表在 `runtime/browser-ports.mjs` 的 `ROUTES`，可读摘要见 `PROJECT-BROWSER-AND-PORTS.md` §1.3）。

| 链 | 入口 | 浏览器 | 账号 | 周期 | 真实回执 |
| --- | --- | --- | --- | --- | --- |
| 竞品（小旺神市场分析 / SKU / FAQ / 词库） | `xws-export-market-analysis/scripts/run-adaptive-export.mjs`、`xws-sku-collection`、`xws-faq-operator/scripts/run-faq-operator.mjs` | 甲 = 买家 9222 + 3457 | 买家 ＋ 小旺神插件 | 周 | XWS 长跑在 20/40 页 `STALLED` 被安全阻断（**这条是设计成功的证据，不是故障**）；FAQ 七阶段有收据 |
| 关键词·搜索排行 | `sycm-export-search-rank/scripts/export-search-rank.mjs` | 乙 = 商家 19022 + 19023 | 商家 | 周 | 从未被真实浏览器驱动 |
| 关键词·灰豚话题热度 | `huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs` | 乙 | 独立（灰豚自己的账号） | 周 | **发布段从未对真实目标 `--commit`** |
| 日报（生意参谋 ＋ 万阿里妈妈 ＋ 飞书） | `sycm-alimama-daily-report/scripts/run-daily-report.mjs` | 乙 | 商家 | 日 | **09-16 全链真跑十步全绿**（底单 6→7 行、`verifiedFields:243`、询单回填 13/39、独立回读通过） |

`competitorImport`（小旺神导出 → 飞书 API）**不需要浏览器**，走纯接口。`weeklyPaste`（周表 → 飞书网页）与 `sellerWorkbench`（千牛，预留无调用方）也挂在乙上。

### 2.3 模块清单

**10 个 Skill**（`skills/<name>/`，每个含 `SKILL.md` 合同 ＋ `scripts/` ＋ 局部测试）：

`huitun-to-feishu-keyword-heat`、`sycm-alimama-daily-report`、`sycm-export-search-rank`、`sycm-to-feishu-base`、`xws-export-market-analysis`、`xws-faq-operator`、`xws-faq-raw-collection`、`xws-question-library-collection`、`xws-sku-collection`、`xws-to-feishu-base`

**runtime**（253 个 git 跟踪的顶层条目，`runtime/INDEX.md` 按生命周期分七类：长期编排 / 可复用核心库 / 一次性迁移修复 / 只读诊断 / 已退役 / 报告生成 / 合同文档）。其中值得单独点名的：

| 模块 | 作用 |
| --- | --- |
| `runtime/browser-ports.mjs` | **端口与浏览器身份的唯一来源**（`PROJECT_PORTS` / `RETIRED_PORTS` / `BROWSER_PROFILES` / `ROUTES` / `SITE_ACCOUNT`）。仓库内不得出现第二份端口字面量，有静态守卫盯着 |
| `runtime/feishu-targets.mjs` | **飞书 base / 表 id / 凭据文件的唯一来源**（profile 制，`SYCM_FEISHU_PROFILE` 切换） |
| `runtime/start-project-browser.mjs` / `start-daily-report-browser.mjs` | 调试 Edge 启动器（含端口归属预探、同 profile 单例检测、`setInterval` 保活） |
| `runtime/isolated-proxy/cdp-proxy.mjs` | CDP 代理（浏览器级单连接；**Node 22+ 原生 WebSocket**） |
| `runtime/sop-runtime/` | 确定性运行底座：Controller 唯一拥有状态、两段式采集/发布、一次性一阶段、人工闸门、stale 回收、排期（`round-schedule.json`） |
| `runtime/operator-console/` | 本地控制台（只监听 127.0.0.1:19024）。**只读 ＋ 只接 FAQ 三个动作**，飞书发布一律拒 |
| `runtime/supervisor-agent/` | 故障诊断与处置白名单（`diagnose.mjs` / `actions.mjs`），**PROTOTYPE** |
| `runtime/daily-report-audit.mjs` | 日报推送审计（写失败不影响主流程，是旁证不是台账） |
| `runtime/notify-feishu.mjs` | 告警投递出口（自建应用消息主通道、群机器人兜底） |

**db**：`db/migrations/001-007` ＋ 每份配 `rollback` ＋ `db/backups/` 三份变更前备份。PostgreSQL 承担业务事实、verified cursor、租约、幂等提交账本。

**scripts**：`run-test-suite.mjs`（目录发现的套件运行器）、`run-offline-self-tests.mjs`、`test-suite-discovery.mjs`。

### 2.4 知识资产的分布（接手成本的主要来源）

`runtime/` 里躺着 **14 个 git 跟踪的合同/决策文档**（`huitun-candidate-contract.md`、`keyword-field-contract-20260809.md`、`sku-weekly-storage-decision-20260825.md` 等），而 `docs/standards/README.md` §3 把 `runtime/` 定位为「运行入口、阶段指针和单次运行状态；**不是架构事实源**」。

这是矛盾，不是遗漏：`runtime/` 从「临时运行目录」被无声升级成了「业务合同仓库」，没人回头更新它的定义。后果是**知识分布问题**——接手者按文档去找合同找不到，按标准去信 `runtime/` 又被告知它不算权威。技术债 A2，评级「可维护性极高」。

## 3. 依赖关系

### 3.1 依赖方向：`skills/` ↔ `runtime/` 双向（实测，且比文档记载的更大）

目标终态是单向：`ops → lib ← skills`，禁止 `skills → ops`。**当前不是。**

实测 `skills/` 下 import `../../../runtime/` 的文件（只列生产文件，不含测试）：

| Skill | 反向依赖的文件 |
| --- | --- |
| `sycm-alimama-daily-report` | `run-daily-report.mjs`、`run-inquiry-backfill.mjs`、`readback-daily-report.mjs`、`collect-shop-report.mjs`、`collect-promotion-report.mjs`、`date-picker.mjs` |
| `sycm-to-feishu-base` | `run-weekly-pre-ai.mjs`、`run-weekly-post-ai.mjs`、`copy-weekly-table.mjs`、`adapter.feishu-weekly.mjs`、`inspect-feishu-fields.mjs` |
| `xws-export-market-analysis` | `export-market-analysis.mjs`、`flow.mjs`、`segments.mjs` |
| `huitun-to-feishu-keyword-heat` | `flow.mjs` |
| `sycm-export-search-rank` | `export-search-rank.mjs` |

（口径：在 `skills/ ＋ runtime/ ＋ scripts/` 里扫 `.mjs/.cjs/.js`、剥掉整行注释后统计，`skills/` 下命中 **31 个文件**，其中 **16 个非测试**、15 个是测试文件。）

再加上反向的 `runtime/ → skills/`（`apply-xws-sku-manifest.mjs`、`competitor-history-publish-core.mjs` 等约 10 处），形成强耦合环。

两条部署推论：

1. **必须整仓复制。** 单独拷 `skills/sycm-alimama-daily-report` 跑不起来——它的 `REPO_ROOT = SCRIPT_DIR/../../..`（`run-daily-report.mjs:16`），还会动态 import 另一个 skill 的 `feishu-client.mjs`。
2. **改一个函数签名会同时冲击能力和编排两侧。** 部署前不要顺手重构。

另有一处 `PROJECT_ROOT = SCRIPT_DIR/../../..`（`run-daily-report.mjs:16`）——**目录深度本身就是合同**，搬移文件位置会静默改掉仓库根。

### 3.2 端口与浏览器身份（部署最容易出事的一处）

权威在 `runtime/browser-ports.mjs`。三条链、两个浏览器：

```text
甲 competitor  买家号 + 小旺神插件  Edge 9222 + 代理 3457  profile D:/Retire/edge-debug-profile
乙 dailyReport 商家号               Edge 19022 + 代理 19023 profile D:/Retire/edge-daily-report-profile
运营台         本地控制台           127.0.0.1:19024（不是浏览器端口，同一条「只写一次」原则）
退役 9223 / 3458（本项目自己换掉的旧值，留档并纳入守卫扫描）
外来 3456（别的项目的共享代理，挂在用户日常 Edge 上）—— 避开，不借，不抢
```

**为什么不能合并成一个浏览器**：一个 profile 只能是一个淘宝身份，而**卖家版账号用不了小旺神**（商家号看不到别家商品详情页）。反过来把买家号登进乙，生意参谋直接停在登录墙。两边**都不会报错**——点击成功、导航成功、导出成功，只是拿回来的是错账号下的数据。所以这条只能靠「每条链绑定自己的浏览器」保证，不能靠人临场判断。

### 3.3 飞书目标与凭据

`runtime/feishu-targets.mjs` 是唯一来源，**profile 制**：`legacy`（旧租户 rcndesfqro3x）与 `kcne`（新租户 kcne618basvj，`DEFAULT_PROFILE`）。切换用 `SYCM_FEISHU_PROFILE`（接受别名）。

每个 profile 里写死三样东西：`envFile`（凭据文件路径）、`competitorBase` / `keywordBase`、四个稳定表 id。另有 `dailyReport` 块（baseToken / sourceTable / sourceView / inquiryTable）。

**注意**：周一创建的表（竞品周 / SKU周 / 问题库）**不在**这个文件里——它们每周新建，id 天然会过期，按名字在运行时解析（`runtime/weekly-table-target.mjs`）。

### 3.4 运行时依赖

| 依赖 | 版本要求 | 证据 |
| --- | --- | --- |
| Node | **22+**（CDP 代理用原生 WebSocket）。`package.json` 声明的是 `>=18`（两处口径不一致，部署按 22） | `runtime/isolated-proxy/cdp-proxy.mjs:4,40-42`、`package.json:5-7` |
| Python 3 ＋ openpyxl / Pillow / python-docx | `requirements.txt` 锁定 `openpyxl==3.1.5` / `Pillow==11.3.0` / `python-docx==1.2.0`；解释器版本未声明（README 用 `py -3`，实测 CPython 3.12.9） | `requirements.txt` |
| npm 包 | `pg`（仅配了审计库时需要，动态 import）、`docx@^9.7.1`（文档生成）、`@temporalio/*`（POC，未落地依赖） | `package.json` |
| Microsoft Edge | 可执行文件默认路径**写死为 x86**（`C:/Program Files (x86)/...`），64 位机器要用 `PROJECT_BROWSER_EXE` 覆盖 | `runtime/start-project-browser.mjs:40` |

**Python 是 4 个 Skill 的硬依赖**（不是可选的）：`xws-export-market-analysis`（validate/merge）、`xws-to-feishu-base`（xlsx 抽取）、`sycm-export-search-rank`（写 workbook/验收）、`sycm-alimama-daily-report`（源文件解析，`run-daily-report.mjs:105` 用 `py -3` 调）。

**未解决的外部依赖**：`table_geometry` 被 `runtime/build-keyword-decision-brief.py` 与 `build-keyword-decision-report.py` import，**不在仓库内、无发布包** ⇒ 这两个脚本不能从干净 checkout 复现。技术债 C1，未决策归属。

### 3.5 仓库外前置（换机器时一个都不存在）

| 前置 | 开发机位置 | 能否用环境变量改 |
| --- | --- | --- |
| 飞书自建应用凭据 | `E:/小红书/.env.feishu-kcne.local`（日报链）＋ `E:/小红书/.env.local`（数据库、旧租户） | **不能**。只有 `SYCM_FEISHU_PROFILE` 在两个写死的 profile 之间切换，**没有**「换凭据文件路径」的开关 |
| 数据库连接串 | `E:/小红书/.env.local` 的 `XWS_DATABASE_URL` | 能（`XWS_DATABASE_URL` / `PG_URL` / `DATABASE_URL`） |
| 浏览器 profile 目录 | `D:/Retire/edge-debug-profile`、`D:/Retire/edge-daily-report-profile` | 能（`PROJECT_BROWSER_PROFILE`），但登记表默认值写死 |
| 已登录的 Edge 会话 | 人工成果 | — |
| 全局 Skill 目录联接 | `D:\codex\skills\sycm-*` / `xws-*` / `huitun-*` → 本项目 `skills/` | 不适用（**这是项目外的消费者面**，搬移文件前必须确认） |

## 4. 运行环境与部署条件

### 4.1 硬性前置清单（缺一项就装不起来）

| # | 项 | 判据 |
| --- | --- | --- |
| 1 | Node **22+** | `node -v` ≥ v22；低了 `cdp-proxy` 起不来 |
| 2 | Python 3 ＋ 三个包 | `py -3 -c "import openpyxl, PIL, docx"` 不报错 |
| 3 | Microsoft Edge（x64 或 x86） | 路径存在；用 `PROJECT_BROWSER_EXE` 覆盖默认的 x86 路径 |
| 4 | 空闲端口 9222 / 3457 / 19022 / 19023（＋19024 若用运营台） | 无占用，且**不是** 3456（别的项目） |
| 5 | 商家号（生意参谋＋阿里妈妈＋飞书）登录态 | 登在乙 profile 里；能直接打开生意参谋后台 |
| 6 | 买家号 ＋ 小旺神插件（仅竞品链需要） | 登在甲 profile 里；页面里 `document.querySelector('#xws-tblist-box')` 存在 |
| 7 | 飞书自建应用凭据文件 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 能读出来 |
| 8 | 飞书应用是该 base 的**可编辑协作者** | 幂等写探针返回 HTTP 200 / code 0（否则 403 / 91403） |
| 9 | PostgreSQL（用 sop-runtime / 审计时需要） | `xws_automation` 库可达；无 psql 时用 `docker exec`（本机容器 `xws-adaptive-postgres`） |
| 10 | 系统时间正确（`Asia/Shanghai`） | 目标日按 `Asia/Shanghai` 推导，系统时间不对会落位到错的一天 |

### 4.2 配置面：哪些能配、哪些必须改代码

| 配置 | 现状 | 换机器时的动作 |
| --- | --- | --- |
| 端口 / browser id / label | `runtime/browser-ports.mjs` 唯一来源 ＋ env 覆盖 | 一般不用改 |
| profile 目录 | env `PROJECT_BROWSER_PROFILE`（**两个启动器都认**，2026-09-17 实测） | 新机没有 D 盘则**设这个变量**，不必改代码 |
| Edge 可执行文件 | env `PROJECT_BROWSER_EXE` | **x64 机器必设**（默认是 x86 路径） |
| 飞书凭据文件路径 | **已外置**（P0-1, 2026-09-17）：`config/customer.json` 的 `feishu.<profile>.envFile` | **改配置，不改代码** |
| 飞书 base / 表 id | **已外置**（P0-1, 2026-09-17）：同上 `competitorBase` / `keywordBase` / `tables` / `dailyReport` | **改配置，不改代码** |
| 客户配置本身 | `config/customer.json`（**不进版本库**），路径可用 `SYCM_CUSTOMER_CONFIG` 覆盖；模板 `config/customer.example.json`，字段说明 `config/README.md` | 复制模板，改 4 项 |
| 店铺名 | 从 xlsx 读出来（`checks.shopName`），回填靠 `--source-shop` / `--shop` 参数 | 不用改代码，但要知道填什么 |
| Python 解释器 | `SYCM_PYTHON` / `XWS_PYTHON` | 客户机上 `py` 不是 3.x 时要设 |
| 排期（什么时候跑） | `runtime/round-schedule.json`（配置文件，**不是触发器**；宿主只负责叫醒） | 按客户作息改这一份 |
| 运营台端口 | `OPERATOR_CONSOLE_PORT` | 一般不用改 |

### 4.3 数据存储与权威

| 数据 | 权威 | 迁移含义 |
| --- | --- | --- |
| 执行历史、定时器、重试 | Durable Workflow 层（当前是 `sop-runtime` ＋ PostgreSQL） | 新机器要建库并 apply `db/migrations/001-007` |
| 业务事实、verified cursor、租约、幂等提交账本 | PostgreSQL `xws_automation` | 同上 |
| 运营工作台与发布投影 | 飞书 | 换客户＝换 base，见 §4.2 |
| 不可变原始文件/大工件 | **Object Storage 未实现**，当前落本地目录与 `evidence/` | 磁盘规划；`runtime/` 已 3.8G |
| 本地 JSON | **只能是缓存或投影**，不得决定恢复位置或完成状态 | 别把本地文件当台账 |

日报链是特例：**权威在飞书**（底单/询单表），本地不存业务状态；幂等键是「目标日 ＋ 店铺」，由飞书那一行回答（同日重复＝硬停止）。所以它不需要本地状态文件，也不存在「本地说跑过了、飞书里没有」的漂移。

### 4.4 当前基线（2026-09-17 实测，三套分别跑）

| 套件 | 结果 | 文件数 | 备注 |
| --- | --- | --- | --- |
| `node scripts/run-test-suite.mjs runtime --concurrency=1` | **546 通过 / 0 失败** | 73 | 发现规则**非递归** |
| `node scripts/run-test-suite.mjs skills --concurrency=1` | **609 通过 / 0 失败** | 51（实跑；发现 53） | 含约 17 分钟的 `xws-export-market-analysis` prepare-flow |
| `node --test runtime/sop-runtime/*.test.mjs` | **355 通过 / 0 失败** | 26 | **不在上面两套里**，必须单独跑 |

合计 **1510** 条用例全绿。但注意：**这三套的运行时长差一个数量级**——runtime 与 sop-runtime 各几秒，skills 一套 20 分钟（`xws-export-market-analysis` 的 `prepare-flow` 一个文件就占了大头，它拉起真实 CLI 子进程并有 retry backoff）。所以「快速回归」与「完整回归」是两件事，交付时不要在客户机上默认跑全套。

**「实跑 51」与「发现 53」不是矛盾**（原先这里只写了 51，没写口径，容易被读成另一个数）：
`discoverSkillTests()` 发现 53 个，其中 2 个被 `run-test-suite.mjs` 的 `EXCLUSIONS` 划给 `integration` 套件
（`skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs`、`skills/xws-export-market-analysis/tests/postgres-state.test.mjs`）。51 是离线套件的实跑数，53 是发现数。

#### 4.4.1 关于 skills 那 609 条

`skills` 套件对外部环境比另外两套敏感 —— 但**原因不是「它会跑 Python 测试文件」**（2026-09-17 更正）。

原先这里写的是「发现规则覆盖 `skills/<name>/{tests,scripts}`，包含 `*_test.py`」。实测不成立：
`scripts/test-suite-discovery.mjs` 的 `listTestFiles()` **只收 `.test.mjs`**。skills 下确实有 1 个
Python 测试（`skills/xws-to-feishu-base/tests/extract_xws_xlsx_test.py`），但它**不被任何套件认领**，
只能按 `SKILL.md` / README 里那条 `py -3 -m unittest …` 手工跑。

真实的敏感来源是：`skills/xws-export-market-analysis` 的 **4 个 `.test.mjs`** 会 spawn `py` / `python3`
子进程（可用 `XWS_PYTHON` 覆盖解释器路径）。所以「Python 缺失或 openpyxl 版本不符时这一套会红」这个
**结论是对的，理由要换成这条** —— 部署时的动作也跟着不同：装 Python 不是为了「让套件能发现 `.py` 测试」，
而是因为这些测试与生产脚本真的会调用它。

日报链单跑（用来快速验证这条链的改动）：
`node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report` ⇒ **70/70**。
注意 `--skill=` **必须与套件名同给**（`skills --skill=…`），只给 `--skill=` 会打到 usage 退出 2。

`--concurrency=1` 不是可选项：`xws-export-market-analysis` 的用例会拉起真实 CLI 打假代理并含 stall/deadline 计时断言，机器有负载时会假失败。

套件运行器的发现是**非递归**的（runtime 只发现 `runtime/*.test.mjs`，skills 只发现 `skills/*/{tests,scripts}`）。`runtime/sop-runtime/` 下 **26** 个测试文件不在 `runtime` 那一套里——**漏跑一次就是 355 条用例无声地不进回归**。这是部署与 CI 都要知道的坑。

CI 现状（`.github/workflows/ci.yml`）：`windows-latest`，三层（L0 语法 / L1 离线 self-test / L2 单测），按 skill 分矩阵。**只覆盖离线层**，真实浏览器/飞书/生产库按设计不进 CI。

**CI 矩阵曾漏了三个 skill —— 2026-09-17 已修（M2）。**

当时的实测：10 个 skill 里有 **8 个**自带测试（`huitun 5 / daily-report 6 / search-rank 4 / sycm-to-feishu 10 / market-analysis 12 / faq-operator 1 / sku-collection 1 / xws-to-feishu 14`，合计 53 个文件），
而矩阵只列了 5 个，于是 `sycm-alimama-daily-report`（6 个测试文件）、`xws-faq-operator`（1）、`xws-sku-collection`（1）
—— 共 **8 个测试文件在 CI 上零覆盖**（其中日报链单跑是 70/70）。

修法是两步：矩阵补齐到 8 个 skill；并新增 `runtime/ci-matrix-coverage.test.mjs` 把这件事守住
—— 判据从 `discoverSkillTests()` 推导，不抄第二份名单，突变验证过（删掉矩阵里任一条目 → 守卫红并点名那个 skill）。

那条与事实不符的注释「The FAQ/question/sku skills keep their tests in runtime/*.test.mjs, which fast-gate already covers」
也一并删掉了：FAQ 与 SKU 确实在自己的 `tests/` 目录下留着测试文件，`fast-gate` 不会跑到。那是注释与事实的偏差，不是设计。

## 5. 风险与待完善项

### 5.1 阻塞级（不解决就不能承诺更强的档位）

| # | 阻塞项 | 性质 | 证据 |
| --- | --- | --- | --- |
| B-1 | 真实环境验证未闭环 | 验证缺口 | `xws.sku.collection` 与 `huitun.keyword-heat.collect` 的发布段从未对真实目标 `--commit`；`sycm.search-rank.export` 从未被真实浏览器驱动 |
| B-2 | 平台范围项未实现 | 范围缺口 | 控制平面、Browser Broker、多租户隔离、Object Storage 均未落地（已列为非目标） |
| B-3 | 工程与运维面缺失 | 交付缺口 | 无部署清单与环境 bootstrap、无监控告警、无 RPO/RTO 与恢复演练 |
| B-4 | 治理与决策未定 | 决策缺口 | 9 项待决策（部署区域、凭据托管、数据留存与 PII、SLA/RPO/RTO、并发规模、合规边界、模型供应商与预算、Temporal 去留）全部未定 |

11 条架构验收里 **6 条完整闭环、4 条只到离线层、1 条（两店铺并行不串账号）完全未证**。

### 5.2 结构性债务（来源：技术债治理方案，逐条复核过现状）

| 债 | 方案里的目标 | **2026-09-17 实测现状** | 判定 |
| --- | --- | --- | --- |
| A1 `skills` ↔ `runtime` 双向依赖 | 0 | 实测 `skills` 下 **31 个文件**（含 16 个生产文件）反向 import `runtime/`（比方案登记时**更多**，日报链是新增的） | **未关闭，且扩大** |
| A2 `runtime/` 无治理身份 | 分类收敛 | 253 个顶层跟踪条目（`INDEX.md` 记的是 168，**已过时**）；14 个合同文档仍在 `runtime/` | **未关闭** |
| B1 飞书鉴权重复实现 | 27 → 1 | 实测 **52 个文件**含 `tenant_access_token`（其中 49 个非测试；`evidence/` 下另有 2 个） | **未关闭，且扩大** |
| C1 `table_geometry` 未声明 | 决定归属 | 仍在仓库外，无发布包；两个报告脚本不可复现 | **未关闭** |
| C2 无 CI | 建 CI | 已有 `.github/workflows/ci.yml`（离线三层） | **已关闭**（但见 §4.4 的矩阵缺口） |
| D1 测试无统一入口 | ≥4 个入口 | 已有 `test:offline/unit/skills/runtime/integration` ＋ 套件运行器 | **已关闭**（但 sop-runtime 仍要单跑） |
| E3 受治理文档未纳版本控制 | 提交 | 803 个文件已跟踪，工作区干净 | **已关闭** |
| F2 工具产物误提交风险 | 加 .gitignore | `.codegraph/`、`$d/`、`tmp-*-xlsx/`、`/checkpoint.json` 均已忽略 | **已关闭** |
| A4 本地 JSON 当权威 | 清理 | 根目录 `checkpoint.json` 已不存在 | **已关闭** |
| E1/E2 版本号与 frontmatter 不一致 | 对齐 | 需逐 skill 复核（未在本次范围内核验） | **待核** |

一句话：**「可复现性」类债务（C2/D1/E3/F2/A4）基本还清；「边界」类债务（A1/A2/B1）原地不动甚至更重。** 这与技术债评估的排序结论一致——最难、最该做的是边界收敛。

### 5.3 交付形态风险（面向「装到别人电脑上」）

| # | 风险 | 说明 |
| --- | --- | --- |
| R-1 | **登错账号是静默失败** | 卖家号用不了小旺神；买家号进不了生意参谋。两边都不报错，只是数据属于另一个人。必须当场交代 ＋ 体检里断言「读到的店铺名 == 配置里的店铺名」 |
| R-2 | **两条链不能合并成一个浏览器** | 物理约束（一个 profile 一个淘宝身份），不是设计洁癖 |
| R-3 | **登录失效是高频事件，不是异常** | 主因是凭证自然过期、同一 profile 被别的账号登录、平台侧风控。日报主链**零登录判定**，不补则灯全绿也会卡死 |
| R-4 | **定时必须排在下午** | 阿里妈妈推广块上午有未回补窗口（实测同一目标日 11:22 导出曝光量 0、14:41 才变 860），而查重键是「同一天＋同店铺」⇒ 早跑写下的低值同一天修不了 |
| R-5 | **父进程一退，浏览器与代理一起被回收** | 启动器靠 `setInterval` 保活；现在这份「常驻」是给工程师会话用的，不是给客户机用的 |
| R-6 | **Edge 单例按 profile 目录判** | 「换端口」起不出第二个实例；同 profile 已在别的端口跑时，新进程会 code 0 交出请求后退出（看起来像「端口没起来」） |
| R-7 | **页面改版与风控不可自愈** | 任何客户端都修不了自己的选择器。不要对客户承诺「以后不用找你们」 |
| R-8 | **Python/openpyxl 缺失的失败点很靠后** | 解析发生在干跑那一阶段，前面采集都成功了才炸；体检要前置检查 |
| R-9 | **审计库可有可无，但不是故障** | 没配库时会打印「未写入（不影响本次结论）」，这是设计；要写进交付说明 |
| R-10 | **证据目录写在安装目录里** | 每个目标日一代（`evidence/daily-report-<日期>[-rerunN]/`），跑一年会积累不少；要有归档/清理策略 |
| R-11 | `.env.example` 曾以 3456 举例 | 该端口是别的项目的共享代理、本项目明令避开。**2026-09-17 已修**（见 §5.4）。顺带更正一条先前的说法：它并不在端口守卫的扫描面内（守卫只收 `.mjs`），所以是「根本没人看着」，而不是「靠注释躲过了守卫」 |
| R-12 | **中英文路径与安全删除守卫** | 本机对含中文路径的批量删除 fail-closed（`E:\小红书\...`）；部署脚本不要做批量删除 |
| R-13 | **沙箱端口可见性** | agent 会话只能连「会话前就在监听、或本会话自己起的」端口。换机器时若由外部启动服务，注意这条在本机工具链里的表现 |

### 5.4 顺手记下的小项（都是「不会炸但会误导人」）

**2026-09-17：四条已全部处理完（M0/M2 那两轮）。逐条记下做了什么 —— 结论留在正文里比打勾有用。**

1. `.env.example` 里把 3456（**别的项目**的共享代理）当示例端口，共四处。**已改**：删掉这四处，改成指向唯一来源 `runtime/browser-ports.mjs`，并写明两个浏览器各自的账号归属。
2. `package.json` 声明 `node >=18`，实际需要 22+。**已改**：`package.json`、`package-lock.json` 顶层 `engines`、README 三处一起改成 `>=22`。
3. `runtime/INDEX.md` 条目数与现状对不上。**已改**：用脚本实数后写回（顶层跟踪条目 253、顶层文件 597、顶层 `.md` 16），并加了一行提醒「改动本文件时请连数字一起更新」。
4. README §验证 的命令清单与套件运行器并存。**已处理**：清单保留（它按功能分组，有信息量），但把 26 行硬编码的本机绝对路径 `D:\Retire\sycm-automation\...` 全改成相对仓库根 —— 换机器时那一段原本会整段失效。两套入口的关系在 README 里已写明（逐条入口 vs 全仓回归）。

## 6. 部署方案

### 6.0 三种部署形态（先选形态，再谈步骤）

| 变体 | 场景 | 成本 | 当前可行性 |
| --- | --- | --- | --- |
| **A 单机工程师旁站** | 迁到另一台机器，工程师在场跑通 | 半天～一天，**不改代码** | **今天可做** |
| **B 单机客户自助** | 装到客户电脑，非技术人员独立用 | 需补 P0 六项（见 §6.3） | 需开发 |
| **C 服务器侧无人值守** | 长期无人值守、多店铺并发 | 需 Browser Broker ＋ 租户隔离 | **当前是非目标**，不建议现在启动 |

本文给出 A 与 B 的完整步骤；C 只给前置条件判断，不展开（避免把规划写成承诺）。

### 6.1 变体 A：工程师旁站迁移（推荐先做这一步）

目标：**在一个全新环境上把四条链里至少一条跑通，把所有环境类风险一次暴露完。**
原则：每一步都有验收判据，任一条不成立就停在那一步，不要往下走。

**阶段 0：量地基**（不装任何东西）

1. `node -v` ⇒ 需 ≥ v22。低于 22 停下装 Node 22 LTS。
2. `py -3 -c "import openpyxl, PIL, docx; print('ok')"` ⇒ 需 `ok`。缺则 `py -3 -m pip install -r requirements.txt`。
3. 找 Edge 真实路径：x64 常在 `C:\Program Files\Microsoft\Edge\Application\msedge.exe`。**不要**用脚本默认的 x86 路径。
4. 探端口：9222、3457、19022、19023（＋19024）全部空闲。**确认没占 3456**——那是别的项目的共享代理。
5. 判系统时间与 `Asia/Shanghai` 的偏差（目标日靠它推导）。

判据：五条全过才进阶段 1。

**阶段 1：整仓落地**

6. 把 `sycm-automation` **整个目录**复制到目标机（如 `D:\sycm-automation`）。
   判据：`git status --porcelain` 为空（干净 checkout）。
7. 根目录 `npm ci --ignore-scripts`。
   判据：无 EBADENGINE 类版本告警。
8. 跑离线自检：`npm run test:offline`。
   判据：通过。这是「环境基本可用」的第一道证据。
9. 跑三套基线并记录结果：
   `node scripts/run-test-suite.mjs runtime --concurrency=1`
   `node scripts/run-test-suite.mjs skills --concurrency=1`
   `node --test runtime/sop-runtime/*.test.mjs`
   判据：与本机基线一致（runtime 535/0、sop-runtime 355/0、skills 见 §4.4.1）。**不一致就停**——差异本身就是新环境的信号。

**阶段 2：配置与凭据**

10. 落凭据文件到目标机的约定目录，内容含 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。
    在 `config/customer.json` 的 `feishu.<profile>.envFile` 里写它的路径 —— **不需要改代码**（P0-1, 2026-09-17）。
    起手：`copy config\customer.example.json config\customer.json`，字段说明见 `config/README.md`。
    判据：`node -e "import('./runtime/feishu-targets.mjs').then(m=>console.log(m.loadFeishuCredentials('kcne').appId.slice(0,6)))"` 能打出前 6 位。
11. 核对/登记飞书 base 与表 id（`feishu-targets.mjs` 的 `competitorBase` / `keywordBase` / `tables` / `dailyReport`）。
    验收：读回来的 id 与飞书地址栏**逐字符一致**。沿用同一 base 则跳过。
12. 用一次**幂等写探针**复验写权限（把某个已有字段写成它当前的值）。
    判据：HTTP 200 / code 0。403 / 91403 ⇒ 应用没被加为可编辑协作者，**停下**去飞书里加。

**阶段 3：浏览器与代理（常驻）**

13. 设 `PROJECT_BROWSER_PROFILE` 指向目标机的 profile 目录（**不需要改代码** —— 两个启动器都认这个变量，2026-09-17 实测）。
    内置默认值是本机的 `D:/Retire/edge-debug-profile` 与 `D:/Retire/edge-daily-report-profile`，目标机没有 D 盘就会指到不存在的地方。
14. 起**甲**（买家链，仅竞品/FAQ 需要）：
    `PROJECT_BROWSER_EXE=<目标机 msedge> node runtime/start-project-browser.mjs`
    判据：打印 `[browser] READY ... on 9222`；且启动器念的账号要求是「必须是**买家**账号」。
15. 起**乙**（商家链）：`node runtime/start-daily-report-browser.mjs`
    判据：`READY ... on 19022`。
    **这两个启动器进程要一直活着**——父进程退出会把浏览器一起带走。
16. 起代理（各自一条）：
    `CDP_PROXY_PORT=3457 CDP_BROWSER_PORT=9222 node runtime/isolated-proxy/cdp-proxy.mjs`
    `node runtime/start-daily-report-proxy.mjs`
    判据：`GET http://127.0.0.1:3457/health` 报 `connected:true` 且 `browser.id=edge-isolated`；19023 报 `browser.id=edge-daily-report`。
    **两份都要对**，`XWS_BROWSER_ID` 与 `/health` 的 `browser.id` 不一致会硬失败。

**阶段 4：人工登录（一次性，且必须登对）**

17. 在**甲**窗口里扫码登录**买家号**，确认小旺神插件已加载：`document.querySelector('#xws-tblist-box')` 存在、页面文本含「市场分析」。
18. 在**乙**窗口里扫码登录**商家号**（生意参谋 ＋ 阿里妈妈 ＋ 飞书网页）。灰豚也在乙（它用自己的账号）。
    判据（四条，来自 `PROJECT-BROWSER-AND-PORTS.md` §4）：① 启动器没报「拒绝启动」；② `/health` 的 `browser.id` 与预期一致；③ 插件已加载（仅甲）；④ **登录身份与这条链的归属一致**（甲必须是买家向账号、乙必须能打开生意参谋后台）。
    任一不过就停下等人，不要靠重试硬闯（会加速风控）。
19. 摆好工作页（各恰好一个）：甲停在淘宝、乙停在 `#!/report/download-list`（日报用）与 `sycm` 首页。
    判据：`GET /targets` 恰好三页、URL 片段各一。**页面会被动消失**，每次开跑前都要重查。

**阶段 5：单链端到端验收（零写入 → 真写入）**

20. 选**日报链**做第一条验收（它最简单：不需买家浏览器、不需小旺神、权威在飞书，且有 09-16 全绿成例）。
    步骤见 `DAILY-REPORT-STANDALONE-DEPLOYMENT.md` §4.1 第 10-11 步；或按 `skills/sycm-alimama-daily-report/references/sop.md` §10 操作单。
    判据：干跑 `plan.json` 的 `checks` 十一项齐全、`sourceSelfChecks.allMatchDate:true`、`recordCount` 与底单行数一致；真写入后底单 +1 行且能按新 `recordId` 读回、`verifiedFields` 243、询单回填就位、`unchangedOtherFields:true`。
    若报 `duplicate daily report row exists` ⇒ 那天推过了，**停手**（不是故障）。
21. 第二条验收竞品链（需要甲浏览器 ＋ 小旺神额度）：
    `node skills/xws-export-market-analysis/scripts/run-adaptive-export.mjs`（**不要裸跑** `export-market-analysis.mjs`）。
    判据：连续前缀验证通过；出现 `STALLED` 时**它是正确行为**，不是故障。
22. 关键词链（搜索排行 ＋ 灰豚）：按 `skills/sycm-to-feishu-base/scripts/run-weekly-pre-ai.mjs` → 人工跑飞书 AI → `run-weekly-post-ai.mjs` 的顺序。
    注意：导入必须先 dry-run 再 `--commit` 带周期；CSV 只 16 列无 `搜索关键词` ⇒ `sync-latest-ab-to-main-core.mjs:73` fail-closed ⇒ 第 6 步会报「无合格候选」，这是**已知设计**不是 bug。
23. FAQ 链：`node runtime/run-faq-operator.mjs --status` 只读检查 → `--advance` 每次只推进一个阶段。

**阶段 6：常驻与定时（可选，做之前先读 §5.3 R-5）**

24. 排期写在 `runtime/round-schedule.json`（配置文件，不是触发器）；宿主只需负责叫醒：
    `node runtime/sop-runtime/round-runner.mjs --schedule-file runtime/round-schedule.json --show-plan`（先看计划）
    `… --round weekly-competitor`（手工跑一条）
    `… --serve --interval-seconds 60`（常驻）或交给任务计划程序（等价）。
    判据：`--show-plan` 给出 `triggerAt` / `isLastTriggerToday` / `hoursSinceTriggerAt` / `nextTriggerAt`。
    **到期口径是「只算触发日当天」，跨天不自动补跑**——要补跑用 `--force`。
25. 定时时刻**排在下午**（见 R-4）。
26. 重复触发靠飞书「同日重复硬停」兜底——它会**明确报错退出**，不会安静跳过。

**变体 A 的验收线**：至少一条链在目标机上跑出可回读的真实结果，且所有环境类异常都已具名暴露。

### 6.2 变体 B：做到「客户自己用」

在变体 A 跑通的基础上，按下面的顺序补齐。**变体 A 的每一条验收判据，正是 B 里那条命令应该自己做的断言——别重写，逐条搬进编排器。**

P0（不补不能交付）：

| 优先级 | 补齐项 | 做什么 | 复用 |
| --- | --- | --- | --- |
| P0-1 | **配置外置** | 把「凭据文件路径 / base＋表 id / profile 目录 / Edge 路径」收进一份客户配置，去掉改代码；在 `SYCM_FEISHU_PROFILE` 之外增加 `FEISHU_ENV_FILE` 一类开关 | `browser-ports.mjs` 的形状 |
| P0-2 | **一条命令跑完全链** | `run-daily-report-chain.mjs --date <日>`：体检 → 落位 → 导出 → 取件 → 干跑 → commit → 回填 → 回读，每步打印预期值与判据。**2026-09-18 晚：除体检段外已落地并跑通**（多店铺形态的 `run-multi-shop-day.mjs`，见 §7 的偏差说明） | SOP 操作单本身就是规格 |
| P0-3 | **登录体检** | 三个站点各一组登录标记（**按浏览器分组**），输出 `AUTH_READY / AUTH_REQUIRED / AUTH_UNKNOWN`；`AUTH_UNKNOWN` 不许当成已登录 | `xws-sku-auth-preflight.mjs`、`reopen_login_window` |
| P0-4 | **常驻与定时** | 托盘常驻 ＋ 开机自启 ＋ 按周/日定点触发 ＋ 崩溃后自动接管 | `round-runner` 的 `--serve`、stale 回收 |
| P0-5 | **通知出口** | 三级模板（要人动手 / 仅知会 / 无法自愈）＋ 去重 ＋ 恢复通知 | `notifyOperator` 通道 ＋ `notify-feishu.mjs` |
| P0-6 | **一键诊断包** | 版本 ＋ 最近回执 ＋ 关键日志 ＋ 出错页截图，一键导出并发送；**必须脱敏**（不含凭据/Cookie/token） | `evidence/` 与回执体系就是最小充分证据 |

P1：P1-1 本地控制台界面（运营台已有骨架，但要把「界面只读运行时状态」这条边界落到代码里，避免长出第二份状态真相）；P1-2 自助重登（灯红 → 开可见窗口 → 扫码 → 检测到就绪 → 自动续跑，**只扫码、不代填账密**）；P1-3 人话指引库；P1-4 进度可视化。

P2：P2-1 自动更新与回滚（页面改版时唯一出路）；P2-2 远程协助（可选）；P2-3 运行历史归档。

**依赖顺序**：P0-1 是地基（其它项都要读同一份配置）→ P0-2 与 P0-3 可并行 → P0-4 依赖 P0-1 → P0-6 依赖 P0-5 → P1-1 依赖 P0-4。

**必须提前对客户讲清的边界**：① 不做账号密码代登；② 页面改版不可自愈；③「无需返工」只对登录态类、环境类成立，改版类与风控类做不到；④ 凭据留在浏览器 profile 里，系统只存标识。

### 6.3 变体 C：服务器侧无人值守的前置判断

**现在不要启动。** 先回答两个问题：

1. 能不能接受「一台常开的 Windows 机器 ＋ 一个人能随时扫码」？能 ⇒ 变体 B 就够，不需要 C。
2. 真的需要多店铺并发吗？

需要 C 的话，按属性必须先做 **Browser Broker 与租户隔离**（它们决定并发上限与隔离边界），而不是先上容器编排。同时 README §11 的九项决策（部署区域、凭据托管、数据留存与 PII、SLA/RPO/RTO、并发规模、合规边界、模型预算、Temporal 去留）必须先定——它们**全部未定**。

## 7. 执行顺序与里程碑

| 阶段 | 做什么 | 完成标志 | 前置 | 状态（2026-09-18 更新） |
| --- | --- | --- | --- | --- |
| **M0** | 冻结当前基线：三套实测 ＋ HEAD 记入部署单 | 部署单有可对照的基线数字 | 无 | **已完成**（`54c93ed` → `docs/ops/DEPLOYMENT-RUNBOOK.md`） |
| **M1** | 变体 A 在目标机跑通（工程师旁站，不改代码） | 至少一条链产出可回读的真实结果；环境类风险全部具名 | M0 | **未开始 —— 缺目标机**。本机跑通不算数，它证明不了「换机器会怎样」 |
| **M2** | 顺手项：`.env.example` 改掉 3456、`package.json` engines 改 22、`INDEX.md` 条目数对齐、CI 矩阵补三个 skill | 四项各自可机械校验 | 无（不与 M1 冲突） | **已完成**（`6fbf64f`，额外加了 CI 矩阵守卫） |
| **M3** | P0-1 配置外置 ＋ P0-2 一条命令 | 「迁移」这件事从此不再需要工程师 | M1 | **P0-1 已完成**（`config/customer.json` ＋ `runtime/customer-config.mjs`）；**P0-2 部分落地**（2026-09-18 晚：`run-multi-shop-day.mjs` 把「落位→导出→取件→干跑/核对→回填→回读」固化成一条命令并真跑通，四家店串行、只读复验；同夜又接进体检段 → **十一阶段**。见下方偏差说明） |
| **M4** | P0-3 登录体检 ＋ P0-5 通知 | 最高频故障（登录失效）能自己恢复且会主动叫人 | M3 | **各完成一半**。P0-5 通知出口已落地（`runtime/notify-feishu.mjs`，零参数 CLI，「没送达必然非零退出码」）；P0-3 的**探测与按店铺点名告警**已落地（`skills/sycm-alimama-daily-report/scripts/login-merchant.mjs` ＋ core 的 `alertForRun`，点名这件事有测试锁住），**自助重登（灯红 → 开可见窗口 → 扫码 → 检测到就绪 → 自动续跑）未做** |
| **M5** | P0-4 常驻定时 ＋ P0-6 诊断包 ＋ P1-1 界面 | 客户能不看命令行使用 | M4 | 未开始 |
| **M6** | 边界收敛（抽 `lib/feishu-client` 把散落的飞书鉴权收敛掉 —— §5.2 实测 **52 个文件**含 `tenant_access_token`；解 `skills→runtime` 反向依赖 —— 实测 **31 个文件**；`runtime/` 生命周期分类） | 反向依赖 ＝ 0；飞书鉴权实现 ＝ 1 | M2 的 CI 门禁真的在跑 | 未开始（本轮按推荐**不排**） |
| **M7** | 补齐三条能力的真实发布段（B-1） | 各有一份真实 `--commit` 回执 | 外部前置 | 未开始 |

**与里程碑顺序的一处偏差（如实记）**：M3 的前置写的是「M1」，但 P0-1（配置外置）不依赖目标机，
而它要解决的正是「到了目标机上必须改代码」这件事，所以先做了。P0-2 留在原处 ——
它的规格来自 SOP 操作单，等 M1 把手工流程真跑通一次，再固化成一条命令更稳。

**2026-09-18 晚更新（P0-2 的暂缓理由已满足）**：那天手工流程真的整轮跑通了一次（**真写入**，
四家店，见 `evidence/multi-shop-run-2026-09-18/RUN-LOG.md`），当晚就把「落位→导出→取件→
干跑/核对→回填→回读」固化成一条命令 `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`，
并对同一天做了只读复验跑通（四家店 × 十阶段全 ok，见 `evidence/multi-shop-2026-09-17/RUN-LOG.md`）。
所以 P0-2 记「**部分落地**」，不记完成，还差两段：

1. **体检段的深度仍未到** —— 那条命令的第一步体检**已经接进驱动了**（2026-09-18 深夜起是十一阶段：
   整轮跑之前先体检一次商家浏览器，不通过则整轮不跑且与 `--keep-going` 无关；每台店浏览器各体检一次），
   但 `runtime/xws-platform-health-preflight.mjs` 只有 L1（环境层）真实实现，L0/L2/L3 如实标 `NOT_IMPLEMENTED`。
   也就是说「体检有没有跑」已经不缺，「体检能不能查出更深的问题」还缺。
2. **只在目标机上才能验的那部分仍未验** —— 它证明的是「这条链在本机能一条命令跑完」，
   而不是「换一台机器也能」。后者仍等 M1。

**下一步最该做的是 M1** —— 它把「环境类风险」从纸面变成实测。剩下的活里 M6 风险最高（动结构），
必须在 M2 之后、且每批 ≤10 文件。

## 8. 待拍板（每项都有推荐默认值，不说就按推荐值）

1. **先做哪一步**：推荐 M1（在目标机跑通变体 A）。理由：环境类风险只有真跑才暴露，比继续补代码更快定位真问题。
2. **目标机范围**：只迁一条链（日报，最简）还是四条全迁？推荐先只迁日报，跑通后再加竞品链。
3. **P0-1 配置外置的形态**：一份 JSON 配置文件 还是 全 env？推荐**一份 JSON**（形状照 `browser-ports.mjs`），env 仍可覆盖顶层。
4. **M2 的顺手项要不要现在做**：推荐做（四项都是「不会炸但会误导人」，改动小、可机械校验）。
5. **要不要把 M6 排进本轮**：推荐**不排**。它动结构、风险最高，且当前 CI 的守卫密度还不足以托住它。

## 9. 本文不承诺什么

- 不承诺上线日期、生产级无人值守规模或长期平台兼容性（沿用 `docs/architecture/README.md` §11 口径）。
- 不把「测试通过」当作「已获授权」：commit / push / 部署 / 真实外部写入各自仍需明确授权。
- 不把「离线层已证」表述成「真实环境已证」。
- 不把「仓库里有这个文件」当作「这个能力已实现」——`agent-runtime/`、`supervisor-agent/` 都是 PROTOTYPE。
