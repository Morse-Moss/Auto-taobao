#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const WEEKLY_TABLE_ID = 'tblSS5bxyIeXgngI';
const MAIN_TABLE_ID = 'tblJ9LHFN6pMVjPv';
const SKU_WEEKLY_TABLE_ID = 'tblSgYvJzGBxzEBO';
const ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_CSV = 'runtime/latest-competitor-1-40-20260824.csv';
const DEFAULT_MANIFEST = 'runtime/repair-weekly-images/manifest.json';

const RAW_FIELDS = [
  '序号', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数', '平台', '占位类型',
  '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点', '搜索关键词',
];

function parseEnv(raw) {
  return Object.fromEntries(String(raw).split(/\r?\n/u).flatMap((line) => {
    const value = line.trim(); const index = value.indexOf('=');
    if (!value || value.startsWith('#') || index < 1) return [];
    return [[value.slice(0, index).trim(), value.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '')]];
  }));
}

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/u, '')); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter((item) => item.some((value) => String(value ?? '').trim())).map((item) => Object.fromEntries(headers.map((h, i) => [h, item[i] ?? ''])));
}

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('');
  if (typeof value === 'object') return text(value.text ?? value.value ?? value.link ?? value.url ?? '');
  return String(value).trim();
}

function productId(url) { return text(url).match(/[?&]id=(\d+)/u)?.[1] ?? ''; }
function numberOrText(value) {
  const source = text(value);
  if (!source || source === '-') return source;
  const n = Number(source.replaceAll(',', ''));
  return Number.isFinite(n) ? n : source;
}
function parseArgs(argv) {
  const value = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  return { apply: argv.includes('--apply'), csv: value('--csv', DEFAULT_CSV), manifest: value('--manifest', DEFAULT_MANIFEST), envFile: value('--env-file', ENV_FILE) };
}
function fieldName(field) { return field.fieldName ?? field.field_name; }

async function addTextField(client, tableId, fields, name) {
  if (fields.some((field) => fieldName(field) === name)) return fields;
  await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, { field_name: name, type: 1 });
  return client.listFields(tableId);
}
async function batchUpdate(client, tableId, records) {
  for (let i = 0; i < records.length; i += 500) await client.batchUpdateRecords(tableId, records.slice(i, i + 500));
}
async function batchCreate(client, tableId, fields) {
  for (let i = 0; i < fields.length; i += 500) await client.batchCreateRecords(tableId, fields.slice(i, i + 500));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) throw new Error('Refusing to mutate Feishu without --apply');
  if (!existsSync(resolve(options.csv)) || !existsSync(resolve(options.manifest))) throw new Error('Source CSV or image manifest is unavailable');
  const env = parseEnv(await readFile(resolve(options.envFile), 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const tables = await client.listTables();
  if (tables.find((table) => table.tableId === WEEKLY_TABLE_ID)?.name !== '竞品周_2026-08-23_2026-08-29') throw new Error('Weekly table identity mismatch');
  if (tables.find((table) => table.tableId === MAIN_TABLE_ID)?.name !== '竞品主表') throw new Error('Main table identity mismatch');

  const sourceRows = parseCsv(await readFile(resolve(options.csv), 'utf8').then((value) => value.replace(/^\uFEFF/u, '')));
  const manifest = JSON.parse(await readFile(resolve(options.manifest), 'utf8'));
  if (sourceRows.length !== 1461 || !Array.isArray(manifest.images) || manifest.images.length < 1) throw new Error(`Expected 1461 CSV rows and an image manifest, got csv=${sourceRows.length}`);
  const imageByRow = new Map(manifest.images.map((image) => [Number(image.row), image.path]));
  const [weeklyBefore, mainBefore] = await Promise.all([client.listRecords(WEEKLY_TABLE_ID), client.listRecords(MAIN_TABLE_ID)]);
  if (weeklyBefore.length !== 1461) throw new Error(`Unexpected weekly row count: ${weeklyBefore.length}`);

  let weeklyFields = await client.listFields(WEEKLY_TABLE_ID);
  weeklyFields = await addTextField(client, WEEKLY_TABLE_ID, weeklyFields, '商品ID');
  weeklyFields = await addTextField(client, WEEKLY_TABLE_ID, weeklyFields, '主表记录ID');
  const weeklyByKey = new Map(weeklyBefore.map((record) => [text(record.fields?.商品周期唯一键), record]));
  const mainByProduct = new Map(mainBefore.map((record) => [productId(record.fields?.商品链接), record]));
  const updates = []; let uploadedImages = 0;
  const imageTokenByProduct = new Map();
  for (let index = 0; index < sourceRows.length; index += 1) {
    const source = sourceRows[index]; const pid = productId(source.商品链接); const key = `${pid}|2026-08-23`;
    const target = weeklyByKey.get(key);
    if (!target) throw new Error(`Weekly record missing for ${key}`);
    const fields = Object.fromEntries(RAW_FIELDS.map((name) => [name, source[name]]));
    fields.序号 = source.序号; fields.价格 = numberOrText(source.价格); fields.同款数 = text(source.同款数);
    fields.商品链接 = source.商品链接; fields.商品ID = pid;
    const currentImage = target.fields?.商品图片;
    if (!(Array.isArray(currentImage) && currentImage.length > 0)) {
      const imagePath = imageByRow.get(index + 2);
      let token = imageTokenByProduct.get(pid);
      if (!token) {
        let name; let bytes;
        if (imagePath && existsSync(imagePath)) {
          name = imagePath.split(/[\\/]/u).pop(); bytes = await readFile(imagePath);
        } else {
          const response = await fetch(source.商品图片);
          if (!response.ok) throw new Error(`Image download failed for source row ${index + 1}: ${response.status}`);
          bytes = Buffer.from(await response.arrayBuffer());
          name = `row-${String(index + 1).padStart(6, '0')}.jpg`;
        }
        token = await client.uploadFile({ name, bytes }); imageTokenByProduct.set(pid, token); uploadedImages += 1;
      }
      fields.商品图片 = [{ file_token: token }];
    }
    updates.push({ recordId: target.recordId, fields });
  }
  await batchUpdate(client, WEEKLY_TABLE_ID, updates);
  const weeklyAfter = await client.listRecords(WEEKLY_TABLE_ID);
  const weeklyByProduct = new Map(weeklyAfter.map((record) => [productId(record.fields?.商品链接), record]));
  if (weeklyAfter.length !== 1461 || new Set(weeklyAfter.map((r) => text(r.fields?.商品ID))).size !== 1461 || weeklyAfter.some((r) => !Array.isArray(r.fields?.商品图片) || r.fields.商品图片.length < 1)) throw new Error('Weekly repair verification failed');

  const mainFields = await client.listFields(MAIN_TABLE_ID);
  const mainFieldNames = new Set(mainFields.map(fieldName));
  if (!mainFieldNames.has('商品ID')) await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE_ID}/fields`, { field_name: '商品ID', type: 1 });
  const mainHasStatus = mainFieldNames.has('当前周状态');
  if (!mainHasStatus) await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE_ID}/fields`, { field_name: '当前周状态', type: 1 });
  const mainCreates = []; const mainUpdates = []; const seen = new Set();
  for (const [pid, weekly] of weeklyByProduct) {
    if (seen.has(pid)) throw new Error(`Duplicate weekly product ID: ${pid}`); seen.add(pid);
    const source = weekly.fields ?? {}; const fields = {};
    for (const name of RAW_FIELDS) if (name !== '序号' && source[name] !== undefined) fields[name] = source[name];
    fields.序号 = text(source.序号); fields.价格 = numberOrText(source.价格); fields.商品ID = pid; fields.当前周状态 = '本周出现';
    if (Array.isArray(source.商品图片) && source.商品图片.length) fields.商品图片 = source.商品图片;
    const existing = mainByProduct.get(pid);
    if (existing) mainUpdates.push({ recordId: existing.recordId, fields }); else mainCreates.push(fields);
  }
  const currentProducts = new Set(weeklyByProduct.keys());
  for (const [pid, record] of mainByProduct) if (!currentProducts.has(pid)) mainUpdates.push({ recordId: record.recordId, fields: { 当前周状态: '本周未出现' } });
  await batchCreate(client, MAIN_TABLE_ID, mainCreates); await batchUpdate(client, MAIN_TABLE_ID, mainUpdates);
  const mainAfter = await client.listRecords(MAIN_TABLE_ID);
  const mainAfterByProduct = new Map(mainAfter.map((record) => [productId(record.fields?.商品链接), record]));
  if (mainAfterByProduct.size !== 2004 || [...weeklyByProduct.keys()].some((pid) => !mainAfterByProduct.has(pid))) throw new Error(`Main sync verification failed: ${mainAfterByProduct.size}`);
  const linkUpdates = [];
  for (const [pid, weekly] of weeklyByProduct) linkUpdates.push({ recordId: weekly.recordId, fields: { 主表记录ID: mainAfterByProduct.get(pid).recordId } });
  await batchUpdate(client, WEEKLY_TABLE_ID, linkUpdates);
  console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', sourceRows: sourceRows.length, weeklyRows: weeklyAfter.length, uploadedImages, mainBefore: mainBefore.length, mainCreated: mainCreates.length, mainUpdated: mainUpdates.length, mainAfter: mainAfter.length, weeklyProductsLinkedToMain: linkUpdates.length }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
