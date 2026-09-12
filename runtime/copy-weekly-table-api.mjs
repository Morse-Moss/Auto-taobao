// API-based clone of the protected weekly keyword table (structure only).
// Replaces the broken Feishu UI "复制数据表" flow (context menu suppressed by new frontend).
//
// Steps:
//  1. Read full field schemas of the protected table.
//  2. Create new table via bitable API.
//  3. Rename default primary field to the protected primary name; create remaining
//     non-formula fields in schema order (select options passed by name).
//  4. Create formula fields, rewriting self-references
//     bitable::$table[OLD_TBL].$field[OLD_FLD] -> bitable::$table[NEW_TBL].$field[NEW_FLD].
//
// Usage: node copy-weekly-table-api.mjs [--apply]
//   default is dry-run (prints plan only).

import { readFileSync } from 'node:fs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const SOURCE_TABLE = 'tblG5sd2WfunbpLq'; // 关键词分析 V1（2026-08-29）
const NEW_TABLE_NAME = '关键词分析 V1（2026-09-11）';
const APPLY = process.argv.includes('--apply');

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

// --- 1. read source schema ---
const srcFields = [];
let pageToken;
do {
  const q = new URLSearchParams({ page_size: '100' });
  if (pageToken) q.set('page_token', pageToken);
  const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${SOURCE_TABLE}/fields?${q}`);
  srcFields.push(...(data.items ?? []));
  pageToken = data.has_more ? data.page_token : undefined;
} while (pageToken);

const plain = srcFields.filter(f => f.type !== 20);
const formulas = srcFields.filter(f => f.type === 20);
console.log(`source: ${srcFields.length} fields (${plain.length} plain, ${formulas.length} formula)`);
console.log(`target name: ${NEW_TABLE_NAME}, apply=${APPLY}`);

// --- check for existing table with same name (idempotency / resume) ---
const tablesData = await api(`/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
const existing = (tablesData.items ?? []).find(t => t.name === NEW_TABLE_NAME);
let newTableId = null;
if (existing) {
  newTableId = existing.table_id;
  console.log(`table already exists: ${existing.name} ${existing.table_id} — resuming`);
}

// select fields must not carry source-specific option ids on creation
function sanitizeProperty(f) {
  if (!f.property) return null;
  const p = { ...f.property };
  if (Array.isArray(p.options)) {
    p.options = p.options.map(({ name, color }) => ({ name, color }));
  }
  return p;
}

const fieldMap = new Map();

if (newTableId) {
  // resume: map source fields to fields already present in the partial table
  const cur = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${newTableId}/fields?page_size=100`);
  for (const cf of cur.items ?? []) {
    const src = srcFields.find(f => f.field_name === cf.field_name);
    if (src) fieldMap.set(src.field_id, cf.field_id);
  }
  console.log(`resume: ${fieldMap.size}/${srcFields.length} fields already present`);
}

if (!APPLY) {
  for (const f of srcFields) {
    console.log(`  would create: type=${f.type} ui=${f.ui_type} name=${f.field_name}${f.type === 20 ? ' [formula, refs remapped]' : ''}`);
  }
  console.log('dry-run complete; rerun with --apply to create the table');
  process.exit(0);
}

// --- 2. create table ---
if (!newTableId) {
  const created = await api(`/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: NEW_TABLE_NAME } }),
  });
  newTableId = created.table_id;
  console.log(`created table ${NEW_TABLE_NAME} -> ${newTableId}`);
}

// --- 3. list new table's default fields, rename primary ---
const newFieldsData = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${newTableId}/fields?page_size=100`);
const newDefaults = newFieldsData.items ?? [];
const primarySrc = srcFields.find(f => f.is_primary);
if (!fieldMap.has(primarySrc.field_id)) {
  const defaultField = newDefaults[0];
  if (newDefaults.length !== 1) {
    console.warn(`warning: new table has ${newDefaults.length} default fields (expected 1)`);
  }
  await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${newTableId}/fields/${defaultField.field_id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      field_name: primarySrc.field_name,
      type: primarySrc.type,
      ...(primarySrc.property ? { property: primarySrc.property } : {}),
    }),
  });
  console.log(`primary renamed: ${defaultField.field_id} -> ${primarySrc.field_name}`);
  fieldMap.set(primarySrc.field_id, defaultField.field_id);
}

// create remaining plain fields in schema order
for (const f of plain) {
  if (fieldMap.has(f.field_id)) continue;
  const body = { field_name: f.field_name, type: f.type };
  const prop = sanitizeProperty(f);
  if (prop) body.property = prop;
  if (f.ui_type) body.ui_type = f.ui_type;
  if (f.description?.text) body.description = f.description;
  const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${newTableId}/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  fieldMap.set(f.field_id, data.field?.field_id);
  console.log(`created field: ${f.field_name} -> ${data.field?.field_id}`);
}

// --- 4. formula fields with remapped self-references (dependency-ordered) ---
const OLD_REF = new RegExp(`bitable::\\$table\\[${SOURCE_TABLE}\\]\\.\\$field\\[([A-Za-z0-9]+)\\]`, 'g');
const pendingFormulas = [...formulas];
let guard = 0;
while (pendingFormulas.length) {
  let progress = false;
  if (++guard > 50) throw new Error('formula dependency loop failed to converge');
  for (let i = pendingFormulas.length - 1; i >= 0; i--) {
    const f = pendingFormulas[i];
    if (fieldMap.has(f.field_id)) { // already created in a previous run
      pendingFormulas.splice(i, 1);
      progress = true;
      continue;
    }
    let expr = f.property.formula_expression;
    const missing = [];
    const mapped = expr.replace(OLD_REF, (_, oldId) => {
      const newId = fieldMap.get(oldId);
      if (!newId) missing.push(oldId);
      return `bitable::$table[${newTableId}].$field[${newId ?? oldId}]`;
    });
    if (missing.length) continue; // wait for dependency formulas to be created first
    console.log(`creating formula: ${f.field_name}`);
    const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${newTableId}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field_name: f.field_name,
        type: 20,
        ui_type: 'Formula',
        property: { ...f.property, formula_expression: mapped },
      }),
    });
    fieldMap.set(f.field_id, data.field?.field_id);
    pendingFormulas.splice(i, 1);
    progress = true;
    console.log(`created formula: ${f.field_name} -> ${data.field?.field_id}`);
  }
  if (!progress) {
    throw new Error(`unresolvable formula references remain: ${pendingFormulas.map(f => f.field_name).join(', ')}`);
  }
}

console.log(JSON.stringify({ newTableId, name: NEW_TABLE_NAME, fieldCount: srcFields.length }));
