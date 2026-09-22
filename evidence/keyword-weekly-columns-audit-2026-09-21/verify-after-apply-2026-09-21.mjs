// 独立回读（换一套实现，不信脚本自报）：apply 之后重读 09-19 表与历史表。
// 只发 GET。输出 evidence/keyword-weekly-columns-audit-2026-09-21/verify-after-apply.txt
import { writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21/verify-after-apply.txt`;
const lines = [];
const say = (s = '') => { lines.push(String(s)); writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8'); };

const { activeProfileName, keywordBaseToken, loadFeishuCredentials } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const base = keywordBaseToken(activeProfileName());
const creds = loadFeishuCredentials(activeProfileName());

const auth = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code}`);
const H = { Authorization: `Bearer ${auth.tenant_access_token}` };
const GET = async (u) => {
  const r = await fetch(u, { headers: H }).then((x) => x.json());
  if (r.code !== 0) throw new Error(`${u} -> ${r.code} ${r.msg}`);
  return r.data;
};
async function paged(url0, size = 500) {
  const out = []; let pt = '';
  do {
    const d = await GET(`${url0}${url0.includes('?') ? '&' : '?'}page_size=${size}${pt ? `&page_token=${pt}` : ''}`);
    out.push(...(d.items ?? [])); pt = d.has_more ? d.page_token : '';
  } while (pt);
  return out;
}
const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? v.link ?? '');
  return String(v).trim();
};
const stat = (records, name) => {
  let filled = 0; const dist = new Map();
  for (const r of records) {
    const v = text(r.fields?.[name]);
    if (v === '') continue;
    filled += 1; dist.set(v, (dist.get(v) ?? 0) + 1);
  }
  const top = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, c]) => `${k}×${c}`).join('  ');
  return `有值 ${filled}/${records.length}${filled ? `   分布 ${top}` : ''}`;
};

say(`独立回读（apply 之后）  时间=${new Date().toISOString()}`);
say();

// ---- 09-19 分析表 ----
const T19 = 'tblZsUns9353w3nl';
const recs19 = await paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${T19}/records`);
say(`=== 09-19 分析表（${T19}）  行数=${recs19.length} ===`);
for (const c of [
  '上一有效周重点达标', '上一有效周探索达标', '上一有效周A级达标',
  '近2周重点达标次数', '近2周探索达标次数', '近2周A级达标次数', '是否重点词',
]) say(`  ${c}：${stat(recs19, c)}`);
say();

// ---- 历史表 ----
const HIST = 'tbl7HbH11JsQx6FL';
const recsH = await paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${HIST}/records`);
say(`=== 关键词历史总表（${HIST}）  行数=${recsH.length} ===`);
const groups = new Map();
for (const r of recsH) {
  const b = Number(text(r.fields?.['批次编号']));
  if (!groups.has(b)) groups.set(b, []);
  groups.get(b).push(r);
}
for (const b of [...groups.keys()].sort((x, y) => x - y)) {
  const rows = groups.get(b);
  if (b < 6) { say(`  批次 ${b}  行数=${rows.length}  （略）`); continue; }
  say(`  批次 ${b}  行数=${rows.length}`);
  for (const c of ['批次有效性', '本期标记', '重点达标', 'A级达标', '探索达标', '标准归并词', '是否重点词', '优先级']) {
    say(`      ${c}：${stat(rows, c)}`);
  }
}
say();
say('=== 完（只发 GET）===');
console.log(`written: ${OUT}`);
