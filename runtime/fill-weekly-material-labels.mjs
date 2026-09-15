#!/usr/bin/env node
// Restore the missing weekly step: populate 材质分类 on a competitor-week table.
//
// Why this exists: B-高价值竞品 = FIND("人造石",[材质分类])>0 AND 月收货人数计算值>=10.
// The weekly tables are created by prepare-weekly-competitor-table.mjs, which clones the
// previous week's field SCHEMA only (and intentionally defers formula/lookup fields), so
// 材质分类 arrives as an empty column. Nothing in the weekly chain ever writes it:
//   - the import path does not touch attribute fields,
//   - migrate-competitor-v2-analysis.mjs writes sentinels only into 竞品主表 (aiRunTriggered=false),
//   - competitor-history-publish-core.mjs derives 材质分类 for the HISTORY table on the fly.
// Result: B has been structurally 0 for every week created this way.
//
// This step fills only blank cells, using the same deterministic rule the publish path
// already uses (selectFirstMaterial: title evidence, with PMMA/高分子/绮美石/可丽耐/杜邦石/
// 亚克力人造石 normalised to 人造石). It never overwrites a non-empty value, so it is
// re-runnable and cannot destroy curated data.
//
// Dry-run by default. Writing requires --apply plus a matching --confirm-app-token.
//
// Usage:
//   node runtime/fill-weekly-material-labels.mjs
//   node runtime/fill-weekly-material-labels.mjs --table-id tbllWI45sK0DfHpr
//   node runtime/fill-weekly-material-labels.mjs --apply --confirm-app-token <APP_TOKEN> \
//     --env-file "E:/小红书/.env.feishu-kcne.local"
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { selectFirstMaterial } from './competitor-visualization-core.mjs';
import { activeProfileName, competitorBaseToken, envFilePath } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = competitorBaseToken();
const WEEKLY_NAME = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const BATCH = 200;

function parseArgs(argv) {
  const options = { apply: false, tableId: '', envFile: envFilePath() ?? 'E:/小红书/.env.local', receipt: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (['--table-id', '--env-file', '--confirm-app-token', '--receipt'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.confirmAppToken !== APP_TOKEN) {
    throw new Error('--apply requires --confirm-app-token exactly equal to the active competitor base token');
  }
  return options;
}

function readEnv(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

const text = (value) => (Array.isArray(value)
  ? value.map((item) => item?.text ?? item?.name ?? item).join(',').trim()
  : String(value ?? '').trim());

const options = parseArgs(process.argv.slice(2));
const env = readEnv(options.envFile);
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

async function api(path, init) {
  const res = await fetch(`${API_ROOT}${path}`, { headers, ...init }).then((r) => r.json());
  if (res.code !== 0) throw new Error(`${path} -> ${res.code} ${res.msg}`);
  return res.data;
}

async function listRecords(tableId) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${query}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function resolveTable() {
  const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
  const weekly = (data.items ?? []).filter((table) => WEEKLY_NAME.test(table.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (options.tableId) {
    const found = (data.items ?? []).find((table) => table.table_id === options.tableId);
    if (!found) throw new Error(`table not found in the active base: ${options.tableId}`);
    return found;
  }
  if (!weekly.length) throw new Error('no 竞品周_* table found in the active base');
  return weekly[weekly.length - 1];
}

const table = await resolveTable();
const fields = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${table.table_id}/fields?page_size=200`);
const materialField = (fields.items ?? []).find((field) => field.field_name === '材质分类');
if (!materialField) throw new Error(`${table.name} has no 材质分类 field; create it before filling`);
if (materialField.type !== 1) {
  throw new Error(`${table.name}.材质分类 is type ${materialField.type}, expected 1 (Text). Refusing to guess the write shape.`);
}

const records = await listRecords(table.table_id);
const plan = [];
for (const record of records) {
  const current = text(record.fields?.['材质分类']);
  if (current) continue;
  const title = text(record.fields?.['商品标题']);
  if (!title) continue;
  plan.push({ recordId: record.record_id, title, derived: selectFirstMaterial(title) });
}

const distribution = new Map();
for (const item of plan) distribution.set(item.derived, (distribution.get(item.derived) ?? 0) + 1);
const monthly = (record) => {
  const raw = text(record.fields?.['月收货人数计算值']).replaceAll(',', '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};
const eligible = records.filter((record) => {
  const derived = text(record.fields?.['材质分类']) || selectFirstMaterial(text(record.fields?.['商品标题']));
  return derived.includes('人造石') && (monthly(record) ?? -1) >= 10;
});

console.log(`base profile = ${activeProfileName()} / ${APP_TOKEN}`);
console.log(`table = ${table.name} (${table.table_id})，共 ${records.length} 行`);
console.log(`材质分类 已填 ${records.length - plan.length} 行，待填 ${plan.length} 行`);
console.log('待填的推导分布: ' + [...distribution.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || '（无）');
console.log(`其中「人造石」${plan.filter((item) => item.derived === '人造石').length} 行`);
console.log(`\n补填后 B-高价值竞品 的条数（材质含人造石 且 人数>=10）: ${eligible.length}`);
for (const record of eligible) {
  console.log(`   m=${String(monthly(record)).padStart(4)}  ${text(record.fields?.['商品标题']).slice(0, 46)}`);
}
console.log('   （注意：A 由采集包决定，本步骤不改动 A；人数<80 的周补了材质也不会出现 A）');

const receipt = {
  mode: options.apply ? 'APPLIED' : 'DRY_RUN',
  at: new Date().toISOString(),
  profile: activeProfileName(),
  appToken: APP_TOKEN,
  table: { name: table.name, tableId: table.table_id },
  rows: records.length,
  alreadyFilled: records.length - plan.length,
  plannedWrites: plan.length,
  written: 0,
  distribution: Object.fromEntries(distribution),
  bCountAfterFill: eligible.length,
  rule: 'selectFirstMaterial(商品标题) — 与发布路径同一套确定性规则，不覆盖已有非空值',
};

if (!options.apply) {
  console.log('\nDRY-RUN：未写入任何内容。加 --apply --confirm-app-token 才执行。');
} else {
  let written = 0;
  for (let offset = 0; offset < plan.length; offset += BATCH) {
    const chunk = plan.slice(offset, offset + BATCH);
    await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${table.table_id}/records/batch_update`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk.map((item) => ({ record_id: item.recordId, fields: { 材质分类: item.derived } })) }),
    });
    written += chunk.length;
    console.log(`  已写入 ${written}/${plan.length}`);
  }
  const after = await listRecords(table.table_id);
  const stillBlank = after.filter((record) => !text(record.fields?.['材质分类'])).length;
  receipt.written = written;
  receipt.readBack = { rows: after.length, stillBlank };
  console.log(`\n回读：${after.length} 行，材质分类 仍为空 ${stillBlank} 行`);
  if (stillBlank !== records.length - plan.length) throw new Error('read-back mismatch: blank count changed unexpectedly');
  console.log('APPLIED_AND_VERIFIED');
}

if (options.receipt) {
  mkdirSync(dirname(options.receipt), { recursive: true });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`receipt -> ${options.receipt}`);
}
