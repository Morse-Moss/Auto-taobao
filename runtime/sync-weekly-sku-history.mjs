#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { latestWeeklyTable, weeklyTableName } from './weekly-table-target.mjs';
import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const PROFILE = activeProfileName();
const TARGET = {
  appToken: competitorBaseToken(PROFILE),
  skuTableId: tableId('skuDetail', PROFILE),
};

const HISTORY_FIELDS = [
  'SKU周期唯一键', 'SKU唯一键', '商品周期唯一键', '数据开始日期', '数据结束日期', '采集时间',
  '商品ID', '商品链接', '商品标题', '竞品分类', 'SKU名称', 'SKU规格', 'SKU尺寸', '尺寸汇总',
  '适用空间', '空间判定状态', '空间判定依据', '采集状态', '待补数据项', '来源证据哈希', '所属竞品记录ID',
];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? value.record_id ?? value.recordId ?? '');
  return String(value ?? '').trim();
}

function relationId(value) {
  if (Array.isArray(value)) return relationId(value[0]);
  if (value && typeof value === 'object') return text(value.record_id ?? value.recordId ?? value.record_ids?.[0] ?? '');
  return text(value);
}

function dateValue(value, name) {
  const match = String(value ?? '').trim().match(/^\d{4}-\d{2}-\d{2}$/u);
  if (!match) throw new Error(`${name} must use YYYY-MM-DD`);
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} is invalid`);
  return timestamp;
}

function sourceProductId(fields) {
  const direct = text(fields.商品ID);
  if (direct) return direct;
  const url = text(fields.商品链接);
  try { return new URL(url).searchParams.get('id') ?? ''; } catch { return ''; }
}

export function snapshotFields(record, { startDate, endDate, collectedAt, evidenceHash = '' }) {
  const source = record.fields ?? {};
  const uniqueKey = text(source.SKU唯一键);
  if (!uniqueKey) throw new Error(`SKU record ${record.recordId ?? record.record_id} has no SKU唯一键`);
  const productId = sourceProductId(source);
  if (!productId) throw new Error(`SKU ${uniqueKey} has no 商品ID`);
  const start = dateValue(startDate, 'startDate');
  const end = dateValue(endDate, 'endDate');
  const collected = collectedAt ? new Date(collectedAt).getTime() : Date.now();
  if (!Number.isFinite(collected)) throw new Error('collectedAt is invalid');
  const historyKey = `${uniqueKey}|${startDate}`;
  const fields = {
    'SKU周期唯一键': historyKey,
    'SKU唯一键': uniqueKey,
    '商品周期唯一键': `${productId}|${startDate}`,
    '数据开始日期': start,
    '数据结束日期': end,
    '采集时间': collected,
    '商品ID': productId,
    '商品链接': text(source.商品链接),
    '商品标题': text(source.商品标题),
    '竞品分类': text(source.竞品分类),
    'SKU名称': text(source.SKU名称),
    'SKU规格': text(source.SKU规格),
    'SKU尺寸': text(source.SKU尺寸),
    '尺寸汇总': text(source.尺寸汇总),
    '适用空间': text(source.适用空间),
    '空间判定状态': text(source.空间判定状态),
    '空间判定依据': text(source.空间判定依据),
    '采集状态': text(source.采集状态),
    '待补数据项': Array.isArray(source.待补数据项) ? source.待补数据项.map(text).filter(Boolean) : text(source.待补数据项).split(/[,，]/u).map((item) => item.trim()).filter(Boolean),
    '来源证据哈希': evidenceHash,
    '所属竞品记录ID': relationId(source.所属竞品),
  };
  return { historyKey, fields };
}

function comparableField(name, value) {
  if (value == null) return null;
  if (name === '数据开始日期' || name === '数据结束日期' || name === '采集时间') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => text(item)).filter(Boolean);
    return items.length > 0 ? items : null;
  }
  return text(value);
}

export function sameFields(left, right) {
  return HISTORY_FIELDS.every((name) => {
    // Collection time is run metadata. A same-week replay should not become
    // a data update merely because it was executed later.
    if (name === '采集时间') return true;
    return (
    JSON.stringify(comparableField(name, left?.[name]))
      === JSON.stringify(comparableField(name, right?.[name]))
    );
  });
}

export function buildSnapshotPlan({ skuRecords, historyRecords, startDate, endDate, collectedAt, evidenceHash = '' }) {
  const existing = new Map();
  for (const record of historyRecords ?? []) {
    const key = text(record.fields?.SKU周期唯一键);
    if (!key) continue;
    if (existing.has(key)) throw new Error(`Duplicate SKU周期唯一键 in history: ${key}`);
    existing.set(key, record);
  }
  const creates = [];
  const updates = [];
  const unchanged = [];
  const effectiveCollectedAt = collectedAt ?? new Date().toISOString();
  for (const sku of skuRecords ?? []) {
    const snapshot = snapshotFields(sku, {
      startDate,
      endDate,
      collectedAt: effectiveCollectedAt,
      evidenceHash,
    });
    const current = existing.get(snapshot.historyKey);
    if (!current) creates.push(snapshot.fields);
    else if (sameFields(current.fields, snapshot.fields)) unchanged.push(snapshot.historyKey);
    else updates.push({ recordId: current.recordId ?? current.record_id, fields: snapshot.fields });
  }
  return { summary: { sourceSkuRows: skuRecords?.length ?? 0, toCreate: creates.length, toUpdate: updates.length, unchanged: unchanged.length }, creates, updates, unchanged };
}

function parseEnv(textValue) {
  return Object.fromEntries(String(textValue).split(/\r?\n/u).flatMap((line) => {
    const value = line.trim(); const index = value.indexOf('=');
    if (!value || value.startsWith('#') || index < 1) return [];
    return [[value.slice(0, index).trim(), value.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '')]];
  }));
}

function arg(argv, name, required = true) {
  const index = argv.indexOf(name); const value = index >= 0 ? argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} requires a value`);
  return value;
}

export async function syncWeeklySkuHistory({ envFile = envFilePath(PROFILE), startDate, endDate, collectedAt, evidenceHash = '', targetTableId, apply = false } = {}) {
  if (!startDate || !endDate) throw new Error('startDate and endDate are required');
  const envPath = resolve(envFile);
  if (!existsSync(envPath)) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(envPath, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: TARGET.appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const target = targetTableId
    ? tables.find((table) => table.tableId === targetTableId)
    : tables.find((table) => table.name === weeklyTableName('SKU', startDate, endDate));
  if (!target || !target.name.startsWith('SKU周_')) throw new Error(`Weekly SKU table not found: ${weeklyTableName('SKU', startDate, endDate)}`);
  const [skuRecords, historyRecords] = await Promise.all([client.listRecords(TARGET.skuTableId), client.listRecords(target.tableId)]);
  const plan = buildSnapshotPlan({ skuRecords, historyRecords, startDate, endDate, collectedAt, evidenceHash });
  if (apply) {
    for (let index = 0; index < plan.creates.length; index += 500) await client.batchCreateRecords(target.tableId, plan.creates.slice(index, index + 500));
    for (let index = 0; index < plan.updates.length; index += 500) await client.batchUpdateRecords(target.tableId, plan.updates.slice(index, index + 500));
  }
  const after = apply ? await client.listRecords(target.tableId) : historyRecords;
  const keys = new Set(after.map((record) => text(record.fields?.SKU周期唯一键)).filter(Boolean));
  const expectedKeys = new Set([...plan.creates, ...plan.updates.map((item) => item.fields)].map((fields) => text(fields.SKU周期唯一键)));
  const verified = !apply || [...expectedKeys].every((key) => keys.has(key));
  if (apply && !verified) throw new Error('Weekly SKU table read-back is missing expected snapshot keys');
  return { mode: apply ? 'APPLIED_AND_VERIFIED' : 'DRY_RUN', target: { ...TARGET, weeklyTableId: target.tableId, weeklyTableName: target.name }, period: { startDate, endDate }, plan: plan.summary, historyRecordCountBefore: historyRecords.length, historyRecordCountAfter: after.length, verified };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  syncWeeklySkuHistory({
    envFile: arg(argv, '--env-file', false) ?? envFilePath(PROFILE),
    startDate: arg(argv, '--start-date'), endDate: arg(argv, '--end-date'),
    collectedAt: arg(argv, '--collected-at', false), evidenceHash: arg(argv, '--evidence-hash', false) ?? '', targetTableId: arg(argv, '--target-table-id', false), apply: argv.includes('--apply'),
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
