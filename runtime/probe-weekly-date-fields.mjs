#!/usr/bin/env node
// 只读诊断：竞品周表的 数据开始日期/数据结束日期/采集时间 填充情况
import fs from 'node:fs';
import path from 'node:path';

function loadEnv(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const envFile = process.env.FEISHU_ENV_FILE || 'E:/小红书/.env.local';
const env = { ...loadEnv(envFile), ...process.env };
const appId = env.FEISHU_APP_ID;
const appSecret = env.FEISHU_APP_SECRET;
const APP = process.env.FEISHU_APP_TOKEN || 'OWebbPUcBa7B8JseYLccQCy9nkf';
if (!appId || !appSecret) throw new Error('missing FEISHU_APP_ID/SECRET');

const ROOT = 'https://open.feishu.cn/open-apis';
const auth = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const ab = await auth.json();
if (!auth.ok || ab.code !== 0) throw new Error(`auth failed ${auth.status} ${ab.code} ${ab.msg}`);
const token = ab.tenant_access_token;

async function req(method, p, body) {
  const r = await fetch(ROOT + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok || j.code !== 0) throw new Error(`${method} ${p} ${r.status} ${j.code} ${j.msg}`);
  return j.data || {};
}

const FIELDS = ['数据开始日期', '数据结束日期', '采集时间'];

// 1. 列出所有表
let tables = [], pt;
do {
  const q = new URLSearchParams({ page_size: '100' });
  if (pt) q.set('page_token', pt);
  const d = await req('GET', `/bitable/v1/apps/${APP}/tables?${q}`);
  tables.push(...(d.items || []));
  pt = d.has_more ? d.page_token : undefined;
} while (pt);

const weekly = tables.filter((t) => /竞品周/.test(t.name ?? ''));
console.log(`base 共 ${tables.length} 张表，其中竞品周表 ${weekly.length} 张`);

for (const t of weekly) {
  const fields = (await req('GET', `/bitable/v1/apps/${APP}/tables/${t.table_id}/fields?page_size=200`)).items || [];
  const meta = {};
  for (const f of fields) {
    if (FIELDS.includes(f.field_name)) meta[f.field_name] = { type: f.type, ui: f.ui_type, prop: f.property ? JSON.stringify(f.property).slice(0, 120) : null };
  }
  // 统计填充情况 + 采样已有值
  let total = 0, filled = 0;
  const samples = {};
  let p;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (p) q.set('page_token', p);
    const d = await req('GET', `/bitable/v1/apps/${APP}/tables/${t.table_id}/records?${q}`);
    for (const r of d.items || []) {
      total += 1;
      let any = false;
      for (const f of FIELDS) {
        const v = r.fields?.[f];
        if (v !== undefined && v !== null) {
          any = true;
          if (samples[f] === undefined) samples[f] = v;
        }
      }
      if (any) filled += 1;
    }
    p = d.has_more ? d.page_token : undefined;
  } while (p);
  console.log(`\n== ${t.name} (${t.table_id})  行数 ${total}，三字段任一有值 ${filled}`);
  console.log('   字段定义:', JSON.stringify(meta));
  console.log('   采样值:', JSON.stringify(samples));
}
