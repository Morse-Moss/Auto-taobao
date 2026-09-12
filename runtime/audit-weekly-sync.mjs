// Read-only audit of keyword base sync state (batch 6).
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TABLES = {
  weekly: 'tblHJpDjwAyuHrTK',     // 关键词分析 V1（2026-09-11）
  history: 'tblh1Rwt0LE68KXc',    // 关键词历史总表 V1
  library: 'tblXJSGLoHt5z8Jv',    // 关键词编号库 V1
  protected: 'tblG5sd2WfunbpLq',  // 关键词分析 V1（2026-08-29）
};

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = readEnv('E:/小红书/.env.local');
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then(r => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const token = auth.tenant_access_token;

async function api(path) {
  const res = await fetch(`${API_ROOT}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await res.json();
  if (!res.ok || payload.code !== 0) throw new Error(`API ${path}: ${payload.code} ${payload.msg}`);
  return payload.data ?? {};
}
async function listRecords(tableId) {
  const records = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${q}`);
    records.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return records;
}
const plain = (v) => v == null ? '' : Array.isArray(v) ? v.map(x => x?.text ?? x?.name ?? '').join('、') : typeof v === 'object' ? String(v.text ?? v.name ?? v.value ?? '') : String(v).trim();

const report = {};

// weekly table
const weekly = await listRecords(TABLES.weekly);
const empty = { 标准归并词: 0, 关键词分类: 0, 细分标签: 0, 用户意图: 0, 内容热度: 0, 采集日期: 0, 已有有效批次数: 0 };
const heatDist = {}; const intentDist = {}; const classDist = {};
const huitunFilled = weekly.filter(r => { const v = r.fields?.['灰豚话题浏览量']; return v != null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) ? plain(v) === '' : false); }).length;
for (const r of weekly) {
  for (const k of Object.keys(empty)) {
    const v = r.fields?.[k];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) empty[k]++;
  }
  heatDist[plain(r.fields?.['内容热度'])] = (heatDist[plain(r.fields?.['内容热度'])] || 0) + 1;
  intentDist[plain(r.fields?.['用户意图'])] = (intentDist[plain(r.fields?.['用户意图'])] || 0) + 1;
  classDist[plain(r.fields?.['关键词分类'])] = (classDist[plain(r.fields?.['关键词分类'])] || 0) + 1;
}
report.weekly = {
  tableId: TABLES.weekly, total: weekly.length, emptyFields: empty,
  huitunFilled, heatDist, intentDist: Object.fromEntries(Object.entries(intentDist).sort((a,b)=>b[1]-a[1])),
  classDist: Object.fromEntries(Object.entries(classDist).sort((a,b)=>b[1]-a[1])),
  sampleFormula: (() => { const r = weekly[0]; return { kw: plain(r.fields?.['搜索词']) || plain(r.fields?.['原始关键词']), 一级类目: plain(r.fields?.['一级类目']), 搜索热度: plain(r.fields?.['搜索热度']), 交易热度: plain(r.fields?.['交易热度']), 是否重点词: plain(r.fields?.['是否重点词']), 优先级: plain(r.fields?.['优先级']), 对应产品方向: plain(r.fields?.['对应产品方向']), 近2周重点达标次数: plain(r.fields?.['近2周重点达标次数']) }; })(),
};

// history table
const history = await listRecords(TABLES.history);
const batchCount = {};
for (const r of history) {
  const b = plain(r.fields?.['批次号']) || plain(r.fields?.['批次数']);
  batchCount[b || '(空)'] = (batchCount[b || '(空)'] || 0) + 1;
}
report.history = { tableId: TABLES.history, total: history.length, batchCount };

// library
const library = await listRecords(TABLES.library);
report.library = { tableId: TABLES.library, total: library.length };

// protected
const prot = await listRecords(TABLES.protected);
report.protected = { tableId: TABLES.protected, total: prot.length };

console.log(JSON.stringify(report, null, 2));
