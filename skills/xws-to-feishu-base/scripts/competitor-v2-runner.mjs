import { basename } from 'node:path';
import { readFile as readFileDefault } from 'node:fs/promises';

import { validateSourceHeaders } from './import-core.mjs';
import {
  COMPETITOR_MAIN_FIELDS,
  SKU_DETAIL_FIELDS,
  buildCompetitorRecord,
  buildFeishuCompetitorRecord,
} from './competitor-v2-core.mjs';

const TABLES = [
  { name: '竞品主表', fields: COMPETITOR_MAIN_FIELDS },
  { name: 'SKU明细', fields: SKU_DETAIL_FIELDS },
];

function tableId(table) {
  return table.tableId ?? table.table_id;
}

function fieldName(field) {
  return field.fieldName ?? field.field_name;
}

function recordFields(record) {
  return record.fields ?? {};
}

function validateManifest(manifest, expectedRows) {
  validateSourceHeaders(manifest.headers);
  if (!Array.isArray(manifest.rows) || manifest.rows.length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} source rows; received ${manifest.rows?.length ?? 0}`);
  }
  const imagesByRow = new Map();
  for (const image of manifest.images ?? []) {
    const values = imagesByRow.get(image.row) ?? [];
    values.push(image);
    imagesByRow.set(image.row, values);
  }
  const entries = manifest.rows.map((row, index) => {
    const worksheetRow = index + 2;
    const images = imagesByRow.get(worksheetRow) ?? [];
    if (images.length !== 1) {
      throw new Error(`Worksheet row ${worksheetRow} must have exactly one embedded image; found ${images.length}`);
    }
    return { row, image: images[0] };
  });
  if ((manifest.images ?? []).length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} source images; received ${manifest.images?.length ?? 0}`);
  }
  return entries;
}

function countBy(records, field) {
  const counts = new Map();
  for (const record of records) {
    const values = Array.isArray(record[field]) ? record[field] : [record[field]];
    for (const value of values) {
      const key = value || '<空>';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

function buildSummary(entries, searchKeyword) {
  const records = entries.map(({ row }) => buildCompetitorRecord(row, { searchKeyword }));
  return {
    priceBands: countBy(records, '客单价带分类'),
    monthlyReceivedBasis: countBy(records, '计算口径'),
    competitorClasses: countBy(records, '竞品分类'),
    dataStatus: countBy(records, '数据状态'),
  };
}

async function ensureTable(client, definition) {
  let matches = (await client.listTables()).filter((table) => table.name === definition.name);
  if (matches.length > 1) throw new Error(`Multiple tables named ${definition.name}`);
  let id;
  if (matches.length === 0) {
    id = await client.createTable(definition.name, definition.fields);
  } else {
    id = tableId(matches[0]);
  }
  if (!id) throw new Error(`Unable to resolve table ${definition.name}`);
  const actualFields = await client.listFields(id);
  const formulaCompatible = new Set([
    '月收货人数计算值', '计算口径', '月收货金额',
    '客单价带分类', '竞品分类', '数据状态', '待补数据项',
  ]);
  const compatible = actualFields.length === definition.fields.length && actualFields.every((field, index) => {
    const expected = definition.fields[index];
    return fieldName(field) === expected.name
      && (field.type === expected.type || (formulaCompatible.has(expected.name) && field.type === 20));
  });
  if (!compatible) {
    throw new Error(`${definition.name} field schema differs from the approved V2 contract`);
  }
  return id;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function comparable(fields) {
  return Object.fromEntries(Object.entries(fields)
    .filter(([name]) => name !== '商品图片')
    .map(([name, value]) => [name, canonical(value)]));
}

export function findFieldDifferences(actual, expected) {
  const names = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...names]
    .filter((name) => !equivalentFieldValues(actual[name], expected[name]))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function equivalentFieldValues(left, right) {
  const isEmpty = (value) => value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0);
  if (isEmpty(left) && isEmpty(right)) return true;
  const numeric = (value) => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim());
  if (typeof left === 'number' && numeric(right)) return left === Number(right);
  if (typeof right === 'number' && numeric(left)) return right === Number(left);
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function expectedWithoutImage(row, searchKeyword) {
  return comparable(buildFeishuCompetitorRecord(row, '__verification__', { searchKeyword }));
}

function verifyExisting(records, entries, searchKeyword) {
  const sourceByRank = new Map(entries.map((entry) => [String(entry.row.序号), entry]));
  const seen = new Set();
  for (const record of records) {
    const fields = recordFields(record);
    const rank = String(fields.序号 ?? '');
    if (!sourceByRank.has(rank) || seen.has(rank)) {
      throw new Error(`Unexpected or duplicate existing record rank: ${rank || '<empty>'}`);
    }
    seen.add(rank);
    const attachments = fields.商品图片;
    if (!Array.isArray(attachments) || attachments.length !== 1) {
      throw new Error(`existing record ${rank} does not contain exactly one attachment`);
    }
    const expected = expectedWithoutImage(sourceByRank.get(rank).row, searchKeyword);
    const actual = comparable(fields);
    const differences = findFieldDifferences(actual, expected);
    if (differences.length > 0) {
      const details = Object.fromEntries(differences.map((name) => [name, {
        actual: actual[name] ?? null,
        expected: expected[name] ?? null,
      }]));
      throw new Error(`existing record differs from source at rank ${rank}; fields=${differences.join(',')}; details=${JSON.stringify(details)}`);
    }
  }
  return seen;
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  async function consume() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => consume()));
  return output;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function runCompetitorV2({
  manifest,
  client,
  apply = false,
  searchKeyword,
  expectedRows,
  readFile = readFileDefault,
  uploadConcurrency = 3,
  recordBatchSize = 100,
  onProgress = () => {},
}) {
  const entries = validateManifest(manifest, expectedRows);
  const summary = buildSummary(entries, searchKeyword);
  if (!apply) {
    return {
      dryRun: true,
      sourceRows: entries.length,
      sourceImages: manifest.images.length,
      summary,
    };
  }
  if (!client) throw new Error('A Feishu client is required in apply mode');

  const tableIds = {};
  for (const definition of TABLES) tableIds[definition.name] = await ensureTable(client, definition);

  const skuRecords = await client.listRecords(tableIds.SKU明细);
  if (skuRecords.length !== 0) throw new Error('SKU明细 must remain empty in this stage');

  const existing = await client.listRecords(tableIds.竞品主表);
  const resumedFromRows = existing.length;
  const existingRanks = verifyExisting(existing, entries, searchKeyword);
  const missing = entries.filter((entry) => !existingRanks.has(String(entry.row.序号)));
  let importedThisRun = 0;

  for (const batch of chunks(missing, recordBatchSize)) {
    const fieldsList = await mapLimit(batch, uploadConcurrency, async (entry) => {
      const bytes = await readFile(entry.image.path);
      const token = await client.uploadFile({ name: basename(entry.image.path), bytes });
      importedThisRun += 1;
      onProgress({ phase: 'UPLOAD', uploaded: importedThisRun, total: missing.length });
      return buildFeishuCompetitorRecord(entry.row, token, { searchKeyword });
    });
    await client.batchCreateRecords(tableIds.竞品主表, fieldsList);
    onProgress({ phase: 'WRITE', imported: importedThisRun, total: missing.length });
  }

  const saved = await client.listRecords(tableIds.竞品主表);
  verifyExisting(saved, entries, searchKeyword);
  if (saved.length !== entries.length) {
    throw new Error(`Expected ${entries.length} imported records; received ${saved.length}`);
  }
  const attachmentCount = saved.reduce((count, record) => (
    count + (Array.isArray(recordFields(record).商品图片) ? recordFields(record).商品图片.length : 0)
  ), 0);
  if (attachmentCount !== entries.length) {
    throw new Error(`Expected ${entries.length} attachments; received ${attachmentCount}`);
  }

  return {
    dryRun: false,
    sourceRows: entries.length,
    sourceImages: manifest.images.length,
    resumedFromRows,
    importedThisRun: missing.length,
    importedRows: saved.length,
    attachmentCount,
    tableIds,
    summary,
  };
}
