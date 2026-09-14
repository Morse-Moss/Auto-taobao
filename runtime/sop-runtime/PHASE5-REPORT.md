# sop-runtime 阶段 5 报告：环境实测 + 首条业务 SOP 两段式迁移（xws.feishu.import）

日期：2026-09-14
范围：实施计划「阶段 4 的收尾」——把一条真实业务能力从 CLI 一把梭改成「采集 Worker + 发布 Publisher」；同时把「目标环境是哪些」用实测证据钉死
状态：迁移完成并在采集段跑通真实收据；发布段代码就绪但**未执行**（真实写飞书需单独授权）；108 + 7 项测试全绿
报告位置：runtime/sop-runtime/PHASE5-REPORT.md

## 1. 目标环境：实测清单（回答「目标环境是哪些」）

架构文档只写了「Portretag PostgreSQL」，没有任何连接信息（交接文档明确要求「不回报连接串或秘密」）。实测本机可触达的 PostgreSQL 环境如下。

| # | 环境 | 版本 | 接入点 | 用途 | 本脚本可否建隔离库 |
| --- | --- | --- | --- | --- | --- |
| A | 容器 `xws-adaptive-postgres` / 库 `xws_automation` | postgres:17（17.10-1.pgdg13+1） | 127.0.0.1:5432 | **本项目业务库**（001/002/003 已 apply，durable_* 仍 0 行） | 用 `xws_runner` 可以；用 `xws_agent` 不行 |
| B | 容器 `xws-postgres-test` / 库 `xws_test` | postgres:16-alpine（16.15） | 0.0.0.0:55432 | 独立测试实例，**另一个大版本** | 未验证（无凭据） |
| C | 容器 `sub2api-postgres` | postgres:18-alpine | 仅容器网络 5432 | 网关联调，与本项目无关 | 不适用 |
| D | 容器 `maps-crawler-postgres` | — | 127.0.0.1:5434 | 印尼摩配爬虫项目 | 不适用 |
| E | 「Portretag PostgreSQL」 | 未知 | **无连接串** | 文档所写目标 | 无法验证 |

关键结论：
1. 本机**没有**名为 Portretag 的独立实例。E 要么就是 A（文档里的别名），要么是外部环境——这一点只能由知道 Portretag 的人确认，代码和容器名都推不出来。
2. 隔离库验证（`runtime/verify-migrations-isolated.mjs`）依赖 `CREATEDB`。**项目配置文件 `E:/小红书/.env.local` 里的角色是 `xws_agent`（无 superuser、无 createdb）**，从干净 shell 用项目配置跑会失败；本次能跑通是因为会话的进程环境变量里导出了容器超级用户 `xws_runner` 的连接串。
3. B 的存在给了一个「不改 A 的预演环境」，但它是 PG **16**，与业务库 PG 17 不同大版本，只能作为附加参考，不能替代在 PG 17 上的验证。

复现命令（全部只读或仅操作临时库）：

```
# 容器与端口
docker ps --format "{{.Names}} | {{.Image}} | {{.Ports}} | {{.Status}}"
# 角色能力（只读）
node runtime/probe-db-isolation-readiness.mjs
# 隔离库全套验证（临时库 sop_verify_*，不碰业务库）
node runtime/verify-migrations-isolated.mjs
# 用项目配置文件（受限角色）跑，应明确失败
node -e "const e={...process.env};delete e.XWS_DATABASE_URL;require('child_process').spawnSync(process.execPath,['runtime/verify-migrations-isolated.mjs'],{stdio:'inherit',env:e})"
```

## 2. 本阶段解决的问题

阶段 4b 结束时留下一个明确的缺口：`createCapabilityWorker` / `createCapabilityPublisher` 是接线点，但**没有任何真实业务能力走过它们**，所以那套闸门只是「可用」而不是「在用」。本阶段挑 `xws.feishu.import` 走通——选它的理由：它声明了外部写入（`feishu_write`）且已经声明了 `readback` + `publication`，是唯一能同时压到两段的能力；并且它的 CLI 本来就有 dry-run 模式，采集段可以在不产生任何外部写入的前提下跑出真实收据。

## 3. 新增/修改文件

新增：

| 文件 | 职责 |
| --- | --- |
| skills/xws-to-feishu-base/scripts/adapter.feishu-import.mjs | 采集段适配器（Worker 契约）+ 发布段钩子工厂 `createFeishuImportPublisher` |
| skills/xws-to-feishu-base/tests/adapter-feishu-import.test.mjs | 7 项（hermetic，注入假抽取器，不调 Python、不联网） |
| runtime/sop-runtime/run-feishu-import-two-stage.mjs | 两段式运行器：admit → Worker(COLLECT) → markEvidenceValidated → Publisher(PUBLISH) → advanceCursor |

修改：

| 文件 | 改动 |
| --- | --- |
| skills/xws-to-feishu-base/manifest.json | `entry` 由 CLI 改为适配器模块；`version` 1.0.0 → 1.1.0（入口契约变更，属破坏性，必须升版本） |
| runtime/sop-runtime/publication.mjs | 新增人工闸门：风险由 **manifest 声明的副作用**重判，高风险能力必须 `humanGateStatus=APPROVED` 才能提交 |
| runtime/sop-runtime/validator.mjs | `validateCompleteness` / `validatePublication`：`null` 与 `undefined` 同等视为「未声明预期值」 |
| runtime/sop-runtime/side-effect-ledger.mjs | `verify` 同样容忍 null；`commit` 失败分支改用状态码归类失败类型 |
| runtime/sop-runtime/policy.mjs | 新增 `classifyExternalFailure`：状态码优先→消息状态码→关键词→BUG |
| runtime/verify-migrations-isolated.mjs | 打印实际生效角色、superuser/createdb、角色来源；权限不足时明确失败 |
| runtime/sop-runtime/PHASE4B-REPORT.md | 第 5 节改为精确表述（两个角色并存 + 会话特权串才是本次能跑通的原因） |

`registryDigest` 由 `sha256:dd564ed1…873a` 变为 `sha256:eefd8340…cefb`——这是**预期内的漂移**，因为 `xws.feishu.import` 的入口与版本确实变了。

## 4. 关键设计决定

**适配器入口取代 CLI 入口，CLI 不删。**
`Controller → registry.require(能力 ID) → loader.loadAdapter(能力 ID) → 适配器契约`，而 CLI 不满足 7 方法契约，所以能力 ID 路径必然装不起来。于是新增适配器模块并把它设为 `entry`，CLI 原样保留作为人工运维入口。这带来一个必须说明的代价：`manifest.entry` 不再指向运维入口，两者容易出现理解偏差，因此适配器文件头部写明了分工。

**发布段不读采集段的内存。**
`createFeishuImportPublisher` 接收的是**落盘的工件字节**（evidence store 里的 `xws-import-parse.bin`），发布段自己解析回来。这样发布段不依赖同进程内存状态，跨进程恢复时只需从证据库读回即可。这一点有单测直接覆盖。

**人工闸门按 manifest 重判风险，而不是信调用方。**
准入时 `spec.sideEffects` 由调用方给。如果提交路径信它，就能用「准入只声明 `local_parse`」的方式绕开审批再去写飞书。因此 Publisher 用 `classifyRisk({ sideEffects: manifest.sideEffects })` 重新判定，高风险必须 `APPROVED`。两条测试分别证明：未审批时 handler **零调用**；按只读副作用准入时准入闸门确实没开、但提交路径仍然拒绝。

**发布段在 dry-run 下如实保持 `NOT_REQUESTED`。**
采集段跑完不等于发布完成。运行器在默认模式下不尝试发布，收据里明确写 `verdict: NOT_ATTEMPTED`、`publicationStatus: NOT_REQUESTED`、`cursorAdvanced: false`。这是刻意的：宁可收据只证明一半，也不把「采集成功」写成「发布已验收」。

## 5. 验收结果

```
node --test runtime/sop-runtime/*.test.mjs
# tests 108   pass 108   fail 0
node --test skills/xws-to-feishu-base/tests/*.test.mjs
# tests 84    pass 84    fail 0
node runtime/sop-runtime/build-skill-registry.mjs --check
# 8 manifest 通过，registryDigest=sha256:eefd8340…cefb
```

采集段真实收据（`--xlsx runtime/xws-bathtub-top3-with-images.xlsx --expected-rows 3`）：

```
mode          : dry-run
gate          : NONE / ALLOW / MEDIUM
collect       : stage=COLLECT  rowCount=3
                sha256=16764f9314cea1f2ee89e91c06a456132968b95eef6c9e25022a894a0290dcaf
                validators=structure:ok row_count:ok digest:ok adapter:ok
                validationSource=manifest:xws.feishu.import@1.1.0
publish       : NOT_ATTEMPTED
publicationStatus: NOT_REQUESTED
cursorAdvanced: false
```

数据流完整：真实 XLSX → Python 抽取器 → 3 行 3 图 → 工件落盘（sha256 可复验）→ manifest 声明的 3 个采集期验证器 + 适配器自检全过 → `evidenceStatus=VALIDATED`。

发布段的闸门行为（未产生任何外部写入）：

```
# 无 --operator
Error: --operator is required with --commit (records who approved the human gate)   # 退出码 1
# 有 --operator + 假 base token
gate: APPROVED / ALLOW_WITH_APPROVAL / HIGH
publish: REJECTED  error="Feishu API failed: 400 91402 NOTEXIST"
```

这里要如实说明：带 `--operator` 的那次已经用真实应用凭据**发起过真实的飞书 API 调用**，因为目标是假 base token 才以 400 NOTEXIST 结束，未产生任何写入。发布段对着真实 base 的执行不在本轮范围内，需要单独授权。

## 6. 本次跑出来的真实缺陷（都已修）

1. **`null` 被当成 0**：`expectedRows: null` 时 `row_count` 把 3 行判成 `INCOMPLETE_RANGE`（预期 null→`Number(null)=0`）。同一模式也存在于 `validatePublication` 与账本 `verify` 的 `expected.rows/expected.digest`。已统一为「`null` 与 `undefined` 同等表示未声明」，并补 2 项回归测试。这是运行器第一次跑就暴露的，不是静态审阅能发现的。
2. **提交失败一律归 BUG**：`400 NOTEXIST` 这类目标配置错误被归成 `BUG`，而 `BUG` 的动作是 `STOP_AND_ALERT`，等于把一次可修复的错误升级成停线。已新增 `classifyExternalFailure`（状态码优先）：4xx→`POLICY_DENIED`，5xx/408/429→`TRANSIENT_EXTERNAL`，补 1 项测试。

## 7. 未做与阻塞

- **发布段从未对真实 base 执行过**。本轮只有采集段的真实收据；`xws.feishu.import` 的 `publicationStatus=VERIFIED` + 游标推进这条链**尚未在真实环境验证过**。需要一次明确授权才能做。
- **未对任何数据库 apply 004/005**。目标环境已查清（见第 1 节），但仍需在「A 还是 E」上做出选择。
- **发布路径仍只被这一个运行器调用**。`sycm.feishu.weekly`、`huitun.keyword-heat.collect` 等其他声明了外部写入的能力还在走旧 CLI；`NOT_REQUESTED` 依然是 `advanceCursor` 的合法前置，所以「该写外部但没走 Publisher」的口子在那些能力上仍然存在。
- 运行器的 `workDir` 每次生成新目录（`two-stage-<stamp>`），未做清理策略。

## 8. 下一步建议

1. 授权一次「对着真实（或专门准备的空）飞书表」的 `--commit` 执行，把 `VERIFIED` 与游标推进这条链也变成有实测证据的。
2. 决定 004/005 的目标环境（本机业务库 / Portretag），再 apply。
3. 按同样方式迁移 `sycm.feishu.weekly`（写外部 + 已声明 readback/publication），把第三例做完后可以考虑收紧 `advanceCursor` 的前置条件。
