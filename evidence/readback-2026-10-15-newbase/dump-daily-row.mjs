// 只读：dump 底单某天某店的整行字段值（判断是骨架还是有数）。只发 GET。
import { readFileSync } from 'node:fs';
import { dailyReportTargets } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';

const DATE = process.argv[2] || '2026-10-15';
const SHOP = process.argv[3] || '网林家居旗舰店';
const API = 'https://open.feishu.cn/open-apis';
const env = {};
for (const line of readFileSync('E:/小红书/.env.feishu-kcne.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const token = (await (await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
})).json()).tenant_access_token;
if (!token) { console.error('NO TOKEN'); process.exit(1); }

const T = dailyReportTargets('kcne');
console.log('base =', T.baseToken, '| sourceTable =', T.sourceTable);

function norm(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(norm).join('');
  if (typeof v === 'object') { if (typeof v.value === 'number') return norm(v.value); return norm(v.text ?? v.name ?? v.value ?? ''); }
  if (typeof v === 'number' && v > 1e11) { const d = new Date(v + 8 * 3600 * 1000); return d.toISOString().slice(0, 10); }
  return String(v).trim();
}

let pageToken = ''; const rows = [];
do {
  const url = new URL(`${API}/bitable/v1/apps/${T.baseToken}/tables/${T.sourceTable}/records`);
  url.searchParams.set('page_size', '500');
  if (pageToken) url.searchParams.set('page_token', pageToken);
  const b = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (b.code !== 0) { console.error('ERR', JSON.stringify(b).slice(0, 300)); process.exit(1); }
  rows.push(...(b.data.items || []));
  pageToken = b.data.has_more ? b.data.page_token : '';
} while (pageToken);

const hits = rows.filter((r) => norm(r.fields['统计日期']) === DATE && norm(r.fields['店铺名称']) === SHOP);
console.log(`命中 ${hits.length} 行  ${DATE} / ${SHOP}`);
for (const r of hits) {
  const f = r.fields;
  let filled = 0, empty = 0;
  for (const k of Object.keys(f)) { if (k === '统计日期' || k === '店铺名称') continue; const t = norm(f[k]); if (t === '' || t == null) empty++; else filled++; }
  console.log(`  rec=${r.record_id}  字段总数=${Object.keys(f).length} 非空=${filled} 空=${empty}`);
  // 打印常见指标字段
  for (const k of ['店铺ID', '日期', '支付金额', '支付买家数', '商品访客数', '访客数', '询单人数', '客单价', '支付转化率', '推广花费', '推广成交金额']) {
    if (k in f) console.log(`    ${k} = ${norm(f[k]) || '(空)'}`);
  }
  console.log('  --- 全部非空字段 ---');
  for (const k of Object.keys(f)) {
    if (k === '统计日期' || k === '店铺名称') continue;
    const t = norm(f[k]); if (t !== '') console.log(`    ${k} = ${t}`);
  }
}
