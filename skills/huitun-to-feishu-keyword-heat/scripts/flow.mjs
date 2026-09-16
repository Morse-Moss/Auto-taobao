import crypto from 'node:crypto';

import { activeProfileName, envFilePath, keywordBaseToken } from '../../../runtime/feishu-targets.mjs';
import { BROWSER_IDS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';

export const A_THRESHOLD = 10_000_000;
export const DEFAULT_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const HUITUN_RESULT_SCHEMA_VERSION = 1;
export const HUITUN_RESULT_SOURCE = Object.freeze({
  platform: '灰豚数据红薯版',
  page: '话题搜索',
  url: 'https://xhs.huitun.com/#/anchor/anchor_topic',
  match_rule: '去除话题首尾#后与搜索词完全一致；不累加相近话题',
});

// 期望的浏览器身份默认取登记表（乙 / edge-daily-report），不再写死 "edge"。
export function assertProxyBrowserHealth(health, expectedBrowserId = BROWSER_IDS.dailyReport) {
  if (health?.status !== 'ok' || health?.connected !== true) {
    throw new Error(`Proxy is not connected to ${expectedBrowserId}`);
  }
  const actual = plain(health.browser?.id);
  if (actual !== expectedBrowserId) {
    throw new Error(`Proxy browser mismatch: expected ${expectedBrowserId}, received ${actual || '<missing>'}`);
  }
  return true;
}

export function hasConfirmedAccount(value) {
  return /(?:^|\s)(?:ID|DY)[：:\s]*\d+/iu.test(plain(value));
}

// 关键词库 base 与凭据文件同样按 SYCM_FEISHU_PROFILE 走单点配置，不在这里写死：
// 2026-09-14 整批搬到新租户后，关键词库是**另一张独立 base**（复制竞品 base 不会带上它），
// 它的副本 token 单独在 feishu-targets.mjs 里维护。
const PROFILE = activeProfileName();

export const DEFAULT_TARGET = Object.freeze({
  appToken: keywordBaseToken(PROFILE),
  tableId: '',
  tableName: '',
  envFile: envFilePath(PROFILE),
});

// 内容热度由上游内容平台/AI流程提供；灰豚只负责补充原始浏览量证据。
export const WRITABLE_FIELDS = new Set(['灰豚话题浏览量']);
const EXPECTED_FORMULA_FIELDS = new Set(['优先级']);
const VALUE_OPTIONS = new Set([
  'app-token',
  'table-id',
  'table-name',
  'env-file',
  'proxy',
  'browser-id',
  'output-dir',
  'results',
  'confirm-table',
  'poll-seconds',
  'query-timeout-seconds',
  'max-candidates',
  'result-max-age-hours',
]);

export function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '').trim();
  return String(value).trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function numericOption(value, name, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return number;
}

export function parseOptions(argv, env = process.env) {
  const options = {
    ...DEFAULT_TARGET,
    // 灰豚是第三方平台，但这条链的浏览器归属已定为**乙（商家浏览器）**：
    // 关键词这条路线两半（生意参谋搜索排行 + 灰豚）都在乙上，跑关键词只开一个浏览器。
    // 端口来自 runtime/browser-ports.mjs；原先默认写的是**别的项目**的共享代理，
    // 能不能跑取决于别人的代理是否活着（2026-09-16 用户拍板迁走）。
    proxy: env.HUITUN_PROXY || `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
    browserId: env.HUITUN_BROWSER_ID || BROWSER_IDS.dailyReport,
    outputDir: '',
    resultsPath: '',
    pollMs: 1_000,
    queryTimeoutMs: 30_000,
    maxCandidates: 50,
    resultMaxAgeMs: DEFAULT_RESULT_MAX_AGE_MS,
    apply: false,
    confirmTable: '',
    selfTest: false,
    help: false,
    candidateMode: 'A_ONLY',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') options.apply = true;
    else if (token === '--fallback-b') options.candidateMode = 'B_FALLBACK';
    else if (token === '--self-test') options.selfTest = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      const key = token.slice(2, separator > 0 ? separator : undefined);
      if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option: --${key}`);
      let value = separator > 0 ? token.slice(separator + 1) : argv[index + 1];
      if (separator < 0) index += 1;
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`missing value for --${key}`);
      value = value.trim();
      if (key === 'app-token') options.appToken = value;
      else if (key === 'table-id') options.tableId = value;
      else if (key === 'table-name') options.tableName = value;
      else if (key === 'env-file') options.envFile = value;
      else if (key === 'proxy') options.proxy = value.replace(/\/$/u, '');
      else if (key === 'browser-id') options.browserId = value;
      else if (key === 'output-dir') options.outputDir = value;
      else if (key === 'results') options.resultsPath = value;
      else if (key === 'confirm-table') options.confirmTable = value;
      else if (key === 'poll-seconds') options.pollMs = numericOption(value, 'poll-seconds', 0.5) * 1_000;
      else if (key === 'query-timeout-seconds') options.queryTimeoutMs = numericOption(value, 'query-timeout-seconds', 5) * 1_000;
      else if (key === 'max-candidates') options.maxCandidates = numericOption(value, 'max-candidates', 1);
      else if (key === 'result-max-age-hours') options.resultMaxAgeMs = numericOption(value, 'result-max-age-hours', 0.1) * 60 * 60 * 1_000;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }

  if (!options.help && !options.selfTest && (!options.appToken || !options.tableId || !options.tableName || !options.envFile)) {
    throw new Error('app-token, table-id, table-name, and env-file are required');
  }
  if (!Number.isInteger(options.maxCandidates)) throw new Error('max-candidates must be an integer');
  if (options.apply && options.confirmTable !== options.tableId) {
    throw new Error(`--apply requires --confirm-table ${options.tableId}`);
  }
  return options;
}

export function parseDisplayedViews(value) {
  const source = plain(value).replaceAll(',', '').replace(/\s+/gu, '');
  const match = source.match(/^(\d+(?:\.\d+)?)(亿|万|w|W)?$/u);
  if (!match) throw new Error(`Unsupported Huitun view value: ${plain(value) || '<empty>'}`);
  const multiplier = match[2] === '亿' ? 100_000_000 : ['万', 'w', 'W'].includes(match[2]) ? 10_000 : 1;
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid Huitun view value: ${value}`);
  return result;
}

export function normalizeTopic(value) {
  return plain(value).replace(/^#+|#+$/gu, '').trim();
}

// Kept only for compatibility with old evidence tooling; never used for a Feishu write.
export function contentHeatForViews(views) {
  if (!Number.isSafeInteger(views) || views < 0) throw new Error(`Invalid numeric views: ${views}`);
  return views >= A_THRESHOLD ? '高' : '低';
}

export function classifyTopicSnapshot({ keyword, rows, emptyText }) {
  const search = plain(keyword);
  if (!search) throw new Error('Huitun keyword is empty');
  const exact = (Array.isArray(rows) ? rows : []).filter((row) => normalizeTopic(row?.[0]) === search);
  if (exact.length > 1) throw new Error(`More than one exact Huitun topic matched ${search}`);
  if (exact.length === 1) {
    const topic = plain(exact[0][0]);
    const viewsRaw = plain(exact[0][1]);
    return { keyword: search, status: 'FOUND_EXACT', topic, viewsRaw, views: parseDisplayedViews(viewsRaw) };
  }
  const evidence = plain(emptyText) || '灰豚返回相近话题，无完全同名话题';
  return { keyword: search, status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: evidence, views: 0 };
}

const HARD_RISK_RULES = [
  ['CAPTCHA', /验证码|滑块验证/u],
  ['SECURITY', /安全验证|账号异常|风控|访问受限|操作频繁/u],
  ['PERMISSION', /无权限|权限不足/u],
  ['LOGIN_CHALLENGE', /扫码登录|微信登录|短信验证/u],
  ['LOGIN_REQUIRED', /请登录/u],
];

export function detectHumanRequired({ visibleTexts = [] } = {}, { allowLogin = false } = {}) {
  const texts = (Array.isArray(visibleTexts) ? visibleTexts : [visibleTexts]).map(plain).filter(Boolean);
  const source = texts.join('\n');
  for (const [code, pattern] of HARD_RISK_RULES) {
    if (pattern.test(source)) return { code, text: source.slice(0, 500) };
  }
  if (!allowLogin && texts.some((text) => text === '登录/注册')) {
    return { code: 'LOGIN_REQUIRED', text: source.slice(0, 500) };
  }
  return null;
}

function isHuitunPage(target) {
  if (target?.type !== 'page' || !target.targetId) return false;
  try {
    return ['https://dy.huitun.com', 'https://xhs.huitun.com'].includes(new URL(target.url).origin);
  } catch {
    return false;
  }
}

export function selectRunTarget(targets, runLabel) {
  const matches = (Array.isArray(targets) ? targets : [])
    .filter((target) => isHuitunPage(target) && target.automationLabel === runLabel);
  if (matches.length !== 1) throw new Error(`Expected one labeled Huitun target for ${runLabel}; received ${matches.length}`);
  return matches[0];
}

export function selectCandidates(records, { mode = 'A_ONLY' } = {}) {
  const source = Array.isArray(records) ? records : [];
  if (mode === 'B_FALLBACK') {
    const aQueue = source.filter((record) => plain(record.fields?.优先级) === 'A候选');
    if (aQueue.length > 0) throw new Error(`A-candidate queue exists; B fallback is not allowed (${aQueue.length} row(s))`);
    const candidates = source.filter((record) => (
      candidateKeyword(record)
      && plain(record.fields?.搜索热度) === '高'
      && ['中', '高'].includes(plain(record.fields?.交易热度))
    ));
    const seen = new Set();
    for (const record of candidates) {
      const keyword = candidateKeyword(record);
      if (seen.has(keyword)) throw new Error(`Duplicate B-fallback keyword: ${keyword}`);
      seen.add(keyword);
    }
    return candidates;
  }
  if (mode !== 'A_ONLY') throw new Error(`Unsupported Huitun candidate mode: ${mode}`);
  const pending = source.filter((record) => (
    candidateKeyword(record) && ['', '待数据'].includes(plain(record.fields?.优先级))
  ));
  if (pending.length > 0) {
    const pendingValues = pending.map((record) => plain(record.fields?.优先级));
    const reasons = [
      ...(pendingValues.includes('待数据') ? ['优先级=待数据'] : []),
      ...(pendingValues.includes('') ? ['优先级 is blank'] : []),
    ];
    const error = new Error(`${pending.length} populated row(s) are not ready for Huitun (${reasons.join(', ')}); finish Feishu AI analysis before Huitun collection`);
    error.code = 'AI_REQUIRED';
    error.details = {
      pendingCount: pending.length,
      sampleKeywords: pending.slice(0, 5).map(candidateKeyword),
    };
    throw error;
  }

  const candidates = source.filter((record) => (
    plain(record.fields?.优先级) === 'A候选'
  ));
  const seen = new Set();
  for (const record of candidates) {
    const keyword = candidateKeyword(record);
    if (!keyword) throw new Error(`Empty A-candidate keyword for record ${plain(record.record_id) || '<missing>'}`);
    if (seen.has(keyword)) throw new Error(`Duplicate A-candidate keyword: ${keyword}`);
    seen.add(keyword);
  }
  return candidates;
}

export function candidateKeyword(record) {
  return plain(record?.fields?.搜索词);
}

export function buildQueueBinding({ appToken, tableId, tableName, records, candidateMode = 'A_ONLY' }) {
  const target = {
    appToken: plain(appToken),
    tableId: plain(tableId),
    tableName: plain(tableName),
  };
  if (!target.appToken || !target.tableId || !target.tableName) {
    throw new Error('Huitun queue binding requires app token, table ID, and table name');
  }
  const queue = selectCandidates(records, { mode: candidateMode }).map((record) => {
    const recordId = plain(record.record_id);
    if (!recordId) throw new Error(`A-candidate ${candidateKeyword(record)} has no record ID`);
    return { recordId, keyword: candidateKeyword(record) };
  }).sort((left, right) => left.recordId.localeCompare(right.recordId) || left.keyword.localeCompare(right.keyword, 'zh-CN'));
  const queueFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize({ ...target, queue })))
    .digest('hex');
  return { tableId: target.tableId, tableName: target.tableName, queueFingerprint };
}

export function validateResultDocument({ document, binding, maxAgeMs = DEFAULT_RESULT_MAX_AGE_MS, nowMs = Date.now() }) {
  if (document?.schemaVersion !== HUITUN_RESULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Huitun result schema: ${document?.schemaVersion ?? '<missing>'}`);
  }
  for (const [name, expected] of Object.entries(HUITUN_RESULT_SOURCE)) {
    if (document.source?.[name] !== expected) {
      throw new Error(`Invalid Huitun result source ${name}: ${plain(document.source?.[name]) || '<missing>'}`);
    }
  }
  if (!canonicalEqual(document.target, binding)) throw new Error('Huitun result binding does not match the live queue');
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(nowMs)) {
    throw new Error('Invalid Huitun result freshness policy');
  }
  const collectedAt = Date.parse(document.source?.collected_at);
  if (!Number.isFinite(collectedAt)) throw new Error('Huitun result source collected_at is missing or invalid');
  if (collectedAt > nowMs + 5 * 60 * 1_000) throw new Error('Huitun result collected_at is in the future');
  if (nowMs - collectedAt > maxAgeMs) throw new Error('Huitun result is stale or expired');
  return normalizeResults(document);
}

export function normalizeResults(document) {
  if (!document || !Array.isArray(document.items)) throw new Error('Huitun result document must contain an items array');
  const seen = new Set();
  return document.items.map((item) => {
    const keyword = plain(item.keyword);
    if (!keyword || seen.has(keyword)) throw new Error(`Invalid or duplicate Huitun keyword: ${keyword || '<empty>'}`);
    seen.add(keyword);
    if (item.status === 'FOUND_EXACT') {
      const topic = plain(item.topic);
      if (normalizeTopic(topic) !== keyword) throw new Error(`Huitun topic is not an exact match for ${keyword}: ${topic}`);
      const views = parseDisplayedViews(item.viewsRaw);
      if (item.views !== views) throw new Error(`Numeric views do not match displayed views for ${keyword}`);
      return { keyword, status: item.status, topic, viewsRaw: plain(item.viewsRaw), views };
    }
    if (item.status === 'NO_EXACT_TOPIC') {
      if (item.topic != null || item.views !== 0) throw new Error(`No-result item must use null topic and zero views: ${keyword}`);
      return { keyword, status: item.status, topic: null, viewsRaw: plain(item.viewsRaw), views: 0 };
    }
    throw new Error(`Unsupported Huitun result status for ${keyword}: ${item.status}`);
  });
}

function uniqueRecord(records, keyword) {
  const matches = records.filter((record) => candidateKeyword(record) === keyword);
  if (matches.length !== 1) throw new Error(`Expected exactly one Feishu record for ${keyword}; received ${matches.length}`);
  return matches[0];
}

function isMissingPriorityInput(value) {
  return ['', '待核验'].includes(plain(value));
}

function expectedPriorityAfterViews(record, views) {
  const fields = record.fields ?? {};
  const category = plain(fields.关键词分类);
  if (category === '品牌词') return 'C-常规跟踪';
  if (isMissingPriorityInput(category)
      || (category === '痛点词' && isMissingPriorityInput(fields.细分标签))
      || isMissingPriorityInput(fields.搜索热度)
      || isMissingPriorityInput(fields.交易热度)) {
    return '待数据';
  }
  const searchReady = ['中', '高'].includes(plain(fields.搜索热度));
  const tradeReady = ['中', '高'].includes(plain(fields.交易热度));
  const contentReady = ['中', '高'].includes(plain(fields.内容热度));
  if (views >= A_THRESHOLD && searchReady && contentReady && plain(fields.交易热度) === '高') {
    return 'A-立即跟进';
  }
  if (searchReady && tradeReady) return 'B-持续观察';
  return 'C-常规跟踪';
}

export function buildUpdatePlan({ records, resultDocument, resultContext, candidateMode = 'A_ONLY' }) {
  if (!resultContext) throw new Error('Huitun result provenance context is required');
  const results = validateResultDocument({ document: resultDocument, ...resultContext });
  const candidateNames = selectCandidates(records, { mode: candidateMode }).map((record) => plain(record.fields?.搜索词)).sort();
  const resultNames = results.map((item) => item.keyword).sort();
  if (!canonicalEqual(candidateNames, resultNames)) {
    throw new Error(`Live A-candidate queue differs from Huitun results: queue=${JSON.stringify(candidateNames)} results=${JSON.stringify(resultNames)}`);
  }

  const updates = [];
  const expected = [];
  for (const result of results) {
    const record = uniqueRecord(records, result.keyword);
    const desired = { 灰豚话题浏览量: result.views };
    const fields = {};
    for (const [name, value] of Object.entries(desired)) {
      const existing = record.fields?.[name];
      const blank = existing == null || plain(existing) === '';
      if (!blank && plain(existing) !== String(value)) {
        throw new Error(`Refusing to overwrite ${name} for ${result.keyword}: ${plain(existing)}`);
      }
      if (blank) fields[name] = value;
    }
    if (Object.keys(fields).length > 0) updates.push({ record_id: record.record_id, fields });
    expected.push({
      recordId: record.record_id,
      keyword: result.keyword,
      status: result.status,
      topic: result.topic,
      viewsRaw: result.viewsRaw,
      contentHeat: plain(record.fields?.内容热度),
      desired,
      expectedPriority: expectedPriorityAfterViews(record, result.views),
    });
  }
  return { updates, expected };
}

export function assertAuthorizedMutation({ appToken, tableId, method, apiPath, body, plan }) {
  const expectedPath = `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`;
  const valid = method === 'POST' && apiPath === expectedPath
    && Array.isArray(body?.records) && body.records.length > 0
    && body.records.every((record) => record.record_id && Object.keys(record.fields ?? {}).length > 0
      && Object.keys(record.fields).every((name) => WRITABLE_FIELDS.has(name)))
    && canonicalEqual(body.records, plan.updates);
  if (!valid) throw new Error('Blocked unauthorized Huitun mutation');
}

function canonicalRecord(record, ignoredFields = new Set()) {
  return {
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name]) => !ignoredFields.has(name))
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
  };
}

export function verifyBackfill({ before, after, plan }) {
  if (before.length !== after.length) throw new Error('Huitun backfill changed the record count');
  const expectedById = new Map(plan.expected.map((item) => [item.recordId, item]));
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Huitun backfill removed record ${prior.record_id}`);
    const expected = expectedById.get(prior.record_id);
    if (!expected) {
      if (!canonicalEqual(prior, next)) throw new Error(`Huitun backfill changed unrelated record ${prior.record_id}`);
      continue;
    }
    const ignored = new Set([...WRITABLE_FIELDS, ...EXPECTED_FORMULA_FIELDS]);
    if (!canonicalEqual(canonicalRecord(prior, ignored), canonicalRecord(next, ignored))) {
      throw new Error(`Huitun backfill changed unauthorized fields for ${expected.keyword}`);
    }
    for (const [name, value] of Object.entries(expected.desired)) {
      if (plain(next.fields?.[name]) !== String(value)) throw new Error(`${name} verification failed for ${expected.keyword}`);
    }
    if (plain(next.fields?.优先级) !== expected.expectedPriority) {
      throw new Error(`Priority verification failed for ${expected.keyword}: ${plain(next.fields?.优先级)}`);
    }
  }
  return {
    recordsWritten: plan.updates.length,
    verified: plan.expected.map((item) => ({
      keyword: item.keyword,
      contentHeat: item.contentHeat,
      views: item.desired.灰豚话题浏览量,
      priority: item.expectedPriority,
    })),
  };
}

export function resultSnapshotSignature(snapshot) {
  return JSON.stringify(canonicalize({
    rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
    emptyText: plain(snapshot?.emptyText),
  }));
}

export function advanceQuerySettlement({ keyword, preSignature, preLoading = false, state = {}, snapshot }) {
  const search = plain(keyword);
  const query = plain(snapshot?.query);
  if (query !== search) throw new Error(`Huitun query changed unexpectedly: expected ${search}, received ${query}`);
  const signature = resultSnapshotSignature(snapshot);
  const loading = Number(snapshot?.loading) > 0;
  const hasResult = (Array.isArray(snapshot?.rows) && snapshot.rows.length > 0) || Boolean(plain(snapshot?.emptyText));
  const previousLoading = state.previousLoading ?? Boolean(preLoading);
  const loadingTransition = loading && !previousLoading;
  const transitionSeen = Boolean(state.transitionSeen) || loadingTransition || signature !== preSignature;
  let previousSignature = state.previousSignature || '';
  let stableCount = Number(state.stableCount) || 0;
  if (!transitionSeen || loading || !hasResult) {
    previousSignature = '';
    stableCount = 0;
  } else {
    stableCount = signature === previousSignature ? stableCount + 1 : 1;
    previousSignature = signature;
  }
  const nextState = { transitionSeen, previousLoading: loading, previousSignature, stableCount };
  const result = stableCount >= 2
    ? classifyTopicSnapshot({ keyword: search, rows: snapshot.rows, emptyText: snapshot.emptyText })
    : null;
  return { state: nextState, result };
}
