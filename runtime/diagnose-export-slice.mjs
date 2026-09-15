#!/usr/bin/env node
// Read-only: which slice of which list did each export come from?
// Prints the 序号 range + the rank-1 / rank-last item per export, plus the keyword mix,
// so we can tell "same list, different page range" from "a different list entirely".
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

const files = readdirSync(DIR).filter((f) => /浴缸/.test(f) && /\.csv$/i.test(f) && /小旺神/.test(f));
const rows = [];
for (const file of files) {
  const stamp = file.match(/(\d{4}-\d{2}-\d{2}) (\d{2})_(\d{2})/u);
  if (!stamp) continue;
  const when = `${stamp[1]} ${stamp[2]}:${stamp[3]}`;
  const { header, rows: data } = parseCsv(readFileSync(`${DIR}/${file}`, 'utf8'));
  const col = (n) => header.findIndex((h) => h.trim() === n);
  const iSeq = col('序号'); const iMonthly = col('月收货人数'); const iTitle = col('商品标题'); const iCat = col('类目');
  const seqs = data.map((r) => Number.parseInt(String(r[iSeq] ?? ''), 10)).filter(Number.isFinite);
  const monthly = data.map((r) => Number.parseFloat(String(r[iMonthly] ?? '').replace(/[^\d.]/gu, ''))).filter(Number.isFinite);
  const cats = new Map();
  for (const r of data) {
    const c = String(r[iCat] ?? '').trim();
    const leaf = c.split('>>').pop().trim();
    cats.set(leaf, (cats.get(leaf) ?? 0) + 1);
  }
  rows.push({
    when,
    seqMin: seqs.length ? Math.min(...seqs) : null,
    seqMax: seqs.length ? Math.max(...seqs) : null,
    rows: data.length,
    max: monthly.length ? Math.max(...monthly) : null,
    topTitle: String(data[0]?.[iTitle] ?? '').slice(0, 30),
    topMonthly: monthly.length ? Number.parseFloat(String(data[0][iMonthly] ?? '').replace(/[^\d.]/gu, '')) : null,
    lastTitle: String(data[data.length - 1]?.[iTitle] ?? '').slice(0, 30),
    cats: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '),
  });
}
rows.sort((a, b) => a.when.localeCompare(b.when));
console.log('when              序号范围      rows  max  首行monthly  类目(前3)');
for (const r of rows) {
  console.log(`${r.when}  ${String(r.seqMin).padStart(4)}-${String(r.seqMax).padStart(4)}  ${String(r.rows).padStart(5)} ${String(r.max).padStart(5)} ${String(r.topMonthly).padStart(6)}   ${r.cats}`);
  console.log(`                      首行: ${r.topTitle}`);
}
