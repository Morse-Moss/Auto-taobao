import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildDecisionFormulaPlan,
  filterChangedFormulaPlan,
  normalizeFormulaExpression,
  verifyDecisionFormulaFields,
} from './keyword-decision-formulas.mjs';
import {
  assertDecisionSchemaMutation,
  buildDecisionSchemaPlan,
  verifyDecisionSchemaMigration,
} from './keyword-decision-schema.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const MAIN_TABLE_ID = 'tblN1uT1LpzyqqWx';
const MAIN_TABLE_NAME = '\u5173\u952e\u8bcd\u5206\u6790 V1\uff08\u4fee\u6b63\u7248\uff09';
const HISTORY_TABLE_ID = 'tblh1Rwt0LE68KXc';
const HISTORY_TABLE_NAME = '\u5173\u952e\u8bcd\u5386\u53f2\u603b\u8868 V1';
const LIBRARY_TABLE_ID = 'tblXJSGLoHt5z8Jv';
const LIBRARY_TABLE_NAME = '\u5173\u952e\u8bcd\u7f16\u53f7\u5e93 V1';
const ENV_FILE = 'E:/\u5c0f\u7ea2\u4e66/.env.local';
const BACKUP_DIR = path.resolve('runtime/keyword-analysis-backups');
const TEST_RECEIPT = path.resolve('runtime/keyword-decision-formula-live-test.json');

const REQUIRED_MAIN_FIELDS = [
  '\u641c\u7d22\u8bcd', '\u5173\u952e\u8bcd\u5206\u7c7b', '\u7ec6\u5206\u6807\u7b7e',
  '\u641c\u7d22\u70ed\u5ea6', '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09', '\u4ea4\u6613\u70ed\u5ea6',
  '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570', '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf',
  '\u662f\u5426\u91cd\u70b9\u8bcd', '\u4f18\u5148\u7ea7',
];
const DECISION_FIELDS = new Set(['\u662f\u5426\u91cd\u70b9\u8bcd', '\u4f18\u5148\u7ea7']);

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

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value);
}

function assertExactNames(fields, names, context) {
  const present = new Set(fields.map((field) => field.field_name));
  for (const name of names) {
    if (!present.has(name)) throw new Error(`${context} missing required field: ${name}`);
  }
}

function protectedTables() {
  return [
    { tableId: MAIN_TABLE_ID, tableName: MAIN_TABLE_NAME },
    { tableId: HISTORY_TABLE_ID, tableName: HISTORY_TABLE_NAME },
    { tableId: LIBRARY_TABLE_ID, tableName: LIBRARY_TABLE_NAME },
  ];
}

function testTableName() {
  return `__\u516c\u5f0f\u9a8c\u8bc1_\u91cd\u70b9\u8bcd\u4f18\u5148\u7ea7_V2_${stamp()}`;
}

function testFieldDefinitions() {
  const text = (name) => ({ field_name: name, type: 1 });
  const number = (name) => ({ field_name: name, type: 2 });
  const select = (name, options) => ({ field_name: name, type: 3, property: { options: options.map((option) => ({ name: option })) } });
  const multi = (name, options) => ({ field_name: name, type: 4, property: { options: options.map((option) => ({ name: option })) } });
  return [
    text('\u641c\u7d22\u8bcd'),
    select('\u5173\u952e\u8bcd\u5206\u7c7b', ['\u54c1\u724c\u8bcd', '\u573a\u666f\u8bcd', '\u75db\u70b9\u8bcd']),
    multi('\u7ec6\u5206\u6807\u7b7e', ['\u573a\u666f/\u5bb6\u7528', '\u75db\u70b9/\u6e05\u6d01', '\u75db\u70b9/\u6f0f\u6c34', '\u75db\u70b9/\u6392\u6c34', '\u75db\u70b9/\u7ef4\u4fee']),
    text('\u641c\u7d22\u70ed\u5ea6'),
    text('\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09'),
    text('\u4ea4\u6613\u70ed\u5ea6'),
    number('\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570'),
    number('\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf'),
    text('\u662f\u5426\u91cd\u70b9\u8bcd'),
    text('\u4f18\u5148\u7ea7'),
  ];
}

function testRows() {
  const row = (search, fields, expected) => ({
    fields: {
      '\u641c\u7d22\u8bcd': search,
      '\u5173\u952e\u8bcd\u5206\u7c7b': '\u573a\u666f\u8bcd',
      '\u7ec6\u5206\u6807\u7b7e': ['\u573a\u666f/\u5bb6\u7528'],
      '\u641c\u7d22\u70ed\u5ea6': '\u9ad8',
      '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09': '\u4e2d',
      '\u4ea4\u6613\u70ed\u5ea6': '\u4e2d',
      '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570': 2,
      '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf': 0,
      ...fields,
    },
    expected,
  });
  return [
    row('test-key-wait', { '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09': '', '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570': null }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5f85\u6570\u636e', '\u4f18\u5148\u7ea7': 'B-\u6301\u7eed\u89c2\u5bdf' }),
    row('test-key-yes', {}, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u662f', '\u4f18\u5148\u7ea7': 'B-\u6301\u7eed\u89c2\u5bdf' }),
    row('test-key-no', { '\u641c\u7d22\u70ed\u5ea6': '\u4e2d', '\u4ea4\u6613\u70ed\u5ea6': '\u9ad8' }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5426', '\u4f18\u5148\u7ea7': 'B-\u6301\u7eed\u89c2\u5bdf' }),
    row('test-brand', { '\u5173\u952e\u8bcd\u5206\u7c7b': '\u54c1\u724c\u8bcd', '\u641c\u7d22\u70ed\u5ea6': '', '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09': '', '\u4ea4\u6613\u70ed\u5ea6': '', '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570': null }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5426', '\u4f18\u5148\u7ea7': 'C-\u5e38\u89c4\u8ddf\u8e2a' }),
    row('test-service', { '\u5173\u952e\u8bcd\u5206\u7c7b': '\u75db\u70b9\u8bcd', '\u7ec6\u5206\u6807\u7b7e': ['\u75db\u70b9/\u6e05\u6d01'] }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5426', '\u4f18\u5148\u7ea7': 'C-\u5e38\u89c4\u8ddf\u8e2a' }),
    row('test-priority-a', { '\u641c\u7d22\u70ed\u5ea6': '\u4e2d', '\u4ea4\u6613\u70ed\u5ea6': '\u9ad8', '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf': 10000000 }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5426', '\u4f18\u5148\u7ea7': 'A-\u7acb\u5373\u8ddf\u8fdb' }),
    row('test-priority-b-without-content', { '\u641c\u7d22\u70ed\u5ea6': '\u4e2d', '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09': '', '\u4ea4\u6613\u70ed\u5ea6': '\u9ad8', '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570': null, '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf': 20000000 }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5f85\u6570\u636e', '\u4f18\u5148\u7ea7': 'A\u5019\u9009' }),
    row('test-priority-c', { '\u641c\u7d22\u70ed\u5ea6': '\u4f4e', '\u4ea4\u6613\u70ed\u5ea6': '\u9ad8' }, { '\u662f\u5426\u91cd\u70b9\u8bcd': '\u5426', '\u4f18\u5148\u7ea7': 'C-\u5e38\u89c4\u8ddf\u8e2a' }),
  ];
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
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${apiPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
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

  async createTestTable(name) {
    const fields = testFieldDefinitions();
    const body = { table: { name, default_view_name: '\u5168\u90e8\u8bb0\u5f55', fields } };
    if (!name.startsWith('__\u516c\u5f0f\u9a8c\u8bc1_') || !same(body.table.fields, fields)) throw new Error('Blocked unsafe test-table creation');
    await this.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables`, body);
    const matches = (await this.listTables()).filter((table) => table.name === name);
    if (matches.length !== 1) throw new Error(`Unable to resolve formula test table ${name}`);
    return matches[0].table_id;
  }

  async createTestRecords(tableId, rows) {
    const expected = new Set(testRows().map((item) => item.fields['\u641c\u7d22\u8bcd']));
    const actual = new Set(rows.map((item) => item.fields?.['\u641c\u7d22\u8bcd']));
    if (tableId === MAIN_TABLE_ID || actual.size !== expected.size || [...expected].some((name) => !actual.has(name))) {
      throw new Error('Blocked unexpected formula test record write');
    }
    await this.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`, { records: rows });
  }

  async applyDecisionSchema(tableId, plan) {
    for (const update of plan.updates) {
      const apiPath = `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${update.fieldId}`;
      assertDecisionSchemaMutation({ appToken: APP_TOKEN, tableId, plan, method: 'PUT', path: apiPath, body: update.body });
      await this.request('PUT', apiPath, update.body);
    }
    for (const create of plan.creates) {
      const apiPath = `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`;
      assertDecisionSchemaMutation({ appToken: APP_TOKEN, tableId, plan, method: 'POST', path: apiPath, body: create.body });
      await this.request('POST', apiPath, create.body);
    }
  }

  async updateFormulaFields(tableId, plan, { main = false } = {}) {
    for (const update of plan.updates) {
      if (!DECISION_FIELDS.has(update.fieldName) || update.body.type !== 20 || !update.body.property?.formula_expression) {
        throw new Error(`Blocked unapproved formula field mutation: ${update.fieldName}`);
      }
      if (main && tableId !== MAIN_TABLE_ID) throw new Error('Blocked main formula update against another table');
      if (!main && tableId === MAIN_TABLE_ID) throw new Error('Blocked test formula update against main table');
      await this.request('PUT', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${update.fieldId}`, update.body);
    }
  }
}

function canonicalRecords(records, ignoredFields = new Set()) {
  return [...records]
    .map((record) => ({
      record_id: record.record_id,
      fields: Object.fromEntries(Object.entries(record.fields ?? {})
        .filter(([name]) => !ignoredFields.has(name))),
    }))
    .sort((left, right) => left.record_id.localeCompare(right.record_id));
}

async function snapshotProtectedTables(api) {
  const tables = await api.listTables();
  const output = [];
  for (const expected of protectedTables()) {
    const table = tables.find((item) => item.table_id === expected.tableId);
    if (!table || table.name !== expected.tableName) throw new Error(`Authorized table mismatch: ${expected.tableId}`);
    const [fields, records] = await Promise.all([api.listFields(expected.tableId), api.listRecords(expected.tableId)]);
    output.push({ ...expected, fields, records });
  }
  return output;
}

function writeBackup(tables, purpose) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const content = `${JSON.stringify({ createdAt: new Date().toISOString(), appToken: APP_TOKEN, purpose, tables }, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `keyword-decision-formulas-${stamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return { path: backupPath, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

function tableById(tables, tableId) {
  const table = tables.find((item) => item.tableId === tableId);
  if (!table) throw new Error(`Missing protected snapshot for ${tableId}`);
  return table;
}

function verifyProtectedMutation(before, after, plan) {
  for (const expected of protectedTables()) {
    const prior = tableById(before, expected.tableId);
    const next = tableById(after, expected.tableId);
    if (prior.records.length !== next.records.length) throw new Error(`${expected.tableName} record count changed unexpectedly`);
    const ignore = expected.tableId === MAIN_TABLE_ID ? DECISION_FIELDS : new Set();
    if (!same(canonicalRecords(prior.records, ignore), canonicalRecords(next.records, ignore))) {
      throw new Error(`${expected.tableName} record data changed outside decision formulas`);
    }
    if (expected.tableId === MAIN_TABLE_ID) {
      verifyDecisionFormulaFields({ tableId: MAIN_TABLE_ID, before: prior.fields, after: next.fields, plan });
      continue;
    }
    if (!same(prior.fields, next.fields)) throw new Error(`${expected.tableName} field definitions changed unexpectedly`);
  }
}

async function waitForTestResults(api, tableId, rows) {
  const expected = new Map(rows.map((row) => [row.fields['\u641c\u7d22\u8bcd'], row.expected]));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const records = await api.listRecords(tableId);
    const actual = new Map(records.map((record) => [plain(record.fields?.['\u641c\u7d22\u8bcd']), record.fields ?? {}]));
    let pending = false;
    let mismatch;
    for (const [search, outcome] of expected) {
      const fields = actual.get(search);
      const key = plain(fields?.['\u662f\u5426\u91cd\u70b9\u8bcd']);
      const priority = plain(fields?.['\u4f18\u5148\u7ea7']);
      if (!fields || !key || !priority || key.startsWith('#') || priority.startsWith('#')) {
        pending = true;
        continue;
      }
      if (key !== outcome['\u662f\u5426\u91cd\u70b9\u8bcd'] || priority !== outcome['\u4f18\u5148\u7ea7']) {
        mismatch = { search, expected: outcome, actual: { '\u662f\u5426\u91cd\u70b9\u8bcd': key, '\u4f18\u5148\u7ea7': priority } };
        break;
      }
    }
    if (mismatch) throw new Error(`Formula test outcome mismatch: ${JSON.stringify(mismatch)}`);
    if (!pending) return { recordCount: records.length, expectedRows: expected.size };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Formula test did not settle within 120 seconds');
}

function formulaDigest(plan) {
  return digest(plan.updates.map((item) => ({
    fieldName: item.fieldName,
    expression: normalizeFormulaExpression(item.body.property.formula_expression),
  })));
}

async function runLiveTest(api) {
  const rows = testRows();
  const existing = (await api.listTables()).filter((table) => table.name.startsWith('__\u516c\u5f0f\u9a8c\u8bc1_'));
  const reusable = [];
  for (const table of existing) {
    const [fields, records] = await Promise.all([api.listFields(table.table_id), api.listRecords(table.table_id)]);
    if (records.length === rows.length) reusable.push({ tableId: table.table_id, name: table.name, fields });
  }
  if (reusable.length > 1) throw new Error('More than one reusable formula test table exists');
  const created = reusable.length === 0;
  const name = reusable[0]?.name ?? testTableName();
  const tableId = reusable[0]?.tableId ?? await api.createTestTable(name);
  if (created) await api.createTestRecords(tableId, rows.map(({ fields }) => ({ fields })));
  const fieldsBefore = reusable[0]?.fields ?? await api.listFields(tableId);
  assertExactNames(fieldsBefore, REQUIRED_MAIN_FIELDS, 'Formula test table');
  const plan = buildDecisionFormulaPlan({ tableId, fields: fieldsBefore });
  const alreadyFormula = plan.updates.every((update) => {
    const field = fieldsBefore.find((item) => item.field_id === update.fieldId);
    return field?.type === 20 && field.property?.formula_expression === update.body.property.formula_expression;
  });
  if (!alreadyFormula) await api.updateFormulaFields(tableId, plan);
  const fieldsAfter = await api.listFields(tableId);
  verifyDecisionFormulaFields({ tableId, before: fieldsBefore, after: fieldsAfter, plan });
  const result = await waitForTestResults(api, tableId, rows);
  const receipt = {
    createdAt: new Date().toISOString(),
    appToken: APP_TOKEN,
    tableId,
    tableName: name,
    formulaDigest: formulaDigest(plan),
    ...result,
  };
  fs.writeFileSync(TEST_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

async function applyMain(api) {
  if (!fs.existsSync(TEST_RECEIPT)) throw new Error(`Main migration requires a verified live-test receipt: ${TEST_RECEIPT}`);
  const receipt = JSON.parse(fs.readFileSync(TEST_RECEIPT, 'utf8'));
  if (receipt.appToken !== APP_TOKEN || !receipt.tableId || receipt.expectedRows !== testRows().length) {
    throw new Error('Formula test receipt is incomplete or belongs to another base');
  }

  const before = await snapshotProtectedTables(api);
  const mainBefore = tableById(before, MAIN_TABLE_ID);
  const schemaPlan = buildDecisionSchemaPlan({ fields: mainBefore.fields, records: mainBefore.records });
  const backup = writeBackup(before, 'before applying the latest decision helper fields and verified formulas');

  if (schemaPlan.updates.length || schemaPlan.creates.length) {
    await api.applyDecisionSchema(MAIN_TABLE_ID, schemaPlan);
  }

  const afterSchema = await snapshotProtectedTables(api);
  const mainAfterSchema = tableById(afterSchema, MAIN_TABLE_ID);
  const schemaVerification = verifyDecisionSchemaMigration({
    before: { fields: mainBefore.fields, records: mainBefore.records },
    after: { fields: mainAfterSchema.fields, records: mainAfterSchema.records },
    plan: schemaPlan,
  });
  for (const expected of protectedTables().filter((item) => item.tableId !== MAIN_TABLE_ID)) {
    if (!same(tableById(before, expected.tableId), tableById(afterSchema, expected.tableId))) {
      throw new Error(`${expected.tableName} changed during decision schema migration`);
    }
  }

  assertExactNames(mainAfterSchema.fields, REQUIRED_MAIN_FIELDS, MAIN_TABLE_NAME);
  const fullPlan = buildDecisionFormulaPlan({ tableId: MAIN_TABLE_ID, fields: mainAfterSchema.fields });
  if (receipt.formulaDigest !== formulaDigest(fullPlan)) throw new Error('Live-test formulas differ from the current main-table plan');
  const plan = filterChangedFormulaPlan({ fields: mainAfterSchema.fields, plan: fullPlan });
  if (plan.updates.some((update) => update.fieldName !== '\u4f18\u5148\u7ea7')) {
    throw new Error('Current migration is allowed to change only the priority formula');
  }

  if (plan.updates.length) await api.updateFormulaFields(MAIN_TABLE_ID, plan, { main: true });
  const after = await snapshotProtectedTables(api);
  verifyProtectedMutation(afterSchema, after, plan);
  const mainAfter = tableById(after, MAIN_TABLE_ID);
  const distribution = Object.fromEntries([...mainAfter.records.reduce((map, record) => {
    const key = `${plain(record.fields?.['\u662f\u5426\u91cd\u70b9\u8bcd']) || '<empty>'}|${plain(record.fields?.['\u4f18\u5148\u7ea7']) || '<empty>'}`;
    map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
  return {
    backup,
    schemaVerification,
    fieldCount: mainAfter.fields.length,
    recordCount: mainAfter.records.length,
    recordsWritten: 0,
    fieldsConvertedToFormula: plan.updates.map((item) => item.fieldName),
    distribution,
  };
}

async function main() {
  const liveTest = process.argv.includes('--live-test');
  const apply = process.argv.includes('--apply-main');
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-table='))?.slice('--confirm-table='.length);
  if (!liveTest && !apply) throw new Error('Choose --live-test or --apply-main');
  if (apply && confirmation !== MAIN_TABLE_ID) throw new Error(`Apply requires --confirm-table=${MAIN_TABLE_ID}`);

  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const output = {};
  if (liveTest) output.liveTest = await runLiveTest(api);
  if (apply) output.mainMigration = await applyMain(api);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
