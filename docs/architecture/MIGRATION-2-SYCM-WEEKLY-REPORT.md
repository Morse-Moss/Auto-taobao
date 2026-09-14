# 迁移 2 报告：通用两段式运行器 + sycm.feishu.weekly 迁移

日期：2026-09-14
编号说明：本报告按 **首批流程迁移顺序**（implementation-plan 第 5 节）。迁移 1 是 `xws.feishu.import`（见 PHASE5-REPORT 系列），本次是**迁移 2**，对应迁移顺序里的第 5 项（SYCM → Feishu）。
范围：把「两段式」从一条能力的专用脚本，提升为**能力无关的运行时驱动**，并用它完成第二条能力的迁移。
状态：已落地并有测试证据；发布段仍未对真实 base 执行过（见第 5 节）。

## 1. 为什么要先做「通用运行器」而不是直接抄第二份迁移

迁移 1 的 `run-feishu-import-two-stage.mjs` 是**专用**运行器：采集输入、验证器合同、发布钩子全部硬编码在文件里。若每条能力都照抄一份，阶段 3 的验收标准「新 Skill 可只新增目录、manifest、实现和测试，不修改核心 Runtime」就形同虚设——每迁移一条能力都要改一次 Runtime。

因此本次的关键决策是：**先抽出能力无关的两段式驱动，再让第二条能力成为它的第一个真实用户**。这样每条能力的迁移成本降到「一个 adapter 文件 + 一个 manifest 入口」。
（迁移 1 的专用运行器保留不动，作为人工运维入口；两套并存，不互删。）

## 2. 架构设计：通用两段式运行器

`runtime/sop-runtime/two-stage-runner.mjs`，把两段式固化成固定的六步：

```
ADMIT → (HUMAN GATE) → COLLECT(Worker + 采集期验证器) → VALIDATED
      → PUBLISH(Publisher + 发布期验证器) → VERIFIED → ADVANCE CURSOR
```

能力需要提供三样东西：

1. `manifest`：声明副作用与验证器集合（唯一事实来源，运行器不重复判断）；
2. 实现模块导出 `adapter`（采集段 7 方法契约）；
3. 若声明了外部写副作用，再导出 `createPublisher(...)`（发布段钩子工厂）。

### 关键决策

**D1 — 发布钩子工厂用约定导出名 `createPublisher`，缺工厂即 fail-closed。**
运行器按 `PUBLISH_HOOK_MISSING` 直接报错，不允许「声明要写外部但找不到实现」时静默跳过发布。理由：静默跳过会把 `NOT_REQUESTED` 伪装成「已完成」，而这是整条链上最危险的一种假成功。

**D2 — 采集段与发布段用不同的副作用集合准入。**
采集段准入只声明 `collectSideEffects(manifest)`（= manifest 副作用减去外部写类），因此**默认 dry-run 模式不会触达人工闸门**；`--commit` 才按 manifest 完整副作用准入 → 高风险 → 开闸 → 必须有 `--operator`。副作用集合由运行器从 manifest 推导，调用方不能通过传参放大或缩小。

**D3 — 能力自描述采集合同。**
运行器先装载实现模块，调用它导出的 `collectContract()` 拿到 `requiredFields` 等，再装配 Worker。这样调用方不需要替每条能力维护一份字段清单（迁移 1 的做法是在运行器里 import `XWS_HEADERS`，属于能力知识外泄）。

**D4 — 采集段与发布段之间只通过工件字节传递数据。**
发布段从证据库落盘的工件字节重建输入，不读采集段的进程内状态。这是跨进程恢复能成立的前提，也是「发布段不依赖一次成功的采集进程是否还活着」的唯一保证。

**D5 — 游标推进量取自已验证的证据，不取调用方口述。**
`end = expectedRows ?? evidence.rowCount`，且 `advanceCursor` 自身还会校验 `evidenceStatus=VALIDATED` 与 `publicationStatus∈{VERIFIED, NOT_REQUESTED}`。

**D6 — 支持 `--database-url` 走真实 PG。**
默认内存 store（dry-run 不需要持久化），但允许直接跑在权威库上，避免「只在内存里好看」的验收。

## 3. sycm.feishu.weekly 的迁移设计

新增 `skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs`，manifest 入口从 CLI 换成本文件，版本 1.0.0 → 1.1.0。

**采集段（COLLECT，无外部写入）**：SYCM 导出（浏览器读 + 本地工件）→ 源文件对证明（7 天窗口、行数、连续排名）→ 解析源行 → 产出 `sycm-weekly-source-v1` 工件。

工件把**源行本身**嵌进字节，因此发布段不依赖原始 CSV 是否还在；同时把 `source.csv/xlsx` 路径带在工件里，让写入端（CLI）再验一次源文件对——这是刻意的纵深防御：路径失效时**响亮失败**，而不是静默写入不确定的数据。

**发布段（PUBLISH，有外部写入）**：
1. `copy-weekly-table.mjs` 克隆上周周表（保留字段与公式结构，不带记录）；
2. `update-weekly-base.mjs` 把本周源行写入新周表；
3. 回读新表与历史表记录数与摘要。

### 关键决策

**D7 — 明确划出「第二个发布单元」的边界。**
周更 SOP 在「克隆 + 导入」之后还要等飞书 AI 结算，再跑 `sync-decision-history`。那是**第二个发布单元**，依赖一个非确定性的外部结算过程，不能塞进同一次 publish（一次 publish 只能覆盖一个确定性外部写入 + 一次回读）。本文件只覆盖第一个，第二个仍走 CLI 人工阶段。
把这条写进 manifest description 与报告，是为了防止后续审查者把「迁移没做完」与「架构上不该合并」混为一谈。

**D8 — 写入端沿用已测 CLI，不重写业务逻辑。**
`copy-weekly-table` 与 `update-weekly-base` 本身已有完整测试（含 mutation guard、字段合同、幂等重跑）。发布段以子进程调用它们并带全部确认参数（`--confirm-base` / `--confirm-weekly-table`），而不是在 adapter 里重写一遍飞书写入。理由：这次迁移的目标是**改变编排与验收方式**，不是重写业务；重写会把风险引到已验证的代码上。

**D9 — 回读必须指定 `weeklyTableId`，不允许用「其他表」冒充验收对象。**
缺 `weeklyTableId` 即抛错。否则「随便读一张表发现行数对得上」就能骗过验收。

**D10 — 从 manifest 的 validation 里移除 `relations`。**
`relations` 验证的是跨实体关系（主表 ↔ SKU 表），而本能力的采集工件是扁平的周关键词行，没有关系可校验。它在无 `contract.relations` 时是空转 no-op——保留一个永远不生效的声明，会让审查者以为关系已被校验。移除并在此说明。
周表与历史表的关系由发布期回读（行数 + 摘要）承担，不靠 `relations`。

**D11 — 采集工件把身份键抬到工件对象表面。**
`structure` 验证器只看**工件对象**的键，而 `schemaVersion/capability/capabilityVersion/fields` 原本只存在于字节内部。首版 `collectContract()` 声明的键根本不在被校验对象上（测试当场抓到），等于空转校验。现在工件对象表面持有这些身份键 + 5 个源字段非空计数，字节内部的 `expected/source/target/rows` 由 `adapter.validate` 负责——两层各管一层，不重复也不落空。

## 4. 本次跑出来的真实缺陷（都已修）

1. **`collectContract().requiredFields` 声明的键不在被校验对象上**（见 D11）。测试 `collectContract 的 requiredFields 与工件实际键一致` 直接抓到——这正是把合同写成能力自描述之后才可能被发现的一类错误。
2. **`side-effect-ledger.reconcileUnknown` 绕过 `keyOf`**：第 98 行直接读 `record.commit_key`，而端口契约是 camelCase，内存 store 上会得到 `commitKey: undefined`——「需要人工对账」的收据丢掉唯一的定位键。已改走 `keyOf(record)`。这是 pg-store camelCase 归一化那批缺陷的**同源残留**（只修了主路径，漏了对账分支）。
3. manifest 首版写了两个不在受控词表里的取值（`outputs[].type = "json"`、`preconditions` 里的 `sycm_export_access`），被注册期校验拦下。已改为 `artifact_ref` 与 `logged_in_seller`。
4. 测试期望写错一处：manifest 声明未实现的验证器，应归 `CAPABILITY_DEGRADED`（能力定义坏了、停用该版本），而不是 `EVIDENCE_INVALID`（这次证据不合格、去重采）。归错会让人修错东西。实现未改，修正的是测试期望。

## 5. 验收结果

```
node --test runtime/sop-runtime/*.test.mjs
# tests 175  pass 175  fail 0      （+two-stage-runner 15）
node --test skills/sycm-to-feishu-base/tests/*.test.mjs
# tests 71   pass 71   fail 0      （+adapter-feishu-weekly 13）
node --test skills/xws-to-feishu-base/tests/*.test.mjs
# tests 84   pass 84   fail 0
node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 8 manifest 通过；sycm.feishu.weekly@1.1.0 已登记
# registryDigest=sha256:18bc50e9…4cf6（因 manifest 变更而变，属预期）
```

新增文件：
- runtime/sop-runtime/two-stage-runner.mjs + two-stage-runner.test.mjs
- skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs
- skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs

修改文件：skills/sycm-to-feishu-base/manifest.json（entry/version/validation）、runtime/sop-runtime/side-effect-ledger.mjs（keyOf 修正）。

## 6. 仍未做（必须如实列出）

- 发布段从未对真实 base 执行过 `--commit`。`handler` 的非 dry-run 分支、`readBack` 的默认 FeishuApi 实现都只有单测覆盖；真实飞书访问需要单独授权 + 一个可写的目标表 + 一次可回滚的空表准备。
- 第二个发布单元（飞书 AI 结算后的 `sync-decision-history`）没有纳入两段式，仍走 CLI 人工阶段；这是刻意的架构边界（D7），不是遗漏。
- 迁移 1 的专用运行器尚未改用通用运行器（保留为人工入口）。
- 迁移顺序里的其余项（FAQ fan-out、XWS SKU、SYCM 搜索排行、灰豚周度、Agent Planner/Reviewer）尚未开始。
