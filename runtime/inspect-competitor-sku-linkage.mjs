#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const TARGET = {
  appToken: 'OWebbPUcBa7B8JseYLccQCy9nkf',
  mainTableId: 'tblJ9LHFN6pMVjPv',
  skuTableId: 'tblddWTrPeB4TKmR',
};
const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const MAIN_FIELD_NAMES = new Set(['尺寸', '适用空间', 'SKU采集明细']);
const SKU_FIELD_NAMES = new Set(['SKU尺寸', '尺寸汇总', '适用空间', '所属竞品']);

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('\"') && value.endsWith('\"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function relationIds(value) {
  const found = new Set();
  const visit = (item) => {
    if (item == null || item === '') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === 'string') {
      if (/^rec[A-Za-z0-9]+$/u.test(item)) found.add(item);
      return;
    }
    if (typeof item !== 'object') return;
    for (const key of ['record_id', 'recordId']) visit(item[key]);
    for (const key of ['record_ids', 'recordIds', 'value']) visit(item[key]);
  };
  visit(value);
  return [...found];
}

function selectNames(value) {
  const found = new Set();
  const visit = (item) => {
    if (item == null || item === '') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === 'string') {
      found.add(item.trim());
      return;
    }
    if (typeof item !== 'object') return;
    const label = item.name ?? item.text;
    if (typeof label === 'string' && label.trim()) found.add(label.trim());
    else if (item.value !== undefined) visit(item.value);
  };
  visit(value);
  return [...found].filter(Boolean);
}

function fieldSummary(field) {
  const property = field.property ?? {};
  return {
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    type: Number(field.type),
    property: {
      ...(property.table_id ? { tableId: property.table_id } : {}),
      ...(property.back_field_name ? { backFieldName: property.back_field_name } : {}),
      ...(typeof property.multiple === 'boolean' ? { multiple: property.multiple } : {}),
      ...(property.formula_expression ? { formulaExpression: property.formula_expression } : {}),
      ...(Array.isArray(property.options)
        ? { options: property.options.map((option) => option.name).filter(Boolean) }
        : {}),
    },
  };
}

function requireFields(fields, names, tableName) {
  const selected = fields.filter((field) => names.has(field.fieldName));
  for (const name of names) {
    const count = selected.filter((field) => field.fieldName === name).length;
    if (count !== 1) throw new Error(`${tableName} must contain exactly one ${name}; received ${count}`);
  }
  return selected.map(fieldSummary);
}

async function main(argv = process.argv.slice(2)) {
  const envArgumentIndex = argv.indexOf('--env-file');
  const envFile = resolve(envArgumentIndex >= 0 ? argv[envArgumentIndex + 1] : DEFAULT_ENV_FILE);
  if (!existsSync(envFile)) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(envFile, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials are unavailable');

  const client = new CompetitorV2FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: TARGET.appToken,
  });
  await client.authenticate();
  const [mainFields, skuFields, mainRecords, skuRecords] = await Promise.all([
    client.listFields(TARGET.mainTableId),
    client.listFields(TARGET.skuTableId),
    client.listRecords(TARGET.mainTableId),
    client.listRecords(TARGET.skuTableId),
  ]);

  const aggregate = new Map();
  for (const sku of skuRecords) {
    const mainIds = relationIds(sku.fields?.所属竞品);
    for (const mainId of mainIds) {
      const entry = aggregate.get(mainId) ?? { skuCount: 0, spaces: new Set() };
      entry.skuCount += 1;
      selectNames(sku.fields?.适用空间).forEach((space) => entry.spaces.add(space));
      aggregate.set(mainId, entry);
    }
  }

  const linkedCompetitors = mainRecords
    .map((record) => {
      const fromSku = aggregate.get(record.recordId) ?? { skuCount: 0, spaces: new Set() };
      const backlinkCount = relationIds(record.fields?.SKU采集明细).length;
      return {
        mainRecordId: record.recordId,
        backlinkCount,
        skuSideCount: fromSku.skuCount,
        applicableSpaces: [...fromSku.spaces].sort(),
        countsMatch: backlinkCount === fromSku.skuCount,
      };
    })
    .filter((record) => record.backlinkCount > 0 || record.skuSideCount > 0)
    .sort((left, right) => left.mainRecordId.localeCompare(right.mainRecordId));

  const output = {
    mode: 'READ_ONLY',
    target: TARGET,
    recordCounts: { main: mainRecords.length, sku: skuRecords.length },
    fields: {
      main: requireFields(mainFields, MAIN_FIELD_NAMES, '竞品主表'),
      sku: requireFields(skuFields, SKU_FIELD_NAMES, 'SKU明细'),
    },
    linkage: {
      linkedCompetitorCount: linkedCompetitors.length,
      allCountsMatch: linkedCompetitors.every((record) => record.countsMatch),
      competitors: linkedCompetitors,
    },
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
