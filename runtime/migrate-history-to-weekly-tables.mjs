#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const ENV_FILE = 'E:/小红书/.env.local';
const PERIOD = '2026-08-23_2026-08-29';
const SOURCES = [
  { id: 'tbl7u5CUYiRei7AQ', name: '竞品历史总表', target: `竞品周_${PERIOD}`, kind: 'competitor' },
  { id: 'tbl2buNGnN1BxKCU', name: 'SKU历史总表', target: `SKU周_${PERIOD}`, kind: 'sku' },
];
const DELETE_TABLES = [
  ['tbl7u5CUYiRei7AQ', '竞品历史总表'],
  ['tbl2buNGnN1BxKCU', 'SKU历史总表'],
  ['tblAIrCvkxAbvhyr', '数据表'],
  ['tbliEvGogHi2gCyx', '分析周次'],
  ['tblZNRIAzHrSSRyK', '竞品采集批次'],
  ['tblgQgyla33f9h5s', '竞品周快照'],
];
const FORMULA_SNAPSHOT_TYPES = new Map([
  ['月收货人数计算值', 2],
  ['月收货金额', 2],
  ['是否有效竞品', 1],
  ['竞品分类', 1],
  ['数据状态', 1],
  ['待补数据项', 1],
]);

function parseEnv(raw) {
  const env = {};
  for (const line of String(raw).split(/\r?\n/gu)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const index = value.indexOf('=');
    if (index < 1) continue;
    let item = value.slice(index + 1).trim();
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      item = item.slice(1, -1);
    }
    env[value.slice(0, index).trim()] = item;
  }
  return env;
}

function fieldName(field) { return field.fieldName ?? field.field_name; }
function fieldType(field) { return Number(field.type); }

function cleanProperty(property) {
  if (!property || typeof property !== 'object') return undefined;
  const allowed = ['formatter', 'date_formatter', 'auto_fill', 'options', 'multiple', 'table_id', 'back_field_name'];
  const result = {};
  for (const key of allowed) if (property[key] !== undefined) result[key] = property[key];
  if (Array.isArray(result.options)) {
    result.options = result.options.map((option) => ({
      name: option.name,
      color: option.color,
    })).filter((option) => option.name);
  }
  return Object.keys(result).length ? result : undefined;
}

function fieldDefinitions(sourceFields, kind) {
  return sourceFields
    .filter((field) => fieldName(field) !== '文本')
    .map((field) => {
      const name = fieldName(field);
      if (kind === 'competitor' && FORMULA_SNAPSHOT_TYPES.has(name)) {
        return { field_name: name, type: FORMULA_SNAPSHOT_TYPES.get(name) };
      }
      return {
        field_name: name,
        type: fieldType(field),
        ...(cleanProperty(field.property) ? { property: cleanProperty(field.property) } : {}),
      };
    });
}

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (typeof value === 'object') return String(value.text ?? value.value ?? value.name ?? '');
  return String(value);
}

function snapshotFields(record, fields, kind) {
  const source = record.fields ?? {};
  const output = {};
  for (const field of fields) {
    const name = fieldName(field);
    if (!(name in source) || source[name] == null) continue;
    const value = source[name];
    if (kind === 'competitor' && FORMULA_SNAPSHOT_TYPES.has(name)) {
      output[name] = FORMULA_SNAPSHOT_TYPES.get(name) === 2
        ? Number(value) || 0
        : text(value);
    } else if (fieldType(field) === 2) {
      output[name] = Number(value) || 0;
    } else {
      output[name] = value;
    }
  }
  return output;
}

async function createTable(client, name, definitions) {
  const data = await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables`, {
    table: { name, default_view_name: '全部记录', fields: definitions },
  });
  const tableId = data.table_id ?? data.table?.table_id;
  if (!tableId) throw new Error(`Feishu did not return table id for ${name}`);
  return tableId;
}

async function batchCreateAny(client, tableId, fieldsList) {
  const data = await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`, {
    records: fieldsList.map((fields) => ({ fields })),
  });
  return (data.records ?? []).map((record) => record.record_id);
}

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Refusing to mutate Feishu without --apply');
  if (!existsSync(ENV_FILE)) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(ENV_FILE, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const tables = await client.listTables();
  const byId = new Map(tables.map((table) => [table.tableId, table]));
  const byName = new Map(tables.map((table) => [table.name, table]));
  for (const source of SOURCES) {
    if (byId.get(source.id)?.name !== source.name) throw new Error(`Source table mismatch: ${source.id}`);
  }

  const migrated = [];
  for (const source of SOURCES) {
    const [sourceFields, sourceRecords] = await Promise.all([
      client.listFields(source.id),
      client.listRecords(source.id),
    ]);
    const records = source.kind === 'competitor'
      ? sourceRecords.filter((record) => text(record.fields?.商品周期唯一键) && record.fields?.['数据开始日期'] != null)
      : sourceRecords.filter((record) => text(record.fields?.SKU周期唯一键));
    const definitions = fieldDefinitions(sourceFields, source.kind);
    const existingTarget = byName.get(source.target);
    let targetId = existingTarget?.tableId;
    if (targetId) {
      const existingRecords = await client.listRecords(targetId);
      if (existingRecords.length > 0) throw new Error(`Target table is not empty: ${source.target}`);
    } else {
      targetId = await createTable(client, source.target, definitions);
    }
    const targetFields = await client.listFields(targetId);
    const targetNames = new Set(targetFields.map(fieldName));
    for (const definition of definitions) if (!targetNames.has(definition.field_name)) throw new Error(`Target field missing: ${source.target}.${definition.field_name}`);
    const payloads = records.map((record) => snapshotFields(record, sourceFields, source.kind));
    for (let index = 0; index < payloads.length; index += 500) await batchCreateAny(client, targetId, payloads.slice(index, index + 500));
    const after = await client.listRecords(targetId);
    const keyName = source.kind === 'competitor' ? '商品周期唯一键' : 'SKU周期唯一键';
    const keys = after.map((record) => text(record.fields?.[keyName])).filter(Boolean);
    if (after.length !== records.length || new Set(keys).size !== records.length) throw new Error(`Target verification failed: ${source.target}`);
    migrated.push({ sourceTableId: source.id, sourceTableName: source.name, targetTableId: targetId, targetTableName: source.target, sourceRecords: records.length, targetRecords: after.length, keyField: keyName });
  }

  const refreshed = await client.listTables();
  const refreshedById = new Map(refreshed.map((table) => [table.tableId, table]));
  for (const [id, name] of DELETE_TABLES) if (refreshedById.get(id)?.name !== name) throw new Error(`Delete target mismatch: ${id}`);
  for (const [id] of DELETE_TABLES) await client.deleteTable(id);
  const finalTables = await client.listTables();
  const deletedIds = new Set(DELETE_TABLES.map(([id]) => id));
  if (finalTables.some((table) => deletedIds.has(table.tableId))) throw new Error('Deleted table read-back still present');
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: PERIOD, migrated, deletedTables: DELETE_TABLES.map(([tableId, name]) => ({ tableId, name })), remainingTables: finalTables };
  const output = resolve('runtime/history-weekly-migration-20260825.json');
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ...receipt, receiptPath: output }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
