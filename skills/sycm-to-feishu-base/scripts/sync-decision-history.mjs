#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const SNAPSHOT_FIELDS = [
  { snapshot: '重点达标', recent: '近2周重点达标次数' },
  { snapshot: 'A级达标', recent: '近2周A级达标次数' },
  { snapshot: '探索达标', recent: '近2周探索达标次数' },
];
const SNAPSHOT_FIELD_NAMES = SNAPSHOT_FIELDS.map((item) => item.snapshot);
const RECENT_FIELD_NAMES = SNAPSHOT_FIELDS.map((item) => item.recent);
const BATCH_VALIDITY_FIELD = '批次有效性';
const VALID_BATCH = '有效';
const INVALID_PERIOD_BATCH = '无效-周期错误';
const SERVICE_LABELS = new Set(['痛点/清洁', '痛点/漏水', '痛点/排水', '痛点/维修']);
const CURRENT_REQUIRED_FIELDS = [
  '关键词编号', '关键词分类', '细分标签', '搜索热度', '内容热度', '交易热度', '优先级',
  ...RECENT_FIELD_NAMES,
];
const HISTORY_REQUIRED_FIELDS = ['关键词编号', '批次编号', BATCH_VALIDITY_FIELD];

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    recalculateExistingSnapshots: false,
    envFile: 'E:/小红书/.env.local',
    backupDir: 'runtime/keyword-analysis-backups',
  };
  const values = new Set([
    'base-url', 'current-table-id', 'current-table-name', 'previous-table-id', 'previous-table-name',
    'history-table-id', 'history-table-name', 'current-batch-number', 'expected-current-rows',
    'expected-history-rows', 'env-file', 'backup-dir', 'receipt-file', 'confirm-base',
    'confirm-current-table', 'confirm-history-table', 'verify-history-batch',
    'expected-verified-batch-rows',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply' || name === 'recalculate-existing-snapshots') {
      options[optionKey(name)] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }

  const required = [
    'baseUrl', 'currentTableId', 'currentTableName', 'historyTableId', 'historyTableName',
    'currentBatchNumber', 'expectedCurrentRows', 'expectedHistoryRows',
  ];
  const missing = required.filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
  if (Boolean(options.previousTableId) !== Boolean(options.previousTableName)) {
    throw new Error('--previous-table-id and --previous-table-name must be supplied together');
  }
  if (Boolean(options.verifyHistoryBatch) !== Boolean(options.expectedVerifiedBatchRows)) {
    throw new Error('--verify-history-batch and --expected-verified-batch-rows must be supplied together');
  }
  if (options.verifyHistoryBatch && !options.previousTableId) {
    throw new Error('--verify-history-batch requires the previous analysis table');
  }

  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  for (const name of ['currentBatchNumber', 'expectedCurrentRows', 'expectedHistoryRows', 'verifyHistoryBatch', 'expectedVerifiedBatchRows']) {
    if (options[name] === undefined) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error(`--apply requires --confirm-base ${options.appToken}`);
  }
  if (options.apply && options.confirmCurrentTable !== options.currentTableId) {
    throw new Error(`--apply requires --confirm-current-table ${options.currentTableId}`);
  }
  if (options.apply && options.confirmHistoryTable !== options.historyTableId) {
    throw new Error(`--apply requires --confirm-history-table ${options.historyTableId}`);
  }
  return options;
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '').trim();
  return String(value).trim();
}

function labels(value) {
  if (Array.isArray(value)) return value.map(plain).filter(Boolean);
  return plain(value).split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
}

function keywordNumber(record, context) {
  const value = plain(record.fields?.关键词编号);
  if (!/^KW\d{6}$/u.test(value)) throw new Error(`${context} has an invalid keyword number: ${value || '<blank>'}`);
  return value;
}

function batchNumber(record) {
  const value = Number(plain(record.fields?.批次编号));
  if (!Number.isInteger(value) || value < 1) throw new Error(`History has an invalid batch number: ${plain(record.fields?.批次编号) || '<blank>'}`);
  return value;
}

export function classifyHistoryBatches(records) {
  const groups = new Map();
  for (const record of records) {
    const batch = batchNumber(record);
    const raw = plain(record.fields?.[BATCH_VALIDITY_FIELD]);
    if (raw && ![VALID_BATCH, INVALID_PERIOD_BATCH, '待核验'].includes(raw)) {
      throw new Error(`History batch ${batch} has an invalid ${BATCH_VALIDITY_FIELD}: ${raw}`);
    }
    const validity = raw || '待核验';
    const group = groups.get(batch) ?? { records: [], validity };
    if (group.validity !== validity) {
      throw new Error(`History batch ${batch} contains mixed ${BATCH_VALIDITY_FIELD} values`);
    }
    group.records.push(record);
    groups.set(batch, group);
  }
  const batchNumbers = [...groups.keys()].sort((left, right) => left - right);
  return {
    groups,
    validBatchNumbers: batchNumbers.filter((batch) => groups.get(batch).validity === VALID_BATCH),
    ignoredBatchNumbers: batchNumbers.filter((batch) => groups.get(batch).validity !== VALID_BATCH),
  };
}

function existingNumber(record, fieldName) {
  const raw = plain(record.fields?.[fieldName]);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${fieldName} contains a non-integer value: ${raw}`);
  return value;
}

function indexRecords(records, context) {
  const indexed = new Map();
  for (const record of records) {
    const number = keywordNumber(record, context);
    if (indexed.has(number)) throw new Error(`${context} contains duplicate keyword number ${number}`);
    indexed.set(number, record);
  }
  return indexed;
}

function indexAnalysisRecords(records, context) {
  const meaningful = records.filter((record) => {
    const fields = record.fields ?? {};
    return ['关键词编号', '排名', '搜索词', '原始关键词'].some((name) => plain(fields[name]));
  });
  return indexRecords(meaningful, context);
}

export function planVerifiedBatchPromotion({
  historyRecords,
  previousRecords,
  verifyHistoryBatch,
  expectedVerifiedBatchRows,
}) {
  if (!verifyHistoryBatch) return { batchNumber: null, keywordCount: 0, updates: [] };
  const batch = Number(verifyHistoryBatch);
  const expectedRows = Number(expectedVerifiedBatchRows);
  const matches = (historyRecords ?? []).filter((record) => batchNumber(record) === batch);
  if (matches.length !== expectedRows) {
    throw new Error(`Verified history batch ${batch} expected ${expectedRows} rows; received ${matches.length}`);
  }
  const historyIndex = indexRecords(matches, `History batch ${batch}`);
  const previousIndex = indexAnalysisRecords(previousRecords ?? [], 'Previous analysis table');
  if (!sameSet(previousIndex, historyIndex)) {
    throw new Error(`Previous analysis table keyword set does not match history batch ${batch}`);
  }
  const validity = new Set(matches.map((record) => plain(record.fields?.[BATCH_VALIDITY_FIELD])));
  if (validity.size === 1 && validity.has(VALID_BATCH)) {
    return { batchNumber: batch, keywordCount: historyIndex.size, updates: [] };
  }
  if (validity.size !== 1 || !validity.has('')) {
    throw new Error(`Verified history batch ${batch} has a conflicting ${BATCH_VALIDITY_FIELD}`);
  }
  return {
    batchNumber: batch,
    keywordCount: historyIndex.size,
    updates: matches.map((record) => ({
      record_id: record.record_id,
      fields: { [BATCH_VALIDITY_FIELD]: VALID_BATCH },
    })),
  };
}

function withVerifiedBatchPromotion(records, promotionPlan) {
  if (!promotionPlan?.updates?.length) return records;
  const ids = new Set(promotionPlan.updates.map((record) => record.record_id));
  return records.map((record) => ids.has(record.record_id)
    ? { ...record, fields: { ...record.fields, [BATCH_VALIDITY_FIELD]: VALID_BATCH } }
    : record);
}

function keyWordTarget(fields) {
  const classification = plain(fields?.关键词分类);
  const detailLabels = labels(fields?.细分标签);
  if (!classification) return { value: null, reason: 'MISSING_KEYWORD_CLASSIFICATION' };
  if (classification === '品牌词' || detailLabels.some((label) => SERVICE_LABELS.has(label))) {
    return { value: 0, reason: 'EXCLUDED' };
  }
  if (classification === '痛点词' && detailLabels.length === 0) {
    return { value: null, reason: 'MISSING_SERVICE_LABEL_CHECK' };
  }

  const search = plain(fields?.搜索热度);
  const trade = plain(fields?.交易热度);
  if (!search || !trade) return { value: null, reason: 'MISSING_HEAT_INPUT' };
  if (search === '待核验' || trade === '待核验') return { value: null, reason: 'UNVERIFIED_HEAT_INPUT' };
  return {
    value: Number(search === '高' && ['中', '高'].includes(trade)),
    reason: 'COMPLETE',
  };
}

function priorityATarget(fields) {
  const priority = plain(fields?.优先级);
  if (!priority || priority === '待数据' || priority.startsWith('#')) {
    return { value: null, reason: 'MISSING_PRIORITY' };
  }
  if (!['A-立即跟进', 'A候选', 'B-持续观察', 'C-常规跟踪'].includes(priority)) {
    return { value: null, reason: 'UNVERIFIED_PRIORITY' };
  }
  return { value: Number(priority === 'A-立即跟进'), reason: 'COMPLETE' };
}

function exploreTarget(fields) {
  const search = plain(fields?.搜索热度);
  const content = plain(fields?.内容热度);
  if (!search || !content) return { value: null, reason: 'MISSING_SEARCH_OR_CONTENT_HEAT' };
  if (search === '待核验' || content === '待核验') {
    return { value: null, reason: 'UNVERIFIED_SEARCH_OR_CONTENT_HEAT' };
  }
  return {
    value: Number(['中', '高'].includes(search) && ['中', '高'].includes(content)),
    reason: 'COMPLETE',
  };
}

function weeklyTargets(fields) {
  return {
    重点达标: keyWordTarget(fields),
    A级达标: priorityATarget(fields),
    探索达标: exploreTarget(fields),
  };
}

function planWrite(record, fieldName, desired, maximum, context, allowCorrection = false) {
  const current = existingNumber(record, fieldName);
  if (current !== null && (current < 0 || current > maximum)) {
    throw new Error(`${context} has an invalid ${fieldName}: ${current}`);
  }
  if (current !== null && current !== desired && !allowCorrection) {
    throw new Error(`${context} has a ${fieldName} conflict: existing ${current}, desired ${desired}`);
  }
  return current === desired ? null : desired;
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  return [...left.keys()].every((key) => right.has(key));
}

export function buildDecisionHistoryPlan({
  batchTables,
  historyRecords,
  currentBatchNumber,
  recalculateExistingSnapshots = false,
}) {
  if (!Array.isArray(batchTables) || !Array.isArray(historyRecords)) throw new Error('Batch tables and history records are required');
  const currentBatch = Number(currentBatchNumber);
  if (!Number.isInteger(currentBatch) || currentBatch < 1) throw new Error('Current batch number must be a positive integer');

  const classified = classifyHistoryBatches(historyRecords);
  const historyByBatch = new Map(classified.validBatchNumbers.map((batch) => [batch, classified.groups.get(batch).records]));
  const latestBatchNumbers = classified.validBatchNumbers.slice(-2);
  if (!historyByBatch.has(currentBatch)) {
    throw new Error(`Current batch ${currentBatch} is not verified as ${VALID_BATCH}`);
  }
  if (latestBatchNumbers.at(-1) !== currentBatch) {
    throw new Error(`Current batch ${currentBatch} is not the latest history batch`);
  }

  const tablesByBatch = new Map();
  for (const table of batchTables) {
    const batch = Number(table.batchNumber);
    if (!Number.isInteger(batch) || batch < 1) throw new Error(`Analysis table has an invalid batch number: ${table.batchNumber}`);
    if (tablesByBatch.has(batch)) throw new Error(`More than one analysis table was supplied for batch ${batch}`);
    tablesByBatch.set(batch, indexAnalysisRecords(table.records ?? [], `Batch ${batch} analysis table`));
  }
  if (!tablesByBatch.has(currentBatch)) throw new Error(`Missing current analysis table for batch ${currentBatch}`);

  const historyIndexes = new Map();
  for (const [batch, records] of historyByBatch) {
    historyIndexes.set(batch, indexRecords(records, `History batch ${batch}`));
  }

  const computedByBatch = new Map();
  const historyUpdates = [];
  const pendingHistory = [];
  for (const batch of latestBatchNumbers) {
    const historyIndex = historyIndexes.get(batch);
    const tableIndex = tablesByBatch.get(batch);
    if (tableIndex && !sameSet(tableIndex, historyIndex)) {
      throw new Error(`Batch ${batch} analysis table does not match its history keyword set`);
    }
    const computed = new Map();
    for (const [number, historyRecord] of historyIndex) {
      const source = tableIndex?.get(number);
      const values = {};
      const fieldsToWrite = {};
      if (source) {
        const results = weeklyTargets(source.fields);
        for (const { snapshot } of SNAPSHOT_FIELDS) {
          const result = results[snapshot];
          const existing = existingNumber(historyRecord, snapshot);
          if (result.value === null) {
            if (existing !== null) values[snapshot] = existing;
            else pendingHistory.push({
              recordId: historyRecord.record_id,
              batchNumber: batch,
              keywordNumber: number,
              fieldName: snapshot,
              reason: result.reason,
            });
            continue;
          }
          const desired = planWrite(
            historyRecord,
            snapshot,
            result.value,
            1,
            `History batch ${batch} keyword ${number}`,
            recalculateExistingSnapshots,
          );
          if (desired !== null) fieldsToWrite[snapshot] = desired;
          values[snapshot] = result.value;
        }
      } else {
        for (const { snapshot } of SNAPSHOT_FIELDS) {
          const existing = existingNumber(historyRecord, snapshot);
          if (existing !== null) values[snapshot] = existing;
          else pendingHistory.push({
            recordId: historyRecord.record_id,
            batchNumber: batch,
            keywordNumber: number,
            fieldName: snapshot,
            reason: 'MISSING_ANALYSIS_SNAPSHOT',
          });
        }
      }
      if (Object.keys(fieldsToWrite).length) {
        historyUpdates.push({ record_id: historyRecord.record_id, fields: fieldsToWrite });
      }
      computed.set(number, values);
    }
    computedByBatch.set(batch, computed);
  }

  const currentIndex = tablesByBatch.get(currentBatch);
  const currentUpdates = [];
  const pendingCurrent = [];
  for (const [number, record] of currentIndex) {
    const fieldsToWrite = {};
    for (const { snapshot, recent } of SNAPSHOT_FIELDS) {
      let desired = null;
      if (latestBatchNumbers.length < 2) {
        pendingCurrent.push({
          recordId: record.record_id,
          keywordNumber: number,
          fieldName: recent,
          reason: 'INSUFFICIENT_HISTORY',
        });
      } else {
        let pending = false;
        let count = 0;
        for (const batch of latestBatchNumbers) {
          const historyIndex = historyIndexes.get(batch);
          if (!historyIndex.has(number)) continue;
          const value = computedByBatch.get(batch).get(number)?.[snapshot];
          if (value === undefined) {
            pending = true;
            break;
          }
          count += value;
        }
        if (pending) {
          pendingCurrent.push({
            recordId: record.record_id,
            keywordNumber: number,
            fieldName: recent,
            reason: 'INCOMPLETE_TWO_WEEK_SNAPSHOT',
          });
        } else {
          desired = count;
        }
      }
      const existing = existingNumber(record, recent);
      if (desired === null) {
        if (existing !== null) fieldsToWrite[recent] = null;
      } else if (existing !== desired) {
        fieldsToWrite[recent] = desired;
      }
    }
    if (Object.keys(fieldsToWrite).length) {
      currentUpdates.push({ record_id: record.record_id, fields: fieldsToWrite });
    }
  }

  return {
    latestBatchNumbers,
    ignoredBatchNumbers: classified.ignoredBatchNumbers,
    historyUpdates,
    currentUpdates,
    pendingHistory,
    pendingCurrent,
  };
}

export function buildDecisionHistorySchemaPlan({ fields }) {
  const creates = [];
  for (const fieldName of SNAPSHOT_FIELD_NAMES) {
    const matches = (fields ?? []).filter((field) => field.field_name === fieldName);
    if (matches.length > 1) throw new Error(`Expected at most one field named ${fieldName}`);
    if (matches.length === 1 && matches[0].type !== 2) {
      throw new Error(`${fieldName} expected number type 2; received ${matches[0].type}`);
    }
    if (matches.length === 0) {
      creates.push({ fieldName, body: { field_name: fieldName, type: 2 } });
    }
  }
  return { creates };
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
}

export function assertDecisionHistoryMutation({ method, path, body }, scope) {
  if (method === 'GET') return;
  const root = `/bitable/v1/apps/${scope.appToken}/tables`;
  if (scope.allowHistoryFieldCreate && method === 'POST' && path === `${root}/${scope.historyTableId}/fields` &&
      exactKeys(body, ['field_name', 'type']) && SNAPSHOT_FIELD_NAMES.includes(body.field_name) && body.type === 2) return;

  const match = path.match(new RegExp(`^${root}/([^/]+)/records/batch_update$`, 'u'));
  const records = body?.records;
  if (method !== 'POST' || !match || !Array.isArray(records) || records.length === 0 || records.length > 500) {
    throw new Error(`Blocked unauthorized decision history mutation: ${method} ${path}`);
  }
  const tableId = match[1];
  if (tableId === scope.historyTableId && records.every((record) => {
    const entries = Object.entries(record.fields ?? {});
    return record.record_id && entries.length > 0 && entries.every(([name, value]) =>
      SNAPSHOT_FIELD_NAMES.includes(name) && [0, 1].includes(value));
  })) return;
  if (tableId === scope.historyTableId && records.every((record) =>
    record.record_id && scope.verifiedBatchRecordIds?.has(record.record_id) &&
    exactKeys(record.fields, [BATCH_VALIDITY_FIELD]) && record.fields[BATCH_VALIDITY_FIELD] === VALID_BATCH)) return;
  if (tableId === scope.currentTableId && records.every((record) => {
    const entries = Object.entries(record.fields ?? {});
    return record.record_id && entries.length > 0 && entries.every(([name, value]) =>
      RECENT_FIELD_NAMES.includes(name) && (value === null || (Number.isInteger(value) && value >= 0 && value <= 2)));
  })) return;
  throw new Error(`Blocked unauthorized decision history mutation: ${method} ${path}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalRecords(records, ignoredFields) {
  return [...records].map((record) => ({
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name]) => !ignoredFields.has(name))
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
  })).sort((left, right) => left.record_id.localeCompare(right.record_id));
}

function verifyDerivedRecords(before, after, updates, fieldName) {
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  const updatesById = new Map(updates
    .filter((record) => Object.hasOwn(record.fields ?? {}, fieldName))
    .map((record) => [record.record_id, record.fields[fieldName]]));
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Decision history verification lost record ${prior.record_id}`);
    if (updatesById.has(prior.record_id)) {
      if (existingNumber(next, fieldName) !== updatesById.get(prior.record_id)) {
        throw new Error(`Decision history verification failed for ${fieldName} on ${prior.record_id}`);
      }
    } else if (existingNumber(prior, fieldName) !== existingNumber(next, fieldName)) {
      throw new Error(`Decision history verification found an unplanned ${fieldName} change on ${prior.record_id}`);
    }
  }
}

export function verifyDecisionHistoryApply({ before, after, schemaPlan, plan, promotionPlan = { updates: [] } }) {
  if (!same(before.currentFields, after.currentFields)) throw new Error('Decision history changed current table field definitions');
  if (after.historyFields.length !== before.historyFields.length + schemaPlan.creates.length) {
    throw new Error('Decision history changed the history field count unexpectedly');
  }
  for (const field of before.historyFields) {
    const next = after.historyFields.find((candidate) => candidate.field_id === field.field_id);
    if (!next || !same(field, next)) throw new Error(`Decision history changed history field ${field.field_name}`);
  }
  const previousIds = new Set(before.historyFields.map((field) => field.field_id));
  const added = after.historyFields.filter((field) => !previousIds.has(field.field_id));
  if (added.length !== schemaPlan.creates.length || added.some((field, index) =>
    field.field_name !== schemaPlan.creates[index]?.fieldName || field.type !== schemaPlan.creates[index]?.body.type)) {
    throw new Error('Decision history created an unauthorized history field');
  }

  if (before.currentRecords.length !== after.currentRecords.length || before.historyRecords.length !== after.historyRecords.length) {
    throw new Error('Decision history changed a table record count');
  }
  if (!same(
    canonicalRecords(before.currentRecords, new Set([...RECENT_FIELD_NAMES, '是否重点词', '对应产品方向'])),
    canonicalRecords(after.currentRecords, new Set([...RECENT_FIELD_NAMES, '是否重点词', '对应产品方向'])),
  ) || !same(
    canonicalRecords(before.historyRecords, new Set([...SNAPSHOT_FIELD_NAMES, BATCH_VALIDITY_FIELD])),
    canonicalRecords(after.historyRecords, new Set([...SNAPSHOT_FIELD_NAMES, BATCH_VALIDITY_FIELD])),
  )) throw new Error('Decision history changed business data');

  for (const fieldName of SNAPSHOT_FIELD_NAMES) {
    verifyDerivedRecords(before.historyRecords, after.historyRecords, plan.historyUpdates, fieldName);
  }
  const validityAfter = new Map(after.historyRecords.map((record) => [record.record_id, plain(record.fields?.[BATCH_VALIDITY_FIELD])]));
  const promotedIds = new Set(promotionPlan.updates.map((record) => record.record_id));
  for (const record of before.historyRecords) {
    const expected = promotedIds.has(record.record_id) ? VALID_BATCH : plain(record.fields?.[BATCH_VALIDITY_FIELD]);
    if (validityAfter.get(record.record_id) !== expected) {
      throw new Error(`Decision history verification found an unplanned ${BATCH_VALIDITY_FIELD} change on ${record.record_id}`);
    }
  }
  for (const fieldName of RECENT_FIELD_NAMES) {
    verifyDerivedRecords(before.currentRecords, after.currentRecords, plan.currentUpdates, fieldName);
  }
  return {
    historyFieldsCreated: schemaPlan.creates.length,
    historyRecordsWritten: plan.historyUpdates.length,
    currentRecordsWritten: plan.currentUpdates.length,
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
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
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

  createField(tableId, body) {
    return this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields`, body);
  }

  async batchUpdate(tableId, records) {
    for (let index = 0; index < records.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_update`, {
        records: records.slice(index, index + 500),
      });
    }
  }
}

function assertTable(tables, tableId, expectedName) {
  const matches = tables.filter((table) => table.table_id === tableId);
  if (matches.length !== 1) throw new Error(`Expected one table ${tableId}; received ${matches.length}`);
  if (matches[0].name !== expectedName) throw new Error(`Table ${tableId} name mismatch: ${matches[0].name}`);
  return matches[0];
}

function assertFields(fields, names, label) {
  const present = fields.map((field) => field.field_name);
  const missing = names.filter((name) => !present.includes(name));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
  if (new Set(present).size !== present.length) throw new Error(`${label} contains duplicate field names`);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function writeBackup(options, snapshot) {
  const directory = path.resolve(options.backupDir);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `decision-history-before-${stamp()}.json`);
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: 'decision history helper update',
    appToken: options.appToken,
    currentTableId: options.currentTableId,
    historyTableId: options.historyTableId,
    snapshot,
  }, null, 2)}\n`;
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  return { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

function summaryFor(options, schemaPlan, plan) {
  return {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
    appToken: options.appToken,
    currentTable: { id: options.currentTableId, name: options.currentTableName, batchNumber: options.currentBatchNumber },
    historyTable: { id: options.historyTableId, name: options.historyTableName },
    latestBatchNumbers: plan.latestBatchNumbers,
    ignoredBatchNumbers: plan.ignoredBatchNumbers,
    planned: {
      historyFieldsToCreate: schemaPlan.creates.length,
      historyValidityToWrite: plan.promotionPlan?.updates.length ?? 0,
      historySnapshotsToWrite: plan.historyUpdates.length,
      currentCountsToWrite: plan.currentUpdates.length,
    },
    pending: {
      historySnapshots: plan.pendingHistory.length,
      currentCounts: plan.pendingCurrent.length,
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const scope = {
    appToken: options.appToken,
    currentTableId: options.currentTableId,
    historyTableId: options.historyTableId,
    allowHistoryFieldCreate: false,
    verifiedBatchRecordIds: new Set(),
  };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    mutationGuard: (request) => assertDecisionHistoryMutation(request, scope),
  });
  await api.authenticate();
  const tables = await api.listTables();
  assertTable(tables, options.currentTableId, options.currentTableName);
  assertTable(tables, options.historyTableId, options.historyTableName);
  if (options.previousTableId) assertTable(tables, options.previousTableId, options.previousTableName);

  const [currentFields, currentRecords, historyFields, historyRecords, previousFields, previousRecords] = await Promise.all([
    api.listFields(options.currentTableId),
    api.listRecords(options.currentTableId),
    api.listFields(options.historyTableId),
    api.listRecords(options.historyTableId),
    options.previousTableId ? api.listFields(options.previousTableId) : Promise.resolve([]),
    options.previousTableId ? api.listRecords(options.previousTableId) : Promise.resolve([]),
  ]);
  assertFields(currentFields, CURRENT_REQUIRED_FIELDS, 'Current table');
  assertFields(historyFields, HISTORY_REQUIRED_FIELDS, 'History table');
  if (options.previousTableId) assertFields(previousFields, CURRENT_REQUIRED_FIELDS, 'Previous table');
  if (currentRecords.length !== options.expectedCurrentRows) {
    throw new Error(`Current table expected ${options.expectedCurrentRows} rows; received ${currentRecords.length}`);
  }
  if (historyRecords.length !== options.expectedHistoryRows) {
    throw new Error(`History table expected ${options.expectedHistoryRows} rows; received ${historyRecords.length}`);
  }

  const promotionPlan = planVerifiedBatchPromotion({
    historyRecords,
    previousRecords,
    verifyHistoryBatch: options.verifyHistoryBatch,
    expectedVerifiedBatchRows: options.expectedVerifiedBatchRows,
  });
  const effectiveHistoryRecords = withVerifiedBatchPromotion(historyRecords, promotionPlan);
  const classifiedHistory = classifyHistoryBatches(effectiveHistoryRecords);
  const previousValidBatchNumber = classifiedHistory.validBatchNumbers
    .filter((batch) => batch < options.currentBatchNumber)
    .at(-1);
  const batchTables = [{ batchNumber: options.currentBatchNumber, records: currentRecords }];
  if (options.previousTableId) {
    if (!previousValidBatchNumber) throw new Error('A previous analysis table was supplied but no previous valid history batch exists');
    batchTables.unshift({ batchNumber: previousValidBatchNumber, records: previousRecords });
  }
  const schemaPlan = buildDecisionHistorySchemaPlan({ fields: historyFields });
  const plan = buildDecisionHistoryPlan({
    batchTables,
    historyRecords: effectiveHistoryRecords,
    currentBatchNumber: options.currentBatchNumber,
    recalculateExistingSnapshots: options.recalculateExistingSnapshots,
  });
  plan.promotionPlan = promotionPlan;
  const summary = summaryFor(options, schemaPlan, plan);
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const before = { currentFields, currentRecords, historyFields, historyRecords };
  const backup = writeBackup(options, before);
  scope.verifiedBatchRecordIds = new Set(promotionPlan.updates.map((record) => record.record_id));
  scope.allowHistoryFieldCreate = schemaPlan.creates.length > 0;
  for (const create of schemaPlan.creates) await api.createField(options.historyTableId, create.body);
  await api.batchUpdate(options.historyTableId, promotionPlan.updates);
  await api.batchUpdate(options.historyTableId, plan.historyUpdates);
  await api.batchUpdate(options.currentTableId, plan.currentUpdates);

  let after;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [nextCurrentFields, nextCurrentRecords, nextHistoryFields, nextHistoryRecords] = await Promise.all([
      api.listFields(options.currentTableId), api.listRecords(options.currentTableId),
      api.listFields(options.historyTableId), api.listRecords(options.historyTableId),
    ]);
    after = {
      currentFields: nextCurrentFields,
      currentRecords: nextCurrentRecords,
      historyFields: nextHistoryFields,
      historyRecords: nextHistoryRecords,
    };
    try {
      verifyDecisionHistoryApply({ before, after, schemaPlan, plan, promotionPlan });
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const verification = verifyDecisionHistoryApply({ before, after, schemaPlan, plan, promotionPlan });
  const settledPlan = buildDecisionHistoryPlan({
    batchTables: [
      ...(options.previousTableId ? [{ batchNumber: previousValidBatchNumber, records: previousRecords }] : []),
      { batchNumber: options.currentBatchNumber, records: after.currentRecords },
    ],
    historyRecords: after.historyRecords,
    currentBatchNumber: options.currentBatchNumber,
  });
  const settledPromotion = planVerifiedBatchPromotion({
    historyRecords: after.historyRecords,
    previousRecords,
    verifyHistoryBatch: options.verifyHistoryBatch,
    expectedVerifiedBatchRows: options.expectedVerifiedBatchRows,
  });
  if (settledPromotion.updates.length) throw new Error('History batch promotion apply is not idempotent');
  if (settledPlan.historyUpdates.length || settledPlan.currentUpdates.length) {
    throw new Error('Decision history apply is not idempotent');
  }
  const receipt = {
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    backup,
    verification,
    pending: {
      historySnapshots: settledPlan.pendingHistory.length,
      currentCounts: settledPlan.pendingCurrent.length,
    },
    afterDigest: digest(after),
  };
  if (options.receiptFile) {
    const file = path.resolve(options.receiptFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    receipt.receiptFile = file;
  }
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
