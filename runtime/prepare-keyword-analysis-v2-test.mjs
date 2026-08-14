import fs from 'node:fs';

import {
  TEST_TABLE_ID,
  assertTestTableMutation,
  buildTestTableFieldPlan,
} from './keyword-analysis-v2-feishu-plan.mjs';
import {
  applyFieldPlan,
  verifyPreparedTestTable,
} from './keyword-analysis-v2-feishu-runner.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TEST_TABLE_NAME = '关键词AI试跑_浴缸_20260811_30行';
const ENV_FILE = 'E:/小红书/.env.local';
const BATCH_ID = 'TEST-YG-20260811-01';

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

class FeishuApi {
  #token;

  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.allowedExistingFieldIds = new Set();
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

  async request(method, path, body) {
    if (method !== 'GET') {
      assertTestTableMutation({ method, path, body }, {
        appToken: APP_TOKEN,
        allowedExistingFieldIds: this.allowedExistingFieldIds,
      });
    }
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
    return data.items ?? [];
  }

  async listFields() {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TEST_TABLE_ID}/fields?page_size=100`);
    const fields = data.items ?? [];
    this.allowedExistingFieldIds = new Set(fields.map((field) => field.field_id));
    return fields;
  }

  async getRecordCount() {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TEST_TABLE_ID}/records?page_size=1`);
    return data.total ?? data.items?.length ?? 0;
  }

  async updateField(fieldId, body) {
    await this.request('PUT', `/bitable/v1/apps/${APP_TOKEN}/tables/${TEST_TABLE_ID}/fields/${fieldId}`, body);
  }

  async createField(body) {
    await this.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${TEST_TABLE_ID}/fields`, body);
  }
}

async function main() {
  const apply = process.argv.includes('--apply-test-fields');
  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();
  const tables = await api.listTables();
  const table = tables.find((item) => item.table_id === TEST_TABLE_ID);
  if (!table || table.name !== TEST_TABLE_NAME) {
    throw new Error(`Authorized test table mismatch: ${table?.name ?? '<missing>'}`);
  }
  const [fieldsBefore, recordCountBefore] = await Promise.all([
    api.listFields(),
    api.getRecordCount(),
  ]);
  if (recordCountBefore !== 0) {
    throw new Error(`Authorized test table must be empty before preparation; received ${recordCountBefore} records`);
  }
  const plan = buildTestTableFieldPlan(fieldsBefore, { batchId: BATCH_ID });
  if (!apply) {
    console.log(JSON.stringify({
      mode: 'DRY_RUN',
      tableId: TEST_TABLE_ID,
      tableName: TEST_TABLE_NAME,
      recordCount: recordCountBefore,
      updates: plan.updates.map((item) => ({ name: item.fieldName, type: item.body.type })),
      creates: plan.creates.map((item) => ({ name: item.fieldName, type: item.body.type })),
      recordsWillBeWritten: false,
    }, null, 2));
    return;
  }
  const applied = await applyFieldPlan(api, plan);
  const [fieldsAfter, recordCountAfter] = await Promise.all([
    api.listFields(),
    api.getRecordCount(),
  ]);
  const receipt = verifyPreparedTestTable({ fields: fieldsAfter, recordCount: recordCountAfter });
  console.log(JSON.stringify({
    mode: 'APPLIED_AND_VERIFIED',
    tableId: TEST_TABLE_ID,
    tableName: TEST_TABLE_NAME,
    batchId: BATCH_ID,
    ...applied,
    ...receipt,
    recordsWritten: 0,
    aiRunsTriggered: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
