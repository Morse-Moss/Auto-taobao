#!/usr/bin/env node
// Read-only: validate the deterministic material derivation and preview its effect.
//
// Why: B-高价值竞品 needs 材质分类 to contain 人造石, and nothing in the weekly pipeline
// ever writes that field (the history publish derives it on the fly via
// selectFirstMaterial, the weekly table keeps it empty). Before writing anything into a
// live table, measure how faithful the derivation is against the one week that does have
// real stored values, then preview what it would change.
import { readFileSync } from 'node:fs';
import { selectFirstMaterial } from './competitor-visualization-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.PROBE_APP_TOKEN ?? 'QcnhbEzYpacGvUskCbVcrcm3nFd';
const ENV_FILE = process.env.PROBE_ENV_FILE ?? 'E:/小红书/.env.feishu-kcne.local';

const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/u)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
}
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
const text = (v) => (Array.isArray(v) ? v.map((x) => x.text ?? x.name ?? x).join(' ').trim() : String(v ?? '').trim());
const numeric = (v) => {
  const raw = text(v).replaceAll(',', '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

async function load(tableId) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${q}`, { headers }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`records failed: ${page.code} ${page.msg}`);
    items.push(...(page.data.items ?? []));
    pageToken = page.data.has_more ? page.data.page_token : undefined;
  } while (pageToken);
  return items;
}

// Default pair: the one week that carries real stored values (整表迁移) and the
// current week. `--table-id` (repeatable) overrides them so this probe stays
// usable next week instead of decaying into a hard-coded snapshot.
const DEFAULT_TABLE_IDS = ['tblDpoBCxUJmNBR7', 'tbllWI45sK0DfHpr'];
const requested = [];
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--table-id') {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--table-id requires a value');
    requested.push(value);
    index += 1;
  } else if (arg.startsWith('--table-id=')) {
    requested.push(arg.slice('--table-id='.length));
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}
const targetIds = requested.length ? requested : DEFAULT_TABLE_IDS;
const catalog = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers })
  .then((r) => r.json());
if (catalog.code !== 0) throw new Error(`list tables failed: ${catalog.code} ${catalog.msg}`);
const nameOf = (id) => (catalog.data.items ?? []).find((t) => t.table_id === id)?.name ?? id;
const TABLES = targetIds.map((id) => ({ label: nameOf(id), id }));

for (const t of TABLES) {
  const items = await load(t.id);
  const derived = items.map((i) => ({
    title: text(i.fields?.['商品标题']),
    stored: text(i.fields?.['材质分类']),
    guess: selectFirstMaterial(text(i.fields?.['商品标题'])),
    monthly: numeric(i.fields?.['月收货人数计算值']),
  }));
  const distribution = new Map();
  for (const d of derived) distribution.set(d.guess, (distribution.get(d.guess) ?? 0) + 1);
  const stone = derived.filter((d) => d.guess === '人造石');
  const stoneEligible = stone.filter((d) => (d.monthly ?? -1) >= 10);

  console.log(`\n=== ${t.label}  ${derived.length} 行`);
  console.log('  推导出的材质分布: ' + [...distribution.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`  推导 人造石: ${stone.length} 行；其中 人数>=10 的: ${stoneEligible.length} 行  ← 这将是补写后 B 的条数`);
  for (const d of stoneEligible.slice(0, 10)) console.log(`     m=${String(d.monthly).padStart(4)}  ${d.title.slice(0, 44)}`);

  const withStored = derived.filter((d) => d.stored);
  if (withStored.length) {
    const agree = withStored.filter((d) => d.stored === d.guess).length;
    console.log(`  与已存真值的可比对行: ${withStored.length}；推导一致 ${agree}（${(100 * agree / withStored.length).toFixed(1)}%）`);
    const mism = withStored.filter((d) => d.stored !== d.guess);
    const pairs = new Map();
    for (const d of mism) pairs.set(`${d.stored} → ${d.guess}`, (pairs.get(`${d.stored} → ${d.guess}`) ?? 0) + 1);
    console.log('  主要不一致（已存 → 推导）: ' + [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  '));
    const storedStone = withStored.filter((d) => d.stored.includes('人造石')).length;
    console.log(`  已存真值里含「人造石」的: ${storedStone} 行；推导给出的: ${withStored.filter((d) => d.guess === '人造石').length} 行`);
    for (const d of mism.filter((x) => x.stored.includes('人造石') || x.guess === '人造石').slice(0, 8)) {
      console.log(`     已存=${d.stored} 推导=${d.guess}  ${d.title.slice(0, 40)}`);
    }
  } else {
    console.log('  该表 材质分类 整列为空，无可比对真值');
  }
}
