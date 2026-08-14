import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
export const TABLE_ID = 'tblN1uT1LpzyqqWx';
export const TABLE_NAME = '关键词分析 V1（修正版）';
export const A_THRESHOLD = 10_000_000;

const API_ROOT = 'https://open.feishu.cn/open-apis';
const ENV_FILE = 'E:/小红书/.env.local';
const BACKUP_DIR = path.resolve('runtime/keyword-analysis-backups');
const WRITABLE_FIELDS = new Set(['内容热度（后续）', '灰豚话题浏览量']);
const FORMULA_FIELDS = new Set(['是否重点词', '优先级']);

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
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

export function contentHeatForViews(views) {
  if (!Number.isSafeInteger(views) || views < 0) throw new Error(`Invalid numeric views: ${views}`);
  return views >= A_THRESHOLD ? '高' : '低';
}

export function normalizeResults(document) {
  if (!document || !Array.isArray(document.items) || document.items.length === 0) {
    throw new Error('Huitun result document must contain at least one item');
  }
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
      return { keyword, status: item.status, topic, viewsRaw: plain(item.viewsRaw), views, contentHeat: contentHeatForViews(views) };
    }
    if (item.status === 'NO_EXACT_TOPIC') {
      if (item.topic != null || item.views !== 0) throw new Error(`No-result item must use null topic and zero views: ${keyword}`);
      return { keyword, status: item.status, topic: null, viewsRaw: plain(item.viewsRaw), views: 0, contentHeat: '低' };
    }
    throw new Error(`Unsupported Huitun result status for ${keyword}: ${item.status}`);
  });
}

function uniqueRecord(records, keyword) {
  const matches = records.filter((record) => plain(record.fields?.搜索词) === keyword);
  if (matches.length !== 1) throw new Error(`Expected exactly one Feishu record for ${keyword}; received ${matches.length}`);
  return matches[0];
}

export function buildHuitunUpdatePlan({ records, resultDocument }) {
  const results = normalizeResults(resultDocument);
  const candidates = records.filter((record) => plain(record.fields?.优先级) === 'A候选');
  const candidateNames = candidates.map((record) => plain(record.fields?.搜索词)).sort();
  const resultNames = results.map((item) => item.keyword).sort();
  if (!same(candidateNames, resultNames)) {
    throw new Error(`Live A候选 queue differs from Huitun results: queue=${JSON.stringify(candidateNames)} results=${JSON.stringify(resultNames)}`);
  }

  const updates = [];
  const expected = [];
  for (const result of results) {
    const record = uniqueRecord(records, result.keyword);
    const desired = { '内容热度（后续）': result.contentHeat, '灰豚话题浏览量': result.views };
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
      desired,
      expectedPriority: result.views >= A_THRESHOLD ? 'A-立即跟进' : 'B-持续观察',
    });
  }
  return { updates, expected };
}

export function assertHuitunMutation({ method, apiPath, body, plan }) {
  const expectedPath = `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`;
  const valid = method === 'POST' && apiPath === expectedPath &&
    Array.isArray(body?.records) && body.records.length > 0 &&
    body.records.every((record) => record.record_id && Object.keys(record.fields ?? {}).length > 0 &&
      Object.keys(record.fields).every((name) => WRITABLE_FIELDS.has(name))) &&
    same(body.records, plan.updates);
  if (!valid) throw new Error(`Blocked unauthorized Huitun mutation: ${method} ${apiPath}`);
}

function canonicalRecord(record, ignoredFields = new Set()) {
  return {
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name]) => !ignoredFields.has(name))
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
  };
}

export function verifyHuitunBackfill({ before, after, plan }) {
  if (before.length !== after.length) throw new Error('Huitun backfill changed the record count');
  const expectedById = new Map(plan.expected.map((item) => [item.recordId, item]));
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Huitun backfill removed record ${prior.record_id}`);
    const expected = expectedById.get(prior.record_id);
    if (!expected) {
      if (!same(prior, next)) throw new Error(`Huitun backfill changed unrelated record ${prior.record_id}`);
      continue;
    }
    const ignored = new Set([...WRITABLE_FIELDS, ...FORMULA_FIELDS]);
    if (!same(canonicalRecord(prior, ignored), canonicalRecord(next, ignored))) {
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
    verified: plan.expected.map((item) => ({ keyword: item.keyword, ...item.desired, priority: item.expectedPriority })),
  };
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.msg ?? ''}`.trim());
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, apiPath, body) {
    const response = await fetch(`${API_ROOT}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${apiPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    return (await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`)).items ?? [];
  }

  async listFields() {
    return (await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`)).items ?? [];
  }

  async listRecords() {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async apply(plan) {
    const apiPath = `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`;
    const body = { records: plan.updates };
    assertHuitunMutation({ method: 'POST', apiPath, body, plan });
    return this.request('POST', apiPath, body);
  }
}

function requiredField(fields, name, type) {
  const matches = fields.filter((field) => field.field_name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  if (type != null && matches[0].type !== type) throw new Error(`${name} expected field type ${type}; received ${matches[0].type}`);
  return matches[0];
}

function writeBackup(fields, records, resultDocument) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const content = `${JSON.stringify({ createdAt: new Date().toISOString(), appToken: APP_TOKEN, tableId: TABLE_ID, fields, records, resultDocument }, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `huitun-backfill-${stamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return { path: backupPath, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function waitForFormulaSettlement(api, plan) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const records = await api.listRecords();
    const byId = new Map(records.map((record) => [record.record_id, record]));
    const settled = plan.expected.every((item) => plain(byId.get(item.recordId)?.fields?.优先级) === item.expectedPriority);
    if (settled) return records;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Feishu priority formulas did not settle within 60 seconds');
}

function summarizePlan(plan) {
  return plan.expected.map((item) => ({
    keyword: item.keyword,
    status: item.status,
    topic: item.topic,
    viewsRaw: item.viewsRaw,
    contentHeat: item.desired['内容热度（后续）'],
    views: item.desired.灰豚话题浏览量,
    expectedPriority: item.expectedPriority,
    willWrite: plan.updates.some((update) => update.record_id === item.recordId),
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-table='))?.slice('--confirm-table='.length);
  const resultPathArg = process.argv.find((arg) => arg.startsWith('--results='))?.slice('--results='.length);
  if (!resultPathArg) throw new Error('Usage requires --results=<json file>');
  if (apply && confirmation !== TABLE_ID) throw new Error(`Apply requires --confirm-table=${TABLE_ID}`);

  const resultPath = path.resolve(resultPathArg);
  const resultDocument = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const tables = await api.listTables();
  const table = tables.find((item) => item.table_id === TABLE_ID);
  if (table?.name !== TABLE_NAME) throw new Error(`Authorized table mismatch: ${table?.name ?? '<missing>'}`);
  const [fields, records] = await Promise.all([api.listFields(), api.listRecords()]);
  requiredField(fields, '搜索词');
  requiredField(fields, '内容热度（后续）', 1);
  requiredField(fields, '灰豚话题浏览量', 2);
  requiredField(fields, '优先级', 20);
  const plan = buildHuitunUpdatePlan({ records, resultDocument });
  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    appToken: APP_TOKEN,
    tableId: TABLE_ID,
    tableName: TABLE_NAME,
    fieldCount: fields.length,
    recordCount: records.length,
    results: summarizePlan(plan),
    plannedRecordUpdates: plan.updates.length,
  };
  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backup = writeBackup(fields, records, resultDocument);
  if (plan.updates.length > 0) await api.apply(plan);
  const after = await waitForFormulaSettlement(api, plan);
  const fieldsAfter = await api.listFields();
  if (!same(fields, fieldsAfter)) throw new Error('Huitun backfill changed field definitions');
  const verification = verifyHuitunBackfill({ before: records, after, plan });
  console.log(JSON.stringify({ ...summary, mode: 'APPLIED_AND_VERIFIED', backup, verification }, null, 2));
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
