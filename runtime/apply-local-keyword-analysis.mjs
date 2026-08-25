#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TARGET_FIELDS,
  assertLocalAnalysisMutation,
  buildLocalAnalysisPlan,
  partitionPlanByFieldTypes,
  verifyLocalAnalysisApply,
} from './local-keyword-analysis.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    replaceUserIntent: false,
    expectedRows: 267,
    outputDir: 'runtime/local-analysis-runs',
  };
  const values = new Set([
    'app-token', 'table-id', 'table-name', 'env-file', 'expected-rows', 'output-dir',
    'confirm-base', 'confirm-table',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply' || name === 'replace-user-intent') {
      options[optionKey(name)] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  const missing = ['appToken', 'tableId', 'tableName', 'envFile'].filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
  options.expectedRows = Number(options.expectedRows);
  if (!Number.isInteger(options.expectedRows) || options.expectedRows < 1) {
    throw new Error('--expected-rows must be a positive integer');
  }
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error('Write mode requires matching --confirm-base <app-token>');
  }
  if (options.apply && options.confirmTable !== options.tableId) {
    throw new Error('Write mode requires matching --confirm-table <table-id>');
  }
  return options;
}

function requiredField(fields, name, type) {
  const matches = fields.filter((field) => field.field_name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} field; received ${matches.length}`);
  const allowed = Array.isArray(type) ? type : [type];
  if (!allowed.includes(matches[0].type)) {
    throw new Error(`${name} expected type ${allowed.join(' or ')}; received ${matches[0].type}`);
  }
  return matches[0];
}

function assertOptions(field, required) {
  const available = new Set((field.property?.options ?? []).map((option) => option.name));
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`${field.field_name} missing option: ${missing.join('、')}`);
}

export function validateFieldContract(fields, generated) {
  requiredField(fields, '原始关键词', [1, 20]);
  requiredField(fields, '标准归并词', [1, 25]);
  const classification = requiredField(fields, '关键词分类', 3);
  const labels = requiredField(fields, '细分标签', 4);
  const intent = requiredField(fields, '用户意图', 3);
  assertOptions(classification, generated.categories);
  assertOptions(labels, generated.labels);
  assertOptions(intent, generated.intents);
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

class FeishuApi {
  #token;

  constructor({ appId, appSecret, appToken, mutationGuard }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.mutationGuard = mutationGuard;
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

  async request(method, requestPath, body) {
    if (method !== 'GET') this.mutationGuard({ method, path: requestPath, body });
    const response = await fetch(`${API_ROOT}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${requestPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?page_size=100`)).items ?? [];
  }

  async listFields(tableId) {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`)).items ?? [];
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
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function summarizePlan(plan, records) {
  const generated = plan.updates.map((update) => update.fields);
  const distribution = (name) => Object.fromEntries([...generated.reduce((map, fields) => {
    const value = fields[name];
    if (value === undefined) return map;
    const key = Array.isArray(value) ? (value.length ? value.join('、') : '(空)') : value;
    map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map())].sort((left, right) => right[1] - left[1]));
  return {
    recordCount: records.length,
    recordsPlanned: plan.updates.length,
    fieldsPlanned: plan.updates.reduce((sum, update) => sum + Object.keys(update.fields).length, 0),
    preservedExisting: plan.preservedExisting,
    distributions: {
      关键词分类: distribution('关键词分类'),
      用户意图: distribution('用户意图'),
      细分标签: distribution('细分标签'),
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const scope = { appToken: options.appToken, tableId: options.tableId };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    mutationGuard: (request) => assertLocalAnalysisMutation(request, scope),
  });
  await api.authenticate();
  const [tables, fields, records] = await Promise.all([
    api.listTables(), api.listFields(options.tableId), api.listRecords(options.tableId),
  ]);
  const table = tables.find((item) => item.table_id === options.tableId);
  if (!table || table.name !== options.tableName) throw new Error(`Confirmed table identity mismatch: ${options.tableId}`);
  if (records.length !== options.expectedRows) {
    throw new Error(`Expected ${options.expectedRows} records; received ${records.length}`);
  }
  const plan = buildLocalAnalysisPlan(records, {
    replaceFields: options.replaceUserIntent ? ['用户意图'] : [],
  });
  const partitioned = partitionPlanByFieldTypes(plan, fields);
  const generated = {
    categories: [...new Set(plan.updates.map((item) => item.fields.关键词分类).filter(Boolean))],
    labels: [...new Set(plan.updates.flatMap((item) => item.fields.细分标签 ?? []))],
    intents: [...new Set(plan.updates.map((item) => item.fields.用户意图).filter(Boolean))],
  };
  validateFieldContract(fields, generated);

  const runDir = path.resolve(options.outputDir, `${stamp()}-${options.tableId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const before = { table, fields, records };
  const beforeFile = path.join(runDir, 'before.json');
  const planFile = path.join(runDir, 'plan.json');
  const frontendFile = path.join(runDir, 'standard-merge-values.tsv');
  fs.writeFileSync(beforeFile, `${JSON.stringify(before, null, 2)}\n`, 'utf8');
  fs.writeFileSync(planFile, `${JSON.stringify({
    summary: summarizePlan(plan, records),
    apiUpdates: partitioned.apiUpdates,
    frontendUpdates: partitioned.frontendUpdates,
  }, null, 2)}\n`, 'utf8');
  const frontendById = new Map(partitioned.frontendUpdates.map((update) => [update.record_id, update.fields.标准归并词]));
  fs.writeFileSync(frontendFile, `${records.map((record) => frontendById.get(record.record_id) ?? '').join('\n')}\n`, 'utf8');

  const summary = summarizePlan(plan, records);
  if (!options.apply) {
    console.log(JSON.stringify({
      status: 'DRY_RUN', ...summary,
      apiRecordsPlanned: partitioned.apiUpdates.length,
      frontendRecordsPlanned: partitioned.frontendUpdates.length,
      beforeFile, planFile, frontendFile,
    }, null, 2));
    return;
  }

  const derivedFields = fields.filter((field) => field.type === 20).map((field) => field.field_name);
  const canary = partitioned.apiUpdates.slice(0, 1);
  await api.batchUpdate(options.tableId, canary);
  const canaryRecords = await api.listRecords(options.tableId);
  const canaryFields = await api.listFields(options.tableId);
  if (digest(fields) !== digest(canaryFields)) throw new Error('Local analysis canary changed field definitions');
  verifyLocalAnalysisApply({ before: records, after: canaryRecords, updates: canary, derivedFields });

  await api.batchUpdate(options.tableId, partitioned.apiUpdates.slice(1));
  const afterRecords = await api.listRecords(options.tableId);
  const afterFields = await api.listFields(options.tableId);
  if (digest(fields) !== digest(afterFields)) throw new Error('Local analysis changed field definitions');
  const verification = verifyLocalAnalysisApply({
    before: records, after: afterRecords, updates: partitioned.apiUpdates, derivedFields,
  });
  const afterFile = path.join(runDir, 'after.json');
  const receiptFile = path.join(runDir, 'receipt.json');
  fs.writeFileSync(afterFile, `${JSON.stringify({ table, fields: afterFields, records: afterRecords }, null, 2)}\n`, 'utf8');
  const priorityDistribution = Object.fromEntries([...afterRecords.reduce((map, record) => {
    const value = String(record.fields?.优先级 ?? '(空)');
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map())]);
  const receipt = {
    status: partitioned.frontendUpdates.length ? 'API_APPLIED_FRONTEND_PENDING' : 'APPLIED_AND_VERIFIED',
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    beforeDigest: digest(before),
    afterDigest: digest({ table, fields: afterFields, records: afterRecords }),
    ...summary,
    ...verification,
    frontendRecordsPending: partitioned.frontendUpdates.length,
    priorityDistribution,
    beforeFile,
    planFile,
    frontendFile,
    afterFile,
  };
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...receipt, receiptFile }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
