import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertAuthorizedMutation,
  buildDecisionPlan,
} from './keyword-decision-engine.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const CURRENT_TABLE_ID = 'tblN1uT1LpzyqqWx';
const HISTORY_TABLE_ID = 'tblh1Rwt0LE68KXc';
const LIBRARY_TABLE_ID = 'tblXJSGLoHt5z8Jv';
const CURRENT_TABLE_NAME = '关键词分析 V1（修正版）';
const ENV_FILE = 'E:/小红书/.env.local';
const BACKUP_DIR = path.resolve('runtime/keyword-analysis-backups');
const PROTECTED_TABLES = [CURRENT_TABLE_ID, HISTORY_TABLE_ID, LIBRARY_TABLE_ID];
const AUTHORIZED_RECORD_FIELDS = new Set(['是否重点词', '优先级']);

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

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.name ?? item?.value ?? String(item ?? '')).join('');
  }
  return String(value).trim();
}

function distribution(records, fieldName) {
  const output = {};
  for (const record of records) {
    if (!text(record.fields?.关键词编号)) continue;
    const value = text(record.fields?.[fieldName]) || '<空>';
    output[value] = (output[value] ?? 0) + 1;
  }
  return output;
}

function recordsWithoutAuthorizedFields(records) {
  return records.map((record) => ({
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name]) => !AUTHORIZED_RECORD_FIELDS.has(name))),
  }));
}

function fieldsWithoutProductDirection(fields) {
  return fields.filter((field) => field.field_name !== '对应产品方向');
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.productDirectionFieldId = null;
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
    if (method !== 'GET') {
      assertAuthorizedMutation({ method, path: apiPath, body }, {
        appToken: APP_TOKEN,
        currentTableId: CURRENT_TABLE_ID,
        productDirectionFieldId: this.productDirectionFieldId,
      });
    }
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

  async updateProductDirectionField(body) {
    return this.request('PUT', `/bitable/v1/apps/${APP_TOKEN}/tables/${CURRENT_TABLE_ID}/fields/${this.productDirectionFieldId}`, body);
  }

  async batchUpdateRecords(records) {
    return this.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${CURRENT_TABLE_ID}/records/batch_update`, { records });
  }
}

async function snapshotTables(api, tables) {
  const output = [];
  for (const tableId of PROTECTED_TABLES) {
    const table = tables.find((item) => item.table_id === tableId);
    if (!table) throw new Error(`Protected table missing: ${tableId}`);
    const [fields, records] = await Promise.all([api.listFields(tableId), api.listRecords(tableId)]);
    output.push({ tableId, tableName: table.name, fields, records });
  }
  return output;
}

function writeBackup(snapshots) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = { createdAt: new Date().toISOString(), appToken: APP_TOKEN, tables: snapshots };
  const content = `${JSON.stringify(backup, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `keyword-decisions-three-tables-${timestamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return { backupPath, backupSha256: crypto.createHash('sha256').update(content).digest('hex') };
}

function verifyCurrentShape(fields, records) {
  if (fields.length !== 22) throw new Error(`Current table expected 22 fields; received ${fields.length}`);
  const validRecords = records.filter((record) => text(record.fields?.关键词编号));
  if (validRecords.length !== 300) throw new Error(`Current table expected 300 valid keyword rows; received ${validRecords.length}`);
  const ids = validRecords.map((record) => text(record.fields.关键词编号));
  if (new Set(ids).size !== ids.length) throw new Error('Current table contains duplicate keyword numbers');
  return { validRecords: validRecords.length, blankRecords: records.length - validRecords.length };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-table='))?.split('=', 2)[1];
  if (apply && confirmation !== CURRENT_TABLE_ID) {
    throw new Error(`Apply requires --confirm-table=${CURRENT_TABLE_ID}`);
  }

  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const tables = await api.listTables();
  const currentTable = tables.find((item) => item.table_id === CURRENT_TABLE_ID);
  if (currentTable?.name !== CURRENT_TABLE_NAME) {
    throw new Error(`Authorized current table mismatch: ${currentTable?.name ?? '<missing>'}`);
  }
  const before = await snapshotTables(api, tables);
  const currentBefore = before.find((item) => item.tableId === CURRENT_TABLE_ID);
  const historyBefore = before.find((item) => item.tableId === HISTORY_TABLE_ID);
  const shape = verifyCurrentShape(currentBefore.fields, currentBefore.records);
  const direction = currentBefore.fields.find((field) => field.field_name === '对应产品方向');
  if (!direction) throw new Error('对应产品方向 field missing');
  api.productDirectionFieldId = direction.field_id;

  const plan = buildDecisionPlan({
    currentRecords: currentBefore.records,
    historyRecords: historyBefore.records,
  });
  const backup = writeBackup(before);
  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    appToken: APP_TOKEN,
    tableId: CURRENT_TABLE_ID,
    tableName: CURRENT_TABLE_NAME,
    recordCount: currentBefore.records.length,
    ...shape,
    historyRecordCount: historyBefore.records.length,
    historyDatedRecordCount: historyBefore.records.filter((record) => text(record.fields?.采集日期)).length,
    conflicts: plan.conflicts,
    plannedRecordUpdates: plan.updates.length,
    desiredDistribution: {
      是否重点词: Object.groupBy(plan.decisions, (item) => item.desired.是否重点词),
      优先级: Object.groupBy(plan.decisions, (item) => item.desired.优先级),
    },
    productDirection: {
      typeBefore: direction.type,
      typeAfter: 1,
      nonEmptyCount: currentBefore.records.filter((record) => text(record.fields?.对应产品方向)).length,
      promptWillBeConfiguredSeparatelyWithoutAIRun: true,
    },
    backup,
  };
  for (const field of Object.keys(summary.desiredDistribution)) {
    summary.desiredDistribution[field] = Object.fromEntries(Object.entries(summary.desiredDistribution[field])
      .map(([value, items]) => [value, items.length]));
  }

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (plan.conflicts.length > 0) {
    throw new Error(`Refusing to overwrite ${plan.conflicts.length} non-empty decision value(s)`);
  }
  if (currentBefore.records.some((record) => text(record.fields?.对应产品方向))) {
    throw new Error('Refusing to convert non-empty 对应产品方向 field');
  }

  if (direction.type !== 1) {
    await api.updateProductDirectionField({ field_name: '对应产品方向', type: 1 });
  }
  for (let index = 0; index < plan.updates.length; index += 500) {
    await api.batchUpdateRecords(plan.updates.slice(index, index + 500));
  }

  const after = await snapshotTables(api, tables);
  const currentAfter = after.find((item) => item.tableId === CURRENT_TABLE_ID);
  const historyAfter = after.find((item) => item.tableId === HISTORY_TABLE_ID);
  const libraryBefore = before.find((item) => item.tableId === LIBRARY_TABLE_ID);
  const libraryAfter = after.find((item) => item.tableId === LIBRARY_TABLE_ID);
  verifyCurrentShape(currentAfter.fields, currentAfter.records);

  if (digest(recordsWithoutAuthorizedFields(currentBefore.records)) !== digest(recordsWithoutAuthorizedFields(currentAfter.records))) {
    throw new Error('A non-authorized current-table record field changed');
  }
  if (digest(fieldsWithoutProductDirection(currentBefore.fields)) !== digest(fieldsWithoutProductDirection(currentAfter.fields))) {
    throw new Error('A non-authorized current-table field definition changed');
  }
  if (digest(historyBefore) !== digest(historyAfter)) throw new Error('History table changed unexpectedly');
  if (digest(libraryBefore) !== digest(libraryAfter)) throw new Error('Keyword library changed unexpectedly');
  const directionAfter = currentAfter.fields.find((field) => field.field_name === '对应产品方向');
  if (directionAfter?.type !== 1) throw new Error(`对应产品方向 expected text type 1; received ${directionAfter?.type}`);

  const expected = new Map(plan.decisions.map((item) => [item.recordId, item.desired]));
  for (const record of currentAfter.records) {
    const desired = expected.get(record.record_id);
    if (!desired) continue;
    for (const [name, value] of Object.entries(desired)) {
      if (text(record.fields?.[name]) !== value) {
        throw new Error(`${name} verification mismatch for ${record.record_id}`);
      }
    }
  }

  console.log(JSON.stringify({
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    recordUpdatesWritten: plan.updates.length,
    recordCountAfter: currentAfter.records.length,
    otherCurrentRecordDifferences: 0,
    otherCurrentFieldDefinitionDifferences: 0,
    historyTableDifferences: 0,
    keywordLibraryDifferences: 0,
    actualDistribution: {
      是否重点词: distribution(currentAfter.records, '是否重点词'),
      优先级: distribution(currentAfter.records, '优先级'),
    },
    productDirectionTypeAfter: directionAfter.type,
    aiRunsTriggered: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
