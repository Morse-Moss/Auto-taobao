export const REQUIRED_HEADERS = [
  "序号",
  "商品图片",
  "商品标题",
  "商品链接",
  "价格",
  "月收货人数",
  "类目",
  "同款数",
  "平台",
  "占位类型",
  "店铺名",
  "店铺旺旺",
  "店铺类型",
  "地址",
  "收藏人数",
  "卖点",
];

const COUNT_HEADERS = new Set(["月收货人数", "付款人数"]);

export function assertProxyBrowserHealth(health, expectedBrowserId = "edge") {
  if (health?.status !== "ok" || health?.connected !== true) {
    throw new Error(`Proxy is not connected to ${expectedBrowserId}`);
  }
  const actual = String(health.browser?.id || "").trim();
  if (actual !== expectedBrowserId) {
    throw new Error(`Proxy browser mismatch: expected ${expectedBrowserId}, received ${actual || "<missing>"}`);
  }
  return true;
}

function supportedHeaders(headers) {
  return Array.isArray(headers) && headers.length === REQUIRED_HEADERS.length
    && COUNT_HEADERS.has(String(headers[5] || "").trim())
    && headers.every((value, index) => index === 5
      || String(value || "").trim() === REQUIRED_HEADERS[index]);
}

const RISK_RULES = [
  ["CAPTCHA", /验证码|滑块验证|滑动验证/u],
  ["QR_OR_SMS", /二维码|扫码登录|短信验证/u],
  ["LOGIN_REQUIRED", /请登录|登录后|登录\/验证/u],
  ["SECURITY", /安全验证|账号异常|风控|访问受限|操作频繁/u],
  ["PERMISSION", /无权限|权限不足/u],
];

const VALUE_OPTIONS = new Set([
  "keyword",
  "channel",
  "sort",
  "pages",
  "price",
  "frequency",
  "export",
  "output-dir",
  "proxy",
  "poll-seconds",
  "stall-seconds",
]);

function integerRange(value, name, minimum) {
  const match = String(value || "").match(/^([0-9]+)-([0-9]+)$/u);
  if (!match) throw new Error(`${name} range must use MIN-MAX`);
  const range = { min: Number(match[1]), max: Number(match[2]) };
  if (range.min < minimum || range.max < range.min) throw new Error(`invalid ${name} range`);
  return range;
}

export function parseOptions(argv, env = process.env) {
  const options = {
    proxy: env.XWS_PROXY || "http://127.0.0.1:3456",
    keyword: "",
    channel: "all",
    sort: "sales",
    pages: { start: 1, end: 40 },
    price: { min: 0, max: null },
    frequency: { min: 10, max: 15 },
    exportModes: ["csv", "xlsx-images"],
    outputDir: "",
    pollMs: 8_000,
    stallMs: 120_000,
    fromTaobaoHome: true,
    allowTrial: false,
    exportPartialOnStall: false,
    adoptLiveResult: false,
    prepareOnly: false,
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-trial") options.allowTrial = true;
    else if (token === "--export-partial-on-stall") options.exportPartialOnStall = true;
    else if (token === "--adopt-live-result") options.adoptLiveResult = true;
    else if (token === "--prepare-only") options.prepareOnly = true;
    else if (token === "--from-taobao-home") options.fromTaobaoHome = true;
    else if (token === "--self-test") options.selfTest = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option: --${key}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      index += 1;
      if (key === "keyword") options.keyword = value.trim();
      else if (key === "channel") options.channel = value;
      else if (key === "sort") options.sort = value;
      else if (key === "pages") {
        const range = integerRange(value, "pages", 1);
        options.pages = { start: range.min, end: range.max };
      } else if (key === "frequency") options.frequency = integerRange(value, "frequency", 10);
      else if (key === "price") {
        const match = value.match(/^([0-9]+(?:\.[0-9]+)?)-(unlimited|[0-9]+(?:\.[0-9]+)?)$/u);
        if (!match) throw new Error("price range must use MIN-MAX or MIN-unlimited");
        options.price = { min: Number(match[1]), max: match[2] === "unlimited" ? null : Number(match[2]) };
        if (options.price.max !== null && options.price.max < options.price.min) throw new Error("invalid price range");
      } else if (key === "export") options.exportModes = value.split(",").map((item) => item.trim()).filter(Boolean);
      else if (key === "output-dir") options.outputDir = value;
      else if (key === "proxy") options.proxy = value.replace(/\/$/u, "");
      else if (key === "poll-seconds") options.pollMs = Number(value) * 1000;
      else if (key === "stall-seconds") options.stallMs = Number(value) * 1000;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }

  if (!options.help && !options.selfTest && !options.keyword) throw new Error("--keyword is required");
  if (!new Set(["all", "taobao", "tmall"]).has(options.channel)) throw new Error("channel must be all, taobao, or tmall");
  if (!new Set(["relevance", "sales", "credit", "price-low", "price-high"]).has(options.sort)) {
    throw new Error("unsupported sort mode");
  }
  if (options.pages.end > 100) throw new Error("page range cannot exceed 100");
  if (options.frequency.max > 300) throw new Error("frequency range cannot exceed 300 seconds");
  const exportModes = new Set(["csv", "xlsx", "xlsx-images"]);
  if (!options.exportModes.length || options.exportModes.some((mode) => !exportModes.has(mode))) {
    throw new Error("export must contain csv, xlsx, or xlsx-images");
  }
  if (options.exportModes.some((mode) => mode === "xlsx" || mode === "xlsx-images") && !options.exportModes.includes("csv")) {
    throw new Error("CSV is required when exporting XLSX so cross-format fields can be validated");
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs < 2_000) throw new Error("poll-seconds must be at least 2");
  if (!Number.isFinite(options.stallMs) || options.stallMs < 60_000) throw new Error("stall-seconds must be at least 60");
  return options;
}

export function detectRiskMarkers(text) {
  const source = String(text || "");
  return RISK_RULES.filter(([, pattern]) => pattern.test(source)).map(([code]) => code);
}

function pageRange(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(text || "").match(new RegExp(`${escaped}\\s*([0-9]+)(?:\\s*~\\s*([0-9]+))?\\s*页`, "u"));
  if (!match) return { start: 0, end: 0 };
  return { start: Number(match[1]), end: Number(match[2] || match[1]) };
}

export function parseProgressText(text) {
  const source = String(text || "");
  const pageRange = (value, label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = value.match(new RegExp(`${escaped}\\s*([0-9]+)(?:\\s*~\\s*([0-9]+))?\\s*页`, "u"));
    return { start: Number(match?.[1]) || 0, end: Number(match?.[2] || match?.[1]) || 0 };
  };
  const title = source.match(/【\s*([^】]+?)\s*】\s*([^\n]*?排序)Top[0-9]+\s*-\s*[0-9]{4}-[0-9]{2}-[0-9]{2}/u);
  const requested = pageRange(source, "您搜索的页数：第");
  const completed = pageRange(source, "已成功获取：第");
  const count = source.match(/商品数量：\s*([0-9,]+)/u);
  const waiting = source.match(/([0-9]+)\s*秒后获取：?\s*第\s*([0-9]+)\s*页/u);
  const active = source.match(/正在获取\s*[：:]?\s*第\s*([0-9]+)\s*页/u);
  return {
    keyword: title?.[1]?.trim() || "",
    sortLabel: title?.[2]?.trim() || "",
    requestedStart: requested.start,
    requestedEnd: requested.end,
    completedStart: completed.start,
    completedEnd: completed.end,
    rowCount: count ? Number(count[1].replace(/,/gu, "")) : 0,
    ...(waiting ? { waitSeconds: Number(waiting[1]), nextPage: Number(waiting[2]) } : {}),
    ...(active ? { activePage: Number(active[1]) } : {}),
    complete: requested.end > 0 && completed.end >= requested.end,
  };
}

export function selectExportResultDialog(dialogEntries, expectedProgress) {
  const expected = expectedProgress || {};
  const matches = (Array.isArray(dialogEntries) ? dialogEntries : [])
    .map((entry, index) => ({
      index,
      text: typeof entry === "string" ? entry : entry?.text,
      attemptMarker: typeof entry === "string" ? "" : entry?.attemptMarker,
    }))
    .map((entry) => ({ ...entry, progress: parseProgressText(entry.text) }))
    .filter(({ progress, attemptMarker }) => (
      !expected.attemptMarker || attemptMarker === expected.attemptMarker
    )
      && progress.keyword === String(expected.keyword || "").trim()
      && progress.requestedStart === Number(expected.requestedStart)
      && progress.requestedEnd === Number(expected.requestedEnd)
      && progress.completedStart === Number(expected.completedStart)
      && progress.completedEnd === Number(expected.completedEnd)
      && progress.rowCount === Number(expected.rowCount));
  if (matches.length !== 1) {
    throw new Error(`Expected one matching result dialog; received ${matches.length}`);
  }
  return matches[0].index;
}

export function selectObservedCollectionResult(dialogEntries, expectedProgress = {}) {
  const expected = expectedProgress || {};
  const matches = (Array.isArray(dialogEntries) ? dialogEntries : [])
    .map((entry, index) => ({
      index,
      text: typeof entry === "string" ? entry : entry?.text,
      attemptMarker: typeof entry === "string" ? "" : entry?.attemptMarker || "",
    }))
    .map((entry) => ({ ...entry, progress: parseProgressText(entry.text) }))
    .filter(({ progress }) => (
      progress.keyword === String(expected.keyword || "").trim()
      && (!expected.sortLabel || progress.sortLabel === String(expected.sortLabel).trim())
      && progress.requestedStart === Number(expected.requestedStart)
      && progress.requestedEnd === Number(expected.requestedEnd)
      && progress.completedStart >= Number(expected.requestedStart)
      && progress.completedEnd <= Number(expected.requestedEnd)
      && progress.rowCount > 0
    ));
  if (matches.length > 1) throw new Error("ambiguous observed collection results");
  return matches[0] || null;
}

export function resolveOwnedExportProgress(snapshot = {}, expectedProgress = {}) {
  if (snapshot.observedAmbiguous === true || snapshot.trackerOwned !== true || snapshot.owned !== true) {
    const error = new Error("owned result is unavailable");
    error.code = "OWNED_RESULT_UNAVAILABLE";
    throw error;
  }
  const expected = expectedProgress || {};
  const progress = snapshot.observedProgress || snapshot.progress || parseProgressText(snapshot.text || "");
  if (progress.keyword !== String(expected.keyword || "").trim()
    || (expected.sortLabel && progress.sortLabel !== String(expected.sortLabel).trim())
    || progress.requestedStart !== Number(expected.requestedStart)
    || progress.requestedEnd !== Number(expected.requestedEnd)
    || progress.completedStart < Number(expected.requestedStart)
    || progress.completedEnd > Number(expected.requestedEnd)
    || progress.rowCount < 1) {
    throw new Error("owned result progress does not match requested contract");
  }
  return progress;
}

export function collectionResultSnapshot(text) {
  const source = String(text || "");
  const range = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = source.match(new RegExp(`${escaped}\\s*([0-9]+)(?:\\s*~\\s*([0-9]+))?\\s*页`, "u"));
    return {
      start: Number(match?.[1]) || 0,
      end: Number(match?.[2] || match?.[1]) || 0,
    };
  };
  const requested = range("您搜索的页数：第");
  const completed = range("已成功获取：第");
  const count = source.match(/商品数量：\s*([0-9,]+)/u);
  return {
    requestedStart: requested.start,
    requestedEnd: requested.end,
    completedStart: completed.start,
    completedEnd: completed.end,
    rowCount: count ? Number(count[1].replace(/,/gu, "")) : 0,
  };
}

export function selectPendingRequest(requests) {
  return (Array.isArray(requests) ? requests : []).find((request) => request?.pending);
}

export function isSuccessfulCollectionResponse(result) {
  if (!result || typeof result !== "object" || result.error) return false;
  const code = result.retCode ?? result.ret;
  if (code !== undefined && code !== null && code !== "") {
    if (Array.isArray(code)) {
      return code.length > 0 && code.every((entry) => /^SUCCESS::/u.test(String(entry)));
    }
    return Number.isFinite(Number(code)) && Number(code) === 0;
  }
  if (result.status !== undefined && result.status !== null && result.status !== "") {
    const status = Number(result.status);
    return Number.isFinite(status) && status >= 200 && status < 300;
  }
  return false;
}

export function createCollectionAttemptTracker(
  range,
  {
    now = () => Date.now(),
    clickWindowMs = 60_000,
    resultWindowMs = 60_000,
  } = {},
) {
  const expectedStart = Number(range?.start);
  const expectedEnd = Number(range?.end);
  const attempts = new Map();
  const snapshot = (progress = {}) => ({
    requestedStart: Number(progress.requestedStart) || 0,
    requestedEnd: Number(progress.requestedEnd) || 0,
    completedEnd: Number(progress.completedEnd) || 0,
    rowCount: Number(progress.rowCount) || 0,
  });
  const sameSnapshot = (left, right) => (
    left.requestedStart === right.requestedStart
    && left.requestedEnd === right.requestedEnd
    && left.completedEnd === right.completedEnd
    && left.rowCount === right.rowCount
  );
  const current = (marker) => attempts.get(marker);
  const markActivity = (attempt, kind) => {
    if (!attempt || !["request", "response", "result"].includes(kind)) return false;
    attempt.lastActivityAt = now();
    attempt[`${kind}Count`] += 1;
    return true;
  };
  const withinClickWindow = (attempt) => (
    Number.isFinite(attempt?.clickStartedAt)
    && now() - attempt.clickStartedAt <= clickWindowMs
  );

  return {
    arm(marker, baseline, resultBaselines = [], resultNodes = []) {
      const existing = current(marker);
      if (existing?.clickGeneration > 0) return;
      attempts.set(marker, {
        baselines: [snapshot(baseline), ...(Array.isArray(resultBaselines) ? resultBaselines.map(snapshot) : [])],
        baselineNodes: Array.isArray(resultNodes) ? resultNodes : [],
        clickGeneration: 0,
        clickStartedAt: null,
        requestGeneration: 0,
        requestFailed: false,
        responseGeneration: 0,
        resultGeneration: 0,
        pendingResultGeneration: 0,
        activityResultGeneration: 0,
        lastActivityAt: null,
        requestCount: 0,
        responseCount: 0,
        resultCount: 0,
        activityRequests: new Map(),
        lastProgress: null,
      });
    },
    retryClick(marker) {
      const attempt = current(marker);
      if (!attempt || attempt.clickGeneration === 0) return;
      attempt.clickStartedAt = now();
      attempt.clickEndedAt = null;
    },
    beginClick(marker) {
      const attempt = current(marker);
      if (!attempt) return;
      attempt.clickGeneration += 1;
      attempt.clickStartedAt = now();
      attempt.requestGeneration = 0;
      attempt.requestFailed = false;
      attempt.responseGeneration = 0;
      attempt.resultGeneration = 0;
      attempt.pendingResultGeneration = 0;
      attempt.activityResultGeneration = 0;
    },
    endClick(marker) {
      const attempt = current(marker);
      if (attempt) attempt.clickEndedAt = now();
    },
    recordRequest(marker, request = {}) {
      const attempt = current(marker);
      const page = Number(request.page);
      const flag = String(request.flag || "");
      const hasPage = Number.isInteger(page) && page > 0;
      const isPageRequest = request.apiKey === "request"
        && /^XWS_PAGE_REQUEST_[0-9]+$/u.test(flag);
      const matchesCollectionRequest = isPageRequest
        && (!hasPage || page === expectedStart);
      if (!attempt || !isPageRequest || !flag) return false;
      if (attempt.clickGeneration > 0
        && attempt.requestGeneration === attempt.clickGeneration
        && (!hasPage || page >= expectedStart)) {
        request.attemptGeneration = attempt.clickGeneration;
        attempt.activityRequests.set(flag, request);
        markActivity(attempt, "request");
        return true;
      }
      if (!withinClickWindow(attempt)
        || !matchesCollectionRequest
        || attempt.requestGeneration !== 0) return false;
      attempt.requestGeneration = attempt.clickGeneration;
      attempt.requestStartedAt = now();
      attempt.request = request;
      attempt.activityRequests.set(flag, request);
      request.attemptGeneration = attempt.clickGeneration;
      markActivity(attempt, "request");
      return true;
    },
    recordResponse(marker, response = {}) {
      const attempt = current(marker);
      if (!attempt) return false;
      const flag = String(response.flag || "");
      const isInitialRequest = attempt.requestGeneration === attempt.clickGeneration
        && flag === String(attempt.request?.flag || "");
      const activityRequest = attempt.activityRequests.get(flag);
      if (!isInitialRequest && !activityRequest) return false;
      const successful = isSuccessfulCollectionResponse(response);
      if (!successful) {
        if (isInitialRequest) attempt.requestFailed = true;
        return false;
      }
      markActivity(attempt, "response");
      if (!isInitialRequest) return true;
      attempt.responseGeneration = attempt.clickGeneration;
      attempt.responseObservedAt = now();
      if (attempt.pendingResultGeneration === attempt.clickGeneration
        && attempt.pendingResultAt - attempt.requestStartedAt <= resultWindowMs
        && attempt.responseObservedAt - attempt.requestStartedAt <= resultWindowMs) {
        attempt.resultGeneration = attempt.clickGeneration;
      }
      return true;
    },
    recordActivity(marker, kind) {
      return markActivity(current(marker), kind);
    },
    activity(marker) {
      const attempt = current(marker);
      if (!attempt) return null;
      return {
        lastActivityAt: attempt.lastActivityAt,
        requestCount: attempt.requestCount,
        responseCount: attempt.responseCount,
        resultCount: attempt.resultCount,
      };
    },
    recordPageRequestActivity(marker, request = {}) {
      const attempt = current(marker);
      const page = Number(request.page);
      const flag = String(request.flag || "");
      if (!attempt || request.apiKey !== "request"
        || !/^XWS_PAGE_REQUEST_[0-9]+$/u.test(flag)
        || !Number.isInteger(page) || page < expectedStart
        || page > expectedEnd
        || attempt.requestGeneration !== attempt.clickGeneration) return false;
      request.attemptGeneration = attempt.clickGeneration;
      attempt.activityRequests.set(flag, request);
      return markActivity(attempt, "request");
    },
    recordResponseActivity(marker, response = {}) {
      const attempt = current(marker);
      const flag = String(response.flag || "");
      if (!attempt || !attempt.activityRequests.has(flag)) return false;
      if (!isSuccessfulCollectionResponse(response)) return false;
      return markActivity(attempt, "response");
    },
    recordProgressActivity(marker, progress = {}) {
      const attempt = current(marker);
      const next = snapshot(progress);
      if (!attempt || next.requestedStart !== expectedStart
        || next.requestedEnd !== expectedEnd
        || (attempt.lastProgress && sameSnapshot(attempt.lastProgress, next))) return false;
      attempt.lastProgress = next;
      attempt.resultCount += 1;
      attempt.lastActivityAt = now();
      return true;
    },
    recordResult(marker, progress, nodeId = "") {
      const attempt = current(marker);
      if (!attempt) return false;
      if (nodeId && attempt.baselineNodes.includes(nodeId)) return false;
      const result = snapshot(progress);
      if (result.requestedStart !== expectedStart
        || result.requestedEnd !== expectedEnd
        || attempt.baselines.some((baseline) => sameSnapshot(result, baseline))) return false;
      const observedAt = now();
      if (attempt.requestGeneration === attempt.clickGeneration
        && attempt.responseGeneration === attempt.clickGeneration
        && attempt.clickGeneration > 0) {
        if (observedAt - attempt.requestStartedAt > resultWindowMs) return false;
        attempt.resultGeneration = attempt.clickGeneration;
        markActivity(attempt, "result");
        return true;
      }
      if (attempt.requestGeneration === attempt.clickGeneration
        && observedAt - attempt.requestStartedAt > resultWindowMs) return false;
      if (!withinClickWindow(attempt)
        && attempt.requestGeneration !== attempt.clickGeneration) return false;
      attempt.pendingResultGeneration = attempt.clickGeneration;
      attempt.pendingResultAt = observedAt;
      markActivity(attempt, "result");
      return true;
    },
    isClickObserved(marker) {
      const attempt = current(marker);
      return Boolean(attempt?.clickGeneration > 0);
    },
    isFailed(marker) {
      return current(marker)?.requestFailed === true;
    },
    isStarted(marker) {
      const attempt = current(marker);
      return Boolean(
        attempt?.clickGeneration > 0
        && attempt.requestGeneration === attempt.clickGeneration
        && !attempt.requestFailed
      );
    },
    isOwned(marker) {
      const attempt = current(marker);
      return Boolean(
        attempt?.clickGeneration > 0
        && attempt.requestGeneration === attempt.clickGeneration
        && attempt.responseGeneration === attempt.clickGeneration
        && attempt.resultGeneration === attempt.clickGeneration,
      );
    },
  };
}

export function collectionActivitySignature(progress = {}, diagnostics = {}) {
  const requests = Array.isArray(diagnostics.requests) ? diagnostics.requests : [];
  const messages = Array.isArray(diagnostics.messages) ? diagnostics.messages : [];
  const latestRequest = requests.at(-1) || {};
  const latestMessage = messages.at(-1) || {};
  return JSON.stringify({
    completedEnd: Number(progress.completedEnd) || 0,
    rowCount: Number(progress.rowCount) || 0,
    complete: progress.complete === true,
    nextPage: Number.isInteger(progress.nextPage) ? progress.nextPage : null,
    activePage: Number.isInteger(progress.activePage) ? progress.activePage : null,
    requestCount: requests.length,
    requestPage: Number.isInteger(latestRequest.page) ? latestRequest.page : null,
    requestPending: latestRequest.pending === true,
    requestStatus: Number.isInteger(latestRequest.status) ? latestRequest.status : null,
    messageCount: messages.length,
    messageType: String(latestMessage.type || ""),
  });
}

export function collectionStallReason({
  idleMs,
  elapsedMs,
  stallMs,
  deadlineMs,
  diagnosticKind,
}) {
  if (elapsedMs >= deadlineMs) return "deadline";
  if (diagnosticKind === "REQUEST_PENDING") return "";
  if (idleMs >= stallMs) return "idle";
  return "";
}

export function classifyCollection(snapshot) {
  const text = String(snapshot?.text || "");
  if (detectRiskMarkers(text).length) return "HUMAN_REQUIRED";
  const progress = parseProgressText(text);
  if (progress.complete) return "COMPLETE";
  if (progress.completedEnd > 0) return "COLLECTING";
  return "STARTING";
}

export function selectTaobaoSearchTarget(targets, keyword) {
  const expected = String(keyword || "");
  const matches = (Array.isArray(targets) ? targets : []).filter((target) => {
    if (target?.type !== "page" || !target.targetId) return false;
    try {
      const url = new URL(target.url);
      return url.origin === "https://s.taobao.com"
        && url.pathname === "/search"
        && url.searchParams.get("q") === expected;
    } catch {
      return false;
    }
  });
  if (!matches.length) throw new Error(`No Taobao search target for keyword: ${expected}`);
  return matches.at(-1);
}

export function validateDataset(headers, rows) {
  if (!supportedHeaders(headers)) {
    throw new Error("Xiaowangshen headers do not match the 16-column contract");
  }
  if (!Array.isArray(rows) || rows.length < 1) throw new Error("Xiaowangshen dataset is empty");

  const links = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row) || row.length !== REQUIRED_HEADERS.length) {
      throw new Error(`row ${index + 1} does not contain 16 columns`);
    }
    const rank = Number(row[0]);
    if (!Number.isInteger(rank) || rank !== index + 1) {
      throw new Error(`ranks are not contiguous at row ${index + 1}`);
    }
    const link = String(row[3] || "").trim();
    if (!link) throw new Error(`empty product link at row ${index + 1}`);
    links.push(link);
  }

  const unique = new Set(links);
  if (unique.size !== links.length) throw new Error("duplicate product links detected");
  return {
    rowCount: rows.length,
    rankRange: `1-${rows.length}`,
    emptyLinks: 0,
    duplicateLinks: 0,
  };
}

export function collectionDeadlineMs({ pageCount, frequencyMaxSeconds }) {
  const pages = Number(pageCount);
  const frequency = Number(frequencyMaxSeconds);
  if (!Number.isInteger(pages) || pages < 1) throw new Error("pageCount must be positive");
  if (!Number.isFinite(frequency) || frequency < 1) throw new Error("frequencyMaxSeconds must be positive");
  return pages * ((frequency * 1000) + 15_000) + 500_000;
}
