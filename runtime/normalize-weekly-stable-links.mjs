#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const APP = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const ENV = 'E:/小红书/.env.local';
const TABLES = {
  main: 'tblJ9LHFN6pMVjPv', competitor: 'tblSS5bxyIeXgngI', sku: 'tblddWTrPeB4TKmR', skuWeekly: 'tblSgYvJzGBxzEBO',
};
function env(raw) { return Object.fromEntries(raw.split(/\r?\n/u).filter((x) => x && !x.startsWith('#')).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1).replace(/^['"]|['"]$/gu, '')]; })); }
function text(v) { if (v == null) return ''; if (Array.isArray(v)) return v.map(text).join(''); if (typeof v === 'object') return text(v.text ?? v.value ?? v.record_id ?? ''); return String(v).trim(); }
function pid(v) { return text(v).match(/[?&]id=(\d+)/u)?.[1] ?? ''; }
function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
async function addText(client, tableId, fields, name) { if (fields.some((f) => f.fieldName === name)) return fields; await client.request('POST', `/bitable/v1/apps/${APP}/tables/${tableId}/fields`, { field_name: name, type: 1 }); return client.listFields(tableId); }
async function update(client, tableId, records) { for (let i = 0; i < records.length; i += 500) await client.batchUpdateRecords(tableId, records.slice(i, i + 500)); }
async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Refusing to mutate Feishu without --apply');
  const e = env(await readFile(arg('--env-file', ENV), 'utf8')); const c = new CompetitorV2FeishuClient({ appId: e.FEISHU_APP_ID, appSecret: e.FEISHU_APP_SECRET, appToken: APP }); await c.authenticate();
  let cf = await c.listFields(TABLES.competitor); let sf = await c.listFields(TABLES.skuWeekly); let skf = await c.listFields(TABLES.sku);
  cf = await addText(c, TABLES.competitor, cf, '主表记录ID'); cf = await addText(c, TABLES.competitor, cf, '商品ID'); sf = await addText(c, TABLES.skuWeekly, sf, '主表记录ID'); sf = await addText(c, TABLES.skuWeekly, sf, '竞品周记录ID'); sf = await addText(c, TABLES.skuWeekly, sf, '竞品周关联状态'); skf = await addText(c, TABLES.sku, skf, '最后出现周'); skf = await addText(c, TABLES.sku, skf, '当前状态');
  const [main, competitor, sku, skuWeekly] = await Promise.all([c.listRecords(TABLES.main), c.listRecords(TABLES.competitor), c.listRecords(TABLES.sku), c.listRecords(TABLES.skuWeekly)]);
  const mainByProduct = new Map(main.map((r) => [pid(r.fields?.商品链接), r])); const competitorByProduct = new Map(competitor.map((r) => [pid(r.fields?.商品链接), r]));
  const competitorUpdates = competitor.map((r) => ({ recordId: r.recordId, fields: { 商品ID: pid(r.fields?.商品链接), 主表记录ID: mainByProduct.get(pid(r.fields?.商品链接))?.recordId ?? '' } }));
  const skuWeeklyUpdates = skuWeekly.map((r) => { const product = pid(r.fields?.商品链接); const weekly = competitorByProduct.get(product)?.recordId ?? ''; return { recordId: r.recordId, fields: { 主表记录ID: mainByProduct.get(product)?.recordId ?? '', ...(weekly ? { 竞品周记录ID: weekly } : {}), 竞品周关联状态: weekly ? '已关联本周竞品周' : '历史商品，本周竞品周未出现' } }; });
  const skuUpdates = sku.map((r) => ({ recordId: r.recordId, fields: { 最后出现周: '2026-08-23', 当前状态: '本周出现' } }));
  await update(c, TABLES.competitor, competitorUpdates); await update(c, TABLES.skuWeekly, skuWeeklyUpdates); await update(c, TABLES.sku, skuUpdates);
  const obsolete = [
    [TABLES.main, 'SKU周_2026-08-23_2026-08-29_修复结构V2-所属竞品'],
    [TABLES.competitor, 'SKU采集明细'],
    [TABLES.competitor, 'SKU周_2026-08-23_2026-08-29-竞品周_2026-08-23_2026-08-29-SKU采集明细'],
    [TABLES.sku, '竞品周_2026-08-23_2026-08-29_修复结构-SKU采集明细'],
    [TABLES.skuWeekly, '竞品周_2026-08-23_2026-08-29-SKU采集明细'],
  ];
  for (const [tableId, name] of obsolete) { const fields = await c.listFields(tableId); const field = fields.find((f) => f.fieldName === name); if (field) await c.request('DELETE', `/bitable/v1/apps/${APP}/tables/${tableId}/fields/${field.fieldId}`); }
  const after = { competitor: await c.listRecords(TABLES.competitor), skuWeekly: await c.listRecords(TABLES.skuWeekly), sku: await c.listRecords(TABLES.sku), main: await c.listRecords(TABLES.main) };
  const counts = { competitor: after.competitor.length, skuWeekly: after.skuWeekly.length, sku: after.sku.length, main: after.main.length };
  if (counts.competitor !== 1461 || counts.skuWeekly !== 734 || counts.sku !== 734 || counts.main !== 2004) throw new Error(`Count verification failed: ${JSON.stringify(counts)}`);
  if (after.skuWeekly.some((r) => !text(r.fields?.主表记录ID) || !text(r.fields?.竞品周关联状态))) throw new Error('Stable SKU weekly links are incomplete');
  console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', counts, stableLinks: { competitorRows: after.competitor.filter((r) => text(r.fields?.主表记录ID)).length, skuWeeklyRows: after.skuWeekly.filter((r) => text(r.fields?.主表记录ID)).length, linkedToCurrentCompetitorWeekly: after.skuWeekly.filter((r) => text(r.fields?.竞品周记录ID)).length, historicalNotInCurrentWeekly: after.skuWeekly.filter((r) => text(r.fields?.竞品周关联状态).includes('未出现')).length }, deletedFields: obsolete.map(([, name]) => name) }, null, 2));
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
