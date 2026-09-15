#!/usr/bin/env node
// Read-only: is the 月收货人数 column stable across exports?
//
// Method: index every 小旺神 CSV in Downloads by product id, then look at products
// observed in TWO OR MORE exports made on THE SAME DAY. Same day removes real drift,
// so any disagreement left is export-side instability (column shift / different metric
// / different field selection), not a market fact.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const DIR = process.env.DIAG_DOWNLOADS ?? 'C:/Users/Administrator/Downloads';

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const parseRow = (line) => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur); return cells;
  };
  return { header: parseRow(lines[0]), rows: lines.slice(1).map(parseRow) };
}

const files = readdirSync(DIR).filter((f) => /浴缸/.test(f) && /\.csv$/i.test(f) && /小旺神/.test(f));
const observations = new Map(); // id -> [{id,stamp,day,monthly,price,fav,same,title}]
const exportSummary = [];

for (const file of files) {
  const stamp = file.match(/(\d{4}-\d{2}-\d{2}) (\d{2})_(\d{2})/u);
  if (!stamp) continue;
  const when = `${stamp[1]} ${stamp[2]}:${stamp[3]}`;
  const day = stamp[1];
  const { header, rows } = parseCsv(readFileSync(`${DIR}/${file}`, 'utf8'));
  const col = (name) => header.findIndex((h) => h.trim() === name);
  const iLink = col('商品链接'); const iMonthly = col('月收货人数'); const iPrice = col('价格');
  const iFav = col('收藏人数'); const iSame = col('同款数'); const iTitle = col('商品标题'); const iFav2 = col('付款人数');
  const num = (v) => { const n = Number.parseFloat(String(v ?? '').replace(/[^\d.]/gu, '')); return Number.isFinite(n) ? n : null; };
  const monthlyValues = [];
  for (const row of rows) {
    const link = String(row[iLink] ?? '').trim();
    const id = link.match(/[?&]id=(\d+)/u)?.[1] ?? (link ? link.slice(-24) : '');
    if (!id) continue;
    const monthly = iMonthly >= 0 ? num(row[iMonthly]) : null;
    if (monthly != null) monthlyValues.push(monthly);
    const obs = { stamp: when, day, monthly, price: num(row[iPrice]), fav: num(row[iFav]), same: num(row[iSame]), title: String(row[iTitle] ?? '').slice(0, 32), file: file.slice(0, 42) };
    if (!observations.has(id)) observations.set(id, []);
    observations.get(id).push(obs);
  }
  exportSummary.push({
    when,
    day,
    metricColumn: iMonthly >= 0 ? '月收货人数' : (iFav2 >= 0 ? '付款人数' : '?'),
    rows: rows.length,
    max: monthlyValues.length ? Math.max(...monthlyValues) : null,
    ge80: monthlyValues.filter((v) => v >= 80).length,
  });
}

exportSummary.sort((a, b) => a.when.localeCompare(b.when));
console.log('when              metricCol    rows   max  >=80');
for (const e of exportSummary) console.log(`${e.when}  ${e.metricColumn.padEnd(10)} ${String(e.rows).padStart(5)} ${String(e.max).padStart(5)} ${String(e.ge80).padStart(4)}`);

let multi = 0; let sameDayMulti = 0; let unstable = 0;
const unstableRows = [];
for (const [id, list] of observations) {
  if (list.length < 2) continue;
  multi += 1;
  const byDay = new Map();
  for (const obs of list) {
    if (!byDay.has(obs.day)) byDay.set(obs.day, []);
    byDay.get(obs.day).push(obs);
  }
  for (const [day, obsList] of byDay) {
    if (obsList.length < 2) continue;
    sameDayMulti += 1;
    const values = obsList.map((o) => o.monthly);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > 0) {
      unstable += 1;
      unstableRows.push({ id, day, title: obsList[0].title, obsList, spread, ratio: Math.max(...values) / Math.max(1, Math.min(...values)) });
    }
  }
}

console.log(`\nproducts seen in >=2 exports: ${multi}`);
console.log(`products seen in >=2 exports on the SAME DAY: ${sameDayMulti}`);
console.log(`  ... of which the value DISAGREES: ${unstable}`);
unstableRows.sort((a, b) => b.spread - a.spread);
console.log('\ntop disagreements (same product, same day, different export):');
for (const r of unstableRows.slice(0, 12)) {
  console.log(`  ${r.title}`);
  console.log(`     ${r.obsList.map((o) => `${o.stamp}=${o.monthly}(fav ${o.fav}, same ${o.same}, price ${o.price})`).join('  |  ')}`);
}

// Which products carry the huge values, and what do their other columns look like?
const huge = [...observations.entries()]
  .flatMap(([id, list]) => list.map((o) => ({ id, ...o })))
  .filter((o) => o.monthly != null && o.monthly >= 1000)
  .sort((a, b) => b.monthly - a.monthly);
console.log(`\nobservations with 月收货人数 >= 1000: ${huge.length}`);
for (const h of huge.slice(0, 10)) console.log(`  ${h.stamp}  monthly=${h.monthly}  price=${h.price}  fav=${h.fav}  same=${h.same}  ${h.title}`);
