# 迁移 6：灰豚周度（能力级队列 + 外部写 + 公式结算回读）

日期：2026-09-14
对应实施计划：第 5 节「首批流程迁移顺序」第 6 项（灰豚周度：话题搜索采集与受控回填）
本报告是深报告，摘要见 `docs/architecture/PHASE-ARCHIVE.md` 第 7.7 节。

## 1. 这一轮要解决的到底是什么

灰豚回填原本是**一个 CLI 从头做到尾**：

```
run-huitun-topic-heat.mjs
  读飞书 A候选 队列 → 浏览器采集灰豚话题浏览量 → dry-run 计划 → --apply 回填 → 回读校验（含 优先级 公式结算）
```

这条链本身写得相当严谨（来源平台身份、队列指纹、字段类型前置、只写一个字段、公式结算等待、整表比对、结果新鲜度、`AI_REQUIRED` 前置），它缺的仍是迁移 5 那三件事的同类：

1. **授权是一个命令行开关。** `--apply --confirm-table <id>` 同时扮演「人工审批」和「参数」。事后没有权威记录能回答「这次回填是谁在什么时候批准的」。
2. **它是一条长事务。** 浏览器采集、写飞书、等公式结算全在同一个进程里；进程一崩，唯一的进度载体是磁盘上的 runDir，没有任何东西能告诉运行时「这条 run 现在是哪一段」。
3. **队列是「能力级」的，不是商品级 fan-out。** 迁移 3 为商品级 fan-out 建立的失败隔离（一个商品失败不影响其余）在这里用不上：本能力的单位就是「本周这一个候选队列」。真正需要的是另一件事——**0 候选不许伪装成「推进了一格」**（框架游标要求 `end >= 1`）。

要改的就是这三件事：把「复验 + 写入 + 回读」变成一条能被确定性运行时驱动的能力，并且**不虚构也不缩小**任何一道闸门。

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| `skills/huitun-to-feishu-keyword-heat/manifest.json` | 改：`entry` 由 CLI 改为适配器；`version 1.0.0 → 1.1.0`；`permissions` 补 `filesystem.read`（采集段要读 `results.json` 与 env 文件）；`validation` 对齐为 `[source_identity, structure, row_count, publication, readback]`；`inputs.queue_snapshot` 的非法类型 `external_read` 改为注册表允许的 `object` |
| `skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs` | 新：7 方法 Worker 契约（采集段独立复验 `results.json` + 飞书只读）+ `createPublisher`（对账式写入 + 回读含公式结算）。**不 import `runtime/` 下任何模块** |
| `skills/huitun-to-feishu-keyword-heat/tests/adapter-huitun-keyword-heat.test.mjs` | 新：34 项。覆盖 manifest 对齐、契约同源、跨 Skill 依赖漂移、真 registry/loader/Controller/证据库驱动的端到端采集与端到端**提交**、13 条确定性拒绝码、工件篡改自检、目标不一致、幂等写入、UNKNOWN/REJECTED 分流、人工闸门、回读五路分离、纯函数确定性 |
| `skills/xws-to-feishu-base/scripts/feishu-client.mjs` | 改：**纯新增**两个方法——`listTables()`（只读表清单）与 `batchUpdateRecords([{record_id, fields}])`（≤500 行批量更新，返回 `record_id` 列表）。既有方法一行未动 |
| `skills/xws-to-feishu-base/adapter.feishu.manifest.json` | 改：`1.0.0 → 1.1.0`，description 补「表/字段读取、批量创建与批量更新」 |
| `skills/huitun-to-feishu-keyword-heat/SKILL.md` | 改：新增「运行时入口（Agent SOP Runtime）」一节，说明能力边界、两条写入路径的分工与离线检查 |
| `skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs` | **未改一行**。本能力是第一条「复用既有纯逻辑模块而不复刻」的迁移：来源校验、队列绑定、`AI_REQUIRED` 前置、`Refusing to overwrite`、`assertAuthorizedMutation`、`优先级` 公式预期全部沿用原实现，避免第二份真相 |

`runtime/sop-runtime/` **仍然没有新增任何模块**，`two-stage-runner.mjs` 也**没有改一行**。至此「新能力 = 新目录 + manifest + 实现 + 测试」这条设计目标，已由三种形态各自验证过一次：只读（迁移 4）、商品级 fan-out（迁移 3）、外部写（迁移 5）、**能力级队列 + 外部写 + 异步公式结算（本轮）**。

## 3. 关键决策

### D7.26 能力切在「results.json + 飞书只读 → 工件」与「工件 → 对账写入 → 回读」之间；浏览器采集留在既有 CLI

浏览器点击、结果稳定判定（loading 过渡 + 两次相同签名）、截图留证需要 Edge 会话与真人节奏。把它们塞进 Worker 的 `start/observe` 只会把「可恢复的确定性步骤」重新变成「不可恢复的长事务」。因此：

- COLLECT：读 `results.json`（CLI 采集产物）+ 飞书**只读**（表清单 / 字段定义 / 记录）→ 独立复验来源身份、队列指纹绑定、字段类型、结果新鲜度、逐行身份 → 产出「已结算的写入计划」工件；
- PUBLISH：只读**工件字节** → 重读目标表 → 逐行对账 → 只写仍然为空的字段 → 外部回读（含 `优先级` 公式结算）。

**与迁移 3/5 完全同构**，这正是它零改动复用通用运行器的原因。

### D7.27 工件携带的是「计划」，不是「结果文档」

`results.json` 在 COLLECT 时被用来算出计划，之后工件里只留 `resultsSha256` + 文件路径。第三方仍可拿那份文件重走一遍 `validateResultDocument`；而**发布段不需要结果文档的新鲜度策略**。

取舍理由：若把新鲜度判定搬进发布段，「采集时合法、提交时刚好过期（默认 24h）」的一条工作会被误杀，而发布段真正要守的是「这批行还在不在、字段还是不是空白」。新鲜度是**采集期**的性质，写进工件只会让它在错误的阶段重新生效。

### D7.28 发布段不重算解析，改为重读目标表 + 逐行对账

这是它与运维 CLI 的差别所在：CLI 在写之前重跑一次完整 dry-run；运行时路径离线不可用，改为「读实况 → 队列指纹 → 逐行身份/守卫/现值 → 只写仍然为空的字段」。

比 CLI 更强的一点：队列变了就直接拒绝（CLI 靠 `validateResultDocument` 的绑定检查达到同样效果，运行时路径把它显式写成可审计的 `QUEUE_CHANGED`）。

**但队列指纹的语义必须写准**（这是本轮抓到的真实缺陷 ②，见第 5 节）：指纹回答的是「这批行还在不在 A候选 队列里」。它在**没有待写行时无关紧要**——一次成功的回填会让 `优先级` 公式结算，行随之离开 A候选 队列，指纹必然变化，那是**正常收敛而不是漂移**。因此指纹检查放在逐行对账之后，只在 `stillBlank.length > 0` 时才拦。

### D7.29 回读只守「本批行 × 与优先级判定相关的字段」，不复制整表快照

CLI 的 `verifyBackfill` 做整表逐记录比对（含「无关记录必须原样」）。把整表搬进工件会把证据体积放大到与能力无关的规模。本能力改为：工件为每行记录 6 个守卫字段（`搜索词 / 关键词分类 / 细分标签 / 搜索热度 / 交易热度 / 内容热度`）在采集时的值，读写两侧都比对它们——写前拦 `GUARD_FIELD_CHANGED`，写后由回读收据负责证明结果。

「无关记录必须原样」这条**没有丢**：它由「写入载荷只允许一个字段」+ `assertAuthorizedMutation` 本地守卫 + 回读只认本批行共同保证——因为我们**只写这一个字段**，其余字段不可能被本次写入改动。

### D7.30 未收敛的回读收据**不带 `verifiedAt`**

发布期验证器只认 `rows / digest / verifiedAt` 三项。让「没等到公式结算」的回读收据不带 `verifiedAt`，使「未收敛被判为 `UNKNOWN`」这件事**不依赖调用方是否传了 `expectedRows`**——否则调用方漏传一个参数，就会让一次没验证成功的发布被判成 `VERIFIED`。

这是本能力对「验证器可以只靠收据自身收敛」的一条正面回答：判定依据在被验证的那份证据里，而不在调用方的参数里。

### D7.31 0 候选 = 确定性拒绝 `NO_CANDIDATES`，不伪造 0 行发布

运营口径上「A候选 队列为空 = 本周没有要补的词」，但这**不是一条可结算的工作**：框架的 `advanceCursor` 要求 `end >= 1`（拒绝回归），伪造一个 1 会把「什么都没做」写成「已推进一格」。

因此采集段确定性拒绝，由驱动器负责「空队列就不要再发起本能力」——把「不做」表达成 `POLICY_DENIED`，而不是表达成一次成功的空采集。这是与迁移 3（`DONE_NO_CANDIDATES` 是合法结论）**刻意不同**的取舍：那边一个商品没有证据是合法的产品事实；这边整个队列为空意味着本能力根本不该被调度。

### D7.32 中文策略结论必须显式映射成确定性 code + failureClass

`flow.mjs` 抛的是带**中文**提示的普通 `Error`（「拒绝覆盖」「队列已变化」）。默认的 `failureClassOf` 只按**英文**关键词猜，会把这类**策略结论**猜成 `BUG`（落态 `FAILED/TERMINAL`），从而把一次「修正后本可以重跑」的运行升级成停线。

因此适配器里有 19 条显式规则（`FLOW_ERROR_RULES`）+ `FAILURE_CLASS_BY_CODE` 逐条绑定，并且**未命中规则的异常原样抛出**——一个看起来合理的分类不该把真 bug 藏起来。`AI_REQUIRED` 单独映射到 `HUMAN_REQUIRED`（上游 AI 分析未跑完是等人工，不是停线）。

拒绝码有两个观察面，两者都有测试：
- 直接调 `readHuitunBatch`：拿到的是确定性 `code`（「这批词为什么没通过」的结论）；
- 经 `runTwoStage`：拿到的是 `receipt.failureClass`（运行时据此决定重试/等人工的依据）。

只测其中一面，都会漏掉「code 对但映射错」这类缺陷。

### D7.33 刻意**不**声明的验证器 + 依赖漂移守卫 + 恢复点

写进 `collectContract().omittedValidators`，并有测试锁住「不得出现在 `manifest.validation` 里」：

| 验证器 | 为什么刻意省略 |
| --- | --- |
| `digest` | 比较的是 evidenceStore 从同一份字节算出的摘要，恒等，属空转 |
| `artifact_integrity` | `rowCount > 0` 与 `row_count` 完全重叠，能力已逐行复验身份 |
| `scope_match` | 本能力不做分片：一次运行就是「一个队列的全部关键词」 |
| `contiguous_prefix` | 同上：没有可续接的范围，队列就是单位 |
| `completeness` | `expectedRows` 由调用方给出并由 `row_count` 校验 |
| `relations` | 没有声明任何跨记录关系 |

其余三条与迁移 5 一致：`adapter.feishu` 写进 manifest 依赖并用**漂移测试**锁住（注册表里的 entry 解析路径 == 适配器相对导入的解析路径 == manifest 声明）；`recovery.resumeFrom = idempotent_commit`（恢复点是提交记录，不是游标：`UNKNOWN` 只能对账，重试必须落在同一个 `commitKey` 上）。

### D7.34 两条写入路径的分工与强度差异（如实标注）

`run-huitun-topic-heat.mjs` 仍然存在、不回退、不改写：

|  | 运维 CLI | 运行时能力 |
| --- | --- | --- |
| 触发 | 操作者手打 `--apply --confirm-table <id>` | 人工闸门 `humanGateStatus=APPROVED`（`--operator` 记录审批人） |
| 写前 | 重跑完整 dry-run（含浏览器采集后的结果复验） | 不重跑（离线不可用）；靠工件绑定 + 队列指纹 + 逐行守卫对账 |
| 写后 | 整表逐记录比对 + 公式结算轮询 | 一次外部回读，逐行核对（含公式结算），未收敛即 `UNKNOWN` |
| 审批痕迹 | 命令行参数 | `supervisor_commit_records` + Controller 上下文 |
| 浏览器 | 负责采集 | **完全不发起**（不 import 任何浏览器能力） |

## 4. 验证

```
node --test skills/huitun-to-feishu-keyword-heat/tests/adapter-huitun-keyword-heat.test.mjs
# tests 34  pass 34  fail 0

node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 10 manifest 通过（能力 8 + 适配器 2）
# registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48
# 告警 5 项，全部是 adapter.browser 显式外部依赖（共享 CDP 代理不在仓库内）
```

端到端用例用的是**真** registry（`buildRegistryFromDisk`）、真 loader、真 Controller、真证据库、真 Side Effect Ledger、真 `runTwoStage`；只有两处是注入的：store 在内存（`createMemoryStore`）、飞书客户端是假实现——假实现**记录调用次数**，因此「幂等写入不产生第二次写入」「人工闸门未开时一次外部调用都没发生」是被断言出来的，而不是被相信的。

覆盖到的端到端路径（每条都有独立用例）：

| 场景 | 期望结论 |
| --- | --- |
| 只跑采集段 | `rowCount=2` / `publicationStatus=NOT_REQUESTED` / 游标不推进 / `executionStatus=SUCCEEDED`（运行必须终结） |
| 提交段（公式结算） | `VERIFIED` + 游标推进到 `{start:1,end:2,version:1}` + 写入恰好一次且只含空白行 |
| 幂等重跑（值已写入、公式已结算、行已离开 A候选 队列） | 0 次写入 + 回读仍收敛（`verifiedAt` 存在） |
| 目标与已审批工件不一致 | `REJECTED` 留收据、`publicationStatus` 停在 `READY`、`executionStatus=null` |
| 5xx / 4xx | `UNKNOWN`（等对账） / `REJECTED`（确定性拒绝） |
| 公式始终不结算 | 回读不收敛 → `UNKNOWN`，但写入确实发生了（不许因为回读失败就说「没写」） |
| `--commit` 无审批人 | `HUMAN_REQUIRED` + `WAITING_HUMAN`，一次外部调用都没有 |

## 5. 本轮抓到的真实缺陷（2 条，均已修并各有测试）

① **`validate()` 把「调用方没提供的表面字段」当成撒谎。** 原实现遍历 `ARTIFACT_SURFACE_FIELDS` 全量比较 `parsed[key]` 与 `artifact[key]`，而工件表面字段是**框架侧从字节派生**的：任何「只拿字节 + 摘要」的路径（第三方复核、跨进程恢复、独立复算）都会被判 `STRUCTURE_INVALID`。这与迁移 5 的缺陷 ② 是同一类错误的**相反方向**（那次是「要求 `rowCount` 必然存在」，这次是「要求全部表面字段必然提供」）。

修法：只比较**调用方确实提供了的**字段（`artifact[key] !== undefined && !== null`）。「没提供」不是撒谎，「提供了却不一致」才是。用字节单独重建的工件因此能自检通过，而「谎报一个 `keywordCount`」仍被抓成 `STRUCTURE_INVALID`——两个方向都有用例锁住。

② **回读对账被自己的成功结果挡住（队列指纹无条件检查）。** 原实现把「live 队列指纹 == 工件指纹」当成写入前的硬门。但**一次成功的回填会让 `优先级` 公式结算，行随之离开 A候选 队列**，指纹必然变化。于是：进程死在「飞书已写、本地未记账」之间 → 重跑对账 → `QUEUE_CHANGED`，`UNKNOWN` 对账路径（这份设计里唯一被允许的恢复动作）**永远走不到自己的成功状态**。这条缺陷在静态审阅里看不出来，只有把「写之后的状态」摆进夹具才会暴露。

修法：指纹检查移到逐行对账之后，只在 `stillBlank.length > 0`（确实还要写点什么）时才生效。两个方向各有用例：值都已写入 → 0 次写入 + 回读收敛；新增一个 A候选 行（有东西要写）→ `QUEUE_CHANGED` 且一次写入都没有发生。

## 6. 未做项（刻意不做，避免范围膨胀）

1. **不接浏览器采集。** 采集仍在 CLI 里；把它塞进 Worker 需要把一个「不可恢复的长事务」重新引入运行时。
2. **不复刻 `flow.mjs`。** 本能力 import 同 Skill 的 `./flow.mjs`（本能力自己的纯逻辑模块）。跨 Skill 的相对导入仍然只允许**已登记能力**的实现（`adapter.feishu`），并有漂移测试锁住。
3. **不引入第二条 Feishu 读路径。** 发布段的重读用的是 `adapter.feishu` 新增的 `listTables`；没有为「写前新鲜度重算」另开一条只读链（同迁移 5 的未做项，理由一致）。
4. **`advanceCursor` 前置条件仍延后收紧**（第 7 项 Planner/Reviewer 一并做）。
5. **真实 `--commit` 仍未对真实 base 执行过。** 这条链的 `VERIFIED` + 游标推进只有单测覆盖，与迁移 1/5 同属「代码已就绪但从未真实跑过」的关键路径，需要单独授权 + 可写目标表。
