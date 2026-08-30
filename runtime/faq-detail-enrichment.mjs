import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';

export const FAQ_DETAIL_ENRICHMENT_VERSION = 'faq-detail-enrichment-v1.0.0';

const TEXT = 1;

export const FAQ_DETAIL_ENRICHMENT_FIELDS = [
  { name: '痛点描述', type: TEXT },
  { name: '典型问题', type: TEXT },
  { name: '典型用户原话', type: TEXT },
];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function fieldsOf(record) {
  return record?.fields ?? record ?? {};
}

function contentFor(record, operatorContent) {
  const label = text(fieldsOf(record).分类标签);
  const content = operatorContent?.content?.[label];
  if (!FAQ_LABEL_CATALOG.some((item) => item.label === label) || !content) throw new Error(`FAQ detail record has unknown or empty label: ${label}`);
  return {
    痛点描述: text(content.痛点描述),
    典型问题: text(content.典型问题),
    典型用户原话: text(content.典型用户原话),
  };
}

export function enrichmentFieldsForRecord(record, operatorContent) {
  return contentFor(record, operatorContent);
}

export function buildDetailEnrichmentPlan({ masterRecords, weeklyRecords, operatorContent }) {
  const build = (records, table) => {
    const updates = [];
    for (const record of records ?? []) {
      const fields = enrichmentFieldsForRecord(record, operatorContent);
      const current = fieldsOf(record);
      if (FAQ_DETAIL_ENRICHMENT_FIELDS.some(({ name }) => text(current[name]) !== fields[name])) {
        updates.push({ recordId: record.recordId, fields });
      }
    }
    return { table, recordCount: records?.length ?? 0, updates };
  };
  return {
    version: FAQ_DETAIL_ENRICHMENT_VERSION,
    labels: FAQ_LABEL_CATALOG.map(({ label }) => label),
    fields: FAQ_DETAIL_ENRICHMENT_FIELDS,
    master: build(masterRecords, 'master'),
    weekly: build(weeklyRecords, 'weekly'),
  };
}

export function assertEnrichmentReadBack({ before, after, operatorContent }) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) throw new Error('FAQ detail record count changed during enrichment');
  const afterById = new Map(after.map((record) => [record.recordId, record]));
  const enrichmentNames = new Set(FAQ_DETAIL_ENRICHMENT_FIELDS.map(({ name }) => name));
  for (const previous of before) {
    const current = afterById.get(previous.recordId);
    if (!current) throw new Error(`FAQ detail record disappeared during enrichment: ${previous.recordId}`);
    const previousFields = fieldsOf(previous);
    const currentFields = fieldsOf(current);
    for (const [name, value] of Object.entries(previousFields)) {
      if (enrichmentNames.has(name)) continue;
      if (JSON.stringify(value) !== JSON.stringify(currentFields[name])) throw new Error(`FAQ detail original field changed: ${previous.recordId}/${name}`);
    }
    const expected = enrichmentFieldsForRecord(previous, operatorContent);
    for (const { name } of FAQ_DETAIL_ENRICHMENT_FIELDS) if (text(currentFields[name]) !== expected[name]) throw new Error(`FAQ detail enrichment mismatch: ${previous.recordId}/${name}`);
  }
  return true;
}
