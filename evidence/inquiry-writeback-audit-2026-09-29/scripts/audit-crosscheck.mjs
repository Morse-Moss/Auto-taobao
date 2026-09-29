import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const snap = JSON.parse(readFileSync('evidence/inquiry-writeback-audit-2026-09-29/inquiry-table-snapshot.json', 'utf8'));
const rows = snap.rows;
const OURS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];

const tableByKey = new Map();
for (const x of rows) if (x.day) tableByKey.set(`${x.day}|${x.shop}`, x);

const receipts = [];
function walk(dir, depth = 0) {
  if (depth > 4) return;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === 'inquiry-backfill-receipt.json') receipts.push(p);
  }
}
walk('evidence');

console.log('=== 收据说「写成功了」，表里到底有没有值（09-14 起）===');
console.log('');
console.log('日期       | 店铺      | 收据状态                  | 收据写的值        | 表里值        | 判定');
const problems = [];
for (const p of receipts) {
  let d; try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  if (!OURS.includes(d.shop)) continue;
  if (d.reportDate < '2026-09-14') continue;
  const key = `${d.reportDate}|${d.shop}`;
  const t = tableByKey.get(key);
  const rv = d.values ?? {};
  const tv = t ? { 询单量: t.inquiry, 同层: t.peer } : null;
  const rInq = rv['询单量'];
  const tInq = tv?.询单量;
  const ok = t && Number(tInq) === Number(rInq);
  const verdict = !t ? '表里无此行!' : (ok ? 'OK' : '值不一致!');
  if (verdict !== 'OK') problems.push({ ...d, key, rInq, tInq, path: p });
  console.log(`${d.reportDate} | ${d.shop.padEnd(9)} | ${String(d.status).padEnd(24)} | 询单=${String(rInq).padEnd(4)} 同层=${String(rv['同层同行询单量']).padEnd(4)} | 询单=${String(tInq).padEnd(4)} 同层=${String(tv?.同层).padEnd(4)} | ${verdict}`);
}

console.log('');
console.log('=== 汇总：对不上的', problems.length, '条 ===');
for (const x of problems) console.log(`  ${x.key}  收据=${x.rInq} 表里=${x.tInq}  rec=${x.target?.recordId}`);
