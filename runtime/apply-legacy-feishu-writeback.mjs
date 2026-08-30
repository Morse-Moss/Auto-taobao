#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLegacyWritebackPlan, readArtifact, WRITEBACK_FIELDS } from './legacy-feishu-writeback.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const DEFAULT_ARTIFACT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'weekly-runs/2026-08-29/local-legacy-prompt-analysis/2026-08-29-batch-5-batched/analysis-artifact.json');

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function parseOptions(argv) {
  const options = { envFile: 'E:/小红书/.env.local', artifact: DEFAULT_ARTIFACT, outputDir: 'runtime/weekly-runs/2026-08-29/local-writeback', expectedRows: 300, apply: false };
  const valueOptions = new Set(['app-token', 'table-id', 'table-name', 'env-file', 'artifact', 'output-dir', 'expected-rows', 'confirm-base', 'confirm-table']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') { options.apply = true; continue; }
    if (!arg.startsWith('--') || !valueOptions.has(arg.slice(2))) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ['appToken', 'tableId', 'tableName']) if (!options[key]) throw new Error(`Missing required option: --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  options.expectedRows = Number(options.expectedRows);
  if (!Number.isInteger(options.expectedRows) || options.expectedRows < 1) throw new Error('--expected-rows must be a positive integer');
  if (options.apply && (options.confirmBase !== options.appToken || options.confirmTable !== options.tableId)) throw new Error('Write mode requires matching --confirm-base and --confirm-table');
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

class FeishuApi {
  constructor({ appId, appSecret, appToken, scope }) { this.appId = appId; this.appSecret = appSecret; this.appToken = appToken; this.scope = scope; this.token = null; }
  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }) });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${payload.code ?? response.status}`);
    this.token = payload.tenant_access_token;
  }
  async request(method, requestPath, body) {
    if (method !== 'GET') {
      const expected = `/bitable/v1/apps/${this.scope.appToken}/tables/${this.scope.tableId}/records/batch_update`;
      if (method !== 'POST' || requestPath !== expected || !Array.isArray(body?.records) || body.records.length < 1 || body.records.length > 500 || body.records.some((record) => !record.record_id || Object.keys(record.fields ?? {}).some((name) => !WRITEBACK_FIELDS.includes(name)))) throw new Error(`Blocked unauthorized write: ${method} ${requestPath}`);
    }
    const response = await fetch(`${API_ROOT}${requestPath}`, { method, headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${requestPath} ${payload.code ?? response.status} ${payload.msg ?? ''}`.trim());
    return payload.data ?? {};
  }
  async listFields() { return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${this.scope.tableId}/fields?page_size=100`)).items ?? []; }
  async listRecords() {
    const records = []; let pageToken;
    do { const query = new URLSearchParams({ page_size: '500' }); if (pageToken) query.set('page_token', pageToken); const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${this.scope.tableId}/records?${query}`); records.push(...(data.items ?? [])); pageToken = data.has_more ? data.page_token : undefined; } while (pageToken);
    return records;
  }
  async listTables() { return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?page_size=100`)).items ?? []; }
  async batchUpdate(records) { for (let index = 0; index < records.length; index += 500) await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${this.scope.tableId}/records/batch_update`, { records: records.slice(index, index + 500) }); }
}

function verify({ before, after, updates }) {
  if (before.length !== after.length) throw new Error('Record count changed during writeback');
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  const updateById = new Map(updates.map((record) => [record.record_id, record.fields]));
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Missing record after writeback: ${prior.record_id}`);
    const planned = updateById.get(prior.record_id) ?? {};
    for (const [name, value] of Object.entries(planned)) {
      const actual = next.fields?.[name] ?? (Array.isArray(value) ? [] : '');
      if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(value))) throw new Error(`Writeback verification failed for ${name} on ${prior.record_id}`);
    }
    for (const name of WRITEBACK_FIELDS) {
      if (!(name in planned) && JSON.stringify(canonical(prior.fields?.[name])) !== JSON.stringify(canonical(next.fields?.[name]))) throw new Error(`Writeback overwrote existing ${name} on ${prior.record_id}`);
    }
  }
  return { recordsVerified: before.length, fieldsVerified: updates.reduce((sum, item) => sum + Object.keys(item.fields).length, 0) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const artifact = readArtifact(options.artifact);
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken, scope: options });
  await api.authenticate();
  const [tables, fields, records] = await Promise.all([api.listTables(), api.listFields(), api.listRecords()]);
  const table = tables.find((item) => item.table_id === options.tableId);
  if (!table || table.name !== options.tableName) throw new Error('Confirmed table identity mismatch');
  if (records.length !== options.expectedRows) throw new Error(`Expected ${options.expectedRows} records; received ${records.length}`);
  const plan = buildLegacyWritebackPlan({ artifact, records, fieldDefinitions: fields });
  const runDir = path.resolve(options.outputDir, `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${options.tableId}`);
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'before.json'), { table, fields, records });
  writeJson(path.join(runDir, 'plan.json'), plan);
  writeJson(path.join(runDir, 'unmapped-labels.json'), plan.unmappedLabels);
  const summary = { status: options.apply ? 'PENDING_APPLY' : 'DRY_RUN', tableId: options.tableId, tableName: options.tableName, recordCount: records.length, recordsPlanned: plan.updates.length, fieldsPlanned: plan.updates.reduce((sum, update) => sum + Object.keys(update.fields).length, 0), preservedExisting: plan.preservedExisting, unmappedLabelCount: plan.unmappedLabelCount, writableFields: WRITEBACK_FIELDS, beforeDigest: digest({ table, fields, records }), runDir };
  if (!options.apply) { console.log(JSON.stringify(summary, null, 2)); return; }
  const canary = plan.updates.slice(0, 1);
  if (canary.length) { await api.batchUpdate(canary); const afterCanary = await api.listRecords(); verify({ before: records, after: afterCanary, updates: canary }); }
  await api.batchUpdate(plan.updates.slice(1));
  const after = await api.listRecords();
  const verification = verify({ before: records, after, updates: plan.updates });
  writeJson(path.join(runDir, 'after.json'), { table, fields: await api.listFields(), records: after });
  const receipt = { ...summary, status: 'APPLIED_AND_VERIFIED', afterDigest: digest({ table, fields: await api.listFields(), records: after }), ...verification, unmappedLabelAudit: path.join(runDir, 'unmapped-labels.json') };
  writeJson(path.join(runDir, 'receipt.json'), receipt);
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
