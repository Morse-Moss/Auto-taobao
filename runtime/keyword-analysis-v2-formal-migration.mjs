import {
  FINE_LABEL_DICTIONARY,
  MAIN_CATEGORIES,
} from './keyword-analysis-v2-core.mjs';

export const FORMAL_TABLE_ID = 'tblN1uT1LpzyqqWx';
export const FORMAL_TABLE_NAME = '关键词分析 V1（修正版）';
export const EXPECTED_FIELD_COUNT = 22;
export const EXPECTED_RECORD_COUNT = 300;

const INTENTS = ['了解型', '对比型', '购买型', '灵感型', '问题解决型'];
const MUTABLE_FIELD_NAMES = new Set(['标准归并词', '关键词分类', '细分标签', '用户意图']);

function requiredField(fields, name) {
  const matches = fields.filter((field) => field.field_name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  return matches[0];
}

function currentOptions(field) {
  return field.property?.options ?? [];
}

function mergeOptions(existing, requiredNames) {
  const result = existing.map((item) => ({ ...item }));
  const names = new Set(result.map((item) => item.name));
  for (const name of requiredNames) {
    if (!names.has(name)) {
      result.push({ name });
      names.add(name);
    }
  }
  return result;
}

function controlledFineLabelNames() {
  return Object.entries(FINE_LABEL_DICTIONARY)
    .flatMap(([dimension, values]) => values.map((value) => `${dimension}/${value}`));
}

export function buildFormalFieldPlan(fields, { usedIntentOptionNames }) {
  verifyFormalTable({ tableName: FORMAL_TABLE_NAME, fields, recordCount: EXPECTED_RECORD_COUNT });
  const merge = requiredField(fields, '标准归并词');
  const classification = requiredField(fields, '关键词分类');
  const labels = requiredField(fields, '细分标签');
  const intent = requiredField(fields, '用户意图');

  const unknownUsedIntents = [...usedIntentOptionNames].filter((name) => !INTENTS.includes(name));
  if (unknownUsedIntents.length > 0) {
    throw new Error(`Cannot remove used intent option(s): ${unknownUsedIntents.join(', ')}`);
  }
  const validIntentOptions = INTENTS.map((name) => {
    const existing = currentOptions(intent).find((item) => item.name === name);
    return existing ? { ...existing } : { name };
  });

  return {
    updates: [
      {
        fieldId: classification.field_id,
        fieldName: '关键词分类',
        body: {
          field_name: '关键词分类',
          type: 3,
          property: { options: mergeOptions(currentOptions(classification), MAIN_CATEGORIES) },
        },
      },
      {
        fieldId: labels.field_id,
        fieldName: '细分标签',
        body: {
          field_name: '细分标签',
          type: 4,
          property: { options: mergeOptions(currentOptions(labels), controlledFineLabelNames()) },
        },
      },
      {
        fieldId: intent.field_id,
        fieldName: '用户意图',
        body: {
          field_name: '用户意图',
          type: 3,
          property: { options: validIntentOptions },
        },
      },
      {
        fieldId: merge.field_id,
        fieldName: '标准归并词',
        body: { field_name: '标准归并词', type: 1 },
      },
    ],
    creates: [],
  };
}

export function assertFormalFieldMutation({ method, path, body }, { appToken, allowedFields }) {
  if (method === 'GET') return;
  const root = `/bitable/v1/apps/${appToken}/tables/${FORMAL_TABLE_ID}/fields`;
  if (method === 'PUT' && path.startsWith(`${root}/`)) {
    const fieldId = path.slice(root.length + 1);
    const expectedName = allowedFields.get(fieldId);
    if (expectedName && MUTABLE_FIELD_NAMES.has(expectedName) && body?.field_name === expectedName) return;
  }
  throw new Error(`Blocked non-formal-field mutation: ${method} ${path}`);
}

export function verifyFormalTable({ tableName, fields, recordCount }) {
  if (tableName !== FORMAL_TABLE_NAME) {
    throw new Error(`Authorized table name mismatch: ${tableName ?? '<missing>'}`);
  }
  if (fields.length !== EXPECTED_FIELD_COUNT) {
    throw new Error(`Formal table must have ${EXPECTED_FIELD_COUNT} fields; received ${fields.length}`);
  }
  if (recordCount !== EXPECTED_RECORD_COUNT) {
    throw new Error(`Formal table must have ${EXPECTED_RECORD_COUNT} records; received ${recordCount}`);
  }
  const names = fields.map((field) => field.field_name);
  if (new Set(names).size !== names.length) throw new Error('Formal table contains duplicate field names');
  for (const name of MUTABLE_FIELD_NAMES) requiredField(fields, name);
}

export function verifyMigratedFields(fields) {
  const merge = requiredField(fields, '标准归并词');
  if (merge.type !== 1) throw new Error(`标准归并词 expected text type 1; received ${merge.type}`);

  const classification = requiredField(fields, '关键词分类');
  if (classification.type !== 3) throw new Error(`关键词分类 expected single-select type 3; received ${classification.type}`);
  const categoryNames = new Set(currentOptions(classification).map((item) => item.name));
  for (const name of MAIN_CATEGORIES) {
    if (!categoryNames.has(name)) throw new Error(`关键词分类 missing option: ${name}`);
  }

  const labels = requiredField(fields, '细分标签');
  if (labels.type !== 4) throw new Error(`细分标签 expected multi-select type 4; received ${labels.type}`);
  const labelNames = new Set(currentOptions(labels).map((item) => item.name));
  for (const name of controlledFineLabelNames()) {
    if (!labelNames.has(name)) throw new Error(`细分标签 missing controlled option: ${name}`);
  }

  const intent = requiredField(fields, '用户意图');
  if (intent.type !== 3) throw new Error(`用户意图 expected single-select type 3; received ${intent.type}`);
  const intentNames = currentOptions(intent).map((item) => item.name);
  if (JSON.stringify(intentNames) !== JSON.stringify(INTENTS)) {
    throw new Error(`用户意图 options differ: ${JSON.stringify(intentNames)}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalRecords(records) {
  return [...records]
    .map(({ record_id, fields }) => ({ record_id, fields: canonicalize(fields) }))
    .sort((left, right) => left.record_id.localeCompare(right.record_id));
}

export function assertRecordsUnchanged(before, after) {
  const beforeText = JSON.stringify(canonicalRecords(before));
  const afterText = JSON.stringify(canonicalRecords(after));
  if (beforeText !== afterText) throw new Error('Record data changed during field migration');
}
