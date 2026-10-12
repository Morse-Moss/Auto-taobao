// 只读：把 batches.log 里每次 login-preflight 的结论按时间顺序提出来（含网林那几次）。
import { readFileSync } from 'node:fs';

const file = 'D:/Retire/sycm-automation/evidence/batches-2026-09-24/batches.log';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);

let ts = null;
let only = null;
const out = [];
for (const l of lines) {
  if (l.includes('--- login-preflight：')) {
    ts = (l.match(/\[([^\]]+)\]/) || [])[1] ?? '?';
    const m = l.match(/--shops (\S+)/);
    only = m ? m[1] : '(全部五家)';
    continue;
  }
  const sv = l.match(/"scriptVerdict": "([A-Z_]+)"/);
  if (sv && ts) { out.push([ts, only, sv[1]]); ts = null; continue; }
  const rv = l.match(/"verdict": "(ALL_IN|NEEDS_LOGIN|INCONCLUSIVE|UNREADABLE)"/);
  if (rv && ts) { out.push([ts, only, `round=${rv[1]}`]); ts = null; }
}
for (const r of out) console.log(r.join('  '));
console.log(`共 ${out.length} 条`);
