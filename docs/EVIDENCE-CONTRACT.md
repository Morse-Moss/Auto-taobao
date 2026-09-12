# 证据与事件约定（S0，SUPERVISOR-AGENT-DESIGN.md 3.4/8.2）

## events.jsonl 的地位

events.jsonl 是诊断与进度投影，不是恢复权威。PostgreSQL（durable_runs/durable_attempts/supervisor_commit_records）才是权威。两者不一致时不得"挑合理的"，必须记 EVIDENCE_UNKNOWN 进入对账。

## 事件关联约定

每个事件对象最少包含：

```json
{
  "at": "ISO-8601 时间戳",
  "event": "事件类型（PROGRESS/EXPORT_STARTED/PARTIAL_EXPORT_FAILED/...）",
  "runId": "Controller 分配的 run 身份",
  "attemptId": "当前尝试身份",
  "seq": "单文件内单调递增序号"
}
```

涉及工件的必须带 `artifactDigest`（sha256，由 runtime/supervisor-agent/proposal/schema.mjs#sha256Of 的规范化算法生成）。

## EvidenceSnapshot 约定

监督 Agent 的输入不由人工拼装 JSON，由 Controller 生成带 digest 的证据束：
- receipt（postgres_receipt）
- eventsTail（events_projection，最多 20 条）
- diagnostics（diagnostic_summary）
- experience（historical_experience）

见 runtime/supervisor-agent/proposal/schema.mjs#buildEvidenceBundle。Proposal 只能引用束内证据，digest 逐字匹配，由独立 Validator 校验。

## 现状声明

现有 xws 采集事件流（attempt 目录下 events.jsonl）尚未全部携带 runId/attemptId/seq 字段；补齐属 S1 后续工作，在补齐前事件流仅作诊断参考，恢复一律以 durable_* 表为准。
