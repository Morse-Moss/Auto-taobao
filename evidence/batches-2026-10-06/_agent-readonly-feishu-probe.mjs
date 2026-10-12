#!/usr/bin/env node
// 修复 agent 的**只读**取证脚本（2026-10-06 目标日）。
// 只调 listRecords（GET），不发任何写请求。用于独立复核：
//   ① 总数据来源底单 2026-10-06 有几行；
//   ② 各店铺数据日报 2026-10-06 有几行、最新日期到哪天。
// 用法：node evidence/batches-2026-10-06/_agent-readonly-feishu-probe.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../runtime/feishu-targets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientModule = await import(pathToFileURL(path.join(REPO_ROOT,
  'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')));

const TARGET = dailyReportTargets('kcne');
const cred = loadFeishuCredentials('kcne');

function epoch(dateStr) { return new Date(`${dateStr}T00:00:00+08:00`).getTime(); }
function dayOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // epoch ms -> +08:00 日期串
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function cell(v) { return Array.isArray(v) ? v[0] : v; }

async function dump(tableId, label, dateFieldNames) {
  const client = new clientModule.FeishuClient({ appId: cred.appId, appSecret: cred.appSecret,
    appToken: TARGET.baseToken, tableId });
  const tables = await client.listTables();
  const meta = tables.find(t => t.tableId === tableId);
  const records = await client.listRecords();
  const byDay = new Map();
  const byDayShop = new Map();
  let dateField = null;
  for (const rec of records) {
    const f = rec.fields ?? {};
    const name = dateFieldNames.find(n => f[n] !== undefined && f[n] !== null);
    if (!name) continue;
    dateField = name;
    const d = dayOf(cell(f[name]));
    if (!d) continue;
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
    const shop = cell(f['店铺'] ?? f['店铺名称'] ?? null);
    const key = `${d}|${shop}`;
    byDayShop.set(key, (byDayShop.get(key) ?? 0) + 1);
  }
  const days = [...byDay.keys()].sort();
  console.log(`\n===== ${label} (${tableId}) =====`);
  console.log(`表名（API 读回）：${meta?.name ?? '(未找到)'}`);
  console.log(`总记录数：${records.length}｜日期字段：${dateField ?? '(读不到)'}`);
  console.log(`日期范围：${days[0] ?? '-'} … ${days.at(-1) ?? '-'}`);
  console.log(`最近 8 个日期行数：${days.slice(-8).map(d => `${d}=${byDay.get(d)}`).join('  ')}`);
  const target = '2026-10-06';
  console.log(`>>> ${target} 行数 = ${byDay.get(target) ?? 0}`);
  const shops = [...byDayShop.entries()].filter(([k]) => k.startsWith(`${target}|`))
    .map(([k, v]) => `${k.split('|')[1]}=${v}`).sort();
  console.log(`>>> ${target} 逐店：${shops.length ? shops.join('  ') : '(无行)'}`);
  return { tableId, name: meta?.name ?? null, total: records.length, range: [days[0] ?? null, days.at(-1) ?? null],
    byDay: Object.fromEntries(byDay), onTarget: byDay.get(target) ?? 0 };
}

const out = {};
out.source = await dump(TARGET.sourceTable, '总数据来源底单', ['统计日期', '日期']);
out.inquiry = await dump(TARGET.inquiryTable, '各店铺数据日报', ['日期']);

// 把 2026-10-06 底单那 7 行的原始 fields 打出来（含派生「店铺」的 id 与可读替身），
// 以及两张表的「店铺」字段选项表 id→name，用来独立把 7 行归到店名。
async function rawRowsAndOptions() {
  const src = new clientModule.FeishuClient({ appId: cred.appId, appSecret: cred.appSecret,
    appToken: TARGET.baseToken, tableId: TARGET.sourceTable });
  const records = await src.listRecords();
  const target = epoch('2026-10-06');
  const rows = records.filter(r => Number(cell(r.fields?.['统计日期'])) === target);
  console.log(`\n===== 底单 2026-10-06 原始行（${rows.length} 行）=====`);
  for (const r of rows) {
    console.log(JSON.stringify(r.fields));
  }
  const inq = new clientModule.FeishuClient({ appId: cred.appId, appSecret: cred.appSecret,
    appToken: TARGET.baseToken, tableId: TARGET.inquiryTable });
  const fields = await inq.listFieldItems();
  const shopField = fields.find(f => f.field_name === '店铺');
  console.log(`\n===== 各店铺数据日报「店铺」选项表 =====`);
  for (const o of (shopField?.property?.options ?? [])) console.log(`${o.id}  ${o.name}`);
}
await rawRowsAndOptions();
console.log(`\n[probe] baseToken=${TARGET.baseToken} host=kcne618basvj.feishu.cn`);
