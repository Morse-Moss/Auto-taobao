#!/usr/bin/env node
// Read-only diagnosis for the weekly competitor collection profile.
//
// Why this exists: A/B (爆款/高价值竞品) classification is driven by
// 月收货人数计算值 + 月收货金额 thresholds, and those values alternate between two
// very different weekly profiles. This script answers the documented open question
// "是真实没有爆款竞品，还是分类公式的输入没采全" with evidence instead of opinion.
//
// What it reports, for every 竞品周_* table in the competitor base:
//   1. period stamp (数据开始/结束日期 + 采集时间) — what the run claims it collected
//   2. 平台 / 店铺类型 / 类目 mix                — collection scope (淘宝 vs 天猫)
//   3. 月收货人数计算值 distribution             — the classification input
//   4. top-N items by monthly receipts           — which items drive A/B
//   5. cross-week shared-title comparison        — is the metric itself stable?
//
// Usage:
//   node runtime/diagnose-weekly-collection-profile.mjs
//   PROBE_ENV_FILE=E:/小红书/.env.feishu-kcne.local \
//   PROBE_APP_TOKEN=<app token> node runtime/diagnose-weekly-collection-profile.mjs
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.PROBE_APP_TOKEN ?? 'QcnhbEzYpacGvUskCbVcrcm3nFd';
const ENV_FILE = process.env.PROBE_ENV_FILE ?? 'E:/小红书/.env.feishu-kcne.local';
const TOP_N = Number.parseInt(process.env.PROBE_TOP_N ?? '8', 10);

const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
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
  const parsed = Number.parseFloat(raw.replace(/[^\d.]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
// Feishu date fields are epoch ms at Shanghai midnight; render in Asia/Shanghai.
const day = (value) => (typeof value === 'number' ? new Date(value + 8 * 3600 * 1000).toISOString().slice(0, 10) : String(value ?? ''));

async function listWeeklyTables() {
  const res = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers }).then((r) => r.json());
  if (res.code !== 0) throw new Error(`list tables failed: ${res.code} ${res.msg}`);
  return (res.data.items ?? [])
    .filter((t) => /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u.test(t.name))
    .map((t) => ({ tableId: t.table_id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function load(tableId) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const res = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${query}`, { headers }).then((r) => r.json());
    if (res.code !== 0) throw new Error(`records failed: ${res.code} ${res.msg}`);
    items.push(...(res.data.items ?? []));
    pageToken = res.data.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return items;
}

const tables = await listWeeklyTables();
const snapshot = [];

for (const table of tables) {
  const items = await load(table.tableId);
  const monthly = items.map((i) => num(i.fields?.['月收货人数计算值'])).filter((v) => v != null);
  const bands = { 0: 0, '1-9': 0, '10-29': 0, '30-79': 0, '80-199': 0, '>=200': 0 };
  for (const v of monthly) {
    if (v === 0) bands[0] += 1;
    else if (v < 10) bands['1-9'] += 1;
    else if (v < 30) bands['10-29'] += 1;
    else if (v < 80) bands['30-79'] += 1;
    else if (v < 200) bands['80-199'] += 1;
    else bands['>=200'] += 1;
  }
  const mix = (name) => {
    const tally = new Map();
    for (const item of items) {
      const value = text(item.fields?.[name]).trim() || '(空)';
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    return tally;
  };
  const ranked = items
    .map((i) => ({
      monthly: num(i.fields?.['月收货人数计算值']),
      platform: text(i.fields?.['平台']).trim(),
      shopType: text(i.fields?.['店铺类型']).trim(),
      shopName: text(i.fields?.['店铺名']).trim().slice(0, 16),
      title: text(i.fields?.['商品标题']).trim(),
    }))
    .filter((r) => r.monthly != null)
    .sort((a, b) => b.monthly - a.monthly);

  const first = items[0]?.fields ?? {};
  snapshot.push({
    table,
    rows: items.length,
    stamp: `数据 ${day(first['数据开始日期'])}~${day(first['数据结束日期'])} 采集 ${day(first['采集时间'])}`,
    platform: mix('平台'),
    shopType: mix('店铺类型'),
    monthly,
    bands,
    ranked,
    titles: new Set(items.map((i) => text(i.fields?.['商品标题']).trim()).filter(Boolean)),
  });
}

console.log('table                                 rows  零值  1-9  10-29 30-79 80-199 >=200  天猫  旗舰店  浪鲸  max   period stamp');
for (const s of snapshot) {
  const cn = s.platform.get('天猫') ?? 0;
  const flagship = s.shopType.get('旗舰店') ?? 0;
  const lang = s.ranked.filter((r) => r.title.includes('浪鲸')).length
    + [...s.titles].filter((t) => t.includes('浪鲸')).length - s.ranked.filter((r) => r.title.includes('浪鲸')).length;
  console.log(
    `${s.table.name.padEnd(32)} ${String(s.rows).padStart(4)} ${String(s.bands[0]).padStart(5)} ${String(s.bands['1-9']).padStart(4)} ${String(s.bands['10-29']).padStart(5)} ${String(s.bands['30-79']).padStart(5)} ${String(s.bands['80-199']).padStart(6)} ${String(s.bands['>=200']).padStart(5)} ${String(cn).padStart(5)} ${String(flagship).padStart(6)} ${String(lang).padStart(5)} ${String(Math.max(...s.monthly)).padStart(4)}   ${s.stamp}`,
  );
}

console.log(`\ntop-${TOP_N} by 月收货人数计算值 per week:`);
for (const s of snapshot) {
  console.log(`\n  ${s.table.name}`);
  for (const r of s.ranked.slice(0, TOP_N)) {
    console.log(`    m=${String(r.monthly).padStart(4)}  ${r.platform}/${r.shopType}  [${r.shopName}]  ${r.title.slice(0, 34)}`);
  }
}

if (snapshot.length >= 2) {
  const previous = snapshot[snapshot.length - 2];
  const current = snapshot[snapshot.length - 1];
  const shared = [...previous.titles].filter((t) => current.titles.has(t));
  const prevByTitle = new Map(previous.ranked.map((r) => [r.title, r.monthly]));
  const nowByTitle = new Map(current.ranked.map((r) => [r.title, r.monthly]));
  let same = 0; let lower = 0; let higher = 0;
  for (const title of shared) {
    const a = prevByTitle.get(title);
    const b = nowByTitle.get(title);
    if (a == null || b == null) continue;
    if (b === a) same += 1;
    else if (b < a) lower += 1;
    else higher += 1;
  }
  console.log(`\n${previous.table.name} -> ${current.table.name}`);
  console.log(`  titles: ${previous.titles.size} -> ${current.titles.size}, shared ${shared.length}`);
  console.log(`  shared-title monthly: same=${same} lower=${lower} higher=${higher}`);
  console.log('  (a high `same` count means the metric itself is stable and the difference is the collected SET, not the numbers)');
  console.log(`  only-in-previous top: ${[...previous.titles].filter((t) => !current.titles.has(t))
    .map((t) => ({ t, m: prevByTitle.get(t) ?? -1 })).sort((a, b) => b.m - a.m).slice(0, 5)
    .map((x) => `${x.m} ${x.t.slice(0, 26)}`).join(' | ')}`);
}
