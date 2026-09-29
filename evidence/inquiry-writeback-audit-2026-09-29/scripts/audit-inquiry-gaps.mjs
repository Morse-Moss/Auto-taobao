import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync('evidence/inquiry-writeback-audit-2026-09-29/inquiry-table-snapshot.json', 'utf8'));
const rows = snap.rows;

// 我们的五家店（运营叫法）
const OURS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];

const byDay = new Map();
for (const x of rows) {
  if (!x.day) continue;
  if (!byDay.has(x.day)) byDay.set(x.day, []);
  byDay.get(x.day).push(x);
}

console.log('=== 我方 5 家在询单表里逐日「有值」情况（含 09-01 起全量）===');
console.log('');
const days = [...byDay.keys()].sort();
const header = '日期        | ' + OURS.map(s => s.padEnd(12)).join('| ');
console.log(header);
for (const d of days) {
  const list = byDay.get(d);
  const cells = OURS.map(shop => {
    const hit = list.find(x => x.shop === shop);
    if (!hit) return '缺行'.padEnd(12);
    const v = hit.inquiry;
    const has = v !== null && v !== undefined && String(v) !== '';
    return (has ? String(v) : '·').padEnd(12);
  });
  console.log(`${d} | ${cells.join('| ')}`);
}

console.log('');
console.log('=== 断点统计（我方 5 家里「有值」的店数）===');
let prev = null;
for (const d of days) {
  const list = byDay.get(d);
  let n = 0;
  const missing = [];
  for (const shop of OURS) {
    const hit = list.find(x => x.shop === shop);
    const has = hit && hit.inquiry !== null && hit.inquiry !== undefined && String(hit.inquiry) !== '';
    if (has) n += 1; else missing.push(hit ? shop : shop + '(缺行)');
  }
  const flag = n < 5 ? '  <<< 不齐' : '';
  if (n !== prev || n < 5) {
    console.log(`${d}: 有值 ${n}/5  缺=[${missing.join(', ')}]${flag}`);
  }
  prev = n;
}

console.log('');
console.log('=== 09-28 那 12 行的明细（选项 id 形态）===');
for (const x of byDay.get('2026-09-28') ?? []) {
  console.log('  ', x.id, '| rawShop=', x.rawShop, '| 归一化=', x.shop, '| 询单量=', x.inquiry, '| 同层=', x.peer);
}

console.log('');
console.log('=== 我方 5 家在选项映射表里的名字 ==');
console.log(' 选项映射:', JSON.stringify(snap.optionMap, null, 1));
