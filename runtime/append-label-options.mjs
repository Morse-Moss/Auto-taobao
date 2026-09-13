// Append missing 细分标签 options to the new weekly table's MultiSelect field.
import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.LABEL_APP_TOKEN ?? 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TABLE_ID = process.env.LABEL_TABLE_ID ?? 'tblHJpDjwAyuHrTK';

const NEW_OPTIONS = (process.env.LABEL_NEW_OPTIONS
  ? process.env.LABEL_NEW_OPTIONS.split(/[、,]/u).map((s) => s.trim()).filter(Boolean)
  : [
      '品牌/赛高', '品牌/观博', '品牌/勒示', '品牌/杜菲尼', '品牌/Bette', '品牌/roca', '品牌/tw',
      '功能/加厚', '材质/软体', '尺寸/60cm', '尺寸/70cm', '款式/自砌', '款式/泡澡桶',
    ]);

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
    throw new Error(`API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${payload.code} ${payload.msg}`);
  }
  return payload.data ?? {};
}

const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`);
const labelField = (data.items ?? []).find(f => f.field_name === '细分标签');
if (!labelField) throw new Error('细分标签 field not found');

const existing = labelField.property?.options ?? [];
const existingNames = new Set(existing.map(o => o.name));
const toAdd = NEW_OPTIONS.filter(name => !existingNames.has(name));
if (toAdd.length === 0) {
  console.log('nothing to add; all options already present');
  process.exit(0);
}
const maxColor = Math.max(-1, ...existing.map(o => Number(o.color) || 0));
const merged = [
  ...existing,
  ...toAdd.map((name, i) => ({ name, color: (maxColor + 1 + i) % 10 })),
];
const result = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${labelField.field_id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    field_name: labelField.field_name,
    type: labelField.type,
    property: { ...labelField.property, options: merged },
  }),
});
console.log(`appended ${toAdd.length} options: ${toAdd.join('、')}`);
console.log(`options total now: ${result.field?.property?.options?.length ?? '?'}`);
