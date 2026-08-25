#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBaseUrl } from '../skills/xws-to-feishu-base/scripts/import-core.mjs';
import {
  TABLE_DEFINITIONS,
  RELATION_DEFINITIONS,
  assertSchemaMutation,
  buildSchemaPlan,
  summarizeSchemaPlan,
} from './competitor-weekly-schema-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_OUTPUT_DIR = 'runtime/competitor-weekly-schema-migration';
const BIDIRECTIONAL_LINK = 21;

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
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

function parseArgs(argv) {
  const options = { apply: false, envFile: DEFAULT_ENV_FILE, outputDir: DEFAULT_OUTPUT_DIR };
  const values = new Set(['base-url', 'env-file', 'output-dir', 'confirm-app-token', 'confirm-main-table-id', 'expected-main-rows', 'expected-sku-rows']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') { options.apply = true; continue; }
    if (!values.has(arg.slice(2))) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    options[key] = value;
    index += 1;
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  const target = parseBaseUrl(options.baseUrl);
  options.appToken = target.appToken;
  options.mainTableId = target.tableId;
  if (options.apply) {
    for (const key of ['confirmAppToken', 'confirmMainTableId', 'expectedMainRows', 'expectedSkuRows']) {
      if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required with --apply`);
    }
    if (options.confirmAppToken !== options.appToken) throw new Error('--confirm-app-token mismatch');
    if (options.confirmMainTableId !== options.mainTableId) throw new Error('--confirm-main-table-id mismatch');
    options.expectedMainRows = Number(options.expectedMainRows);
    options.expectedSkuRows = Number(options.expectedSkuRows);
    if (!Number.isInteger(options.expectedMainRows) || options.expectedMainRows < 0) throw new Error('--expected-main-rows must be a non-negative integer');
    if (!Number.isInteger(options.expectedSkuRows) || options.expectedSkuRows < 0) throw new Error('--expected-sku-rows must be a non-negative integer');
  }
  return options;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret, appToken }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''}`.trim());
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, requestPath, body) {
    const response = await fetch(`${API_ROOT}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${requestPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    return payload.data ?? {};
  }

  async listTables() {
    const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?page_size=100`);
    return (data.items ?? []).map((table) => ({ tableId: table.table_id, name: table.name }));
  }

  async listFields(tableId) {
    const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`);
    return data.items ?? [];
  }

  async listRecordIds(tableId) {
    const ids = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      ids.push(...(data.items ?? []).map((record) => record.record_id));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return ids.sort();
  }

  async createTable(name, definitions) {
    const data = await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables`, {
      table: {
        name,
        default_view_name: '全部记录',
        fields: definitions.map((field) => ({
          field_name: field.name,
          type: field.type,
          ...(field.property ? { property: field.property } : {}),
        })),
      },
    });
    return data.table_id ?? data.table?.table_id;
  }

  async createField(tableId, definition) {
    return this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields`, {
      field_name: definition.name,
      type: definition.type,
      ...(definition.property ? { property: definition.property } : {}),
    });
  }
}

async function readState(api) {
  const tables = await api.listTables();
  const enriched = [];
  for (const table of tables) {
    const [fields, recordIds] = await Promise.all([api.listFields(table.tableId), api.listRecordIds(table.tableId)]);
    enriched.push({ ...table, fields, recordCount: recordIds.length, recordFingerprint: digest(recordIds) });
  }
  return enriched;
}

function tableMap(tables) {
  return new Map(tables.map((table) => [table.name, table]));
}

function relationBody(relation, tableIds) {
  return {
    name: relation.fieldName,
    type: BIDIRECTIONAL_LINK,
    property: { multiple: false, table_id: tableIds.get(relation.to), back_field_name: relation.backFieldName },
  };
}

function relationPlan(state) {
  const ids = tableMap(state);
  return RELATION_DEFINITIONS.filter((relation) => {
    const from = ids.get(relation.from);
    return from && !(from.fields ?? []).some((field) => field.field_name === relation.fieldName);
  }).map((relation) => ({ ...relation, fromTableId: ids.get(relation.from).tableId, body: relationBody(relation, new Map([...ids].map(([name, table]) => [name, table.tableId]))) }));
}

function summary(options, before, plan, relations) {
  return {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN',
    target: { appToken: options.appToken, mainTableId: options.mainTableId },
    existingTables: before.map((table) => ({ name: table.name, tableId: table.tableId, recordCount: table.recordCount })),
    protectedTables: before.filter((table) => ['竞品主表', 'SKU明细'].includes(table.name)).map((table) => ({ name: table.name, tableId: table.tableId, recordCount: table.recordCount, recordFingerprint: table.recordFingerprint })),
    ...summarizeSchemaPlan(plan),
    relationsToCreate: relations.map(({ from, fieldName, to, backFieldName }) => ({ from, fieldName, to, backFieldName })),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await api.authenticate();

  const before = await readState(api);
  const currentTable = before.find((table) => table.tableId === options.mainTableId);
  const skuTable = before.find((table) => table.name === 'SKU明细');
  if (!currentTable || currentTable.name !== '竞品主表') throw new Error(`Confirmed main table mismatch: ${options.mainTableId}`);
  if (!skuTable || (options.apply && skuTable.recordCount !== options.expectedSkuRows)) throw new Error(`SKU明细 record count mismatch: ${skuTable?.recordCount ?? 'missing'}`);
  if (options.apply && currentTable.recordCount !== options.expectedMainRows) throw new Error(`竞品主表 record count mismatch: ${currentTable.recordCount}`);

  const plan = buildSchemaPlan({ tables: before });
  const relations = relationPlan(before);
  const report = summary(options, before, plan, relations);
  fs.mkdirSync(path.resolve(options.outputDir), { recursive: true });
  const receiptPath = path.resolve(options.outputDir, `${new Date().toISOString().replace(/[-:.]/gu, '')}-${options.apply ? 'apply' : 'dry-run'}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!options.apply) {
    console.log(JSON.stringify({ ...report, receiptPath }, null, 2));
    return report;
  }

  const created = new Map();
  for (const table of plan.tablesToCreate) {
    assertSchemaMutation({ method: 'POST', path: `/bitable/v1/apps/${options.appToken}/tables`, body: { table: { name: table.name } } }, plan);
    created.set(table.name, await api.createTable(table.name, table.fields));
  }

  let state = await readState(api);
  const refreshedPlan = buildSchemaPlan({ tables: state });
  for (const item of refreshedPlan.fieldsToCreate) {
    const requestPath = `/bitable/v1/apps/${options.appToken}/tables/${item.tableId}/fields`;
    const body = { field_name: item.field.name };
    assertSchemaMutation({ method: 'POST', path: requestPath, body }, refreshedPlan);
    await api.createField(item.tableId, item.field);
  }

  state = await readState(api);
  const refreshedRelations = relationPlan(state);
  const ids = tableMap(state);
  for (const relation of refreshedRelations) {
    const body = relationBody(relation, new Map([...ids].map(([name, table]) => [name, table.tableId])));
    await api.createField(relation.fromTableId, body);
  }

  const after = await readState(api);
  const afterMain = after.find((table) => table.tableId === options.mainTableId);
  const afterSku = after.find((table) => table.name === 'SKU明细');
  if (afterMain.recordCount !== currentTable.recordCount || afterMain.recordFingerprint !== currentTable.recordFingerprint) throw new Error('竞品主表 records changed during schema provisioning');
  if (afterSku.recordCount !== skuTable.recordCount || afterSku.recordFingerprint !== skuTable.recordFingerprint) throw new Error('SKU明细 records changed during schema provisioning');
  const finalPlan = buildSchemaPlan({ tables: after });
  const finalRelations = relationPlan(after);
  if (finalPlan.tablesToCreate.length || finalPlan.fieldsToCreate.length || finalRelations.length) throw new Error('Schema provisioning did not settle to a no-op');

  const final = { ...report, mode: 'APPLIED_AND_VERIFIED', createdTables: [...created.entries()], secondDryRun: summarizeSchemaPlan(finalPlan), remainingRelations: finalRelations.length, receiptPath };
  fs.writeFileSync(receiptPath, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(final, null, 2));
  return final;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
