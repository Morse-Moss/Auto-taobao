#!/usr/bin/env node
// 在新一周的竞品周表上重建「派生字段」：19 查找引用（Lookup）+ 20 公式。
//
// 为什么必须单独一趟：这两类字段的 property 里内嵌了具体的表/字段 id
// （形如 `bitable::$table[<表>].$field[<字段>]`），照抄上一周的表就会指向旧表。
// 所以建表脚本只复制普通字段，把这两类留到这里、**按字段名字**重写引用。
//
// 默认只出计划（dry-run），加 --apply 才真的写。引用来源表默认＝竞品主表
// （字段定义的唯一基准），可用 COMPETITOR_OLD_TABLE_ID 覆盖；目标周表用
// COMPETITOR_NEW_TABLE_ID 指定。
//
// 顺序不可颠倒：先建 Lookup，再建公式——`数据状态`/`待补数据项` 的表达式引用
// `尺寸`/`适用空间`，两者不存在时它们会被判为「引用未映射」而跳过。
import { readFileSync } from 'node:fs';

import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const PROFILE = activeProfileName();
const APP_TOKEN = competitorBaseToken(PROFILE);
const SOURCE_TABLE = process.env.COMPETITOR_OLD_TABLE_ID ?? tableId('competitorMain', PROFILE);
const TARGET_TABLE = process.env.COMPETITOR_NEW_TABLE_ID ?? '';
const LOOKUP = 19;
const FORMULA = 20;
const TEXT = 1;
const MAX_ROUNDS = 6;

// 这 4 个字段在**主表**上是 Lookup/公式，但周表上不该照抄：
//   1. 开放 API 建不了 Lookup(19)（三变体实测全 99992402 field validation failed）；
//   2. `数据状态`/`待补数据项` 的公式表达式引用 `尺寸`/`适用空间`，上游建不起来就永久 DEFERRED。
// 于是这里改成「文本 + 规则回填」：schema 由本脚本建 Text(1)，值由
// runtime/fill-weekly-attribute-labels.mjs 写入，口径与主表公式同源
// （skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs buildCompetitorRecord）。
const RULE_FILLED_TEXT = ['尺寸', '适用空间', '数据状态', '待补数据项'];

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

function lookupBody(field, formula) {
  const property = { formula, formatter: field.property?.formatter ?? '' };
  for (const key of ['filter_info', 'roll_up', 'target_field']) {
    if (field.property?.[key] !== undefined) property[key] = field.property[key];
  }
  return { field_name: field.field_name, type: LOOKUP, property };
}

function formulaBody(field, expression) {
  return {
    field_name: field.field_name,
    type: FORMULA,
    property: { formatter: field.property?.formatter ?? '', formula_expression: expression },
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!TARGET_TABLE) throw new Error('COMPETITOR_NEW_TABLE_ID is required (the table whose derived fields to rebuild)');
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
  const fieldsOf = (id) => call(`/bitable/v1/apps/${APP_TOKEN}/tables/${id}/fields?page_size=100`).then((data) => data.items ?? []);
  const fieldRoot = `/bitable/v1/apps/${APP_TOKEN}/tables/${TARGET_TABLE}/fields`;

  const sourceFields = await fieldsOf(SOURCE_TABLE);
  const lookupFields = sourceFields.filter((f) => f.type === LOOKUP && f.property?.formula
    && !RULE_FILLED_TEXT.includes(f.field_name));
  const formulaFields = sourceFields.filter((f) => f.type === FORMULA && f.property?.formula_expression
    && !RULE_FILLED_TEXT.includes(f.field_name));
  console.log(`source ${SOURCE_TABLE}: ${lookupFields.length} lookup + ${formulaFields.length} formula fields -> target ${TARGET_TABLE}`);
  console.log(`rule-filled text columns: ${RULE_FILLED_TEXT.join(', ')}`);
  if (!apply) console.log('DRY RUN (pass --apply to write)');

  // Rewrite: references to the source table point at the target table; source
  // field ids are remapped by field name. Feishu stores refs in the dot form
  // `bitable::$table[TBL].$field[FLD]`; other tables' refs are left untouched.
  const rewrite = (expression, nameMap) => expression.replace(
    /(bitable::\$table\[)([A-Za-z0-9]+)(\]\.\$field\[|\]\[)([A-Za-z0-9]+)(\])/gu,
    (match, prefix, tableId, mid, fldId, suffix) => {
      if (tableId !== SOURCE_TABLE) return match;
      const name = sourceFields.find((f) => f.field_id === fldId)?.field_name;
      if (!name) return match;
      const newFld = nameMap.get(name);
      if (!newFld) return match;
      return `${prefix}${TARGET_TABLE}${mid}${newFld}${suffix}`;
    },
  );

  const blocked = [];
  let created = 0;

  // Pass 0 — rule-filled text columns. 必须最先建：Pass 2 的公式会引用它们。
  for (const name of RULE_FILLED_TEXT) {
    const current = (await fieldsOf(TARGET_TABLE)).find((f) => f.field_name === name);
    if (current && current.type === TEXT) {
      console.log(`rule-text: ${name} already present (${current.field_id})`);
      continue;
    }
    if (current) {
      blocked.push(`${name}: a ${current.type} field already occupies the name`);
      continue;
    }
    if (!apply) {
      console.log(`rule-text: WOULD CREATE ${name} type=${TEXT}`);
      continue;
    }
    await call(fieldRoot, { method: 'POST', body: JSON.stringify({ field_name: name, type: TEXT }) });
    const readBack = (await fieldsOf(TARGET_TABLE)).find((f) => f.field_name === name);
    if (readBack?.type !== TEXT) throw new Error(`rule-text ${name} did not settle: ${JSON.stringify(readBack)}`);
    console.log(`rule-text: CREATED ${name} (${readBack.field_id})`);
    created += 1;
  }

  // Pass 1 — lookups. Formulas below reference them, so they must exist first.
  for (const field of lookupFields) {
    const current = (await fieldsOf(TARGET_TABLE)).find((f) => f.field_name === field.field_name);
    if (current && current.type === LOOKUP) {
      console.log(`lookup: ${field.field_name} already present (${current.field_id})`);
      continue;
    }
    if (current) {
      blocked.push(`${field.field_name}: a ${current.type} field already occupies the name`);
      continue;
    }
    const nameMap = new Map((await fieldsOf(TARGET_TABLE)).map((f) => [f.field_name, f.field_id]));
    const expression = rewrite(field.property.formula, nameMap);
    if (expression.includes(SOURCE_TABLE)) {
      blocked.push(`${field.field_name}: unmapped refs remain after rewrite`);
      continue;
    }
    const body = lookupBody(field, expression);
    if (!apply) {
      console.log(`lookup: WOULD CREATE ${field.field_name} type=${LOOKUP}`);
      console.log(`  property=${JSON.stringify(body.property)}`);
      continue;
    }
    await call(fieldRoot, { method: 'POST', body: JSON.stringify(body) });
    const readBack = (await fieldsOf(TARGET_TABLE)).find((f) => f.field_name === field.field_name);
    if (readBack?.type !== LOOKUP || readBack.property?.formula !== expression) {
      throw new Error(`lookup ${field.field_name} did not settle: ${JSON.stringify(readBack?.property)}`);
    }
    console.log(`lookup: CREATED ${field.field_name} (${readBack.field_id})`);
    created += 1;
  }

  // Pass 2..N — formulas, delete-and-recreate until the dependency chain settles.
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const newFields = await fieldsOf(TARGET_TABLE);
    const existing = new Set(newFields.map((f) => f.field_name));
    const missing = formulaFields.filter((f) => !existing.has(f.field_name));
    const stale = newFields.filter((f) => f.type === FORMULA && (f.property?.formula_expression ?? '').includes(SOURCE_TABLE));
    if (!missing.length && !stale.length) {
      console.log(`round ${round}: converged, nothing to do`);
      break;
    }
    console.log(`round ${round}: missing=[${missing.map((f) => f.field_name).join(', ')}] stale=[${stale.map((f) => f.field_name).join(', ')}]`);
    if (!apply) continue;

    for (const field of stale) {
      await call(`${fieldRoot}/${field.field_id}`, { method: 'DELETE' });
      console.log(`round ${round}: DELETED stale formula field: ${field.field_name}`);
    }

    const nameMap = new Map((await fieldsOf(TARGET_TABLE)).map((f) => [f.field_name, f.field_id]));
    for (const field of missing) {
      const expression = rewrite(field.property.formula_expression, nameMap);
      if (expression.includes(SOURCE_TABLE)) {
        // 仍然引用了目标表里还不存在的字段（例如上游 Lookup 没建起来）。停在这里
        // 而不是硬写一个会悬空的公式。
        blocked.push(`${field.field_name}: unmapped refs remain`);
        console.log(`round ${round}: DEFERRED ${field.field_name} (unmapped refs remain)`);
        continue;
      }
      await call(fieldRoot, { method: 'POST', body: JSON.stringify(formulaBody(field, expression)) });
      console.log(`round ${round}: CREATED ${field.field_name}`);
      created += 1;
    }
  }

  const finalNames = new Set((await fieldsOf(TARGET_TABLE)).map((f) => f.field_name));
  const stillMissing = [...lookupFields, ...formulaFields]
    .map((f) => f.field_name)
    .filter((name) => !finalNames.has(name));
  console.log(`\ncreated=${created} fieldCount=${finalNames.size}`);
  const ruleTextMissing = RULE_FILLED_TEXT.filter((name) => !finalNames.has(name));
  if (ruleTextMissing.length) console.log(`RULE-TEXT STILL MISSING (${ruleTextMissing.length}): ${ruleTextMissing.join(', ')}`);
  if (stillMissing.length) console.log(`STILL MISSING (${stillMissing.length}): ${stillMissing.join(', ')}`);
  if (blocked.length) console.log(`BLOCKED (${blocked.length}): ${blocked.join('; ')}`);
  if (stillMissing.length || blocked.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
