#!/usr/bin/env node
// Read-only audit of the A/B classification criteria against real weekly data.
//
// Why this exists: "A/B 都是 0" gets explained away as market noise every time.
// This script walks the actual formula inputs (月收货人数计算值 / 月收货金额 /
// 材质 / 客单价带分类) for every 竞品周_* table and shows, item by item, which
// threshold each near-miss candidate failed. It answers "是真实没有，还是判据
// 的输入根本没采到" with numbers instead of opinion.
//
// Usage:
//   node runtime/diagnose-weekly-ab-criteria.mjs
//   PROBE_TOP_N=15 node runtime/diagnose-weekly-ab-criteria.mjs
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.PROBE_APP_TOKEN ?? 'QcnhbEzYpacGvUskCbVcrcm3nFd';
const ENV_FILE = process.env.PROBE_ENV_FILE ?? 'E:/小红书/.env.feishu-kcne.local';
const TOP_N = Number.parseInt(process.env.PROBE_TOP_N ?? '10', 10);
const ONLY_TABLE = process.env.PROBE_TABLE_ID ?? '';

const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/u)) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
}
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

const text = (value) => (Array.isArray(value) ? value.map((x) => x.text ?? x.name ?? x).join(' ') : String(value ?? ''));
const num = (value) => {
  const raw = Array.isArray(value) ? value.map((x) => x.text ?? x).join('') : String(value ?? '');
  const parsed = Number.parseFloat(raw.replace(/[^0-9.\-]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const day = (value) => (typeof value === 'number' ? new Date(value + 8 * 3600 * 1000).toISOString().slice(0, 10) : String(value ?? ''));

const res = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers }).then((r) => r.json());
if (res.code !== 0) throw new Error(`list tables failed: ${res.code} ${res.msg}`);
const tables = (res.data.items ?? [])
  .filter((t) => /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u.test(t.name))
  .filter((t) => (ONLY_TABLE ? t.table_id === ONLY_TABLE : true))
  .map((t) => ({ tableId: t.table_id, name: t.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

async function load(tableId) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${query}`, { headers }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`records failed: ${page.code} ${page.msg}`);
    items.push(...(page.data.items ?? []));
    pageToken = page.data.has_more ? page.data.page_token : undefined;
  } while (pageToken);
  return items;
}

let printedKeys = false;
let printedRaw = false;

for (const table of tables) {
  const items = await load(table.tableId);
  if (!printedKeys && items.length) {
    console.log(`[field keys of ${table.name}]`);
    console.log('  ' + Object.keys(items[0].fields ?? {}).join(' | '));
    console.log('');
    printedKeys = true;
  }

  const tally = new Map();
  for (const item of items) {
    const value = text(item.fields?.['竞品分类']).trim() || '(空)';
    tally.set(value, (tally.get(value) ?? 0) + 1);
  }

  const stone = items.filter((i) => text(i.fields?.['材质分类']).includes('人造石'));
  const stoneWithTraffic = stone.filter((i) => (num(i.fields?.['月收货人数计算值']) ?? -1) >= 10);
  const traffic = items.filter((i) => (num(i.fields?.['月收货人数计算值']) ?? -1) >= 10);
  const trafficWithPrice = traffic.filter((i) => num(i.fields?.['客单价带分类']) != null);
  const blankPrice = items.filter((i) => num(i.fields?.['客单价带分类']) == null);

  const first = items[0]?.fields ?? {};
  console.log(`=== ${table.name}  (${items.length} 行, 数据 ${day(first['数据开始日期'])}~${day(first['数据结束日期'])}, 采集 ${day(first['采集时间'])})`);
  console.log('  竞品分类: ' + [...tally.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`  材质含「人造石」: ${stone.length} 行; 其中 人数>=10 的: ${stoneWithTraffic.length} 行`);
  console.log(`  人数>=10: ${traffic.length} 行; 其中 客单价带分类 非空: ${trafficWithPrice.length} 行`);
  console.log(`  材质分类 为空的行: ${items.filter((i) => !text(i.fields?.['材质分类']).trim()).length}`);
  console.log(`  客单价带分类为空的行: ${blankPrice.length}`);
  if (!printedRaw && items.length) {
    printedRaw = true;
    const f = items[0].fields ?? {};
    console.log(`  [raw] 客单价带分类 = ${JSON.stringify(f['客单价带分类'])}`);
    console.log(`  [raw] 价格 = ${JSON.stringify(f['价格'])}`);
    console.log(`  [raw] 月收货金额 = ${JSON.stringify(f['月收货金额'])}`);
    console.log(`  [raw] 材质分类 = ${JSON.stringify(f['材质分类'])}`);
  }

  const ranked = items
    .map((i) => ({
      monthly: num(i.fields?.['月收货人数计算值']),
      amount: num(i.fields?.['月收货金额']),
      price: num(i.fields?.['客单价带分类']),
      material: text(i.fields?.['材质分类']).trim(),
      platform: text(i.fields?.['平台']).trim(),
      shop: text(i.fields?.['店铺名']).trim().slice(0, 14),
      title: text(i.fields?.['商品标题']).trim(),
      klass: text(i.fields?.['竞品分类']).trim(),
    }))
    .filter((r) => r.monthly != null)
    .sort((a, b) => b.monthly - a.monthly);

  console.log(`  top-${TOP_N} 候选逐条核 A（人数>=80 且 金额>=200000）/ B（材质含人造石 且 人数>=10）:`);
  for (const r of ranked.slice(0, TOP_N)) {
    const aOk = r.monthly >= 80 && (r.amount ?? -1) >= 200000;
    const bOk = r.material.includes('人造石') && r.monthly >= 10;
    console.log(
      `    m=${String(r.monthly).padStart(4)} 金额=${String(r.amount ?? 'null').padStart(10)} 客单价=${String(r.price ?? 'null').padStart(7)}` +
      ` 材质=${(r.material || '(空)').slice(0, 8).padEnd(8)} A=${aOk ? 'Y' : '.'} B=${bOk ? 'Y' : '.'} [${r.klass || '(空)'}] ${r.shop} ${r.title.slice(0, 24)}`,
    );
  }
  console.log('');
}
