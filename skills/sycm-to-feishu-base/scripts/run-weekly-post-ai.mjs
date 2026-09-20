#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDigest, validatePublishPlan, validatePublishReadback } from '../../../runtime/weekly-local-analysis.mjs';
import { activeProfileName, envFilePath } from '../../../runtime/feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

// 默认凭据文件跟着租户登记表走，不要写死。
// 写死旧租户路径（E:/小红书/.env.local）会拿旧租户的 token 去读新租户的 base，
// 得到 91403 Forbidden —— 看起来像「应用没被加为协作者」的假故障。
export function parseOptions(argv, dependencies = {}) {
  const options = { apply: false, envFile: envFilePath(activeProfileName()) };
  const values = new Set(['publish-artifact', 'pre-ai-manifest', 'env-file', 'receipt-file', 'confirm-base', 'confirm-current-table', 'confirm-history-table', 'confirm-library-table']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply') {
      options.apply = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  if (!options.publishArtifact) {
    if (options.preAiManifest) throw new Error('--pre-ai-manifest is obsolete; provide --publish-artifact from a PUBLISH_READY artifact');
    throw new Error('Required: --publish-artifact');
  }
  options.publishArtifact = path.resolve(options.publishArtifact);
  const readArtifact = dependencies.readArtifact ?? ((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const artifact = readArtifact(options.publishArtifact);
  if (artifact?.status !== 'PUBLISH_READY' || !artifact.publishPlan) {
    throw new Error('Publish artifact must have status PUBLISH_READY and a publishPlan');
  }
  if (!artifact.evidence?.source || !artifact.evidence?.providerDigest || !artifact.evidence?.promptDigest) {
    throw new Error('Publish artifact evidence is incomplete');
  }
  options.artifact = artifact;
  options.appToken = artifact.publishPlan.appToken;
  const tables = artifact.publishPlan.tables;
  options.currentTableId = tables?.current?.tableId;
  options.historyTableId = tables?.history?.tableId;
  options.libraryTableId = tables?.library?.tableId;
  if (!options.appToken || !options.currentTableId || !options.historyTableId || !options.libraryTableId) throw new Error('Publish artifact target is incomplete');
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error(`--apply requires --confirm-base ${options.appToken}`);
  }
  if (options.apply && options.confirmCurrentTable !== options.currentTableId) {
    throw new Error(`--apply requires --confirm-current-table ${options.currentTableId}`);
  }
  if (options.apply && options.confirmHistoryTable !== options.historyTableId) {
    throw new Error(`--apply requires --confirm-history-table ${options.historyTableId}`);
  }
  if (options.apply && options.confirmLibraryTable !== options.libraryTableId) {
    throw new Error(`--apply requires --confirm-library-table ${options.libraryTableId}`);
  }
  return options;
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, requestPath, body) {
    const response = await fetch(`${API_ROOT}${requestPath}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${requestPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    return payload.data ?? {};
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async batchUpdate(tableId, records) {
    for (let index = 0; index < records.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_update`, {
        records: records.slice(index, index + 500),
      });
    }
  }

  async batchCreate(tableId, records) {
    for (let index = 0; index < records.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_create`, {
        records: records.slice(index, index + 500),
      });
    }
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function defaultReadTarget(options) {
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await api.authenticate();
  const [records, historyRecords, libraryRecords] = await Promise.all([
    api.listRecords(options.currentTableId),
    api.listRecords(options.historyTableId),
    api.listRecords(options.libraryTableId),
  ]);
  return { api, records, tables: { history: { records: historyRecords }, library: { records: libraryRecords } } };
}

function validateTableUpdates(plan, records) {
  const byId = new Map((records ?? []).map((record) => [record.record_id, record]));
  for (const update of plan.updates ?? []) {
    if (!byId.has(update.record_id)) throw new Error(`Publish record mismatch for ${update.record_id}`);
  }
}

function validateUpdateReadback(updates, records) {
  const byId = new Map((records ?? []).map((record) => [record.record_id, record]));
  for (const update of updates ?? []) {
    const record = byId.get(update.record_id);
    if (!record) throw new Error(`Publish record mismatch for ${update.record_id}`);
    for (const [name, value] of Object.entries(update.fields ?? {})) {
      if (JSON.stringify(record.fields?.[name]) !== JSON.stringify(value)) {
        throw new Error(`Publish value mismatch for ${update.record_id}:${name}`);
      }
    }
  }
}

function validatePlanDigest(publishPlan) {
  const withoutDigest = { ...publishPlan };
  delete withoutDigest.planDigest;
  if (publishPlan.planDigest !== canonicalDigest(withoutDigest)) throw new Error('Plan digest mismatch');
}

export async function runPostAiWorkflow(options, dependencies = {}) {
  const artifact = options.artifact ?? JSON.parse(fs.readFileSync(options.publishArtifact, 'utf8'));
  const readTarget = dependencies.readTarget ?? defaultReadTarget;
  const target = await readTarget(options, artifact);
  const publishPlan = artifact.publishPlan;
  const tables = publishPlan.tables;
  validatePlanDigest(publishPlan);
  const currentPlan = tables.current;
  const historyPlan = tables.history;
  const libraryPlan = tables.library;
  const current = { appToken: options.appToken, tableId: options.currentTableId, records: target.records ?? [] };
  validatePublishPlan(currentPlan, current);
  validateTableUpdates(historyPlan, target.tables?.history?.records ?? []);
  if (!options.apply) {
    return {
      status: 'PUBLISH_DRY_RUN_READY', artifact: options.publishArtifact, planDigest: publishPlan.planDigest,
      tables: {
        current: { updates: currentPlan.updates.length },
        history: { creates: (historyPlan.creates ?? []).length, updates: (historyPlan.updates ?? []).length },
        library: { creates: (libraryPlan.creates ?? []).length },
      },
    };
  }
  if (!target.api || typeof target.api.batchUpdate !== 'function') throw new Error('Publish target does not provide a batchUpdate client');
  if ((libraryPlan.creates ?? []).length > 0) {
    if (typeof target.api.batchCreate !== 'function') throw new Error('Publish target does not provide a batchCreate client');
    await target.api.batchCreate(options.libraryTableId, libraryPlan.creates);
  }
  await target.api.batchUpdate(options.currentTableId, currentPlan.updates);
  await target.api.batchUpdate(options.historyTableId, historyPlan.updates ?? []);
  const [afterCurrent, afterHistory, afterLibrary] = await Promise.all([
    target.api.listRecords(options.currentTableId),
    target.api.listRecords(options.historyTableId),
    target.api.listRecords(options.libraryTableId),
  ]);
  validatePublishPlan(currentPlan, { ...current, records: afterCurrent });
  validatePublishReadback(currentPlan, afterCurrent);
  validateUpdateReadback(historyPlan.updates, afterHistory);
  if ((libraryPlan.creates ?? []).length > 0 && afterLibrary.length < libraryPlan.creates.length) {
    throw new Error('Publish library readback mismatch');
  }
  const receipt = {
    status: 'PUBLISHED_AND_VERIFIED', appToken: options.appToken,
    tables: { current: { updates: currentPlan.updates.length }, history: { creates: historyPlan.creates.length, updates: historyPlan.updates.length }, library: { creates: libraryPlan.creates.length } },
    planDigest: publishPlan.planDigest, artifactDigest: artifact.artifactDigest,
    verifiedRecords: { current: afterCurrent.length, history: afterHistory.length, library: afterLibrary.length },
  };
  if (options.receiptFile) {
    const receiptFile = path.resolve(options.receiptFile);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    receipt.receiptFile = receiptFile;
  }
  return receipt;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify(await runPostAiWorkflow(options), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: error.code || 'FAILED', error: error.message }));
    process.exitCode = 1;
  });
}
