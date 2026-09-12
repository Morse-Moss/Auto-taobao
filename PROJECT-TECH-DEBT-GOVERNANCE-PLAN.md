# 技术债成因分析与分阶段治理方案

生成时间：2026-09-11
对象：`D:\Retire\sycm-automation`
配套阅读：`PROJECT-HANDOVER-ANALYSIS.md`（现状盘点）、`docs/architecture/README.md`（目标架构）、`docs/standards/README.md`（治理基线）
本方案性质：一次性治理规划件，不属于受治理文档集。落地时如需成为长期规范，应走 `docs/standards/` 的变更流程。

---

## 零、判定原则

在开始之前先定三条排序原则，避免把"看着不舒服"和"真的有风险"混在一起：

1. 按"是否会破坏已交付业务"排序，而不是按改动量排序。这个项目已经有真实业务在跑（周更、FAQ、SKU），任何让已验证能力失效的改动优先级最高，哪怕它看起来最小。
2. 按"阻塞后续所有工作"的程度排序。有些债不还，其它债没法还（例如没有测试门禁就不敢动耦合）。
3. 显式区分"止血"和"治本"。止血不改行为，可以立刻做；治本改结构，必须排队。

同时明确一点：本项目的性能问题基本不存在独立技术债。真正的性能观察只有三处（`runtime/` 占 3.8G 产物、`.codegraph/` 20MB SQLite、PostgreSQL 连接池 `max: 4`），且都不是当前瓶颈。绝大多数债落在稳定性和可维护性两个维度上。下面的影响评估会如实标注，不夸大性能影响。

---

## 一、技术债分类、成因与影响

### A 类 架构与边界债（最高优先级）

**A1 双向循环依赖：`skills/` 与 `runtime/` 互相 import**

具体证据：
- `skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs` 第 8 行 import `../../../runtime/weekly-local-analysis.mjs`
- `runtime/apply-xws-sku-manifest.mjs`、`competitor-history-publish-core.mjs`、`create-weekly-history-tables.mjs` 等约 10 处 import `../skills/xws-to-feishu-base/scripts/*`

成因：这是典型的"演进式增长"结果，不是设计失误。早期项目按"skill 是能力、runtime 是本周怎么跑"来分，runtime 作为编排层自然要调用 skill；但当某个能力（本地关键词分析）先写在 runtime、后来才被 skill 需要时，就出现了反向 import。仓库自订的目录所有权规则（`docs/standards/README.md` 第 3 节）写于耦合发生之后，属于"事后立法"，没有回头治理既有耦合。

影响范围：14 个 runtime 模块 + 1 个 skill 模块形成强耦合环。任何对 `xws-to-feishu-base/scripts/competitor-v2-core.mjs` 或 `runtime/weekly-local-analysis.mjs` 的签名修改，都会同时冲击能力和编排两侧。

影响评级：稳定性 中（当前能跑，但改一处炸两侧），性能 无，可维护性 高。

**A2 `runtime/` 是事实上的编排层，却不在任何治理边界内**

具体证据：`runtime/` 非测试 `.mjs` 18029 行、168 个 git 跟踪入口，体量超过 `skills/`（14782 行）。但它既没有 SKILL 合同，也不属于 `docs/architecture/` 或 `docs/standards/` 的覆盖对象。仓库自己的定位说它是"运行入口、阶段指针和单次运行状态；不是架构事实源"，可是里面实际躺着 14 个被 git 跟踪的合同与决策文档，包括 `huitun-candidate-contract.md`、`keyword-analysis-v2-contract-20260811.md`、`keyword-field-contract-20260809.md`、`sku-weekly-storage-decision-20260825.md`。

成因：`runtime/` 从"临时运行目录"被无声升级成了"业务合同仓库"和"编排层"，但没有人回头更新它的定义。这是职责漂移，不是写错代码。

影响范围：全项目。**这是本次分析里最影响长期可维护性的一条**——因为它是知识分布问题：接手者按文档去找合同时找不到，按标准去信 `runtime/` 时又被告知它不算权威。

影响评级：稳定性 低（不影响运行），性能 无，可维护性 极高。

**A3 平台底座与业务能力严重代际错位**

具体证据：目标架构要求控制平面、唯一 Durable Workflow 层、Browser Broker、Object Storage；现实是 `agent-runtime/`（180 行、3 文件）全部 fake adapter，`local-vertical-slice.mjs` 自述"内存演示，不是崩溃恢复证据"，其 5 项验收全未达成；真实长跑在 20/40 页 `STALLED`，PostgreSQL `completed_end=0`、`committed_parts=[]`。

成因：正确的演进顺序（先垂直切片验证，再铺平台）被执行成了"先把框架依赖装上、文档写好、原型占位"。这是好意图加坏排序。

影响范围：决定了后续所有平台化工作的起点。风险不只是"没做完"，而是"未完成的原型可能被误读为已实现能力"。

影响评级：稳定性 高（真实恢复能力未经验证），性能 无，可维护性 高。

**A4 本地 JSON 被当作运行权威**

具体证据：根目录 `checkpoint.json` 内容为 `{"status":"RUNNING"}`，无 run id、无时间、无归属。架构原则明确"本地 JSON 是缓存或投影，不得决定业务恢复位置或业务完成状态"。

成因：`checkpoint.json` 是早期单文件断点方案的残留；后来 XWS adaptive 已改用 PostgreSQL 做权威（`postgres-state.mjs` 有完整 CAS + advisory lock），但根目录这个文件没人清理，语义已被架空却仍在。

影响范围：单个文件，但它是"错误示范"——接手者很容易照着它继续写本地 checkpoint。

影响评级：稳定性 中，性能 无，可维护性 中。

### B 类 代码质量与重复债

**B1 飞书客户端逻辑大面积重复**

具体证据：27 个文件各自实现原始飞书鉴权（`tenant_access_token`），其中 20 个在 `runtime/`。而规范实现其实已经存在，就是 `skills/xws-to-feishu-base/scripts/feishu-client.mjs`（有独立测试 `feishu-client.test.mjs`）。举一个极端例子：`runtime/fix-legacy-content-heat.mjs` 整个文件被压成单行，一次 `main()` 里塞完鉴权、分页、dry-run、写入、回读、写回执。

成因：一次性运维脚本的"先解决眼前问题"惯性。每个脚本都是为一次特定迁移写的，写的时候不觉得需要复用，写完就留在仓库里，于是 27 份实现共同演化（或者说共同停止演化）。

影响范围：任何飞书 API 层面的变更（鉴权、分页、错误码、限流）需要在 27 处同步修改，实际上不可能同步，结果是行为不一致。

影响评级：稳定性 高（错误处理与重试逻辑在各文件间不一致），性能 低，可维护性 极高。

**B2 一次性脚本与长期代码混放，无生命周期标记**

具体证据：168 个 runtime 入口中，既有长期编排（`run-faq-operator.mjs`、`run-weekly-*`），也有明确的一次性迁移（`fix-legacy-content-heat.mjs`、`repair-history-types.mjs`、`repair-history-types-v2.mjs`、`repair-weekly-tables.mjs`、`migrate-*`、`cleanup-*`、`inspect-*`、`summarize-*`、`tmp-inspect-feishu-ui.mjs`）。命名里只有 `tmp-` 一个前缀和 `retired-` 一种显式标记。

成因：迁移脚本写完之后没有"退役"这一步动作。仓库其实已经建立了正确模式（`retired-huitun-result-writer.mjs` 是一个 fail-closed 抛错存根，做法很规范），但没有回溯应用到存量。

影响范围：接手者无法区分"这个脚本还能不能跑"。误跑一个 `migrate-*` 或 `cleanup-*` 脚本的后果可能很重。

影响评级：稳定性 高（误执行风险），性能 无，可维护性 高。

**B3 硬编码绝对路径与凭据路径**

具体证据：
- `runtime/fix-legacy-content-heat.mjs`：`path.resolve('D:/Retire/sycm-automation/runtime/...')`
- `runtime/import-history-via-api.mjs`、`runtime/paste-history-import.mjs`：硬编码 `D:/Retire/sycm-automation/runtime/latest-competitor-1-40-20260824.csv`
- `skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs`：默认值 `envFile: 'E:/小红书/.env.local'`
- `runtime/legacy-feishu-writeback.test.mjs`：测试里也硬编码绝对路径

成因：本地单人开发环境下的便利写法。凭据路径尤其值得注意——虽然没泄露凭据值，但把机器专属路径写进默认参数，等于把"这台机器"变成了隐式前提。

影响范围：5 处路径 + 1 处凭据默认值。直接后果是无法在别的机器或 CI 上运行，间接后果是治理验收永远无法在干净环境复现。

影响评级：稳定性 中，性能 无，可维护性 高。

### C 类 依赖与可复现债

**C1 未声明依赖**

具体证据：
- Node：`runtime/generate-competitor-v2-archive-docx.cjs`、`generate-competitor-v2-business-docx.cjs` 直接 require `docx`，但 `package.json` 只有 5 个依赖，`node_modules/docx` 实测不存在（当前已损坏不可运行）。
- Python：13 个 `.py` 使用 `openpyxl`（12 处导入）、`PIL`（3 处）、`python-docx`（31 处导入）。此外 `runtime/build-keyword-decision-brief.py`、`build-keyword-decision-report.py` 依赖仓库外的 `table_geometry`。

成因：Node 侧是"临时写个文档生成脚本，随手 require"；Python 侧是从头就没有 Python 依赖管理这一步。

影响范围：可分三类。可修（openpyxl/Pillow/python-docx 可声明）、需选型（docx 需决定版本并真正装上）、不可自愈（`table_geometry` 在仓库外，且是 `build-keyword-decision-brief.py` 和 `build-keyword-decision-report.py` 的硬依赖——这两个文件是关键词决策报告生成器，属于业务能力，不是临时脚本）。

影响评级：稳定性 中（当前这些入口本来就跑不起来），性能 无，可维护性 高。

**C2 没有构建、检查、集成流水线**

具体证据：`package.json` 只有 3 个脚本（`test:offline`、`test:agent-runtime`、`run:agent-runtime-local`）；无 lint、无 build、无 CI 配置。`test:offline` 实测只跑 3 个固定 self-test、不发现测试文件。`docs/standards/README.md` 自己写明"没有 CI 时，不得把人工命令列表表述为自动化门禁"。

成因：本地单人项目没有引入流水线的触发点。

影响范围：所有质量保障都依赖人肉记忆命令列表，且清单散落在 README、standards、各 SKILL.md 之间，已经出现不一致。

影响评级：稳定性 中，性能 无，可维护性 高。

### D 类 测试与验证债

**D1 测试资产强但入口缺失**

具体证据：98 个 `*.test.mjs`、16512 行测试代码，最强的单点证据是 `evidence/verification-receipt-20260904.json` 记录的 XWS 套件 107/107 通过，含 11 项真实 PostgreSQL 集成、40 项 adaptive 结算回归。但 58 个测试文件在 `runtime/`，没有任何统一执行入口；`package.json` 也没有全仓测试命令。

成因：测试是随着每个功能单独写的，从没被要求"可一键执行"。

影响范围：测试的价值无法被自动兑现。新人不知道该跑哪些、跑的顺序、哪些需要数据库。实际后果是回归依赖熟人。

影响评级：稳定性 高（回归不可自动复现），性能 无，可维护性 高。

**D2 回执是点态证据，且被设计为易失效**

具体证据：`verification-receipt-20260904.json` 的 `invalidated_by` 明确写：任何超出该次 diff 哈希的源码/测试/文档改动都会使其失效。也就是说这份 107/107 的证据，在任何人改动任何一行相关代码后就不再成立。

成因：这是**正确的设计**（证据必须绑定版本），但要配套自动重验机制；当前缺的正是 C2 里的 CI，于是正确设计反而变成了负担——每次改动都让证据作废，却没有机制再造一份。

影响范围：证据可信度随时间衰减，而重建成本高。

影响评级：稳定性 中，性能 无，可维护性 高。

**D3 关键真实路径无自动化验证**

具体证据：真实长跑失败（20/40 页 STALLED）暴露出"代码就绪、真机未通"。回执 `not_executed.controlled_real_membership_recovery` 的失败原因是共享 Proxy 报 `browser.id=browser-service` 而非 `edge`——环境问题，但没有任何自动化能在治理过程中持续回答"现在真机能跑通吗"。

成因：真实浏览器流程天然难自动化，团队选择了"离线测试 + 人工真机验收"，这是合理的权衡，只是缺一个记录"真机最后一次通过是什么时候"的机制。

影响评级：稳定性 高，性能 无，可维护性 中。

### E 类 文档与治理债

**E1 版本号三处不一致**

具体证据：
- `xws-sku-collection`：`README.md` 写 v1.2.0，`SKILL.md` frontmatter 写 `1.9.0`，同文件正文写 `Version: 1.8.0`
- `xws-faq-operator`：`README.md` 写 v2.0.0，`SKILL.md` 写 `3.1.0`

成因：版本号在三个地方各写一遍，没有单一来源。

影响范围：直接影响 `agent-runtime` 的能力加载——`local-vertical-slice.mjs` 和 `temporal/activities.mjs` 都通过解析 SKILL.md frontmatter 读取 name/version，版本漂移会让 manifest 成为不可信输入。

影响评级：稳定性 低，性能 无，可维护性 中。

**E2 SKILL manifest YAML 结构错误**

具体证据：`skills/xws-sku-collection/SKILL.md` 中 `version: "1.9.0"` 未缩进，成为顶层键而非 `metadata` 的子键，与其余 8 个 SKILL 的写法不一致。

影响范围：任何按 `metadata.version` 读取的消费者会读不到；而按顶层 `version` 读取的会读到，造成读取行为依赖实现细节。

影响评级：稳定性 低，性能 无，可维护性 中。

**E3 受治理文档未纳入版本控制**

具体证据：`git status` 显示 `docs/architecture/`、`docs/standards/`、`agent-runtime/`、`scripts/` 全部为未跟踪（`??`）。也就是说架构基线、工程规范、离线自检入口、平台原型都还在工作区里。

成因：本地持续演进，未做提交动作。

影响范围：任何 clone 都拿不到架构与规范；回执里的 `unclassified_paths` 也把这些列为未分类。

影响评级：稳定性 低，性能 无，可维护性 高。

### F 类 环境与产物卫生债

**F1 根目录污染**

具体证据：
- `$d/`：6 个 xlsx 内部 XML（`xl/worksheets/sheet1..4.xml`），是一次解压时目录名被错误处理留下的
- `tmp-faq-ops-xlsx/`：同类，6 个 XML
- `checkpoint.json`：见 A4
- `CUsersAdministratorDownloads/`、`DRetire sycm-automation/`：两个空目录，成因明确——Windows 路径未加引号，反斜杠被 shell 吃掉后按字面创建

成因：全部是命令行传参事故，不是设计问题。但它们进了回执的 `unclassified_paths`，说明连当时的验证者都无法给它们归类。

影响范围：`$d` 这个目录名尤其危险——在 bash 里 `$d` 会被当作变量展开，任何脚本里不小心写到它都会产生意外行为。

影响评级：稳定性 低，性能 低（体积小），可维护性 中。

**F2 工具产物可能被误提交**

具体证据：`.codegraph/` 含 20MB `codegraph.db`、`codegraph.db-shm/-wal`、`daemon.pid`（记录 pid 40668，启动于 2026-09-01）、104KB `daemon.log`，且当前是未跟踪状态。仓库根 `.gitignore` 未覆盖 `.codegraph/`。

成因：工具自动生成，未及时加入忽略列表。

影响范围：一次 `git add -A` 就会把 20MB 二进制和一个带机器路径的守护进程日志提交进仓库。

影响评级：稳定性 低，性能 低，可维护性 中。

**F3 运行产物体积**

具体证据：`runtime/` 目录 3.8G，主要是 jpeg/png/jsonl。`.gitignore` 已覆盖大部分（`runtime/**/*.jsonl`、`*.png` 等），所以版本库本身只有 4MB——这条治理得不错。

影响范围：仅本地磁盘与扫描速度（`find` 类命令经常超时，本次分析中实际遇到两次）。

影响评级：稳定性 无，性能 低，可维护性 低。

### 债的量化汇总

| 维度 | 指标 | 当前值 | 目标值 |
| --- | --- | --- | --- |
| 重复实现 | 自实现飞书鉴权的文件数 | 27 | 1 |
| 依赖方向 | skills↔runtime 双向依赖数 | ≥11 | 0 |
| 依赖声明 | 未声明的运行时依赖 | 3（docx / Python 三方 / table_geometry） | 0 |
| 测试入口 | 全仓测试命令数 | 0 | ≥4（unit / runtime / integration / offline） |
| 可移植性 | 硬编码绝对路径与凭据默认值 | 6 | 0 |
| 版本一致性 | 版本号不一致的 Skill | 2 | 0 |
| 仓库卫生 | 根目录未分类项 | 5 | 0 |
| 真实闭环 | 端到端真机单分片验证 | 未通过 | 通过 |

---

## 二、系统性解决方案：三条收敛线

债务看起来有 20 多项，但把它们归因之后，实际只有三个根因，对应三条收敛线。所有阶段动作都应该能明确挂到其中一条上；挂不上的动作不做。

**收敛线一：边界收敛。** 根因是"能力层与编排层互相渗透，且编排层没有正式身份"。终态是三层清晰：`skills/` 能力层（带合同与测试）、`lib/` 共享库层（飞书客户端、校验器、契约类型）、`ops/` 编排与运维层（一次性脚本明确标记生命周期）。依赖方向单向：`ops → lib ← skills`，禁止 `skills → ops`。

**收敛线二：可复现收敛。** 根因是"质量保障靠人肉记忆命令"。终态是干净机器上 `npm ci` + 一条命令即可完成离线验证，Python 依赖可声明安装，CI 在每个 PR 上跑分级门禁。

**收敛线三：执行收敛。** 根因是"平台底座以原型冒充实现"。终态是 durable workflow 有真实验收（5 项达成），真机单分片端到端跑通，且未达成的部分在文档与代码中都显式标注为 prototype。

---

## 三、分阶段治理方案

排序的硬约束来自依赖关系：P2 必须先有 P1 的门禁（否则改耦合等于盲改），P3 必须先有 P2 的边界（否则 workflow 接口无稳定依赖对象），P0 无前置可以立即开始。

### P0 冻结与止损（不改任何行为）

目标：让仓库状态变得可信可读。这一阶段**不允许修改任何业务逻辑、测试断言、SKILL 合同正文**。

动作：

1. 建立治理分支（如 `refactor/debt-p0`），不改 main。
2. 归类未跟踪资产并提交，四类分开提交，便于单独回滚：
   - 治理文档：`docs/architecture/`、`docs/standards/`
   - 离线门禁：`scripts/`
   - 平台原型：`agent-runtime/`（提交时在 `CLAUDE.md` 顶部补一行"STATUS: PROTOTYPE, fake adapters only, acceptance unmet"）
   - 忽略项：见下
3. 补 `.gitignore`：`.codegraph/`、`$d/`、`tmp-*-xlsx/`、`/checkpoint.json`。
4. 清理根目录：删除 `$d/`、`tmp-faq-ops-xlsx/`、两个空目录、`checkpoint.json`。删除前先确认 `checkpoint.json` 无引用（先 `grep` 全库确认）、`$d/` 与 `tmp-faq-ops-xlsx/` 内容可从源 xlsx 重新解出。删除走系统回收站而非 `rm`，且分批执行、每批校验。
5. 文档版本对齐：以 `SKILL.md` 为单一来源，修正 `README.md` 中的 `xws-sku-collection` 与 `xws-faq-operator` 版本号；修复 `xws-sku-collection/SKILL.md` 的 frontmatter 缩进；把同文件正文的 `Version: 1.8.0` 与 frontmatter 统一。
6. 在 `runtime/` 新增 `INDEX.md`（或在根 README 增加一节），把 168 个入口按"长期编排 / 一次性迁移 / 诊断只读 / 已退役"四类列出。此步只登记，不搬移文件。

前置依赖：无。
退出条件：`git status` 输出可解释（每条都有归属）；根目录无异常项；两个 Skill 的版本号三处一致。
验证方式：`git status` 人工审阅；`node scripts/run-offline-self-tests.mjs` 仍通过；`git diff` 不含任何 `.mjs` 逻辑行变更（可机械校验）。
回滚：每类资产独立提交，单独 `git revert`。
风险控制：清理动作前逐项列出受影响路径清单并要求确认；`$d/` 因 `$` 在 shell 中的特殊性，用引号包裹的单一路径逐个操作，不用通配符。

### P1 可复现基线（仍不改业务逻辑）

目标：让"这台机器能跑"变成"任何机器能跑"。

动作：

1. 声明缺失依赖：
   - `package.json` 增加 `docx`（选定版本后 `npm i`），使两个 `.cjs` 可运行。
   - 新增 `requirements.txt`，锁定 `openpyxl`、`Pillow`、`python-docx` 版本。
   - `table_geometry`：决定归属。它是仓库外的业务硬依赖，两条路——把实现内联进 `runtime/`（推荐，体量应很小），或在 `requirements.txt` 中以本地路径/Git 引用声明。**在决定前，把 `build-keyword-decision-brief.py` 与 `build-keyword-decision-report.py` 在文档中标记为"依赖仓库外模块，当前不可复现"**。
2. 新增 `.env.example`，只写字段名：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`XWS_DATABASE_URL`、`XWS_TEST_DATABASE_URL`、`XWS_MARKET_ANALYSIS_LOCK`，全部留空值。
3. 建立分级测试入口（关键一步，后续所有阶段都依赖它）：
   - `test:unit` —— 纯确定性、无外部依赖
   - `test:runtime` —— 显式列出 `runtime/**/*.test.mjs`（解决 58 个文件无入口的问题）
   - `test:integration` —— 需 `XWS_TEST_DATABASE_URL`，缺失时明确 skip 并回报 skipped 计数，不允许静默通过
   - `test:offline` —— 保留现状语义（3 个 self-test），不动
   - `test:all` —— 组合入口
4. 引入 CI（GitHub Actions 或本地等价流水线），只跑 `test:unit` + `test:offline` + `node --check`。integration 与真实浏览器流程明确排除在 CI 之外，写入注释说明原因。
5. 建立"回执自动重建"机制：新增脚本，在 CI 通过后自动生成新的 verification receipt，记录当时 HEAD 与 diff 哈希，替代手工维护。这是对 D2 的直接回应。

前置依赖：P0（`scripts/` 需先提交）。
退出条件：干净机器执行 `npm ci --ignore-scripts && npm run test:offline && npm run test:unit` 全通过；`py -3 -m pip install -r requirements.txt` 可完成；`.env.example` 字段与实际读取代码一致。
验证方式：在临时目录 clone 后执行上述命令；`grep` 确认三处未声明依赖已消除或已标记。
回滚：`package.json` / `requirements.txt` 变更独立提交。
风险控制：新增依赖可能引入版本冲突，`docx` 需先验证两个 `.cjs` 的实际 API 用法再定版本；`test:runtime` 首次运行大概率有失败用例，**此时不允许为通过而修改断言——先记录为已知失败清单**，留待 P2 处理。

### P2 边界收敛（本轮最关键、风险最高的阶段）

目标：消除双向依赖与飞书客户端重复，建立 `lib/` 层。

这一阶段必须拆成三个互不混合的小批次，每批单独提交、单独验证。

**P2.1 抽取 `lib/feishu-client.mjs`**
- 以 `skills/xws-to-feishu-base/scripts/feishu-client.mjs` 为蓝本（它已有测试，是现成的最佳实现）。
- 把 27 处自实现鉴权收敛到该客户端。**迁移顺序按风险从低到高**：先只读诊断脚本（`inspect-*`、`summarize-*`、`get-feishu-state.mjs`），再 dry-run 类，最后写操作类。
- 每迁移一个文件，保留新旧双实现并做输出比对（同一输入下两者请求体与结果应一致），比对通过后再删除旧实现。
- **严禁**在同一批次里修改任何飞书字段名、公式、写入范围或幂等键。

**P2.2 解除 `skills → runtime` 反向依赖**
- 唯一一处反向依赖是 `run-weekly-post-ai.mjs` 导入 `runtime/weekly-local-analysis.mjs` 的三个函数（`canonicalDigest`、`validatePublishPlan`、`validatePublishReadback`）。
- 处理方式：把这三个函数移到 `lib/publish-contract.mjs`，`runtime/weekly-local-analysis.mjs` 改为 re-export 以保持向后兼容（保留旧路径可用）。
- 注意：`run-weekly-post-ai.mjs` 还有 `PROJECT_ROOT` 与 `envFile: 'E:/小红书/.env.local'` 的硬编码默认值，同批次一并改为必填参数 + 环境变量，移除默认值（移除默认值是行为变更，需在回执中显式记录）。

**P2.3 生命周期标记与目录收敛**
- 把 `runtime/` 中一次性脚本移入 `ops/migrations/`、`ops/diagnostics/`，长期编排移入 `ops/workflows/`。
- 对已完成的迁移脚本套用仓库已有的正确模式（`retired-*.mjs` 的 fail-closed 抛错存根）。
- 此步**只做移动与加存根，不改逻辑**；旧路径保留 re-export 壳一个周期。

前置依赖：P1 的 `test:runtime` 与 CI（没有门禁就不许动耦合）。
退出条件：`skills/` 下不存在指向 `runtime/` 的 import（可机械 grep 校验）；自实现飞书鉴权文件数从 27 降到 1；`test:runtime` 失败清单清零或明确登记为已知问题；`XWS` 套件仍 107/107（或失败数不增加）。
验证方式：
```
grep -rn "runtime/" --include=*.mjs skills/ | grep -v test    # 期望空
grep -rln "tenant_access_token" --include=*.mjs . | grep -v node_modules | wc -l  # 期望 1
npm run test:runtime
XWS_TEST_DATABASE_URL=... node --test skills/xws-export-market-analysis/tests/*.test.mjs
```
回滚：三个子批次独立提交；`lib/` 抽取阶段新旧双实现并存，回滚只需切回旧调用点。
风险控制（本阶段红线）：
- 不触碰 `export-market-analysis.mjs` 的 selector、不触碰任何 `--confirm-*` 授权语义、不触碰幂等键生成逻辑。
- 不修改 `skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs` 的公式构造输出——它被飞书回读验证依赖，改它等于改业务合同。
- 每批次 ≤10 文件，每批后立即跑受影响测试。
- 删除任何旧入口前，先 grep 全库确认无引用，并保留一个提交周期的 re-export 壳。

### P3 执行收敛（平台底座）

目标：让 durable workflow 从原型变成有真实验收的执行层。

动作：
1. 先补 `agent-runtime/` 的 5 项验收，顺序不能颠倒：
   - 独立 worker 进程被杀后恢复 + 持久化副作用回执
   - commit-before-response 失败后重复调用只产生一次持久化副作用
   - 人工闸门跨 worker 替换存活，且拒绝非法 resume 决策
   - 真实受限工具 + 校验 proposal 的 Agent 调用（硬编码决策不算）
   - 真实 CSV/XLSX 校验 + PostgreSQL cursor 与资源归属集成
2. 用 XWS 单分片完成垂直切片：采集 → 验证 → EvidenceManifest → 幂等提交 → 恢复。**只做单分片**，不铺多页。
3. 把 fake adapter 逐个替换为真实 adapter：先替换 `observePage` / `validateArtifact` / `commitArtifact`（这三个最接近已有能力，可复用 `skills/xws-export-market-analysis` 的现成实现），最后替换浏览器动作。
4. 真机单分片跑通后，再考虑多分片与 1-40 页。

前置依赖：P2（边界收敛后才有稳定的能力接口可依赖）、`table_geometry` 归属决策（P1）。
退出条件：5 项验收各有可执行的测试或回执；真机单分片端到端通过并产生 Publication Receipt；PostgreSQL `completed_end` 与 `committed_parts` 有真实推进记录。
验证方式：故障注入测试（杀 worker、断浏览器、重复回调、partial artifact、retry 耗尽、租约释放、`COMMIT_UNKNOWN` 对账），逐项对应 `docs/architecture/README.md` 第 10 节的 11 条架构验收。
回滚：`agent-runtime/` 与现有 `runtime/` 编排并存，未切换前业务不受影响。
风险控制：此阶段最容易犯的错是"用 fake adapter 的通过来宣布完成"。硬性要求：任何验收结论必须指向真实外部系统产生的回执，内存演示与进程内 worker 替换均不计入。

### P4 能力补齐

控制平面、Browser Broker、Object Storage、多租户隔离。这些在 `docs/architecture/README.md` 第 11 节仍属"待决策"，在 P3 完成前不应启动。此处不展开，避免把规划写成承诺。

### 阶段依赖总览

```
P0 冻结止损 ──> P1 可复现基线 ──> P2 边界收敛 ──> P3 执行收敛 ──> P4 能力补齐
   (无前置)        (需 P0)          (需 P1)         (需 P2)       (需 P3)
                                     |
                              最关键，风险最高
```

可并行的部分：P0 的文档版本对齐与 P1 的依赖声明互不阻塞；P2.1（飞书客户端）与 P2.2（反向依赖）理论可并行，但建议串行以降低验证复杂度。

---

## 四、治理期间的持续可用性策略

这是整个方案里最容易被忽略、但决定成败的部分。业务正在跑（周更、FAQ、SKU），治理不能让它停。

**策略一：冻结运行面（Frozen Surface）**

先显式定义"当前可用入口清单"，并约定这些入口在治理期间 CLI 参数与行为不变：

- `runtime/run-faq-operator.mjs`（FAQ 周更）
- `skills/sycm-to-feishu-base/scripts/run-weekly-pre-ai.mjs` / `run-weekly-post-ai.mjs`（关键词周更）
- `skills/xws-export-market-analysis/scripts/export-market-analysis.mjs`（竞品采集）
- `skills/huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs`（灰豚）

治理改动发生在这四个入口的**内部实现**，不改变它们的对外契约。任何必要的契约变更单独走一次显式评审，不与重构混批。

**策略二：兼容壳先行，删除延后**

P2 涉及文件搬移。做法是先在旧路径留下 re-export 壳，至少保留一个完整交付周期再删除。这样即使有未被 grep 到的引用（例如外部 `D:\codex\skills\sycm-*` 的目录联接），也不会中断。

注意：`README.md` 提到全局 Skill 入口 `D:\codex\skills\sycm-*`、`xws-*`、`huitun-*` 是指向本项目 `skills` 的目录联接。**这说明存在项目外的消费者**。P2.3 搬移 `runtime/` 文件前，必须先把这个外部引用面确认清楚，否则会造成静默断链。

**策略三：dry-run 默认，写入显式**

这是项目已有的优秀惯例（飞书写入需要 `--apply` + 精确 `--confirm-*`），治理期间必须保持放大：所有重构后的飞书路径，先用历史数据跑 dry-run，与重构前的 dry-run 输出逐字段比对，一致后才做一次受控真实写入验证。

**策略四：回执快照与回滚锚点**

每个阶段开始前，对当前 HEAD 打 tag 并归档关键回执（`evidence/verification-receipt-20260904.json` 等）。阶段内每个子批次结束时生成新的回执快照。回滚粒度是子批次，不是阶段。

**策略五：数据层零变更**

治理期间不动 PostgreSQL schema（`xws_adaptive_runs` / `parts` / `manifests`）、不动飞书字段结构、不动幂等键。这条是硬约束——一旦数据层变更混进重构批次，回滚将不再安全。

---

## 五、验证与门禁设计

把 `docs/standards/README.md` 第 7 节已有的分层验证表落成可执行命令。

| 层级 | 触发时机 | 命令 | 是否需要外部系统 |
| --- | --- | --- | --- |
| L0 语法 | 每次提交 | `node --check <changed .mjs>` | 否 |
| L1 离线自检 | 每次提交 | `npm run test:offline` | 否 |
| L2 单元 | 每个 PR / 每批 | `npm run test:unit` | 否 |
| L3 runtime 回归 | 每个 PR / 每批 | `npm run test:runtime` | 否 |
| L4 集成 | 合并前 | `XWS_TEST_DATABASE_URL=... npm run test:integration` | PostgreSQL |
| L5 XWS 全量 | 合并前 | `XWS_TEST_DATABASE_URL=... node --test skills/xws-export-market-analysis/tests/*.test.mjs` | PostgreSQL |
| L6 真机 | 阶段验收 | 冻结入口 + `--apply` + `--confirm-*` + 回读 | Edge + Proxy + 飞书 |

关键约定：
- L4/L5 缺环境变量时必须报 skipped 而非静默通过（当前 XWS 回执里 `postgresql_integration_tests_skipped: 0` 是好惯例，要固化成机制）。
- L6 不进 CI，但每次执行必须产出回执并归档，回执里记录 `browser.id` 断言结果、HEAD、diff 哈希。
- 每阶段退出条件必须包含"上一阶段的证据仍成立"——即回归不倒退。

---

## 六、治理自身的风险（反模式警告）

写在这里，是因为历史上这类治理最容易在以下几个点上翻车：

1. **把治理做成大爆炸重构。** 一次性搬空 `runtime/` 必然破坏冻结运行面。坚持"每批 ≤10 文件 + 每批验证"。
2. **为了测试变绿而改测试。** P1 阶段 `test:runtime` 首跑必有失败。正确做法是登记已知失败，而不是改断言迁就实现。改断言等于把债从一个地方挪到证据里，更糟。
3. **在重构批次里顺手改业务语义。** 例如顺手"优化"飞书公式、顺手统一字段名。这类改动会让回滚不再安全，也让验证结论失去意义。
4. **用假验收结束 P3。** 内存演示、进程内 worker 替换、SDK handler 调用都不能证明真实恢复。这一条 `agent-runtime/CLAUDE.md` 自己已经写得非常清楚，照做即可。
5. **忽视项目外消费者。** `D:\codex\skills\sycm-*` 等目录联接是真实存在的调用面，搬移文件前必须确认。
6. **忽略本机环境约束。** 该机器对含中文路径的批量删除采取 fail-closed 策略，且本项目大量路径含中文（`E:\小红书\.env.local`、运行目录中的 `20260904113057-浴缸`）。清理与搬移操作必须小批量、显式路径、逐个校验，避免触发守卫或被误拒。
7. **文档与代码各自治理。** 本项目文档治理水平很高（架构、规范、知识、SKILL 四层明确），风险恰恰是改代码时不回头更新文档，造成第二轮漂移。约定：任何触及契约的改动，同批次更新对应文档段落。

---

## 七、建议排期与里程碑

按依赖关系给出顺序，不绑定具体日期（取决于可投入人力）：

| 里程碑 | 内容 | 完成标志 |
| --- | --- | --- |
| M1 | P0 全部完成 | `git status` 可解释；根目录干净；版本号三处一致 |
| M2 | P1 全部完成 | 干净机器一条命令通过离线验证；CI 跑起来；回执可自动重建 |
| M3 | P2.1 完成 | 飞书鉴权实现 27 → 1 |
| M4 | P2.2 + P2.3 完成 | `skills → runtime` 反向依赖 = 0；入口按生命周期分类 |
| M5 | P3 验收补齐 | 5 项验收各有真实证据 |
| M6 | P3 真机单分片 | 端到端通过并产出 Publication Receipt |

M1 与 M2 可以立即启动，且不依赖任何人做架构决策，建议先做，因为它们能立刻降低接手成本且零业务风险。M3 之后需要先确认项目外调用面与 `table_geometry` 归属两个决策点。

---

## 八、一页速览

| 债类 | 代表证据 | 主要影响维度 | 归属阶段 |
| --- | --- | --- | --- |
| 架构与边界 | skills↔runtime 双向依赖；runtime 无治理身份；29 行 fake adapter | 可维护性 极高 / 稳定性 高 | P2 / P3 |
| 代码质量 | 27 份飞书鉴权实现；168 入口无生命周期标记 | 稳定性 高 / 可维护性 极高 | P2 |
| 依赖管理 | `docx` 未声明且缺失；`table_geometry` 在仓库外 | 可维护性 高 | P1 |
| 测试缺失 | 98 测试文件但 0 个全仓入口 | 稳定性 高 | P1 |
| 配置与可移植性 | 6 处硬编码绝对路径/凭据默认值 | 可维护性 高 | P0 / P2.2 |
| 文档与治理 | 版本号三处不一致；受治理文档未提交 | 可维护性 高 | P0 |
| 环境与产物 | `$d/`、`tmp-*-xlsx/`、`.codegraph/` 20MB 未忽略 | 可维护性 中 | P0 |

治理的总策略一句话：**先让状态可信（P0），再让环境可复现（P1），然后才动结构（P2），最后才上平台（P3），全程不碰数据层、不动冻结运行面。**
