#!/usr/bin/env node
// 只读诊断：列出指定表的视图（含筛选条件）以定位仪表盘的数据来源
import fs from 'node:fs';

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const env = { ...loadEnv(process.env.FEISHU_ENV_FILE || 'E:/小红书/.env.local'), ...process.env };
const APP = process.env.FEISHU_APP_TOKEN || 'OWebbPUcBa7B8JseYLccQCy9nkf';
const ROOT = 'https://open.feishu.cn/open-apis';
const a = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
});
const ab = await a.json();
if (!a.ok || ab.code !== 0) throw new Error(`auth ${a.status} ${ab.code} ${ab.msg}`);
const token = ab.tenant_access_token;
async function req(p) {
  const r = await fetch(ROOT + p, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok || j.code !== 0) throw new Error(`${p} ${r.status} ${j.code} ${j.msg}`);
  return j.data || {};
}

const TABLES = (process.env.PROBE_TABLES || 'tblSS5bxyIeXgngI,tblOIPXlFVk91laj,tbld2LVUhXBuIEwD,tblJ9LHFN6pMVjPv').split(',');
for (const tid of TABLES) {
  let views = [], pt;
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (pt) q.set('page_token', pt);
    const d = await req(`/bitable/v1/apps/${APP}/tables/${tid}/views?${q}`);
    views.push(...(d.items || []));
    pt = d.has_more ? d.page_token : undefined;
  } while (pt);
  console.log(`\n===== ${tid}  视图 ${views.length} 个 =====`);
  for (const v of views) {
    console.log(`  - view_id=${v.view_id} name=${v.view_name} type=${v.view_type}`);
  }
}
