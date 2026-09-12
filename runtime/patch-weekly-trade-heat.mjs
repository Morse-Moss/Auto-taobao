// Refresh the 交易热度 formula on a weekly keyword table after the TRADE_HIGH
// range set changed (35% ~ 40% and all 45%+ buckets were missing).
//
// The formula body hard-codes the range enumeration, so editing the JS set alone
// does NOT change an already-created Feishu field — the field must be re-PUT.
//
// Usage: node patch-weekly-trade-heat.mjs [--apply]
//   default is dry-run (prints old vs new formula).

import { readFileSync } from 'node:fs';

import { buildFormulaDefinitions } from './keyword-dual-table-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TARGET_TABLE = process.env.TARGET_TABLE ?? 'tblHJpDjwAyuHrTK';
const APPLY = process.argv.includes('--apply');

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
  }
  return env;
}

const env = readEnv('E:/小红书/.env.local');
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const token = auth.tenant_access_token;

async function api(path, init = {}) {
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const payload = await res.json();
  if (!res.ok || payload.code !== 0) {
    throw new Error(`API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${payload.code} ${payload.msg}`);
  }
  return payload.data ?? {};
}

const fields = [];
let pageToken;
let hasMore = true;
while (hasMore) {
  const query = pageToken ? `?page_token=${pageToken}&page_size=100` : '?page_size=100';
  const page = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TARGET_TABLE}/fields${query}`);
  fields.push(...(page.items ?? []));
  pageToken = page.page_token;
  hasMore = Boolean(pageToken) && Boolean(page.has_more);
}

const byName = new Map(fields.map((f) => [f.field_name, f]));
const trade = byName.get('交易热度');
const tradeRate = byName.get('支付转化率');
if (!trade) throw new Error('field 交易热度 not found');
if (!tradeRate) throw new Error('field 支付转化率 not found');

const { 交易热度: newFormula } = buildFormulaDefinitions({
  tableId: TARGET_TABLE,
  fieldIds: {
    搜索词: byName.get('搜索词')?.field_id ?? 'fldMissingSearch',
    搜索人气: byName.get('搜索人气')?.field_id ?? 'fldMissingPopularity',
    点击率: byName.get('点击率')?.field_id ?? 'fldMissingClick',
    支付转化率: tradeRate.field_id,
  },
});

console.log(`table    : ${TARGET_TABLE}`);
console.log(`field    : 交易热度 (${trade.field_id})`);
console.log(`old len  : ${String(trade.property?.formula_expression ?? '').length}`);
console.log(`new len  : ${newFormula.length}`);
console.log(`unchanged: ${trade.property?.formula_expression === newFormula}`);
console.log('--- new formula ---');
console.log(newFormula);

if (APPLY) {
  if (trade.property?.formula_expression === newFormula) {
    console.log('\n[dry] formula already up to date, nothing to write');
  } else {
    await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TARGET_TABLE}/fields/${trade.field_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field_name: '交易热度',
        type: trade.type,
        property: { ...trade.property, formula_expression: newFormula },
      }),
    });
    console.log('\n[apply] 交易热度 formula updated');
  }
} else {
  console.log('\n[dry-run] pass --apply to write');
}
