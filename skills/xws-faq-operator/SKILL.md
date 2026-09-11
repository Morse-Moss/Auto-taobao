---
name: xws-faq-operator
description: "面向非技术运营的一句话 FAQ 周更入口：采集小旺神原文、本地完成可复现分类与汇总，并安全更新问题主库和周表。"
metadata:
  version: "3.1.0"
---

# FAQ 周更运营入口

这是运营唯一需要使用的 FAQ Skill。运营不需要知道脚本路径或公式；只有发布阶段需要确认 `问题主库` 和当前周表的 table ID。原始证据、分类明细和汇总过程由 Skill 保存在本地，运营最终验收 `问题主库` 与周期周表。

## 自然语言入口

将下列自然语言请求映射到对应动作：

- “执行本周 FAQ 采集，周期是 YYYY-MM-DD 到 YYYY-MM-DD”：启动或恢复本周任务。
- “检查 FAQ 进度”：读取本周期证据、收集状态和最近告警，只报告当前卡点。
- “继续上次中断的 FAQ”：从最后一个未完成商品或阶段继续，不重跑已验证数据。
- “把已验证结果更新到运营问题库”：在原始、分析、汇总全部通过后，执行固定表发布。

未给出周期时，先解析最新有效的 `竞品周_开始日期_结束日期`；无法唯一确定时停下并说明需要的周期。

## 总控命令

所有状态判断和确定性阶段推进统一使用 `runtime/run-faq-operator.mjs`。运营只说自然语言，Codex 负责解析周期并执行命令。

只读检查或恢复任务时先运行：

```powershell
node runtime/run-faq-operator.mjs --status --period-start YYYY-MM-DD --period-end YYYY-MM-DD
```

推进一个阶段时运行：

```powershell
node runtime/run-faq-operator.mjs --advance --period-start YYYY-MM-DD --period-end YYYY-MM-DD
```

每次 `--advance` 只推进状态收据给出的一个阶段。再次读取状态后才决定下一步，不把多个飞书写入或浏览器任务串成无法监管的长命令。

当下一步为 `COLLECT_EVIDENCE` 时，总控只返回 `BROWSER_ACTION_REQUIRED`。Codex 必须按本 Skill 的浏览器流程采集并保存真实证据；不得由脚本伪造浏览器完成状态。

只有运营明确说“更新运营问题库”时，才允许进入两阶段替换。总控只自动执行 `prepare` dry-run；候选表创建和最终切换必须分别执行并验证：

### 确定性调度器（可选的连续推进入口）

当运营要求“连续推进到下一个停点”时，使用 `runtime/run-flow-orchestrator.mjs`，它是上面 `--status`/`--advance` 循环的确定性封装，不是另一个状态权威：

```powershell
node runtime/run-flow-orchestrator.mjs --flow faq --period-start YYYY-MM-DD --period-end YYYY-MM-DD [--dry-run]
```

调度器的硬边界与总控一致：

- 每次只执行一个 `--advance`，执行后复读状态收据；连续两次推进后收据无变化则停止（`STOP_STUCK`），不空转。
- `COLLECT_EVIDENCE` 和 `REVIEW_AI_HUMAN_QUEUE` 一律停止并交给浏览器流程或人工队列，绝不代做。
- `PUBLISH_FEISHU_SUMMARIES` 需要显式 `--authorize-publish --master-table-id <ID> --weekly-table-id <ID> --operator-xlsx <文件>`；缺任一参数即停止（`STOP_AUTHORIZATION_REQUIRED`）。
- 每次决策追加到 `runtime/orchestrator/faq-<周期>/events.jsonl`，最终只输出面向运营的报告字段。
- 未知 `nextAction` 一律失败（fail-closed），不猜测。

调度器停在哪，Codex 就从哪个停点接管：浏览器停点回到浏览器流程，人工停点报告运营，授权停点请求运营确认。

```powershell
node runtime/publish-faq-detail-enrichment.mjs --phase prepare --period-start YYYY-MM-DD --period-end YYYY-MM-DD --operator-xlsx <运营-xlsx> --master-table-id <问题主库-table-id> --weekly-table-id <问题库-周表-table-id>
```

`prepare --apply` 只创建、写入和回读两张候选表，不改名、不删除旧表。随后用 candidate receipt 的精确 SHA-256 和两张候选 table ID 执行 `switch` dry-run；验证通过后才允许独立执行 `switch --apply`。

## 固定流程

1. 锁定有效竞品中的 A-爆款竞品和 B-高价值竞品，按飞书公式月收货人数降序、序号升序取 TOP5。
2. 使用共享 `web-access` 浏览器和小旺神逐个获取问大家 CSV、评论原文 ZIP；遇到登录、验证、风控、额度或导出失败立即停在当前商品并记录告警。
3. 通过 `runtime/run-question-library-collection.mjs` 校验证据并生成本地 `raw-records.jsonl` 与 `raw-snapshot-receipt.json`，原始内容不得改写。
4. 通过 `runtime/run-faq-text-analysis.mjs` 生成本地 `classified-records.jsonl` 与 `classification-receipt.json`；规则版本必须写入记录，禁止调用飞书 AI 代替固定规则。
5. 对规则层判为 `需人工核验` 的逐主题候选，使用固定版本 AI prompt 复核；AI 结果必须通过任务身份、连续原文证据、置信度和判断一致性质量门，未通过或 provider 失败的任务进入本地人工队列。
6. 将 AI 结论与运营人工决议合并为最终分类快照；人工队列清零并生成可审计确认结果前，不得生成最终汇总或进入发布阶段。
7. 通过 `runtime/run-faq-topic-summary.mjs` 从最终分类快照生成本地周汇总和全部有效周累计汇总；跨周去重、出现次数和占比均由本地确定性规则计算。随后通过 `runtime/publish-faq-detail-enrichment.mjs` 从最终 source-topic 快照全量生成候选问题主库和周期周表，完整验证后安全替换旧表。

## 双表明细替换规则

- 每个实际提及主题必须是独立的 `来源记录唯一键 + 分类标签` 正式行；明确正面提及的问题主题保留该行并判 `否`，未提及主题不得伪造 `否` 行，也不得生成来源×全部主题的笛卡尔积。
- 本地最终分类快照必须绑定当前规则版本、完整 artifact SHA-256、source-topic 集合 SHA-256、遗留主题审计和零人工队列；任何不一致直接阻断。
- `是否痛点` 是逐条主题判断，只允许 `是`、`否`、`需人工核验`；人工补充主题必须物化为正式分类行，不再使用 `补充主题` 文本代替。
- 明细表按唯一 `来源记录唯一键` 计算分母；每个分类标签的 `出现次数` 是关联的唯一来源数，`占比=出现次数/唯一来源分母`。同主题每条明细重复写入该统计值，运营字段顺序固定为 `出现次数`、`痛点描述`、`典型问题`、`典型用户原话`、`占比`。
- `prepare` 默认 dry-run；`prepare --apply` 只允许快照旧表、创建两张唯一候选表、写入和回读，产出绑定四个 table ID、schema、行内容和源 artifact 的 candidate receipt，绝不改名或删除旧表。
- `switch` 必须接收 candidate receipt 的精确 SHA-256 和两张候选 table ID，再次验证候选内容后先完成双表改名和回读。只有两张新表均使用正式名称且内容哈希不变，才允许删除两个精确旧 table ID。
- 改名阶段失败时按 table ID 恢复名称并停止；删除第一张旧表后第二张失败时停止并保留第二张 rollback 表，不伪造恢复。
- operator 只有读取 `REPLACEMENT_APPLIED_AND_VERIFIED` 收据，并验证动态行数、内容哈希、唯一来源分母、主题统计哈希、备份、candidate receipt 及两个旧 ID 均已删除后，才进入 `DONE`。

## 状态和报告

每个周期必须保留以下机器可读收据：

- TOP5 锁定清单
- 每个商品的原始文件哈希和采集状态
- 本地原始快照收据
- 本地分类快照收据
- 本地周汇总和累计汇总收据
- 候选表 prepare 收据、旧表备份和最终替换收据
- 统一状态收据 `runtime/faq-analysis/<周期>/operator-status.json`

对运营的最终报告只包含：周期、TOP5 数量、原始记录数、去重有效记录数、主库与周表行数、是否完成、阻断原因和下一步动作。
不要要求运营阅读 JSON、公式或内部表结构。

状态收据是恢复依据：下游汇总收据已回读验证分析表时，可恢复缺失的旧版分析收据；固定表发布必须通过周期字段，或同时通过来源分析表与汇总表名称确认属于当前周期，禁止用上一周收据误判完成。

## 非目标

- 不在 `问题主库` 或周表中新增周期字段或技术关联字段。
- 不使用飞书 AI 代替可复现分类规则。
- 不绕过淘宝验证码、风控、登录或小旺神额度限制。
- 不在原始表上覆盖或改写原文。
