// 监督 Agent L3 第三级：LLM 诊断钩子。
// 最后手段：经验库与确定性规则都无法分类时才调用。
// 全链路 fail-closed：未配置、网络错误、输出非法，一律返回 null（升级人工），
// 绝不让模型的不确定输出进入执行路径。

import { FAILURE_CLASSES, incidentSignature } from './diagnose.mjs';
import { isActionSafe } from './actions.mjs';

const WHITELIST_SCHEMA_PROMPT = `你是电商采集系统的故障诊断员。根据故障报告判断根因并给出处置。
只允许输出 JSON，结构：
{
  "failureClass": one of [${Object.values(FAILURE_CLASSES).join(', ')}],
  "rootCause": "一句话根因",
  "remedy": "一句话处置原理",
  "actions": [{"type": "restart_flow_with_params|retry_export_with_params|reopen_login_window|escalate_human|mark_experience_failed", "params": {"reason": "..." 或 "overrides": {"参数名": 值}}}]
}
约束：actions 只能来自白名单；overrides 只允许标量值；不确定时给 escalate_human。
`;

export async function llmTriage(incident, context = {}, {
  fetchImpl = globalThis.fetch,
  endpoint = process.env.SUPERVISOR_AGENT_LLM_URL ?? '',
  apiKey = process.env.SUPERVISOR_AGENT_LLM_KEY ?? '',
  model = process.env.SUPERVISOR_AGENT_LLM_MODEL ?? '',
} = {}) {
  if (!endpoint || !apiKey) return null;

  const signature = incidentSignature(incident, FAILURE_CLASSES.UNKNOWN);
  const payload = {
    incident: {
      status: incident?.status ?? null,
      error: String(incident?.error ?? '').slice(0, 800),
      stage: incident?.stage ?? null,
      flow: incident?.flow ?? null,
      params: incident?.params ?? null,
    },
    eventsTail: (incident?.events ?? []).slice(-12),
    relatedExperience: context.relatedExperience ?? [],
  };

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: WHITELIST_SCHEMA_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content
      ?? body?.content?.[0]?.text
      ?? (typeof body?.content === 'string' ? body.content : null);
    if (!content) return null;
    const decision = JSON.parse(content);
    if (!Object.values(FAILURE_CLASSES).includes(decision.failureClass)) return null;
    if (!Array.isArray(decision.actions)) decision.actions = [];
    // 白名单校验：任何一个动作非法，整体拒绝（fail-closed，不部分采纳）
    if (!decision.actions.every(isActionSafe)) return null;
    if (typeof decision.rootCause !== 'string' || typeof decision.remedy !== 'string') return null;
    return { ...decision, source: 'llm', signature };
  } catch {
    return null; // 网络/解析/超时任何异常 → 升级人工
  }
}
