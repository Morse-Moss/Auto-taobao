// 只读审计：关键词库里各期「关键词分析」表的列填充情况（用户 2026-09-21 问「近2周…达标次数为空、是否重点词=待数据」）。
// 只发 GET，不写任何东西。输出 evidence/keyword-weekly-columns-audit-2026-09-21/audit.txt
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });
const OUT = `${OUTDIR}/audit.txt`;

const lines = [];
const say = (s = '') => { lines.push(String(s)); writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8'); };

const { activeProfileName, envFilePath, keywordBaseToken, loadFeishuCredentials } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);

const profile = activeProfileName();
const base = keywordBaseToken(profile);
const creds = loadFeishuCredentials(profile);
say(`profile=${profile}  base=${base}  env-file=${envFilePath(profile)}`);
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

const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? v.link ?? '');
  return String(v).trim();
};

// ---- 1) 全部表 ----
const tables = [];
let pageToken = '';
do {
  const d = await GET(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables?page_size=100${pageToken ? `&page_token=${pageToken}` : ''}`);
  tables.push(...(d.items ?? []));
  pageToken = d.has_more ? d.page_token : '';
} while (pageToken);

say(`=== base 内共 ${tables.length} 张表 ===`);
for (const t of tables) say(`  ${t.table_id}  ${t.name}`);
say();

const TARGET_COLUMNS = ['近2周重点达标次数', '近2周探索达标次数', '近2周A级达标次数', '是否重点词'];
const CONTEXT_COLUMNS = ['搜索词', '优先级', '内容热度', '搜索热度', '交易热度', '灰豚话题浏览量', '对应产品方向'];

const FIELD_TYPE = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框', 11: '人员',
  13: '电话', 15: '超链接', 17: '附件', 18: '单向关联', 19: '查找引用', 20: '公式',
  21: '双向关联', 22: '位置', 23: '群聊', 1001: '创建时间', 1002: '修改时间',
  1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

const weekly = tables.filter((t) => /关键词分析/u.test(t.name));
say(`=== 命中「关键词分析」的表：${weekly.length} 张 ===`);

for (const t of weekly) {
  say();
  say(`${'='.repeat(72)}`);
  say(`${t.table_id}  ${t.name}`);

  // 字段
  const fields = [];
  let fp = '';
  do {
    const d = await GET(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${t.table_id}/fields?page_size=100${fp ? `&page_token=${fp}` : ''}`);
    fields.push(...(d.items ?? []));
    fp = d.has_more ? d.page_token : '';
  } while (fp);
  const byName = new Map(fields.map((f) => [f.field_name, f]));

  say(`  字段数=${fields.length}`);
  say(`  目标列的字段定义：`);
  for (const name of TARGET_COLUMNS) {
    const f = byName.get(name);
    if (!f) { say(`    ${name}：字段不存在`); continue; }
    const formula = f.property?.formula_expression ? `  公式=${f.property.formula_expression}` : '';
    say(`    ${name}：type=${f.type}(${FIELD_TYPE[f.type] ?? '?'})${formula}`);
  }

  // 记录
  const records = [];
  let rp = '';
  do {
    const d = await GET(`https://open.feishu.cn/open-apis/bitable/v1/apps/${base}/tables/${t.table_id}/records?page_size=500${rp ? `&page_token=${rp}` : ''}`);
    records.push(...(d.items ?? []));
    rp = d.has_more ? d.page_token : '';
  } while (rp);

  say(`  行数=${records.length}`);

  const report = (name, list) => {
    let filled = 0;
    const dist = new Map();
    for (const r of list) {
      const v = text(r.fields?.[name]);
      if (v === '') continue;
      filled += 1;
      dist.set(v, (dist.get(v) ?? 0) + 1);
    }
    const top = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, c]) => `${k}×${c}`).join('  ');
    return `${name}：有值 ${filled}/${list.length}${filled === 0 ? '' : `   取值分布 ${top}`}`;
  };

  say(`  --- 目标列填充 ---`);
  for (const name of TARGET_COLUMNS) say(`    ${report(name, records)}`);
  say(`  --- 上游列填充（对照）---`);
  for (const name of CONTEXT_COLUMNS) {
    if (!byName.has(name)) { say(`    ${name}：字段不存在`); continue; }
    say(`    ${report(name, records)}`);
  }
}

say();
say('=== 完（本脚本只发 GET，未做任何写入）===');
console.log(`written: ${OUT}`);
