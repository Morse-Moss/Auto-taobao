// 只读：在重复快照里判定「哪个文件真的被导入过」——用除乱码字段外的所有字段逐行比对。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadFeishuCredentials, productDataTargets } from '../../../runtime/feishu-targets.mjs';
import { PRODUCT_HEADERS, buildProductFields } from '../../../skills/sycm-product-data/scripts/product-core.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const PY = path.join(root, 'skills/sycm-product-data/scripts/read-product-xls.py');
function readXls(file) {
  const r = spawnSync(process.env.PYTHON || 'py', ['-3', PY, path.resolve(file)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`parser failed: ${r.stderr?.trim()}`);
  return JSON.parse(r.stdout);
}
const c = loadFeishuCredentials('kcne');
const auth = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
})).json();
const H = { Authorization: `Bearer ${auth.tenant_access_token}` };
const t = productDataTargets('kcne');
const out = []; let pt = '';
for (;;) {
  const u = `https://open.feishu.cn/open-apis/bitable/v1/apps/${t.baseToken}/tables/${t.productTable}/records?page_size=500` + (pt ? `&page_token=${pt}` : '');
  const j = await (await fetch(u, { headers: H })).json();
  out.push(...(j.data.items ?? []));
  if (!j.data.has_more) break; pt = j.data.page_token;
}
const dPlus8 = (v) => new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dUtc = (v) => new Date(Number(v)).toISOString().slice(0, 10);

// 逐条记录看日期读法分歧
const styles = new Map();
for (const r of out) {
  const raw = r.fields['统计日期'];
  const key = `${dUtc(raw)} / ${dPlus8(raw)}`;
  styles.set(key, (styles.get(key) ?? 0) + 1);
}
console.log('=== 日期读法分布（UTC读法 / +8读法 : 行数）===');
for (const [k, v] of [...styles.entries()].sort()) console.log(`  ${k} : ${v}`);

const existing25 = new Map();
for (const r of out) if (dPlus8(r.fields['统计日期']) === '2026-09-25') existing25.set(String(r.fields['商品ID']), r.fields);
console.log(`\n已有 09-25 底单行 = ${existing25.size}`);

const GARBLED = new Set(['商品名称', '当前在线']);
const dl = path.join(os.homedir(), 'Downloads');
const cands = fs.readdirSync(dl).filter((f) => /商品_全部_2026-09-25_2026-09-25/.test(f) && f.endsWith('.xls'));

console.log('\n=== 候选文件 vs 线上已有 09-25 行：逐字段比对（排除已知乱码字段）===');
for (const name of cands) {
  const raw = readXls(path.join(dl, name));
  const dated = raw.slice(5).filter((row) => Array.isArray(row) && row.length === PRODUCT_HEADERS.length && /^\d{4}-\d{2}-\d{2}$/u.test(row[0]));
  let exact = 0; let diff = 0; let absent = 0; const samples = [];
  for (const row of dated) {
    const id = String(row[1]);
    const live = existing25.get(id);
    if (!live) { absent += 1; continue; }
    const built = buildProductFields(row, PRODUCT_HEADERS);
    const keys = new Set([...Object.keys(built), ...Object.keys(live)]);
    let bad = [];
    for (const k of keys) {
      if (GARBLED.has(k)) continue;
      const a = built[k]; const b = live[k];
      const norm = (v) => (v === undefined || v === null || v === '' ? '' : (typeof v === 'number' ? String(Number(v)) : String(v)));
      if (norm(a) !== norm(b)) bad.push(`${k}: 源=${JSON.stringify(a)} 线上=${JSON.stringify(b)}`);
    }
    if (bad.length === 0) exact += 1; else { diff += 1; if (samples.length < 3) samples.push(`${id} -> ${bad.slice(0, 4).join(' ; ')}`); }
  }
  const stamp = fs.statSync(path.join(dl, name)).mtime.toISOString().slice(0, 19);
  console.log(`\n  ${stamp}  ${name}  n=${dated.length}`);
  console.log(`     完全一致=${exact}  有差异=${diff}  线上无此ID=${absent}`);
  for (const s of samples) console.log(`       ${s}`);
}
