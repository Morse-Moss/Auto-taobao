#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const MAIN_TABLE_ID = 'tblJ9LHFN6pMVjPv';
const SKU_MAIN_TABLE_ID = 'tblddWTrPeB4TKmR';
const OLD_COMPETITOR_TABLE_ID = 'tblaOFbbDHsPdxPP';
const OLD_SKU_TABLE_ID = 'tbl9oaUJyHucfIMw';
const COMPETITOR_TABLE_ID = 'tblSS5bxyIeXgngI';
const SKU_TABLE_ID = 'tblSgYvJzGBxzEBO';
const START_DATE = '2026-08-23';
const END_DATE = '2026-08-29';
const ENV_FILE = 'E:/小红书/.env.local';

const COMPETITOR_METADATA = [
  { field_name: '商品周期唯一键', type: 1 },
  { field_name: '数据开始日期', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd' } },
  { field_name: '数据结束日期', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd' } },
  { field_name: '采集时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd HH:mm' } },
];
const SKU_METADATA = [
  { field_name: 'SKU周期唯一键', type: 1 },
  { field_name: '商品周期唯一键', type: 1 },
  { field_name: '数据开始日期', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd' } },
  { field_name: '数据结束日期', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd' } },
  { field_name: '采集时间', type: 5, property: { auto_fill: false, date_formatter: 'yyyy-MM-dd HH:mm' } },
  { field_name: '来源证据哈希', type: 1 },
];

const COMPETITOR_FORMULAS = new Set([
  '月收货人数计算值', '计算口径', '月收货金额', '客单价带分类', '是否有效竞品',
  '竞品分类', '数据状态', '待补数据项',
]);
const AI_FIELDS = new Set(['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']);

function parseEnv(raw) {
  return Object.fromEntries(String(raw).split(/\r?\n/u).flatMap((line) => {
    const value = line.trim();
    const index = value.indexOf('=');
    if (!value || value.startsWith('#') || index < 1) return [];
    return [[value.slice(0, index).trim(), value.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '')]];
  }));
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? value.record_id ?? '');
  return String(value ?? '').trim();
}

function id(value) {
  const valueText = text(value);
  return valueText || '';
}

function productId(fields) {
  const direct = id(fields.商品ID);
  if (direct) return direct;
  try { return new URL(id(fields.商品链接)).searchParams.get('id') ?? ''; } catch { return ''; }
}

function timestamp(date) {
  const value = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(value)) throw new Error(`Invalid date: ${date}`);
  return value;
}

function collectedAt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : timestamp(END_DATE);
}

function normalizeScalar(value) {
  if (value == null || value === '') return undefined;
  return typeof value === 'object' && !Array.isArray(value) ? text(value) : value;
}

function numberValue(value) {
  const raw = text(value).replace(/,/gu, '');
  if (!raw) return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function relation(recordId) {
  // Feishu's REST API expects type-21 duplex-link values as record-id strings,
  // while read responses may expose richer objects.
  return recordId ? [recordId] : undefined;
}

function fieldType(fields, name) {
  return Number(fields.find((field) => field.fieldName === name)?.type);
}

function relationTarget(fields, tableId) {
  return fields.find((field) => Number(field.type) === 21 &&
    (field.property?.table_id ?? field.property?.tableId) === tableId);
}

async function ensureFields(client, tableId, definitions, apply) {
  const current = await client.listFields(tableId);
  const existing = new Map(current.map((field) => [field.fieldName, field]));
  const missing = definitions.filter((definition) => !existing.has(definition.field_name));
  const mismatches = definitions.filter((definition) => {
    const field = existing.get(definition.field_name);
    return field && Number(field.type) !== Number(definition.type);
  });
  if (mismatches.length) throw new Error(`Metadata field type mismatch: ${mismatches.map((item) => item.field_name).join(', ')}`);
  if (apply) {
    for (const definition of missing) {
      await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, definition);
    }
  }
  return { missing: missing.map((item) => item.field_name), fieldCountBefore: current.length };
}

function mainByProduct(records) {
  const map = new Map();
  for (const record of records) {
    const key = productId(record.fields ?? {});
    if (!key) continue;
    if (map.has(key)) throw new Error(`Duplicate product ID in main table: ${key}`);
    map.set(key, record);
  }
  return map;
}

function skuByProduct(records) {
  const map = new Map();
  for (const record of records) {
    const key = productId(record.fields ?? {});
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(record);
    map.set(key, list);
  }
  return map;
}

function buildCompetitorPlan({ source, main, targetFields, mainById }) {
  const targetNames = new Set(targetFields.map((field) => field.fieldName));
  const targetRelation = relationTarget(targetFields, SKU_MAIN_TABLE_ID);
  const rows = [];
  const missingMain = [];
  const seen = new Set();
  for (const record of source) {
    const sourceFields = record.fields ?? {};
    const pid = productId(sourceFields);
    if (!pid) throw new Error(`Competitor row ${record.recordId} has no 商品ID`);
    const key = `${pid}|${START_DATE}`;
    if (seen.has(key)) throw new Error(`Duplicate 商品周期唯一键: ${key}`);
    seen.add(key);
    const mainRecord = mainById.get(pid);
    if (!mainRecord) missingMain.push(pid);
    const fields = {
      '商品周期唯一键': key,
      '数据开始日期': timestamp(START_DATE),
      '数据结束日期': timestamp(END_DATE),
      '采集时间': collectedAt(sourceFields.采集时间),
    };
    for (const field of targetFields) {
      const name = field.fieldName;
      if (!targetNames.has(name) || COMPETITOR_FORMULAS.has(name) || name === '商品周期唯一键' ||
        name === '数据开始日期' || name === '数据结束日期' || name === '采集时间' || name === 'SKU采集明细') continue;
      const value = AI_FIELDS.has(name) && mainRecord
        ? mainRecord.fields?.[name]
        : (sourceFields[name] !== undefined ? sourceFields[name] : mainRecord?.fields?.[name]);
      if (name === '商品图片') {
        if (mainRecord?.fields?.商品图片) fields[name] = mainRecord.fields.商品图片;
        continue;
      }
      if (name === '价格') {
        const numeric = numberValue(value);
        if (numeric !== undefined) fields[name] = numeric;
        continue;
      }
      const normalized = normalizeScalar(value);
      if (normalized !== undefined && Number(field.type) !== 20 && Number(field.type) !== 21) fields[name] = normalized;
    }
    rows.push({ key, productId: pid, fields });
  }
  return { rows, missingMain, relationField: targetRelation?.fieldName ?? null };
}

function buildSkuPlan({ source, mainById, competitorByProduct, targetFields }) {
  const targetMainRelation = relationTarget(targetFields, MAIN_TABLE_ID);
  const targetWeeklyRelation = relationTarget(targetFields, COMPETITOR_TABLE_ID);
  if (!targetMainRelation || !targetWeeklyRelation) throw new Error('SKU weekly relation fields are missing');
  const rows = [];
  const missing = [];
  const seen = new Set();
  for (const record of source) {
    const sourceFields = record.fields ?? {};
    const skuKey = id(sourceFields.SKU唯一键);
    const pid = productId(sourceFields);
    if (!skuKey || !pid) throw new Error(`SKU row ${record.recordId} has no SKU唯一键 or 商品ID`);
    const cycleKey = `${skuKey}|${START_DATE}`;
    if (seen.has(cycleKey)) throw new Error(`Duplicate SKU周期唯一键: ${cycleKey}`);
    seen.add(cycleKey);
    const mainRecord = mainById.get(pid);
    const competitorRecord = competitorByProduct.get(pid);
    if (!mainRecord || !competitorRecord) missing.push({ skuKey, productId: pid, missingMain: !mainRecord, missingCompetitor: !competitorRecord });
    const fields = {
      'SKU周期唯一键': cycleKey,
      '商品周期唯一键': `${pid}|${START_DATE}`,
      '数据开始日期': timestamp(START_DATE),
      '数据结束日期': timestamp(END_DATE),
      '采集时间': collectedAt(sourceFields.采集时间),
      '来源证据哈希': id(sourceFields.来源证据哈希),
      [targetMainRelation.fieldName]: relation(mainRecord?.recordId),
      [targetWeeklyRelation.fieldName]: relation(competitorRecord?.recordId),
    };
    for (const field of targetFields) {
      const name = field.fieldName;
      if (name === targetMainRelation.fieldName || name === targetWeeklyRelation.fieldName ||
        ['SKU周期唯一键', '商品周期唯一键', '数据开始日期', '数据结束日期', '采集时间', '来源证据哈希'].includes(name)) continue;
      const normalized = normalizeScalar(sourceFields[name]);
      if (normalized !== undefined && Number(field.type) !== 20 && Number(field.type) !== 21) fields[name] = normalized;
    }
    rows.push({ key: cycleKey, productId: pid, fields });
  }
  return { rows, missing, relationFields: { main: targetMainRelation.fieldName, weekly: targetWeeklyRelation.fieldName } };
}

async function writeRows(client, tableId, rows) {
  for (let index = 0; index < rows.length; index += 500) {
    await client.batchCreateRecords(tableId, rows.slice(index, index + 500).map((row) => row.fields));
  }
}

async function readByKey(client, tableId, keyName) {
  const records = await client.listRecords(tableId);
  return { records, byKey: new Map(records.map((record) => [id(record.fields?.[keyName]), record])) };
}

function assertKeySet(actual, expectedRows, keyName, label) {
  const expected = new Set(expectedRows.map((row) => row.key));
  const actualKeys = actual.records.map((record) => id(record.fields?.[keyName])).filter(Boolean);
  if (actualKeys.length !== actual.records.length || new Set(actualKeys).size !== actualKeys.length) {
    throw new Error(`${label} contains missing or duplicate ${keyName} values`);
  }
  if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key))) {
    throw new Error(`${label} keys differ from the planned source rows`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirm = process.argv[process.argv.indexOf('--confirm-base') + 1];
  if (apply && confirm !== APP_TOKEN) throw new Error('Apply requires --confirm-base OWebbPUcBa7B8JseYLccQCy9nkf');
  if (!existsSync(resolve(ENV_FILE))) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(resolve(ENV_FILE), 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const tables = await client.listTables();
  // These are pre-authorized structure copies whose temporary names do not
  // match the client's formal weekly-table name guard.
  client.weeklyTableIds.add(COMPETITOR_TABLE_ID);
  client.weeklyTableIds.add(SKU_TABLE_ID);
  const expected = new Map([
    [MAIN_TABLE_ID, '竞品主表'], [SKU_MAIN_TABLE_ID, 'SKU明细'], [OLD_COMPETITOR_TABLE_ID, '竞品周_2026-08-23_2026-08-29'],
    [OLD_SKU_TABLE_ID, 'SKU周_2026-08-23_2026-08-29'], [COMPETITOR_TABLE_ID, '竞品周_2026-08-23_2026-08-29_修复结构'], [SKU_TABLE_ID, 'SKU周_2026-08-23_2026-08-29_修复结构V2'],
  ]);
  for (const [tableId, name] of expected) if (tables.find((table) => table.tableId === tableId)?.name !== name) throw new Error(`Table identity mismatch: ${tableId}`);
  const [main, oldCompetitor, oldSku, targetCompetitor, targetSku] = await Promise.all([
    client.listRecords(MAIN_TABLE_ID), client.listRecords(OLD_COMPETITOR_TABLE_ID), client.listRecords(OLD_SKU_TABLE_ID),
    client.listRecords(COMPETITOR_TABLE_ID), client.listRecords(SKU_TABLE_ID),
  ]);
  if (targetSku.length) throw new Error(`SKU repair table must be empty: sku=${targetSku.length}`);
  if (targetCompetitor.length && targetCompetitor.length !== oldCompetitor.length) {
    throw new Error(`Competitor repair table has a partial write: competitor=${targetCompetitor.length}, expected=${oldCompetitor.length}`);
  }
  const mainFields = await client.listFields(MAIN_TABLE_ID);
  const competitorFieldsBefore = await client.listFields(COMPETITOR_TABLE_ID);
  const skuFieldsBefore = await client.listFields(SKU_TABLE_ID);
  const competitorMeta = await ensureFields(client, COMPETITOR_TABLE_ID, COMPETITOR_METADATA, apply);
  const skuMeta = await ensureFields(client, SKU_TABLE_ID, SKU_METADATA, apply);
  const competitorFields = apply ? await client.listFields(COMPETITOR_TABLE_ID) : [...competitorFieldsBefore, ...COMPETITOR_METADATA.map((field) => ({ fieldName: field.field_name, type: field.type, property: field.property }))];
  const skuFields = apply ? await client.listFields(SKU_TABLE_ID) : [...skuFieldsBefore, ...SKU_METADATA.map((field) => ({ fieldName: field.field_name, type: field.type, property: field.property }))];
  const mainMap = mainByProduct(main);
  const competitorPlan = buildCompetitorPlan({ source: oldCompetitor, main, targetFields: competitorFields, mainById: mainMap });
  const report = {
    mode: apply ? 'APPLYING' : 'DRY_RUN', period: { startDate: START_DATE, endDate: END_DATE },
    targets: { competitor: { tableId: COMPETITOR_TABLE_ID, before: targetCompetitor.length }, sku: { tableId: SKU_TABLE_ID, before: targetSku.length } },
    metadata: { competitor: competitorMeta, sku: skuMeta },
    competitor: {
      sourceRows: oldCompetitor.length,
      plannedRows: competitorPlan.rows.length,
      relationField: competitorPlan.relationField,
      missingMainLinks: competitorPlan.missingMain.length,
    },
  };
  if (!apply) {
    const skuPlan = buildSkuPlan({ source: oldSku, mainById: mainMap, competitorByProduct: new Map(competitorPlan.rows.map((row) => [row.productId, { recordId: `planned:${row.productId}` }])), targetFields: skuFields });
    report.sku = {
      sourceRows: oldSku.length,
      plannedRows: skuPlan.rows.length,
      relationFields: skuPlan.relationFields,
      missingLinks: skuPlan.missing.length,
      missingMainLinks: skuPlan.missing.filter((item) => item.missingMain).length,
      missingCompetitorLinks: skuPlan.missing.filter((item) => item.missingCompetitor).length,
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!targetCompetitor.length) await writeRows(client, COMPETITOR_TABLE_ID, competitorPlan.rows);
  const competitorAfter = await readByKey(client, COMPETITOR_TABLE_ID, '商品周期唯一键');
  assertKeySet(competitorAfter, competitorPlan.rows, '商品周期唯一键', 'Competitor repair table');
  if (competitorAfter.records.length !== competitorPlan.rows.length) throw new Error(`Competitor row count mismatch: ${competitorAfter.records.length}`);
  const competitorByProduct = new Map(competitorAfter.records.map((record) => [productId(record.fields ?? {}), record]));
  const skuPlan = buildSkuPlan({ source: oldSku, mainById: mainMap, competitorByProduct, targetFields: skuFields });
  await writeRows(client, SKU_TABLE_ID, skuPlan.rows);
  const skuAfter = await readByKey(client, SKU_TABLE_ID, 'SKU周期唯一键');
  if (skuAfter.records.length !== skuPlan.rows.length) throw new Error(`SKU row count mismatch: ${skuAfter.records.length}`);
  report.mode = 'APPLIED_AND_VERIFIED';
  report.competitor.after = competitorAfter.records.length;
  report.sku = {
    sourceRows: oldSku.length,
    plannedRows: skuPlan.rows.length,
    after: skuAfter.records.length,
    relationFields: skuPlan.relationFields,
    missingMainLinks: skuPlan.missing.filter((item) => item.missingMain).length,
    missingCompetitorLinks: skuPlan.missing.filter((item) => item.missingCompetitor).length,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
