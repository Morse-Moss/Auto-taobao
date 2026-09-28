// 只读：对比「商品数据看板」与「商品数据底单」的日期字段原始时间戳，判断查找引用为何匹配不上。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(ROOT, 'VERSION'))) ROOT = path.dirname(ROOT);

const { loadFeishuCredentials, productDataTargets } = await import(pathToFileURL(path.join(ROOT, 'runtime/feishu-targets.mjs')).href);

const c = loadFeishuCredentials('kcne');
const auth = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
})).json();
const H = { Authorization: `Bearer ${auth.tenant_access_token}` };
const t = productDataTargets('kcne');
const base = t.baseToken;
const DASH = 'tbldkz3pU4VQ7Rjt';

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
const dUtc = (v) => new Date(Number(v)).toISOString().slice(0, 10);
const d8 = (v) => new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 10);

const dashFields = await fields(DASH);
const nameOf = new Map(dashFields.map((f) => [f.field_id, f.field_name]));
console.log('=== 看板表字段（id / 名称 / 类型）===');
for (const f of dashFields) console.log(`  ${f.field_id}  ${String(f.field_name).padEnd(12)} type=${f.type}`);

const prodFields = await fields(t.productTable);
const prodNameOf = new Map(prodFields.map((f) => [f.field_id, f.field_name]));
console.log('\n=== 公式里用到的字段 id 解析 ===');
for (const [id, who] of [
  ['fldKTHzsrG', '看板侧 第一条件左值'], ['fldzF9JkgZ', '看板侧 日期右值'],
  ['fldHxbtKaw', '底单侧 商品ID'], ['fldY60t6uc', '底单侧 统计日期'], ['fldKOBM6VQ', '底单侧 被引用值(商品访客数)'],
]) {
  console.log(`  ${id}  ${who}  =>  看板=${nameOf.get(id) ?? '—'} / 底单=${prodNameOf.get(id) ?? '—'}`);
}

const dash = await pull(DASH);
const prod = await pull(t.productTable);
console.log(`\n=== 记录数 ===  看板=${dash.length}  底单=${prod.length}`);

const ID_DASH = 'fldKTHzsrG', DATE_DASH = 'fldzF9JkgZ';
const ID_PROD = 'fldHxbtKaw', DATE_PROD = 'fldY60t6uc';

console.log('\n=== 看板前 5 条的原始值 ===');
for (const r of dash.slice(0, 5)) {
  const f = r.fields ?? {};
  const idv = f[nameOf.get(ID_DASH)];
  const dv = f[nameOf.get(DATE_DASH)];
  console.log(`  ${r.record_id}  商品ID=${JSON.stringify(idv)}  日期=${JSON.stringify(dv)}` +
    (typeof dv === 'number' ? `  (UTC读=${dUtc(dv)} +8读=${d8(dv)})` : ''));
}

// 看板日期字段的读法分布
const dv = new Map();
for (const r of dash) {
  const v = (r.fields ?? {})[nameOf.get(DATE_DASH)];
  if (typeof v !== 'number') { dv.set(`非数字:${JSON.stringify(v)}`, (dv.get(`非数字:${JSON.stringify(v)}`) ?? 0) + 1); continue; }
  const k = `${d8(v)} (UTC读=${dUtc(v)})`;
  dv.set(k, (dv.get(k) ?? 0) + 1);
}
console.log('\n=== 看板「日期」字段按 +8 读法分布 ===');
for (const [k, n] of [...dv.entries()].sort()) console.log(`  ${k} : ${n}`);

// 底单：商品ID -> 该商品的所有 (时间戳, +8日)
const prodById = new Map();
for (const r of prod) {
  const f = r.fields ?? {};
  const id = String(f[prodNameOf.get(ID_PROD)] ?? '');
  const ts = f[prodNameOf.get(DATE_PROD)];
  if (!prodById.has(id)) prodById.set(id, []);
  prodById.get(id).push(ts);
}

let exact = 0, sameDayDiffTs = 0, noId = 0, noDay = 0;
const samples = [];
for (const r of dash) {
  const f = r.fields ?? {};
  const id = String(f[nameOf.get(ID_DASH)] ?? '');
  const ts = f[nameOf.get(DATE_DASH)];
  if (typeof ts !== 'number') { noId += 1; continue; }
  const list = prodById.get(id);
  if (!list) { noId += 1; continue; }
  if (list.includes(ts)) { exact += 1; continue; }
  const hit = list.filter((x) => typeof x === 'number' && d8(x) === d8(ts));
  if (hit.length > 0) {
    sameDayDiffTs += 1;
    if (samples.push({ id, dash: dUtc(ts), prod: dUtc(hit[0]), dashTs: ts, prodTs: hit[0] }) > 3) samples.pop();
  } else noDay += 1;
}
console.log('\n=== 逐个 (商品ID, 日期) 与底单比对 ===');
console.log(`  时间戳完全相同（引用应命中）           = ${exact}`);
console.log(`  同一天 +8 读法相同、但时间戳不同        = ${sameDayDiffTs}   <= 关键`);
console.log(`  底单里没有这个商品ID                    = ${noId}`);
console.log(`  有该商品但那天没有记录                  = ${noDay}`);
console.log('\n  样例（看板日期 / 底单同日的实际值）：');
for (const s of samples) console.log(`    商品ID=${s.id}  看板ts=${s.dashTs}(UTC读=${s.dash})  底单ts=${s.prodTs}(UTC读=${s.prod})`);

// 看板「访客数」这个 lookup 在 API 里算出来的值
const LOOK = '访客数';
let withVal = 0, emptyVal = 0;
for (const r of dash) {
  const v = (r.fields ?? {})[LOOK];
  const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '';
  if (empty) emptyVal += 1; else withVal += 1;
}
console.log(`\n=== 看板「访客数」字段的计算结果（API 返回）===`);
console.log(`  有值 = ${withVal}   空 = ${emptyVal}`);
const firstFew = [];
for (const r of dash) {
  const f = r.fields ?? {};
  const v = f[LOOK];
  const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '';
  firstFew.push(`${r.record_id} 日期ts=${f[nameOf.get(DATE_DASH)]} 访客数=${empty ? '〈空〉' : JSON.stringify(v)}`);
  if (firstFew.length >= 8) break;
}
for (const s of firstFew) console.log('  ' + s);
