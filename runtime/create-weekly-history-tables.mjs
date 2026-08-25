#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { weeklyTableName } from './weekly-table-target.mjs';

const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const KINDS = ['竞品', 'SKU'];

function parseEnv(raw) {
  return Object.fromEntries(String(raw).split(/\r?\n/u).flatMap((line) => {
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

function fieldName(field) { return field.fieldName ?? field.field_name; }
function cleanProperty(property) {
  if (!property || typeof property !== 'object') return undefined;
  const allowed = ['formatter', 'date_formatter', 'auto_fill', 'options', 'multiple', 'table_id', 'back_field_name'];
  const result = {};
  for (const key of allowed) if (property[key] !== undefined) result[key] = property[key];
  if (Array.isArray(result.options)) result.options = result.options.map((option) => ({ name: option.name, color: option.color })).filter((option) => option.name);
  return Object.keys(result).length ? result : undefined;
}

function definitions(fields) {
  return fields.filter((field) => fieldName(field) !== '文本').map((field) => ({
    field_name: fieldName(field), type: Number(field.type), ...(cleanProperty(field.property) ? { property: cleanProperty(field.property) } : {}),
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--apply')) throw new Error('Refusing to mutate Feishu without --apply');
  const startDate = arg(argv, '--start-date'); const endDate = arg(argv, '--end-date');
  const envFile = arg(argv, '--env-file', false) ?? DEFAULT_ENV_FILE;
  if (!existsSync(resolve(envFile))) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(resolve(envFile), 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const tables = await client.listTables();
  const results = [];
  for (const kind of KINDS) {
    const name = weeklyTableName(kind, startDate, endDate);
    if (tables.some((table) => table.name === name)) throw new Error(`Weekly table already exists: ${name}`);
    const source = tables.filter((table) => table.name.startsWith(`${kind === '竞品' ? '竞品周' : 'SKU周'}_`)).sort((a, b) => a.name.localeCompare(b.name)).at(-1);
    if (!source) throw new Error(`No existing ${kind} weekly table available as schema template`);
    const fields = await client.listFields(source.tableId);
    const data = await client.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables`, { table: { name, default_view_name: '全部记录', fields: definitions(fields) } });
    const tableId = data.table_id ?? data.table?.table_id;
    if (!tableId) throw new Error(`Feishu did not return table id for ${name}`);
    const verified = (await client.listTables()).find((table) => table.tableId === tableId && table.name === name);
    if (!verified) throw new Error(`Created weekly table did not read back: ${name}`);
    results.push({ kind, name, tableId, templateTableId: source.tableId, fieldCount: fields.length, recordCount: 0 });
  }
  console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', period: { startDate, endDate }, tables: results }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
