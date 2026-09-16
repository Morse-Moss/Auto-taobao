import { createHash } from 'node:crypto';

import {
  FAQ_ANALYSIS_FIELDS,
  FAQ_ANALYSIS_VERSION,
  PAIN_JUDGMENT_OPTIONS,
  assertAnalysisRecord,
  assertUniqueSourceTopics,
  sourceTopicIdentity,
} from './faq-text-analysis.mjs';

const TEXT = 1;
const NUMBER = 2;
const DATE = 5;

// 版本号随语义改名：v3.2.0 是「整体替换」时代的编号，现役语义是「周表 + 总表只新增」，
// 继续沿用 replacement 字样会让收据上的 mode 与 version 自相矛盾。
export const FAQ_DETAIL_ENRICHMENT_VERSION = 'faq-detail-append-v3.3.0';
// 退役线（整体替换）的版本号必须原样保留：2026-08-23 那期线上 base 就是这么发布的，
// 收据还得能读。否则旧周期会被状态机判成「未发布」，下一轮会去重跑并动已发布的数据。
export const FAQ_LEGACY_REPLACEMENT_VERSION = 'faq-detail-replacement-v3.2.0';
// 发布收据模式：周表补齐/替换 + 总表只新增。契约常量放在领域模块里，发布脚本与
// 状态机（run-faq-operator.mjs 的 publicationVerified）共用同一个字面量，避免各写一份。
export const FAQ_PUBLISH_MODE = 'WEEKLY_PUBLISHED_MASTER_APPENDED_AND_VERIFIED';
export const FAQ_DETAIL_JUDGMENT_FIELD = '是否痛点';
export const FAQ_DETAIL_PERIOD_FIELDS = [
  { name: '周期开始日期', type: DATE },
  { name: '周期结束日期', type: DATE },
];
export const FAQ_DETAIL_ENRICHMENT_FIELDS = [
  { name: '痛点描述', type: TEXT },
  { name: '典型问题', type: TEXT },
  { name: '典型用户原话', type: TEXT },
  { name: '占比', type: NUMBER, property: { formatter: '0.00%' } },
  ...FAQ_DETAIL_PERIOD_FIELDS,
];
const occurrenceIndex = FAQ_ANALYSIS_FIELDS.findIndex(({ name }) => name === '出现次数');
if (occurrenceIndex < 0) throw new Error('FAQ analysis schema has no occurrence field');
export const FAQ_DETAIL_FIELDS = [
  ...FAQ_ANALYSIS_FIELDS.slice(0, occurrenceIndex + 1),
  ...FAQ_DETAIL_ENRICHMENT_FIELDS,
  ...FAQ_ANALYSIS_FIELDS.slice(occurrenceIndex + 1),
];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fieldsOf(record) {
  return record?.fields ?? record ?? {};
}

function periodDateValues(period) {
  const match = String(period ?? '').match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/u);
  if (!match) throw new Error('Invalid FAQ period');
  const [, startDate, endDate] = match;
  const parseDate = (date) => {
    const value = Date.parse(`${date}T00:00:00+08:00`);
    const normalized = Number.isFinite(value) ? new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
    return normalized === date ? value : null;
  };
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid FAQ period');
  return { start, end };
}

function operatorFields(record, operatorContent) {
  const fields = fieldsOf(record);
  const label = text(fields.分类标签);
  const content = operatorContent?.content?.[label];
  if (content) {
    return {
      痛点描述: text(content.痛点描述),
      典型问题: text(content.典型问题),
      典型用户原话: text(content.典型用户原话),
    };
  }
  const evidence = text(fields.痛点判定依据);
  return {
    痛点描述: text(record.humanReviewReason) || evidence,
    典型问题: label,
    典型用户原话: evidence,
  };
}

export function detailRowForRecord(record, operatorContent, statistics, periodDates) {
  assertAnalysisRecord(record);
  const fields = fieldsOf(record);
  const judgment = text(fields.是否痛点);
  if (!PAIN_JUDGMENT_OPTIONS.includes(judgment)) throw new Error(`Invalid FAQ pain judgment: ${judgment}`);
  const row = {};
  for (const definition of FAQ_ANALYSIS_FIELDS) {
    const value = fields[definition.name];
    if (definition.name !== '出现次数' && value !== '' && value != null) row[definition.name] = value;
  }
  if (!Number.isInteger(statistics?.count) || statistics.count < 1 || !Number.isFinite(statistics?.share)) {
    throw new Error(`Missing FAQ detail statistics for label: ${text(fields.分类标签)}`);
  }
  row.出现次数 = statistics.count;
  Object.assign(row, operatorFields(record, operatorContent));
  row.占比 = statistics.share;
  row.周期开始日期 = periodDates?.start;
  row.周期结束日期 = periodDates?.end;
  row.分析版本 = FAQ_ANALYSIS_VERSION;
  return row;
}

function comparableRow(row) {
  return Object.fromEntries(FAQ_DETAIL_FIELDS.map(({ name, type }) => {
    const value = row?.[name];
    if (Number(type) === 2) {
      const number = Number(value);
      return [name, value === '' || value == null ? '' : Math.round(number * 1e12) / 1e12];
    }
    return [name, text(value)];
  }));
}

export function canonicalDetailRows(rows) {
  return rows.map((row) => JSON.stringify(comparableRow(row))).sort();
}

export function sourceTopicSetHash(records) {
  assertUniqueSourceTopics(records, 'FAQ detail records');
  return hash(records.map((record) => sourceTopicIdentity(record)).sort().join('\n'));
}

export function detailRowsHash(rows) {
  return hash(JSON.stringify(canonicalDetailRows(rows)));
}

export function detailSchemaHash(fields = FAQ_DETAIL_FIELDS) {
  return hash(JSON.stringify(fields));
}

export function buildDetailReplacementPlan({ finalRecords, operatorContent, period }) {
  const periodDates = periodDateValues(period);
  assertUniqueSourceTopics(finalRecords, 'Final FAQ records');
  const sources = new Set();
  const topicSources = new Map();
  for (const record of finalRecords) {
    const fields = fieldsOf(record);
    const sourceKey = text(record.sourceDedupKey ?? record.crossWeekDedupKey ?? fields.crossWeekDedupKey);
    if (!sourceKey) throw new Error('FAQ detail statistics require a stable deduplicated source identity');
    const label = text(fields.分类标签);
    sources.add(sourceKey);
    if (!topicSources.has(label)) topicSources.set(label, new Set());
    topicSources.get(label).add(sourceKey);
  }
  const denominator = sources.size;
  if (!denominator) throw new Error('FAQ detail statistics require at least one source record');
  const topicStatistics = Object.fromEntries([...topicSources.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([label, sourceKeys]) => [label, { count: sourceKeys.size, share: sourceKeys.size / denominator }]));
  const statisticsHash = hash(JSON.stringify(topicStatistics));
  const rows = finalRecords.map((record) => detailRowForRecord(record, operatorContent, topicStatistics[text(fieldsOf(record).分类标签)], periodDates));
  const identities = finalRecords.map((record) => sourceTopicIdentity(record));
  if (new Set(identities).size !== rows.length) throw new Error('FAQ detail rows do not have unique source-topic identities');
  const rowsHash = detailRowsHash(rows);
  const identityHash = sourceTopicSetHash(finalRecords);
  const table = { rows: structuredClone(rows), rowCount: rows.length, rowsHash, sourceTopicHash: identityHash, denominator, statisticsHash };
  return {
    version: FAQ_DETAIL_ENRICHMENT_VERSION,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    period,
    fields: FAQ_DETAIL_FIELDS,
    schemaHash: detailSchemaHash(),
    denominator,
    topicStatistics,
    statisticsHash,
    master: structuredClone(table),
    weekly: structuredClone(table),
  };
}

export function assertDetailReadBack({ records, expectedRows, expectedFields = FAQ_DETAIL_FIELDS, expectedPeriod, label = 'FAQ detail table' }) {
  const actualRows = (records ?? []).map((record) => record?.fields ?? record ?? {});
  if (actualRows.length !== expectedRows.length) throw new Error(`${label} record count mismatch`);
  const expectedDates = expectedPeriod ? periodDateValues(expectedPeriod) : null;
  for (const row of actualRows) {
    if (!Number.isFinite(Number(row.周期开始日期)) || !Number.isFinite(Number(row.周期结束日期))) throw new Error(`${label} period fields are incomplete`);
    if (expectedDates && (Number(row.周期开始日期) !== expectedDates.start || Number(row.周期结束日期) !== expectedDates.end)) throw new Error(`${label} period fields mismatch`);
  }
  const actualHash = detailRowsHash(actualRows);
  const expectedHash = detailRowsHash(expectedRows);
  if (actualHash !== expectedHash) throw new Error(`${label} read-back mismatch`);
  if (detailSchemaHash(expectedFields) !== detailSchemaHash(FAQ_DETAIL_FIELDS)) throw new Error(`${label} expected schema mismatch`);
  return { rowCount: actualRows.length, rowsHash: actualHash };
}

export function enrichmentFieldsForRecord(record, operatorContent) {
  return operatorFields(record, operatorContent);
}

// ── 总表「只新增」────────────────────────────────────────────────────────────
// 运营口径（2026-09-16）：`问题主库` 是总表、长期沉淀，**不能替换**；跟词库/竞品库一样
// 分「周表 + 总表」，总表现阶段**只新增**。与竞品历史总表同约定——见
// competitor-history-publish-core.mjs 的 buildHistoryPlan 返回 { creates, updates, deletes: [] }。
//
// 判重键＝sourceTopicIdentity = `来源记录唯一键` + `分类标签`（同一原始记录可命中多个标签，
// 故是「源 × 话题」二元组，与周表行的唯一性断言同一把尺）。
// 契约：deletes 恒为空数组；已存在的身份**绝不修改、绝不删除**；内容有差异只记 conflicts 供人看，
// 不写库（覆盖历史事实不是「只新增」）。
export function buildDetailAppendPlan({ desiredRows, existingRecords, label = '问题主库' }) {
  const existing = new Map();
  for (const record of existingRecords ?? []) {
    const fields = fieldsOf(record);
    const key = sourceTopicIdentity(fields);
    if (existing.has(key)) throw new Error(`${label} has duplicate existing source-topic identity: ${key.replace('\n', ' / ')}`);
    existing.set(key, { recordId: record?.recordId ?? record?.record_id ?? null, fields });
  }
  const seen = new Set();
  const creates = [];
  const conflicts = [];
  for (const row of desiredRows ?? []) {
    const key = sourceTopicIdentity(row);
    if (seen.has(key)) throw new Error(`${label} has duplicate desired source-topic identity: ${key.replace('\n', ' / ')}`);
    seen.add(key);
    const prior = existing.get(key);
    if (!prior) {
      creates.push(row);
      continue;
    }
    const priorFields = comparableRow(prior.fields);
    const desiredFields = comparableRow(row);
    const changedFields = FAQ_DETAIL_FIELDS
      .map(({ name }) => name)
      .filter((name) => priorFields[name] !== desiredFields[name]);
    if (changedFields.length) conflicts.push({ identity: key.replace('\n', ' / '), changedFields });
  }
  return {
    creates,
    conflicts,
    deletes: [],
    existingCount: existing.size,
    desiredCount: seen.size,
    overlapCount: seen.size - creates.length,
  };
}

// 追加后的回读断言：总表行数必须恰为「追加前行数 + 本次新增数」，且每条新增身份都能读到。
// 不做「少一行也算过」的宽容——总表只新增，行数对不上就说明有别的写入方在动这张表。
export function assertAppendReadBack({ records, appended, expectedCountBefore, label = '问题主库' }) {
  const keys = new Set((records ?? []).map((record) => sourceTopicIdentity(fieldsOf(record))));
  if (keys.size !== (records ?? []).length) throw new Error(`${label} has duplicate source-topic identity after append`);
  if (records.length !== expectedCountBefore + appended.length) {
    throw new Error(`${label} record count mismatch after append: ${records.length} != ${expectedCountBefore} + ${appended.length}`);
  }
  for (const row of appended) {
    const key = sourceTopicIdentity(row);
    if (!keys.has(key)) throw new Error(`${label} missing appended identity: ${key.replace('\n', ' / ')}`);
  }
  return { recordCount: records.length, appendedCount: appended.length };
}

