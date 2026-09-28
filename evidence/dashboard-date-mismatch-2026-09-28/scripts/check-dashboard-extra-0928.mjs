// 只读：① 推广底单的日期字段读法；② 看板里「无日期条件的引用」与「有日期条件的引用」的有值率对照。
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
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const dUtc = (v) => new Date(Number(v)).toISOString().slice(0, 10);
const d8 = (v) => new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ① 推广底单日期读法
const pf = await fields(t.promotionTable);
const pname = new Map(pf.map((f) => [f.field_id, f.field_name]));
const promo = await pull(t.promotionTable);
console.log(`=== 商品推广数据底单：${promo.length} 行 ===`);
console.log(`  日期字段 id=fldXWNNF10 => 名称「${pname.get('fldXWNNF10') ?? '?'}」`);
const pstat = new Map();
for (const r of promo) {
  const v = (r.fields ?? {})[pname.get('fldXWNNF10')];
  const k = typeof v === 'number' ? `${d8(v)} (UTC读=${dUtc(v)})${dUtc(v) === d8(v) ? ' 新式' : ' 旧式'}` : `非数字:${JSON.stringify(v)}`;
  pstat.set(k, (pstat.get(k) ?? 0) + 1);
}
for (const [k, n] of [...pstat.entries()].sort()) console.log(`  ${k} : ${n}`);

// ② 看板：有/无日期条件的引用字段，各自的有值率
const dash = await pull(DASH);
const NO_DATE = ['店铺', '图片', '型号'];
const WITH_DATE = ['访客数', '支付金额', '收藏人数', '加购人数', '询单量'];
console.log(`\n=== 看板 ${dash.length} 行：两类引用的有值率 ===`);
console.log('  这一类只按「商品ID」匹配（无日期条件）：');
for (const f of NO_DATE) {
  let has = 0;
  for (const r of dash) if (!isEmpty((r.fields ?? {})[f])) has += 1;
  console.log(`    ${f.padEnd(6)} 有值 ${String(has).padStart(5)} / ${dash.length}  = ${(has / dash.length * 100).toFixed(1)}%`);
}
console.log('  这一类多一个「日期相等」条件：');
for (const f of WITH_DATE) {
  let has = 0;
  for (const r of dash) if (!isEmpty((r.fields ?? {})[f])) has += 1;
  console.log(`    ${f.padEnd(6)} 有值 ${String(has).padStart(5)} / ${dash.length}  = ${(has / dash.length * 100).toFixed(1)}%`);
}

// 按天拆：看板「访客数」在哪几天有值
const DATE_DASH = 'fldzF9JkgZ';
const perDay = new Map();
for (const r of dash) {
  const f = r.fields ?? {};
  const v = f['日期'];
  if (typeof v !== 'number') continue;
  const k = d8(v);
  if (!perDay.has(k)) perDay.set(k, { n: 0, has: 0 });
  const b = perDay.get(k); b.n += 1;
  if (!isEmpty(f['访客数'])) b.has += 1;
}
console.log('\n=== 看板「访客数」按天有值率 ===');
for (const [d, b] of [...perDay.entries()].sort()) {
  const mark = b.has === 0 ? '   <== 整天空' : '';
  console.log(`  ${d}  ${String(b.has).padStart(3)} / ${String(b.n).padStart(3)}${mark}`);
}
