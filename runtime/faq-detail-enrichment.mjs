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

export const FAQ_DETAIL_ENRICHMENT_VERSION = 'faq-detail-replacement-v3.2.0';
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
