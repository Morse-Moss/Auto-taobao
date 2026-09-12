// Verify trade-heat / priority resolution for specific keywords on a weekly table.
// Usage: node verify-trade-heat-rows.mjs [--table tblXXX]

import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TARGET_TABLE = process.env.TARGET_TABLE ?? 'tblHJpDjwAyuHrTK';
const WATCH = ['泡澡缸', '德国汉斯hansinode小户型家用深泡浴缸坐式亚克力日式迷你浴盆', 'bette', '亚克力独立式浴缸'];

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

const dist = { 交易热度: {}, 优先级: {} };
const hits = [];
let scanned = 0;
let pageToken;
let hasMore = true;
while (hasMore) {
  const query = pageToken ? `?page_token=${pageToken}&page_size=200` : '?page_size=200';
  const page = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TARGET_TABLE}/records${query}`);
  for (const rec of page.items ?? []) {
    scanned += 1;
    const f = rec.fields ?? {};
    const trade = typeof f.交易热度 === 'string' ? f.交易热度 : JSON.stringify(f.交易热度 ?? '');
    const prio = typeof f.优先级 === 'string' ? f.优先级 : JSON.stringify(f.优先级 ?? '');
    dist.交易热度[trade] = (dist.交易热度[trade] ?? 0) + 1;
    dist.优先级[prio] = (dist.优先级[prio] ?? 0) + 1;
    const word = typeof f.搜索词 === 'string' ? f.搜索词 : (f.搜索词?.[0]?.text ?? '');
    if (WATCH.some((w) => word.includes(w))) {
      hits.push({ word, 人气: f.搜索人气, 转化: f.支付转化率, 交易热度: trade, 优先级: prio });
    }
  }
  pageToken = page.page_token;
  hasMore = Boolean(pageToken) && Boolean(page.has_more);
}

console.log(`table: ${TARGET_TABLE}  rows scanned: ${scanned}\n`);
console.log('交易热度 distribution:');
for (const [k, v] of Object.entries(dist.交易热度).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n优先级 distribution:');
for (const [k, v] of Object.entries(dist.优先级).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\nwatchlist rows:');
for (const h of hits) console.log(' ', JSON.stringify(h, null, 0));
