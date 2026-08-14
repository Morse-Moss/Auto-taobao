# 关键词公式与 AI 配置续作指针

当前阶段：FORMULAS_VERIFIED_PROMPTS_READY。
最近验证：授权副本已创建并保留 300 行；10 个确定性字段已转为公式并通过 API 与浏览器验收；7 个 AI 字段的提示词已交付但未运行。
下一动作：用户审核提示词后，手动配置 7 个 AI 字段，或明确授权批量 AI 额度后再启用运行。

## StagePacket

```yaml
stage: keyword-formula-ai-copy
outcome: 创建授权测试副本；配置不会触发额度且不会丢失数据的固定值/公式字段；交付 AI 字段的可粘贴提示词；明确暂缓字段
controls:
  execution: STAGED
  risk: STANDARD
  delivery: DEPLOYED
state: HANDOFF
preset: null
scope:
  owned:
    - 用户授权的 `词库 最新` 云端副本
    - `关键词 最新字段` 的现有 22 个字段
    - 本地字段合同、提示词与验证证据
  forbidden:
    - 原飞书表格的任何修改
    - 密码、Cookie、Token、浏览器存储或凭据内容
    - 未经授权的批量 AI/Provider 额度消耗
  unrelated_or_unknown:
    - 原 Base 内其他业务表及用户浏览器标签页
dod:
  - 交付可访问的副本 URL
  - 原表字段和记录保持不变
  - 22 个字段均有明确处理合同
  - 可安全配置的公式或固定值已写入副本
  - AI 提示词若不能无额度触发地配置，则提供可直接粘贴的最终文本
  - 用真实搜索词样例验证字段依赖和输出边界
approvals:
  - policy_id: BOUNDED_PREAUTH
    action: 复制指定飞书 Base 并只修改副本
    evidence: 用户于 2026-08-09 明确要求复制并配置
verification:
  focused:
    - 读取副本 Bitable 前端模型的字段、类型与记录数
  stage_exit:
    - 对照字段合同检查 22 个字段
  real_observation:
    - 副本可访问、原表未变、样例行公式结果可见
review:
  shape: combined
  correction_budget: 2
knowledge_impact:
  - 若形成稳定字段合同，再评估是否更新项目知识文档
non_goals:
  - 不重构原项目自动化
  - 不伪造内容热度或趋势变化
  - 不触发未经授权的 300 行 AI 批量运行
```

## 2026-08-09 验证结果

- 副本：`https://rcndesfqro3x.feishu.cn/base/N21Abkg0HakO6AsbCaDckvcwnVd?table=tblftWXw8cCKosGV&view=vewZowKrE8`
- 目标表：`关键词 最新字段`
- 记录数：300
- 字段数：22
- 原表与副本前五列排序后 SHA-256：`de4e2e36a3b5cfbd4f7ce1485992a8198eb54811d8568a33b0d3270cde218478`
- 公式字段：`关键词编号、一级类目、主关键词、原始关键词、平台来源、搜索热度、交易热度、趋势变化、是否重点词、优先级`
- `原始关键词` 与 `搜索词` 逐行差异：0
- 搜索热度分布：高 24，中 76，低 200
- 交易热度分布：高 48，中 100，低 97，无数据 55
- 公式错误：0
- 未识别热度：0
- `优先级` 当前全部为 `待分析`，因为 `用户意图` 尚未运行 AI
- `对应产品方向` 四个单选项已去除前导空格，记录仍为空
- AI 提示词工件：`runtime/keyword-formulas-ai-prompts-20260809.md`
- 浏览器证据：`runtime/keyword-formulas-copy-right-20260809.png`、`runtime/keyword-formulas-copy-active-20260809.png`
