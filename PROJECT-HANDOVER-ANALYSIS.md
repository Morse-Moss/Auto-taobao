# 生意参谋自动化项目 接手分析报告

生成时间：2026-09-11
分析对象：`D:\Retire\sycm-automation`（git 分支 `main`，HEAD `b5b3ae7`，2026-09-06）
报告性质：一次性接手阅读件，不属于 `docs/architecture/`、`docs/standards/`、`docs/project-knowledge.md` 的受治理文档集。
证据口径：本次分析基于仓库实读（代码、测试、文档、回执），并实际执行了 `npm run test:offline`（通过）。

---

## 一、结论先行

这个项目是一个已经跑通生产业务的电商运营受控浏览器自动化系统，同时正在被改造为多租户任务执行平台。

三条核心判断：

1. 业务能力层成熟。9 个 Skill 覆盖生意参谋采集、小旺神竞品分析、SKU 采集、FAQ 周更、灰豚话题热度、飞书多维表导入，多数有真实运行的零差异回执（300 行 SHA-256 双次一致、1343/1333 行竞品导出、107/107 测试含 11 项 PostgreSQL 集成）。
2. 平台底座层处于 POC 早期。新增的 `agent-runtime/`（Temporal）当前全部使用 fake adapter，其自述的 5 项验收条件全部未达成；真实长跑在 1-40 页的第 20 页 `STALLED`，回执结论为 `LOCAL_READY_EDGE_REBIND_REQUIRED`。
3. 最大的隐性风险不是代码质量，而是工程可复现性和治理边界。没有 CI、没有 build、没有 lint、没有 Python 依赖清单、`docx` 依赖未声明；同时 `runtime/`（18029 行、168 个顶层脚本）事实上承担了业务编排层，却不属于任何 SKILL 合同或架构文档的治理范围，且与 `skills/` 存在双向循环依赖。

代码质量本身明显高于同类自动化项目：幂等键、CAS 版本号、advisory lock、租约、回读验收、写前备份、陈旧锁回收、失败分类都已落地，并且有对应测试。

---

## 二、技术栈

| 层 | 选型 | 实读依据 |
| --- | --- | --- |
| 运行时 | Node.js ESM，`type: module`，声明 `>=18`，实测 `v22.22.2` | `package.json` |
| 生产依赖 | 仅 5 个：`@temporalio/client|worker|testing|workflow` 1.23.0、`pg` 8.23.0 | `package.json`，`node_modules` 实装一致 |
| 辅助脚本 | Python 3（`openpyxl`、`Pillow`、`python-docx`），未声明 | 13 个 `.py`，共 2747 行 |
| 测试框架 | Node 内置 `node:test` + Python `unittest` | 98 个 `*.test.mjs`，1 个 `*_test.py` |
| 浏览器层 | 共享 `web-access` CDP Proxy（`http://127.0.0.1:3456`）+ 已登录 Edge | `AGENTS.md`、各 `SKILL.md` |
| 业务系统 | 飞书 Bitable API；PostgreSQL（`XWS_DATABASE_URL`） | `postgres-state.mjs`、`feishu-client.mjs` |
| 未声明依赖 | Node `docx`（被 2 个 `.cjs` 直接 require）；Python `table_geometry`（仓库外） | `runtime/generate-competitor-v2-*.cjs`、`build-keyword-decision-*.py` |
| 凭据 | `E:\小红书\.env.local`（仅传路径，不入库） | `README.md`、`.gitignore` |

技术栈的一句话概括：Node ESM 为主、Python 只做文档与表格、PostgreSQL 做业务权威、飞书做运营投影、浏览器通过共享 CDP 复用人工登录态。

---

## 三、系统架构

### 3.1 目标架构（尚未落地，已批准为基线）

`docs/architecture/README.md` 定义了分层：

```
运营人员 / API / 定时触发器
        -> 任务与策略入口
        -> 控制平面（租户/店铺/账号/能力/权限/配额/人工任务）
        -> 唯一 Durable Workflow 层（超时/重试/暂停/恢复/信号/审计）
             +-> Browser Worker -> Browser Broker -> 淘宝/SYCM/XWS/灰豚
             +-> API Worker
             +-> Agent Worker（只出 proposal）
             +-> Validator -> Commit / Publication
        -> PostgreSQL + Object Storage + Feishu
```

权威数据划分（重要，接手必读）：

| 数据 | 权威职责 | 现状 |
| --- | --- | --- |
| Durable Workflow history | 执行历史、定时器、重试、恢复依据 | POC，fake |
| PostgreSQL | 业务事实、verified cursor、租约、幂等提交账本 | 已实现（仅 XWS adaptive） |
| Object Storage | 不可变原始工件 | 未实现 |
| Feishu | 运营工作台与发布投影 | 已实现 |
| 本地 JSON | 缓存与投影，不得决定恢复位置 | 存在违规使用，见风险项 |

证据链强制为：`Observation -> Candidate Artifact -> Validated Artifact -> Decision -> Idempotent Commit -> Publication Receipt`。硬规则：未知、缺失、未核验、未完成不得写成 `0` 或空成功。

### 3.2 当前实际架构

目标架构与现状之间有明确落差，现状是：

```
已登录 Edge 会话
  -> 共享 CDP Proxy（127.0.0.1:3456）
  -> 每次动作前重新发现 target
  -> skills/<name>/scripts/ 受控状态机（采集、监督、导出）
  -> 数据与文件双重校验（行数/连续唯一/哈希/ZIP/图片可解码）
  -> 原子发布
  -> runtime/ 业务编排脚本（周更、公式迁移、历史同步、发布）
  -> 授权飞书副本 / 同 Base 周表结构复制 / 回读验收
```

关键结论：`skills/` 是能力层，`runtime/` 是事实上的编排层，`agent-runtime/` 是尚未接入的耐久执行层 POC。

---

## 四、模块划分与依赖

### 4.1 规模分布

| 区域 | 非测试 .mjs 行数 | 说明 |
| --- | --- | --- |
| `skills/` | 14782 | 9 个能力 Skill |
| `runtime/` | 18029 | 实际编排与运营脚本，168 个顶层入口 |
| `agent-runtime/` | 180 | Temporal POC，3 个文件 |
| `scripts/` | 22 | 离线自检入口 |
| 测试 | 16512 | 98 个测试文件 |
| Python | 2747 | 13 个脚本 |

测试与源码行数比约 1:2。仓库总体积 3.8G，其中 `runtime/` 占 3.8G（大量 jpeg/png/jsonl 运行产物，多数被 `.gitignore` 排除）。

### 4.2 Skill 清单

| Skill | 版本（SKILL/README） | scripts | tests | 状态 |
| --- | --- | --- | --- | --- |
| `sycm-export-search-rank` | 无版本 | 7 | 3（在 scripts/ 内） | 已验证 |
| `sycm-to-feishu-base` | 无版本 | 8 | 9 | 已验证 |
| `xws-export-market-analysis` | 2.2.1 / 2.2.1 | 14 | 12 | 主体已验证，adaptive 长跑未通 |
| `xws-to-feishu-base` | 无版本 | 12 | 11（+1 py） | 已验证 |
| `xws-sku-collection` | 1.9.0 / 1.8.0 / README 1.2.0 | 0（入口在 runtime/） | 0 | 2 批次真实验收 |
| `xws-faq-operator` | 3.1.0 / README 2.0.0 | 0（入口在 runtime/） | 0 | 已交付，入口 `runtime/run-faq-operator.mjs` |
| `xws-faq-raw-collection` | 1.2.0 | 2 | 0 | 已验证 |
| `xws-question-library-collection` | 1.2.0 | 0 | 0 | 兼容壳，指向 raw-collection |
| `huitun-to-feishu-keyword-heat` | 无版本 | 2 | 3 | 已验证 |

### 4.3 依赖关系（实读，非推断）

- `runtime/ -> skills/`：多处直接复用，例如 `runtime/apply-xws-sku-manifest.mjs` 导入 `skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs`，`competitor-history-publish-core.mjs` 导入 `competitor-v2-core.mjs`。
- `skills/ -> runtime/`：`skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs` 导入 `../../../runtime/weekly-local-analysis.mjs`。
- 结论：两层存在双向依赖（近似循环）。`docs/standards/README.md` 规定 `skills/<name>/` 不得持有跨 Skill 状态源，且不得包含全局架构规则，当前这条边界已被打破。
- XWS 内部依赖链清晰：`run-adaptive-export.mjs -> adaptive.mjs / postgres-state.mjs / runtime-lock.mjs -> export-market-analysis.mjs -> merge / validate-output.py`。
- `agent-runtime/` 通过读取 `skills/xws-export-market-analysis/SKILL.md` 的 frontmatter 加载能力清单，其余为 fake adapter。

---

## 五、功能实现状态

### 5.1 已完成且有真实证据

- 生意参谋搜索排行导出：2026-08-16 对 `2026-08-09~08-15` 两次独立采集，各 300 行、分页 50x6、排名 1-300 连续唯一，两份 CSV SHA-256 完全一致（`A46B6673...8DCC`）。
- 小旺神市场分析导出：2026-08-05 两次真实完整运行 1-40 页，1343 行与 1333 行，16 列、排名连续唯一、商品链接唯一、CSV/XLSX 非图片字段零差异、嵌入图片可解码。
- 飞书多维表导入与周更：267 行导入保留 24 字段/8 公式/5 AI Prompt/1 视图；两周批次认定修正后分布为批次 1 有效 300、批次 2 无效-周期错误 267、批次 3 有效 300。
- 竞品分析 V2：9 个确定性字段由飞书公式生成并回读验证；有效性与排除原因公式化；AI 字段以哨兵值回填。
- SKU 采集：2026-08-21 首批 36 条、2026-08-23 第二批 6 条，写后回读唯一键、双向关联、空间判定全部 36/36、6/6，冲突与重复均为 0。
- 灰豚话题热度回填：2 条真实验收（`109.4w -> 1094000`；无同名话题 -> `0`）。
- FAQ 周更：v3.1.0 运营入口，累计主表 + 周期周表双表模型，本地确定性分类不调用飞书 AI。
- 关键词周更全链：`run-weekly-pre-ai.mjs` -> `READY_FOR_AI` 人工闸门 -> `run-weekly-post-ai.mjs`，含公式迁移、灰豚回填、历史同步、幂等验收。

### 5.2 部分完成 / 未验证

- `xws-export-market-analysis` 自适应长跑：107/107 测试通过（含 11 项 PostgreSQL 集成），但真实 1-40 页运行在第 20 页 `STALLED`（显示 755 行、请求 21 次、最后状态 200），PostgreSQL 权威 `completed_end=0`、`committed_parts=[]`。回执明确 `full_export_contract: NOT_COMPLETED_ON_REAL_PLUGIN_RUN`。原因是共享 Proxy 报 `browser.id=browser-service` 而非 `edge`，前置闸门安全阻断。
- 迟到工件处理：`Top720` CSV 在子进程退出后出现，被判定 `REJECTED_FOR_CURRENT_ATTEMPT`（不可归属当前 Top755 尝试）。
- `agent-runtime/`：`workflows.mjs`、`activities.mjs` 全为 fake adapter；`local-vertical-slice.mjs` 自述"内存演示，不是崩溃恢复证据"。其"真实 XWS 使用前验收"5 条全部未达成。

### 5.3 未实现

控制平面、Browser Broker、Object Storage、多租户隔离、真实 Agent Runtime（受限工具 + 校验 proposal）、系统化故障注入 POC、CI/CD。

---

## 六、技术债务与风险

### 高

1. 工程可复现性缺口。无 CI、无 build、无 lint；无 Python 依赖清单与版本锁定；`docx` 未在 `package.json` 声明但被 2 个 `.cjs` 直接 require；`table_geometry` 依赖仓库外模块。`docs/standards/README.md` 自己承认"不能承诺干净环境一键复现"。
2. `runtime/` 是治理盲区。18029 行、168 个顶层入口，事实上是编排层，但既无 SKILL 合同覆盖，也不属于架构文档边界；且与 `skills/` 双向依赖（`run-weekly-post-ai.mjs` 反向导入 `runtime/weekly-local-analysis.mjs`）。这直接违反仓库自订的目录所有权规则。
3. 真实长跑未闭环。adaptive 在 20/40 页停滞，是"代码就绪、真机未通"状态。接手后任何"已支持 1-40 页采集"的表述都不成立。
4. `agent-runtime/` 未纳入版本控制。`git status` 显示 `?? agent-runtime/`，且其自称验收条件全部未达成。存在被误引用为"已实现 durable workflow"的风险。
5. 存在违规的本地 JSON 权威。根目录 `checkpoint.json` 内容为 `{"status":"RUNNING"}`，会被误读为运行状态权威，与架构原则（本地 JSON 不得决定业务恢复位置）冲突。

### 中

6. 文档版本漂移。`README.md` 写 `xws-sku-collection` v1.2.0，`SKILL.md` frontmatter 写 1.9.0、正文写 1.8.0；`README.md` 写 `xws-faq-operator` v2.0.0，`SKILL.md` 写 3.1.0。三处口径不一致。
7. SKILL frontmatter YAML 结构错误。`skills/xws-sku-collection/SKILL.md` 中 `version: "1.9.0"` 未缩进在 `metadata:` 之下，成为顶层键，破坏 manifest 解析约定（其他 Skill 均正确缩进）。
8. 根目录污染。`$d/`（解压出的 6 个 xlsx XML）、`tmp-faq-ops-xlsx/`（6 个 XML）、两个空目录 `CUsersAdministratorDownloads/` 与 `DRetire sycm-automation/`（由未加引号的 Windows 路径被 shell 吃掉反斜杠产生）。这些在验证回执中被列为 `unclassified_paths`。
9. 退役入口未清理。`runtime/retired-huitun-result-writer.mjs`、`retired-keyword-decision-writer.mjs`、`apply-keyword-decisions.mjs`、`apply-huitun-results.mjs` 仍存在（已加读取前强制停止，属良性残留，但增加接手认知成本）。
10. 缺失 `.env.example`。`.gitignore` 中有 `!.env.example` 白名单，但文件不存在，新环境无凭据字段模板。
11. 证据分散。`evidence/` 只有 4 组目录 + 1 份回执；大量运行证据在 `runtime/` 下且多数被 `.gitignore` 排除，clone 后无法复核。

### 低

12. `skills/*/scripts/__pycache__` 存在（`.gitignore` 已覆盖）。
13. 中文路径 + 本机 safe-delete fail-closed 策略影响运行产物清理（环境级约束，非代码问题）。

---

## 七、接手关键信息

### 7.1 构建与运行

无构建步骤。安装与最小验证：

```powershell
npm ci --ignore-scripts
npm run test:offline
```

本次实跑 `npm run test:offline` 结果：3 个自检全部 `ok:true`
- `sycm-export-search-rank`：`rowCount=3`、`uniqueRanks/contiguousRanks/uniqueTerms` 全 true
- `xws-export-market-analysis`：`args/progress/risk/dataset/deadline` 全 true
- `huitun-topic-heat`：`options/exactMatch/noExact/risk/provenance/mutation` 全 true

package 级入口仅 3 个：`test:offline`、`test:agent-runtime`、`run:agent-runtime-local`。

### 7.2 真实运行前置条件（四件套，缺一不可）

1. 已登录的 Edge 用户会话；
2. 共享 CDP Proxy 可达且 `/health` 报 `browser.id=edge`（报 `browser-service` 即硬停止，这是本次长跑失败的直接原因）；
3. PostgreSQL 且设置 `XWS_DATABASE_URL`（adaptive 系必需）；
4. 飞书应用凭据文件路径（`E:\小红书\.env.local` 提供 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。

另需注意：`XWS_MARKET_ANALYSIS_LOCK` 可控锁路径，默认在系统临时目录 `xws-runs/.market-analysis.lock`。`--allow-trial` 在 adaptive 流程被显式拒绝。

### 7.3 测试覆盖率

- 98 个 `*.test.mjs`、1 个 `*_test.py`，测试代码 16512 行。
- 最强证据：`evidence/verification-receipt-20260904.json` 记录 XWS 套件 107/107 通过（含 11 项真实 PostgreSQL 集成、40 项 adaptive 结算回归、8 项 prepare/export 流程回归、Edge 绑定闸门 4 项覆盖）。
- 弱项：没有覆盖率工具、没有统一全仓 test gate；`test:offline` 只跑 3 个固定 self-test，不发现测试文件，不代表全仓回归。Python 与真实浏览器路径不在离线门禁内。
- `runtime/` 的 58 个测试文件没有统一的执行入口，需要手工显式列举。

### 7.4 文档完备度

整体高，且有明确的权威分工声明。清单：

- `AGENTS.md`：仓库操作与安全硬规则（最高约束之一）。
- `docs/architecture/README.md`（14672 字节）：目标架构、分层、权威数据、迁移路线、11 条架构验收。
- `docs/standards/README.md`（15638 字节）：工程治理、目录所有权、状态与证据不变量、测试门禁、可复现性缺口（自陈）。
- `docs/project-knowledge.md`（18991 字节）：已验证能力、证据索引、对外表述边界、简历可用事实与"不应声称"清单。
- 9 份 `SKILL.md` + 6 份 `references/`。
- 缺口：无 README 之外的快速上手文档、无架构决策记录目录（`decisions/` 仅约定未建）、无运行手册。
- 风险：文档本身存在版本漂移（见 6.6）与未纳入 git 的架构文档（`docs/architecture/`、`docs/standards/` 当前为 `??` 未跟踪状态）。

---

## 八、建议的接手动作（按优先级）

1. 先跑通环境门禁，不要先改代码。确认 Proxy 报 `edge`、PG 可连、`npm run test:offline` 通过，再执行 `node --test skills/xws-export-market-analysis/tests/*.test.mjs`（需 `XWS_TEST_DATABASE_URL`）复现 107/107。
2. 把已完成的治理资产纳入版本控制。`agent-runtime/`、`docs/architecture/`、`docs/standards/`、`scripts/` 目前均未提交；在提交前需决定 `agent-runtime/` 是否标注为原型。
3. 清理根目录污染。`$d/`、`tmp-faq-ops-xlsx/`、`checkpoint.json`、两个空目录应移除或纳入 `.gitignore`（注意本机中文路径删除策略与批量删除守卫）。
4. 修正文档与 manifest 漂移。统一 `xws-sku-collection` 与 `xws-faq-operator` 的三处版本号，修复 `xws-sku-collection` frontmatter 缩进。
5. 明确 `runtime/` 的归属。要么为它建立治理边界与入口清单，要么把 `run-weekly-post-ai.mjs -> runtime/` 的反向依赖收敛，消除双向耦合。
6. 补最小可复现声明。新增 `requirements.txt`（openpyxl/Pillow/python-docx）、声明 `docx` 版本、提供 `.env.example`（仅字段名，不含值）。
7. 闭环真实长跑。用 Edge 绑定成功后的单分片完成"采集 -> 验证 -> EvidenceManifest -> 幂等提交 -> 恢复"，再谈 1-40 页。
8. 补齐 `agent-runtime/` 的 5 项验收（独立 worker 杀进程恢复、commit-before-response 重复调用只产生一次副作用、人工闸门跨 worker 存活、真实受限工具 Agent 调用、真实 CSV/XLSX 与 PostgreSQL cursor 集成），在此之前不要对外称已有 durable workflow。

---

## 九、接手三天速查

| 我想… | 去哪 |
| --- | --- |
| 了解项目能力边界 | `docs/project-knowledge.md` 的"已实现能力"与"不应声称" |
| 了解目标架构 | `docs/architecture/README.md` |
| 知道改代码要守什么规矩 | `docs/standards/README.md` + `AGENTS.md` |
| 跑最小验证 | `npm run test:offline` |
| 跑最强回归 | `XWS_TEST_DATABASE_URL=... node --test skills/xws-export-market-analysis/tests/*.test.mjs` |
| 看某个能力的可执行合同 | `skills/<name>/SKILL.md` |
| 看真实运行证据 | `evidence/verification-receipt-20260904.json`、`evidence/stability-20260804/`、`evidence/xws-20260805/` |
| 看失败长跑现场 | `runtime/f57ed37d-a4ec-4592-8339-1a1767238a42-runs/`（events.jsonl / diagnostics.json / stall.png） |
| 知道哪些入口已退役 | `runtime/retired-*.mjs`、`apply-keyword-decisions.mjs`、`apply-huitun-results.mjs` |
