#!/usr/bin/env node
// One-off: recreate the formula (type 20) fields of the new competitor-week table
// with expressions rewritten from last week's table ids/field ids to the new table.
// Formula fields reference each other (月收货金额 → 月收货人数计算值 → …), so the
// script runs delete-and-recreate rounds until the dependency chain converges.
// Fields that still reference 尺寸/适用空间 (lookup fields arriving with
// competitor-v2 enrichment) are deferred — rerun this script after enrichment.
import { readFileSync } from 'node:fs';

import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const PROFILE = activeProfileName();
const APP_TOKEN = competitorBaseToken(PROFILE);
const OLD_TABLE = process.env.COMPETITOR_OLD_TABLE_ID ?? ''; // 表达式来源表；不得再留历史 id 默认值（跨租户后必然失效）
const NEW_TABLE = process.env.COMPETITOR_NEW_TABLE_ID ?? ''; // required when the new table differs from OLD_TABLE

function loadEnv() {
  const text = readFileSync(envFilePath(PROFILE), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('FEISHU_APP_ID/FEISHU_APP_SECRET missing');
  return env;
}

async function main() {
  if (!OLD_TABLE) throw new Error('COMPETITOR_OLD_TABLE_ID is required (the table whose formula expressions are the source)');
  if (!NEW_TABLE) throw new Error('COMPETITOR_NEW_TABLE_ID is required (the table whose formula fields to rebuild)');
  const env = loadEnv();
  const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then((r) => r.json());
  if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
  const token = auth.tenant_access_token;
  const call = async (path, init = {}) => {
    const response = await fetch(`${API_ROOT}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`API ${path} failed: ${response.status} ${payload.code} ${payload.msg}`);
    return payload.data ?? {};
  };

  const oldFieldsData = await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${OLD_TABLE}/fields?page_size=100`);
  const oldFields = oldFieldsData.items ?? [];
  const formulaFields = oldFields.filter((f) => f.type === 20 && f.property?.formula_expression);

  // Rewrite: references to the old weekly table point at the new table, and
  // field ids belonging to the old weekly table are remapped by field name.
  // Feishu stores field refs as bitable::$table[TBL].$field[FLD] (dot form).
  const rewrite = (expression, nameMap) => {
    return expression.replace(/(bitable::\$table\[)([A-Za-z0-9]+)(\]\.\$field\[|\]\[)([A-Za-z0-9]+)(\])/gu, (match, prefix, tableId, mid, fldId, suffix) => {
      if (tableId !== OLD_TABLE) return match; // references to other tables stay untouched
      const name = oldFields.find((f) => f.field_id === fldId)?.field_name;
      if (!name) return match;
      const newFld = nameMap.get(name);
      if (!newFld) return match;
      return `${prefix}${NEW_TABLE}${mid}${newFld}${suffix}`;
    });
  };

  for (let round = 1; round <= 6; round += 1) {
    const newFields = await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${NEW_TABLE}/fields?page_size=100`);
    const existing = new Set((newFields.items ?? []).map((f) => f.field_name));
    const missing = formulaFields.filter((f) => !existing.has(f.field_name));
    const stale = (newFields.items ?? []).filter((f) => f.type === 20 && (f.property?.formula_expression ?? '').includes(OLD_TABLE));
    if (!missing.length && !stale.length) {
      console.log(`round ${round}: converged, nothing to do`);
      break;
    }
    console.log(`round ${round}: missing=[${missing.map((f) => f.field_name).join(', ')}] stale=[${stale.map((f) => f.field_name).join(', ')}]`);

    for (const field of stale) {
      await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${NEW_TABLE}/fields/${field.field_id}`, { method: 'DELETE' });
      console.log(`round ${round}: DELETED stale formula field: ${field.field_name}`);
    }

    const afterDelete = await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${NEW_TABLE}/fields?page_size=100`);
    const nameMap = new Map((afterDelete.items ?? []).map((f) => [f.field_name, f.field_id]));
    for (const field of missing) {
      const rewritten = rewrite(field.property.formula_expression, nameMap);
      if (rewritten.includes(OLD_TABLE)) {
        // Still references fields that don't exist yet in the new table
        // (尺寸/适用空间 arrive with competitor-v2 enrichment). Park it.
        console.log(`round ${round}: DEFERRED ${field.field_name} (unmapped refs remain)`);
        continue;
      }
      try {
        await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${NEW_TABLE}/fields`, {
          method: 'POST',
          body: JSON.stringify({
            field_name: field.field_name,
            type: 20,
            property: { formatter: field.property?.formatter ?? '', formula_expression: rewritten },
          }),
        });
        console.log(`round ${round}: CREATED ${field.field_name}`);
      } catch (error) {
        console.log(`round ${round}: FAILED ${field.field_name}: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
