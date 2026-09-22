// 只读 v2：修正「records.fields 的 key 是字段名而不是 field_id」这个坑。
// 目标：① 每张分析表的全部字段（含重名）② 三列公式的「基数项」（上一有效周*达标）填充分布
//       ③ 用字段名索引记录，逐行重算 09-19 的「是否重点词」
// 只发 GET。输出 evidence/keyword-weekly-columns-audit-2026-09-21/field-alignment.txt
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });
const OUT = `${OUTDIR}/field-alignment.txt`;

const lines = [];
const say = (s = '') => { lines.push(String(s)); writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8'); };

const { activeProfileName, keywordBaseToken, loadFeishuCredentials } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const profile = activeProfileName();
const base = keywordBaseToken(profile);
const creds = loadFeishuCredentials(profile);
say(`profile=${profile}  base=${base}`);
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

const FIELD_TYPE = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框', 11: '人员',
  13: '电话', 15: '超链接', 17: '附件', 18: '单向关联', 19: '查找引用', 20: '公式',
  21: '双向关联', 22: '位置', 23: '群聊', 1001: '创建时间', 1002: '修改时间',
  1003: '创建人', 1004: '修改人', 1005: '自动编号',
};
const typename = (t) => `${t}(${FIELD_TYPE[t] ?? '?'})`;

async function paged(url0) {
  const out = []; let pt = '';
  do {
    const d = await GET(`${url0}${url0.includes('?') ? '&' : '?'}page_size=500${pt ? `&page_token=${pt}` : ''}`);
    out.push(...(d.items ?? [])); pt = d.has_more ? d.page_token : '';
  } while (pt);
  return out;
}
const listTables = async () => (await GET(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables?page_size=100`)).items ?? [];
const listFields = (tid) => paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${tid}/fields`);
const listRecords = (tid) => paged(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${tid}/records`);

const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? v.link ?? '');
  return String(v).trim();
};

const tables = await listTables();
const weekly = tables.filter((t) => /关键词分析/u.test(t.name));

const BASE_FIELDS = ['上一有效周重点达标', '上一有效周探索达标', '上一有效周A级达标'];
const TARGET_FIELDS = ['近2周重点达标次数', '近2周探索达标次数', '近2周A级达标次数', '是否重点词'];

const stats = (records, name) => {
  let filled = 0; const dist = new Map();
  for (const r of records) {
    const v = text(r.fields?.[name]);
    if (v === '') continue;
    filled += 1; dist.set(v, (dist.get(v) ?? 0) + 1);
  }
  const top = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, c]) => `${k}×${c}`).join('  ');
  return `有值 ${filled}/${records.length}${filled ? `   分布 ${top}` : ''}`;
};

// ---------- A) 每张表的全部字段（含重名标注） ----------
say('='.repeat(92));
say('A) 各期分析表：全部字段清单（id / 名称 / 类型），同名的标 <<同名>>');
say('='.repeat(92));
const tablePayload = [];
for (const t of weekly) {
  const fields = await listFields(t.table_id);
  const byName = new Map();
  for (const f of fields) { if (!byName.has(f.field_name)) byName.set(f.field_name, []); byName.get(f.field_name).push(f); }
  const records = await listRecords(t.table_id);
  tablePayload.push({ t, fields, byName, records });

  say();
  say('-'.repeat(92));
  say(`${t.table_id}  ${t.name}   字段数=${fields.length}   行数=${records.length}`);
  for (const f of fields) {
    const dup = (byName.get(f.field_name)?.length ?? 0) > 1 ? '   <<同名>>' : '';
    const fx = f.type === 20 ? '  [公式]' : '';
    say(`    ${f.field_id}  ${f.field_name}  ${typename(f.type)}${fx}${dup}`);
  }
}

// ---------- B) 三列公式的「基数项」= 上一有效周*达标（数字字段）填充分布 ----------
say();
say('='.repeat(92));
say('B) 三列公式的基数项「上一有效周*达标」在各期的填充分布（这是跨期结转的载体）');
say('='.repeat(92));
say();
say('表                                上一有效周重点达标        上一有效周探索达标        上一有效周A级达标');
for (const { t, records } of tablePayload) {
  const cells = BASE_FIELDS.map((n) => stats(records, n).padEnd(24, ' '));
  say(`${(`${t.table_id} ${t.name}`).padEnd(34, ' ')}${cells.join('  ')}`);
}

// ---------- C) 目标列（含同名者）在各期的填充 ----------
say();
say('='.repeat(92));
say('C) 目标列填充：同名者逐个列出（公式字段 vs 数字字段可能同名）');
say('='.repeat(92));
for (const { t, fields, byName, records } of tablePayload) {
  say();
  say(`${t.table_id}  ${t.name}`);
  for (const name of TARGET_FIELDS) {
    const list = byName.get(name) ?? [];
    if (!list.length) { say(`  [${name}] 字段不存在`); continue; }
    for (const f of list) {
      const tag = f.type === 20 ? '公式' : typename(f.type);
      say(`  [${name}] id=${f.field_id} type=${tag}  ${stats(records, name)}`);
    }
  }
}

// ---------- D) 09-19 逐行重算「是否重点词」（按字段名索引记录） ----------
say();
say('='.repeat(92));
say('D) 09-19（tblZsUns9353w3nl）逐行重算「是否重点词」：分支落点与待数据成因');
say('='.repeat(92));
const t19 = tablePayload.find((x) => x.t.table_id === 'tblZsUns9353w3nl');
if (!t19) { say('找不到 09-19 表'); }
else {
  const r0 = t19.records[0];
  say();
  say(`首行记录里与「近2周/搜索/交易/内容/关键词分类」相关的 key 与取值（验明同名覆盖行为）：`);
  for (const k of Object.keys(r0.fields ?? {})) {
    if (/近2周|搜索|交易|内容|分类|细分|搜索词/.test(k)) say(`    key="${k}"  ->  ${JSON.stringify(text(r0.fields[k])).slice(0, 80)}`);
  }

  const g = (r, name) => text(r.fields?.[name]);
  const branches = new Map();
  const detail = [];
  for (const r of t19.records) {
    const searchWord = g(r, '搜索词');
    const wordType = g(r, '关键词分类');
    const search = g(r, '搜索热度');
    const trade = g(r, '交易热度');
    const hit = g(r, '近2周重点达标次数');
    let out, reason;
    if (searchWord === '') { out = ''; reason = 'A 搜索词空 -> 输出空'; }
    else if (wordType === '品牌词') { out = '否'; reason = 'B 品牌词 -> 否'; }
    else if (search === '' || search === '待核验' || trade === '' || trade === '待核验') { out = '待数据'; reason = 'C 搜索/交易热度空或待核验 -> 待数据'; }
    else if (search === '高' && (trade === '中' || trade === '高')) {
      if (hit === '' || hit === '待核验') { out = '待数据'; reason = 'D 高搜索×中/高交易，但「近2周重点达标次数」空 -> 待数据'; }
      else { out = Number(hit) >= 2 ? '是' : '否'; reason = Number(hit) >= 2 ? 'E 达标次数>=2 -> 是' : 'F 达标次数<2 -> 否'; }
    } else { out = '否'; reason = 'G 搜索非高 或 交易非中/高 -> 否'; }
    const key = `${out === '' ? '(空)' : out}   ${reason}`;
    branches.set(key, (branches.get(key) ?? 0) + 1);
    if (reason.startsWith('D ') || reason.startsWith('E ')) detail.push({ 搜索词: searchWord, 关键词分类: wordType, 搜索热度: search, 交易热度: trade, 近2周重点达标次数: hit, 判定: out || '(空)' });
  }
  say();
  say('分支落点统计：');
  for (const [k, c] of [...branches.entries()].sort((a, b) => b[1] - a[1])) say(`  ${String(c).padStart(4)} 行  ->  ${k}`);
  say();
  say(`落到 D（待数据）/ E（是）的行明细，共 ${detail.length} 行：`);
  for (const d of detail.slice(0, 40)) say(`    ${JSON.stringify(d)}`);
}

say();
say('=== 完（本脚本只发 GET，未做任何写入）===');
console.log(`written: ${OUT}`);
