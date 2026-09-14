# 迁移 7：Agent Planner/Reviewer —— 「Agent 提议什么」与「运行时允许做什么」

> 本文对应实施计划「阶段 6：有限多 Agent 与高并发」的 Agent 部分，以及第 5 节迁移顺序的第 7 项
> （「Agent Planner/Reviewer：只在证据和 Policy 边界内做解析、分类、摘要和提案」）。
> 审查入口：`PHASE-ARCHIVE.md` §7.8；不变量见 `agent-sop-runtime-spec.md`。

## 1. 这一轮要解决的到底是什么

阶段 6 自带的验收条款里有一条最硬的：**「Agent 移除后确定性流程仍可运行」**。
阶段 6 上半（D7.2）已经把这条的**一半**做掉了：Agent 只能出 proposal，proposal 只能转成
`decisions`，所以拿掉 Agent 只少一条审计记录。但那只解决了「Agent 不能改状态」。

剩下的那一半是：**Agent 能提议并不等于运行时就会执行**。一条格式完全合法的提案仍然可能是错的——
选错能力、引用过期证据、漏掉前置条件、或者只是过度自信。如果「提案合法」直接等于「去执行」，
那么 Agent 层就成了一个绕过全部副作用闸门的侧门：它能挑一个带 `feishu_write` 的能力、
挑一个没登记的能力、挑一个仓库外的路径当输入，而所有这些在 proposal schema 上都**完全合法**。

所以本轮要交付的是一个**判决层**，它把一次 Agent 提议拆成四段，每段都有独立的否决权：

```
Planner（Agent）      从调用方预先批准的候选集里挑一个下一步，附理由与证据
   ↓
边界检查（确定性）     用注册表 + Policy + 文件系统事实判定「这个步骤允许被自动执行吗」
   ↓
Reviewer（Agent）     对已通过边界的步骤给 ACCEPT / REJECT / ESCALATE
   ↓
落点（Controller）     全部结论只进 decisions；要不要真的执行由编排层按 action 决定
```

四段里的每一段失败都**不抛异常**，而是明确返回 `RUN_FALLBACK`（走确定性兜底）或
`PAUSE_FOR_HUMAN`（停下来等人）。这就是「移除 Agent 后确定性流程仍可运行」在运行期的样子：
不是一句声明，而是四条出口。

本轮**没有**驱动任何真实能力集（没有接一条真实 SOP 去跑 Planner），这一点在第 6 节如实标注。

## 2. 交付物

| 类型 | 路径 | 变化 |
| --- | --- | --- |
| 新增模块 | `runtime/sop-runtime/agent-review.mjs` | Reviewer 契约、复核校验、复核端口、提案摘要 |
| 新增模块 | `runtime/sop-runtime/agent-planned-run.mjs` | PLAN 提案解析、四条确定性边界、`planNextStep` 四步流水、审计落点 |
| 修改模块 | `runtime/sop-runtime/policy.mjs` | 新增 `EXTERNAL_WRITE_EFFECTS`（外部写副作用的唯一清单） |
| 修改模块 | `runtime/sop-runtime/skill-manifest.mjs` | 删掉第二份手抄清单，改为同源 import |
| 修改模块 | `runtime/sop-runtime/publication.mjs` | 同上，且保留 `EXTERNAL_WRITE_EFFECTS` 的名字（调用方覆盖仍是逃生门） |
| 修改模块 | `runtime/sop-runtime/context-schema.mjs` | `CONTEXT_STATE_AXIS_FIELDS` 唯一清单；上下文新增 `sideEffects` |
| 修改模块 | `runtime/sop-runtime/task-admission.mjs` | 准入期把声明的副作用写进上下文 |
| 修改模块 | `runtime/sop-runtime/workflow-controller.mjs` | `advanceCursor` 收紧；新增 `recordDecisions` |
| 修改模块 | `runtime/sop-runtime/agent-proposal.mjs` | 角色化 manifest 校验、`AGENT_ROLES`/`REVIEW_VERDICTS`、导出共用判定、端口角色闸门 |
| 修改模块 | `runtime/sop-runtime/index.mjs` | 导出两个新模块 |
| 新增测试 | `runtime/sop-runtime/agent-review.test.mjs` | 13 例 |
| 新增测试 | `runtime/sop-runtime/agent-planned-run.test.mjs` | 14 例 |
| 修改测试 | `runtime/sop-runtime/workflow-controller.test.mjs` | 11 → 13 例（游标收紧 + decisions 入口） |
| 修改测试 | `runtime/sop-runtime/agent-proposal.test.mjs` | 同步 `AGENT_ROLES` / `REVIEW_VERDICTS` / `ROLE_INVALID` |
| 文档 | 本文、`PHASE-ARCHIVE.md` §7.8/§8/§9/§11、`README.md` 验证节 | — |

**没有改动**：`two-stage-runner.mjs`、`validator.mjs`、`side-effect-ledger.mjs`、`task-queue.mjs`、
`fanout.mjs`、任何 skill 目录下的 manifest 或实现。注册表因此完全没动
（`registryDigest` 与迁移 6 相同：`sha256:34936b1f…`，见第 4 节）——这是刻意的证据：
这一轮加的是「判决层」，不是「新能力」。

## 3. 关键决策

### D7.35 `advanceCursor` 收紧，判据取自**上下文里的准入声明**（取消归档里的欠账）

`PHASE-ARCHIVE.md` §9 曾把这条记为「有意延后：等第三个带外部写的能力迁完后收紧，排到迁移 7 一并做」。
条件早已满足（`xws.feishu.import`、`sycm.feishu.weekly`、`xws.sku.collection` 三条带外部写的能力已接入），
本轮把它做掉。

要回答的问题是：「谁有权推进游标？」——如果把答案放在 manifest 里，Controller 就得 import Skill 注册表，
凭空多一条核心层对能力目录的依赖；如果放在调用方参数里，那就等于依赖调用方老实。
最终的判据是**准入期已经写进上下文的 `sideEffects`**（`task-admission.mjs` 从 `spec.sideEffects` 抄一份）：

```js
const declaredWrites = (context.sideEffects ?? []).filter((effect) => EXTERNAL_WRITE_EFFECTS.includes(effect));
if (declaredWrites.length && context.publicationStatus === 'NOT_REQUESTED') {
  throw new ControllerError(..., { code: 'PUBLICATION_NOT_REQUESTED' });
}
```

三条性质同时成立：不依赖 manifest、不依赖调用方是否老实、核心层不必 import Agent 层。
只读运行（`sideEffects` 里没有写外部那一类）与 dry-run 采集路径（根本不调 `advanceCursor`，走 `succeed()`）
都不受影响——测试把这两条一起钉住了（同一用例里 `postgres_write` 被拒、`browser_read + local_artifact` 照常推进到 3）。

### D7.36 「外部写副作用」的清单上移到 `policy.mjs`，三处同源

原先 `feishu_write / external_publish / paid_provider_call / postgres_write` 这份枚举在
`skill-manifest.mjs` 与 `publication.mjs` 里各有一份拷贝。本轮起只有 `policy.mjs` 里一份，
另两处同源 import（`publication.mjs` 保留同名 re-export，调用方覆盖 `externalEffects` 仍是逃生门）。

依赖方向是刻意的：`policy.mjs` 是叶子模块（只 import `context-schema.mjs`），
Controller / skill-manifest / publication 都从它取。文档里写明它与 `SIDE_EFFECT_RISK` 的关系——
**清单不是从风险等级推出来的**（等级回答「要不要人工」，清单回答「要不要走发布段」），
但两者必须自洽，这条自洽关系由单测锁住：清单每一项都必须在风险表里、且不得是 `LOW`。

### D7.37 `decisions` 成为唯一审计落点，且**接口上**写不了状态轴

`controller.recordDecisions(runId, records)` 的签名里没有可写状态轴的位置——
它不是「按纪律不许改状态」，而是**没有那个参数**。另外审计记录**自身**也不许夹带状态轴字段
（`DECISION_STATE_MUTATION_FORBIDDEN`），否则 `decisions` 会变成状态的第二入口。
空写入与终态追加同样被拒（`DECISION_REQUIRED` / `TERMINAL_RUN`）。

这条是「Agent 不改状态」从*声明*变成*接口约束*的地方：Agent 的一切产物唯一的去处就是这里。

### D7.38 角色分离写进 manifest 契约；两个端口互为闸门

`manifest.role ∈ {planner, reviewer}`，**缺省 `planner`**（既有的 agent-capability-v1 manifest 不带这个字段，
行为必须保持不变——有用例守着）。角色决定「它必须声明什么」：

- planner 必须声明 `proposalKinds`；
- reviewer 必须声明 `reviewVerdicts`，且至少一种（否则这个 reviewer 表达不了意见）。

两个端口互为闸门：`createAgentPort` 只接 planner（拿到 reviewer 的 manifest 抛 `ROLE_INVALID`），
`createReviewerPort` 只接 reviewer。这不是洁癖——把 reviewer 的 manifest 挂到提案端口上，
「谁在提案、谁在复核」这条分离会静默失效。

### D7.39 复核必须绑定到**这一份**提案，自审按 name 判定

复核携带 `proposalDigest`（键排序序列化 + sha256），运行时重算并比对，不一致即 `PROPOSAL_MISMATCH`。
这条挡住的是最省事的那种作弊：**拿上一次的 ACCEPT 给这一次盖章**。

自审禁止按 `name` 判定，version 不同也不行——换个版本号就能自审等于没禁。
同时给了静态检查 `assertReviewerIndependent({plannerManifest, reviewerManifest})`，把角色与独立性一起判。

### D7.40 「有结论就必须有理由与证据」，ACCEPT 也不例外

三种结论（ACCEPT / REJECT / ESCALATE）都要求至少一条理由，且**每条理由必须带证据引用**。
ACCEPT 不被豁免，理由是：**橡皮图章式通过是最危险的一种复核产物**——无理由的否决至少还能追溯，
无理由的通过会在审计里留下一个看起来正常的空洞。`REASON_WITHOUT_EVIDENCE` 与 `EVIDENCE_REF_UNKNOWN`
是两条独立的拒绝码。

### D7.41 复核层与提案层**共用同一份**「禁止字段 / 状态轴泄漏」判定

`findForbiddenField` / `findStateAxisLeak` / `evidenceKeysOf` 从私有函数导出，复核层 import 它们。
不这么做的话，「提案不许夹带状态轴」与「复核结论不许夹带状态轴」会变成两套口径，
而两套口径的下场是可以预见的：其中一套会被绕过。

状态轴泄漏的检测刻意**只查键名为 `status/state/axis/phase/nextAction` 的位置**，不做全文子串匹配——
`READY / UNKNOWN / NONE / HELD` 这类取值是通用词，全文匹配会把正常理由一起误杀，
而误杀会让 Agent 层看起来「总是坏的」，最终被绕过，比挡住少数情况更危险。有用例专门钉住
「正文里出现 READY / UNKNOWN 不影响校验」。

### D7.42 步骤的四条边界全部在运行时硬判，不依赖 Agent 自觉

`boundCheckStep(step, {...})` 是纯函数，逐条回答：

| 边界 | 拒绝码 | 判据 |
| --- | --- | --- |
| 候选项必须由**调用方**声明 | `BOUND_CHECK_REQUIRED` | 没声明候选集就不存在「在边界内」这件事，fail-closed |
| 步骤必须落在候选集内 | `STEP_NOT_CANDIDATE` | Agent 不能发明能力 |
| 能力必须已登记 | `STEP_NOT_REGISTERED` | 否则等于绕开副作用闸门 |
| 声明写外部且未授权 | `STEP_REQUIRES_WRITE_AUTHORIZATION` | Agent 可以提议，运行时不会替它开闸 |
| 输入键必须在白名单内、值是标量 | `STEP_INPUT_FORBIDDEN` | `baselineCollectInput` 与 step 合并后再判，基线不能偷渡 |
| 路径类输入必须真实存在且在 `allowedRoots` 之下 | `STEP_INPUT_OUT_OF_ROOT` / `STEP_INPUT_UNRESOLVED` | Agent 不能指向不存在的证据，也不能指向仓库外的任意文件 |

`pathKeys` 的语义是**收窄**而不是开关：显式给非空列表就只检查这些键，给空数组（或不给）回落按键名后缀
（`file/dir/path`）自动识别。**`pathKeys: []` 无法关掉路径检查**——这是刻意的 fail-closed 方向。
逃生门是「把要检查的集合换成另一个」：真有 key 叫 `xxxPath` 却不是文件（例如浏览器 profile 名）时，
把 `pathKeys` 指到真正的路径键上即可（键集本身仍由 `allowedInputKeys` 收口）。两种语义都有用例。

### D7.43 `planNextStep` 永不抛异常，**且把「端口自己抛异常」也包住**

`createAgentPort` / `createReviewerPort` 已经把 Agent 的失败收成 `ok:false`，
但这一层不能假设调用方一定用那两个端口：有人直接塞一个裸适配器进来时，
「Agent 层坏掉把整条确定性 SOP 一起带走」是必须被挡住的。因此提案与复核两处调用都各加了一层 try/catch，
映射到 `details.code = 'AGENT_FAILED'`。有一条用例专门喂五种恶意输入
（端口缺方法、`propose` 返回 `null`、返回 `{ok:true, proposal:null}`、没有 reviewer……），
断言每一种都返回结构化收据、动作在枚举内、且**收据字段恒等**。

### D7.44 ESCALATE 不是失败；失败与「等人」是两条不同的出口

- `ESCALATE` → `action: 'PAUSE_FOR_HUMAN'`、`humanRequired: true`、`fallbackRequired: false`
  （既不走兜底也不执行提案，编排层据此停下）；
- 复核者坏掉 / 复核非法 → `RUN_FALLBACK`、`humanRequired: false`、`fallbackRequired: true`；
- `REJECT` → `RUN_FALLBACK`，把复核理由（`key: note`）放进取据的 `errors`。

返回收据的字段是**恒等**的：`humanRequired` / `fallbackRequired` / `decisions` / `errors` / `step` / `proposal` / `review`
在每条路径上都存在。失败路径显式给 `humanRequired:false` 而不是省略——否则调用方拿到 `undefined`，
而「`undefined` 恰好是假」会掩盖「这个字段到底有没有被设计出来」这件事。**这条正是本轮测试抓出来的**
（见第 5 节）。

### D7.45 PLAN 提案的表达面被收敛为三个 claim

Agent 只被允许用三个 claim 表达下一步：`next.capability` / `next.collectInput` / `next.reason`。
刻意用 key 白名单而不是把 `output` 整个当命令用：**Agent 能表达的东西必须可以穷举**。
缺 `next.capability` 即 `STEP_CLAIM_MISSING`，`collectInput` 不是对象即 `STEP_CLAIM_INVALID`。

### D7.46 复核者看到的是**已通过边界的归一化步骤**，不只是原始提案

`planNextStep` 把 `bound.step`（路径类输入此刻已解析成绝对路径并通过存在性/根目录检查）
一并交给复核端口，`createReviewerPort` 透传给 `runReviewer`。
不这么做「复核已通过边界的步骤」这句话在代码里就不成立——只会是一次对原始提案的复核，
而原始提案里的相对路径、未校验的键名都不是将要执行的东西。有用例断言 `seenStep` 深等于 `plan.step`。

### D7.47 两条闸门在**不同阶段**拦住同一种越界，都要有用例

「agent 只声明了 PLAN，却给出 CLASSIFY」与「agent 声明了 CLASSIFY，给出 CLASSIFY 但当步骤用」
是两件事，拒绝码分别是 `KIND_NOT_ALLOWED`（提案阶段）与 `PROPOSAL_KIND_NOT_PLAN`（解析阶段）。
两条都有用例——因为它们守的是不同的契约（能力声明范围 vs 步骤契约），
只留一条会让另一条静默退化。

## 4. 验证

```
node --test "runtime/sop-runtime/*.test.mjs"
# tests 244  pass 244  fail 0  cancelled 0  skipped 0   EXIT=0
#   迁移 7 新增/增量：agent-review 13、agent-planned-run 14、workflow-controller 11→13
#   上一轮基线 215 → 本轮 244（+29）

node scripts/run-test-suite.mjs skills --concurrency=1
# ==> skills: 42 file(s)
# tests 500  pass 500  fail 0  cancelled 0  skipped 0   EXIT=0（与迁移 6 基线完全一致）
#   本轮未改动 skills/ 下任何文件，因此这个数字是「没有回归」的证据，不是新覆盖

node scripts/run-test-suite.mjs runtime --concurrency=1
# ==> runtime: 59 file(s)
# tests 361  pass 361  fail 0  cancelled 0  skipped 0   EXIT=0
#   覆盖整个 runtime/（含 sop-runtime 的 244），新测试由目录发现自动纳入

node runtime/sop-runtime/build-skill-registry.mjs --check --write
# 10 manifest 通过（能力 8 + 适配器 2）
# registryDigest=sha256:34936b1f01b559be304ba756781e942904c7690f62ea3a9a6c4d838eddd53e48
# 告警 5 项，全部是 adapter.browser 显式外部依赖（共享 CDP 代理不在仓库内）
# ↑ 注册表与迁移 6 完全相同 —— 本轮没有新增/修改任何 skill manifest，这是「只加判决层、不加能力」的证据
```

本轮**新增**的三条关键断言（都是「实现缺陷会被这里抓到」的类型，不是覆盖率装饰）：

1. `workflow-controller.test.mjs`「声称要写外部的运行：发布未请求时游标不得推进（只读运行不受影响）」——
   同一用例里两种运行，一个被拒一个照常推进，防止把收紧写成「一律拒绝」。
2. `agent-review.test.mjs`「橡皮图章与无证据否决都不允许」——三种结论 × 四种理由形态（无理由 / 无证据 /
   空证据 / 未知证据）的 12 组组合全跑一遍，防止只对 REJECT 严、对 ACCEPT 松。
3. `agent-planned-run.test.mjs`「planNextStep 永不抛异常」——五种恶意输入 + 收据字段恒等。

## 5. 本轮抓到的真实缺陷

都是**测试先于实现写对**而抓出来的，其中第 1 条是契约缺口，第 2/3 条是我自己在本轮写代码时引入的
（同为「静态读起来没问题」的类型）。

1. **`createReviewerPort` 的失败返回路径缺 `humanRequired`（契约不完整）** ——
   成功路径返回 `humanRequired: verdict === 'ESCALATE'`，而两条失败路径（`AGENT_FAILED` 与复核非法）
   根本没有这个字段。代码读起来没问题（`undefined` 是假值，行为上「不等人」的语义恰好成立），
   但它把「这个字段到底有没有被设计出来」这件事埋掉了：调用方没法区分
   「明确地不需要人」与「这条路径忘了设置」。修法是让返回契约**全量**——
   每条路径都显式给出 `humanRequired`（失败恒 `false`），并把 `planNextStep` 的 `emptyPlan`
   与 `RUN_PLANNED` 分支同样补齐，用例改为断言 `Object.hasOwn(result, 'humanRequired')`。

   同类的一条：`planNextStep` 原先只在 `ESCALATE` 分支有 `humanRequired`，
   其余分支没有 → 测试改成对**每个**返回都断言字段恒等。

2. **`reviewed.error ?? (reviewed.errors ?? []).join('; ') || '…'` 是 SyntaxError** ——
   `??` 与 `||` 不能在同一个表达式里混用而无括号。这是我在给「裸端口兜底」加错误消息时写下的，
   `node --check` 直接报 `Unexpected token '||'`。教训很直白：**新代码路径必须单独跑一次语法检查**，
   整份套件是因为这个文件加载失败才报 `# fail 3`（三条用例全挂）——如果只有这一条路径被覆盖到，
   失败信号会指向别处。

3. **测试夹具把工具白名单的顺序写死**（同一份契约的第二份拷贝）——
   `assert.deepEqual(tools, ['read_evidence', 'read_context_summary', ...])` 手抄了一份 `READ_ONLY_TOOLS`，
   顺序与源不一致 → 断言在 `runReviewer` 内部抛错 → 被端口自己的 catch 收成 `AGENT_FAILED`
   → 表面症状是「合法复核被判失败」而不是「断言写错」。修法是改为 `[...READ_ONLY_TOOLS]`。
   **这类缺陷的形态值得记下来**：端口把内部断言失败降级成了业务结论，把测试错误伪装成了实现错误。

另外有两处是我的测试**期望**写错、实现未改，一并列出以免被误认为实现缺陷：
`markEvidenceValidated` 要求 `evidenceStatus === 'CANDIDATE'`（必须先 `completeAttempt`），
我先写成直接 `markEvidenceValidated`；`recordDecisions` 的版本断言写成绝对值 2，
而准入本身已经推进过一次版本（正确写法是「基线 +1」）。

还有一处是**文档与实现不一致**（不是缺陷，但审查者一定会问）：
`planNextStep` 的注释写「复核**已通过边界**的步骤」，而代码只把原始提案交给复核端口——
复核者其实看不到归一化的步骤。本轮按 D7.46 把 `bound.step` 一并透传，让这句话在代码里成立。

## 6. 未做项（刻意不做，避免范围膨胀）

1. **没有驱动任何真实能力集**。`planNextStep` 的入参（`registry` / `candidateCapabilities` / `allowWrite` /
   `allowedRoots` / `allowedInputKeys`）目前只由测试构造，运行时侧还没有一个「把某条 SOP 的下一步交给 Planner」
   的驱动器。理由：先要有**真实的多步 SOP**（当前迁移 2/3/4/5/6 都是单步或固定 fan-out），
   否则驱动器只能服务一个虚构场景。这是本轮最大的诚实缺口。
2. **没有接入真实模型**。Planner / Reviewer 在测试里是注入的确定性桩。接真模型需要先回答
   「模型输出非法时降级到什么」，而那正是本轮已经交付的四条出口——顺序上先有出口再接模型是对的。
3. **没有把「多 Agent 并发」做出来**。阶段 6 标题里有「高并发」，但并发扩容必须基于资源容量证据
   （实施计划第 6 节的风险条目）。本轮做的是 Agent 侧的分权与降级，lane 并发仍是 D7.4 / 阶段 6 lane 的结论。
4. **`AGENT_REJECTION` 里有三个码从未被抛出过**：`WRITE_EFFECT_FORBIDDEN`、`TOOL_NOT_READ_ONLY`、
   `FALLBACK_MISSING`。原因是 `validateAgentManifest` 把这三类问题全部折进 `MANIFEST_INVALID`，
   具体文本只出现在 `errors[]` 里，所以运行期永远拿不到这三个码（已核对：全仓库只出现在枚举声明与
   枚举断言里，没有任何 throw 点）。这不算缺陷——注册期的拒绝理由确实该收敛成一个码——
   但审查者应当知道这三个码目前是**声明性的**，不要以为按码分支能匹配到它们。
   （作为对照：`REVIEW_REJECTION` 的 10 个码全部有真实抛出路径。）
5. **`recordDecisions` 只做顶层状态轴检查，不递归**。理由：decisions 是**追加**进 `context.decisions`，
   不会被应用到上下文上，所以嵌套的轴名无论如何都改不了状态；顶层检查的实际作用是
   「不许审计记录*长得像*一个状态载体」。这是可辩护的取舍，但不是「不可能」，故列出。
6. **`assertAgentRemovable` 的检查仍是文本级**（正则匹配 `agent-(proposal|port|runner)`）。
   它足以守住当前的依赖方向（核心模块不得 import Agent 层），但换文件名就能绕过。
   真正可靠的做法是解析 import 图；本轮没做，因为注册表构建不跑这个检查。
