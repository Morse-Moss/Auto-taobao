# 竞品周更全流程监督报告

周期 2026-09-13 ~ 2026-09-19 ｜ 监督执行 2026-09-16（GMT+8）｜ 监督人：WorkBuddy（流程外监督）

---

## 0 结论先行

1. **8 步全部有终态，本周交付物已就绪并已线上回读验证。** 周表 1417 行；历史总表本周期 1417 行；仪表盘 B 榜由 0 条变 1 条。
2. **本次修掉的是链路上唯一缺失的写入方**（五列属性），并因此必须补跑一步——**历史总表重发布**。这两件事是因果链：属性写回改了源，发布是把源搬进仪表盘的唯一通道，不重发布仪表盘就看不到修好的结果。
3. **剩下唯一的硬阻塞是「飞书开放 API 无法创建 Lookup(type 19) 字段」**，不是脚本写错。三种 property 变体全部返回 `99992402 field validation failed`。
4. **真正「不稳定」的只有一个环节：第 6 步 SKU 富化**（依赖买家账号登录态 + 真实商品页 + 平台风控）。它值得接 agent，但接法是**把仓库里已有的提案层接上一个真实调用方**，不是新造一套 agent 系统。
5. 「一个月没跑通」和「一两天跑通」都不奇怪：跑通一天靠的是一次性人工补位；一个月卡住的是**两类结构性病灶**——「建好了没接」和「判据只到执行态」。本次的两个缺陷分别是这两类的第 5、6 个实例。

---

## 1 逐步监督台账（读数均来自线上回读或落盘收据）

| 步 | 环节 | 终态 | 客观证据 | 稳定性判定 |
|---|---|---|---|---|
| 1 | 采集 | 完成 | `runtime/.weekly-collection-receipt.json` @2026-09-15T10:49:58Z；5 段区间 21-24 / 25-28 / 29-32 / 33-36 / 37-40 全部 merged 成功，`failures: []` | 稳定（但历史上要跑到第 3 次，见 §4） |
| 2 | 建周表 | 完成 | `竞品周_2026-09-13_2026-09-19` / `tbllWI45sK0DfHpr`，35 字段；建表基准已从「克隆上一周」改回**竞品主表** | 稳定 |
| 3 | 导入 | 完成 | `runtime/xws-feishu-weekly-2026-09-13_2026-09-19-merged/report.json`：`sourceRows 1417 / importedRows 1417 / attachmentCount 1415`，周期戳 2026-09-13~09-19、采集日 2026-09-15 | 稳定 |
| 4 | 派生字段 | **部分** | `create-weekly-formula-fields.mjs` dry-run：`2 lookup + 9 formula`，实际 `created=0`；`STILL MISSING (4): 尺寸, 适用空间, 数据状态, 待补数据项` | **确定性失败**（平台 API 限制，非抖动） |
| 5 | 分类统计 | 完成 | 线上回读：无分类 890 / D-价格·流量型 421 / C-差异化 82 / 不适用 23 / **B-高价值 1** | 稳定 |
| 6 | SKU/尺寸富化 | **N/A** | 采集时 A/B=0（材质列空导致 B 判不出来）→ 按口径跳过；现在 A/B=1 但产物无消费者（见 §4） | **最不稳定**（登录态/风控，非确定性） |
| 7 | FAQ | 完成 | `runtime/faq-analysis/2026-09-13_2026-09-19/operator-status.json` → `status: DONE`，`nextAction: DONE`，`manifestLocked: true`；候选清单 `outcome: NO_QUALIFIED_CANDIDATES`、`candidateCount: 0`；`rawRecords: 0`（空快照 sha256 = 空串哈希 `01ba4719…`） | 判据可解释，但「空周期→DONE」这条旁路需盯（见 §3 P2-1） |
| 8 | 发布历史总表 | **重跑完成** | `evidence/publish-rerun-2026-09-13_2026-09-19/publish-receipt.json`：`APPLIED_AND_VERIFIED`，`updates 1417 / creates 0 / deletes 0 / after 5763 / readBack true`，`sourceHash 27bcbbe7…` | 稳定（且已验证幂等） |

回归基线：`scripts/run-test-suite.mjs runtime` → **456 通过 / 0 失败 / 65 个文件**（与既有基线一致，本次改动未破坏任何用例）。

---

## 2 本次真实执行的两个改动（都可回读）

### 2.1 五列属性写回周表（补上唯一缺失的写入方）

- 新脚本 `runtime/fill-weekly-attribute-labels.mjs`，口径与飞书评级公式**同源**（`competitor-v2-core.mjs` 的 `buildCompetitorRecord`），不是另造一套。
- 安全设计：默认 dry-run；写入需 `--apply` 且 `--confirm-app-token` 与当前 base token 完全一致；**只填空、绝不覆盖非空值**（可重复执行）；字段类型不是 Text 时**直接抛错拒绝猜测写入形状**；写后有回读校验。
- 结果：`已写入 1417/1417`，回读五列空值全为 0。
- 线上有值率：材质分类 79.0% / 安装方式 72.5% / 功能 27.6% / 外形 27.4% / 风格 22.6%。
- （口径说明：与 08-23 基准周的一致率 93.3% / 99.7% / 99.6% / 98.0% / 98.7%，未编造率 98.5%~99.7%。**但 08-23 的「真值」本身是同一套词表算法生成的，不是人工金标准**，所以这只证明可复现性，不证明正确性。）

### 2.2 历史总表重发布（把修好的源搬进仪表盘）

- 先 dry-run 验幂等：`creates 0 / updates 1417 / deletes 0`，`gate 通过`。
- 关键证据：`sourceHash` 由 `79087c85…` 变为 `27bcbbe7…`——**证明属性写回真的改了源，也证明不重发布仪表盘就是旧的**。
- 再 `--apply`：`APPLIED_AND_VERIFIED`，`readBack: true`，`bHighValue` 从空变为 1 条（勒示卫浴，PMMA 人造石浴缸，金额 8560）。
- 回读对比（重发布前 → 后）：

| 列 | 重发布前（历史总表本周期） | 重发布后 | 周表（源） |
|---|---|---|---|
| B-高价值竞品 | **0** | **1** | 1 |
| C-差异化竞品 | 82 | 82 | 82 |
| D-价格/流量型 | **422** | **421** | 421 |
| 不适用 | 23 | 23 | 23 |
| 无分类 | 890 | 890 | 890 |

重发布前的那 1 条 B 被错算成 D（价格 856 < 1000 命中 D 规则），因为发布时读到的材质列是空的。**这就是「判据只到执行态」的典型后果：每一步都返回成功，坏结果一路流到仪表盘且不可见。**

---

## 3 发现的问题（按严重度，标注已修/未修）

### P0-A 五列属性没有任何写入方 —— 已修

全仓只有三处碰 `材质分类`，**没有一处写周表**：`migrate-competitor-v2-analysis.mjs` 只写竞品主表、`competitor-history-publish-core.mjs` 只写历史总表、`update-competitor-class-labels.mjs` 指向废弃租户。周表四周实测为空行数：08-23 = 670/1461、08-30 = 1423/1423、09-06 与 09-13 各 100% 为空。

### P0-B 属性写回后必须重发布，否则仪表盘看不到 —— 已修

发布链是「周表 →（`buildHistoryRows`）→ 历史总表 → 仪表盘」，`buildHistoryRows` 的 `竞品分类` 是**从周表记录原样拷贝**（`text(source.竞品分类)`）。所以周表公式重算出的 B 不会自己跑到仪表盘。修复动作＝重发布（幂等，只 update）。

### P1-1 周表比主表少 4 个字段 —— 未修（根因是平台 API 限制）

- 缺 `尺寸`、`适用空间`（Lookup type 19）与依赖它们的 `数据状态`、`待补数据项`（Formula type 20）。
- 根因：**飞书开放 API 无法创建 Lookup 字段**。已用三个 property 变体逐一试探（去掉 formula；去掉 formula 与 formatter；与主表 property 完全一致），全部 `400 99992402 field validation failed`。
- 已核清一个次要疑问：Lookup 的**联接键是「商品标题」**（周表 `fld9OgSf0D` ↔ SKU明细 `fld5fPwTIG`），所以「周表商品ID 为空」**不会**影响这条 Lookup。

### P1-2 周表与历史总表的 `搜索关键词` 全空 —— 未修（潜在阻塞）

- 实测：周表 1417/1417 空；历史总表本周期 1417/1417 空。而**竞品主表该列 0/500 空**（值＝「浴缸」）。
- 根因：本周采集产物 `weekly-2026-09-13_2026-09-19-merged.csv` 的表头只有 16 列（序号…卖点），**根本没有关键词列**；周表按主表结构克隆了这个列，于是永远是空的。
- 危害不只是「空列难看」：SKU/FAQ 的候选计划测试里明写 **「不许把关键词默认成浴缸」**（`requires the weekly source keyword instead of silently defaulting to bathtub`）。目前 A/B 候选为 0 所以没暴露，一旦有候选就会撞上。

### P1-3 周表 `商品ID` 全空 —— 未修（低危）

历史总表的 `商品ID` 由发布时从商品链接派生（`productId(record)`），所以 0/1417 空、可用；**周表自身**那列是空的。不影响交付，但属于「结构上承诺了、内容上永远没有」的空列。

### P2-1 FAQ「空周期 → DONE」旁路 —— 未修（本次恰好被 P0-A 触发）

`operator-status.json` 显示 `DONE`、`rawRecords: 0`、空快照 sha256 就是空字符串的哈希。本次 0 行的原因链条是：材质列空 → B 判不出来 → A/B=0 → 候选清单 `NO_QUALIFIED_CANDIDATES` → 采集 0 行 → 判 DONE。
好消息是它**带明确 reasonCode**，不是盲目放行；坏消息是 `manifestLocked: true`，现在 B=1 了也**不会自动重开**。

### P2-2 设计味：Lookup 用「商品标题」当联接键 —— 未修

同名不同款会串。仅记录，本周不动。

---

## 4 「哪里不稳定 → 接 agent」的判断表

判断原则：**能用规则钉死的一律用规则**（确定性、零 token、可回读）；只有「规则判不出来 / 需要现场判断」的才接 agent。

| 环节 | 失稳性质 | 处置 | 理由 |
|---|---|---|---|
| 1 采集 | 启动器与登录态：历史上第 3 次才成功 | **规则 + 重试** | 失败信号是确定的（进程退出码、`adaptive-merge` 产物缺失） |
| 2 建周表 / 3 导入 | 确定 | **规则** | 幂等键明确，dry-run 可证 |
| 4 派生字段 | 确定失败（API 不支持 Lookup） | **规则绕行**（见 §5 决策 1） | 已定位到平台限制，重试无意义 |
| 5 分类统计 | 确定 | **规则** | 纯公式 + 只读复核 |
| **6 SKU 富化** | **不确定**：买家账号登录态被挤掉 / 平台风控 / 商品页未打开 / 风控验证页 | **接 agent（唯一必接点）** | 失败模式多且需要「看现场」；且现有 `xws-sku-auth-preflight.mjs` 报 `AUTH_REQUIRED`/`STALLED` 后**只抛异常**，通知 `delivery.status = NOT_CONFIGURED`（第三跳 webhook 已取消）→ 卡点无人知晓，正是你说的「飞书未收到提醒」 |
| 7 FAQ | 半确定 | **规则收紧 + 少量 agent** | 状态机本身是确定的；要补的是「0 行必须有 reasonCode，且该 reasonCode 要由**独立读周表 A/B 计数**交叉验证」 |
| 8 发布 | 确定 | **规则** | 有 gate + readBack + 幂等键，已是全套确定性校验 |

**接 agent 的最短路径（不新造系统）**：仓库里 `runtime/sop-runtime/agent-proposal.mjs` / `agent-review.mjs` / `agent-planned-run.mjs` 已经是契约层——只读工具、提案 schema 强制带证据、planner 与 reviewer 互锁、四出口（`RUN_FALLBACK` / `PAUSE_FOR_HUMAN` / `AGENT_FAILED` / `REJECT`）、40 例测试、且**在门禁内**。它唯一的缺口是 **`createAgentPort` 只在测试里被实例化过，没有生产调用方**。

所以正确动作是：**给一个「周更监督器」写真实调用方**，让它在第 6/7 步之间读收据 → 用规则分类失败（`AUTH_REQUIRED`→人工；`STALLED`→重试 N 次；`ACCOUNT_MISMATCH`→人工）→ **只把规则判不出来的那部分升级给 LLM 提案**。这样 90% 的卡点仍然走确定性路径，只有真正模糊的情况才烧 token。

> 具体冲突需你裁决：仓库里现在有**两套**提案层——`runtime/sop-runtime/agent-*.mjs`（契约层，在门禁内）与 `runtime/supervisor-agent/proposal/`（原型层，**不在任何套件**，因为 `listTestFiles` 非递归）。接线前必须定以哪套为准，否则会造出第三套。

---

## 5 需要你拍板的清单（每项都给推荐默认值；不想逐条回就回「全按推荐」）

1. **周表缺的那 4 个字段怎么办？**
   (a)【推荐】放弃 Lookup，改用规则写入方——把 `尺寸`/`适用空间`/`数据状态`/`待补数据项` 用 `buildCompetitorRecord` 的本地算法算好，以 Text/多选列写进周表（扩 `fill-weekly-attribute-labels.mjs`，约 40 行，零 LLM）；
   (b) 人工在飞书界面手动建 4 个字段（一次性，但下周换表又要重建）；
   (c) 不补，接受周表比主表少 4 列。
   → 推荐 (a)：无平台依赖、可回读、可重复执行。

2. **`搜索关键词` 全空怎么办？**
   (a)【推荐】采集段在 merged CSV 里补一列固定关键词（本周＝「浴缸」），让周表/历史总表不再空列，同时解掉 SKU/FAQ 候选计划的潜在阻塞；
   (b) 从周表/历史总表结构里删掉这列；
   (c) 不处理（目前 A/B=0 所以没爆）。
   → 推荐 (a)：这是唯一能让下游候选计划合法拿到关键词的低成本做法。

3. **现在 A/B=1 了，要不要为这 1 条补跑第 6 步 SKU 富化 / 重开第 7 步 FAQ？**
   (a)【推荐】都不跑。第 6 步的产物（尺寸/适用空间）目前**没有可到达的消费者**（Lookup 建不了，SKU周表本周也不存在），跑出来是一张没人读的表；而且它需要在你的调试 Edge 里登录买家账号，还有风控风险。第 7 步 manifest 已锁，重开是另一件事。
   (b) 只为这 1 条跑一次 SKU 采集，把链路真跑通一次（耗时 + 需要你先确认买家账号登录态）。
   → 推荐 (a)，本周交付不依赖它们。

4. **历史周表（08-30 / 09-06 / 09-13 的 35 字段表）要不要回填属性列与派生字段？**
   (a)【推荐】不回填，只保证本周起正确——回填会让历史快照的「当时口径」与「现在口径」混在一起，反而破坏可比性；
   (b) 全部回填属性列（不动公式字段）；
   (c) 全部回填（含重发布历史总表）。
   → 推荐 (a)。

5. **代码/文档/记忆要不要提交 git？**
   (a)【推荐】提交，分两条：代码一条（`fill-weekly-attribute-labels.mjs` + 只读探针 + `agent-llm-adapter.mjs`）、文档与记忆一条（本报告 + P0 诊断 + memory）；同一批顺带删掉 §7 列的 4 个临时脚手架；
   (b) 先不提交，等把这周交付完再一起提交。
   → 推荐 (a)。提交会带 `-c user.name="sycm-automation" -c user.email="agent@sycm-automation.local"`。当前工作区共 11 个已跟踪文件被改、31 个新文件未跟踪。

---

## 6 本次明确不做的事

- **不重复执行采集与导入**：同周期重跑会产生重复行（发布已验证幂等，但导入是否按唯一键 upsert 未验证）；且本次只读复核已证明这两步的产物完整（1417 行 / 1415 附件）。
- **不动线上 `竞品分类` 公式**（不加 `IFERROR` 之类）：未验证的改动不往生产放。
- **不重启/不停止任何服务或进程**（Edge 9222 与 CDP 代理 3457 保持本次启动后的状态）。
- **不重开已锁的 FAQ manifest**。

---

## 7 本次新增的脚本（全部可复跑）

| 脚本 | 性质 | 用途 |
|---|---|---|
| `runtime/fill-weekly-attribute-labels.mjs` | **写入**（默认 dry-run，需 `--apply` + token 确认） | 五列属性写回周表，只填空、有回读校验 |
| `runtime/_probe-supervise-20260913.mjs` | 只读 | 周表 vs 历史总表逐列有值率 + 分类分布对照 |
| `runtime/_probe-b-record.mjs` | 只读 | 取 A/B 候选的完整字段 |
| `runtime/_probe-raw-fields.mjs` | 只读 | 原样 dump 存疑字段，排除探针自身取值 bug |
| `runtime/_probe-colid-missing.mjs` | 只读 | 主表 vs 周表列有值率对照 + 采集 CSV 表头 |
| `runtime/_probe-lookup-key.mjs` | 只读 | 映射 Lookup 联接键的字段名 |
| `runtime/_probe-history-cols.mjs` | 只读 | 历史总表逐列有值率 |
| `runtime/_probe-targets-b.mjs` | 只读 | 浏览器标签页与 record_id 现状 |

另有上一轮建立的只读探针（仍在仓库、可复跑）：`_probe-verify-writeback`、`_probe-date-raw`、`_probe-fields`、`_probe-ports`、`_try-create-lookup`、`_probe-lookup-field`、`_probe-target-ids`。

**本轮产生的临时脚手架（建议随第 5 项一起删掉）**：`runtime/_append2.mjs`、`runtime/_chunk2.md`、`runtime/_tail.mjs`、`runtime/_probe-notes.mjs`。

即席证据：`evidence/attribute-writeback-2026-09-13_2026-09-19.receipt.json`、`evidence/publish-rerun-2026-09-13_2026-09-19/publish-receipt.json`。
