# 工程规范基线

状态：第一阶段治理基线，约束文档和后续工程变更；不代表目标架构已经实现。

本文是跨模块的工程规范入口。它不复制业务流程合同，不替代仓库操作规则，也不把一次运行回执、候选框架或未来组件写成当前能力。

## 1. 适用范围

本规范适用于：

- 新增或修改 Skill、运行入口、数据处理、校验和发布流程。
- 后续引入 Worker、Adapter、durable workflow、数据库、对象存储、Agent 或外部系统集成。
- 影响租户、店铺、平台账号、浏览器 profile、资源租约、业务游标或外部写入的变更。
- 与状态、证据、权限、幂等、回读和故障恢复有关的测试与文档变更。

当前阶段不做以下事情：

- 不引入 Temporal、LangGraph、ADK、AutoGen、AgentTeams 或其他运行时框架。
- 不新增数据库 schema、通用 supervisor、Browser Broker、Object Storage 或部署系统。
- 不承诺生产级无人值守、十几或几十家店铺并发、永久登录态或最终部署形态。
- 不通过创建大量空目录或文档，把计划能力伪装成已实现能力。
- 不通过增加重试、超时或 DOM 特判继续扩大现有实验性 supervisor。

## 2. 文档权威与职责

不同文件拥有不同作用域，不能把它们当成一份互相覆盖的配置文件：

| 来源 | 权威范围 |
| --- | --- |
| 系统/开发者指令和用户明确授权 | 当前会话的最高约束 |
| `AGENTS.md` | 仓库操作、安全、外部系统和现有流程硬规则 |
| 本文 | 跨模块工程治理、证据、测试和交付约定 |
| `docs/architecture/README.md` | 目标架构、稳定分层、已批准决策和迁移边界 |
| `skills/*/SKILL.md` | 对应 Skill 的可执行流程、输入输出、安全停止和验收合同 |
| `docs/project-knowledge.md` | 当前已验证事实、历史证据和对外表述边界 |
| `runtime/` | 运行入口、阶段指针和单次运行状态；不是架构事实源 |
| `evidence/` | 可复核验证输出和历史运行证据；不是实时输入 |
| 根 `README.md` | 项目导航和少量入口说明 |

作用域规则：

- `AGENTS.md` 的安全、授权和平台控制规则不可被便利性、架构设想或 Skill 需要覆盖。
- Skill 合同只在对应 Skill 内补充可执行细节，不能降低仓库级安全要求。
- 目标架构中的未来能力必须标注为目标、候选或待 POC，不能反向证明当前实现。
- `docs/project-knowledge.md` 记录事实，不负责决定未来架构；`README.md` 不复制完整合同。
- 发现规则冲突、事实无证据或文档职责漂移时，先停止相关变更，定位冲突文件，更新正确的权威来源后再改代码。

## 3. 目录所有权

| 路径 | 允许内容 | 不允许内容 |
| --- | --- | --- |
| `skills/<name>/` | Skill 合同、脚本、局部测试、参考资料和能力级工件 | 全局架构规则、跨 Skill 状态源 |
| `runtime/` | 项目运行入口、阶段指针、过程状态和受控运行证据 | 把本地 JSON 当作业务恢复或完成状态的唯一权威 |
| `evidence/` | 验证输出、回执和历史运行证据 | 作为下一次采集的未验证实时输入 |
| `docs/architecture/` | 稳定目标架构、批准决策和跨流程契约 | 单次故障调查、实现教程和运行回执 |
| `docs/standards/` | 工程治理标准和本文入口 | 业务数据、凭据、单次运行状态 |
| `docs/references/` | 外部方法、迁移后的知识模式和参考资料 | 未经证据支持的本项目事实 |
| `docs/project-knowledge.md` | 当前能力、证据索引、事实边界和对外声明限制 | 目标架构规范或新的执行合同 |
| 根文档 | 导航、入口和必要的项目说明 | 与 Skill/知识文档重复的完整业务合同 |
| `node_modules/` | 包管理器产生的本地依赖 | 手工业务修改或提交到仓库 |

新增 `decisions/`、`contracts/`、数据库、服务或基础设施目录前，必须有明确的批准决策、目录所有权和清理规则。没有批准决策或可执行 schema 时，不预建空专题目录。

以下内容始终属于项目外部资源：已登录 Edge profile、Cookie、Token、浏览器存储、认证头、共享 CDP Proxy、密码和 `E:\小红书\.env.local` 的凭据值。路径可以在必要的操作说明中出现，秘密值不得进入代码、日志、manifest、checkpoint、证据或文档。

## 4. 模块边界

目标架构的模块职责如下；尚未落地的模块不得被当前脚本名称或目录名称冒充为已实现服务：

- **Control Plane**：租户、店铺、平台账号、能力目录、策略、配额、人工任务和审计查询。
- **Durable Workflow**：唯一拥有运行历史、定时器、暂停、恢复、取消、重试和人工闸门的执行层。
- **Browser Broker**：浏览器 profile、账号、CDP session、tab 和短期 lease 的获取、续期、归属和释放。
- **Adapter/Worker**：平台页面、API、插件、下载和平台专属交互；细节封装在 Adapter 内。
- **Validator**：身份、范围、结构、行数、文件完整性、哈希和来源证据验证。
- **Commit/Publication**：幂等提交、外部写入、回读、发布回执和对账。
- **Agent Runtime**：基于已授权证据提出结构化建议，不拥有资源、游标或写权限。

依赖和隔离规则：

- 工作流依赖业务能力接口，不依赖 DOM selector、按钮文本、target ID 或平台内部请求格式。
- 页面导航、请求关联、插件诊断、弹窗、下载和最后一公里 DOM 操作只能由对应 Adapter 负责。
- 平台变化通过 Capability/Adapter 版本、probe、contract test 和小范围 canary 处理；不能让 Agent 自动修改生产 selector。
- 外部写入不由 Agent 直接执行，必须经过确定性的授权、白名单、幂等和回读路径。
- 飞书是运营工作台或发布投影，不因为可见而自动成为业务事实的唯一权威源。
- 现有 XWS supervisor 是实验性流程实现；后续需要耐久执行时，应先做故障注入垂直切片，再选择底层框架。

## 5. 状态、证据与不变量

执行、证据、人工、资源租约和发布必须分开表达，不能用单一含义模糊的 `status` 代替：

- Execution：`QUEUED / RUNNING / RETRY_WAIT / PAUSED / SUCCEEDED / FAILED`
- Evidence：`NONE / CANDIDATE / VALIDATED / REJECTED`
- Human gate：`NONE / WAITING_HUMAN / APPROVED / DENIED / EXPIRED`
- Lease：`WAITING / HELD / EXPIRED / RELEASED`
- Publication：`NOT_REQUESTED / READY / COMMITTED / VERIFIED / UNKNOWN`

失败分类：

- `TRANSIENT_EXTERNAL`：在明确预算内重试。
- `RESOURCE_BUSY`：回队列等待，不创建重复执行。
- `HUMAN_REQUIRED`：暂停并等待人工处理。
- `CAPABILITY_DEGRADED`：停止当前能力版本，进入维护或回退。
- `EVIDENCE_INVALID`：拒绝当前工件，不重试同一坏证据。
- `POLICY_DENIED`：记录原因并终止。
- `COMMIT_UNKNOWN`：进入对账，禁止盲目重写。
- `BUG`：告警并停止自动化。

统一证据链：

```text
Observation
  -> Candidate Artifact
  -> Validated Artifact
  -> Decision
  -> Idempotent Commit
  -> Publication Receipt
```

强制不变量：

- 只有验证通过的工件才能推进业务游标、快照或完成状态。
- 验证至少覆盖归属、请求范围、结构、行数、文件大小、哈希和格式完整性；具体能力还要执行其 Skill 合同。
- `STALLED` 表示阶段或分片没有继续推进，不等于 `DONE`。
- 未知、缺失、未核验和未完成不得写成 `0`、空成功或完成状态。
- 外部写入必须先 dry-run，再进行精确授权、字段白名单、幂等提交和回读验收；必要时保留写前备份。
- 租约、业务提交和发布回执必须能区分“已确认”“未确认”和“未知”。
- 本地 JSON、页面显示进度、子进程退出码或 tab 是否仍然打开，都不能单独证明业务完成。

## 6. 并发与租户隔离

调度至少按以下资源维度分 lane：

```text
tenant / store / platform / account / browserProfile / capability
```

- 同一平台账号或 browser profile 默认并发为 1。
- 同一店铺的写操作默认串行；不同店铺可以并行。
- API、本地解析和浏览器任务分别限流，按租户设置并发、速率和预算配额。
- 平台级故障使用熔断和背压，避免继续扩大外部压力。
- 使用带权公平队列，避免单个店铺长期占满浏览器或 Agent 资源。
- 资源清理只关闭当前 run 创建或明确认领的资源；未知 tab 不得扫描关闭。

## 7. 测试与验收门禁

每次变更先写清完成条件和验证方法，再执行最小范围变更。验证按风险分层：

| 变更 | 最低验证 |
| --- | --- |
| 文档或导航 | 路径和相对链接存在，`git diff --check`，审阅 scoped diff |
| 脚本或确定性逻辑 | 受影响测试、self-test 和必要的边界/失败用例 |
| 数据流程 | 源行数、字段合同、连续唯一性、可读性、CSV/XLSX 一致性、哈希和回执 |
| 浏览器流程 | Proxy 健康、账号/Edge 绑定、目标重新发现、风险硬停止、停滞和资源释放 |
| 外部写入 | dry-run、显式目标和授权、字段白名单、写前备份、幂等提交、回读验收 |
| 状态/恢复/基础设施 | Worker 被杀、浏览器断开、重复回调、partial artifact、retry 耗尽、租约释放和 `COMMIT_UNKNOWN` 对账 |

真实浏览器、飞书和生产 PostgreSQL 操作不进入普通离线测试；需要真实系统时，必须单独记录环境、授权、目标和回执。CI 现已存在（`.github/workflows/ci.yml`）但**只覆盖离线层**（见 §8），因此不得把「CI 绿」当成「真实流程已验证」，也不得把人工命令列表表述为自动化门禁。

当前仓库测试使用 Node 内置 `node:test` 和 Python `unittest`，主要采用 `<implementation>.test.mjs` 与少量 `*_test.py` 命名；统一入口是 `package.json` 的 `test:*` 系列（`test:integration` 需外部系统，未置绿）。PowerShell 中使用通配符测试前必须确认命令实际展开方式，优先显式列出文件或使用已验证的脚本入口。

## 8. 可复现性现状与缺口

以下是当前已知事实，不是本规范的假设：

- `package.json` 声明 Node `>=18`，并提供 `test:offline` / `test:unit` / `test:runtime` / `test:skills` / `test:integration` 分层入口（集成层需外部系统，未置绿）；**仍没有** lint 或 build 定义。
- 已有 `requirements.txt`（锁定 `openpyxl==3.1.5` / `Pillow==11.3.0` / `python-docx==1.2.0`）与 `.github/workflows/ci.yml`（离线闸门：L0 语法 / L1 self-test / L2 单测，`windows-latest`，按 skill 分矩阵）；`docx` 已声明进 `package.json`。**仍缺**解释器版本声明（README 用 `py -3`，实测 CPython 3.12.9）、部署清单与环境 bootstrap。
- 此前记的「部分 Python 脚本依赖**未声明**的 `openpyxl`/`Pillow`/`python-docx`」与「Node 文档脚本依赖**未声明**的 `docx`」**已过时**——三者现均随清单或 `package.json` 声明。
- `table_geometry` 仍依赖仓库外模块且无发布包，涉及 `runtime/build-keyword-decision-brief.py` 与 `runtime/build-keyword-decision-report.py`，故这两个脚本**不能**从干净 checkout 复现（技术债 C1）。
- PostgreSQL 侧**已形成项目级合同**：`db/migrations/001-007`（每份带 rollback）+ `runtime/verify-migrations-isolated.mjs` 隔离预演（39/39）+ 仓库级词表守卫（`commit-status-vocabulary.test.mjs` 从迁移推导现状；007 的 action/outcome 词表另有一条从迁移文件推导的守卫，见 `skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs`）；**仍缺**服务本身、连接变量与凭据注入方式的合同，`pg` 仍只是客户端依赖。
- durable 语义与确定性运行时**已落地**：PostgreSQL 承担 `runtime/sop-runtime/` 的状态权威，跨进程故障注入（`recovery-fault-injection.mjs`）17/17。**未落地**的是 Object Storage、Browser Broker 与多租户隔离。
- 当前真实运行依赖外部已登录 Edge、共享 CDP Proxy、平台状态和外部凭据文件。

`test:offline` 只运行三个固定的确定性 self-test，不发现或执行测试文件，因此不会触发真实 CDP、PostgreSQL、Python 或外部凭据；它不是完整 test gate。已知的 adaptive retry-budget 长时间失败不属于本阶段修复或验收范围。

因此当前只能承诺已由对应 Skill、测试和运行证据证明的能力，不能承诺干净环境一键复现、完整 CI、生产级恢复或多租户并发。仍未解决的是：解释器 bootstrap、`table_geometry` 归属、部署清单，以及运维面（监控、告警、备份与恢复演练）。后续补齐每项缺口时，必须同时补版本声明、安装方式、失败模式和验证命令。

生产准入的完整评估（四条阻塞线、README §10 十一条架构验收的逐条实测状态、通往生产的最小路径）见 `docs/architecture/PRODUCTION-READINESS.md`。

## 9. 安全与数据治理

- 不读取、记录、复制或提交密码、Cookie、Token、浏览器存储、认证头和凭据值。
- 登录、验证码、QR/SMS、风控、账号风险、权限、额度或安全提示必须进入 `HUMAN_REQUIRED`，不得绕过或伪装处理。
- 不添加 stealth、指纹伪装、反检测或绕过平台控制逻辑。
- 外部写入遵循最小权限、显式目标、授权范围、字段白名单和回读验证。
- Tenant、Store、PlatformAccount、BrowserProfile、写目标和运行工件必须按授权边界隔离。
- 日志和证据只收集完成审计所需的最小信息；避免把 PII 或敏感平台 payload 写入普通日志。
- 数据留存、删除、PII 分类、跨境和模型数据出境尚未完成决策；在决策前不得作合规承诺。

## 10. 变更治理

每次工程变更必须：

1. 识别受影响的权威文档、模块边界、状态、证据、权限和幂等键。
2. 先更新架构边界或数据合同，再实现代码；实现不得反向定义全局规则。
3. 保持变更集中，不在同一批次顺带引入框架、数据库、部署系统或无关重构。
4. 新能力记录直接证据、测试证据、版本信息和仍未验证的部分。
5. 破坏性变化版本化合同，并提供迁移、回滚、补偿或人工处理路径。
6. Adapter 变化先通过 probe、contract test 和 canary，再改变默认版本。
7. 废弃入口保留明确状态和迁移指向，不让旧入口与新入口同时成为隐性权威。
8. 不用 README、截图、运行日志或一次成功回执宣称长期稳定、生产上线或平台永久兼容。

## 11. Agent 权限

Agent 是受限提案者，不是业务状态拥有者。允许：

- 读取已授权的结构化证据。
- 做分类、摘要、解释、异常分诊和人工队列候选。
- 生成任务建议和下一步 proposal。

禁止：

- 选择租户、店铺、平台账号、浏览器 profile 或飞书写目标。
- 确认周期有效性、推进业务游标、改变完成状态或决定提交范围。
- 授予自己或其他组件写权限，直接写 PostgreSQL、飞书或其他业务系统。
- 修改生产 selector、绕过登录/验证码/风控/权限/额度控制。
- 以自然语言“成功”替代结构化验证证据。

每个 proposal 至少包含：任务输入、证据引用、prompt 版本、model 版本、置信度、请求动作和风险分类。确定性 Validator 和 Commit 层必须独立于 Agent 存在；移除 Agent 后，采集、解析、验证和提交仍应可运行。

## 12. Git、提交、推送与部署

- 未经用户明确授权，不执行 commit、push、部署或远程写操作。
- 变更前后检查 `git status` 和完整 scoped diff，保留用户已有 dirty changes。
- 只暂存本次明确范围的文件；不使用会吸收运行工件、临时目录或秘密的宽泛 staging。
- 不提交 `.env`、凭据、Cookie、Token、浏览器 profile、运行输出和大体量临时工件。
- 不 force push，不绕过 hooks，不修改 git config。
- 部署前必须有目标环境、凭据来源、回滚/补偿方案和验收回执；文档变更不得暗示部署完成。
- 本仓库当前的 commit、push 和真实外部写入仍分别需要用户授权，不能由测试通过推导授权。

## 13. 后续落地顺序

1. 依据真实运行需求补 Node/Python 版本、依赖声明、最小测试入口和可复现 bootstrap。
2. 以 XWS 单分片完成故障注入垂直切片，证明验证、幂等提交、恢复和资源释放。
3. 以 FAQ 商品级 fan-out 验证并行、失败隔离、人工队列和跨店资源隔离。
4. 基于 POC 结果选择 durable workflow、Browser Broker 和 Agent runtime；未完成 POC 前不落多个框架依赖。
5. 再迁移 SKU、SYCM、灰豚、周报和飞书发布，并按实际合同新增专题规范或可执行 schema。
