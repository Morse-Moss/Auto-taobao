#!/usr/bin/env node
// Read-only: which tables in the competitor base actually carry the V2 attribute
// classification fields (材质分类 / 外形 / 安装方式 / 功能 / 风格 / 适用空间)?
//
// Why: B-高价值竞品 depends on FIND("人造石",[材质分类]). If the field is empty the
// grade can never appear, no matter what the market did. Before blaming collection,
// establish which tables were ever classified.
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.PROBE_APP_TOKEN ?? 'QcnhbEzYpacGvUskCbVcrcm3nFd';
const ENV_FILE = process.env.PROBE_ENV_FILE ?? 'E:/小红书/.env.feishu-kcne.local';
const FIELDS = ['材质分类', '外形', '安装方式', '功能', '风格', '适用空间'];

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
const text = (v) => (Array.isArray(v) ? v.map((x) => x.text ?? x.name ?? x).join(' ') : String(v ?? ''));

const tables = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers }).then((r) => r.json());
if (tables.code !== 0) throw new Error(`list tables failed: ${tables.code} ${tables.msg}`);
const all = tables.data.items ?? [];

async function load(tableId) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${q}`, { headers }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`records failed for ${tableId}: ${page.code} ${page.msg}`);
    items.push(...(page.data.items ?? []));
    pageToken = page.data.has_more ? page.data.page_token : undefined;
  } while (pageToken);
  return items;
}

console.log(`base ${APP_TOKEN}，共 ${all.length} 张表\n`);
console.log('表名'.padEnd(34) + '行数'.padStart(6) + FIELDS.map((f) => f.padStart(8)).join('') + '  竞品分类有无');
for (const table of all) {
  const items = await load(table.table_id);
  if (!items.length) {
    console.log(`${table.name.slice(0, 32).padEnd(34)}${'0'.padStart(6)}  (空表)`);
    continue;
  }
  const keys = new Set(Object.keys(items[0].fields ?? {}));
  const counts = FIELDS.map((f) => {
    if (!keys.has(f)) return '—';
    const n = items.filter((i) => text(i.fields?.[f]).trim()).length;
    return `${n}/${items.length}`;
  });
  const hasKlass = keys.has('竞品分类');
  // For 竞品分类 we cannot read the formula value reliably on some field types, so only note presence.
  console.log(`${table.name.slice(0, 32).padEnd(34)}${String(items.length).padStart(6)}` + counts.map((c) => String(c).padStart(8)).join('') + `  ${hasKlass ? '有' : '无'}`);
}
