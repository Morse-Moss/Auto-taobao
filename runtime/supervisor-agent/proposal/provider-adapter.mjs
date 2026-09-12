// 模型 Provider Adapter（S2，设计文档 8.2-2）。
// 协议被独立适配器隔离：上层只见 { text, model, modelVersion } 元数据。
// 任何失败（未配置/网络/超时/非 2xx）抛 AdapterUnavailable，由会话层 fail-closed 降级，
// 绝不让半截输出进入 proposal。

export class AdapterUnavailable extends Error {}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param prompt { system, user }
 * @param options { endpoint, apiKey, model, modelVersion, timeoutMs, fetchImpl }
 * @returns { text, model, modelVersion, endpointName }
 */
export async function callModel(prompt, options = {}) {
  const endpoint = options.endpoint ?? process.env.SUPERVISOR_AGENT_LLM_URL ?? '';
  const apiKey = options.apiKey ?? process.env.SUPERVISOR_AGENT_LLM_KEY ?? '';
  const model = options.model ?? process.env.SUPERVISOR_AGENT_LLM_MODEL ?? '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!endpoint || !apiKey || !model) {
    throw new AdapterUnavailable('provider 未配置（SUPERVISOR_AGENT_LLM_URL/KEY/MODEL）');
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdapterUnavailable(`provider 请求失败: ${error.message}`);
  }

  if (!response.ok) {
    throw new AdapterUnavailable(`provider 返回 ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new AdapterUnavailable(`provider 响应不是 JSON: ${error.message}`);
  }

  const text = body?.choices?.[0]?.message?.content
    ?? body?.content?.[0]?.text
    ?? (typeof body?.content === 'string' ? body.content : null);
  if (typeof text !== 'string' || !text) {
    throw new AdapterUnavailable('provider 响应缺少文本内容');
  }

  return {
    text,
    model,
    modelVersion: options.modelVersion ?? body?.model ?? null,
    endpointName: new URL(endpoint).host,
  };
}
