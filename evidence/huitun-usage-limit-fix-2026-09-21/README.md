# 灰豚配额墙的失败分类：修掉「报成 BUG」的小口子（2026-09-21）

## 修的是什么

配额用尽时，`flow.mjs` 抛的是一个**不带 code 的普通 `Error`**。后果有两条，方向不同：

- **运行时那侧**：适配器的 `FLOW_ERROR_RULES` 是按消息文本翻译的，没有匹配它；按该函数自己的注释
  「未命中规则的异常原样抛出」，它原样落到 `worker-adapter.failureClassOf` 的兜底分支 ⇒ 实测归 **`BUG`**
  ⇒ `actionForFailure('BUG')` = **`STOP_AND_ALERT`**（「bug suspected, stop automation」）。
  语义上是「我们的代码有 bug、停线」，事实是「这个免费账号今天的额度用完了」——**指错了人**。
- **CLI 那侧**：`run-huitun-topic-heat.mjs` 的 803/883 行读的是 `error.code`（不读 `failureClass`），
  没有 code ⇒ 退出码 1、并且**关掉**本次页签。

修之前那份取证（手写 error 的对照实验）＝`evidence/huitun-run-2026-09-21/quota-wall-failure-class.txt`。

## 改成什么

| 位置 | 改动 |
| --- | --- |
| `flow.mjs` | 新增导出 `USAGE_LIMIT_CODE = 'USAGE_LIMIT_REACHED'`；配额墙抛错时挂 `error.code` 与 `error.details.evidence`（平台原文） |
| `adapter.huitun-keyword-heat.mjs` | `FAILURE_CLASS_BY_CODE[USAGE_LIMIT_CODE] = 'POLICY_DENIED'`（**本轮已改为 `'USAGE_LIMIT_REACHED'`**，见末节）；`translateFlowError` 加一条按 **code** 翻译的分支（消息里带平台原文、会变，不能拿它当判据） |
| `run-huitun-topic-heat.mjs` | 新增纯判据 `cliExitCodeFor(error)` / `preserveBrowserFor(error)`，**两个调用点都改成走函数**；help 里写明退出码含义 |

为什么归 `POLICY_DENIED` 而不是 `HUMAN_REQUIRED`：`round-notify-policy.mjs` 里两者的
`retryAutomatically` 相反 —— 配额当天不会自愈，落 `HUMAN_REQUIRED` 会**每 15 分钟白重试到当日上限**
（每次都再撞一次墙），而 `POLICY_DENIED` 是 `false`（当天收工、等人补配置：升级套餐或等明天）。
代价是现成 8 类里没有一类的措辞完全贴切（标题写「配置或授权不对」），这一点如实记在这里，不粉饰。

**2026-09-21 本轮修正**：上面那句「没有一类的措辞完全贴切」被落实了 —— 新增第 9 个失败分类
`USAGE_LIMIT_REACHED`（动作与 `POLICY_DENIED` 完全相同：FAIL、当天收工、不自动重试；唯一区别是
**告警措辞**，标题为「平台今日额度已用尽」），并把 DB 的 CHECK 约束一起补齐（迁移 008）。
触发理由：这条链的触发条件是 `优先级=A候选`，**一定会跑到额度墙**，告警把运营指去「查配置」不可接受。
证据＝`evidence/usage-limit-class-and-lock-isolation-2026-09-21/`。

## 验证

1. **端到端复核**（`verify-classification.txt`，脚本同目录，拿页面原文走真链路、不手写 error）：

```
error.code        "USAGE_LIMIT_REACHED"
failureClass      "POLICY_DENIED"        （修前：BUG）
actionForFailure  action=FAIL  reason="policy denied"   （修前：STOP_AND_ALERT）
cliExitCodeFor    2        preserveBrowserFor  true     （修前：1 / false）
对照：真·空结果仍是 NO_EXACT_TOPIC / views 0（没被连坐）
```

2. **技能用例 72 → 75 全绿**（`huitun-tests.txt`）：新增 2 条 CLI 判据用例、1 条**扫源码的接线判据**
   （扫描 `flow.mjs` 里所有 `error.code = …`，要求每个都被映射成分类且不为 `BUG`）。
   这条接线判据的动机很具体：**「加了新 code 却忘了映射」的后果是静默的** —— 它会掉进兜底分支，
   又以「疑似缺陷、停线」的形式出现。
3. **突变 5/5 CAUGHT_AND_NAMED**（`mutation-usage-limit-class.txt`）：① flow 不再挂 code；
   ② 分类表不再映射；③ `translateFlowError` 不再按 code 翻译；④ CLI 退出码判据不认这个 code；
   ⑤ 调用点退回内联清单（判据函数还在但没人用）。每次还原后 sha256 逐字节一致。
   其中 ①②③ 都被那条接线判据一并抓住 —— 它是这几处唯一同时覆盖两条轴的判据。

## skills 套件整跑：781 例 / 780 绿 / 1 红（红在**别的技能**，由并发占锁造成）

原始输出 `suite-skills.txt`（exit 1）。唯一红的用例：

```
not ok 608 - full flow waits for a delayed XLSX export menu
  location: skills/xws-export-market-analysis/tests/prepare-flow.test.mjs:1649
  error: {"status":"BUSY","error":"another Xiaowangshen market-analysis run is already active"}
  1 !== 0
```

归因（三条互相独立的证据，都不指向本次改动）：

1. **那把锁是机器级的、且当时真有别的进程在持有**：`os.tmpdir()/xws-runs/.market-analysis.lock`
   两次探针（`suite-lock-state-{1,2}.txt`）相隔 28 秒，持有者 PID 从 `56996` 换成 `56060`，
   时间戳一路刷新 ⇒ 有一个 **market-analysis 运行循环**在跑，不是「残留的陈旧锁」。
2. **持有者是另一次套件运行的子进程**（`suite-node-processes.txt`）：
   `run-test-suite.mjs skills` → `node --test …` → `prepare-flow.test.mjs` → 真 CLI 子进程；
   并且另一次套件运行的原始输出（`evidence/keta-func-permission-judge-2026-09-21/suite-skills.txt`，
   无收尾汇总 ⇒ 跑还在进行中）里有**同一句 BUSY 的 6 条红**（#582–#587）。
   ⇒ 这个失败形态**与本次改动无关地独立出现过**。
3. **本次改动碰不到它**：`skills/xws-export-market-analysis/` 全目录 grep `huitun|USAGE_LIMIT_CODE` **零命中**。

**这是既有的测试隔离缺陷，不是本次引入的**：市场分析的用例会 spawn 真 CLI 子进程，而子进程取的是
`os.tmpdir()` 下的**机器级锁**（用 `XWS_MARKET_ANALYSIS_LOCK` 才能改路径，这些用例没设）
⇒ **同一台机器上并行跑两次 skills 套件，这一组必然互撞**。本次没修它（不在授权范围内），记在这里。
本技能自身的用例（含本次新增的 3 条）**75/75 全绿**，见 `huitun-tests.txt`。

## 边界（不许含糊）

- 这条失败**只可能从浏览器采集段（CLI）出来**：`classifyTopicSnapshot` 的调用点只有
  `advanceQuerySettlement`（浏览器轮询那一支）。适配器侧这次的改动是**分类正确性**，
  不是「今天有无人值守流程会因此停」——该能力仍未挂排期。
- 本次**没有**跑真实配额墙（今天额度已用尽，且不该为了验证再撞一次）；验证走的是页面原文 +
  真链路函数，不是模拟浏览器。
