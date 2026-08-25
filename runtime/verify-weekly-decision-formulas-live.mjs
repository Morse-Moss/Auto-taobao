#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const PREFIX = '__公式验证_两周实时联动_';
const FORMULA_FIELDS = [
  '搜索热度', '交易热度',
  '近2周重点达标次数', '近2周A级达标次数', '近2周探索达标次数',
  '是否重点词', '优先级', '对应产品方向',
];

function same(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '').trim();
  return String(value).trim();
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function text(name) {
  return { field_name: name, type: 1 };
}

function number(name) {
  return { field_name: name, type: 2 };
}

export function buildValidationTableDefinition(name) {
  if (!name.startsWith(PREFIX)) throw new Error(`Validation table name must start with ${PREFIX}`);
  return {
    name,
    default_view_name: '全部记录',
    fields: [
      text('搜索词'),
      text('搜索人气'),
      text('支付转化率'),
      {
        field_name: '关键词分类',
        type: 3,
        property: { options: ['品牌词', '场景词', '痛点词'].map((option) => ({ name: option })) },
      },
      {
        field_name: '细分标签',
        type: 4,
        property: { options: ['场景/家用', '痛点/清洁'].map((option) => ({ name: option })) },
      },
      text('搜索热度'),
      text('内容热度'),
      text('交易热度'),
      number('上一有效周重点达标'),
      number('上一有效周A级达标'),
      number('上一有效周探索达标'),
      number('近2周重点达标次数'),
      number('近2周A级达标次数'),
      number('近2周探索达标次数'),
      number('灰豚话题浏览量'),
      text('是否重点词'),
      text('优先级'),
      text('对应产品方向'),
    ],
  };
}

export function buildValidationRows() {
  const base = {
    关键词分类: '场景词',
    细分标签: ['场景/家用'],
    上一有效周重点达标: 0,
    上一有效周A级达标: 0,
    上一有效周探索达标: 0,
    灰豚话题浏览量: 0,
  };
  return [
    {
      fields: {
        ...base,
        搜索词: '__验证_主推联动',
        搜索人气: '1200 ~ 2500',
        支付转化率: '2.5% ~ 5%',
        内容热度: '低',
        上一有效周重点达标: 1,
      },
      expected: {
        搜索热度: '高', 交易热度: '中', 近2周重点达标次数: '2',
        近2周A级达标次数: '0', 近2周探索达标次数: '0',
        是否重点词: '是', 优先级: 'B-持续观察', 对应产品方向: '主推方向（已有优势放大）',
      },
    },
    {
      fields: {
        ...base,
        搜索词: '__验证_A候选联动',
        搜索人气: '600 ~ 1200',
        支付转化率: '5% ~ 7.5%',
        内容热度: '高',
        上一有效周A级达标: 1,
        灰豚话题浏览量: null,
      },
      expected: {
        搜索热度: '中', 交易热度: '高', 近2周重点达标次数: '0',
        近2周A级达标次数: '', 近2周探索达标次数: '1',
        是否重点词: '否', 优先级: 'A候选', 对应产品方向: '暂无',
      },
    },
    {
      fields: {
        ...base,
        搜索词: '__验证_探索联动',
        搜索人气: '600 ~ 1200',
        支付转化率: '0% ~ 1%',
        内容热度: '高',
        上一有效周探索达标: 1,
      },
      expected: {
        搜索热度: '中', 交易热度: '低', 近2周重点达标次数: '0',
        近2周A级达标次数: '0', 近2周探索达标次数: '2',
        是否重点词: '否', 优先级: 'C-常规跟踪', 对应产品方向: '探索方向（验证市场）',
      },
    },
    {
      fields: {
        ...base,
        搜索词: '__验证_品牌排除',
        搜索人气: '1200 ~ 2500',
        支付转化率: '5% ~ 7.5%',
        关键词分类: '品牌词',
        内容热度: '高',
        灰豚话题浏览量: 10_000_000,
      },
      expected: {
        搜索热度: '高', 交易热度: '高', 近2周重点达标次数: '0',
        近2周A级达标次数: '0', 近2周探索达标次数: '1',
        是否重点词: '否', 优先级: 'C-常规跟踪', 对应产品方向: '暂无',
      },
    },
    {
      fields: {
        ...base,
        搜索词: '__验证_缺历史证据',
        搜索人气: '1200 ~ 2500',
        支付转化率: '2.5% ~ 5%',
        内容热度: '',
        上一有效周重点达标: null,
        上一有效周A级达标: null,
        上一有效周探索达标: null,
        灰豚话题浏览量: null,
      },
      expected: {
        搜索热度: '高', 交易热度: '中', 近2周重点达标次数: '',
        近2周A级达标次数: '', 近2周探索达标次数: '',
        是否重点词: '待数据', 优先级: 'B-持续观察', 对应产品方向: '暂无',
      },
    },
  ];
}

export function verifyExpectedRows(records, expectedRows) {
  if (records.length !== expectedRows.length) {
    throw new Error(`Validation record count mismatch: expected ${expectedRows.length}, received ${records.length}`);
  }
  const bySearch = new Map(records.map((record) => [plain(record.fields?.搜索词), record]));
  for (const expectedRow of expectedRows) {
    const search = expectedRow.fields.搜索词;
    const actual = bySearch.get(search);
    if (!actual) throw new Error(`Validation outcome mismatch: missing ${search}`);
    for (const fieldName of FORMULA_FIELDS) {
      const value = plain(actual.fields?.[fieldName]);
      if (value.startsWith('#')) throw new Error(`Validation formula error: ${search}/${fieldName}/${value}`);
      const expected = plain(expectedRow.expected[fieldName]);
      if (value !== expected) {
        throw new Error(`Validation outcome mismatch: ${search}/${fieldName}, expected ${expected || '<empty>'}, received ${value || '<empty>'}`);
      }
    }
  }
  return { rowsVerified: expectedRows.length };
}

export function assertValidationMutation({ method, path: requestPath, body }, scope) {
  if (method === 'GET') return;
  const root = `/bitable/v1/apps/${scope.appToken}`;
  if (method === 'POST' && requestPath === `${root}/tables` && !scope.tableId &&
      same(body, { table: scope.definition })) return;
  if (method === 'POST' && requestPath === `${root}/tables/${scope.tableId}/records/batch_create` &&
      same(body, { records: scope.rows.map(({ fields }) => ({ fields })) })) return;
  if (method === 'POST' && requestPath === `${root}/tables/${scope.tableId}/records/batch_update`) {
    const records = body?.records ?? [];
    const allowedValues = new Map([
      ['搜索人气', new Set(['300 ~ 600', '1200 ~ 2500'])],
      ['灰豚话题浏览量', new Set([10_000_000, null])],
    ]);
    const allowed = records.length === 1 && records.every((record) => {
      if (!record.record_id || (scope.allowedRecordIds?.size && !scope.allowedRecordIds.has(record.record_id))) return false;
      const entries = Object.entries(record.fields ?? {});
      return entries.length === 1 && allowedValues.get(entries[0][0])?.has(entries[0][1]);
    });
    if (allowed) return;
  }
  throw new Error(`Blocked unauthorized validation mutation: ${method} ${requestPath}`);
}

function parseOptions(argv) {
  const options = {
    apply: false,
    envFile: 'E:/小红书/.env.local',
    backupDir: 'runtime/keyword-analysis-backups',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    const name = arg.slice(2);
    if (!['base-url', 'confirm-base', 'env-file', 'backup-dir'].includes(name)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (!options.baseUrl) throw new Error('Missing --base-url');
  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  if (!options.apply || options.confirmBase !== options.appToken) {
    throw new Error(`Live validation requires --apply --confirm-base ${options.appToken}`);
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
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret, appToken, scope }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.scope = scope;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, requestPath, body) {
    if (method !== 'GET') assertValidationMutation({ method, path: requestPath, body }, this.scope);
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
}

async function waitForExpected(api, tableId, expectedRows, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const records = await api.listRecords(tableId);
    try {
      return { records, verification: verifyExpectedRows(records, expectedRows) };
    } catch (error) {
      if (/formula error/iu.test(error.message)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError ?? new Error('Validation formulas did not settle');
}

function withExpected(rows, search, fields, expected) {
  return rows.map((row) => row.fields.搜索词 === search
    ? { fields: { ...row.fields, ...fields }, expected: { ...row.expected, ...expected } }
    : structuredClone(row));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const tableName = `${PREFIX}${stamp()}`;
  const definition = buildValidationTableDefinition(tableName);
  const rows = buildValidationRows();
  const scope = { appToken: options.appToken, tableId: null, tableName, definition, rows, allowedRecordIds: new Set() };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    scope,
  });
  await api.authenticate();
  if ((await api.listTables()).some((table) => table.name === tableName)) throw new Error(`Validation table already exists: ${tableName}`);
  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables`, { table: definition });
  const matches = (await api.listTables()).filter((table) => table.name === tableName);
  if (matches.length !== 1) throw new Error(`Unable to resolve validation table: ${tableName}`);
  scope.tableId = matches[0].table_id;
  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables/${scope.tableId}/records/batch_create`, {
    records: rows.map(({ fields }) => ({ fields })),
  });
  const seeded = await api.listRecords(scope.tableId);
  if (seeded.length !== rows.length) throw new Error(`Validation seed count mismatch: ${seeded.length}`);
  const idBySearch = new Map(seeded.map((record) => [plain(record.fields?.搜索词), record.record_id]));
  const mainId = idBySearch.get('__验证_主推联动');
  const candidateId = idBySearch.get('__验证_A候选联动');
  if (!mainId || !candidateId) throw new Error('Validation linkage rows are missing');
  scope.allowedRecordIds = new Set([mainId, candidateId]);

  const receiptDir = path.resolve(options.backupDir);
  fs.mkdirSync(receiptDir, { recursive: true });
  const formulaReceipt = path.join(receiptDir, `weekly-decision-formulas-validation-${stamp()}.json`);
  const applyScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'apply-weekly-decision-formulas.mjs');
  const child = spawnSync(process.execPath, [
    applyScript,
    '--base-url', options.baseUrl,
    '--table-id', scope.tableId,
    '--table-name', tableName,
    '--env-file', path.resolve(options.envFile),
    '--backup-dir', receiptDir,
    '--receipt-file', formulaReceipt,
    '--apply',
    '--confirm-base', options.appToken,
    '--confirm-table', scope.tableId,
  ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`Formula apply failed: ${(child.stderr || child.stdout).trim()}`);

  const initial = await waitForExpected(api, scope.tableId, rows);
  const fields = await api.listFields(scope.tableId);
  for (const fieldName of FORMULA_FIELDS) {
    const field = fields.find((item) => item.field_name === fieldName);
    if (field?.type !== 20 || !field.property?.formula_expression) {
      throw new Error(`Validation formula field is not active: ${fieldName}`);
    }
  }

  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables/${scope.tableId}/records/batch_update`, {
    records: [{ record_id: mainId, fields: { 搜索人气: '300 ~ 600' } }],
  });
  const mainChanged = withExpected(rows, '__验证_主推联动', { 搜索人气: '300 ~ 600' }, {
    搜索热度: '低', 近2周重点达标次数: '1', 近2周A级达标次数: '0',
    近2周探索达标次数: '0', 是否重点词: '否', 优先级: 'C-常规跟踪', 对应产品方向: '暂无',
  });
  const mainPropagation = await waitForExpected(api, scope.tableId, mainChanged);
  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables/${scope.tableId}/records/batch_update`, {
    records: [{ record_id: mainId, fields: { 搜索人气: '1200 ~ 2500' } }],
  });
  await waitForExpected(api, scope.tableId, rows);

  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables/${scope.tableId}/records/batch_update`, {
    records: [{ record_id: candidateId, fields: { 灰豚话题浏览量: 10_000_000 } }],
  });
  const candidateChanged = withExpected(rows, '__验证_A候选联动', { 灰豚话题浏览量: 10_000_000 }, {
    近2周A级达标次数: '2', 优先级: 'A-立即跟进', 对应产品方向: '增长方向（未来新品）',
  });
  const huitunPropagation = await waitForExpected(api, scope.tableId, candidateChanged);
  await api.request('POST', `/bitable/v1/apps/${options.appToken}/tables/${scope.tableId}/records/batch_update`, {
    records: [{ record_id: candidateId, fields: { 灰豚话题浏览量: null } }],
  });
  const restored = await waitForExpected(api, scope.tableId, rows);

  const receipt = {
    createdAt: new Date().toISOString(),
    appToken: options.appToken,
    tableId: scope.tableId,
    tableName,
    tableUrl: `${options.baseUrl}?table=${scope.tableId}`,
    formulaReceipt,
    formulaFieldCount: FORMULA_FIELDS.length,
    initial: initial.verification,
    searchInputPropagation: mainPropagation.verification,
    huitunInputPropagation: huitunPropagation.verification,
    restored: restored.verification,
    finalRecordCount: restored.records.length,
  };
  const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptFile = path.join(receiptDir, `weekly-decision-live-verification-${stamp()}.json`);
  fs.writeFileSync(receiptFile, receiptContent, { encoding: 'utf8', flag: 'wx' });
  receipt.receiptFile = receiptFile;
  receipt.receiptSha256 = crypto.createHash('sha256').update(receiptContent).digest('hex');
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
