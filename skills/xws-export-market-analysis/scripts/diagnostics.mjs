function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function safeText(value, max = 300) {
  return String(value || "").replace(/[\r\n]+/gu, " ").slice(0, max);
}

function safeKeys(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === "string").slice(0, 40).map((item) => safeText(item, 80));
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : undefined;
}

export function normalizeDiagnosticSnapshot(raw = {}) {
  const requests = Array.isArray(raw.requests) ? raw.requests : [];
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return {
    capturedAt: safeText(raw.capturedAt, 40),
    visibility: safeText(raw.visibility, 20),
    readyState: safeText(raw.readyState, 20),
    requests: requests.slice(-100).map((item) => ({
      ...(item.apiKey ? { apiKey: safeText(item.apiKey, 100) } : {}),
      ...(Number.isInteger(item.page) && item.page > 0 ? { page: item.page } : {}),
      ...(item.flag ? { flag: safeText(item.flag, 120) } : {}),
      url: safeUrl(item.url),
      method: safeText(item.method, 12),
      status: Number.isFinite(item.status) ? item.status : null,
      elapsedMs: Number.isFinite(item.elapsedMs) ? item.elapsedMs : null,
      ...(safeKeys(item.resultKeys) ? { resultKeys: safeKeys(item.resultKeys) } : {}),
      ...(safeCount(item.itemCount) !== undefined ? { itemCount: safeCount(item.itemCount) } : {}),
      ...(item.pending === true ? { pending: true } : {}),
      ...(item.error ? { error: safeText(item.error) } : {}),
    })),
    messages: messages.slice(-100).map((item) => ({
      type: safeText(item.type, 100),
      ...(safeKeys(item.resultKeys) ? { resultKeys: safeKeys(item.resultKeys) } : {}),
      ...(safeCount(item.itemCount) !== undefined ? { itemCount: safeCount(item.itemCount) } : {}),
      ...(item.error ? { error: safeText(item.error) } : {}),
    })),
  };
}

export function classifyDiagnosticState(raw = {}) {
  const snapshot = normalizeDiagnosticSnapshot(raw);
  if (snapshot.requests.some((item) => item.status === 403 || item.status === 429)) {
    return "RATE_LIMIT_OR_SECURITY";
  }
  if (snapshot.requests.some((item) => item.pending === true)) return "REQUEST_PENDING";
  if (snapshot.requests.some((item) => item.error)) return "REQUEST_ERROR";
  if (snapshot.visibility === "hidden") return "BACKGROUND_TAB";
  if (
    snapshot.requests.some((item) => Number.isInteger(item.status) && item.status >= 200 && item.status < 300)
    || snapshot.messages.some((item) => /_FINISH$/u.test(item.type) && !item.error)
  ) return "REQUEST_COMPLETED";
  return "NO_REQUEST_SIGNAL";
}
