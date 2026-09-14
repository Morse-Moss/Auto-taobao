# sop-runtime 报告：阶段 1 跨进程恢复实证 + 阶段 5 Memory/Compression + 阶段 6 lane/队列/限流/熔断

日期：2026-09-14
编号说明：本报告按 **implementation-plan 的阶段号**（阶段 1/5/6）。此前的 PHASE3/4/4B/5 报告按的是**迁移顺序**（阶段 3 manifest、阶段 4 validator、4b publisher、首例两段式迁移），两套编号不要混读。
范围：补齐实施计划里「模块根本不存在」与「验收无实测证据」的部分。
状态：全部落地并有测试/实测证据。

## 1. 阶段 1：跨进程恢复的故障注入（新证据）

架构师要求「独立杀掉 worker 后可从最后 verified cursor 恢复；checkpoint 不依赖进程内 Set、本地 JSON 或模型记忆；恢复不重复已经确认的 CommitRecord」。此前只有内存 store 的单测，没有跨进程实测。

新增 `runtime/sop-runtime/recovery-fault-injection.mjs`：在临时库（`sop_fault_<stamp>`，apply 001-005）里跑**真实多进程**场景，跑完即删，业务库不写入。

场景与结果（15/15 通过）：

```
临时库 sop_fault_*（PG 17.10，迁移 001-005 现场应用）
[1] 主进程完成第一分片：提交 ck-fault-shard-1 并推进游标到 10
[2] 子进程 A（PID 独立）beginAttempt 持 lease 执行中 → 被 SIGKILL
    - 杀之前权威状态里存在 RUNNING attempt
    - 杀之后该 attempt 仍完整保存在 PostgreSQL（status=RUNNING, leaseOwner=worker-hold-<pid>）
[3] 等待 lease 过期（2s）后由全新子进程 B：
    - 收回过期 lease（reclaimed=被杀 attempt）
    - 读到的游标是 10（未重复、未跳号）
    - 使用新的 attempt
    - 推进游标到 20，运行终态 SUCCEEDED
[4] 幂等与终态：
    - 被杀 attempt 记为 FAILED + lease EXPIRED
    - 重复提交同一 commit_key 不产生第二行（rows=1，返回既有记录 id）
    - 账本 2 条各 1 次（COMMITTED:1, VERIFIED:1），上下文终态与账本一致
```

复现：`node runtime/sop-runtime/recovery-fault-injection.mjs [--db <name>] [--keep] [--json]`。需要 CREATEDB 身份（本会话用 xws_runner；脚本会打印实际生效角色，权限不足直接拒绝）。

## 2. 阶段 5：Memory 与 Context Compression（新模块）

实施计划阶段 5 的两个模块此前完全不存在，现已补齐。

`compression-service.mjs`（sop-summary-v1）：
- 摘要必须保留恢复必需字段：身份（6 个身份字段逐个校验）、授权边界、五条状态轴、游标、副作用引用、阻塞、下一动作、原文 digest（sha256）、sourceVersion。
- 缺字段一律 fail-closed：`compressContext` 拒绝产出，`assertUsableSummary` 拒绝消费。
- `stepId/attemptId/verifiedCursor/blocker` 允许 null（表示「当前没有」），但字段本身必须存在——「没有值」和「忘了写」严格区分。
- 阈值触发（字节 / token 估算，确定性不调模型）+ 阶段边界触发（只在 COLLATE/VALIDATE/COMMIT/PUBLISH/RECONCILE/DONE 等边界压，避免阶段中途丢掉「正在做什么」）。
- `assertSummaryMatchesRun`：摘要必须指向同一 run/attempt 且不能比当前上下文新——这是「压缩污染恢复」的主要防线。
- `resolveCurrentOverHistory`：当前 run 证据恒优先于历史规则/经验。

`memory-store.mjs`（五层记忆）：
- 层：RUN_CONTEXT / EVIDENCE / VERIFIED_FACT / RULE_DECISION / EXPERIENCE，优先级 4/4/3/2/1，当前运行层（前两者）恒高于历史层。
- 记录必须带 scope + source + confidence∈[0,1] + 有效期（validUntil>validFrom），否则拒绝入库。
- 退役（retired）不物理删除，保留可追溯；过期记忆不再参与决策。
- 冲突判定顺序固定：层级 → 置信度 → validFrom → memoryId（结果与插入顺序无关）。
- **只在同一层内**做「新事实退役旧事实」；跨层冲突留给读取期优先级裁决。早期实现曾让当前证据把历史层直接退役，等于用「删掉历史」冒充「当前优先」，已纠正。
- `assertNoHistoryOverride`：任何「用历史覆盖当前」的尝试抛 HISTORY_OVERRIDE_FORBIDDEN。

## 3. 阶段 6：lane 并发与租约（约束开始生效）

此前 `laneLimit` 是恒返回 1 的桩，且 Controller 开 attempt 时**根本没校验 lane**——lane 只存在于 policy 里，执行层形同虚设。

- `laneLimit`：默认 1；写副作用恒为 1（忽略放宽配置）；只读能力可通过 `limits` 显式放宽（必须基于容量证据，属 P2 的保守默认）。
- Controller `beginAttempt` 新增 lane 闸门：同 lane 其它运行数达上限即拒绝，`LANE_SATURATED` + `failureClass=RESOURCE_BUSY`（可直接接 REQUEUE）。
- lane 计数两种口径**显式区分**（`store-port.mjs`）：
  - `LANE_ACTIVE_STATUSES`（含 QUEUED）：**准入**用——准入即占位，同一 lane 不重复准入。
  - `LANE_EXECUTING_STATUSES`（RUNNING/RETRY_WAIT/PAUSED）：**开 attempt** 用——排队中的 run 不算占资源。
  这是本次最需要留意的设计点：口径混用要么让 lane 形同虚设，要么让同一 lane 连排队都排不进去。
- `countActiveInLane` 新增 `excludeRunId`：运行自己占用的 lane 不算冲突。

## 4. 阶段 6（续）：任务队列、限流、背压、熔断、超时与结果合并

计划原文要求「引入任务队列、租约、超时、取消、重试和资源 lane」「增加限流、背压、平台熔断和结果合并」。第 3 节完成 lane/租约后，本节补齐剩下的调度面。

核心设计取舍：**队列不新建表**。队列元数据（priority / notBefore / deadlineAt / enqueuedAt / attempts）写进 `durable_runs.context.queue`（jsonb，001 就有该列）。因此队列顺序、退避时间、截止时间都随运行状态一起持久化，进程重启后仍在；代价是这些字段不能单独索引，需要按队列维度查询时只能走全表扫描（当前量级可接受）。

`task-queue.mjs` 的组成：

- **队列本体**：`enqueue` / `nextCandidate` / `claim` / `requeue` / `cancel` / `sweepTimeouts` / `depth`。
- **出队闸门**（任一不满足只是「这次不选它」，绝不改成失败或完成）：退避时间 `notBefore` → 截止时间 `deadlineAt` → 熔断 → lane 容量。
- **出队顺序**：优先级降序 → 入队时间升序 → runId 升序。第三级存在的意义是让结果不依赖 Map 迭代顺序，从而完全可复现。
- **限流**（`createRateLimiter`）：按目标平台分桶的令牌桶，匀速回填、封顶容量。放在队列入口而不是执行层，因为它是「保护外部额度」，不是业务正确性。
- **熔断**（`createCircuitBreaker`）：同一目标连续失败到阈值即打开，冷却期内不再派发，成功后清零。
- **背压**：全局队列深度 + 单 lane 队列深度两道上限。
- **失败隔离的重试退避**：`requeue` 不重复执行已完成部分，只把 `notBefore` 推到 `backoffMs(attempts)` 之后（1s/2s/4s…封顶 60s，确定性纯函数，抖动留给调用方，不把随机性引进状态机）。
- **超时清扫**：`RUNNING` 且已过截止时间 → 转 `PAUSED` + `WAITING_HUMAN`（`HUMAN_REQUIRED`），**不自动重试**——错过截止时间是业务判断，不是瞬时抖动，盲目重试只会更晚。
- **fan-out 结果合并**（`mergeFanoutResults`）：确定性排序；同一 key 出现两个不同值时记为**冲突并要求人工**，不静默择一；单分片失败单独计入 `failures` 而不阻塞其余结果。

两个「如实标注」的诚实边界：

1. **限流器与熔断器的状态是进程内的，没有落库，重启即复位。** 代码注释与报告都写明是 best-effort，绝不可宣称 durable。多进程各自持一个桶，实际总放行量约为进程数 × capacity。跨进程的硬约束由 lane 承担（`durable_runs.lane` 是落库列，`countActiveInLane` 是真查询）。
2. **单 lane 的队列深度上限在实践中不可达。** 因为准入本身「准入即占位」（`LANE_ACTIVE_STATUSES` 含 QUEUED），同一 lane 同时只能存在一个 run，第二个 `enqueue` 会先被准入挡下。这不是缺陷而是刻意的安全默认（同一账号/profile/写目标永不并发）；单 lane 深度闸门是给其他路径创建的 run 兜底的防线。

第三个设计点：**准入拒绝到队列拒绝原因的映射**。准入因 lane 占位而拒（`RESOURCE_BUSY`）时，对调用方就是 `BACKPRESSURE`，不是 `POLICY_DENIED`——「排不上队」和「不许做」是两件完全不同的事，前者稍后再试即可。规格非法（`taskSpec.*` / `identity.*`）才归 `INVALID_SPEC`（重试无用）。

第四个设计点：**令牌在准入被拒时归还**（`refund`）。否则一次「没接成的活」会永久吃掉配额——在容量小、竞争多的场景下会把限流器变成随机拒绝器。

`context-schema.mjs` 新增 `queue` 块；`task-admission.mjs` 在准入时把 `lane` 与 `queue` 一并写入上下文（lane 因此成为**权威值**，执行期直接用，不再重新推算，避免「准入时算一种 lane、开 attempt 时算成另一种」的静默漂移）。

## 5. 本次跑出来的真实缺陷（都已修）

故障注入、lane 测试与队列测试各自抓到了静态审阅发现不了的问题：

1. **pg-store 返回 snake_case，端口契约却是 camelCase**（最严重）。`select *` 的 `attempt_id` 喂给按 `attemptId` 写的 Controller，`controller.recover` 直接失效（`leaseExpiresAt` undefined → 永远不会认领过期 lease）。已加 `mapRun/mapAttempt/mapCommit` 归一化；Ledger 的 `record.businessKey` 同样受影响，一并修好。
2. **`updateAttempt` 只认 snake_case 白名单**，Controller 传的 `leaseState/endedAt/failureClass/result` 被静默丢弃 → 恢复时「被杀 attempt 标记为 FAILED + lease EXPIRED」没有落库（实测 status=FAILED 但 lease=HELD）。已改为按 camelCase→列名映射。
3. 映射表里一度加入 `updated_at`，但 `durable_attempts` **没有**该列（用探针核对列清单时发现）——已移除。
4. **pg Pool 无 error 监听**：临时库被 DROP 时空闲连接报错直接把进程打崩（`terminating connection due to administrator command`）。已记录为 `store.poolErrors` 而不中断运行——生产里数据库重启同理。
5. **`buildSummary` 的 spread 顺序**让 base 里的 context schemaVersion 覆盖了摘要自己的版本，摘要被自己的校验器判为缺 schemaVersion。
6. **参数名遮蔽**：`beginAttempt(runId, { write })` 把外层用于 CAS 落库的 `write()` 函数遮蔽了（`write is not a function`）。已改名为 `isWrite` 绑定。
7. lane 语义一处反复：先用「QUEUED 不算占位」改坏了既有的「准入期占位」测试；正确解法是两种口径显式分开（见第 3 节），不是二选一。
8. **`task-queue.mjs` 里 `laneFor` 被使用却没有 import**（首版遗漏），以及对象里的 `async nextCandidate,` 简写是非法语法——两处都是队列首版未跑到测试就发现/被测试拦下的。
9. 队列单测自身的三处期望写错（把「已被取走的令牌」当成还有、用容量 1 去测 refund 路径、给未开始执行的任务测超时）——修正的是**测试**，实现未改；过程记录在此以便复核。

## 6. 验收结果

```
node --test runtime/sop-runtime/*.test.mjs
# tests 160  pass 160  fail 0
#   （阶段 5 起为 108；+compression 12、+memory 11、+lane 7、+task-queue 22）
node --test skills/xws-to-feishu-base/tests/*.test.mjs
# tests 84   pass 84   fail 0
node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 8 manifest 通过，registryDigest=sha256:eefd8340…cefb（未改任何 manifest，属预期不变）
node runtime/sop-runtime/recovery-fault-injection.mjs
# 15/15 通过
```

新增文件：
- runtime/sop-runtime/compression-service.mjs + compression-service.test.mjs
- runtime/sop-runtime/memory-store.mjs + memory-store.test.mjs
- runtime/sop-runtime/lane-concurrency.test.mjs
- runtime/sop-runtime/task-queue.mjs + task-queue.test.mjs
- runtime/sop-runtime/recovery-fault-injection.mjs

修改文件：index.mjs（导出新模块）、context-schema.mjs（queue 元数据块）、policy.mjs（laneLimit 真实化 + writeLane/laneFor）、task-admission.mjs（lane/queue 落上下文）、workflow-controller.mjs（lane 闸门 + isWrite 改名）、store-port.mjs（两种 lane 口径）、stores/memory-store.mjs、stores/pg-store.mjs（行归一化 + pool 错误记录 + lane 口径）。

## 7. 仍未做 / 留给下一步

- **阶段 2 的完整落地**：账本与 UNKNOWN 对账代码已就绪且有单测，但只有 `xws.feishu.import` 一条能力走过两段式；`sycm.feishu.weekly`、`huitun.keyword-heat.collect` 等声明了写外部的能力仍走旧 CLI，`NOT_REQUESTED` 依旧是 `advanceCursor` 的合法前置。
- **发布段对真实 base 的 `--commit` 执行**从未做过（需要单独授权 + 一个可写的目标表）。这是 `VERIFIED` + 游标推进这条链唯一的缺口。
- **限流/熔断不 durable**（见第 4 节）；若要跨进程一致的限流，需要落库或外置（Redis 之类），属后续独立设计。
- 阶段 4 的其余流程迁移：FAQ 商品级 fan-out、XWS SKU、SYCM 搜索排行、SYCM→Feishu、灰豚周报。
- `advanceCursor` 前置条件尚未收紧（第三例能力迁完后才考虑）。
