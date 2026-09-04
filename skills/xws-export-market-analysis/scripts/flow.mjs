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
    prepareOnly: false,
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-trial") options.allowTrial = true;
    else if (token === "--export-partial-on-stall") options.exportPartialOnStall = true;
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

export function collectionActivitySignature(progress = {}, diagnostics = {}) {
  const requests = Array.isArray(diagnostics.requests) ? diagnostics.requests : [];
  const messages = Array.isArray(diagnostics.messages) ? diagnostics.messages : [];
  const latestRequest = requests.at(-1) || {};
  const latestMessage = messages.at(-1) || {};
  return JSON.stringify({
    completedEnd: Number(progress.completedEnd) || 0,
    rowCount: Number(progress.rowCount) || 0,
    complete: progress.complete === true,
    waitSeconds: Number.isInteger(progress.waitSeconds) ? progress.waitSeconds : null,
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
  activePage = null,
}) {
  if (elapsedMs >= deadlineMs) return "deadline";
  if (Number.isInteger(activePage)) return "";
  if (["REQUEST_PENDING", "BACKGROUND_TAB"].includes(diagnosticKind)) return "";
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
