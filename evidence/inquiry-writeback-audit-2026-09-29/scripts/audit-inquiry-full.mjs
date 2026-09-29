import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnvFile } from '../../../runtime/feishu-targets.mjs';

const env = parseEnvFile(readFileSync('E:/小红书/.env.feishu-kcne.local', 'utf8'));
const base = 'https://open.feishu.cn/open-apis';
const r = await fetch(base + '/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
});
const tk = (await r.json()).tenant_access_token;
const h = { Authorization: 'Bearer ' + tk };
const APP = 'PTfHbPt9EaIzddsfL8Jcj238nrb';
const TBL = 'tblUnwn05vl8Wik9';

// 先取选项映射（SingleSelect 选项 id -> 名）
const f = await (await fetch(`${base}/bitable/v1/apps/${APP}/tables/${TBL}/fields?page_size=100`, { headers: h })).json();
const shopField = f.data.items.find(it => it.field_name === '店铺');
const optMap = new Map();
for (const o of shopField?.property?.options ?? []) optMap.set(o.id, o.name);

let pageToken = undefined;
const rows = [];
do {
  const u = new URL(`${base}/bitable/v1/apps/${APP}/tables/${TBL}/records`);
  u.searchParams.set('page_size', '500');
  if (pageToken) u.searchParams.set('page_token', pageToken);
  const j = await (await fetch(u, { headers: h })).json();
  for (const it of j.data?.items ?? []) {
    rows.push({ id: it.record_id, fields: it.fields });
  }
  pageToken = j.data?.page_token;
  if (!j.data?.has_more) break;
} while (pageToken);

console.log('总行数 =', rows.length);
console.log('店铺选项数 =', optMap.size);

// 归一化每一行
const norm = rows.map(r => {
  const rawShop = r.fields['店铺'];
  const shopName = optMap.get(String(rawShop)) ?? String(rawShop ?? '');
  const t = Number(r.fields['日期']);
  const day = Number.isFinite(t) ? new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
  return {
    id: r.id, rawShop: String(rawShop ?? ''), shop: shopName, day,
    isOptId: /^opt/u.test(String(rawShop ?? '')),
    inquiry: r.fields['询单量'] ?? null,
    peer: r.fields['同层同行询单量'] ?? null,
  };
});

// 形态分布
const optIdRows = norm.filter(x => x.isOptId);
const nameRows = norm.filter(x => !x.isOptId);
console.log('');
console.log('行形态：选项id', optIdRows.length, '| 文本名', nameRows.length);
console.log('选项id 行的日期范围:', optIdRows.map(x => x.day).sort()[0], '~', optIdRows.map(x => x.day).sort().slice(-1)[0]);
console.log('文本名 行的日期范围:', nameRows.map(x => x.day).sort()[0], '~', nameRows.map(x => x.day).sort().slice(-1)[0]);

// 按日期聚合
const byDay = new Map();
for (const x of norm) {
  if (!x.day) continue;
  if (!byDay.has(x.day)) byDay.set(x.day, { total: 0, withValue: 0, optId: 0, name: 0, shops: [] });
  const e = byDay.get(x.day);
  e.total += 1;
  if (x.inquiry !== null && x.inquiry !== undefined && String(x.inquiry) !== '') e.withValue += 1;
  if (x.isOptId) e.optId += 1; else e.name += 1;
  e.shops.push(x.shop);
}

const days = [...byDay.keys()].sort();
console.log('');
console.log('日期        | 行数 | 有值 | 选项id | 文本名');
for (const d of days.slice(-30)) {
  const e = byDay.get(d);
  console.log(`${d} | ${String(e.total).padStart(4)} | ${String(e.withValue).padStart(4)} | ${String(e.optId).padStart(6)} | ${String(e.name).padStart(6)}`);
}

writeFileSync('evidence/inquiry-writeback-audit-2026-09-29/inquiry-table-snapshot.json', JSON.stringify({
  fetchedAt: new Date().toISOString(),
  total: rows.length,
  optionMap: Object.fromEntries(optMap),
  byDay: Object.fromEntries([...byDay.entries()].map(([k, v]) => [k, { total: v.total, withValue: v.withValue, optId: v.optId, name: v.name, shops: v.shops }])),
  rows: norm,
}, null, 2), 'utf8');
console.log('');
console.log('已落盘 evidence/inquiry-writeback-audit-2026-09-29/inquiry-table-snapshot.json');
