// 把「商品/询单/推广」三张底单的日期字段统一成「北京时间零点」，
// 让「商品数据看板」的查找引用（要求日期时间戳精确相等）能匹配上。
//
// 用法：
//   node tmp/fix-dashboard-date-0928.mjs            # 只读：打印计划（默认）
//   node tmp/fix-dashboard-date-0928.mjs --probe    # 只改 1 行，并回读看板验证引用是否立刻出数
//   node tmp/fix-dashboard-date-0928.mjs --commit   # 全量执行
//
// 判据：目标值 = 该时间戳「按 +8 读法得到的那一天」的北京时间零点。
// 该公式幂等：本来就是北京时间零点的行，目标值等于自身，不会被改动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(ROOT, 'VERSION'))) ROOT = path.dirname(ROOT);

const { loadFeishuCredentials, productDataTargets } = await import(pathToFileURL(path.join(ROOT, 'runtime/feishu-targets.mjs')).href);

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const COMMIT = args.includes('--commit');
if (PROBE && COMMIT) throw new Error('--probe 与 --commit 不能同时给');

const c = loadFeishuCredentials('kcne');
const auth = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
})).json();
const H = { Authorization: `Bearer ${auth.tenant_access_token}`, 'Content-Type': 'application/json' };
const t = productDataTargets('kcne');
const base = t.baseToken;
const DASH = 'tbldkz3pU4VQ7Rjt';

const dUtc = (v) => new Date(Number(v)).toISOString().slice(0, 10);
const d8 = (v) => new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 10);
function targetFor(v) {
  const [y, m, d] = d8(v).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
}

async function fields(tid) {
  const r = await (await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${tid}/fields?page_size=200`, { headers: H })).json();
  return r.data?.items ?? [];
}
async function pull(tid) {
  const out = []; let pt = '';
  for (;;) {
    const u = `https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${tid}/records?page_size=500` + (pt ? `&page_token=${pt}` : '');
    const j = await (await fetch(u, { headers: H })).json();
    out.push(...(j.data.items ?? []));
    if (!j.data?.has_more) break; pt = j.data.page_token;
  }
  return out;
}
async function batchUpdate(tid, records) {
  let done = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const r = await (await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${tid}/records/batch_update`, {
      method: 'POST', headers: H, body: JSON.stringify({ records: chunk }),
    })).json();
    if (r.code !== 0) throw new Error(`batch_update 失败 (${tid}): ${JSON.stringify(r).slice(0, 300)}`);
    done += chunk.length;
  }
  return done;
}

const TABLES = [
  { label: '商品数据底单', tid: t.productTable, dateField: '统计日期' },
  { label: '商品询单数据底单', tid: t.inquiryTable, dateField: '数据日期' },
  { label: '商品推广数据底单', tid: t.promotionTable, dateField: '日期' },
];

const plan = [];
for (const T of TABLES) {
  const rows = await pull(T.tid);
  const changes = [];
  const byDay = new Map();
  for (const r of rows) {
    const v = (r.fields ?? {})[T.dateField];
    if (typeof v !== 'number') continue;
    const tgt = targetFor(v);
    if (tgt === v) continue;
    changes.push({ record_id: r.record_id, fields: { [T.dateField]: tgt } });
    const day = d8(v);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  plan.push({ ...T, total: rows.length, changes, byDay });
  console.log(`\n=== ${T.label}（共 ${rows.length} 行）：需改 ${changes.length} 行 ===`);
  for (const [d, n] of [...byDay.entries()].sort()) console.log(`   ${d} : ${n} 行`);
  if (changes.length) {
    const s = rows.find((r) => (r.fields ?? {})[T.dateField] === Number(changes[0].fields[T.dateField]));
    console.log(`   样例：record=${changes[0].record_id}  ${dUtc(rows.find((r) => r.record_id === changes[0].record_id).fields[T.dateField])} → ${dUtc(changes[0].fields[T.dateField])}`);
  }
}
const grand = plan.reduce((s, p) => s + p.changes.length, 0);
console.log(`\n合计需改 = ${grand} 行`);

if (!PROBE && !COMMIT) {
  console.log('\n（只读模式，未写入。加 --probe 只改 1 行 / 加 --commit 全量执行）');
  process.exit(0);
}

// ---------- 取「试改」目标：商品底单里 09-23 的一条，且看板上存在对应的 (商品ID, 09-23) 行 ----------
if (PROBE) {
  const prod = plan[0];
  const changeById = new Map(prod.changes.map((ch) => [ch.record_id, ch]));
  const dashRows = await pull(DASH);
  const prodRows = await pull(prod.tid);
  // 挑「底单待改 且 看板同日有行」的那一条，才能真正验证引用
  const dashById = new Map();
  for (const r of dashRows) {
    if (d8((r.fields ?? {})['日期']) !== '2026-09-23') continue;
    dashById.set(String((r.fields ?? {})['商品ID']), r);
  }
  const src = prodRows.find((r) => changeById.has(r.record_id)
    && d8((r.fields ?? {})['统计日期']) === '2026-09-23'
    && dashById.has(String((r.fields ?? {})['商品ID'])));
  if (!src) throw new Error('找不到「底单待改 且 看板 09-23 有行」的商品');
  const cand = changeById.get(src.record_id);
  const pid = String(src.fields['商品ID']);
  const dashRow = dashById.get(pid);
  console.log(`\n===== 试改 1 行 =====`);
  console.log(`  底单记录 ${cand.record_id}  商品ID=${pid}  日期 ${src.fields['统计日期']} → ${cand.fields[prod.dateField]}`);
  console.log(`  底单该行的「商品访客数」= ${JSON.stringify(src.fields['商品访客数'])}`);
  if (!dashRow) { console.log('  看板上找不到对应行，无法验证引用'); process.exit(3); }
  console.log(`  看板行 ${dashRow.record_id}  改前「访客数」= ${JSON.stringify((dashRow.fields ?? {})['访客数'])}`);

  const n = await batchUpdate(prod.tid, [cand]);
  console.log(`  已改 ${n} 行，等待飞书重算引用……`);
  await new Promise((r) => setTimeout(r, 4000));

  const after = (await pull(DASH)).find((r) => r.record_id === dashRow.record_id);
  console.log(`  看板行 ${dashRow.record_id}  改后「访客数」= ${JSON.stringify((after.fields ?? {})['访客数'])}  「支付金额」= ${JSON.stringify((after.fields ?? {})['支付金额'])}`);
  process.exit(0);
}

// ---------- 全量 ----------
console.log('\n===== 全量执行 =====');
const receipt = [];
for (const p of plan) {
  if (!p.changes.length) { console.log(`${p.label}: 无需改动`); receipt.push({ table: p.label, changed: 0 }); continue; }
  const n = await batchUpdate(p.tid, p.changes);
  console.log(`${p.label}: 已改 ${n} 行`);
  receipt.push({ table: p.label, changed: n });
}
const out = path.join(ROOT, 'evidence/dashboard-date-mismatch-2026-09-28/receipt.json');
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), receipt }, null, 2), 'utf8');
console.log(`\n收据已落盘: ${out}`);
