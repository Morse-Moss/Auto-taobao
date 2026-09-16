#!/usr/bin/env node
// One-off: inspect / create the competitor-week table in the authorized Feishu base.
// Read-only by default; pass --create to create the new week's table.
//
// 字段基准 = **竞品主表**，不是上一周的周表。周表历史上是「克隆上一周 + 二次重建
// 公式」，于是任何一次缺字段都会被下一周原样继承。2026-09-15 实测这条链：
// 08-23 的周表（由主表复制而来）有 39 个字段，08-30 起变成 35——`尺寸`/`适用空间`
// （查找引用）、`数据状态`/`待补数据项`（公式，表达式里引用前两项，被 DEFERRED）
// 从 08-30 一路丢到 09-13（四个字面量见 DEFERRED 报告）。主表才是字段定义的
// 唯一基准，所以这里改成读主表；周表专有列显式声明，不再依赖被动继承。
import { readFileSync } from 'node:fs';

import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
// 租户目标集中来自 feishu-targets.mjs（SYCM_FEISHU_PROFILE 可切换）
const PROFILE = activeProfileName();
const APP_TOKEN = competitorBaseToken(PROFILE);
const BASE_TABLE = process.env.COMPETITOR_BASE_TABLE_ID ?? tableId('competitorMain', PROFILE);
const NEW_WEEK = process.env.COMPETITOR_NEW_WEEK ?? '竞品周_2026-09-13_2026-09-19';

// 周表专有列：主表里没有，必须显式声明。旧版从上一周克隆时它们是「顺带继承」来的，
// 一旦某周丢了就再也回不来。
const WEEKLY_ONLY_FIELDS = [
  { field_name: '商品周期唯一键', type: 1 },
  { field_name: '数据开始日期', type: 5 },
  { field_name: '数据结束日期', type: 5 },
  { field_name: '采集时间', type: 5 },
  { field_name: '主表记录ID', type: 1 },
];

// Formula (20) / lookup (19) / bidirectional link (21) embed concrete table and
// field ids in their property — cloning them verbatim would reference the OLD
// table. They are rebuilt by create-weekly-formula-fields.mjs after import.
const CLONABLE_TYPES = new Set([1, 2, 3, 4, 5, 7, 11, 13, 15, 17, 18]);
const LOOKUP = 19;
const FORMULA = 20;
const BIDIRECTIONAL_LINK = 21;
const DEFERRED_TYPE_LABELS = new Map([
  [LOOKUP, '查找引用'],
  [FORMULA, '公式'],
  [BIDIRECTIONAL_LINK, '双向关联'],
]);
// 刻意不在周表上重建的类型。双向关联的 property 里带 back_field_name，在周表上
// 再建一次会给源表多生成一个同名的反向字段、与主表那一个冲突；而且一条 SKU 记录
// 归属于竞品主表的一条商品，不归属于某一周。
const WITHOUT_BY_DESIGN_TYPES = new Set([BIDIRECTIONAL_LINK]);

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
  // 给**已存在**的周表补回缺的普通字段。派生字段不在这里补（见 exists 分支注释）。
  const backfill = process.argv.includes('--apply-missing');
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
  const baseTable = items.find((t) => t.table_id === BASE_TABLE);
  if (!baseTable) throw new Error(`field baseline table not found in base: ${BASE_TABLE}`);

  const sourceFields = (await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${BASE_TABLE}/fields?page_size=100`)).items ?? [];
  const plainFields = sourceFields.filter((f) => CLONABLE_TYPES.has(f.type));
  const defs = [
    ...plainFields.map((f) => ({ field_name: f.field_name, type: f.type, ...(f.property ? { property: f.property } : {}) })),
    ...WEEKLY_ONLY_FIELDS,
  ];
  // 19/20 由派生字段那一趟按新表的字段 id 重写引用后重建。
  const derivedFields = sourceFields.filter((f) => f.type === LOOKUP || f.type === FORMULA);
  const byDesign = sourceFields.filter((f) => WITHOUT_BY_DESIGN_TYPES.has(f.type));
  // 三份清单必须把基准表的字段**分完**：漏掉一类就是静默丢字段，多算一类就是
  // 悄悄把不该建的东西算进「会重建」。所以这里对补集本身也 fail-closed。
  const unclassified = sourceFields.filter((f) => !CLONABLE_TYPES.has(f.type)
    && f.type !== LOOKUP && f.type !== FORMULA && !WITHOUT_BY_DESIGN_TYPES.has(f.type));
  if (unclassified.length) {
    throw new Error(`unclassified field types in ${BASE_TABLE}: ${unclassified.map((f) => `${f.field_name}(${f.type})`).join(', ')}`);
  }
  const expectedNames = [...defs, ...derivedFields].map((f) => f.field_name);

  console.log(`field baseline: ${baseTable.name}(${BASE_TABLE}) — ${sourceFields.length} fields`);
  console.log(`cloning ${plainFields.length} plain + ${WEEKLY_ONLY_FIELDS.length} weekly-only = ${defs.length} fields`);
  console.log(`DERIVED (rebuilt afterwards, ${derivedFields.length}): ${derivedFields.map((f) => `${f.field_name}(${DEFERRED_TYPE_LABELS.get(f.type)})`).join(', ')}`);
  console.log(`WITHOUT_BY_DESIGN (${byDesign.length}): ${byDesign.map((f) => `${f.field_name}(${DEFERRED_TYPE_LABELS.get(f.type) ?? f.type})`).join(', ') || '-'}`);
  console.log(`expected field count of a complete week table: ${expectedNames.length}`);
  for (const def of defs) console.log(`  - ${def.field_name} type=${def.type}${def.property ? ` property=${JSON.stringify(def.property).slice(0, 80)}` : ''}`);

  const exists = items.find((t) => t.name === NEW_WEEK);
  if (exists) {
    console.log(`\nNEW WEEK TABLE ALREADY EXISTS: ${NEW_WEEK}(${exists.table_id})`);
    // 存在的周表缺什么，直接说出来——「周表比主表缺字段」这件事不该靠人肉比对发现。
    const current = (await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${exists.table_id}/fields?page_size=100`)).items ?? [];
    const currentNames = new Set(current.map((f) => f.field_name));
    const missing = expectedNames.filter((name) => !currentNames.has(name));
    const extra = current.map((f) => f.field_name).filter((name) => !expectedNames.includes(name));
    console.log(`  current field count: ${current.length}`);
    console.log(`  MISSING (${missing.length}): ${missing.join(', ') || '-'}`);
    console.log(`  EXTRA   (${extra.length}): ${extra.join(', ') || '-'}`);

    // 只补普通字段。派生字段（19/20）必须走 create-weekly-formula-fields.mjs——
    // 它们的 property 要按**这张表**的字段 id 重新生成，这里补不出来。
    const plainMissing = defs.filter((def) => !currentNames.has(def.field_name));
    if (plainMissing.length === 0) {
      console.log('  nothing to backfill among plain fields');
      return;
    }
    if (!backfill) {
      console.log(`  PLAIN BACKFILL AVAILABLE (${plainMissing.length}): ${plainMissing.map((def) => def.field_name).join(', ')}`);
      console.log('  read-only run; re-run with --apply-missing to create them');
      return;
    }
    for (const def of plainMissing) {
      await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${exists.table_id}/fields`, {
        method: 'POST',
        body: JSON.stringify(def),
      });
      console.log(`  CREATED ${def.field_name} type=${def.type}`);
    }
    const after = (await call(`/bitable/v1/apps/${APP_TOKEN}/tables/${exists.table_id}/fields?page_size=100`)).items ?? [];
    const afterNames = new Set(after.map((f) => f.field_name));
    for (const def of plainMissing) {
      const landed = after.find((f) => f.field_name === def.field_name);
      if (!landed || Number(landed.type) !== def.type) {
        throw new Error(`backfill did not settle: ${def.field_name}`);
      }
    }
    const stillMissing = expectedNames.filter((name) => !afterNames.has(name));
    console.log(`  field count now: ${after.length}`);
    console.log(`  STILL MISSING (${stillMissing.length}): ${stillMissing.join(', ') || '-'}`);
    console.log('  NEXT: COMPETITOR_NEW_TABLE_ID=' + exists.table_id + ' node runtime/create-weekly-formula-fields.mjs [--apply]');
    return;
  }

  if (!create) {
    console.log('\nREAD-ONLY probe done. Re-run with --create to create the new week table.');
    return;
  }
  const created = await call(`/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: 'POST',
    body: JSON.stringify({ table: { name: NEW_WEEK, fields: defs } }),
  });
  console.log(`CREATED: ${NEW_WEEK} table_id=${created.table_id}`);
  console.log('NEXT: run create-weekly-formula-fields.mjs to rebuild the deferred fields.');
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
