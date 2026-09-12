# PROTOTYPE 定位声明（S0 边界门禁）

本目录当前状态：**确定性故障分诊原型**，不是生产 Agent Runtime。

依据 SUPERVISOR-AGENT-DESIGN.md 第 0/3/8 节的代码事实判断：

- diagnose.mjs 的经验匹配与规则分类是确定性函数，属 `deterministic-triage`，不是 Agent。
- llm.mjs 是一次 HTTP 诊断钩子原型：没有受限工具、没有 proposal 持久化、没有独立策略闸门。
- actions.mjs 的白名单+预算是纯策略部分，保留；生产动作必须走预注册 Capability/ActionIntent（见 proposal/ 子目录）。
- CLI `--apply` 未接真实动作执行器，不构成生产动作闭环。
- experience.json 是版本化候选策略快照，不是记忆权威。

生产方向的真实 Agent 提案切片在 `proposal/` 子目录（S2），监督处置闭环（S3）见 action-intent.mjs。

持久化状态（2026-09-12）：DDL 001-supervisor-tables.sql 已获授权执行，5 张 supervisor_* 表已建于 xws_automation（owner xws_agent），ProposalStore postgres 后端冒烟验证通过（写入/读回/幂等键冲突保护）。经验与提案的权威存储已可切 PG；文件投影仅作审计。

在任何 S1 验收（真实单分片耐久闭环）完成前，本目录任何代码不得在生产路径上自动执行业务动作。
