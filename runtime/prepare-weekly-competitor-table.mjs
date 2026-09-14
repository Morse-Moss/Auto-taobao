#!/usr/bin/env node
// One-off: inspect the competitor-week tables in the authorized Feishu base.
// Read-only by default; pass --create to create the new week's empty table
// cloned from last week's field schema.
import { readFileSync } from 'node:fs';

import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
// 租户目标集中来自 feishu-targets.mjs（SYCM_FEISHU_PROFILE 可切换）
const PROFILE = activeProfileName();
const APP_TOKEN = competitorBaseToken(PROFILE);
const LAST_WEEK = process.env.COMPETITOR_LAST_WEEK ?? '竞品周_2026-08-30_2026-09-05';
const NEW_WEEK = process.env.COMPETITOR_NEW_WEEK ?? '竞品周_2026-09-06_2026-09-12';

function loadEnv() {
  const text = readFileSync(envFilePath(PROFILE), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('FEISHU_APP_ID/FEISHU_APP_SECRET missing in env file');
  return env;
}

async function main() {
  const create = process.argv.includes('--create');
  const env = loadEnv();
  const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then((r) => r.json());
  if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
  const token = auth.tenant_access_token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path, init = {}) => {
    const response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`API ${path} failed: ${response.status} ${payload.code} ${payload.msg}`);
    return payload.data ?? {};
  };

  const tables = await call(`/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
  const items = tables.items ?? [];
  console.log('tables in base:', items.map((t) => `${t.name}(${t.table_id})`).join(', '));
  const lastWeek = items.find((t) => t.name === LAST_WEEK);
  if (!lastWeek) throw new Error(`last week table not found: ${LAST_WEEK}`);
  const exists = items.find((t) => t.name === NEW_WEEK);
  if (exists) {
    console.log(`NEW WEEK TABLE ALREADY EXISTS: ${NEW_WEEK}(${exists.table_id})`);
    return;
  }

  const fields = await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${lastWeek.table_id}/fields?page_size=100`);
  // Formula (20) and lookup (19) fields embed last week's table/field ids in their
  // expressions — cloning them verbatim would reference the OLD week's table.
  // They are re-created in a second pass with rewritten expressions after import.
  const CLONABLE_TYPES = new Set([1, 2, 3, 4, 5, 7, 11, 13, 15, 17, 18]);
  const defs = (fields.items ?? [])
    .filter((f) => CLONABLE_TYPES.has(f.type))
    .map((f) => ({ field_name: f.field_name, type: f.type, ...(f.property ? { property: f.property } : {}) }));
  const skipped = (fields.items ?? []).filter((f) => !CLONABLE_TYPES.has(f.type)).map((f) => f.field_name);
  console.log(`cloning ${defs.length} plain fields, deferring ${skipped.length} formula/lookup fields: ${skipped.join(', ')}`);
  console.log(`new table field list (${defs.length} fields):`);
  for (const def of defs) console.log(`  - ${def.field_name} type=${def.type}${def.property ? ` property=${JSON.stringify(def.property).slice(0, 80)}` : ''}`);

  if (!create) {
    console.log('READ-ONLY probe done. Re-run with --create to create the new week table.');
    return;
  }
  const created = await call(`/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: 'POST',
    body: JSON.stringify({ table: { name: NEW_WEEK, fields: defs } }),
  });
  console.log(`CREATED: ${NEW_WEEK} table_id=${created.table_id}`);
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
