#!/usr/bin/env node
// Read-only guard: can this collection package produce an A-grade competitor at all?
//
// Why this exists: every 小旺神 export renumbers 序号 from 1, so a 150-row slice
// scrolled to the middle of the list is indistinguishable from a complete ranking as far
// as row count, headers, links and rank_range are concerned. On 2026-09-15 the first
// capture (15:08) held an item at 月收货人数 = 200; the segmented re-run (17:59-18:48)
// only captured mid-list slices (max = 48) — and the re-run is what got merged and
// imported. A needs 月收货人数 >= 80, so that package could not produce any A, and the
// empty result was misread as "no hit products this week" for two weeks.
//
// The verdict below is deliberately narrow: it only claims what is measurable, namely
// whether the package contains any row that could meet A's traffic threshold.
//
// Usage:
//   node runtime/diagnose-raw-export-head.mjs                     # all 小旺神 csv in Downloads
//   node runtime/diagnose-raw-export-head.mjs --day=2026-09-15
//   node runtime/diagnose-raw-export-head.mjs --dir="D:/path" --strict
//
// Exit code: 0 normally; 2 with --strict when no export reaches A_MIN.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const A_MIN = Number.parseInt(process.env.A_MIN ?? '80', 10);
const STRICT = process.argv.includes('--strict');
const dayArg = process.argv.find((a) => a.startsWith('--day='));
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const DIR = dirArg ? dirArg.slice('--dir='.length) : 'C:/Users/Administrator/Downloads';
const paths = process.argv.filter((a) => a.endsWith('.csv'));

function parseCsv(input) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') { if (input[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

const targets = paths.length
  ? paths.map((p) => ({ path: p, name: p.split(/[\\/]/u).pop() }))
  : readdirSync(DIR)
    .filter((f) => f.endsWith('.csv') && f.includes('小旺神'))
    .map((f) => ({
      path: `${DIR}/${f}`,
      name: f,
      stamp: new Date(statSync(`${DIR}/${f}`).mtimeMs + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    }))
    .filter((x) => (dayArg ? x.stamp.startsWith(dayArg.slice('--day='.length)) : true))
    .sort((a, b) => a.stamp.localeCompare(b.stamp));

const BRANDS = ['浪鲸', 'ssww', '特拉维尔', '箭牌'];
let eligible = 0;
console.log('导出文件                                       行数   max  >=80 旗舰店  零值  类目  ' + BRANDS.map((b) => b.padEnd(6)).join('') + '判定');
for (const t of targets) {
  const rows = parseCsv(readFileSync(t.path, 'utf8'));
  const header = rows[0];
  const idx = (n) => header.indexOf(n);
  const stamp = t.stamp ?? new Date(statSync(t.path).mtimeMs + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (idx('月收货人数') < 0) {
    console.log(`${stamp}  ${t.name.slice(0, 40).padEnd(42)}  -- 无 月收货人数 列（该版导出用的是其它指标名），跳过`);
    continue;
  }
  const body = rows.slice(1).filter((r) => r.length >= header.length);
  const values = body.map((r) => Number.parseFloat(r[idx('月收货人数')])).filter(Number.isFinite);
  const max = values.length ? Math.max(...values) : 0;
  const ge80 = values.filter((v) => v >= 80).length;
  const zeros = values.filter((v) => v === 0).length;
  const flagship = body.filter((r) => /旗舰店/u.test(r[idx('店铺名')] ?? '')).length;
  const cats = new Set(body.map((r) => ((r[idx('类目')] ?? '').split('>>').pop() ?? '').trim())).size;
  const brands = BRANDS.map((b) => String(body.filter((r) => (r[idx('商品标题')] ?? '').includes(b)).length).padEnd(6)).join('');
  // A high max alone is not proof of a usable package: the 2026-09-15 17:16 export reached
  // 9000 because it had scrolled into 20+ unrelated categories, not because it held the
  // rank-1 bathtub. Mixed-category junk is a distinct failure and must be reported as such.
  const verdict = cats > 5 ? '异类目' : (max >= A_MIN ? '含A候选' : (max <= 50 ? '尾段' : '中段'));
  if (verdict === '含A候选') eligible += 1;
  console.log(`${stamp}  ${t.name.slice(0, 40).padEnd(42)}${String(body.length).padStart(5)}${String(max).padStart(6)}${String(ge80).padStart(6)}${String(flagship).padStart(7)}${String(zeros).padStart(6)}${String(cats).padStart(6)}  ${brands}${verdict}`);
}
console.log(`\nA 的门槛是 月收货人数 >= ${A_MIN}；本批扫描中含 A 候选的导出 = ${eligible} 份`);
if (!eligible) {
  console.log('结论：整批导出里没有任何一行的 月收货人数 达到 A 的门槛。');
  console.log('      这意味着「本周 A/B 为 0」是采集包决定的，不能读成「本周没有爆款竞品」或「市场变冷」。');
  console.log('      这份包不要直接进入导入并据此下结论；先查采集侧为什么没覆盖到高销量区段。');
} else {
  console.log('结论：至少一份导出含 A 候选，可以进入导入流程。');
}
if (STRICT && !eligible) process.exit(2);
