// Probe: read full field schemas of the protected weekly keyword table.
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TABLE_ID = process.argv[2] || 'tblG5sd2WfunbpLq';

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
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then(r => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const token = auth.tenant_access_token;

async function api(path, init = {}) {
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const payload = await res.json();
  if (!res.ok || payload.code !== 0) {
    throw new Error(`API ${path} failed: ${res.status} ${payload.code} ${payload.msg}`);
  }
  return payload.data ?? {};
}

const fields = [];
let pageToken;
do {
  const q = new URLSearchParams({ page_size: '100' });
  if (pageToken) q.set('page_token', pageToken);
  const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?${q}`);
  fields.push(...(data.items ?? []));
  pageToken = data.has_more ? data.page_token : undefined;
} while (pageToken);

console.log(JSON.stringify({
  tableId: TABLE_ID,
  fieldCount: fields.length,
  fields: fields.map(f => ({
    field_id: f.field_id,
    field_name: f.field_name,
    type: f.type,
    ui_type: f.ui_type,
    is_primary: f.is_primary,
    property: f.property ?? null,
    description: f.description ?? null,
  })),
}, null, 2));
