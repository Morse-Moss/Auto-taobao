# 迁移 8：调度侧队列探测 —— 「没有活」不是「失败」

## 1. 这一轮要解决的到底是什么

灰豚那条能力（`huitun.keyword-heat.collect`）在 A 候选队列为空时确定性拒绝 `NO_CANDIDATES`，
它的实现里早就写明了正确的分工：

> 运营口径：A 候选队列为空 = 本周没有要补的词。但这不是一条可结算的工作……
> 因此这里确定性拒绝，并**由驱动器负责「空队列就不要再发起本能力」**。

问题是当时**没有驱动器**。于是调度这一层只有两个选择，两个都错：

1. **照常发起**：每周空队列都留下一条失败的 run（`failureClass=POLICY_DENIED`），
   把「本周没有要补的词」这个正常运营状态写成了故障。运营看到红灯去查，查到的是「没事」。
   更糟的是它与真正的策略拒绝（队列过大、目标不符）**长得一模一样**，事后无法区分。
2. **人工跳过**：跳过这件事没有任何可审计的载体——事后没人能回答「上周为什么没跑」。

这一轮把「这条能力现在有没有活」做成一等公民：
**先探测（只读、不建运行）→ 只有确认有活才发起**。跳过本身由收据承载，不留运行记录。

三条硬约束（写进模块头，不允许调用方绕过）：

- 探测**只读**，且绝不创建运行；
- **探测失败一律照常发起**（这是全模块唯一一处刻意 fail-open，理由见 D8.3）；
- 探测**不做策略判决**（否则会长出第二个策略引擎，两份判决早晚不一致）。

## 2. 交付物

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `runtime/sop-runtime/capability-scheduler.mjs` | 新增 | 探测契约 + 归一化 + 调度决策 + CLI（新模块 1/3） |
| `runtime/sop-runtime/runtime-bootstrap.mjs` | 新增 | 运行器装配的唯一一处（新模块 2/3） |
| `runtime/sop-runtime/capability-scheduler.test.mjs` | 新增 | 16 个用例（合成能力 + 真实两段式运行器） |
| `skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs` | 改动 | 新增探测段 `probeQueue()`；候选模式词表收敛为一处 |
| `skills/huitun-to-feishu-keyword-heat/tests/queue-probe.test.mjs` | 新增 | 11 个用例（含真实注册表 + 真实 loader 的调度集成） |
| `runtime/sop-runtime/two-stage-runner.mjs` | 改动 | 装配抽出 + `parseCliArgs({profile})`（**自迁移 2 以来首次改动**，见 D8.10） |
| `runtime/sop-runtime/index.mjs` | 改动 | 具名导出（刻意不用 `export *`，避免 barrel 里冒出 `main`） |

**没有改动**（这些「没动」是结论的一半）：

- 任何 `manifest.json`：**一个字段都没加**，因此 `registryDigest` 与迁移 7 完全相同
  （`sha256:34936b1f…`）——探测不扩权、不新增副作用，改 manifest 只会白白移动摘要；
- `policy.mjs` / `workflow-controller.mjs` / `side-effect-ledger.mjs` / `worker-adapter.mjs` /
  `publication.mjs` / `validator.mjs` / `task-queue.mjs`：零改动；
- 核心层仍零 import Agent 层（探测与 Agent 判决层互不知情）。

## 3. 关键决策

### D8.1 探测是「能力自描述的入口」，与 `collectContract` 同构，不占 manifest 字段

能力侧实现 `export probeQueue({ collectInput })`，调度器按 `QUEUE_PROBE_EXPORT` 常量发现它。
这与 `collectContract`/`createPublisher` 是同一类约定：**能力自己声明它能提供什么**，
调用方不需要在运行器里替每条能力维护一份清单。

不放进 manifest 的理由是具体的：manifest 管的是副作用与权限。探测既没有副作用也不扩权
（读的还是采集段本来就要读的那三样：表名、字段类型、记录），把它写进 manifest 会让
`registryDigest` 变化，而那个摘要一变，任何"能力面发生过变化"的审计都要重新解释一遍——
用一个权限字段去表达"我只是想先问一句有没有活"，代价大于收益。

### D8.2 「有没有活」是一等公民：五条出口，收据字段恒等

```
RAN                      探测通过（或没探出结论）→ 真实运行已发起
PROBED_ONLY              只探测，不发起（排产方用）
SKIPPED_EMPTY_QUEUE      队列确认为空：正常运营状态，ok=true
PAUSED_FOR_HUMAN         队列里还有等上游 AI 结算的行：等人工，ok=false
PROCEEDED_WITHOUT_PROBE  没拿到可用结论，但照样发起（fail-open）
```

五条出口的收据由**同一个工厂函数**产出，键集合来自 `SCHEDULE_RECEIPT_FIELDS`，
且工厂自己会做一次"漏字段即抛"的自检（`RECEIPT_INCOMPLETE`）。
"字段恒等"因此是结构上成立的，而不是靠后来的维护者记得补齐。

`humanRequired` 这类布尔字段**每条路径都必须在场**：用 `undefined` 冒充"否"会让调用方
无法区分「明确为假」与「这条路径忘了设置」——这是迁移 7 缺陷①的同一条教训。

### D8.3 跳过只发生在**有确定结论**时；其余一律照常发起（唯一的 fail-open 点）

| 探测结论 | 行为 | 为什么不这样做的代价更大 |
| --- | --- | --- |
| `EMPTY` | 跳过，不建运行 | ——（这正是本轮的目的） |
| `WAITING_HUMAN` | 暂停等人工，不建运行 | ——（等上游 AI 不是故障） |
| `UNAVAILABLE`（含探测抛异常） | **照常发起** | 探测器坏掉时，"多做一次本来会失败的运行"是可见的；"少做一次本来该做的活"不可见 |
| `NOT_PROBED`（能力没实现探测） | **照常发起** | 同上：没实现探测的能力不该被静默地永远跳过 |

这条规则用两个字段共同守住：跳过要求 `probe.probed === true` **且** 状态属于
`SKIPPABLE_QUEUE_STATES`（只有 `EMPTY` / `WAITING_HUMAN`），并有单测锁住这个集合不许扩容。

### D8.4 探测不做策略判决

表名不符、字段类型不符、队列过大、记录身份坏掉……**全部原样抛出**，由真实运行按既有分类去判。
探测里复制一份的后果不是"更安全"，而是**假矛盾**：探测说有活、采集段却拒绝，
或者反过来。两份判决维护在不同的文件里，早晚不一致。

真实数据上的验证（§4）就是这条决策的证据：拿一张缺 `内容热度` 字段的真实表去探测，
收到的是 `UNAVAILABLE / FIELD_MISSING`（"我没探出来"），而不是"队列为空"。

### D8.5 能力只回三种正向状态，其余由调度器派生

能力返回 `READY` / `EMPTY` / `WAITING_HUMAN`。`UNAVAILABLE` 与 `NOT_PROBED` 是**调度器**的词，
对能力没有意义——能力不需要回答"我探测失败了吗"，它只需要回答"有没有活"，
剩下的（加载失败、没实现、返回怪值）由调度器在归一化时派生。

### D8.6 状态白名单是「能不能跳过」的唯一闸门：归一化是**必然**步骤且**幂等**

归一化（`normalizeProbeResult`）被拆成一个独立步骤，且**无论探测器是谁写的都必然经过它**：
`runScheduled` 对自己注入的探测器同样做归一化。理由：白名单是唯一闸门，
而绕过白名单的方向恰好是"把真活当没活跳过"——一个拼错的状态字符串就能造成静默漏做。

幂等是硬要求：默认实现已经归一化过一次，`runScheduled` 再归一化一次。
若不幂等，`detail` 会越套越深（`detail.detail.…`），把能力自带的细节
（灰豚的 `pendingCount` / `sampleKeywords` / `recordCount`）埋进越来越深的一层里。
幂等分支**不放松**判据：状态仍须属于 `QUEUE_STATES`，跳过仍要求 `probed === true`
（只有归一化器会把它写成 `true`）。

信任边界的说明（诚实记账）：能写出"已归一化信封"的只有本模块自己的契约版本号命名空间；
能力方伪造它等于伪造自己的执行结果，而能力本来就是可信代码（它已经有权直接写飞书）。
这里**不引入新的信任边界**，只是不给自己制造"同一份结论被包装两次"的噪音。

### D8.7 `null` 不是 `0`（同一类缺陷的第 4 次出现）

`candidateCount` 的归一化最初写成 `Number(raw.candidateCount)`：`Number(null) === 0`，
于是"未结算、候选数未知"在收据里变成了"0 个候选"——那正好是"假装知道"，
与本模块的存在理由相反。修法是把 `null` / `undefined` / `''` 显式挑出来。

项目里同一类缺陷此前已出现三次（validator、ledger 两处，加迁移 5 的 `rowCount`），
这次在第 4 个位置（调度收据）又被自己的用例抓住。**"空值不是零"要当成跨模块的默认怀疑对象。**

### D8.8 探测不要求 `resultsFile`

探测发生在**浏览器采集之前**，那时 `results.json` 还不存在。
如果把采集段的 `REQUIRED_INPUT_KEYS` 直接拿来用，探测会永远探不出 `READY`，
退化成一件装饰品——而且它会以"探测总是说 UNAVAILABLE"的形式安静地失败。
探测因此有自己的 `PROBE_REQUIRED_INPUT_KEYS`（`envFile` / `appToken` / `tableId` / `tableName`），
并由单测锁住"不含 resultsFile"。

### D8.9 探测的输入面 = 采集的输入面，只吃 `collectInput`

`probeQueue({ collectInput })`——不额外包一层参数。少一层包装就少一处漂移，
而且调用方在 CLI 里给的就是 `--collect-input`，两段式运行器与调度器喂的是同一份。

### D8.10 运行器装配收敛到 `runtime-bootstrap.mjs`（`two-stage-runner.mjs` 自迁移 2 以来首次改动）

这一处改动的动机不是"顺手重构"，而是一条具体的一致性风险：装配里藏着一个**必须两处一致**
的默认值——store 是内存还是权威 PG。两个 CLI 各维护一份，早晚会出现"一个跑在内存 store 上、
另一个跑在权威库上"的静默分叉，而后果是恢复语义（游标 / 租约 / 提交账本 / UNKNOWN 对账）
在最不该出错的地方悄悄失效，**而且看起来还是绿的**。

同时给 `parseCliArgs` 加了 `{ profile }` 选项：`profile='probe'` 只要求 `--capability`。
探测不建运行，强制要 `--identity` / `--business-key` / `--commit` 三件套只会逼调用方传假值。

两处改动都是纯提取 / 向后兼容：默认参数下 `run` profile 的行为一字未改（原有 15 个用例全绿）。

### D8.11 CLI 的布尔开关必须在调度器层剥掉（实现期抓到的真 bug）

`parseCliArgs` 对任何 `--x` 都要求跟一个值（`--commit` / `--json` 是它自己白名单里的例外）。
`--probe-only` / `--force-run` 是**布尔**开关，若不先剥掉就直接交给它，
会以"`--probe-only` 缺值"报错——一个纯命令行层面的失败，却会让整条调度链不可用。
修法：`parseSchedulerArgs()` 先剥掉这两个开关，再把其余 argv 原样交给 `parseCliArgs`。
**这件事是在跑真实 CLI 时才发现的**（见迁移 7 缺陷②的教训：写完要真的跑一次）。

### D8.12 两个逃生门：`forceRun` 与 `probeOnly`

- `--force-run`：语义是"别问，跑"。探测**一次都不调用**（用例断言调用计数为 0），
  即使探测会说空队列也照常发起。用于人工确认"就是现在跑"的场合。
- `--probe-only`：只探测不发起。让排产方可以低成本地先问一圈"哪些能力有活"，再决定跑哪些；
  它同时把探测结论变成一份独立可引用的收据，而不是某次运行的副产品。

### D8.13 探测不消除竞态：真实运行始终是权威

探测通过之后队列仍可能被清空（上游 AI 恰好结算、运营手工改行），真实运行照样会给出
`NO_CANDIDATES`。探测只是把"稳定的空队列"从"偶发的空队列"里分出来。
因此收据里**两层都在**：`queueState`（探测当时说的）与 `run.failureClass`（运行实际判的）。

## 4. 验证

### 4.1 离线套件

```
node --test runtime/sop-runtime/*.test.mjs
#   tests 261  pass 261  fail 0  cancelled 0  skipped 0        EXIT=0
#   上一轮基线 244 → 本轮 261（+16 调度器、+1 运行器 CLI profile）
#   逐文件：capability-scheduler 16、agent-planned-run 14、agent-review 13、agent-proposal 13、
#          workflow-controller 13、task-queue 23、two-stage-runner 15(→16)、fanout 12、
#          faq-fanout 12、compression 12、memory 11、lane-concurrency 8

node scripts/run-test-suite.mjs runtime --concurrency=1
#   tests 361  pass 361  fail 0  cancelled 0  skipped 0        EXIT=0   （59 文件，与迁移 7 一致）

node scripts/run-test-suite.mjs skills --concurrency=1
#   43 file(s)（迁移 7 为 42）——新增 queue-probe.test.mjs

node runtime/sop-runtime/build-skill-registry.mjs --check --write
#   Registry 校验通过
#   10 manifest（能力 8 + 适配器 2）、验证器实现 11 个
#   registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48
#   ↑ 与迁移 7 **完全相同** —— 本轮没有新增或修改任何能力面
```

### 4.2 真实数据（只读，四次探测 + 一次完整调度）

用真实飞书凭据（`E:/小红书/.env.local`）对真实关键词库 base
（`N21Abkg0HakO6AsbCaDckvcwnVd`）跑 `--probe-only`，全程只读、不建运行：

| 目标表 | 探测结论 | 说明 |
| --- | --- | --- |
| 关键词分析 V1（修正版） | `EMPTY / NO_CANDIDATES`，301 条记录 / 26 字段 | 队列确实为空 |
| 关键词分析 V1（2026-09-12） | `EMPTY / NO_CANDIDATES`，300 条记录 | 同上 |
| 关键词分析 V1（2026-09-11） | `EMPTY / NO_CANDIDATES`，300 条记录 | 同上 |
| 关键词历史总表 V1 | `UNAVAILABLE / FIELD_MISSING`（缺 `内容热度`） | 探不出来，**不是**"队列为空" |
| 关键词分析 V1（09-12）+ 错表名 | `UNAVAILABLE / TABLE_MISMATCH` | 同上 |

再对真实表跑一次**完整调度**（不带 `--probe-only`）：

```
outcome=SKIPPED_EMPTY_QUEUE  scheduled=false  ok=true  humanRequired=false  run=null
exit=0   work-dir 下没有生成任何运行收据
```

也就是说：**在本周的真实数据上，这条驱动器把"队列为空"从"一条失败的运行"变成了
"一条说明为什么没跑的收据 + 退出码 0"**，并且一条运行记录都没留下。

### 4.3 关键断言（挑三条最要紧的）

- `EMPTY` / `WAITING_HUMAN` 路径上，**被包了一层的 store 的 `createRun` 调用次数为 0**
  （不是"收据说 scheduled=false"，而是真的没有运行被创建）；
- 探测器**抛异常**时，收据里带出的是它自己的错误码（例如 `FEISHU_FORBIDDEN`），
  状态是 `UNAVAILABLE`，行为是照常发起；
- 五条出口的收据键集合逐一等于 `SCHEDULE_RECEIPT_FIELDS`，且 `humanRequired`
  用 `Object.hasOwn` 断言在场。

### 4.4 真实探测的收据（节选）

```json
{
  "outcome": "PROBED_ONLY", "scheduled": false, "ok": true, "humanRequired": false,
  "queueState": "EMPTY", "queueCode": "NO_CANDIDATES", "candidateCount": 0,
  "probe": {
    "probed": true, "state": "EMPTY", "code": "NO_CANDIDATES", "candidateCount": 0,
    "detail": {
      "schemaVersion": "huitun-queue-probe-v1", "capabilityVersion": "1.1.0",
      "candidateMode": "A_ONLY", "recordCount": 301, "fieldCount": 26,
      "tableId": "tblN1uT1LpzyqqWx", "tableName": "关键词分析 V1（修正版）",
      "probedAt": "2026-09-14T07:40:24.154Z"
    }
  },
  "run": null
}
```

`detail` 里保住的是**能力自己给的**事实（301 行、26 字段、探测时刻），
没有被调度器的信封再套一层——这正是 D8.6 幂等分支要守的东西。

## 5. 本轮抓到的真实缺陷

### 缺陷①：`candidateCount` 把 `null` 当成了 `0`

`Number(null) === 0` 让"未结算、候选数未知"变成"0 个候选"。这个数字会直接印进收据与
（将来的）仪表盘，而它与真实含义相反。属项目内第 4 次同型缺陷，见 D8.7。
用例：`WAITING_HUMAN` 断言 `candidateCount === null`。

### 缺陷②：归一化不幂等，`detail` 被套第二层

`runScheduled` 会对"默认实现已归一化过的收据"再归一化一次，于是
`detail` 从"能力给的原始事实"变成"上一次的归一化收据"，真正的细节被推深一层。
在没有幂等分支时，这个缺陷在真实 CLI 输出里可见（`detail.detail.*`）。
用例：`normalizeProbeResult(normalized)` 深等于 `normalized`。

### 缺陷③：测试用 `idFactory` 计数冒充"有没有建运行"

我最初用 `createController({ idFactory: () => 'run-' + ++n })` 的计数器来断言
"空队列没建运行"。`idFactory` 造的是 **attempt id**，不是 runId——
即使一条运行都没建，只要是"有活"的路径它也会增长，反之亦然。
换句话说，这条断言测的是"有没有跑过 attempt"，而我声称的结论是"有没有建过 run"。
**它是测试自己制造的一次假绿候选**：断言的措辞比它实际测的东西更强。
修法：把 store 的 `createRun` 包一层计数，直接数真正的创建动作。

这是"测试写法错会让报告长得像实现被判失败"（迁移 7 缺陷③）的镜像版本：
**断言测错了对象，会让绿看起来像是验过了。**

### 缺陷④：CLI 布尔开关漏给下游解析器

见 D8.11。它证明了"写完要真的跑一次真实入口"这条规矩的价值：
单元测试全绿，真实 CLI 一跑就炸。

## 6. 未做项（刻意不做，避免范围膨胀）

1. **没有做多能力批量编排**。本模块是**单能力**驱动器（一问一答一跑）。
   "遍历所有已登记能力、按优先级排产"属于上层编排，等真正有多条能力在跑时再做，
   否则现在只能凭空设计一个没有使用者的调度器。
2. **没有做探测结果缓存 / TTL**。每次探测都是一次真实的飞书只读（约 300~3000 行）。
   周更频率下完全不构成成本；若将来变成高频调度（例如每小时一次），
   缓存与退避必须一起做（否则"缓存失效"会变成新的静默漏做来源）。
3. **没有与 `task-queue` 的候选选择打通**。`task-queue` 管的是"运行时自己的任务队列有多深"，
   这里是"外部业务队列有没有活"——两件事，混在一起会让"没活"和"拥堵"变成同一个信号。
4. **没有接真模型**（Agent Planner/Reviewer 仍是"可移除件"）。影响评估见 §7。
5. ~~发布段仍未对真实 base 跑过。~~ **已于 2026-09-14 补做**（用户授权的一次性演练表，
   用完即删，见 §8）：`xws.feishu.import` 的「采集→准入→人工闸门→提交→回读→游标推进」
   全链已在真实 base 上走通。仍待补的是 `xws.sku.collection` 与
   `huitun.keyword-heat.collect` 的发布段。

## 7. 影响评估（对应"这两个有没有影响"）

### 7.1 给 Planner/Reviewer 接真模型

**不是纯 token 消耗，但也不该现在做。** 分开说：

- *现在接的代价*：Agent 层目前**没有真实使用方**——没有任何 SOP 需要"由 Agent 挑下一步"
  （现有六条能力都是确定性单步：读、写、回读）。接了之后，每次规划都会多一次模型调用，
  并且把"同样的输入 → 同样的判决"这条性质换成"大概率一样"。对一个以此为卖点的底座来说，
  这是**用可重复性换一个暂时没人需要的灵活性**。
- *token 只是最小的那笔账*：真正的成本是失败模式变多——模型可能给出边界检查之外的合理但
  未授权的步骤，而运行时的四条边界只能守住"不许越界"，守不住"该做的没做"。
- *唯一能带来新信息的用法*：把模型放在**对抗性审查**的位置上（复核由确定性边界无法覆盖的东西：
  证据是否过期、前置条件是否遗漏、结论是否过度自信），而不是让它挑步骤。
  这条路上模型输出的是"另一个视角"，而不是"必须执行的计划"，风险面小得多。
- *结论*：**推迟**。等出现第一条"步骤不固定、需要判断下一步"的 SOP 时再接，
  并且优先接成审查者而不是决策者。

### 7.2 用户级 skills 目录里的残留

**与 token 无关，纯卫生问题；但实测后建议不动。** 目录里只有 5 个非技能文件：

```
.disable_to_model_invocation_migration.json     0.1 KB
.model_invocation_to_override_migration.json     0.1 KB
.user_invocable_only_to_off_migration.json       0.0 KB
_bm_skillid_migration.json                       0.0 KB
codex-desktop-rollback.zip                       3.6 KB
```

- 它们**不参与技能发现**（发现只看 `<dir>/SKILL.md`），也不进任何提示词上下文，因此**不花 token**；
- 总量约 **3.9 KB**，清理省不下任何有意义的磁盘；
- 那 4 个 `.json` 是**宿主的迁移标记**：删掉它们不是"清理垃圾"，而是可能让宿主重跑对应的迁移
  （把技能的可调用方式再改一遍）。这是一次有副作用的操作，收益为零。

**结论：不动。** 如果哪天宿主文档说明这些标记可以安全移除，再一次性清掉；
现在动手是"为了整洁去冒一个不必要的风险"。

## 8. 补做：真实 `--commit` 演练（`xws.feishu.import` 的发布段首次对真实 base 执行）

**为什么换目标表。** 用户给的实操表在租户 `kcne618basvj`，而应用
`cli_aa93e98aeef81cef` 建在租户 `rcndesfqro3x`（同一应用读该租户的竞品 base 10 张表
/ 36 字段全部正常）。飞书自建应用是**租户级实体**，不能被另一个租户的文档加为协作者，
只读调用 4 次复检均为 `403 91403`。因此改为在**应用自己的租户**里开一张一次性演练表，
演练结束后删除——不触碰任何生产表。

**场地与数据**

| 项 | 值 |
| --- | --- |
| 演练 base | `Hohobp2UDaq698sXAQSc6SRXn3f`（应用自有「小红书内容分析总表」） |
| 演练表 | `_演练_xws_import_20260914` / `tblgyQGmzTQZOuYS`（本次新建，演练后 DELETE） |
| 字段合同 | 16 列，刻意与生产周表目标同型：`价格` type 2、`月收货人数` type 1、`商品图片` type 17、其余 type 1 |
| 源数据 | `runtime/xws-bathtub-top3-with-images.xlsx`（3 行，每条 1 张图片附件） |
| 收尾 | `DELETE .../tables/tblgyQGmzTQZOuYS` → 200；base 回到原 2 张表，环境干净 |

**采集段（先跑，证明不写）**

```
mode=dry-run  rowCount=3  validators=[structure:ok, row_count:ok, digest:ok, adapter:ok]
publicationStatus=NOT_REQUESTED  cursorAdvanced=false  nextAction=PREPARE_COMMIT
```

**提交段（真实写飞书 + 回读）**

```
gate: riskClass=HIGH  decision=ALLOW_WITH_APPROVAL  status=WAITING_HUMAN → APPROVED(operator 落进 decisions)
publish: verdict=VERIFIED  commitKey=e4c775a05678b05e0729b1fde8affedd
         receipt={ rows:3, attachments:3, digest:67a6d80260afbd985dc2cf08eef228ca1a02992c74bdb88433d973af9eea19b7 }
publicationStatus=VERIFIED  cursor: 1→3 (version 1)  cursorAdvanced=true
decisions: APPROVAL → PUBLICATION/READY → PUBLICATION/COMMITTED → PUBLICATION/VERIFIED
```

**独立回读（不复用运行器的回读代码，直接打 `/records`）**

```
rows = 3  has_more = false
[1] 新品浴缸…欧式浴盆        价格="612"     月收货人数="100"  图片=1  店铺=陈强卫浴工厂店
[2] 古伦比亚…一体浴池        价格="2198.27" 月收货人数="100"  图片=1  店铺=古伦比亚旗舰店
[3] 古伦比亚…成人泡澡        价格="2098.14" 月收货人数="100"  图片=1  店铺=古伦比亚旗舰店
```

**结论。** 「代码已就绪但从未真实跑过」这条自迁移 1 起挂着的关键路径，对
`xws.feishu.import` 已经关闭：采集 → 准入（高风险开闸）→ 人工审批留痕 → 提交 →
外部回读 → 游标推进，全链在真实 base 上走通，且收据与独立回读完全一致。
仍未真实跑过的只剩 `xws.sku.collection` 与 `huitun.keyword-heat.collect` 的发布段。

### 8.1 补做二：在新租户（搬迁目标 base）上的同类演练（2026-09-14 晚）

§8 的演练跑在**应用自有租户**（跨越租户不可达的替代场地）。用户在新租户
`kcne618basvj` 里补好 `bitable:app` + `drive:drive` 并**把应用加为副本 base 的可编辑协作者**，
同时决定整体搬迁到该租户（见 `docs/ops/TENANT-MIGRATION-MAP.md`）。于是同一套两段式在
**搬迁目标 base** 上又跑了一遍——这一次目标就是将来的生产 base：

| 项 | 值 |
| --- | --- |
| 演练 base | `OUMqbkYwVaQxQNsv2EDc1DV7nDf`（副本 base，租户 `kcne618basvj`） |
| 演练表 | `_演练_kcne_20260914` / `tblBEhDouarnVkG5`（演练后 DELETE → 200，base 回到 11 张表） |
| 字段合同 | **从真实周表 `竞品周_2026-09-06_2026-09-12` 克隆** 28 个可克隆字段（7 个 type=20 公式字段按设计延后）；核对 `价格 type=2 / 月收货人数 type=1 / 商品图片 type=17` |
| 凭据 | `E:/小红书/.env.feishu-kcne.local`（`cli_a96ee8749078dbcf`） |
| 结果 | `verdict=VERIFIED`、`commitKey=1014593893a5d8c17639a6ad98453476`、回读 `rows:3/attachments:3/digest:a67f43f3…`、`publicationStatus=VERIFIED`、游标 `1→3`、退出码 0 |
| 独立回读 | `total=3` `has_more=false`；价格 `612 / 2198.27 / 2098.14`；每条 1 附件；三个日期字段已盖周期戳（2026-09-06 / 2026-09-12） |

**第一次尝试被 fail-closed 正确拦下**（缺 `--period-start/--period-end`，而克隆来的表含三个日期字段）：
`sideEffectRefs` 为空、游标 `1 → 0`、零写入。这是 2026-09-14 上午加的
「周表目标含日期字段必须盖周期戳」防线按设计生效——**闸门是对的**。

但它同时暴露出一个**失败分类缺陷**：该次收据的 `blocker.class` 是 `BUG`
（`nextAction=TERMINAL`，理由「bug suspected, stop automation」），而真实原因是**调用方漏了参数**。
链路已定位到行：`import-runner.mjs:81` 抛裸 `Error`（不带 `code`/`failureClass`）
→ `side-effect-ledger.mjs:53` 回落 `classifyExternalFailure`
→ `policy.mjs:159` 无状态码、消息不含关键词 → 落到 `return 'BUG'` → `STOP_AND_ALERT`。
这与 `policy.mjs:156-158` 自述的意图相反；另外三个适配器都已有 `FAILURE_CLASS_BY_CODE`
这类确定性映射，只有 `adapter.feishu-import` 没有。
行为影响有限（两种分类对该 run 都是终止），影响在**给运维的结论**：会把人引向排查代码而不是补参数。
细节与两个修复方案见 `docs/ops/TENANT-MIGRATION-MAP.md` §6。
