#!/usr/bin/env node
// Read-only: tally 竞品分类 distribution in a weekly competitor table.
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const TABLE_ID = process.env.WEEKLY_TABLE_ID ?? 'tbld2LVUhXBuIEwD';

function loadEnv() {
  const text = readFileSync('E:/小红书/.env.local', 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('env missing');
  return env;
}

async function main() {
  const env = loadEnv();
  const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then((r) => r.json());
  if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, 'Content-Type': 'application/json' };

  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const t0 = Date.now();
    const r = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${query}`, { headers })
      .then((r) => r.json());
    if (r.code !== 0) throw new Error(`list failed: ${r.code} ${r.msg}`);
    items.push(...(r.data.items ?? []));
    pageToken = r.data.has_more ? r.data.page_token : undefined;
    console.log(`page done: +${r.data.items?.length ?? 0} items, total=${items.length}, has_more=${Boolean(pageToken)}, ms=${Date.now() - t0}`);
  } while (pageToken);

  const tally = new Map();
  const ab = [];
  for (const it of items) {
    const raw = it.fields['竞品分类'];
    const label = Array.isArray(raw) ? raw.map((x) => x.text ?? x).join('') : String(raw ?? '(空)');
    tally.set(label, (tally.get(label) ?? 0) + 1);
    if (label.startsWith('A-') || label.startsWith('B-')) {
      ab.push({
        recordId: it.record_id,
        title: String(it.fields['商品标题'] ?? '').slice(0, 40),
        price: it.fields['价格'],
        monthly: it.fields['月收货人数计算值'],
        amount: it.fields['月收货金额'],
      });
    }
  }
  console.log(`total records: ${items.length}`);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k}: ${v}`);
  console.log(`A/B count: ${ab.length}`);
  for (const x of ab) console.log(JSON.stringify(x));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
