// 只读：新 base 底单近 N 天，每天行数 + 销售1部 8 店是否齐全。一次拉全表本地聚合。
import { readFileSync } from 'node:fs';
import { dailyReportTargets } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';

const DAYS = Number(process.argv[2] || 20);
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
function norm(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(norm).join('');
  if (typeof v === 'object') { if (typeof v.value === 'number') return norm(v.value); return norm(v.text ?? v.name ?? v.value ?? ''); }
  if (typeof v === 'number' && v > 1e11) { const d = new Date(v + 8 * 3600 * 1000); return d.toISOString().slice(0, 10); }
  return String(v).trim();
}
const S1 = {
  '里可林家居': '里可林淘宝', '网林家居旗舰店': '网林天猫', '盖文全卫定制': '盖文淘宝', '盖文旗舰店': '盖文天猫',
  '科塔全卫定制': '科塔淘宝', '网林全卫定制': '网林淘宝', '里可林旗舰店': '里可林天猫', '网林定制家居': '网林家居',
};

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
console.log('base =', T.baseToken, '| 底单总行数 =', rows.length);

const byDay = new Map();
for (const r of rows) {
  const d = norm(r.fields['统计日期']); if (!d) continue;
  const name = norm(r.fields['店铺名称']);
  if (!byDay.has(d)) byDay.set(d, new Map());
  // 同名多行只记一次
  byDay.get(d).set(name, (byDay.get(d).get(name) || 0) + 1);
}
const days = [...byDay.keys()].sort().slice(-DAYS);
console.log(`\n近 ${DAYS} 天（最新 ${days[days.length - 1]}）：`);
console.log('日期        总行数  销售1部(命中/8)  缺哪些');
for (const d of days) {
  const got = byDay.get(d);
  const miss = Object.keys(S1).filter((k) => !got.has(k)).map((k) => S1[k]);
  const hitN = Object.keys(S1).filter((k) => got.has(k)).length;
  console.log(`${d}   ${String(got.size).padStart(3)}    ${hitN}/8          ${miss.length ? miss.join('、') : '—'}`);
}
