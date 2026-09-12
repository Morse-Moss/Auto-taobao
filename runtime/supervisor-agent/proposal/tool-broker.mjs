// 只读 Tool Broker（S2，设计文档 5.3）。
// Agent 能看到的证据只有这里暴露的只读工具，且全部受限：
// 作用域锁定当前 run/attempt、调用次数上限、响应大小上限、敏感字段脱敏。
// 危险工具（写库、点页面、读凭据、选账号、执行 shell）在此层不存在，而非"提示模型别用"。

const FORBIDDEN_BY_DESIGN = [
  'browser.click', 'browser.evaluate', 'browser.close',
  'readCredentials', 'readCookie', 'readBrowserStorage',
  'feishu.write', 'postgres.write', 'filesystem.delete',
  'chooseAccount', 'chooseStore', 'chooseTarget',
  'runShell', 'executeArbitraryScript', 'modifySelector',
  'approveOwnProposal', 'advanceCursor', 'markDone',
];

const SENSITIVE_KEY_PATTERN = /(cookie|token|authorization|password|secret|credential)/iu;

function maskSensitive(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[masked]' : maskSensitive(item, depth + 1);
    }
    return out;
  }
  return value;
}

function capSize(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

/**
 * @param sources { runSummary, events, diagnostics, experience }  Controller 预取的只读数据
 * @param context  { runId, attemptId }
 * @param limits   { maxCalls, maxResponseChars }
 */
export function createToolBroker(sources, context, limits = {}) {
  const maxCalls = limits.maxCalls ?? 10;
  const maxResponseChars = limits.maxResponseChars ?? 20000;
  let calls = 0;

  function guard(name, argsRunId) {
    // 作用域检查先于预算扣减：越权访问不消耗调用预算
    if (argsRunId !== undefined && argsRunId !== context.runId) {
      throw new Error(`SCOPE_VIOLATION: ${name} 只允许访问当前 run`);
    }
    if (calls >= maxCalls) throw new Error(`TOOL_BUDGET_EXHAUSTED: ${name}`);
    calls += 1;
  }

  function respond(value) {
    return JSON.parse(capSize(JSON.stringify(maskSensitive(value)), maxResponseChars));
  }

  return {
    // 供审计：Agent 可用的工具名列表（危险工具根本不在其中）
    listTools() {
      return {
        tools: ['getRunSummary', 'getRecentEvents', 'getDiagnosticSummary', 'getHistoricalExperience'],
        forbidden: FORBIDDEN_BY_DESIGN,
        remainingCalls: Math.max(0, maxCalls - calls),
      };
    },

    getRunSummary(args = {}) {
      guard('getRunSummary', args.runId);
      return respond(sources.runSummary ?? null);
    },

    getRecentEvents(args = {}) {
      guard('getRecentEvents', args.runId);
      const limit = Math.min(Number(args.limit ?? 20), 50); // 硬上限 50
      return respond((sources.events ?? []).slice(-limit));
    },

    getDiagnosticSummary(args = {}) {
      guard('getDiagnosticSummary', args.attemptId);
      if (args.attemptId !== undefined && args.attemptId !== context.attemptId) {
        throw new Error('SCOPE_VIOLATION: getDiagnosticSummary 只允许访问当前 attempt');
      }
      return respond(sources.diagnostics ?? null);
    },

    getHistoricalExperience(args = {}) {
      guard('getHistoricalExperience', args.runId);
      return respond(sources.experience ?? null);
    },

    _stats() {
      return { calls };
    },
  };
}

export { FORBIDDEN_BY_DESIGN };
