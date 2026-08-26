---
name: xws-faq-operator
description: "面向非技术运营的一句话 FAQ 周更入口：采集小旺神原文、完成可复现分类、用飞书公式统计，并安全更新固定问题库。"
metadata:
  version: "1.1.0"
---

# FAQ 周更运营入口

这是运营唯一需要使用的 FAQ Skill。运营不需要知道 Base ID、表 ID、脚本路径或公式。内部日期表和分析表
由 Skill 自动管理，运营最终只验收固定的 `问题库` 表。

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

只有运营明确说“更新运营问题库”时，发布阶段才允许增加 `--replace-current`：

```powershell
node runtime/run-faq-operator.mjs --advance --replace-current --period-start YYYY-MM-DD --period-end YYYY-MM-DD
```

## 固定流程

1. 锁定有效竞品中的 A-爆款竞品和 B-高价值竞品，按飞书公式月收货人数降序、序号升序取 TOP5。
2. 使用共享 `web-access` 浏览器和小旺神逐个获取问大家 CSV、评论原文 ZIP；遇到登录、验证、风控、额度或导出失败立即停在当前商品并记录告警。
3. 通过 `runtime/run-question-library-collection.mjs` 写入日期原始表 `问题库_开始日期_结束日期`。原始内容不得改写，分析字段保持空。
4. 通过 `runtime/run-faq-text-analysis.mjs` 使用固定规则生成 `问题库分析_开始日期_结束日期`。规则版本必须写入记录，禁止调用飞书 AI 代替固定规则。
5. 通过 `runtime/run-faq-topic-summary.mjs` 创建日期汇总表；`出现次数` 必须由飞书公式回读验证。
6. 通过 `runtime/sync-question-library-template.mjs` 将已验证结果同步到固定 `问题库`，只保留运营需要的八个字段。

## 固定表发布规则

- 首次发布：固定 `问题库` 为空时创建全部记录。
- 重复发布：同一周期且内容完全一致时报告 `toCreate=0`，不重复写入。
- 新周期发布：固定表已有其他周期数据时，必须使用明确的“更新运营表”意图；脚本先保存本地备份，再删除固定表旧记录、写入新记录并回读验证。
- 替换期间任何写入失败，先清理部分新记录，再用备份恢复旧记录；恢复失败必须报告为阻断，不得宣称完成。
- 不删除日期原始表、分析表或汇总表；它们是内部追溯和复现证据。

## 状态和报告

每个周期必须保留以下机器可读收据：

- TOP5 锁定清单
- 每个商品的原始文件哈希和采集状态
- 原始表写入收据
- 分析表写入收据
- 飞书汇总公式回读收据
- 固定问题库发布收据
- 统一状态收据 `runtime/faq-analysis/<周期>/operator-status.json`

对运营的最终报告只包含：周期、TOP5 数量、原始记录数、问题库记录数、是否完成、阻断原因和下一步动作。
不要要求运营阅读 JSON、公式或内部表结构。

状态收据是恢复依据：下游汇总收据已回读验证分析表时，可恢复缺失的旧版分析收据；固定表发布必须通过周期字段，或同时通过来源分析表与汇总表名称确认属于当前周期，禁止用上一周收据误判完成。

## 非目标

- 不在固定问题库中新增周期字段或技术关联字段。
- 不使用飞书 AI 代替可复现分类规则。
- 不绕过淘宝验证码、风控、登录或小旺神额度限制。
- 不在原始表上覆盖或改写原文。
