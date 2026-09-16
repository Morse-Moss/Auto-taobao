# 成熟 Agent 架构的组件清单 × 本仓库实测对账

日期：2026-09-16
问题：系统有没有借鉴成熟 agent 架构（ADK 等）？真正要用的能力（挂载 skills、用 tool、上下文管理、记忆管理）是不是缺的？

方法：不讨论框架优劣。先把成熟框架的标准组件列成清单，再逐个在本仓库里找对应物 **并实测它有没有生产调用点**。对一个模块，只有「文件存在」不算有，必须有非测试、非 `index.mjs` 导出的真实调用方。

---

## 0. 结论

1. **组件清单基本齐了。** 你点的四项（skills 挂载、tool、上下文管理、记忆管理）本仓库**全都有实现**，而且记忆管理做得比多数框架更严谨（五层 + 优先级 + 过期 + 当前证据恒压历史）。
2. **真正的缺口不是组件，是接线。** `runtime/sop-runtime/` 35 个模块里，除了 3 个本身就是 CLI 入口，有 3 个模块**零生产调用点**，分层记忆则只有导出没有使用者。而这三个恰好就是「AI 相关」的那三个。
3. **所以现在缺的不是引入 ADK，是把自己已经建好的那份接上。** 引入 ADK 只会带来第二套同类抽象，并且它的执行模型与本仓库的硬不变量冲突（见 §3）。

---

## 1. 标准组件 × 本仓库映射

| 成熟框架标准组件 | 本仓库对应物 | 是否在用 |
| --- | --- | --- |
| **Skills 挂载** | `skill-manifest.mjs`（manifest + semver + capabilities）、`skill-discovery` / `skill-loader` / `skill-registry` / `build-skill-registry` | **是**，`runtime-bootstrap` / `two-stage-runner` 走 loader |
| **Tool 接入** | `policy.mjs`（capability + `RISK_CLASS` + lane）、`worker-adapter.mjs`、`validation-registry.mjs`；Agent 侧 `READ_ONLY_TOOLS` | **是** |
| **上下文管理** | `context-schema.mjs`（五条状态轴）、`compression-service.mjs`（结构化摘要 `sop-summary-v1`） | 前者在用；**后者零调用点** |
| **记忆管理** | `memory-store.mjs`：五层 `RUN_CONTEXT / EVIDENCE / VERIFIED_FACT / RULE_DECISION / EXPERIENCE`，带优先级、过期判定、退役不物理删除、「当前 run 证据恒高于历史」 | **零调用点** |
| **编排** | `workflow-controller.mjs`、`task-queue.mjs`、`capability-scheduler.mjs`、`fanout.mjs`、`two-stage-runner.mjs` | **是** |
| **状态存储** | `store-port.mjs` + `stores/pg-store.mjs`（生产）/ `stores/memory-store.mjs`（单测） | **是**（PG） |
| **恢复 / 断点续跑** | `leaseStatus` 轴、`side-effect-ledger.mjs`、`evidence-store.mjs`、`run-liveness.mjs`；故障注入 `recovery-fault-injection.mjs` | **是**（S1 已跑 15/15） |
| **人机闸门（HITL）** | `humanGateStatus` 轴、`publication.mjs` | **是** |
| **可观测 / 审计** | `evidence-store`、`decisions`、`side-effect-ledger`、收据 | **是** |
| **Planner** | `agent-planned-run.mjs`（`planNextStep` + 四条硬边界） | **零调用点** |
| **Reviewer / 对抗复核** | `agent-review.mjs`（`ACCEPT / REJECT / ESCALATE`） | **零调用点** |
| **Agent 接入契约** | `agent-proposal.mjs`（唯一入口、只读工具面、证据强制、兜底、可移除性静态证明） | 在门禁内，**零生产调用点** |
| **长期经验复用** | `supervisor-agent/experience.mjs` | 原型，**不在任何测试套件** |

结论：**唯一系统性缺失的是「AI 那一侧的接线」**，其余组件都在正常服役。这条恰好与上一轮 `LLM-PLACEMENT-AND-AI-NATIVE-CRITERIA.md` 的结论一致，只是这次有量化证据。

---

## 2. 实测：35 个模块的调用点分布

统计口径：对每个模块，在**全仓库**范围找引用它的文件，排除该模块自身、排除 `index.mjs`（纯导出，不构成调用）、排除 `*.test.mjs`。

- **有生产调用点：28 个**（`context-schema` 9 处、`policy` 10 处、`workflow-controller` 4 处…… 依赖网是活的）
- **零生产调用点：7 个**，其中
  - 3 个是 **CLI 入口**，本来就该没人 import：`round-runner.mjs`、`run-faq-fanout.mjs`、`run-feishu-import-two-stage.mjs`
  - 1 个是**测试装置**：`recovery-fault-injection.mjs`（故障注入，只在 S1 里被驱动）
  - **剩下 3 个是真缺口**：`agent-planned-run.mjs`、`agent-review.mjs`、`compression-service.mjs`

另外单独说明：分层记忆 `memory-store.mjs` 的唯一非测试引用是 `index.mjs:18` 的 `export *`。**没有任何运行时模块使用它。**

顺带发现一处名实不符：`memory-store.mjs:145` 注释写「PG 端口见 `stores/pg-memory-store.mjs`」，而 `stores/` 目录下实际只有 `memory-store.mjs` 与 `pg-store.mjs`，**该文件不存在**。也就是说分层记忆目前**没有持久化后端**，只有内存实现。

---

## 3. 对 ADK / 同类框架的取舍判断

判断分两层，结论不同：

**该借的：组件清单与抽象命名。**
它们把「agent 系统要有什么」沉淀成了一份可核对的清单，价值在于**当检查表用**——用它逐项核对本仓库，马上就能发现「压缩服务建了没人用」这种问题。本轮做的事就是这个。

**不该借的：执行模型。**
ADK 这类框架的默认心智是 **LLM 在控制流里**：模型决定下一步调什么工具，框架负责执行。这在本仓库会同时撞上两条硬约束：

- **C1 外部副作用不可回滚**：框架让模型直接调工具，而本项目的写侧必须 fail-closed。
- **C4 移除模型后确定性流程仍可运行**（`SUPERVISOR-AGENT-DESIGN.md:799`，且有 `assertAgentRemovable` 静态检查守着）：LLM 在控制流里，这条不变量直接不成立。

而且本仓库的 `agent-planned-run.mjs` 已经给出了替代形态，其头注释就是设计声明：
`Planner 从调用方预先批准的候选集里挑一步 → 确定性边界检查 → Reviewer 复核 → Controller 落点，全部结论只进 decisions`（`:5-8`）。
这个形态比「模型自由选工具」更弱、更慢，但它让 C1/C4 同时成立——这是刻意的取舍，不是落后。

**一句话：借它的清单，不借它的控制流。**

---

## 4. 关于「PI」

你提到的「PI」我不能确定指哪一个，所以不猜着评。可能是：

- **PydanticAI**：价值在类型化工具契约与依赖注入。与本仓库 `agent-proposal.mjs` 的思路同源（结构化 schema + 校验后才放行），属于「值得对标的同构方案」，不是要替换。
- **阿里云 PAI**：那是模型训练/推理平台，与 agent 编排不是同一层；若你指的是它，方向是「模型侧托管」，与本轮的接线问题正交。
- 其他（Inflection Pi 等）：属对话产品，不构成架构参考。

一句话告诉我哪个，我重新对一遍，不空谈。

---

## 5. 缺的到底是什么（三件事，按顺序）

1. **接线**：让 `workflow-controller` 成为 `agent-planned-run` 的调用方——它已经声明「要不要执行由编排层按 action 决定」，但这一层映射没写。这是三处零调用点里唯一需要动编排的地方。
2. **触发与判据**：即使接上，也没有事件去唤起它，也没有语义判据决定何时该唤起（同 `ROOT-CAUSE-AND-SELF-HEALING-PLAN.md` §4 动作 1/2）。
3. **门禁**：`compression-service`、分层记忆这两个已建模块必须先进测试套件并接上持久化后端（`stores/pg-memory-store.mjs` 目前不存在），否则它们会继续以「看起来建好了」的状态腐烂。

---

## 6. 一句话回答你的两个问句

- 「系统有没有借鉴成熟 agent 架构」→ **结构上高度同构**（组件齐、抽象对、约束更严），但没有借任何框架的执行模型，这是有意的。
- 「skills / tool / 上下文 / 记忆是不是都需要」→ **都需要，而且都写了**。问题不在「有没有」，在「AI 那三个模块没被接上」，以及「压缩与记忆没有持久后端」。
