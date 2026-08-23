import {
  plainFeishuFormulaValue,
  SKU_APPLICABLE_SPACES,
  SKU_BACKLINK_FIELD_NAME,
  SKU_DETAIL_FIELDS,
  SKU_RELATION_FIELD_NAME,
} from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

const BIDIRECTIONAL_LINK = 21;
const A_OR_B_COMPETITOR = /^(?:A-|B-)/u;

function text(value) {
  return String(plainFeishuFormulaValue(value) ?? '').trim();
}

function required(value, name) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function fieldName(field) {
  return field?.fieldName ?? field?.field_name;
}

function fieldType(field) {
  return Number(field?.type);
}

function findExactlyOne(fields, name, tableName) {
  const matches = (fields ?? []).filter((field) => fieldName(field) === name);
  if (matches.length !== 1) {
    throw new Error(`${tableName} must contain exactly one ${name}; received ${matches.length}`);
  }
  return matches[0];
}

function optionNames(field) {
  return (field?.property?.options ?? []).map((option) => String(option?.name ?? '').trim());
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSkuSchema({ target, mainFields, skuFields }) {
  for (const definition of SKU_DETAIL_FIELDS) {
    const field = findExactlyOne(skuFields, definition.name, 'SKU明细');
    if (fieldType(field) !== definition.type) {
      throw new Error(`SKU明细 ${definition.name} type differs from the approved contract`);
    }
    const expectedOptions = definition.property?.options?.map((option) => option.name);
    if (expectedOptions && !sameStrings(optionNames(field), expectedOptions)) {
      throw new Error(`SKU明细 ${definition.name} options differ from the approved contract`);
    }
  }

  const space = findExactlyOne(skuFields, '适用空间', 'SKU明细');
  if (!sameStrings(optionNames(space), SKU_APPLICABLE_SPACES) || optionNames(space).includes('大户型')) {
    throw new Error('SKU明细 适用空间 differs from the approved contract');
  }

  const relation = findExactlyOne(skuFields, SKU_RELATION_FIELD_NAME, 'SKU明细');
  const relationProperty = relation.property ?? {};
  if (fieldType(relation) !== BIDIRECTIONAL_LINK
    || relationProperty.table_id !== target.mainTableId
    || relationProperty.multiple !== false
    || relationProperty.back_field_name !== SKU_BACKLINK_FIELD_NAME) {
    throw new Error('SKU明细 所属竞品 relation differs from the approved contract');
  }

  const backlink = findExactlyOne(mainFields, SKU_BACKLINK_FIELD_NAME, '竞品主表');
  if (fieldType(backlink) !== BIDIRECTIONAL_LINK || backlink.property?.table_id !== target.skuTableId) {
    throw new Error('竞品主表 SKU采集明细 backlink differs from the approved contract');
  }
}

function productIdFromUrl(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return productIdFromUrl(value.link ?? value.url ?? '');
  }
  try {
    return new URL(value).searchParams.get('id') ?? '';
  } catch {
    return '';
  }
}

function assertSource({ target, source, mainRecord }) {
  required(target?.appToken, 'target appToken');
  required(target?.mainTableId, 'target mainTableId');
  required(target?.skuTableId, 'target skuTableId');
  const productId = required(source?.productId, 'source productId');
  const productUrl = required(source?.productUrl, 'source productUrl');
  const productTitle = required(source?.productTitle, 'source productTitle');
  const competitorClass = required(source?.competitorClass, 'source competitorClass');
  const mainRecordId = required(source?.mainRecordId, 'source mainRecordId');
  if (!A_OR_B_COMPETITOR.test(competitorClass)) {
    throw new Error('Source competitor class must be A or B');
  }
  if (productIdFromUrl(productUrl) !== productId) {
    throw new Error('Source product URL does not match source product ID');
  }
  if (required(mainRecord?.recordId ?? mainRecord?.record_id, 'main record ID') !== mainRecordId) {
    throw new Error('Selected main record differs from the captured source record');
  }
  const fields = mainRecord?.fields ?? {};
  if (text(fields.是否有效竞品) !== '是') {
    throw new Error('Selected main record is not currently a valid competitor');
  }
  const currentClass = text(fields.竞品分类);
  if (!A_OR_B_COMPETITOR.test(currentClass)) {
    throw new Error('Selected main record is no longer an A or B competitor');
  }
  if (currentClass !== competitorClass) {
    throw new Error('Captured competitor class differs from the current Feishu formula result');
  }
  if (productIdFromUrl(fields.商品链接) !== productId) {
    throw new Error('Selected main record product link differs from the captured product ID');
  }
  if (text(fields.商品标题) !== productTitle) {
    throw new Error('Selected main record title differs from the captured source title');
  }
}

function relationRecordIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of values) {
    if (item == null || item === '') continue;
    if (typeof item === 'string') {
      ids.push(item.trim());
      continue;
    }
    const raw = item.record_ids ?? item.recordIds ?? item.record_id ?? item.recordId;
    if (Array.isArray(raw)) ids.push(...raw.map((id) => String(id).trim()));
    else if (raw != null) ids.push(String(raw).trim());
  }
  return [...new Set(ids.filter(Boolean))].sort();
}

function normalizedFieldValue(name, value) {
  if (name === SKU_RELATION_FIELD_NAME) return relationRecordIds(value);
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).filter(Boolean).sort();
  }
  return text(value);
}

function sameFieldValue(name, left, right) {
  const normalizedLeft = normalizedFieldValue(name, left);
  const normalizedRight = normalizedFieldValue(name, right);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function writeFieldsFor(parsedRow, source) {
  const fields = parsedRow?.fields ?? {};
  const uniqueKey = required(fields.SKU唯一键, 'SKU unique key');
  if (uniqueKey !== `${source.productId}|${required(parsedRow?.skuId, 'parsed SKU ID')}`) {
    throw new Error(`Parsed SKU unique key does not match its SKU ID: ${uniqueKey}`);
  }
  if (text(fields.商品ID) !== source.productId || productIdFromUrl(text(fields.商品链接)) !== source.productId) {
    throw new Error(`Parsed SKU source identity differs: ${uniqueKey}`);
  }
  if (text(fields.商品标题) !== source.productTitle || text(fields.竞品分类) !== source.competitorClass) {
    throw new Error(`Parsed SKU source fields differ: ${uniqueKey}`);
  }
  if (text(fields[SKU_RELATION_FIELD_NAME]) !== source.mainRecordId) {
    throw new Error(`Parsed SKU relation differs: ${uniqueKey}`);
  }

  const allowedNames = new Set([...SKU_DETAIL_FIELDS.map((definition) => definition.name), SKU_RELATION_FIELD_NAME]);
  for (const name of Object.keys(fields)) {
    if (!allowedNames.has(name)) throw new Error(`Parsed SKU has an unapproved field: ${name}`);
  }
  const output = {};
  for (const definition of SKU_DETAIL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, definition.name)) {
      output[definition.name] = fields[definition.name];
    }
  }
  // Feishu's create-record API requires a duplex-link value to be an array of record IDs.
  output[SKU_RELATION_FIELD_NAME] = [source.mainRecordId];
  return output;
}

function existingByUniqueKey(records) {
  const output = new Map();
  for (const record of records ?? []) {
    const recordId = required(record?.recordId ?? record?.record_id, 'SKU record ID');
    const uniqueKey = text(record?.fields?.SKU唯一键);
    if (!uniqueKey) continue;
    const items = output.get(uniqueKey) ?? [];
    items.push({ recordId, fields: record.fields ?? {} });
    output.set(uniqueKey, items);
  }
  return output;
}

function samePersistedSku(existing, writeFields) {
  return Object.entries(writeFields).every(([name, value]) => sameFieldValue(name, existing.fields?.[name], value));
}

export function buildSkuDryRunPlan({
  target,
  source,
  mainRecord,
  mainFields,
  skuFields,
  skuRecords,
  parsedRows,
}) {
  assertSource({ target, source, mainRecord });
  assertSkuSchema({ target, mainFields, skuFields });
  if (!Array.isArray(parsedRows) || parsedRows.length === 0) throw new Error('Parsed SKU rows are required');

  const existing = existingByUniqueKey(skuRecords);
  const seenParsedKeys = new Set();
  const items = parsedRows.map((parsedRow) => {
    const writeFields = writeFieldsFor(parsedRow, source);
    const uniqueKey = writeFields.SKU唯一键;
    if (seenParsedKeys.has(uniqueKey)) throw new Error(`Parsed SKU contains a duplicate unique key: ${uniqueKey}`);
    seenParsedKeys.add(uniqueKey);

    const matching = existing.get(uniqueKey) ?? [];
    if (matching.length === 0) {
      return { skuId: parsedRow.skuId, uniqueKey, action: 'toCreate', writeFields };
    }
    if (matching.length > 1) {
      return {
        skuId: parsedRow.skuId,
        uniqueKey,
        action: 'conflict',
        reason: 'duplicateExistingUniqueKey',
        recordIds: matching.map((item) => item.recordId),
      };
    }
    if (samePersistedSku(matching[0], writeFields)) {
      return { skuId: parsedRow.skuId, uniqueKey, action: 'alreadyPresent', recordId: matching[0].recordId };
    }
    return {
      skuId: parsedRow.skuId,
      uniqueKey,
      action: 'conflict',
      reason: 'existingRecordDiffers',
      recordId: matching[0].recordId,
    };
  });

  const count = (action) => items.filter((item) => item.action === action).length;
  const duplicateExistingKeys = [...existing.values()].filter((records) => records.length > 1).length;
  const conflict = count('conflict');
  return {
    items,
    summary: {
      parsedRows: items.length,
      toCreate: count('toCreate'),
      alreadyPresent: count('alreadyPresent'),
      conflict,
      duplicateExistingKeys,
      writeReady: conflict === 0 && duplicateExistingKeys === 0,
    },
  };
}
