#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const ENV_FILE = 'E:/小红书/.env.local';
const BACKUP_DIR = path.resolve('evidence/keyword-base-cleanup');

export const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
export const DELETE_TARGETS = Object.freeze([
  Object.freeze({ tableId: 'tbltN7RA6oHQSkDJ', tableName: '关键词分析 V1（2026-08-14）', expectedRecords: 267 }),
  Object.freeze({ tableId: 'tblQfSWJauB9BiDK', tableName: '__公式验证_重点词优先级_20260813T013238Z', expectedRecords: 6 }),
  Object.freeze({ tableId: 'tblNeMEwv2MtmFw9', tableName: '__公式验证_重点词优先级_V2_20260813T081833Z', expectedRecords: 8 }),
  Object.freeze({ tableId: 'tble4VTa2BahzV2s', tableName: '__公式验证_两周实时联动_20260817T021901Z', expectedRecords: 5 }),
]);
export const PROTECTED_TABLES = Object.freeze([
  Object.freeze({ tableId: 'tblh1Rwt0LE68KXc', tableName: '关键词历史总表 V1', expectedRecords: 1167 }),
  Object.freeze({ tableId: 'tblXJSGLoHt5z8Jv', tableName: '关键词编号库 V1', expectedRecords: 429 }),
  Object.freeze({ tableId: 'tblfbhliKhI5uAEA', tableName: '关键词分析 V1（2026-08-26）', expectedRecords: 300 }),
  Object.freeze({ tableId: 'tblCswWXxEVGV20s', tableName: '关键词分析 V1（2026-08-15）', expectedRecords: 300 }),
  Object.freeze({ tableId: 'tblN1uT1LpzyqqWx', tableName: '关键词分析 V1（修正版）', expectedRecords: 301 }),
]);

function exactTable(tables, expected) {
  const table = tables.find((item) => item.table_id === expected.tableId);
  if (!table || table.name !== expected.tableName) {
    throw new Error(`Table identity mismatch for ${expected.tableId}: ${table?.name ?? '<missing>'}`);
  }
  if (table.recordCount !== expected.expectedRecords) {
    throw new Error(`Record count mismatch for ${expected.tableName}: expected ${expected.expectedRecords}, received ${table.recordCount}`);
  }
  return table;
}

export function buildCleanupPlan(tables) {
  for (const expected of [...DELETE_TARGETS, ...PROTECTED_TABLES]) exactTable(tables, expected);
  return { deletes: DELETE_TARGETS, protected: PROTECTED_TABLES };
}

export function assertApplyConfirmation({ appToken, tableIds }) {
  if (appToken !== APP_TOKEN) throw new Error('App confirmation does not match the keyword Base');
  const expected = DELETE_TARGETS.map((table) => table.tableId);
  if (JSON.stringify(tableIds) !== JSON.stringify(expected)) {
    throw new Error('Table confirmation must contain the complete ordered delete target set');
  }
}

export function assertCleanupMutation({ method, path: apiPath, body }) {
  const allowed = DELETE_TARGETS.some((target) =>
    method === 'DELETE' &&
    apiPath === `/bitable/v1/apps/${APP_TOKEN}/tables/${target.tableId}` &&
    body === undefined);
  if (!allowed) throw new Error(`Blocked unauthorized mutation: ${method} ${apiPath}`);
}

export function verifyCleanupResult(tables) {
  for (const expected of PROTECTED_TABLES) {
    const table = tables.find((item) => item.table_id === expected.tableId);
    if (!table) throw new Error(`Protected table missing: ${expected.tableName}`);
    exactTable(tables, expected);
  }
  for (const target of DELETE_TARGETS) {
    if (tables.some((item) => item.table_id === target.tableId)) {
      throw new Error(`Delete target still exists: ${target.tableName}`);
    }
  }
  return {
    deletedTableIds: DELETE_TARGETS.map((table) => table.tableId),
    protectedTables: PROTECTED_TABLES,
  };
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

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
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
    if (method !== 'GET') assertCleanupMutation({ method, path: apiPath, body });
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

  async listViews(tableId) {
    return (await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/views?page_size=100`)).items ?? [];
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

  async deleteTable(tableId) {
    return this.request('DELETE', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}`);
  }
}

async function snapshotTables(api, expectedTables, { includeDetails }) {
  const tables = await api.listTables();
  const snapshots = [];
  for (const expected of expectedTables) {
    const table = tables.find((item) => item.table_id === expected.tableId);
    if (!table || table.name !== expected.tableName) {
      throw new Error(`Table identity mismatch for ${expected.tableId}: ${table?.name ?? '<missing>'}`);
    }
    const records = await api.listRecords(expected.tableId);
    const snapshot = { ...table, recordCount: records.length };
    if (includeDetails) {
      const [fields, views] = await Promise.all([
        api.listFields(expected.tableId),
        api.listViews(expected.tableId),
      ]);
      Object.assign(snapshot, { fields, views, records });
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

function writeBackup(tables, mode) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    appToken: APP_TOKEN,
    purpose: 'keyword Base table cleanup rollback evidence',
    mode,
    deleteTargets: DELETE_TARGETS,
    tables,
  }, null, 2)}\n`;
  const backupPath = path.join(BACKUP_DIR, `keyword-base-cleanup-before-${stamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return {
    path: backupPath,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function argument(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmedIds = (argument('--confirm-tables') ?? '').split(',').filter(Boolean);
  if (apply) assertApplyConfirmation({
    appToken: argument('--confirm-app'),
    tableIds: confirmedIds,
  });

  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  await api.authenticate();

  const allExpected = [...DELETE_TARGETS, ...PROTECTED_TABLES];
  const before = await snapshotTables(api, allExpected, { includeDetails: false });
  const plan = buildCleanupPlan(before);
  const backupTables = await snapshotTables(api, DELETE_TARGETS, { includeDetails: true });
  buildCleanupPlan([...backupTables, ...before.filter((table) => PROTECTED_TABLES.some((item) => item.tableId === table.table_id))]);
  const backup = writeBackup(backupTables, apply ? 'APPLY' : 'DRY_RUN');

  if (!apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', appToken: APP_TOKEN, plan, backup }, null, 2));
    return;
  }

  for (const target of DELETE_TARGETS) {
    const current = await snapshotTables(api, [target], { includeDetails: false });
    exactTable(current, target);
    await api.deleteTable(target.tableId);
  }

  const remaining = await snapshotTables(api, PROTECTED_TABLES, { includeDetails: false });
  const allTablesAfter = await api.listTables();
  const verification = verifyCleanupResult([
    ...remaining,
    ...allTablesAfter
      .filter((table) => DELETE_TARGETS.some((target) => target.tableId === table.table_id))
      .map((table) => ({ ...table, recordCount: -1 })),
  ]);
  console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', backup, verification }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
