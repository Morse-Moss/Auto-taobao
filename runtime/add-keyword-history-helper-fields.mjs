import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const ENV_FILE = 'E:/小红书/.env.local';
const BACKUP_DIR = path.resolve('runtime/keyword-analysis-backups');

export const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
export const ANALYSIS_TABLE_ID = 'tblN1uT1LpzyqqWx';
export const ANALYSIS_TABLE_NAME = '关键词分析 V1（修正版）';
export const HISTORY_TABLE_ID = 'tblh1Rwt0LE68KXc';
export const HISTORY_TABLE_NAME = '关键词历史总表 V1';
export const KEYWORD_LIBRARY_TABLE_ID = 'tblXJSGLoHt5z8Jv';
export const KEYWORD_LIBRARY_TABLE_NAME = '关键词编号库 V1';

// These fields are intentionally plain numbers. The weekly importer will populate them later.
export const FIELD_ADDITIONS = [
  {
    tableId: ANALYSIS_TABLE_ID,
    tableName: ANALYSIS_TABLE_NAME,
    fields: [
      { fieldName: '已有有效批次数', body: { field_name: '已有有效批次数', type: 2 } },
      { fieldName: '近8批出现次数', body: { field_name: '近8批出现次数', type: 2 } },
    ],
  },
  {
    tableId: HISTORY_TABLE_ID,
    tableName: HISTORY_TABLE_NAME,
    fields: [
      { fieldName: '批次编号', body: { field_name: '批次编号', type: 2 } },
    ],
  },
];

const PROTECTED_TABLES = [
  { tableId: ANALYSIS_TABLE_ID, tableName: ANALYSIS_TABLE_NAME },
  { tableId: HISTORY_TABLE_ID, tableName: HISTORY_TABLE_NAME },
  { tableId: KEYWORD_LIBRARY_TABLE_ID, tableName: KEYWORD_LIBRARY_TABLE_NAME },
];

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function tableById(snapshot, tableId) {
  const matches = snapshot.filter((item) => item.tableId === tableId);
  if (matches.length !== 1) throw new Error(`Expected one protected snapshot for ${tableId}; received ${matches.length}`);
  return matches[0];
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertProtectedShape(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length !== PROTECTED_TABLES.length) {
    throw new Error('Protected snapshot must contain exactly the three authorized tables');
  }
  for (const expected of PROTECTED_TABLES) {
    const table = tableById(snapshot, expected.tableId);
    if (table.tableName !== expected.tableName) {
      throw new Error(`Authorized table mismatch for ${expected.tableId}: ${table.tableName ?? '<missing>'}`);
    }
    const names = table.fields.map((field) => field.field_name);
    if (new Set(names).size !== names.length) {
      throw new Error(`${expected.tableName} contains duplicate field names`);
    }
  }
}

function assertAppendPosition(table, addition) {
  const names = table.fields.map((field) => field.field_name);
  const dateIndex = names.indexOf('采集日期');
  if (dateIndex < 0) throw new Error(`${addition.tableName} missing 采集日期`);
  if (names.lastIndexOf('采集日期') !== dateIndex) throw new Error(`${addition.tableName} contains duplicate 采集日期`);

  const afterDate = table.fields.slice(dateIndex + 1);
  const expectedPrefix = addition.fields.slice(0, afterDate.length);
  if (afterDate.length > addition.fields.length ||
      afterDate.some((field, index) => field.field_name !== expectedPrefix[index]?.fieldName || field.type !== 2)) {
    throw new Error(`${addition.tableName} requires 采集日期 to be the last existing field before helper fields`);
  }
  return afterDate.length;
}

export function buildFieldCreatePlan(snapshot) {
  assertProtectedShape(snapshot);
  const creates = [];
  for (const addition of FIELD_ADDITIONS) {
    const table = tableById(snapshot, addition.tableId);
    const completedCount = assertAppendPosition(table, addition);
    for (const field of addition.fields.slice(completedCount)) {
      creates.push({
        tableId: addition.tableId,
        tableName: addition.tableName,
        fieldName: field.fieldName,
        body: structuredClone(field.body),
      });
    }
  }
  return { creates, recordsWillBeWritten: false };
}

export function assertHelperFieldMutation({ method, path: apiPath, body }) {
  const allowed = FIELD_ADDITIONS.flatMap((addition) => addition.fields.map((field) => ({
    tableId: addition.tableId,
    body: field.body,
  })));
  const match = allowed.find((candidate) =>
    method === 'POST' &&
    apiPath === `/bitable/v1/apps/${APP_TOKEN}/tables/${candidate.tableId}/fields` &&
    same(body, candidate.body));
  if (!match) throw new Error(`Blocked unauthorized mutation: ${method} ${apiPath}`);
}

function immutableRecords(records, ignoredFieldNames = new Set()) {
  return [...records]
    .map((record) => ({
      record_id: record.record_id,
      fields: Object.fromEntries(Object.entries(record.fields ?? {})
        .filter(([name]) => !ignoredFieldNames.has(name))),
    }))
    .sort((left, right) => left.record_id.localeCompare(right.record_id));
}

function changedFieldNames(beforeFields, afterFields) {
  const names = new Set([...Object.keys(beforeFields ?? {}), ...Object.keys(afterFields ?? {})]);
  return [...names].filter((name) => !same(beforeFields?.[name], afterFields?.[name]));
}

export function summarizeSnapshotDifference(before, after) {
  assertProtectedShape(before);
  assertProtectedShape(after);
  const tables = [];
  for (const expected of PROTECTED_TABLES) {
    const beforeTable = tableById(before, expected.tableId);
    const afterTable = tableById(after, expected.tableId);
    const beforeById = new Map(beforeTable.records.map((record) => [record.record_id, record]));
    const afterById = new Map(afterTable.records.map((record) => [record.record_id, record]));
    const changedNames = new Set();
    let changedRecordCount = 0;
    for (const [recordId, beforeRecord] of beforeById) {
      const afterRecord = afterById.get(recordId);
      if (!afterRecord) continue;
      const names = changedFieldNames(beforeRecord.fields, afterRecord.fields);
      if (names.length === 0) continue;
      changedRecordCount += 1;
      for (const name of names) changedNames.add(name);
    }
    const addedRecordCount = [...afterById.keys()].filter((recordId) => !beforeById.has(recordId)).length;
    const removedRecordCount = [...beforeById.keys()].filter((recordId) => !afterById.has(recordId)).length;
    if (changedRecordCount || addedRecordCount || removedRecordCount) {
      tables.push({
        tableName: expected.tableName,
        recordCountBefore: beforeTable.records.length,
        recordCountAfter: afterTable.records.length,
        changedRecordCount,
        addedRecordCount,
        removedRecordCount,
        changedFieldNames: [...changedNames].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      });
    }
  }
  return { tables };
}

export function verifyFieldAddition({ before, after, plan }) {
  assertProtectedShape(before);
  assertProtectedShape(after);
  const expectedCreatesByTable = new Map();
  for (const create of plan.creates) {
    const entries = expectedCreatesByTable.get(create.tableId) ?? [];
    entries.push(create);
    expectedCreatesByTable.set(create.tableId, entries);
  }

  for (const expected of PROTECTED_TABLES) {
    const beforeTable = tableById(before, expected.tableId);
    const afterTable = tableById(after, expected.tableId);
    const ignoredFieldNames = new Set((expectedCreatesByTable.get(expected.tableId) ?? [])
      .map((create) => create.fieldName));
    if (!same(immutableRecords(beforeTable.records), immutableRecords(afterTable.records, ignoredFieldNames))) {
      throw new Error(`${expected.tableName} record data changed unexpectedly`);
    }

    const creates = expectedCreatesByTable.get(expected.tableId) ?? [];
    if (!same(afterTable.fields.slice(0, beforeTable.fields.length), beforeTable.fields)) {
      throw new Error(`${expected.tableName} existing field definition changed unexpectedly`);
    }
    const appended = afterTable.fields.slice(beforeTable.fields.length);
    if (appended.length !== creates.length || appended.some((field, index) =>
      field.field_name !== creates[index]?.fieldName || field.type !== creates[index]?.body.type)) {
      throw new Error(`${expected.tableName} appended helper fields differ from the approved plan`);
    }
  }

  const analysisFields = tableById(after, ANALYSIS_TABLE_ID).fields.map((field) => field.field_name);
  const historyFields = tableById(after, HISTORY_TABLE_ID).fields.map((field) => field.field_name);
  if (analysisFields.slice(-2).join('|') !== '已有有效批次数|近8批出现次数') {
    throw new Error('Main-table helper field order verification failed');
  }
  if (historyFields.at(-1) !== '批次编号') {
    throw new Error('History-table helper field position verification failed');
  }
  return {
    recordsChanged: 0,
    existingFieldsChanged: 0,
    fieldsCreated: plan.creates.length,
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
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, apiPath, body) {
    if (method !== 'GET') assertHelperFieldMutation({ method, path: apiPath, body });
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

  async listFields(tableId) {
    return (await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields?page_size=100`)).items ?? [];
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async createField(tableId, body) {
    return this.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, body);
  }
}

async function snapshotTables(api) {
  const tables = await api.listTables();
  const snapshots = [];
  for (const expected of PROTECTED_TABLES) {
    const table = tables.find((item) => item.table_id === expected.tableId);
    if (!table || table.name !== expected.tableName) {
      throw new Error(`Authorized table mismatch for ${expected.tableId}: ${table?.name ?? '<missing>'}`);
    }
    const [fields, records] = await Promise.all([
      api.listFields(expected.tableId),
      api.listRecords(expected.tableId),
    ]);
    snapshots.push({ tableId: expected.tableId, tableName: table.name, fields, records });
  }
  return snapshots;
}

function writeBackup(snapshot) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    appToken: APP_TOKEN,
    purpose: 'before adding keyword-history helper fields',
    tables: snapshot,
  }, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `keyword-helper-fields-${timestamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return {
    backupPath,
    backupSha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const compareBackup = process.argv.find((arg) => arg.startsWith('--compare-backup='))?.slice('--compare-backup='.length);
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-app='))?.split('=', 2)[1];
  if (apply && confirmation !== APP_TOKEN) {
    throw new Error(`Apply requires --confirm-app=${APP_TOKEN}`);
  }

  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const before = await snapshotTables(api);
  if (compareBackup) {
    const backup = JSON.parse(fs.readFileSync(compareBackup, 'utf8'));
    const backupTables = backup.tables;
    const backupPlan = buildFieldCreatePlan(backupTables);
    const verification = verifyFieldAddition({ before: backupTables, after: before, plan: backupPlan });
    console.log(JSON.stringify({
      mode: 'READ_ONLY_DIAGNOSTIC',
      backupPath: path.resolve(compareBackup),
      backupSha256: crypto.createHash('sha256').update(fs.readFileSync(compareBackup)).digest('hex'),
      recordDifference: summarizeSnapshotDifference(backupTables, before),
      verification,
      currentShape: before.map((table) => ({
        tableName: table.tableName,
        fieldCount: table.fields.length,
        recordCount: table.records.length,
        trailingFields: table.fields.slice(-4).map((field) => ({ name: field.field_name, type: field.type })),
      })),
      recordsWritten: 0,
    }, null, 2));
    return;
  }
  const plan = buildFieldCreatePlan(before);
  if (!apply || plan.creates.length === 0) {
    console.log(JSON.stringify({
      mode: apply ? 'NO_OP_ALREADY_APPLIED' : 'DRY_RUN',
      appToken: APP_TOKEN,
      creates: plan.creates.map(({ tableName, fieldName, body }) => ({ tableName, fieldName, type: body.type })),
      recordsWillBeWritten: false,
    }, null, 2));
    return;
  }

  const backup = writeBackup(before);
  for (const create of plan.creates) {
    const current = await snapshotTables(api);
    const remaining = buildFieldCreatePlan(current).creates;
    const next = remaining[0];
    if (!next || next.tableId !== create.tableId || next.fieldName !== create.fieldName || !same(next.body, create.body)) {
      throw new Error('Field plan changed during execution; refusing to continue');
    }
    await api.createField(create.tableId, create.body);
  }

  const after = await snapshotTables(api);
  const verification = verifyFieldAddition({ before, after, plan });
  console.log(JSON.stringify({
    mode: 'APPLIED_AND_VERIFIED',
    appToken: APP_TOKEN,
    created: plan.creates.map(({ tableName, fieldName, body }) => ({ tableName, fieldName, type: body.type })),
    backup,
    ...verification,
    recordsWritten: 0,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
