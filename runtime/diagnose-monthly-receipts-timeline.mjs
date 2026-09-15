#!/usr/bin/env node
// Read-only forensics: time series of the raw 月收货人数 column across every 小旺神
// export still present in Downloads. The filename carries the exact export moment, so
// this tells us whether the metric is a rolling window or a calendar/week-to-date
// accumulator — i.e. whether "collected on Tuesday" explains the low weeks.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const DIR = process.env.DIAG_DOWNLOADS ?? 'C:/Users/Administrator/Downloads';
const files = readdirSync(DIR).filter((f) => /浴缸/.test(f) && /\.csv$/i.test(f));

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

const out = [];
for (const file of files) {
  const full = `${DIR}/${file}`;
  const text = readFileSync(full, 'utf8');
  const { header, rows } = parseCsv(text);
  const idx = header.findIndex((h) => h.trim() === '月收货人数');
  const priceIdx = header.findIndex((h) => h.trim() === '价格');
  if (idx < 0) { out.push({ file, note: `no 月收货人数 column (headers: ${header.join('|')})` }); continue; }
  const monthly = rows.map((r) => Number.parseFloat(String(r[idx] ?? '').replace(/[^\d.]/gu, ''))).filter((v) => Number.isFinite(v));
  const prices = rows.map((r) => Number.parseFloat(String(r[priceIdx] ?? '').replace(/[^\d.]/gu, ''))).filter((v) => Number.isFinite(v));
  // filename: 【 浴缸 】价格从高到低排序Top<N> - YYYY-MM-DD HH_MM - 市场数据分析 - 小旺神.csv
  const stamp = file.match(/(\d{4}-\d{2}-\d{2}) (\d{2})_(\d{2})/u);
  const top = file.match(/Top(\d+)/u);
  out.push({
    file,
    when: stamp ? `${stamp[1]} ${stamp[2]}:${stamp[3]}` : null,
    declaredTop: top ? Number(top[1]) : null,
    mtime: new Date(statSync(full).mtimeMs + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    rows: rows.length,
    zeros: monthly.filter((v) => v === 0).length,
    max: monthly.length ? Math.max(...monthly) : null,
    ge10: monthly.filter((v) => v >= 10).length,
    ge80: monthly.filter((v) => v >= 80).length,
    maxPrice: prices.length ? Math.max(...prices) : null,
  });
}

out.sort((a, b) => String(a.when).localeCompare(String(b.when)));
console.log('filename stamp      rows  zeros  max  >=10  >=80   priceMax   TopN   (mtime +08)');
for (const r of out) {
  if (r.note) { console.log(`${r.file.slice(0, 60)}  ${r.note}`); continue; }
  console.log(
    `${String(r.when).padEnd(18)} ${String(r.rows).padStart(4)} ${String(r.zeros).padStart(6)} ${String(r.max).padStart(4)} ${String(r.ge10).padStart(5)} ${String(r.ge80).padStart(5)}  ${String(r.maxPrice).padStart(9)} ${String(r.declaredTop).padStart(6)}   ${r.mtime}`,
  );
}
