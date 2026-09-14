// huitun.keyword-heat.collect 的运行时实现入口（实施计划「迁移顺序第 6 项：灰豚周度」）。
//
// 这条链原来的样子：`run-huitun-topic-heat.mjs` 一个 CLI 从头做到尾——
//   读飞书 A 候选队列 → 浏览器采集灰豚话题浏览量 → dry-run 计划 → --apply 回填 → 回读校验。
// 它本身写得相当严谨（来源身份、队列指纹、字段类型、只写一个字段、公式结算等待、整表比对），
// 但它有两个结构性弱点：
//   1. 授权是命令行开关（`--apply --confirm-table <id>`），不是可审计状态：事后没有任何权威记录
//      能回答「这次回填是谁在什么时候批准的」；
//   2. 它是一条长事务：浏览器采集、写飞书、等公式结算全在同一个进程里。进程一崩，唯一的进度
//      载体是磁盘上的 runDir，没有任何东西能告诉运行时「这条 run 现在是哪一段」。
//
// 本文件把它拆成确定性运行时的两段式：
//   COLLECT（无外部写入）：读 results.json + 飞书只读（表名/字段类型/记录）→ 复验来源与队列绑定
//                        → 产出「已结算的写入计划」工件
//   PUBLISH（外部写入）  ：只读工件字节 → 队列指纹复验 → 对账式 batch_update → 回读（含公式结算）
// 浏览器采集仍由该 Skill 的既有 CLI 完成，本文件不发起任何浏览器动作——与迁移 3（FAQ）、
// 迁移 5（SKU）同构，因此同样不需要为它改通用两段式运行器。
//
// 关键设计取舍（记录在此以便对抗性审查）：
//  1. **工件携带的是「计划」，不是「结果文档」**。结果文档在 COLLECT 时用来算出计划，之后只留下
//     `resultsSha256` + 文件路径：第三方可以拿那份文件重新走一遍 validateResultDocument，而发布段
//     不需要它的新鲜度策略。若把新鲜度判定搬进发布段，一条「采集时合法、提交时刚好过期」的工作
//     会被误杀，而发布段真正要守的是「这批行还在不在、字段还是不是空白」。
//  2. **发布段不重算解析，而是重读目标表**。这正是它与运维 CLI 的差别所在：CLI 在写之前重跑一次
//     完整 dry-run；运行时路径离线不可用，改为「读实况 → 队列指纹必须不变 → 只写仍然为空的字段」。
//     结果比 CLI 更强的一点：队列变了就直接拒绝（CLI 靠 validateResultDocument 的绑定检查达到同样
//     效果，但运行时路径把它显式写成 QUEUE_CHANGED 这个可审计的结论）。指纹检查只在「还有待写的
//     行」时生效——回填成功会让公式结算、行离开 A 候选队列，指纹变化是收敛而不是漂移。
//  3. **回读只守「本批涉及的行 × 与优先级判定相关的字段」**，不复制整表快照。CLI 的 verifyBackfill
//     做的是整表逐记录比对（含「无关记录必须原样」）；把整表搬进工件会把证据体积放大到与能力无关
//     的规模。这里改为：工件为每行记录 6 个守卫字段在采集时的值，读写两侧都比对它们（写前拦
//     GUARD_FIELD_CHANGED，写后由回读收据负责证明结果）。
//  4. **未收敛的回读收据不带 verifiedAt**。发布期验证器只认 `rows/digest/verifiedAt` 三项，
//     因此「没等到公式结算就不给 verifiedAt」使「未收敛被判为 UNKNOWN」这件事不依赖调用方是否
//     传了 expectedRows——否则调用方漏传一个参数就会让一次没验证成功的发布被判成 VERIFIED。
//
// 边界：本文件不 import runtime/ 下任何模块。同 Skill 内 import `./flow.mjs` 是被允许的
// （它是本能力自己的纯逻辑模块）；跨 Skill 的相对导入只允许已登记能力的实现——
// Feishu 客户端来自 `adapter.feishu`（skills/xws-to-feishu-base/scripts/feishu-client.mjs），
// 并且走可注入的懒加载，测试里替换成假实现，不需要网络与凭据。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertAuthorizedMutation,
  buildQueueBinding,
  buildUpdatePlan,
  DEFAULT_RESULT_MAX_AGE_MS,
  HUITUN_RESULT_SOURCE,
  plain,
  selectCandidates,
  validateResultDocument,
} from './flow.mjs';

export const capabilityId = 'huitun.keyword-heat.collect';
export const manifestVersion = '1.1.0';
export const EVIDENCE_SCHEMA_VERSION = 'huitun-keyword-heat-evidence-v1';

// 唯一允许写入的字段（与 SKILL.md 的固定契约一致：内容热度由上游 AI 流程给，灰豚只补浏览量）。
export const WRITABLE_FIELD = '灰豚话题浏览量';
export const PRIORITY_FIELD = '优先级';

// 回读要守的字段：搜索词（身份）+ 决定 优先级 公式结果的四个输入。
// 优先级 本身是公式字段，不能写、只能等它结算，因此单列。
export const GUARD_FIELDS = Object.freeze(['搜索词', '关键词分类', '细分标签', '搜索热度', '交易热度', '内容热度']);

// 表结构前置条件：字段名 → 期望的飞书字段类型（null = 不限）。
// 灰豚话题浏览量 必须是数字字段（写进去的是整数），优先级 必须是公式字段（20），
// 否则「写成功但公式没重算」会被误判成回读失败。
export const REQUIRED_FIELDS = Object.freeze({
  搜索词: null,
  内容热度: 1,
  [WRITABLE_FIELD]: 2,
  [PRIORITY_FIELD]: 20,
});

// 工件表面必须存在的键（collectContract().requiredFields 引用同一份清单，避免两处漂移）。
export const ARTIFACT_SURFACE_FIELDS = Object.freeze([
  'schemaVersion',
  'sourceIdentity',
  'resultsSha256',
  'tableId',
  'tableName',
  'queueFingerprint',
  'keywordCount',
  'planUpdates',
  'queueDigest',
  'viewsDigest',
  'expectedDigest',
]);

// 确定性拒绝码 → 失败分类。默认的 failureClassOf 只按英文关键词猜，
// 而这条链的原因文案大多是中文（「拒绝覆盖」「队列已变化」），必须逐条显式映射。
export const FAILURE_CLASS_BY_CODE = Object.freeze({
  RESULTS_MISSING: 'EVIDENCE_INVALID',
  // 探测专属：调用方没给全探测输入（与采集段的 TARGET_REQUIRED 同类：都是「这次调用没准备好」）。
  // 它永远到不了运行时的失败分类——探测的异常由调度器收成「结论未知、照常发起」。
  PROBE_INPUT_MISSING: 'POLICY_DENIED',
  RESULTS_INCOMPLETE: 'EVIDENCE_INVALID',
  RESULTS_HASH_MISMATCH: 'EVIDENCE_INVALID',
  RESULT_STALE: 'EVIDENCE_INVALID',
  RESULT_INVALID: 'EVIDENCE_INVALID',
  SOURCE_MISMATCH: 'EVIDENCE_INVALID',
  QUEUE_CHANGED: 'EVIDENCE_INVALID',
  QUEUE_INVALID: 'EVIDENCE_INVALID',
  GUARD_FIELD_CHANGED: 'EVIDENCE_INVALID',
  ITEM_INVALID: 'EVIDENCE_INVALID',
  NO_CANDIDATES: 'POLICY_DENIED',
  QUEUE_TOO_LARGE: 'POLICY_DENIED',
  TABLE_MISMATCH: 'POLICY_DENIED',
  FIELD_MISSING: 'POLICY_DENIED',
  FIELD_TYPE_MISMATCH: 'POLICY_DENIED',
  TARGET_REQUIRED: 'POLICY_DENIED',
  TARGET_MISMATCH: 'POLICY_DENIED',
  OVERWRITE_REFUSED: 'POLICY_DENIED',
  UNSUPPORTED_MODE: 'POLICY_DENIED',
  FEISHU_WRITE_REJECTED: 'POLICY_DENIED',
  CREDENTIALS_UNAVAILABLE: 'HUMAN_REQUIRED',
  AI_REQUIRED: 'HUMAN_REQUIRED',
});

export class HuitunEvidenceError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'HuitunEvidenceError';
    this.code = code;
    this.failureClass = FAILURE_CLASS_BY_CODE[code] ?? 'EVIDENCE_INVALID';
    this.details = details;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 稳定序列化：键排序，保证同一份证据每次得到同一摘要（否则摘要校验会随机失败）。
export function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());

// 飞书字段值可能是纯文本、富文本数组或对象；比较前先归一化成文本。
export function plainText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(plainText).join('').trim();
  if (typeof value === 'object') return asText(value.text ?? value.value ?? value.name);
  return asText(value);
}

export function sourceIdentityOf(source = HUITUN_RESULT_SOURCE) {
  return [
    asText(source.platform),
    asText(source.page),
    asText(source.url),
    asText(source.match_rule),
  ].join('|');
}

// ── flow.mjs 的错误 → 确定性失败分类 ────────────────────────────────────────
// flow.mjs 抛的是带中文提示的普通 Error；若不在这里显式翻译，默认分类器会把
// 「队列已变化」「拒绝覆盖」这类**策略结论**猜成 BUG（落态 FAILED/TERMINAL），
// 从而把一次本可以修正后重跑的运行升级成停线。
const FLOW_ERROR_RULES = Object.freeze([
  [/Huitun result is stale or expired/u, 'RESULT_STALE'],
  [/Huitun result binding does not match the live queue/u, 'QUEUE_CHANGED'],
  [/exceeds --max-candidates/u, 'QUEUE_TOO_LARGE'],
  [/Refusing to overwrite/u, 'OVERWRITE_REFUSED'],
  [/Unsupported Huitun candidate mode/u, 'UNSUPPORTED_MODE'],
  [/^(?:Duplicate|Empty) (?:A-candidate|B-fallback) keyword/u, 'QUEUE_INVALID'],
  [/Expected exactly one Feishu record/u, 'QUEUE_INVALID'],
  [/A-candidate .* has no record ID/u, 'QUEUE_INVALID'],
  [/A-candidate queue exists; B fallback is not allowed/u, 'QUEUE_INVALID'],
  [/Unsupported Huitun result schema/u, 'RESULT_INVALID'],
  [/Invalid Huitun result source/u, 'SOURCE_MISMATCH'],
  [/Invalid or duplicate Huitun keyword/u, 'RESULT_INVALID'],
  [/Huitun topic is not an exact match/u, 'RESULT_INVALID'],
  [/Unsupported Huitun view value|Invalid Huitun view value/u, 'RESULT_INVALID'],
  [/Numeric views do not match displayed views/u, 'RESULT_INVALID'],
  [/No-result item must use null topic/u, 'RESULT_INVALID'],
  [/Unsupported Huitun result status/u, 'RESULT_INVALID'],
  [/Live A-candidate queue differs from Huitun results/u, 'QUEUE_CHANGED'],
  [/Huitun result provenance context is required/u, 'EVIDENCE_INCOMPLETE'],
  [/Invalid Huitun result freshness policy/u, 'EVIDENCE_INCOMPLETE'],
]);

export function translateFlowError(error) {
  if (error instanceof HuitunEvidenceError) return error;
  // AI_REQUIRED 是「上游 AI 分析还没跑完」，不是流程缺陷：它必须落成等人工，而不是停线。
  if (error?.code === 'AI_REQUIRED') {
    const wrapped = new HuitunEvidenceError(
      'the A-candidate queue still has rows awaiting Feishu AI analysis',
      'AI_REQUIRED',
      { pendingCount: error.details?.pendingCount ?? null, sampleKeywords: error.details?.sampleKeywords ?? [] },
    );
    return wrapped;
  }
  const message = String(error?.message ?? error);
  for (const [pattern, code] of FLOW_ERROR_RULES) {
    if (pattern.test(message)) return new HuitunEvidenceError(message, code, { causeCode: error?.code ?? null });
  }
  // 未命中规则的异常**原样抛出**：它可能是真 bug，不能用一个看起来合理的分类把它藏起来。
  return error;
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    throw translateFlowError(error);
  }
}

// ── 依赖注入 ────────────────────────────────────────────────────────────────
// 默认实现懒加载已登记的 adapter.feishu；测试用 setDependenciesForTest 替换，
// 不需要网络、凭据或真实 Base。
let deps = {
  createClient: null,   // ({appId, appSecret, appToken, tableId}) => client
  readEnvFile: null,    // (path) => text
};

export function setDependenciesForTest(overrides = {}) {
  deps = { ...deps, ...overrides };
}

export function resetDependenciesForTest() {
  deps = { createClient: null, readEnvFile: null };
}

async function defaultCreateClient({ appId, appSecret, appToken, tableId }) {
  const module = await import('../../xws-to-feishu-base/scripts/feishu-client.mjs');
  return new module.FeishuClient({ appId, appSecret, appToken, tableId });
}

export { defaultCreateClient };

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

// credentials 只从显式给出的 env 文件读取，绝不落进工件：
// 工件里只有「读到过凭据」这个事实，没有凭据值本身。
async function readCredentials(envFile) {
  const absolute = resolve(envFile);
  if (!existsSync(absolute)) {
    throw new HuitunEvidenceError('Feishu environment file is unavailable', 'CREDENTIALS_UNAVAILABLE', { envFile: absolute });
  }
  const text = deps.readEnvFile ? await deps.readEnvFile(absolute) : await readFile(absolute, 'utf8');
  const env = parseEnvText(text);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new HuitunEvidenceError('Feishu app credentials are unavailable', 'CREDENTIALS_UNAVAILABLE', { envFile: absolute });
  }
  return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET };
}

// ── 目标与前置条件 ──────────────────────────────────────────────────────────
export function requestTarget(raw) {
  const appToken = asText(raw?.appToken);
  const tableId = asText(raw?.tableId);
  const tableName = asText(raw?.tableName);
  if (!appToken || !tableId || !tableName) {
    throw new HuitunEvidenceError('target must name appToken, tableId and tableName', 'TARGET_REQUIRED', { target: raw ?? null });
  }
  return { appToken, tableId, tableName };
}

function requireField(fields, name, expectedType) {
  const matches = (fields ?? []).filter((field) => asText(field?.fieldName) === name);
  if (matches.length !== 1) {
    throw new HuitunEvidenceError(`expected exactly one field named ${name}`, 'FIELD_MISSING', {
      field: name, found: matches.length,
    });
  }
  const type = matches[0].type;
  if (expectedType !== null && Number(type) !== Number(expectedType)) {
    throw new HuitunEvidenceError(`${name} has field type ${type}, expected ${expectedType}`, 'FIELD_TYPE_MISMATCH', {
      field: name, expected: expectedType, actual: type,
    });
  }
  return matches[0];
}

export function assertTableShape({ tables = [], fields = [], tableId, tableName }) {
  const table = tables.find((item) => asText(item?.tableId) === asText(tableId));
  if (!table) {
    throw new HuitunEvidenceError('the requested table is not present in the Base', 'TABLE_MISMATCH', { tableId });
  }
  if (asText(table.name) !== asText(tableName)) {
    throw new HuitunEvidenceError('the requested table does not carry the authorized name', 'TABLE_MISMATCH', {
      tableId, expected: tableName, actual: asText(table.name),
    });
  }
  for (const [name, type] of Object.entries(REQUIRED_FIELDS)) requireField(fields, name, type);
  return table;
}

// ── COLLECT 段：读取与独立复验 ──────────────────────────────────────────────
export const REQUIRED_INPUT_KEYS = Object.freeze(['resultsFile', 'envFile', 'appToken', 'tableId', 'tableName']);

function requireInputText(input, key) {
  const value = asText(input?.[key]);
  if (!value) throw new HuitunEvidenceError(`${key} is required`, 'RESULTS_MISSING', { key });
  return value;
}

function requireInputPath(input, key) {
  const absolute = resolve(requireInputText(input, key));
  if (!existsSync(absolute)) {
    throw new HuitunEvidenceError(`${key} is unavailable: ${absolute}`, 'RESULTS_MISSING', { key, path: absolute });
  }
  return absolute;
}

function guardValues(record) {
  const fields = record?.fields ?? {};
  return Object.fromEntries(GUARD_FIELDS.map((name) => [name, plainText(fields[name])]));
}

function assertGuardsUnchanged(expectedGuard, record) {
  const changed = [];
  for (const name of GUARD_FIELDS) {
    if (plainText(record?.fields?.[name]) !== plainText(expectedGuard?.[name])) {
      changed.push({ field: name, before: plainText(expectedGuard?.[name]), now: plainText(record?.fields?.[name]) });
    }
  }
  return changed;
}

// 读一个批次的证据并把「已结算的写入计划」复验成工件数据。
// 任何一条不满足都抛出带确定性 code 的 HuitunEvidenceError——这些 code 就是
// 「这批关键词为什么没通过」的可审计结论，而不是一句泛化失败。
export async function readHuitunBatch(input = {}, { createClient = null } = {}) {
  for (const key of REQUIRED_INPUT_KEYS) requireInputText(input, key);
  const resultsPath = requireInputPath(input, 'resultsFile');
  const target = requestTarget({
    appToken: input.appToken,
    tableId: input.tableId,
    tableName: input.tableName,
  });
  // 候选模式的词表只有一处（candidateModeOf）：探测段与采集段必须对「哪些模式合法」
  // 给出同一个答案，否则会出现「探测说有活、采集段却拒绝这个模式」的假矛盾。
  const candidateMode = candidateModeOf(input);
  const maxCandidates = Number.isFinite(Number(input.maxCandidates)) && Number(input.maxCandidates) > 0
    ? Math.floor(Number(input.maxCandidates))
    : 50;
  const resultMaxAgeMs = Number.isFinite(Number(input.resultMaxAgeMs)) && Number(input.resultMaxAgeMs) > 0
    ? Number(input.resultMaxAgeMs)
    : DEFAULT_RESULT_MAX_AGE_MS;

  const resultsBytes = await readFile(resultsPath);
  const resultsSha256 = sha256Hex(resultsBytes);
  const resultDocument = await guarded(async () => {
    try {
      return JSON.parse(resultsBytes.toString('utf8'));
    } catch (error) {
      throw new HuitunEvidenceError('results file is not valid JSON', 'RESULTS_INCOMPLETE', {
        path: resultsPath, cause: String(error?.message ?? error),
      });
    }
  });

  const credentials = await readCredentials(requireInputText(input, 'envFile'));
  const create = createClient ?? deps.createClient ?? defaultCreateClient;
  const client = await create({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appToken: target.appToken,
    tableId: target.tableId,
  });

  // 只会读。COLLECT 段不写任何东西；目标表的实况是这条能力唯一的「外部事实」。
  const tables = await client.listTables();
  const fields = await client.listFields();
  assertTableShape({ tables, fields, tableId: target.tableId, tableName: target.tableName });
  const records = await client.listRecords();

  const candidates = await guarded(() => selectCandidates(records, { mode: candidateMode }));
  if (candidates.length === 0) {
    // 运营口径：A 候选队列为空 = 本周没有要补的词。但这不是一条可结算的工作：
    // 框架的游标要求 end >= 1（advanceCursor 拒绝回归），伪造 1 会把「什么都没做」
    // 写成「已推进一格」。因此这里确定性拒绝，并由驱动器负责「空队列就不要再发起本能力」。
    throw new HuitunEvidenceError('the candidate queue is empty; nothing is collectable', 'NO_CANDIDATES', {
      candidateMode, recordCount: records.length,
    });
  }
  if (candidates.length > maxCandidates) {
    throw new HuitunEvidenceError(
      `candidate queue ${candidates.length} exceeds maxCandidates ${maxCandidates}`,
      'QUEUE_TOO_LARGE',
      { candidates: candidates.length, maxCandidates },
    );
  }

  const binding = await guarded(() => buildQueueBinding({
    appToken: target.appToken,
    tableId: target.tableId,
    tableName: target.tableName,
    records,
    candidateMode,
  }));
  const results = await guarded(() => validateResultDocument({
    document: resultDocument,
    binding,
    maxAgeMs: resultMaxAgeMs,
  }));
  const plan = await guarded(() => buildUpdatePlan({
    records,
    resultDocument,
    candidateMode,
    resultContext: { binding, maxAgeMs: resultMaxAgeMs },
  }));

  const byRecordId = new Map(records.map((record) => [asText(record?.record_id), record]));
  const plannedIds = new Set(plan.expected.map((item) => asText(item.recordId)));
  const updateIds = new Set(plan.updates.map((update) => asText(update.record_id)));
  // results 的长度必须与计划行数一致：前者是「结果文档里被接受的行」，后者是「要结算的行」。
  // 两者不等说明 buildUpdatePlan 之外还有别的路径参与了这个批次，必须显式失败。
  if (results.length !== plan.expected.length) {
    throw new HuitunEvidenceError('validated results and the write plan disagree on the row set', 'QUEUE_CHANGED', {
      results: results.length, planned: plan.expected.length,
    });
  }
  const query = candidates.map((record) => ({
    recordId: asText(record.record_id),
    keyword: plain(record.fields?.搜索词),
  })).sort((left, right) => left.recordId.localeCompare(right.recordId));

  const expected = plan.expected.map((item) => {
    const recordId = asText(item.recordId);
    const record = byRecordId.get(recordId);
    if (!record) {
      throw new HuitunEvidenceError('planned record disappeared from the source snapshot', 'QUEUE_INVALID', { recordId });
    }
    const views = Number(item.desired?.[WRITABLE_FIELD]);
    if (!Number.isSafeInteger(views) || views < 0) {
      throw new HuitunEvidenceError('planned views value is not a non-negative integer', 'ITEM_INVALID', { recordId, views });
    }
    if (asText(record.fields?.搜索词) !== asText(item.keyword)) {
      throw new HuitunEvidenceError('planned record does not carry the planned keyword', 'QUEUE_INVALID', {
        recordId, expected: asText(item.keyword), actual: asText(record.fields?.搜索词),
      });
    }
    return {
      recordId,
      keyword: asText(item.keyword),
      status: asText(item.status),
      topic: item.topic === null || item.topic === undefined ? null : asText(item.topic),
      viewsRaw: asText(item.viewsRaw),
      views,
      contentHeat: asText(item.contentHeat),
      expectedPriority: asText(item.expectedPriority),
      willWrite: updateIds.has(recordId),
      guard: guardValues(record),
    };
  }).sort((left, right) => left.recordId.localeCompare(right.recordId));

  const updates = plan.updates.map((update) => ({
    record_id: asText(update.record_id),
    fields: { [WRITABLE_FIELD]: Number(update.fields?.[WRITABLE_FIELD]) },
  }));
  for (const update of updates) {
    if (!plannedIds.has(update.record_id)) {
      throw new HuitunEvidenceError('write plan contains a record outside the planned set', 'ITEM_INVALID', { update });
    }
  }
  if (updates.length !== expected.filter((item) => item.willWrite).length) {
    throw new HuitunEvidenceError('write plan and its own expectations disagree', 'ITEM_INVALID', {
      updates: updates.length, willWrite: expected.filter((item) => item.willWrite).length,
    });
  }

  const viewsDigest = sha256Hex(Buffer.from(stableJson(expected.map((item) => [item.keyword, item.status, item.views])), 'utf8'));
  const expectedDigest = sha256Hex(Buffer.from(stableJson(expected), 'utf8'));
  const queueDigest = sha256Hex(Buffer.from(stableJson(query), 'utf8'));

  return {
    resultsPath,
    resultsSha256,
    candidateMode,
    maxCandidates,
    resultMaxAgeMs,
    target,
    binding,
    tableId: target.tableId,
    tableName: target.tableName,
    fieldCount: fields.length,
    recordCount: records.length,
    keywordCount: expected.length,
    queue: query,
    queueDigest,
    viewsDigest,
    expectedDigest,
    expected,
    updates,
    planUpdates: updates.length,
    collectedAt: asText(resultDocument?.source?.collected_at),
    resultSource: resultDocument?.source ?? {},
  };
}

// ── 调度侧探测（只读、不建运行） ────────────────────────────────────────────
// 契约（由 runtime/sop-runtime/capability-scheduler.mjs 的 QUEUE_PROBE_EXPORT 固定）：
//   probeQueue({ collectInput }) → { state, code, reason, candidateCount, ... }
// 只在**确定的运营状态**上下结论，不做策略判决：
//   READY         队列里有可采的候选 → 交给真实运行；
//   EMPTY         A 候选队列为空 → 本周没有要补的词（正常运营状态，不是失败）；
//   WAITING_HUMAN 仍有内容行没结算完（优先级为空或 待数据）→ 等上游 AI，不是失败。
// 其余一切（表名/字段不符、队列过大、记录身份坏掉……）**原样抛出**：那是真实运行的判决，
// 在这里复制一份只会长出第二个策略引擎，两份判决早晚不一致。
//
// 与采集段的两处**刻意的**差别：
//  1. **不要求 resultsFile**。探测发生在浏览器采集之前，那时 results.json 还不存在；
//     把它设成前置条件等于永远探不出 READY，探测就退化成一个恒返回「未知」的装饰品。
//  2. **不读 results 文件、不写任何本地文件**。探测只读飞书，因此可以放心让调度侧高频调用。
export const PROBE_REQUIRED_INPUT_KEYS = Object.freeze(['envFile', 'appToken', 'tableId', 'tableName']);
export const QUEUE_PROBE_SCHEMA_VERSION = 'huitun-queue-probe-v1';
export const QUEUE_PROBE_STATES = Object.freeze(['READY', 'EMPTY', 'WAITING_HUMAN']);

function requireProbeInputText(input, key) {
  const value = asText(input?.[key]);
  if (!value) throw new HuitunEvidenceError(`${key} is required to probe the queue`, 'PROBE_INPUT_MISSING', { key });
  return value;
}

function candidateModeOf(input) {
  const mode = asText(input?.candidateMode) || 'A_ONLY';
  if (!['A_ONLY', 'B_FALLBACK'].includes(mode)) {
    throw new HuitunEvidenceError(`unsupported candidate mode: ${mode}`, 'UNSUPPORTED_MODE', { candidateMode: mode });
  }
  return mode;
}

export async function probeHuitunQueue(input = {}, { createClient = null } = {}) {
  for (const key of PROBE_REQUIRED_INPUT_KEYS) requireProbeInputText(input, key);
  const target = requestTarget({
    appToken: input.appToken,
    tableId: input.tableId,
    tableName: input.tableName,
  });
  const candidateMode = candidateModeOf(input);

  const credentials = await readCredentials(requireProbeInputText(input, 'envFile'));
  const create = createClient ?? deps.createClient ?? defaultCreateClient;
  const client = await create({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appToken: target.appToken,
    tableId: target.tableId,
  });

  // 只会读，且只读三样：表名、字段类型、记录。探测不建运行，因此也不留任何运行痕迹。
  const tables = await client.listTables();
  const fields = await client.listFields();
  assertTableShape({ tables, fields, tableId: target.tableId, tableName: target.tableName });
  const records = await client.listRecords();

  const shared = {
    schemaVersion: QUEUE_PROBE_SCHEMA_VERSION,
    capabilityId,
    capabilityVersion: manifestVersion,
    candidateMode,
    recordCount: records.length,
    fieldCount: fields.length,
    tableId: target.tableId,
    tableName: target.tableName,
    probedAt: new Date().toISOString(),
  };

  let candidates = null;
  try {
    candidates = await guarded(() => selectCandidates(records, { mode: candidateMode }));
  } catch (error) {
    // AI_REQUIRED 是一条确定性运营状态（上游 AI 没结算完），不是失败，因此在这里就地下结论，
    // 让调度侧能把它报成「等人工」而不是「故障」。
    if (error?.code === 'AI_REQUIRED') {
      const pendingCount = Number(error.details?.pendingCount);
      return {
        ...shared,
        state: 'WAITING_HUMAN',
        code: 'AI_REQUIRED',
        reason: `${Number.isSafeInteger(pendingCount) ? pendingCount : 'some'} populated row(s) are still awaiting Feishu AI settlement`,
        candidateCount: null,
        pendingCount: Number.isSafeInteger(pendingCount) ? pendingCount : null,
        sampleKeywords: error.details?.sampleKeywords ?? [],
      };
    }
    throw error;
  }

  const empty = candidates.length === 0;
  return {
    ...shared,
    state: empty ? 'EMPTY' : 'READY',
    code: empty ? 'NO_CANDIDATES' : 'CANDIDATES_READY',
    reason: empty
      ? `the ${candidateMode} candidate queue is empty; nothing to collect this period`
      : `${candidates.length} candidate keyword(s) are queued for collection`,
    candidateCount: candidates.length,
  };
}

// 调度侧契约的固定导出名（capability-scheduler.mjs 的 QUEUE_PROBE_EXPORT）。
// 只传 collectInput：探测的输入面与采集段相同，多一层参数包装只会多一处漂移。
export async function probeQueue({ collectInput = {} } = {}) {
  return probeHuitunQueue(collectInput);
}

// ── 适配器（Worker 7 方法契约） ─────────────────────────────────────────────
// 两段式里 COLLECT 与 PUBLISH 之间只通过工件字节传递数据，这里存的是
// 「同一次 COLLECT 内各方法要复用的解析结果」。
const stateByBatch = new Map();

export function resetStateForTest() {
  stateByBatch.clear();
  resetDependenciesForTest();
}

function batchKeyOf(input, context, started, observation) {
  return asText(input?.resultsFile)
    || asText(started?.batchKey)
    || asText(observation?.batchKey)
    || asText(context?.scope);
}

export function collectContract() {
  return {
    capabilityId,
    capabilityVersion: manifestVersion,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    // 只用 surface 字段，不用字节内部字段（同 sycm.feishu.weekly 的 D11 教训）。
    requiredFields: [...ARTIFACT_SURFACE_FIELDS],
    // 刻意**不**声明这些验证器：
    //  - digest：比较的是 evidenceStore 从同一份字节算出的摘要，恒等，属空转；
    //  - artifact_integrity：rowCount>0 的判定与 row_count 完全重叠；
    //  - scope_match / contiguous_prefix / completeness / relations：本能力不做分片，
    //    一次运行就是「一个队列的全部关键词」，没有可续接的范围语义。
    omittedValidators: {
      digest: 'compares the artifact against the manifest the store just derived from it; always equal',
      artifact_integrity: 'row_count already asserts the keyword count, and the capability re-derives every row identity',
      scope_match: 'the capability does not shard a range; one run covers the whole candidate queue',
      contiguous_prefix: 'same reason: there is no resumable range, the queue is the unit',
      completeness: 'expectedRows is supplied by the caller and checked by row_count',
      relations: 'no cross-record relation is declared by this capability',
    },
  };
}

export const adapter = {
  async checkSession() {
    // 浏览器采集由 Skill 的既有 CLI 承担；本能力只读飞书与本地 results 文件。
    return { ok: true };
  },

  async prepare(input = {}) {
    // prepare 只做「输入是否齐备」的快速失败，不读外部系统：
    // 内容级判定统一放在 start，避免同一件事出现两处结论。
    for (const key of REQUIRED_INPUT_KEYS) requireInputText(input, key);
    requireInputPath(input, 'resultsFile');
  },

  async start(input = {}, context = {}) {
    const batch = await readHuitunBatch(input);
    const key = batchKeyOf(input, context, null, null);
    stateByBatch.set(key, { batch, key, identity: context.identity ?? null });
    return {
      batchKey: key,
      tableId: batch.tableId,
      tableName: batch.tableName,
      keywordCount: batch.keywordCount,
      planUpdates: batch.planUpdates,
    };
  },

  async observe({ context, started } = {}) {
    const key = batchKeyOf(null, context, started, null);
    const entry = stateByBatch.get(key);
    if (!entry) throw new HuitunEvidenceError('no huitun batch evidence; start() must run first', 'RESULTS_MISSING', { batchKey: key });
    return {
      identity: context?.identity ?? entry.identity ?? null,
      batchKey: entry.key,
      tableId: entry.batch.tableId,
      tableName: entry.batch.tableName,
      keywordCount: entry.batch.keywordCount,
      planUpdates: entry.batch.planUpdates,
    };
  },

  async collectArtifact({ context, observation } = {}) {
    const key = batchKeyOf(null, context, null, observation);
    const entry = stateByBatch.get(key);
    if (!entry) throw new HuitunEvidenceError('no huitun batch evidence; start() must run first', 'RESULTS_MISSING', { batchKey: key });
    const { batch } = entry;
    const payload = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      sourceIdentity: sourceIdentityOf(batch.resultSource),
      resultsSha256: batch.resultsSha256,
      collectedAt: batch.collectedAt,
      candidateMode: batch.candidateMode,
      maxCandidates: batch.maxCandidates,
      resultMaxAgeMs: batch.resultMaxAgeMs,
      target: batch.target,
      binding: batch.binding,
      queueFingerprint: asText(batch.binding?.queueFingerprint),
      tableId: batch.tableId,
      tableName: batch.tableName,
      fieldCount: batch.fieldCount,
      recordCount: batch.recordCount,
      keywordCount: batch.keywordCount,
      planUpdates: batch.planUpdates,
      queueDigest: batch.queueDigest,
      viewsDigest: batch.viewsDigest,
      expectedDigest: batch.expectedDigest,
      queue: batch.queue,
      // 工件自带写入与回读所需的全部事实：发布段只读工件字节，不读进程内状态
      // （这是跨进程恢复能成立的前提）。
      plan: { updates: batch.updates, expected: batch.expected },
      files: { results: batch.resultsPath },
    };
    const bytes = Buffer.from(stableJson(payload), 'utf8');
    return {
      ...payload,
      artifactId: `huitun-keyword-heat-${batch.tableId}`,
      artifactKind: 'json',
      bytes,
      sha256: sha256Hex(bytes),
      rowCount: batch.keywordCount,
      range: { start: 1, end: batch.keywordCount },
    };
  },

  // 能力自检。走到这里 readHuitunBatch 已经通过，因此只兜两道：
  // 工件必须能被独立复验（摘要 + 字节），且表面字段必须与字节内容一致。
  async validate(artifact) {
    if (!artifact) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no artifact' } };
    if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? ''))) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing sha256 digest' } };
    }
    if (!artifact.bytes) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing bytes' } };
    const recomputed = sha256Hex(artifact.bytes);
    if (recomputed !== artifact.sha256) {
      return { ok: false, code: 'DIGEST_MISMATCH', details: { expected: artifact.sha256, actual: recomputed } };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(artifact.bytes.toString('utf8'));
    } catch (error) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: `artifact bytes are not JSON: ${String(error?.message ?? error)}` } };
    }
    // 只校验「调用方确实提供了的」表面字段。这是刻意的：第三方复核与跨进程恢复都只拿到
    // 工件字节与摘要，没有框架派生的表面字段；「没提供」不能被当成撒谎，「提供了却不一致」才是。
    const mismatched = ARTIFACT_SURFACE_FIELDS
      .filter((key) => artifact?.[key] !== undefined && artifact?.[key] !== null)
      .filter((key) => String(parsed?.[key] ?? '') !== String(artifact[key] ?? ''));
    if (mismatched.length) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact surface disagrees with its own bytes', mismatched } };
    }
    const expected = parsed?.plan?.expected;
    if (!Array.isArray(expected) || expected.length !== Number(parsed?.keywordCount)) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact expectations disagree with its own keyword count' } };
    }
    const updates = parsed?.plan?.updates;
    if (!Array.isArray(updates) || updates.length !== Number(parsed?.planUpdates)) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact write plan disagrees with its own update count' } };
    }
    // rowCount 是框架侧派生的表面字段（字节里只有 keywordCount）：只在调用方给出时才校验，
    // 这样用字节单独重建的工件也能自检通过。
    if (artifact?.rowCount !== undefined && artifact?.rowCount !== null && expected.length !== Number(artifact.rowCount)) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact expectations disagree with the declared rowCount', expected: expected.length, rowCount: artifact.rowCount } };
    }
    return { ok: true };
  },

  async release() {},
};

// ── 发布段 ──────────────────────────────────────────────────────────────────
// 写入是否「结果未知」：只有可能已经落库的失败才允许进 UNKNOWN。
// 4xx（参数/权限/字段错误）是确定性拒绝，不能靠重试蒙过去。
export function isUnknownWriteFailure(error) {
  const status = [error?.status, error?.statusCode, error?.response?.status]
    .map((value) => Number(value))
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  if (status !== undefined) return status >= 500 || status === 408 || status === 429;
  const code = asText(error?.code).toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  if (error?.name === 'AbortError') return true;
  return /\b(?:connection reset|fetch failed|network|socket hang up|timed?\s*out|timeout)\b/iu.test(String(error?.message ?? ''));
}

export function artifactPlan(artifactBytes) {
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  } catch (error) {
    throw new HuitunEvidenceError('artifact bytes are not JSON', 'RESULTS_INCOMPLETE', { cause: String(error?.message ?? error) });
  }
  const expected = Array.isArray(parsed?.plan?.expected) ? parsed.plan.expected : [];
  if (expected.length === 0) throw new HuitunEvidenceError('artifact carries no planned keyword', 'RESULTS_INCOMPLETE', {});
  const updates = Array.isArray(parsed?.plan?.updates) ? parsed.plan.updates : [];
  return { artifact: parsed, expected, updates };
}

export function buildReadbackReceipt({ expected = [], records = [], tableId = '', settled = null }) {
  const byId = new Map(records.map((record) => [asText(record?.record_id), record]));
  const missing = [];
  const viewsMismatched = [];
  const priorityPending = [];
  const guardDrift = [];
  const verified = [];
  for (const item of expected) {
    const record = byId.get(item.recordId);
    if (!record) {
      missing.push(item.recordId);
      continue;
    }
    const views = plainText(record.fields?.[WRITABLE_FIELD]);
    if (views !== String(item.views)) {
      viewsMismatched.push({ recordId: item.recordId, keyword: item.keyword, expected: item.views, actual: views });
      continue;
    }
    const priority = plainText(record.fields?.[PRIORITY_FIELD]);
    if (item.expectedPriority && priority !== item.expectedPriority) {
      priorityPending.push({ recordId: item.recordId, keyword: item.keyword, expected: item.expectedPriority, actual: priority });
      continue;
    }
    const drift = assertGuardsUnchanged(item.guard, record);
    if (drift.length) {
      guardDrift.push({ recordId: item.recordId, keyword: item.keyword, drift });
      continue;
    }
    verified.push({ recordId: item.recordId, keyword: item.keyword, views: item.views, priority });
  }
  const converged = missing.length === 0 && viewsMismatched.length === 0 && priorityPending.length === 0 && guardDrift.length === 0;
  return {
    // 未收敛的回读收据**不带 verifiedAt**：发布期验证器只认 rows/digest/verifiedAt，
    // 因此「没等到公式结算」会被判成 UNVERIFIED（UNKNOWN 待对账），
    // 而且这件事不依赖调用方是否传了 expectedRows。
    verifiedAt: converged ? (settled ?? new Date().toISOString()) : null,
    rows: verified.length,
    expectedRows: expected.length,
    digest: sha256Hex(Buffer.from(stableJson(verified.map((row) => [row.keyword, row.views, row.priority])), 'utf8')),
    tableId,
    missing,
    viewsMismatched,
    priorityPending,
    guardDrift,
    verified,
  };
}

// 发布钩子工厂。约定导出名由两段式运行器固定（PUBLISH_HOOK_FACTORY = 'createPublisher'）。
export function createPublisher({ artifactBytes, collectInput = {}, publishInput = {} } = {}) {
  if (!artifactBytes) throw new HuitunEvidenceError('artifactBytes is required for the publish stage', 'RESULTS_MISSING', {});
  const { artifact, expected, updates } = artifactPlan(artifactBytes);
  // 「没有目标」是调用方缺陷：工厂期就拒绝，连凭据都不去读。
  const expectedTarget = requestTarget(publishInput.target ?? null);
  // 「目标与已审批工件不一致」是策略拒绝，不是调用方笔误：它必须留下可审计的 REJECTED 收据，
  // 而不是在最外层抛异常、把这条 run 留在 RUNNING。因此这里只记录结论，在 handler 里抛出。
  const targetMismatch = asText(artifact?.target?.appToken) !== expectedTarget.appToken
    || asText(artifact?.target?.tableId) !== expectedTarget.tableId
    || asText(artifact?.target?.tableName) !== expectedTarget.tableName;
  const envFile = asText(publishInput.envFile) || asText(collectInput.envFile);
  const batchSize = Number.isInteger(publishInput.batchSize) && publishInput.batchSize > 0
    ? Math.min(publishInput.batchSize, 500)
    : 500;
  const settleTimeoutMs = Number.isFinite(Number(publishInput.settleTimeoutMs)) && Number(publishInput.settleTimeoutMs) > 0
    ? Number(publishInput.settleTimeoutMs)
    : 60_000;
  const pollMs = Number.isFinite(Number(publishInput.pollMs)) && Number(publishInput.pollMs) > 0
    ? Number(publishInput.pollMs)
    : 1_000;
  const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

  async function client() {
    if (!envFile) throw new HuitunEvidenceError('an env file is required to reach Feishu', 'CREDENTIALS_UNAVAILABLE', {});
    const credentials = await readCredentials(envFile);
    const create = deps.createClient ?? defaultCreateClient;
    return create({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appToken: expectedTarget.appToken,
      tableId: expectedTarget.tableId,
    });
  }

  // 读实况并复验「工件描述的那批行」在目标表里仍然成立。
  // 这一段刻意在写之前跑：它替代了运维 CLI 的「写前重算 dry-run」。
  async function reconcile(api) {
    const tables = await api.listTables();
    const fields = await api.listFields();
    assertTableShape({ tables, fields, tableId: expectedTarget.tableId, tableName: expectedTarget.tableName });
    const records = await api.listRecords();
    const liveBinding = await guarded(() => buildQueueBinding({
      appToken: expectedTarget.appToken,
      tableId: expectedTarget.tableId,
      tableName: expectedTarget.tableName,
      records,
      candidateMode: asText(artifact?.candidateMode) || 'A_ONLY',
    }));
    // 队列指纹的含义是「这批行还在不在 A 候选队列里」。它在**没有待写行**时无关紧要：
    // 一次成功的回填会让 优先级 公式结算，行随之离开 A 候选队列，指纹必然变化——那是正常收敛，
    // 不是漂移。因此指纹检查放在逐行对账之后，只在真正要写点什么时才拦；否则一次崩溃后重跑
    // 的 UNKNOWN 对账会被自己的成功结果挡在门外（这正是不允许「重试 UNKNOWN」时要能跑通的那条路）。
    const queueMatches = asText(liveBinding?.queueFingerprint) === asText(artifact?.queueFingerprint);
    const byId = new Map(records.map((record) => [asText(record?.record_id), record]));
    const stillBlank = [];
    const alreadySettled = [];
    for (const item of expected) {
      const record = byId.get(item.recordId);
      if (!record) {
        throw new HuitunEvidenceError('a planned record disappeared from the target table', 'QUEUE_CHANGED', { recordId: item.recordId });
      }
      const drift = assertGuardsUnchanged(item.guard, record);
      if (drift.length) {
        throw new HuitunEvidenceError('a guard field changed since the artifact was collected', 'GUARD_FIELD_CHANGED', {
          recordId: item.recordId, keyword: item.keyword, drift,
        });
      }
      const current = plainText(record.fields?.[WRITABLE_FIELD]);
      if (current === '') {
        stillBlank.push({ record_id: item.recordId, fields: { [WRITABLE_FIELD]: item.views } });
        continue;
      }
      if (current !== String(item.views)) {
        // 已有其他值：这是「拒绝覆盖」，不是「幂等重跑」。两者必须分开——前者是策略拒绝，
        // 后者静默跳过。把它们合并会让一次越权改写被当作正常运行记录进账本。
        throw new HuitunEvidenceError(`${WRITABLE_FIELD} already holds another value`, 'OVERWRITE_REFUSED', {
          recordId: item.recordId, keyword: item.keyword, existing: current, planned: item.views,
        });
      }
      alreadySettled.push(item.recordId);
    }
    if (stillBlank.length > 0 && !queueMatches) {
      throw new HuitunEvidenceError('the live candidate queue differs from the approved artifact', 'QUEUE_CHANGED', {
        approved: asText(artifact?.queueFingerprint), live: asText(liveBinding?.queueFingerprint), pendingWrites: stillBlank.length,
      });
    }
    return { records, stillBlank, alreadySettled, queueMatches };
  }

  return {
    expectedTarget,
    expected,

    // 对账式幂等写入：只写「仍然为空」的字段。
    // 进程在「飞书已写、本地未记账」之间崩溃后重跑（新 runId → 新 commitKey）不会造成二次改写，
    // UNKNOWN 对账也只需要一次回读，不必「猜它到底写没写」。
    async handler() {
      if (targetMismatch) {
        throw new HuitunEvidenceError('requested target differs from the approved artifact target', 'TARGET_MISMATCH', {
          approved: artifact?.target ?? null, requested: expectedTarget,
        });
      }
      const api = await client();
      const { stillBlank, alreadySettled, queueMatches } = await reconcile(api);
      const written = [];
      for (let offset = 0; offset < stillBlank.length; offset += batchSize) {
        const slice = stillBlank.slice(offset, offset + batchSize);
        // 用与运维 CLI 完全相同的守卫校验写入载荷：只允许 灰豚话题浏览量，且必须与计划逐字段等值。
        // 这一层防的是「实现自己在构造 body 时多写了别的字段」，不是防调用方。
        try {
          await guarded(() => assertAuthorizedMutation({
            appToken: expectedTarget.appToken,
            tableId: expectedTarget.tableId,
            method: 'POST',
            apiPath: `/bitable/v1/apps/${expectedTarget.appToken}/tables/${expectedTarget.tableId}/records/batch_update`,
            body: { records: slice },
            plan: { updates: slice },
          }));
        } catch (error) {
          throw error instanceof HuitunEvidenceError
            ? error
            : new HuitunEvidenceError(`write payload was rejected by the local guard: ${String(error?.message ?? error)}`, 'FEISHU_WRITE_REJECTED', {});
        }
        try {
          await api.batchUpdateRecords(slice);
        } catch (error) {
          if (isUnknownWriteFailure(error)) {
            // 结果未知：不允许当成失败重试，交给 UNKNOWN 对账路径。
            throw Object.assign(new Error(`Feishu write outcome unknown: ${String(error?.message ?? error)}`), {
              unknown: true, failureClass: 'TRANSIENT_EXTERNAL',
            });
          }
          throw new HuitunEvidenceError(`Feishu rejected the topic-view backfill: ${String(error?.message ?? error)}`, 'FEISHU_WRITE_REJECTED', {
            writtenBeforeFailure: written.map((row) => row.record_id),
          });
        }
        written.push(...slice);
      }
      // 校验「写进去的就是计划里的那条」：本地更新载荷与工件计划必须逐字段一致。
      const plannedById = new Map(updates.map((update) => [asText(update.record_id), Number(update.fields?.[WRITABLE_FIELD])]));
      for (const row of written) {
        if (plannedById.get(row.record_id) !== Number(row.fields[WRITABLE_FIELD])) {
          throw new HuitunEvidenceError('a written row disagrees with the approved plan', 'ITEM_INVALID', { recordId: row.record_id });
        }
      }
      return {
        writtenRecordIds: written.map((row) => row.record_id),
        alreadySettledRecordIds: alreadySettled,
        recordsWritten: written.length,
        recordsAlreadySettled: alreadySettled.length,
        plannedRecords: expected.length,
        // 如实记录「队列指纹当时还成立吗」：与本次是否落笔无关，是给对账的人看的事实
        // （重跑时它通常是 false——上一次写入已经让公式结算、行离开了 A候选 队列）。
        queueFingerprintMatched: queueMatches,
      };
    },

    // 回读验收：必须由飞书真实回读，且必须等到 优先级 公式结算，
    // 不能凭 batch_update 的返回推断。
    async readBack() {
      const api = await client();
      const deadline = Date.now() + settleTimeoutMs;
      let receipt = null;
      do {
        const records = await api.listRecords();
        receipt = buildReadbackReceipt({ expected, records, tableId: expectedTarget.tableId });
        if (receipt.verifiedAt) return receipt;
        if (Date.now() >= deadline) break;
        await sleep(pollMs);
      } while (Date.now() < deadline);
      return receipt;
    },
  };
}
