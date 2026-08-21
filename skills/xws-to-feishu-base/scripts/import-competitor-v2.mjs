#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseBaseUrl } from './import-core.mjs';
import { runCompetitorV2 } from './competitor-v2-runner.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const ALLOWED_TABLES = new Set(['竞品主表', 'SKU明细', '问题库']);
const scriptDir = dirname(fileURLToPath(import.meta.url));

function positiveInteger(value, name) {
  if (!/^\d+$/u.test(String(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

export function parseCliArgs(argv) {
  const options = {
    apply: false,
    expectedRows: 1333,
    searchKeyword: '浴缸',
    uploadConcurrency: 3,
    recordBatchSize: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if ([
      '--xlsx', '--base-url', '--env-file', '--work-dir', '--search-keyword',
      '--expected-rows', '--upload-concurrency', '--record-batch-size', '--confirm-app-token', '--python',
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (key === 'expectedRows' || key === 'uploadConcurrency' || key === 'recordBatchSize') {
        options[key] = positiveInteger(value, arg);
      } else {
        options[key] = value;
      }
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.xlsx) throw new Error('--xlsx is required');
  if (!options.baseUrl) throw new Error('--base-url is required');
  const target = parseBaseUrl(options.baseUrl);
  if (options.apply && !options.envFile) throw new Error('--env-file is required with --apply');
  if (options.apply && !options.confirmAppToken) throw new Error('--confirm-app-token is required with --apply');
  if (options.confirmAppToken && options.confirmAppToken !== target.appToken) {
    throw new Error('--confirm-app-token does not match the Base URL app token');
  }
  return { ...options, target };
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
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

function extractManifest({ xlsx, outputDir, python }) {
  const script = resolve(scriptDir, 'extract_xws_xlsx.py');
  const command = python ?? (process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(python || process.platform !== 'win32' ? [] : ['-3']), script, xlsx, outputDir];
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`XLSX extraction failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

function normalizeTable(table) {
  return { tableId: table.table_id ?? table.tableId, name: table.name };
}

export class CompetitorV2FeishuClient {
  #token;

  constructor({ appId, appSecret, appToken, transport = fetch }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.transport = transport;
    this.mainTableId = null;
  }

  async authenticate() {
    const response = await this.transport(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
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
    if (!this.#token) throw new Error('Feishu client is not authenticated');
    const response = await this.transport(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    const items = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?${query}`);
      items.push(...(data.items ?? []).map(normalizeTable));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    const main = items.find((item) => item.name === '竞品主表');
    this.mainTableId = main?.tableId ?? this.mainTableId;
    return items;
  }

  async createTable(name, definitions) {
    if (!ALLOWED_TABLES.has(name)) throw new Error(`Blocked table creation: ${name}`);
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
    const id = data.table_id ?? data.table?.table_id;
    if (!id) throw new Error(`Feishu did not return a table id for ${name}`);
    if (name === '竞品主表') this.mainTableId = id;
    return id;
  }

  async listFields(tableId) {
    const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`);
    return (data.items ?? []).map((field) => ({
      fieldId: field.field_id,
      fieldName: field.field_name,
      type: field.type,
      property: field.property,
    }));
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []).map((record) => ({ recordId: record.record_id, fields: record.fields ?? {} })));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async uploadFile({ name, bytes }) {
    if (!this.mainTableId) throw new Error('Main table must be resolved before file upload');
    const form = new FormData();
    form.append('file_name', name);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', this.appToken);
    form.append('size', String(bytes.length));
    form.append('file', new Blob([bytes]), name);
    const data = await this.request('POST', '/drive/v1/medias/upload_all', form);
    if (!data.file_token) throw new Error(`Feishu did not return a file token for ${name}`);
    return data.file_token;
  }

  async batchCreateRecords(tableId, fieldsList) {
    if (tableId !== this.mainTableId) throw new Error('Blocked record write outside 竞品主表');
    if (fieldsList.length < 1 || fieldsList.length > 500) {
      throw new Error(`Batch size must be between 1 and 500; received ${fieldsList.length}`);
    }
    const data = await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_create`, {
      records: fieldsList.map((fields) => ({ fields })),
    });
    return (data.records ?? []).map((record) => record.record_id);
  }

  async deleteTable(tableId) {
    if (!tableId) throw new Error('tableId is required');
    await this.request('DELETE', `/bitable/v1/apps/${this.appToken}/tables/${tableId}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const xlsx = resolve(options.xlsx);
  if (!existsSync(xlsx)) throw new Error(`XLSX file not found: ${xlsx}`);
  const workDir = resolve(options.workDir ?? `runtime/competitor-v2-${basename(xlsx, '.xlsx')}`);
  const imageDir = resolve(workDir, 'images');
  await mkdir(workDir, { recursive: true });
  const manifest = extractManifest({ xlsx, outputDir: imageDir, python: options.python });

  let client;
  if (options.apply) {
    const envPath = resolve(options.envFile);
    if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
    const env = parseEnvFile(envPath);
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
      throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
    }
    client = new CompetitorV2FeishuClient({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      appToken: options.target.appToken,
    });
    await client.authenticate();
  }

  const result = await runCompetitorV2({
    manifest,
    client,
    apply: options.apply,
    searchKeyword: options.searchKeyword,
    expectedRows: options.expectedRows,
    uploadConcurrency: options.uploadConcurrency,
    recordBatchSize: options.recordBatchSize,
    onProgress: (progress) => {
      if (options.apply) console.error(JSON.stringify(progress));
    },
  });
  const report = {
    source: xlsx,
    target: options.baseUrl,
    workDir,
    mode: options.apply ? 'APPLIED_AND_VERIFIED' : 'DRY_RUN',
    ...result,
  };
  writeFileSync(resolve(workDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
