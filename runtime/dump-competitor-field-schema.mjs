#!/usr/bin/env node
// Read-only dump of the ACTIVE competitor base schema: every table, every field,
// its type, its id, and — for formula fields — the live formula expression.
//
// Why: the field-level reference for the competitor tables has been reconstructed
// from several places (competitive-v2-core.mjs field definitions, the AI prompt
// markdown, competitor-v2-live-formulas.json). That archived JSON was captured
// against the RETIRED tenant (OWebbPUcBa7B8JseYLccQCy9nkf / tblJ9LHFN6pMVjPv),
// so it cannot be quoted as "what the table looks like now". This script is the
// evidence layer the reference document cites.
//
// Strictly read-only: only GET requests. Never writes to Feishu.
//
// Usage:
//   node runtime/dump-competitor-field-schema.mjs [--out <file>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  activeProfileName,
  competitorBaseToken,
  loadFeishuCredentials,
  profileTargets,
} from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';

const TYPE_NAMES = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框', 11: '人员',
  13: '电话', 15: '超链接', 17: '附件', 18: '单向关联', 19: 'Lookup', 20: '公式',
  21: '双向关联', 22: '地理位置', 23: '群组', 1001: '创建时间', 1002: '最后更新时间',
  1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

function parseArgs(argv) {
  const options = { out: 'evidence/competitor-field-schema-20260915.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--out requires a value');
      options.out = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const profile = activeProfileName();
const appToken = competitorBaseToken();
const targets = profileTargets();
const { appId, appSecret, file: credentialFile } = loadFeishuCredentials();

const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
}).then((response) => response.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

async function api(path, init) {
  const payload = await fetch(`${API_ROOT}${path}`, { headers, ...init }).then((response) => response.json());
  if (payload.code !== 0) throw new Error(`${path} -> ${payload.code} ${payload.msg}`);
  return payload.data;
}

const tables = (await api(`/bitable/v1/apps/${appToken}/tables?page_size=100`)).items ?? [];
const snapshot = {
  capturedAt: new Date().toISOString(),
  profile,
  profileLabel: targets.label,
  appToken,
  credentialFile,
  readOnly: true,
  tables: [],
};

for (const table of tables) {
  const fields = (await api(`/bitable/v1/apps/${appToken}/tables/${table.table_id}/fields?page_size=200`)).items ?? [];
  snapshot.tables.push({
    tableId: table.table_id,
    name: table.name,
    fields: fields.map((field) => ({
      fieldId: field.field_id,
      name: field.field_name,
      type: field.type,
      typeName: TYPE_NAMES[field.type] ?? `type-${field.type}`,
      options: (field.property?.options ?? []).map((option) => option.name),
      formula: field.property?.formula_expression ?? null,
      propertyKeys: Object.keys(field.property ?? {}).sort(),
    })),
  });
}

mkdirSync(dirname(resolve(options.out)), { recursive: true });
writeFileSync(resolve(options.out), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(`profile = ${profile} (${targets.label})`);
console.log(`appToken = ${appToken}`);
console.log(`tables = ${snapshot.tables.length}`);
for (const table of snapshot.tables) {
  const counts = new Map();
  for (const field of table.fields) counts.set(field.typeName, (counts.get(field.typeName) ?? 0) + 1);
  const summary = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(' ');
  console.log(`  ${table.name} (${table.tableId}) — ${table.fields.length} 字段 [${summary}]`);
}

const main = snapshot.tables.find((table) => table.name === '竞品主表');
if (main) {
  console.log('\n竞品主表 逐字段：');
  for (const field of main.fields) {
    const extra = field.type === 20
      ? `formula ${String(field.formula ?? '').length} 字符`
      : field.type === 21 || field.type === 19
        ? `property: ${field.propertyKeys.join(',')}`
        : field.options.length
          ? `${field.options.length} 选项`
          : '';
    console.log(`  ${String(field.name).padEnd(12, '　')} type=${String(field.type).padStart(2)} ${field.typeName.padEnd(5, '　')} ${extra}`);
  }
}
console.log(`\nsnapshot -> ${resolve(options.out)}`);
