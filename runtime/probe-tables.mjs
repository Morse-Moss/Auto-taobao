#!/usr/bin/env node
// 只读：列出 base 内全部数据表
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
const token = ab.tenant_access_token;
const r = await fetch(`${ROOT}/bitable/v1/apps/${APP}/tables?page_size=100`, { headers: { Authorization: `Bearer ${token}` } });
const j = await r.json();
for (const t of j.data?.items || []) console.log(`${t.table_id}  ${t.name}`);
