#!/usr/bin/env node
// 竞品周表「商品ID」补写 —— 把链接里已经存在的商品 id 落到这一列上。
//
// 这一列空着不是「链接不够用」，而是**没有写入方**，所以本脚本只做一件事：
// 从 `商品链接` 提出 id 写进 `商品ID`。判据全在 fill-weekly-product-id-core.mjs（有测试守着）。
//
// 三条边界（别在这里放宽）：
//   1) **只填空**。已有值一律不覆盖 —— 这一列是跨表联结键的原料（SKU唯一键 = 商品ID|SKU ID），
//      覆盖一次就可能把某行接到另一个商品上，而且是静默的。
//   2) 已有值与链接 id 不一致的行**不写、但要报**（conflict）；链接提不出 id 的行单独计数（noId）。
//      两种都不许并进「已填」。
//   3) 只写这一列。不碰任何属性列、不碰主表、不碰 SKU明细、不碰历史总表。
//
// 默认 dry-run。真写要 `--apply` 且 `--confirm-app-token` 与当前 base token 完全一致
// （与 fill-weekly-attribute-labels.mjs 同一口径：表名可以重名，只报名字不算确认）。
//
// 用法：
//   node runtime/fill-weekly-product-id.mjs
//   node runtime/fill-weekly-product-id.mjs --table-id tbllWI45sK0DfHpr
//   node runtime/fill-weekly-product-id.mjs --apply \
//     --confirm-app-token <base token> \
//     --env-file "E:/小红书/.env.feishu-kcne.local" \
//     --receipt "evidence/product-id-backfill-<date>/receipt.json"
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { activeProfileName, competitorBaseToken, envFilePath } from './feishu-targets.mjs';
import { judgeProductIdBackfill, normalizeCell, planProductIdFills } from './fill-weekly-product-id-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = competitorBaseToken();
const FIELD = '商品ID';
const LINK_FIELD = '商品链接';
const WEEKLY_NAME = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const BATCH = 200;

function parseArgs(argv) {
  const options = {
    apply: false, tableId: '', envFile: envFilePath() ?? 'E:/小红书/.env.local', receipt: '', confirmAppToken: '',
  };
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

const options = parseArgs(process.argv.slice(2));
const env = readEnv(options.envFile);
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((response) => response.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

async function api(path, init) {
  const response = await fetch(`${API_ROOT}${path}`, { headers, ...init }).then((item) => item.json());
  if (response.code !== 0) throw new Error(`${path} -> ${response.code} ${response.msg}`);
  return response.data;
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
  const all = data.items ?? [];
  if (options.tableId) {
    const found = all.find((table) => table.table_id === options.tableId);
    if (!found) throw new Error(`table not found in the active base: ${options.tableId}`);
    return found;
  }
  const weekly = all.filter((table) => WEEKLY_NAME.test(table.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!weekly.length) throw new Error('no 竞品周_* table found in the active base');
  return weekly[weekly.length - 1];
}

const table = await resolveTable();
const fields = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${table.table_id}/fields?page_size=200`);
const byName = new Map((fields.items ?? []).map((field) => [field.field_name, field]));

// 字段类型必须自己核一遍：这一列是 Text 才写字符串。类型不对就停 —— 猜写入形状的代价
// 是「写了但读回来是另一回事」，比不写更糟。
for (const [name, required] of [[FIELD, true], [LINK_FIELD, true]]) {
  const field = byName.get(name);
  if (!field) {
    if (required) throw new Error(`${table.name} 缺字段 ${name}；先补齐字段再写值`);
    continue;
  }
  if (field.type !== 1) {
    throw new Error(`${table.name}.${name} is type ${field.type}, expected 1 (Text). Refusing to guess the write shape.`);
  }
}

const records = await listRecords(table.table_id);
const rows = records.map((record) => ({
  recordId: record.record_id,
  existing: normalizeCell(record.fields?.[FIELD]),
  link: normalizeCell(record.fields?.[LINK_FIELD]),
}));
const { updates, stats } = planProductIdFills(rows);

console.log(`base profile = ${activeProfileName()} / ${APP_TOKEN}`);
console.log(`table = ${table.name} (${table.table_id})，共 ${records.length} 行`);
console.log(`字段在场：${FIELD} Text(1) ✓，${LINK_FIELD} Text(1) ✓`);
console.log(`将写入的行数 = ${updates.length}（只填空）`);
console.log(`已有值且与链接一致 = ${stats.alreadyCorrect}`);
console.log(`已有值与链接不一致 = ${stats.conflictCount}${stats.conflictCount ? `  ${stats.conflict.slice(0, 5).map((item) => `${item.recordId}:${item.existing}!=${item.derived}`).join('  ')}` : ''}`);
console.log(`链接提不出 id = ${stats.noIdCount}${stats.noIdCount ? `  ${stats.noId.slice(0, 5).map((item) => item.recordId).join('  ')}` : ''}`);

const receipt = {
  version: 'weekly-product-id-backfill-v1',
  mode: options.apply ? 'APPLIED' : 'DRY_RUN',
  at: new Date().toISOString(),
  profile: activeProfileName(),
  appToken: APP_TOKEN,
  table: { name: table.name, tableId: table.table_id },
  column: FIELD,
  rule: '商品链接 → 商品 id（extractProductId，与 fill-weekly-attribute-labels-core 同一实现）；只填空、已有值不覆盖、不一致只报不改、提不出 id 单独计数',
  rows: records.length,
  plannedRows: updates.length,
  written: 0,
  perBucket: {
    filled: stats.filled, alreadyCorrect: stats.alreadyCorrect,
    conflictCount: stats.conflictCount, noIdCount: stats.noIdCount,
  },
  conflict: stats.conflict,
  noId: stats.noId,
};

// 收据先落盘、再判成败顺序不能反：读回不一致时如果先抛，收据就没了 ——
// 而那种时刻恰恰是最需要现场的时候（同仓踩过「报成功、表内容一字未变」）。
function saveReceipt() {
  if (!options.receipt) return;
  mkdirSync(dirname(options.receipt), { recursive: true });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`receipt -> ${options.receipt}`);
}

if (!options.apply) {
  console.log('\nDRY-RUN：未写入任何内容。加 --apply --confirm-app-token 才执行。');
  saveReceipt();
} else {
  let written = 0;
  for (let offset = 0; offset < updates.length; offset += BATCH) {
    const chunk = updates.slice(offset, offset + BATCH);
    await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${table.table_id}/records/batch_update`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk.map((item) => ({ record_id: item.recordId, fields: { [FIELD]: item.productId } })) }),
    });
    written += chunk.length;
    console.log(`  已写入 ${written}/${updates.length}`);
  }

  const after = await listRecords(table.table_id);
  const blanksAfter = after.filter((record) => !normalizeCell(record.fields?.[FIELD])).length;
  const verdict = judgeProductIdBackfill({ stats, blanksAfter, rowsAfter: after.length });
  receipt.written = written;
  receipt.readBack = { rows: after.length, blanksAfter, expectedBlanks: verdict.expected, ok: verdict.ok };
  console.log(`\n回读：${after.length} 行；${FIELD} 仍为空 ${blanksAfter} 格（预期 ${verdict.expected}）`);
  saveReceipt();
  if (!verdict.ok) throw new Error(`read-back mismatch: ${verdict.detail}`);
  console.log('APPLIED_AND_VERIFIED');
}
