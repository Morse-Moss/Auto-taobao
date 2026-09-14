# sop-runtime 阶段 4b 报告：发布/回读路径接线（PUBLICATION 阶段验证器）

日期：2026-09-14
范围：实施计划「阶段 4：Validator 和 Adapter 收敛」的后半部分（发布期验证器接入提交/回读路径）
状态：代码已实现，103 项单测全绿；真实 8 个 manifest 的 Registry 校验通过；未触碰数据库与外部系统
报告位置：runtime/sop-runtime/PHASE4B-REPORT.md

## 1. 本阶段解决的问题

阶段 4a 把 manifest 声明的**采集期**验证器接进了 Worker。发布期两个验证器（`publication`、`readback`）当时只有实现和单测，**没有任何运行时路径会调用它们**。

后果不是「少做一次校验」，而是一个可被触发的漏洞：`advanceCursor` 只要求 `publicationStatus ∈ {VERIFIED, NOT_REQUESTED}`。一个声明了 `feishu_write` 却没有发布期验证器的能力，发布轴会一直停在 `NOT_REQUESTED`，于是**游标在从未验收的对外写入上推进**。三份真实 manifest（`huitun.keyword-heat.collect`、`sycm.feishu.weekly`、`xws.feishu.import`）都声明了 `feishu_write`，这三条路径都暴露在这个漏洞下。

本阶段做了两件事：把发布期验证器接进一条真实的提交/回读路径；把「写外部 ⇒ 必须有发布期验证器」变成不可绕过的义务。

## 2. 新增/修改文件

新增：

| 文件 | 职责 |
| --- | --- |
| runtime/sop-runtime/publication.mjs | `createCapabilityPublisher`：副作用闸门 → 幂等提交 → 真实回读 → manifest 发布期验证 → 结算发布轴 |
| runtime/sop-runtime/publication.test.mjs | 18 项 |

修改：

| 文件 | 改动 |
| --- | --- |
| runtime/sop-runtime/workflow-controller.mjs | 新增发布轴三个状态转移：`markPublicationReady`、`markPublicationCommitted`、`settlePublication`（VERIFIED / UNKNOWN / REJECTED） |
| runtime/sop-runtime/skill-manifest.mjs | 新增 `PUBLICATION_VALIDATION_NAMES`（由 Validator 实现表的 stage 派生）与 `PUBLICATION_VALIDATOR_MISSING` 义务校验 |
| runtime/sop-runtime/side-effect-ledger.mjs | `commit()` 失败分支透传 `failureClass`，发布路径据此区分重试与终止 |
| runtime/sop-runtime/index.mjs | 出口补 publication |
| runtime/sop-runtime/skill-registry.test.mjs | 夹具 `xws.publish` 补 `readback`（新义务命中既有夹具）；新增 Registry 级义务用例（13 → 15 项） |
| runtime/sop-runtime/PHASE4-REPORT.md | 追加第 8 节：更正被实测推翻的「角色无 CREATEDB」结论 |

## 3. 关键设计决定

**发布轴不新增取值。**
`PUBLICATION_STATUS` 的五个值已经被 005 的 `durable_runs_publication_status_check` 约束死。所以「确定性拒绝」不能图省事塞进 UNKNOWN：效果**确定未发生**，回来标 UNKNOWN 会毒化对账语义（对账只处理「无法判定」）。本阶段的映射是：

- 提交成功 → `markPublicationCommitted` → `COMMITTED`
- 回读 + 验证器全过 → `settlePublication(VERIFIED)` → `VERIFIED`，`nextAction=ADVANCE_CURSOR`
- 回读失败 / 收据不符 / 验证器失败 → `settlePublication(UNKNOWN)` → `UNKNOWN` + blocker `COMMIT_UNKNOWN`，`nextAction=RECONCILE_COMMIT`
- 确定性拒绝 → `settlePublication(REJECTED)` → **发布轴回退到 `READY`（未提交即未发布）**，执行轴按 `actionForFailure` 走重试/回队列/人工/终止

**验证器的顺序说明了它为什么必须单独一段。**
`publication` / `readback` 需要外部回读收据，采集完成时还没有。所以 `buildValidatorsFromManifest` 带 `stage`，Worker 只跑 COLLECT，发布期跑在 `publisher.publish()` 里。两段混跑会让声明了 `readback` 的能力在采集期被误判为「证据无效」——这正是阶段 4a 里没有接线、也没有硬凑的原因。

**义务挂在 manifest 上，闸门有两道。**
`skill-manifest.validateManifest` 新增：`kind=capability` 且声明了外部写副作用（`feishu_write` / `external_publish` / `paid_provider_call` / `postgres_write`），必须同时声明 `publication` 或 `readback`，否则注册期报 `PUBLICATION_VALIDATOR_MISSING`。运行时 `publisher.assertPublicationDeclared()` 再兜一道，用 stub registry 绕过注册期校验也放不过。只约束 capability 不约束 adapter：发布验收是能力层的责任，`adapter.feishu` 声明 `feishu_write` 但不应被要求声明发布期验证器。

**发布期验证器名单必须与实现表同源。**
`PUBLICATION_VALIDATION_NAMES` 从 `validationStageOf()` 派生，不在 skill-manifest 里手抄一份 `['publication','readback']`。否则哪天给验证器改阶段，会出现「校验说属于发布期、运行时按采集期跑」的分裂。

**结论由「账本判 + manifest 判」共同决定，不是二选一。**
账本的 `verify` 只管行数/摘要/`verifiedAt` 这些机械条件；manifest 声明的验证器管业务契约。任何一方不过就 UNKNOWN。专门写了对照测试证明这一点（见下）。

## 4. 验收结果

```
node --test runtime/sop-runtime/*.test.mjs
# tests 103   pass 103   fail 0
```

（84 → 103：本阶段新增 `publication.test.mjs` 18 项，`skill-registry.test.mjs` 新增 Registry 级义务用例 1 项。阶段 0 的 27 项、阶段 3 的 38 项、阶段 4a 的 19 项全部保留并通过；`skill-registry.test.mjs` 中 1 个既有夹具因新义务补了 `readback` 字段，断言未改。）

```
node runtime/sop-runtime/build-skill-registry.mjs --check
# 发现 manifest 8 个，注册条目 8 个（能力 6，适配器 2）
# 验证器实现 11 个：采集期 9，发布期 2
# 告警 5 项（均为 adapter.browser 显式外部依赖）
# Registry 校验通过，registryDigest=sha256:dd564ed1…873a
```

`registryDigest` 与阶段 4a 完全一致——本阶段没有改动任何 manifest，只加了约束；三个声明 `feishu_write` 的能力本来就已声明 `readback`，因此新义务零命中。

**可证伪的两组对照测试（本阶段的关键证据）：**

1. 同一份回读收据（`rows=10`，与账本 `expected.rows=10` 一致），契约里 `readback.rows=99`：
   - manifest 声明 `readback` 时 → `UNKNOWN` + `PUBLICATION_UNVERIFIED`；
   - manifest 只声明 `publication` 时 → `VERIFIED`。
   同一个缺陷，因声明不同而结论不同，排除了「其实是硬编码在拦」的解释。
2. `PUBLICATION_VALIDATOR_MISSING`：声明 `feishu_write` 且 `validation: ['structure']` → 拒绝；同样声明但 `validation: ['structure','readback']` → 通过。排除「只要看到 feishu_write 就一律拒绝」。

## 5. 顺带查实的环境事实（与本阶段无关，但阻塞了下一步）

阶段 4a 报告写的「角色 xws_agent 无 CREATEDB、无法做隔离库验证」经实测**只对了一半**，需要更精确的表述（2026-09-14 二次核验）：

- 本机 PostgreSQL 跑在 Docker 容器 `xws-adaptive-postgres`（postgres:17，映射 127.0.0.1:5432），库内存在**两个角色**：
  - `xws_agent`：rolsuper=false、rolcreatedb=false —— 项目配置文件 `E:/小红书/.env.local` 用的就是它。
  - `xws_runner`：rolsuper=true、rolcreatedb=true —— 容器的 `POSTGRES_USER`，即超级用户。
- 隔离验证之所以能跑通，是因为**本次会话的进程环境变量里导出了 `xws_runner` 的连接串**；脚本用 `{ ...envFile, ...process.env }`，进程环境覆盖了文件。换句话说：用项目配置文件从干净 shell 跑，会因为 `xws_agent` 无 CREATEDB 直接失败。
- 已据此加固 `runtime/verify-migrations-isolated.mjs`：先打印实际生效角色、superuser/createdb 与「角色来源（进程环境变量 / env 文件）」，权限不足时给出明确错误而不是含糊报错。实测两条路径：
  - 有会话特权串 → `实际生效角色: xws_runner superuser=true createdb=true`，17/17 通过；
  - 清掉会话变量、只用 env 文件 → `实际生效角色: xws_agent superuser=false createdb=false`，明确失败并提示改用有 CREATEDB 的角色。
- 004 首次隔离执行**暴露过真实缺陷**：`architecture.phases` 的 7 行种子把 `risks`/`exit_criteria`（jsonb）写成纯文本，报 `invalid input syntax for type json`。已修正为 JSON 数组。
- 修正后隔离验证 **17/17 通过**（语法 / 幂等 / CHECK 约束 / 默认值 / rollback / rollback 后重放），临时库 `sop_verify_*`，业务库 `xws_automation` 全程未被写入。
- 仍未对任何真实环境 apply。

## 6. 未做与阻塞

- **发布路径尚未由 Workflow 调用。** `createCapabilityPublisher` 是接线点，真实业务 SOP（竞品周更、FAQ、XWS 导入）仍走旧 CLI，没有改成「采集 Worker + 发布 Publisher」两段式。Workflow 层的义务是：在 `nextAction=COMMIT` 时调用 `publish()`，并且只有在 `VERIFIED` 之后才调 `advanceCursor`——这一步没搬完之前，漏洞只是**新增了可用的堵法**，不是**已经堵死**。
- **`NOT_REQUESTED` 仍是 `advanceCursor` 的合法前置。** 对「其实该写外部但 Publisher 从未被调用」的路径，游标仍可推进。彻底堵死要么靠 Workflow 强制调用，要么把 `NOT_REQUESTED` 从允许集合里去掉（但那会破坏所有纯采集跑法）。当前选择保留，并明确记录为 Workflow 层义务。
- 004/005 仍未 apply；apply 前需确认目标环境。
- xws-sku-collection / xws-faq-operator 仍未登记 manifest。

## 7. 下一步建议

1. 用一个真实业务 SOP 走两段式：admit → `createCapabilityWorker.runOnce` → `createCapabilityPublisher.publish` → `advanceCursor`，产出前后对照收据。建议先做 `xws.feishu.import`（写外部、已声明 `readback`+`publication`，且在干跑模式即可验证）。
2. 确认 004/005 的目标环境并 apply，然后用 pg-store 重跑垂直切片与真实跨进程故障注入。
3. 把 `xws-sku-collection` / `xws-faq-operator` 迁到 Adapter/Workflow 契约后补 manifest。
