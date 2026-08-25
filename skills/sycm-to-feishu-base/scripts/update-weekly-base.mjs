#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyExportPair } from '../../sycm-export-search-rank/scripts/source-period-proof.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const RAW_FIELDS = ['排名', '搜索词', '搜索人气', '点击率', '支付转化率'];
const WEEKLY_WRITE_FIELDS = [...RAW_FIELDS, '关键词编号', '采集日期'];
const BATCH_VALIDITY_FIELD = '批次有效性';
const VALID_BATCH = '有效';
const INVALID_PERIOD_BATCH = '无效-周期错误';
const HISTORY_BASE_WRITE_FIELDS = [...WEEKLY_WRITE_FIELDS, '批次编号'];
const HISTORY_WRITE_FIELDS = [...HISTORY_BASE_WRITE_FIELDS, BATCH_VALIDITY_FIELD];
const LIBRARY_WRITE_FIELDS = ['唯一匹配键', '一级类目', '原始关键词', '规范化关键词'];
const WEEKLY_FORMULA_FIELDS = [
  '一级类目', '主关键词', '原始关键词', '来源渠道',
  '搜索热度', '交易热度', '是否重点词', '优先级',
];
const HISTORY_FORMULA_FIELDS = [
  '一级类目', '主关键词', '原始关键词', '来源渠道', '搜索热度', '交易热度',
];
const REQUIRED_WEEKLY_FIELDS = [
  ...WEEKLY_WRITE_FIELDS,
  '一级类目', '主关键词', '原始关键词', '标准归并词', '关键词分类', '细分标签',
  '用户意图', '来源渠道', '搜索热度', '内容热度', '交易热度',
  '是否重点词', '优先级', '对应产品方向',
  '近2周重点达标次数', '灰豚话题浏览量',
];
const REQUIRED_HISTORY_BASE_FIELDS = [
  ...HISTORY_BASE_WRITE_FIELDS,
  '一级类目', '主关键词', '原始关键词', '来源渠道', '搜索热度', '交易热度',
  '出现状态', '排名环比', '搜索人气环比', '交易环比', '综合趋势变化', '重点达标',
];
const REQUIRED_HISTORY_FIELDS = [...REQUIRED_HISTORY_BASE_FIELDS, BATCH_VALIDITY_FIELD];
const REQUIRED_LIBRARY_FIELDS = [...LIBRARY_WRITE_FIELDS, '关键词编号'];

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    category: '浴缸',
    envFile: 'E:/小红书/.env.local',
    backupDir: 'runtime/keyword-analysis-backups',
  };
  const values = new Set([
    'base-url', 'source-csv', 'weekly-table-id', 'weekly-table-name',
    'source-xlsx',
    'history-table-id', 'library-table-id', 'protected-table-id', 'protected-table-name',
    'collection-date', 'batch-number', 'expected-source-rows',
    'expected-history-before', 'category', 'env-file', 'backup-dir',
    'receipt-file', 'confirm-base', 'confirm-weekly-table',
    'invalidate-history-batch', 'expected-invalid-batch-rows',
  ]);
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
  const required = [
    'baseUrl', 'sourceCsv', 'sourceXlsx', 'weeklyTableId', 'weeklyTableName', 'historyTableId',
    'libraryTableId', 'protectedTableId', 'protectedTableName', 'collectionDate', 'batchNumber',
    'expectedSourceRows', 'expectedHistoryBefore',
  ];
  const missing = required.filter((name) => !options[name]);
  if (missing.length > 0) throw new Error(`Missing required options: ${missing.join(', ')}`);

  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  for (const name of ['batchNumber', 'expectedSourceRows', 'expectedHistoryBefore']) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) {
      throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer`);
    }
  }
  options.previousBatchNumber = options.batchNumber - 1;
  if (Boolean(options.invalidateHistoryBatch) !== Boolean(options.expectedInvalidBatchRows)) {
    throw new Error('--invalidate-history-batch and --expected-invalid-batch-rows must be supplied together');
  }
  for (const name of ['invalidateHistoryBatch', 'expectedInvalidBatchRows']) {
    if (options[name] === undefined) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) {
      throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer`);
    }
  }
  if (options.invalidateHistoryBatch && options.invalidateHistoryBatch >= options.batchNumber) {
    throw new Error('--invalidate-history-batch must be older than --batch-number');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.collectionDate) ||
      !Number.isFinite(Date.parse(`${options.collectionDate}T00:00:00+08:00`))) {
    throw new Error('--collection-date must be a valid YYYY-MM-DD date');
  }
  if (options.apply && !options.confirmBase) {
    throw new Error('Write mode requires --confirm-base <app-token>');
  }
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error('--confirm-base does not match the Base app token');
  }
  if (options.apply && !options.confirmWeeklyTable) {
    throw new Error('Write mode requires --confirm-weekly-table <table-id>');
  }
  if (options.apply && options.confirmWeeklyTable !== options.weeklyTableId) {
    throw new Error('--confirm-weekly-table does not match --weekly-table-id');
  }
  return options;
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('Source CSV has an unterminated quote');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

export function parseSourceCsv(csv) {
  const parsed = parseCsv(csv.replace(/^\uFEFF/u, ''));
  const headers = parsed.shift();
  if (JSON.stringify(headers) !== JSON.stringify(RAW_FIELDS)) {
    throw new Error(`Source CSV must contain exactly: ${RAW_FIELDS.join(',')}`);
  }
  if (parsed.length === 0) throw new Error('Source CSV contains no records');
  if (parsed.some((row) => row.length !== RAW_FIELDS.length)) {
    throw new Error('Source CSV contains a malformed row');
  }
  const records = parsed.map((row) => Object.fromEntries(RAW_FIELDS.map((name, index) => [name, row[index]])));
  const ranks = records.map((record) => Number(record.排名));
  if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1)) {
    throw new Error('Source ranks must be positive integers');
  }
  if (new Set(ranks).size !== ranks.length) throw new Error('Source ranks must be unique');
  if (ranks.some((rank, index) => rank !== index + 1)) {
    throw new Error('Source ranks must be contiguous from 1');
  }
  if (records.some((record) => RAW_FIELDS.some((name) => String(record[name] ?? '') === ''))) {
    throw new Error('Source fields must not be empty');
  }
  const keywords = records.map((record) => record.搜索词);
  if (new Set(keywords).size !== keywords.length) throw new Error('Source search terms must be unique');
  return records;
}

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.name ?? item?.value ?? String(item ?? '')).join('');
  }
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

export function assertWeeklyFieldContract(fields) {
  assertFieldContract(fields, REQUIRED_WEEKLY_FIELDS, 'Weekly table');
}

export function assertHistoryFieldContract(fields) {
  assertFieldContract(fields, REQUIRED_HISTORY_FIELDS, 'History table');
}

export function buildBatchValiditySchemaPlan(fields) {
  const matches = (fields ?? []).filter((field) => field.field_name === BATCH_VALIDITY_FIELD);
  if (matches.length > 1) throw new Error(`Expected at most one field named ${BATCH_VALIDITY_FIELD}`);
  if (matches.length === 1 && matches[0].type !== 1) {
    throw new Error(`${BATCH_VALIDITY_FIELD} expected text type 1; received ${matches[0].type}`);
  }
  return {
    creates: matches.length === 0
      ? [{ fieldName: BATCH_VALIDITY_FIELD, body: { field_name: BATCH_VALIDITY_FIELD, type: 1 } }]
      : [],
  };
}

export function planInvalidBatchUpdates(records, { invalidateHistoryBatch, expectedInvalidBatchRows } = {}) {
  if (!invalidateHistoryBatch) return [];
  const matches = records.filter((record) => Number(text(record.fields?.批次编号)) === Number(invalidateHistoryBatch));
  if (matches.length !== Number(expectedInvalidBatchRows)) {
    throw new Error(`Invalid batch ${invalidateHistoryBatch} expected ${expectedInvalidBatchRows} rows; received ${matches.length}`);
  }
  return matches.flatMap((record) => {
    const current = text(record.fields?.[BATCH_VALIDITY_FIELD]);
    if (!current) return [{ record_id: record.record_id, fields: { [BATCH_VALIDITY_FIELD]: INVALID_PERIOD_BATCH } }];
    if (current === INVALID_PERIOD_BATCH) return [];
    throw new Error(`Invalid batch ${invalidateHistoryBatch} has a conflicting ${BATCH_VALIDITY_FIELD}: ${current}`);
  });
}

export function assertCollectionDateAvailable(records, { batchNumber, collectionDate }) {
  const desiredDate = Date.parse(`${collectionDate}T00:00:00+08:00`);
  for (const record of records) {
    const rawDate = text(record.fields?.采集日期);
    if (!rawDate) continue;
    const date = Number(rawDate);
    if (!Number.isFinite(date)) throw new Error(`History contains an invalid collection date: ${rawDate}`);
    const batch = Number(text(record.fields?.批次编号));
    if (batch === Number(batchNumber) && date !== desiredDate) {
      throw new Error(`Batch ${batchNumber} already contains a different collection date`);
    }
    if (date === desiredDate && batch !== Number(batchNumber)) {
      throw new Error(`Collection date ${collectionDate} already belongs to batch ${Number.isInteger(batch) ? batch : '<blank>'}`);
    }
  }
}

export function normalizeKeyword(value) {
  return text(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function buildIdentityKey(category, keyword) {
  const normalizedCategory = normalizeKeyword(category);
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedCategory || !normalizedKeyword) throw new Error('Keyword identity requires a category and keyword');
  return `${normalizedCategory}\u001f${normalizedKeyword}`;
}

function indexLibrary(records) {
  const byIdentity = new Map();
  const numbers = new Set();
  for (const record of records) {
    const fields = record.fields ?? record;
    const identity = buildIdentityKey(fields.一级类目, fields.原始关键词);
    if (text(fields.唯一匹配键) !== identity) throw new Error(`Library identity mismatch: ${text(fields.唯一匹配键)}`);
    if (byIdentity.has(identity)) throw new Error(`Duplicate library identity: ${identity}`);
    const number = text(fields.关键词编号);
    if (number && !/^KW\d{6}$/u.test(number)) throw new Error(`Invalid keyword number: ${number}`);
    if (number && numbers.has(number)) throw new Error(`Duplicate keyword number: ${number}`);
    if (number) numbers.add(number);
    byIdentity.set(identity, record);
  }
  return byIdentity;
}

export function buildLibrarySeed(sourceRows, libraryRecords, category) {
  const existing = indexLibrary(libraryRecords);
  const desiredIdentities = new Set();
  const missing = [];
  for (const row of sourceRows) {
    const identity = buildIdentityKey(category, row.搜索词);
    if (desiredIdentities.has(identity)) throw new Error(`Duplicate source keyword identity: ${identity}`);
    desiredIdentities.add(identity);
    if (!existing.has(identity)) {
      missing.push({
        唯一匹配键: identity,
        一级类目: category,
        原始关键词: row.搜索词,
        规范化关键词: normalizeKeyword(row.搜索词),
      });
    }
  }
  return { missing, desiredIdentities };
}

function keywordNumberMap(libraryRecords) {
  const indexed = indexLibrary(libraryRecords);
  const mapping = new Map();
  for (const [identity, record] of indexed) {
    const number = text(record.fields?.关键词编号 ?? record.关键词编号);
    if (!/^KW\d{6}$/u.test(number)) throw new Error(`Keyword number has not settled for ${identity}`);
    mapping.set(identity, number);
  }
  return mapping;
}

export function buildBusinessRecords(sourceRows, mapping, { category, collectionDate, batchNumber }) {
  const date = Date.parse(`${collectionDate}T00:00:00+08:00`);
  const weekly = sourceRows.map((row) => {
    const keywordNumber = mapping.get(buildIdentityKey(category, row.搜索词));
    if (!keywordNumber) throw new Error(`Missing keyword number for ${row.搜索词}`);
    return {
      ...Object.fromEntries(RAW_FIELDS.map((name) => [name, row[name]])),
      关键词编号: keywordNumber,
      采集日期: date,
    };
  });
  return {
    weekly,
    history: weekly.map((record) => ({
      ...record,
      批次编号: batchNumber,
      [BATCH_VALIDITY_FIELD]: VALID_BATCH,
    })),
  };
}

function comparable(value) {
  if (value == null) return '';
  return String(value);
}

export function planExistingRecords(existingRecords, desiredFields, compareFields) {
  const desiredByRank = new Map(desiredFields.map((fields) => [text(fields.排名), fields]));
  const existingByRank = new Map();
  for (const record of existingRecords) {
    const rank = text(record.fields?.排名);
    if (!desiredByRank.has(rank)) throw new Error(`Existing table contains unexpected rank: ${rank || '<blank>'}`);
    if (existingByRank.has(rank)) throw new Error(`Existing table contains duplicate rank: ${rank}`);
    existingByRank.set(rank, record);
    const desired = desiredByRank.get(rank);
    for (const field of compareFields) {
      if (comparable(record.fields?.[field]) !== comparable(desired[field])) {
        throw new Error(`Existing rank ${rank} has a conflict in ${field}`);
      }
    }
  }
  return {
    create: desiredFields.filter((fields) => !existingByRank.has(text(fields.排名))),
    matchedCount: existingRecords.length,
  };
}

export function countHistoryBatches(records) {
  const counts = new Map();
  for (const record of records) {
    const value = text(record.fields?.批次编号);
    const batch = Number(value);
    if (!value || !Number.isInteger(batch) || batch < 1) {
      throw new Error(`History contains invalid batch: ${value || '<blank>'}`);
    }
    counts.set(batch, (counts.get(batch) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left - right));
}

export function planPreviousBatchUpdates(records, previousBatchNumber) {
  return records.flatMap((record) => {
    const value = text(record.fields?.批次编号);
    if (!value) {
      if (previousBatchNumber !== 1) {
        throw new Error('Previous history contains a blank batch after the initial migration');
      }
      return [{ record_id: record.record_id, fields: { 批次编号: previousBatchNumber } }];
    }
    const batch = Number(value);
    if (!Number.isInteger(batch) || batch < 1 || batch > previousBatchNumber) {
      throw new Error(`Previous history contains unexpected batch: ${value}`);
    }
    return [];
  });
}

function exactKeys(value, expected) {
  const keys = Object.keys(value ?? {}).sort();
  return JSON.stringify(keys) === JSON.stringify([...expected].sort());
}

export function assertAuthorizedMutation({ method, path: requestPath, body }, scope) {
  if (method === 'GET') return;
  const root = `/bitable/v1/apps/${scope.appToken}/tables`;
  if (scope.allowBatchValidityFieldCreate && method === 'POST' &&
      requestPath === `${root}/${scope.historyTableId}/fields` &&
      exactKeys(body, ['field_name', 'type']) &&
      body.field_name === BATCH_VALIDITY_FIELD && body.type === 1) return;
  const match = requestPath.match(new RegExp(`^${root}/([^/]+)/records/(batch_create|batch_update)$`, 'u'));
  if (method !== 'POST' || !match) throw new Error(`Blocked unauthorized mutation: ${method} ${requestPath}`);
  const [, tableId, operation] = match;
  const records = body?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > 500) {
    throw new Error(`Blocked unauthorized mutation: ${method} ${requestPath}`);
  }
  if (tableId === scope.libraryTableId && operation === 'batch_create' &&
      records.every((record) => exactKeys(record.fields, LIBRARY_WRITE_FIELDS))) return;
  if (tableId === scope.weeklyTableId && operation === 'batch_create' &&
      records.every((record) => exactKeys(record.fields, WEEKLY_WRITE_FIELDS))) return;
  if (tableId === scope.historyTableId && operation === 'batch_create' &&
      records.every((record) => exactKeys(record.fields, HISTORY_WRITE_FIELDS) &&
        Number(record.fields.批次编号) === Number(scope.currentBatchNumber ?? scope.previousBatchNumber + 1) &&
        record.fields[BATCH_VALIDITY_FIELD] === VALID_BATCH)) return;
  if (tableId === scope.historyTableId && operation === 'batch_update' &&
      records.every((record) => record.record_id && exactKeys(record.fields, ['批次编号']) &&
        Number(record.fields.批次编号) === Number(scope.previousBatchNumber))) return;
  if (tableId === scope.historyTableId && operation === 'batch_update' &&
      records.every((record) => record.record_id && scope.invalidBatchRecordIds?.has(record.record_id) &&
        exactKeys(record.fields, [BATCH_VALIDITY_FIELD]) &&
        record.fields[BATCH_VALIDITY_FIELD] === INVALID_PERIOD_BATCH)) return;
  throw new Error(`Blocked unauthorized mutation: ${method} ${requestPath}`);
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

  createField(tableId, body) {
    return this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields`, body);
  }

  async batchCreate(tableId, fieldsList) {
    if (fieldsList.length === 0) return;
    for (let index = 0; index < fieldsList.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_create`, {
        records: fieldsList.slice(index, index + 500).map((fields) => ({ fields })),
      });
    }
  }

  async batchUpdate(tableId, records) {
    if (records.length === 0) return;
    for (let index = 0; index < records.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_update`, {
        records: records.slice(index, index + 500),
      });
    }
  }
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

function recordsWithoutFields(records, fieldNames) {
  const ignored = new Set(fieldNames);
  return records.map((record) => ({
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {}).filter(([name]) => !ignored.has(name))),
  }));
}

function verifyPlannedFieldUpdates(before, after, updates, fieldName) {
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  const desiredById = new Map(updates.map((record) => [record.record_id, text(record.fields[fieldName])]));
  for (const record of before) {
    const next = afterById.get(record.record_id);
    if (!next) throw new Error(`History verification lost record ${record.record_id}`);
    const previous = text(record.fields?.[fieldName]);
    const current = text(next.fields?.[fieldName]);
    if (desiredById.has(record.record_id)) {
      if (current !== desiredById.get(record.record_id)) {
        throw new Error(`History verification failed for ${fieldName} on ${record.record_id}`);
      }
    } else if (current !== previous) {
      throw new Error(`History verification found an unplanned ${fieldName} change on ${record.record_id}`);
    }
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function writeBackup(options, snapshots) {
  const directory = path.resolve(options.backupDir);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `weekly-base-before-${timestamp()}.json`);
  const payload = {
    createdAt: new Date().toISOString(),
    purpose: 'weekly Base update before append',
    appToken: options.appToken,
    sourceCsv: path.resolve(options.sourceCsv),
    collectionDate: options.collectionDate,
    batchNumber: options.batchNumber,
    tables: snapshots,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { file, sha256: digest(payload) };
}

function assertTable(tables, id, expectedName) {
  const matches = tables.filter((table) => table.table_id === id);
  if (matches.length !== 1) throw new Error(`Expected one table ${id}; received ${matches.length}`);
  if (expectedName && matches[0].name !== expectedName) {
    throw new Error(`Table ${id} name mismatch: ${matches[0].name}`);
  }
  return matches[0];
}

function assertFieldContract(fields, requiredNames, label) {
  const names = fields.map((field) => field.field_name);
  const missing = requiredNames.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error(`${label} contains duplicate field names`);
}

async function awaitKeywordNumbers(api, tableId, sourceRows, category) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const records = await api.listRecords(tableId);
    try {
      const mapping = keywordNumberMap(records);
      if (sourceRows.every((row) => mapping.has(buildIdentityKey(category, row.搜索词)))) {
        return { records, mapping };
      }
    } catch {
      // Auto-number fields may take a short time to settle after record creation.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Keyword library auto-numbers did not settle');
}

async function awaitFormulaFields(api, tableId, names, expectedRows) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const records = await api.listRecords(tableId);
    if (records.length === expectedRows && records.every((record) => names.every((name) => {
      const value = text(record.fields?.[name]);
      return value && !value.startsWith('#');
    }))) return records;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Formula fields did not settle for ${tableId}`);
}

function verifyDesiredRecords(records, desired, compareFields, label) {
  const plan = planExistingRecords(records, desired, compareFields);
  if (plan.create.length !== 0 || plan.matchedCount !== desired.length) {
    throw new Error(`${label} verification count mismatch`);
  }
}

function snapshot(table, fields, records) {
  return { tableId: table.table_id, tableName: table.name, fields, records };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceProof = await verifyExportPair({
    csv: options.sourceCsv,
    xlsx: options.sourceXlsx,
    expectedEndDate: options.collectionDate,
  });
  const sourceRows = parseSourceCsv(fs.readFileSync(path.resolve(options.sourceCsv), 'utf8'));
  if (sourceRows.length !== options.expectedSourceRows) {
    throw new Error(`Source expected ${options.expectedSourceRows} rows; received ${sourceRows.length}`);
  }
  if (sourceProof.rowCount !== sourceRows.length) {
    throw new Error(`Source proof expected ${sourceProof.rowCount} rows; CSV contains ${sourceRows.length}`);
  }
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const scope = {
    appToken: options.appToken,
    weeklyTableId: options.weeklyTableId,
    historyTableId: options.historyTableId,
    libraryTableId: options.libraryTableId,
    previousBatchNumber: options.previousBatchNumber,
    currentBatchNumber: options.batchNumber,
    allowBatchValidityFieldCreate: false,
    invalidBatchRecordIds: new Set(),
  };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    mutationGuard: (request) => assertAuthorizedMutation(request, scope),
  });
  await api.authenticate();
  const tables = await api.listTables();
  const weeklyTable = assertTable(tables, options.weeklyTableId, options.weeklyTableName);
  const historyTable = assertTable(tables, options.historyTableId, '关键词历史总表 V1');
  const libraryTable = assertTable(tables, options.libraryTableId, '关键词编号库 V1');
  const protectedTable = assertTable(tables, options.protectedTableId, options.protectedTableName);
  const [weeklyFields, weeklyRecords, historyFields, historyRecords, libraryFields, libraryRecords, protectedFields, protectedRecords] = await Promise.all([
    api.listFields(weeklyTable.table_id), api.listRecords(weeklyTable.table_id),
    api.listFields(historyTable.table_id), api.listRecords(historyTable.table_id),
    api.listFields(libraryTable.table_id), api.listRecords(libraryTable.table_id),
    api.listFields(protectedTable.table_id), api.listRecords(protectedTable.table_id),
  ]);
  assertWeeklyFieldContract(weeklyFields);
  assertFieldContract(historyFields, REQUIRED_HISTORY_BASE_FIELDS, 'History table');
  const batchValiditySchemaPlan = buildBatchValiditySchemaPlan(historyFields);
  assertFieldContract(libraryFields, REQUIRED_LIBRARY_FIELDS, 'Keyword library');
  assertCollectionDateAvailable(historyRecords, options);
  const currentHistory = historyRecords.filter((record) => Number(text(record.fields?.批次编号)) === options.batchNumber);
  const previousHistory = historyRecords.filter((record) => Number(text(record.fields?.批次编号)) !== options.batchNumber);
  if (previousHistory.length !== options.expectedHistoryBefore) {
    throw new Error(`History expected ${options.expectedHistoryBefore} prior rows; received ${previousHistory.length}`);
  }
  const previousBatchUpdates = planPreviousBatchUpdates(previousHistory, options.previousBatchNumber);
  const invalidBatchUpdates = planInvalidBatchUpdates(previousHistory, options);
  scope.invalidBatchRecordIds = new Set(invalidBatchUpdates.map((record) => record.record_id));
  const librarySeed = buildLibrarySeed(sourceRows, libraryRecords, options.category);
  const summary = {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
    appToken: options.appToken,
    source: {
      csv: path.resolve(options.sourceCsv),
      xlsx: path.resolve(options.sourceXlsx),
      proof: sourceProof,
      rows: sourceRows.length,
      firstRank: sourceRows[0].排名,
      lastRank: sourceRows.at(-1).排名,
    },
    weekly: { tableId: weeklyTable.table_id, tableName: weeklyTable.name, existingRows: weeklyRecords.length },
    history: { tableId: historyTable.table_id, priorRows: previousHistory.length, currentBatchRows: currentHistory.length, expectedAfter: options.expectedHistoryBefore + sourceRows.length },
    keywordLibrary: { existingRows: libraryRecords.length, missingRows: librarySeed.missing.length },
    batch: {
      previous: options.previousBatchNumber,
      current: options.batchNumber,
      collectionDate: options.collectionDate,
      priorBlankCollectionDates: previousHistory.filter((record) => !text(record.fields?.采集日期)).length,
    },
    plannedPreviousBatchUpdates: previousBatchUpdates.length,
    batchValidity: {
      fieldsToCreate: batchValiditySchemaPlan.creates.length,
      invalidBatchNumber: options.invalidateHistoryBatch ?? null,
      invalidBatchRowsExpected: options.expectedInvalidBatchRows ?? 0,
      invalidRowsToMark: invalidBatchUpdates.length,
      blankLegacyRowsLeftUnverified: previousHistory.filter((record) =>
        !text(record.fields?.[BATCH_VALIDITY_FIELD]) &&
        Number(text(record.fields?.批次编号)) !== options.invalidateHistoryBatch).length,
    },
  };
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const protectedBeforeDigest = digest(snapshot(protectedTable, protectedFields, protectedRecords));
  const oldHistoryBeforeDigest = digest(recordsWithoutFields(previousHistory, ['批次编号', BATCH_VALIDITY_FIELD]));
  const oldLibraryBeforeDigest = digest(libraryRecords);
  const backup = writeBackup(options, [
    snapshot(protectedTable, protectedFields, protectedRecords),
    snapshot(historyTable, historyFields, historyRecords),
    snapshot(libraryTable, libraryFields, libraryRecords),
    snapshot(weeklyTable, weeklyFields, weeklyRecords),
  ]);

  scope.allowBatchValidityFieldCreate = batchValiditySchemaPlan.creates.length === 1;
  for (const create of batchValiditySchemaPlan.creates) await api.createField(historyTable.table_id, create.body);
  await api.batchCreate(libraryTable.table_id, librarySeed.missing);
  const settledLibrary = await awaitKeywordNumbers(api, libraryTable.table_id, sourceRows, options.category);
  const desired = buildBusinessRecords(sourceRows, settledLibrary.mapping, options);
  const weeklyPlan = planExistingRecords(weeklyRecords, desired.weekly, WEEKLY_WRITE_FIELDS);
  const historyPlan = planExistingRecords(currentHistory, desired.history, HISTORY_WRITE_FIELDS);
  await api.batchCreate(weeklyTable.table_id, weeklyPlan.create);
  await api.batchUpdate(historyTable.table_id, previousBatchUpdates);
  await api.batchUpdate(historyTable.table_id, invalidBatchUpdates);
  await api.batchCreate(historyTable.table_id, historyPlan.create);

  const [weeklyAfter, historyFieldsAfter, historyAfter, libraryAfter, protectedFieldsAfter, protectedRecordsAfter] = await Promise.all([
    awaitFormulaFields(api, weeklyTable.table_id, WEEKLY_FORMULA_FIELDS, sourceRows.length),
    api.listFields(historyTable.table_id),
    awaitFormulaFields(api, historyTable.table_id, HISTORY_FORMULA_FIELDS, options.expectedHistoryBefore + sourceRows.length),
    api.listRecords(libraryTable.table_id),
    api.listFields(protectedTable.table_id),
    api.listRecords(protectedTable.table_id),
  ]);
  const historyCurrentAfter = historyAfter.filter((record) => Number(text(record.fields?.批次编号)) === options.batchNumber);
  const historyPreviousAfter = historyAfter.filter((record) => Number(text(record.fields?.批次编号)) !== options.batchNumber);
  verifyDesiredRecords(weeklyAfter, desired.weekly, WEEKLY_WRITE_FIELDS, 'Weekly table');
  verifyDesiredRecords(historyCurrentAfter, desired.history, HISTORY_WRITE_FIELDS, 'History current batch');
  assertHistoryFieldContract(historyFieldsAfter);
  if (historyFieldsAfter.length !== historyFields.length + batchValiditySchemaPlan.creates.length) {
    throw new Error('History field count changed unexpectedly');
  }
  for (const field of historyFields) {
    const next = historyFieldsAfter.find((candidate) => candidate.field_id === field.field_id);
    if (!next || digest(next) !== digest(field)) throw new Error(`Existing history field changed: ${field.field_name}`);
  }
  if (historyPreviousAfter.length !== options.expectedHistoryBefore) throw new Error('Previous history batch count changed');
  if (digest(recordsWithoutFields(historyPreviousAfter, ['批次编号', BATCH_VALIDITY_FIELD])) !== oldHistoryBeforeDigest) {
    throw new Error('A previous-history business field changed');
  }
  verifyPlannedFieldUpdates(previousHistory, historyPreviousAfter, previousBatchUpdates, '批次编号');
  verifyPlannedFieldUpdates(previousHistory, historyPreviousAfter, invalidBatchUpdates, BATCH_VALIDITY_FIELD);
  if (digest(snapshot(protectedTable, protectedFieldsAfter, protectedRecordsAfter)) !== protectedBeforeDigest) {
    throw new Error('Protected previous-week analysis table changed');
  }
  const libraryAfterById = new Map(libraryAfter.map((record) => [record.record_id, record]));
  const oldLibraryAfter = libraryRecords.map((record) => libraryAfterById.get(record.record_id));
  if (oldLibraryAfter.some((record) => !record) || digest(oldLibraryAfter) !== oldLibraryBeforeDigest) {
    throw new Error('Existing keyword-library records changed');
  }
  const finalMapping = keywordNumberMap(libraryAfter);
  if (!sourceRows.every((row) => finalMapping.has(buildIdentityKey(options.category, row.搜索词)))) {
    throw new Error('Keyword library is missing a source identity after import');
  }
  if (buildBatchValiditySchemaPlan(historyFieldsAfter).creates.length ||
      planInvalidBatchUpdates(historyPreviousAfter, options).length) {
    throw new Error('Batch-validity correction is not idempotent');
  }
  const receipt = {
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    backup,
    writes: {
      libraryCreated: librarySeed.missing.length,
      weeklyCreated: weeklyPlan.create.length,
      previousHistoryBatchUpdated: previousBatchUpdates.length,
      invalidHistoryBatchMarked: invalidBatchUpdates.length,
      historyFieldsCreated: batchValiditySchemaPlan.creates.length,
      historyCreated: historyPlan.create.length,
    },
    verified: {
      weeklyRows: weeklyAfter.length,
      historyRows: historyAfter.length,
      historyBatchRows: countHistoryBatches(historyAfter),
      invalidBatchRows: historyAfter.filter((record) => text(record.fields?.[BATCH_VALIDITY_FIELD]) === INVALID_PERIOD_BATCH).length,
      validBatchRows: historyAfter.filter((record) => text(record.fields?.[BATCH_VALIDITY_FIELD]) === VALID_BATCH).length,
      unverifiedBatchRows: historyAfter.filter((record) => !text(record.fields?.[BATCH_VALIDITY_FIELD])).length,
      keywordLibraryRows: libraryAfter.length,
      protectedPreviousWeekUnchanged: true,
      priorCollectionDateInvented: false,
    },
  };
  if (options.receiptFile) {
    const receiptFile = path.resolve(options.receiptFile);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    receipt.receiptFile = receiptFile;
  }
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
