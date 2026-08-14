import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  EXPECTED_RECORD_COUNT,
  FORMAL_TABLE_ID,
  FORMAL_TABLE_NAME,
  assertFormalFieldMutation,
  assertRecordsUnchanged,
  buildFormalFieldPlan,
  verifyFormalTable,
  verifyMigratedFields,
} from './keyword-analysis-v2-formal-migration.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const ENV_FILE = 'E:/小红书/.env.local';
const BACKUP_DIR = path.resolve('runtime/keyword-analysis-backups');

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

function collectStrings(value, output) {
  if (typeof value === 'string') output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function optionCount(field) {
  return field.property?.options?.length ?? 0;
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.allowedFields = new Map();
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
      assertFormalFieldMutation({ method, path: apiPath, body }, {
        appToken: APP_TOKEN,
        allowedFields: this.allowedFields,
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

  async listFields() {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${FORMAL_TABLE_ID}/fields?page_size=100`);
    const fields = data.items ?? [];
    this.allowedFields = new Map(fields
      .filter((field) => ['标准归并词', '关键词分类', '细分标签', '用户意图'].includes(field.field_name))
      .map((field) => [field.field_id, field.field_name]));
    return fields;
  }

  async listRecords() {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${FORMAL_TABLE_ID}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async updateField(fieldId, body) {
    return this.request('PUT', `/bitable/v1/apps/${APP_TOKEN}/tables/${FORMAL_TABLE_ID}/fields/${fieldId}`, body);
  }
}

async function main() {
  const apply = process.argv.includes('--apply-formal-fields');
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-table='))?.split('=', 2)[1];
  if (apply && confirmation !== FORMAL_TABLE_ID) {
    throw new Error(`Apply requires --confirm-table=${FORMAL_TABLE_ID}`);
  }

  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const tables = await api.listTables();
  const table = tables.find((item) => item.table_id === FORMAL_TABLE_ID);
  const [fieldsBefore, recordsBefore] = await Promise.all([api.listFields(), api.listRecords()]);
  verifyFormalTable({ tableName: table?.name, fields: fieldsBefore, recordCount: recordsBefore.length });

  const usedIntentOptionNames = new Set();
  for (const record of recordsBefore) collectStrings(record.fields?.用户意图, usedIntentOptionNames);
  const plan = buildFormalFieldPlan(fieldsBefore, { usedIntentOptionNames });

  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    appToken: APP_TOKEN,
    tableId: FORMAL_TABLE_ID,
    tableName: FORMAL_TABLE_NAME,
    fieldCount: fieldsBefore.length,
    recordCount: recordsBefore.length,
    updates: plan.updates.map((item) => {
      const before = fieldsBefore.find((field) => field.field_id === item.fieldId);
      return {
        fieldName: item.fieldName,
        typeBefore: before.type,
        typeAfter: item.body.type,
        optionsBefore: optionCount(before),
        optionsAfter: item.body.property?.options?.length ?? 0,
      };
    }),
    fieldsCreated: 0,
    recordsWillBeWritten: false,
    aiRunsWillBeTriggered: false,
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = {
    createdAt: new Date().toISOString(),
    appToken: APP_TOKEN,
    tableId: FORMAL_TABLE_ID,
    tableName: FORMAL_TABLE_NAME,
    fields: fieldsBefore,
    records: recordsBefore,
  };
  const backupText = `${JSON.stringify(backup, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `keyword-analysis-v1-corrected-${timestamp()}.json`);
  fs.writeFileSync(backupPath, backupText, { encoding: 'utf8', flag: 'wx' });
  const backupSha256 = crypto.createHash('sha256').update(backupText).digest('hex');

  const completed = [];
  for (const update of plan.updates) {
    await api.updateField(update.fieldId, update.body);
    const [currentFields, currentRecords] = await Promise.all([api.listFields(), api.listRecords()]);
    verifyFormalTable({ tableName: table.name, fields: currentFields, recordCount: currentRecords.length });
    assertRecordsUnchanged(recordsBefore, currentRecords);
    completed.push(update.fieldName);
  }

  const [fieldsAfter, recordsAfter] = await Promise.all([api.listFields(), api.listRecords()]);
  verifyFormalTable({ tableName: table.name, fields: fieldsAfter, recordCount: recordsAfter.length });
  verifyMigratedFields(fieldsAfter);
  assertRecordsUnchanged(recordsBefore, recordsAfter);

  console.log(JSON.stringify({
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    completed,
    backupPath,
    backupSha256,
    recordCountAfter: recordsAfter.length,
    recordDataDifferences: 0,
    fieldsCreated: 0,
    recordsWritten: 0,
    aiRunsTriggered: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
