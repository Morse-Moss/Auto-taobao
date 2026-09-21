# 两件事：额度用尽单列一类 + xws 测试的锁隔离（2026-09-21 傍晚）

用户拍板（原话）：「1.修 / 2.那边你别管 / 3.不是将来，是肯定要，触发条件就要调用灰豚」。

- 第 1 件：修 `skills` 套件里那条「假红」的**测试隔离缺陷**（我上一轮列的第 1 项，用户回「修」）。
- 第 3 件：给「额度用尽」补一类**准确的告警措辞**（用户否掉了「等将来挂排期再说」——
  这条链的触发条件是 `优先级=A候选`，**一定会跑到额度墙**）。
- 第 2 件：另一会话正在改的那些文件，按用户要求**一个字没碰**。

## 一、xws-export-market-analysis 的测试隔离缺陷（用户「1.修」）

### 症状与根因

`skills` 套件里 xws 那一组红，失败体是：

```
{"status":"BUSY","error":"another Xiaowangshen market-analysis run is already active"}
```

根因不在被测代码，而在**用例把锁留在了机器级**：

- 锁的默认路径是 `os.tmpdir()/xws-runs/.market-analysis.lock`（`scripts/runtime-lock.mjs:249-256`）；
  **只有 `XWS_MARKET_ANALYSIS_LOCK` 能改它，`XWS_RUNTIME_DIR` 不影响锁路径**。
- `tests/prepare-flow.test.mjs` 里 **29 处** spawn 真 CLI 子进程，env 只传了 `XWS_RUNTIME_DIR`，
  子进程于是去抢那把**机器级**锁 ⇒ **同一台机器上并行跑两次套件必然互撞**。

### 修法

抽一个 `cliEnv(runtime)`，把锁**指到本用例自己的 runtime 目录**，29 处全部改走它：

```js
function cliEnv(runtime, extra = {}) {
  return {
    ...process.env,
    XWS_RUNTIME_DIR: runtime,
    XWS_MARKET_ANALYSIS_LOCK: path.join(runtime, ".market-analysis.lock"),
    ...extra,
  };
}
```

注意**没有**把锁关掉（不是传 `XWS_ADAPTIVE_LOCK_OWNER=1`）：子进程照常抢锁，只是抢的是自己那把 ——
隔离的是**作用域**，不是取消互斥。替换后自证：裸 env 残留 **0** 处、`env: cliEnv(` **29** 处。

### 守卫（新增 `tests/spawn-lock-isolation.test.mjs`，2 条）

为什么必须有判据：**漏一处不会在本文件报错**，只会在「并行跑套件」时以 BUSY 的形式炸出来，
而那时现象与改动点隔着好几层（实测就是这么发生的，花了三条独立证据才归因清楚）。

- 裸 env 零残留 + `spawn(` 数 == `env: cliEnv(` 数；
- 跨文件：用了 `XWS_RUNTIME_DIR` 的测试文件必须也处理 `XWS_MARKET_ANALYSIS_LOCK`；
- 防呆：`cliEnv()` 定义里真的设了锁（否则它只是「改了个名字」）。

### 验证

- **两份同时跑，各 39/39 全绿、exit 0、零 BUSY**（`lock-parallel-1.txt` / `lock-parallel-2.txt`）。
  这是**修复前必然互撞**的那个场景 —— 上一轮就是在同样的条件下出的
  `{"status":"BUSY",…}`，而这次两份各自跑完 37 条 prepare-flow + 2 条守卫、互不影响。
- **突变 2/2 CAUGHT_AND_NAMED**（`mutation-lock-isolation.txt`）：
  L1 某一处退回裸 env、L2 helper 里不再设锁 —— 两次都被上面第一条断言点名，还原后 sha256 逐字节一致。
- **完整 `skills` 套件 786/786 全绿**（`suite-skills.txt`，exit 0、`not ok` 零行）：
  这是本轮改动之后的完整分母。上一轮同一条命令是 **781 例 / 1 红**，而那 1 红正是本文件要修的那条 ——
  也就是说：**本轮之后，那个「假红」不再出现**。

## 二、额度用尽单列一类（用户第 3 问）

### 为什么不是复用 `POLICY_DENIED`

首轮把它并进了 `POLICY_DENIED`：**动作确实相同**（`FAIL`、当天收工、不自动重试）。
但**告警措辞**必须不同 —— `POLICY_DENIED` 的标题是「配置或授权不对，已拒绝执行」，
运营读到会去查配置和授权；而这里要做的是**等额度重置或升级套餐**。

用户明确了这条链「肯定要」跑到额度墙 ⇒ 告警指错人不可接受。
结论：**动作相同不足以成为复用的理由，分类的粒度决定告警指不指得对人。**

### 一个分类值同时活在四处，四处都要改

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | `runtime/sop-runtime/context-schema.mjs` | `FAILURE_CLASS` 增 `USAGE_LIMIT_REACHED`（第 9 类） |
| 2 | `runtime/sop-runtime/policy.mjs` | `actionForFailure` 增 case → `FAIL / 'platform usage limit reached, the quota resets on its own'` |
| 3 | `runtime/sop-runtime/round-notify-policy.mjs` | 增规则：`needs:CONFIG`、`retryAutomatically:false`、标题「平台今日额度已用尽」 |
| 4 | `db/migrations/008-*.sql` | DB 的 CHECK 约束补齐（见第三节） |
| 5 | `skills/huitun-to-feishu-keyword-heat/scripts/adapter.huitun-keyword-heat.mjs` | `FAILURE_CLASS_BY_CODE[USAGE_LIMIT_CODE]`：`POLICY_DENIED` → `USAGE_LIMIT_REACHED` |

### 接线是自动成立的（而且是个隐式约定）

`round-runner.escalationReasonFor()`（`:230-236`）**拿分类名当 key 去查通知表**，
查到 `plan:'NOTIFY'` 就原样返回 ⇒ 新分类的标题会直接出现在告警上。
反过来说：**只加分类、不加通知规则，你写的措辞永远不会出现**（会落 `ESCALATED_HUMAN` 的通用标题）。
`nonRetryable = NO_AUTO_RETRY_REASONS.includes(failureClass)`（`:669`）同理 —— 靠通知规则里的
`retryAutomatically:false` 才会「当天收工」。
⇒ 这条架构的隐式约定是：**分类名必须与通知表的 key 逐字同名**。

### 验证

- **端到端复核**（`verify-classification.txt`）：拿页面原文走真链路 ⇒
  `failureClass=USAGE_LIMIT_REACHED`、`action=FAIL`、**运行时词表里有**、CLI 退出码 2、保留页签 true；
  对照：真·空结果仍 `NO_EXACT_TOPIC / views 0`（没被连坐）。
- **新增一致性判据**（在适配器测试里）：**适配器给出的每个分类都必须是运行时词表里的一个值**。
  扫源码读词表（不 import，避免扩大跨目录依赖面），解析失败即断言失败（fail-closed）。
  它防的是「把分类名拼错 ⇒ 收据被上下文校验拒」这种静默故障。
- **突变 6/6 CAUGHT_AND_NAMED**（`mutation-2-usage-limit-class.txt`）：比首轮多一条 M6 ——
  把运行时词表里的新值删掉，由上面那条一致性判据点名。
- **灰豚技能 + sop-runtime 用例 474/474**（`huitun-and-sop-runtime-tests.txt`）：
  `sop-runtime` 那批包含「词表里的每个分类都必须在通知表里表态」的守卫，全绿即接线齐全。

## 三、DB 的 CHECK 约束：不补就是一颗雷（迁移 008）

`db/migrations/005-sop-runtime-context.sql:61-64` 给 `durable_attempts.failure_class` 建了 CHECK，
只认旧的 8 个值。**离线测试照不到它** —— 内存 store 对值域不做任何约束，所有用例都跑在内存 store 上。

后果与 006（`FAILED`）**完全同构**：失败路径把新分类写进权威 PG → CHECK 拒绝 →
异常从写入点抛出 → **连收据都落不下来**。

- `db/migrations/008-sop-runtime-usage-limit-class.sql`：`DROP CONSTRAINT IF EXISTS` + `ADD`（幂等、不碰数据行）；
- `db/migrations/008-rollback.sql`：还原成 8 值，**刻意 fail-closed**（表里还有新值就整体失败）；
- `runtime/verify-migrations-isolated.mjs`：加一段 008 验证，并**顺手加了一条漂移守卫** ——
  **代码词表 ⊆ DB 约束**（读 `context-schema.mjs` 提词表 + 查 `pg_get_constraintdef`）。
  006 与 008 都是这条漂移的产物，这条判据才是根治手段。

### 隔离库验证 49/49 通过（`migrate-008-isolated.txt`）

在临时库 `sop_verify_*` 上跑（跑完自动 `DROP DATABASE ... WITH (FORCE)`），**业务库一个字没动**。
其中「**前置反例**」最值得看：

```
PASS  008 前置：旧约束下 USAGE_LIMIT_REACHED 被拒（复现漂移）
PASS  008 后 USAGE_LIMIT_REACHED 可写入（失败路径从此能落库）
PASS  008 后非法值仍被拒（是补齐词表，不是拆掉约束）
PASS  008 rollback 在存在 USAGE_LIMIT_REACHED 行时按预期失败（fail-closed）
PASS  代码词表 ⊆ DB 约束（新加一类就必须配一条迁移）  — 9 个值全部被约束接受
```

### ⚠️ 需要你拍板：迁移还没 apply 到生产

008 只写了文件、只在临时库验过。**生产库 `xws_automation` 一个字没动**（数据库变更要单独授权）。
灰豚这条链目前仍未挂排期，所以**不 apply 不会立刻出事**；但真跑起来之前必须 apply，
否则那天会以「失败路径写不进库」的形式炸出来。

## 边界（不许含糊）

- **没有跑真实的配额墙**：今天额度已用尽，不该为了验证再撞一次；复核走的是页面原文 + 真链路函数。
- **迁移只在隔离库验证**，生产 apply 待授权（见上）。
- 另一会话在改的 `evidence/multi-shop-2026-09-20/*` 与 `skills/sycm-alimama-daily-report/*` **一个字没碰**。
