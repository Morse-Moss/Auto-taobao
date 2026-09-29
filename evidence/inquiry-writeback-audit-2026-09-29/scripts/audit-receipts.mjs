import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const OURS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];

// 收集所有 backfill 收据
const root = 'evidence';
const receipts = [];
function walk(dir, depth = 0) {
  if (depth > 4) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === 'inquiry-backfill-receipt.json') receipts.push(p);
  }
}
walk(root);

console.log('=== 找到 backfill 收据', receipts.length, '份 ===');
console.log('');

const byDateShop = new Map();
for (const p of receipts) {
  let d;
  try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  const key = `${d.reportDate}|${d.shop}`;
  const rec = { path: p, status: d.status, recordId: d.target?.recordId, table: d.target?.tableName, values: d.values, computedAt: d.environment?.computedAt };
  if (!byDateShop.has(key)) byDateShop.set(key, []);
  byDateShop.get(key).push(rec);
}

// 按日期列出我方 5 家的收据状态
const dates = [...new Set([...byDateShop.keys()].map(k => k.split('|')[0]))].sort();
console.log('日期        | ' + OURS.map(s => s.padEnd(10)).join('| '));
for (const dt of dates) {
  if (dt < '2026-09-01') continue;
  const cells = OURS.map(shop => {
    const list = byDateShop.get(`${dt}|${shop}`);
    if (!list || !list.length) return '-'.padEnd(10);
    const best = list[list.length - 1];
    const tag = best.status === 'COMMITTED_AND_VERIFIED' ? 'OK' : String(best.status).slice(0, 8);
    return tag.padEnd(10);
  });
  console.log(`${dt} | ${cells.join('| ')}`);
}

console.log('');
console.log('=== 09-24 ~ 09-29 逐条收据明细 ===');
for (const dt of dates.filter(d => d >= '2026-09-24')) {
  for (const shop of OURS) {
    const list = byDateShop.get(`${dt}|${shop}`);
    if (!list) continue;
    for (const r of list) {
      console.log(`${dt} ${shop.padEnd(10)} ${String(r.status).padEnd(26)} rec=${r.recordId ?? '-'}`);
    }
  }
}
