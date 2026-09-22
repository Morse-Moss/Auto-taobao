// 只读：读「关键词历史总表 V1」，按批次分组看 批次有效性 / 本期标记 / 三个快照字段 的填充，
// 用来判定 1.6 决策历史同步（sync-decision-history.mjs --apply）到底对哪些批次成功写过。
// 只发 GET。输出 evidence/keyword-weekly-columns-audit-2026-09-21/history-batch-state.txt
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });
const OUT = `${OUTDIR}/history-batch-state.txt`;

const lines = [];
const say = (s = '') => { lines.push(String(s)); writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8'); };

const { activeProfileName, keywordBaseToken, loadFeishuCredentials } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const profile = activeProfileName();
const base = keywordBaseToken(profile);
const creds = loadFeishuCredentials(profile);
const HISTORY = 'tbl7HbH11JsQx6FL';
say(`profile=${profile}  base=${base}  历史表=${HISTORY}`);
say(`生成时间=${new Date().toISOString()}`);
say();

const auth = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const H = { Authorization: `Bearer ${auth.tenant_access_token}` };
const GET = async (url) => {
  const res = await fetch(url, { headers: H }).then((r) => r.json());
  if (res.code !== 0) throw new Error(`${url} -> ${res.code} ${res.msg}`);
  return res.data;
};
const paged = async (url0) => {
  const out = []; let pt = '';
  do {
    const d = await GET(`${url0}${url0.includes('?') ? '&' : '?'}page_size=500${pt ? `&page_token=${pt}` : ''}`);
    out.push(...(d.items ?? [])); pt = d.has_more ? d.page_token : '';
  } while (pt);
  return out;
};
const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? v.link ?? '');
  return String(v).trim();
};

const fields = await paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${HISTORY}/fields`);
say(`历史表字段数=${fields.length}`);
for (const f of fields) {
  const fx = f.type === 20 ? '  [公式]' : '';
  say(`    ${f.field_id}  ${f.field_name}  ${f.type}${fx}`);
}
say();

const records = await paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${HISTORY}/records`);
say(`历史表行数=${records.length}`);
say();

const dist = (list, name) => {
  const m = new Map();
  let filled = 0;
  for (const r of list) { const v = text(r.fields?.[name]); if (v === '') continue; filled += 1; m.set(v, (m.get(v) ?? 0) + 1); }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${k}×${c}`).join('  ');
  return `有值 ${filled}/${list.length}${filled ? `   ${top}` : ''}`;
};

const groups = new Map();
for (const r of records) {
  const b = Number(text(r.fields?.['批次编号']));
  const key = Number.isInteger(b) && b > 0 ? b : '<无效批次号>';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const batchKeys = [...groups.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
say('='.repeat(96));
say('按批次分组：批次有效性 / 本期标记 / 三个快照字段 / 可视化快照字段');
say('='.repeat(96));
for (const b of batchKeys) {
  const list = groups.get(b);
  say();
  say(`批次 ${b}   行数=${list.length}`);
  say(`    批次有效性：      ${dist(list, '批次有效性')}`);
  say(`    本期标记：        ${dist(list, '本期标记')}`);
  say(`    重点达标：        ${dist(list, '重点达标')}`);
  say(`    A级达标：         ${dist(list, 'A级达标')}`);
  say(`    探索达标：        ${dist(list, '探索达标')}`);
  say(`    标准归并词：      ${dist(list, '标准归并词')}`);
  say(`    是否重点词：      ${dist(list, '是否重点词')}`);
  say(`    优先级：          ${dist(list, '优先级')}`);
}

say();
say('=== 完（本脚本只发 GET，未做任何写入）===');
console.log(`written: ${OUT}`);
