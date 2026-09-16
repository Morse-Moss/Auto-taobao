#!/usr/bin/env node
// 竞品周表「规则列」写回 —— 补上整条周更链里唯一缺失的写入方。
//
// 背景（2026-09-16 实测，见 docs/ops/P0-ATTRIBUTE-WRITEBACK-DIAGNOSIS.md）：
//   周表由建表脚本克隆字段架构而来，属性列落地即空列；而口径函数早已存在于
//   skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs，buildCompetitorRecord
//   一次就能把 5 列属性 + A/B/C/D + 尺寸 + 适用空间 + 数据状态 + 待补数据项全算完
//   —— 缺的只是「有人把它写进周表」。
//
// 本脚本写 10 列（都只填空、绝不覆盖，可重复执行）：
//   1. 搜索关键词   —— 常量（--search-keyword，默认「浴缸」）。
//      采集合同 XWS_HEADERS 只有 16 列、物理上不含此列，所以周表落地即空；
//      而 sync-latest-ab-to-main-core.mjs 明确 fail-closed：
//      `if (!fields.搜索关键词) throw new Error('Latest competitor row requires a search keyword')`。
//      本列不是装饰：它空 → 周表 A/B 永远同步不进主表 → 主表指标陈旧 → 主表分类与周表不一致
//      → 第 6 步 SKU 富化（要求主表 A/B）找不到合格候选。
//   2. 材质分类/外形/安装方式/功能/风格 —— buildCompetitorRecord（与飞书评级公式同源）。
//   3. 尺寸/适用空间 —— 优先取 SKU明细 按「商品标题」聚合（与主表 Lookup 同源同形态），
//      无 SKU 行时回落 buildCompetitorRecord 的标题规则判定。
//   4. 数据状态/待补数据项 —— buildCompetitorRecord（主表上这两个是公式，周表建不了 Lookup
//      导致的死锁见 runtime/create-weekly-formula-fields.mjs 的 RULE_FILLED_TEXT）。
//
// 线上这些列均为 Text(type 1)，多值以英文逗号连接（与 08-23 基准周真值格式一致）。
//
// 默认 dry-run。写入需 --apply 且 --confirm-app-token 与当前 base token 完全一致。
//
// 用法：
//   node runtime/fill-weekly-attribute-labels.mjs
//   node runtime/fill-weekly-attribute-labels.mjs --table-id tbllWI45sK0DfHpr
//   node runtime/fill-weekly-attribute-labels.mjs --apply \
//     --confirm-app-token QcnhbEzYpacGvUskCbVcrcm3nFd --env-file "E:/小红书/.env.feishu-kcne.local" \
//     --receipt "evidence/attribute-writeback-<week>.receipt.json"
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCompetitorRecord } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';
import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = competitorBaseToken();
const ATTRS = ['材质分类', '外形', '安装方式', '功能', '风格'];
const DERIVED = ['尺寸', '适用空间', '数据状态', '待补数据项'];
const KEYWORD_FIELD = '搜索关键词';
const WEEKLY_NAME = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const BATCH = 200;
const DEFAULT_KEYWORD = '浴缸';

function parseArgs(argv) {
  const options = {
    apply: false, tableId: '', envFile: envFilePath() ?? 'E:/小红书/.env.local',
    receipt: '', searchKeyword: DEFAULT_KEYWORD,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (['--table-id', '--env-file', '--confirm-app-token', '--receipt', '--search-keyword'].includes(arg)) {
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

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).join(',').trim();
  if (typeof value === 'object') return text(value.text ?? value.value ?? value.name);
  return String(value).trim();
};

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
  const all = data.items ?? [];
  if (options.tableId) {
    const found = all.find((table) => table.table_id === options.tableId);
    if (!found) throw new Error(`table not found in the active base: ${options.tableId}`);
    return { table: found, all };
  }
  const weekly = all.filter((table) => WEEKLY_NAME.test(table.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!weekly.length) throw new Error('no 竞品周_* table found in the active base');
  return { table: weekly[weekly.length - 1], all };
}

const { table, all } = await resolveTable();
const fields = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${table.table_id}/fields?page_size=200`);
const byName = new Map((fields.items ?? []).map((field) => [field.field_name, field]));

function assertText(name, required) {
  const field = byName.get(name);
  if (!field) {
    if (required) throw new Error(`${table.name} 缺字段 ${name}；先补齐字段再写值`);
    return null;
  }
  if (field.type !== 1) {
    throw new Error(`${table.name}.${name} is type ${field.type}, expected 1 (Text). Refusing to guess the write shape.`);
  }
  return field;
}

for (const attr of ATTRS) assertText(attr, true);
const derivedPresent = DERIVED.filter((name) => assertText(name, false));
const keywordPresent = assertText(KEYWORD_FIELD, false) ? true : false;
if (!derivedPresent.length && !keywordPresent) {
  console.log(`提示：${table.name} 上既无 ${KEYWORD_FIELD} 也无规则列，本脚本只会重写已有列。`);
}

// SKU明细 按「商品标题」聚合：尺寸取 SKU尺寸（与主表 Lookup 同源），适用空间取 SKU 判定值。
const skuByTitle = new Map();
const skuTableId = tableId('skuDetail');
const skuTableExists = all.some((entry) => entry.table_id === skuTableId);
if (skuTableExists) {
  for (const record of await listRecords(skuTableId)) {
    const title = text(record.fields?.['商品标题']);
    if (!title) continue;
    const bucket = skuByTitle.get(title) ?? { sizes: new Set(), spaces: new Set() };
    for (const size of [text(record.fields?.['SKU尺寸']), text(record.fields?.['尺寸汇总'])]) {
      if (size && size !== '无注明') bucket.sizes.add(size);
    }
    for (const space of [text(record.fields?.['适用空间'])]) {
      if (space && space !== '无注明') bucket.spaces.add(space);
    }
    skuByTitle.set(title, bucket);
  }
}

const records = await listRecords(table.table_id);
const COLUMNS = [...ATTRS, ...derivedPresent];
if (keywordPresent) COLUMNS.push(KEYWORD_FIELD);
const stats = new Map(COLUMNS.map((name) => [name, { filled: 0, none: 0, na: 0, skipped: 0, skuBacked: 0 }]));
const plan = [];

for (const record of records) {
  const f = record.fields ?? {};
  const row = {
    商品标题: text(f['商品标题']),
    价格: text(f['价格']),
    是否有效竞品: text(f['是否有效竞品']),
    月收货人数: text(f['月收货人数']),
    卖点: text(f['卖点']),
  };
  const built = buildCompetitorRecord(row, { searchKeyword: text(f[KEYWORD_FIELD]) || options.searchKeyword });
  const sku = skuByTitle.get(row.商品标题);
  const values = {};
  for (const attr of ATTRS) values[attr] = Array.isArray(built[attr]) ? built[attr].join(',') : text(built[attr]);
  for (const name of derivedPresent) {
    if (name === '尺寸') {
      values[name] = sku?.sizes.size
        ? [...sku.sizes].join(',')
        : (Array.isArray(built.尺寸) ? built.尺寸.join(',') : text(built.尺寸));
    } else if (name === '适用空间') {
      values[name] = sku?.spaces.size
        ? [...sku.spaces].join(',')
        : (Array.isArray(built.适用空间) ? built.适用空间.join(',') : text(built.适用空间));
    } else {
      values[name] = Array.isArray(built[name]) ? built[name].join(',') : text(built[name]);
    }
  }
  if (keywordPresent) values[KEYWORD_FIELD] = options.searchKeyword;

  const patch = {};
  for (const name of COLUMNS) {
    if (text(f[name])) { stats.get(name).skipped += 1; continue; } // 已有值，不覆盖
    const value = values[name];
    if (!value) continue;
    patch[name] = value;
    const bucket = stats.get(name);
    if (value.includes('不适用')) bucket.na += 1;
    else if (value.includes('无注明')) bucket.none += 1;
    else bucket.filled += 1;
    if ((name === '尺寸' || name === '适用空间') && sku && ((name === '尺寸' && sku.sizes.size) || (name === '适用空间' && sku.spaces.size))) {
      bucket.skuBacked += 1;
    }
  }
  if (Object.keys(patch).length) plan.push({ recordId: record.record_id, title: row.商品标题, patch, klass: built.竞品分类 });
}

const klass = new Map();
for (const item of plan) klass.set(item.klass, (klass.get(item.klass) ?? 0) + 1);

console.log(`base profile = ${activeProfileName()} / ${APP_TOKEN}`);
console.log(`table = ${table.name} (${table.table_id})，共 ${records.length} 行`);
console.log(`字段在场：属性 5，规则列 ${derivedPresent.length}/${DERIVED.length}${derivedPresent.length < DERIVED.length ? `（缺 ${DERIVED.filter((n) => !derivedPresent.includes(n)).join(',')}）` : ''}，${KEYWORD_FIELD} ${keywordPresent ? '有' : '无'}`);
console.log(`搜索关键词写入值 = ${options.searchKeyword}`);
console.log(`SKU明细聚合源 = ${skuTableExists ? `${skuTableId}（${skuByTitle.size} 个商品标题）` : '不可用（未在 base 中找到该表）'}`);
console.log(`将写入的行数 = ${plan.length}（每行只写当前为空的列）`);
console.log('各列预计：');
for (const name of COLUMNS) {
  const c = stats.get(name);
  const rate = ((100 * c.filled) / records.length).toFixed(1);
  const skuNote = (name === '尺寸' || name === '适用空间') ? `   SKU来源 ${c.skuBacked}` : '';
  console.log(`  ${name.padEnd(6)} 有值 ${String(c.filled).padStart(5)} (${rate}%)   无注明 ${String(c.none).padStart(5)}   不适用 ${String(c.na).padStart(3)}   已存跳过 ${String(c.skipped).padStart(5)}${skuNote}`);
}
console.log(`写入后 竞品分类 分布（预期）：${[...klass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);

const receipt = {
  version: 'weekly-rule-column-writeback-v2',
  mode: options.apply ? 'APPLIED' : 'DRY_RUN',
  at: new Date().toISOString(),
  profile: activeProfileName(),
  appToken: APP_TOKEN,
  table: { name: table.name, tableId: table.table_id },
  searchKeyword: options.searchKeyword,
  columns: COLUMNS,
  rows: records.length,
  plannedRows: plan.length,
  written: 0,
  perColumn: Object.fromEntries([...stats.entries()].map(([k, v]) => [k, v])),
  expectedClassAfter: Object.fromEntries(klass),
  rule: 'buildCompetitorRecord（与飞书评级公式同源）；尺寸/适用空间 优先 SKU明细 按商品标题聚合（与主表 Lookup 同源），否则回落标题规则；Text 多值逗号连接；只填空不覆盖',
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
      body: JSON.stringify({ records: chunk.map((item) => ({ record_id: item.recordId, fields: item.patch })) }),
    });
    written += chunk.length;
    console.log(`  已写入 ${written}/${plan.length}`);
  }
  const after = await listRecords(table.table_id);
  const stillBlank = {};
  for (const name of COLUMNS) stillBlank[name] = after.filter((r) => !text(r.fields?.[name])).length;
  receipt.written = written;
  receipt.readBack = { rows: after.length, stillBlank };
  console.log(`\n回读：${after.length} 行；各列仍为空 ${COLUMNS.map((n) => `${n}=${stillBlank[n]}`).join(' ')}`);
  for (const name of COLUMNS) {
    const expected = records.filter((r) => text(r.fields?.[name])).length + stats.get(name).filled
      + stats.get(name).none + stats.get(name).na;
    if (stillBlank[name] !== records.length - expected) {
      throw new Error(`read-back mismatch on ${name}: blank=${stillBlank[name]}, expected=${records.length - expected}`);
    }
  }
  console.log('APPLIED_AND_VERIFIED');
}

if (options.receipt) {
  mkdirSync(dirname(options.receipt), { recursive: true });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`receipt -> ${options.receipt}`);
}
