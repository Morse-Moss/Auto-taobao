#!/usr/bin/env node
// Read-only, decisive: for each export, is the ROW ORDER actually 销量降序 (monthly
// receipts non-increasing) or 价格降序 (price non-increasing)? The plugin's filename
// always claims "价格从高到低", so the filename cannot be trusted — measure it.
import { readFileSync, readdirSync } from 'node:fs';

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

const monotonicity = (values) => {
  const pairs = values.length - 1;
  if (pairs < 2) return { ratio: null, pairs };
  let nonIncreasing = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] <= values[i - 1]) nonIncreasing += 1;
  return { ratio: nonIncreasing / pairs, pairs };
};

const files = readdirSync(DIR).filter((f) => /浴缸/.test(f) && /\.csv$/i.test(f) && /小旺神/.test(f));
const out = [];
for (const file of files) {
  const stamp = file.match(/(\d{4}-\d{2}-\d{2}) (\d{2})_(\d{2})/u);
  if (!stamp) continue;
  const { header, rows } = parseCsv(readFileSync(`${DIR}/${file}`, 'utf8'));
  const col = (n) => header.findIndex((h) => h.trim() === n);
  const iMonthly = col('月收货人数'); const iPrice = col('价格'); const iTitle = col('商品标题'); const iCat = col('类目');
  if (iMonthly < 0) { out.push({ when: `${stamp[1]} ${stamp[2]}:${stamp[3]}`, rows: rows.length, verdict: 'no 月收货人数 column (付款人数 export)' }); continue; }
  const num = (v) => { const n = Number.parseFloat(String(v ?? '').replace(/[^\d.]/gu, '')); return Number.isFinite(n) ? n : null; };
  const monthly = rows.map((r) => num(r[iMonthly]));
  const prices = rows.map((r) => num(r[iPrice]));
  const m = monotonicity(monthly.filter((v) => v != null));
  const p = monotonicity(prices.filter((v) => v != null));
  // dominant 类目 leaf for this export
  const cats = new Map();
  for (const r of rows) { const leaf = String(r[iCat] ?? '').split('>>').pop().trim(); cats.set(leaf, (cats.get(leaf) ?? 0) + 1); }
  const exotic = [...cats.entries()].filter(([k]) => !/浴缸/.test(k));
  out.push({
    when: `${stamp[1]} ${stamp[2]}:${stamp[3]}`,
    rows: rows.length,
    monthlyNonIncreasing: m.ratio,
    priceNonIncreasing: p.ratio,
    maxMonthly: Math.max(...monthly.filter((v) => v != null)),
    firstTitle: String(rows[0]?.[iTitle] ?? '').slice(0, 26),
    exoticCategories: exotic.map(([k, v]) => `${k}:${v}`).join(' '),
  });
}
out.sort((a, b) => a.when.localeCompare(b.when));
console.log('when              rows  monthly↓  price↓   maxM  verdict                     首行');
for (const r of out) {
  if (r.verdict) { console.log(`${r.when}  ${String(r.rows).padStart(5)}  ${r.verdict}`); continue; }
  const m = r.monthlyNonIncreasing; const p = r.priceNonIncreasing;
  let verdict;
  if (m != null && m > 0.95) verdict = '销量降序 (monthly ↓)';
  else if (p != null && p > 0.95) verdict = '价格降序 (price ↓)';
  else verdict = `都不是 (m↓${m?.toFixed(2)} p↓${p?.toFixed(2)})`;
  console.log(`${r.when}  ${String(r.rows).padStart(5)}  ${String(m?.toFixed(2)).padStart(8)}  ${String(p?.toFixed(2)).padStart(6)}  ${String(r.maxMonthly).padStart(5)}  ${verdict.padEnd(26)} ${r.firstTitle}${r.exoticCategories ? '   [非浴缸类目: ' + r.exoticCategories + ']' : ''}`);
}
