#!/usr/bin/env node
// 回填竞品周表的 数据开始日期/数据结束日期/采集时间（仅填空缺字段，不覆盖已有值）
// 用法：
//   node runtime/backfill-weekly-date-fields.mjs            # dry-run
//   node runtime/backfill-weekly-date-fields.mjs --commit   # 写入
import fs from 'node:fs';

import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const PROFILE = activeProfileName();
const env = { ...loadEnv(process.env.FEISHU_ENV_FILE || envFilePath(PROFILE)), ...process.env };
const COMMIT = process.argv.includes('--commit');
const APP = process.env.FEISHU_APP_TOKEN || competitorBaseToken(PROFILE);
const ROOT = 'https://open.feishu.cn/open-apis';

// 每期回填值（时间戳 = 当日 00:00 +08:00），采集时间取实际采集日（有产物 mtime 佐证）
const PLANS = [
  {
    tableId: process.env.WEEKLY_TABLE_ID || null,
    name: '竞品周_2026-08-30_2026-09-05',
    values: {
      数据开始日期: Date.parse('2026-08-30T00:00:00+08:00'),
      数据结束日期: Date.parse('2026-09-05T00:00:00+08:00'),
      采集时间: Date.parse('2026-09-12T00:00:00+08:00'),
    },
  },
  {
    tableId: null,
    name: '竞品周_2026-09-06_2026-09-12',
    values: {
      数据开始日期: Date.parse('2026-09-06T00:00:00+08:00'),
      数据结束日期: Date.parse('2026-09-12T00:00:00+08:00'),
      采集时间: Date.parse('2026-09-13T00:00:00+08:00'),
    },
  },
  {
    // 2026-09-16 补：本期此前不在 PLANS 里，而它的日期列同样是空的（仪表盘四个图表因此无数据）。
    // 采集时间取实际采集日：runtime/.weekly-collection-receipt.json 的 at = 2026-09-15T10:49Z（北京 09-15 18:49）。
    tableId: null,
    name: '竞品周_2026-09-13_2026-09-19',
    values: {
      数据开始日期: Date.parse('2026-09-13T00:00:00+08:00'),
      数据结束日期: Date.parse('2026-09-19T00:00:00+08:00'),
      采集时间: Date.parse('2026-09-15T00:00:00+08:00'),
    },
  },
];

const a = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
});
const ab = await a.json();
if (!a.ok || ab.code !== 0) throw new Error(`auth ${a.status} ${ab.code} ${ab.msg}`);
const token = ab.tenant_access_token;

async function req(method, p, body) {
  const r = await fetch(ROOT + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok || j.code !== 0) throw new Error(`${method} ${p} ${r.status} ${j.code} ${j.msg}`);
  return j.data || {};
}

async function allRecords(tableId) {
  const out = [];
  let pt;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pt) q.set('page_token', pt);
    const d = await req('GET', `/bitable/v1/apps/${APP}/tables/${tableId}/records?${q}`);
    out.push(...(d.items || []));
    pt = d.has_more ? d.page_token : undefined;
  } while (pt);
  return out;
}

// 表 id 不硬编码：按 PLANS 里已有的表名在目标 base 内解析（跨租户后旧 id 必然失效）
const tableList = await req('GET', `/bitable/v1/apps/${APP}/tables?page_size=100`);
const idByName = new Map((tableList.items || []).map((t) => [t.name, t.table_id]));
for (const plan of PLANS) {
  if (!plan.tableId) plan.tableId = idByName.get(plan.name) ?? null;
  if (!plan.tableId) throw new Error(`table not found in base: ${plan.name}`);
  console.log(`resolved ${plan.name} -> ${plan.tableId}`);
}

const summary = [];
for (const plan of PLANS) {
  const records = await allRecords(plan.tableId);
  const updates = [];
  for (const r of records) {
    const fields = {};
    for (const [k, v] of Object.entries(plan.values)) {
      const cur = r.fields?.[k];
      if (cur === undefined || cur === null) fields[k] = v; // 只补空缺
    }
    if (Object.keys(fields).length) updates.push({ record_id: r.record_id, fields });
  }
  console.log(`[${plan.name}] 总行数 ${records.length}，需回填 ${updates.length} 行`);
  if (COMMIT && updates.length) {
    for (let i = 0; i < updates.length; i += 500) {
      await req('POST', `/bitable/v1/apps/${APP}/tables/${plan.tableId}/records/batch_update`, {
        records: updates.slice(i, i + 500),
      });
      console.log(`  已写入 ${Math.min(i + 500, updates.length)}/${updates.length}`);
    }
  }
  summary.push({ table: plan.name, total: records.length, pending: updates.length, committed: COMMIT });
}

// 回读校验
if (COMMIT) {
  for (const plan of PLANS) {
    const records = await allRecords(plan.tableId);
    const bad = records.filter((r) =>
      Object.values(plan.values).some((_, idx) => {
        const k = Object.keys(plan.values)[idx];
        return r.fields?.[k] === undefined || r.fields?.[k] === null;
      }));
    console.log(`[校验] ${plan.name}: 缺日期行 ${bad.length}`);
    if (bad.length) throw new Error(`${plan.name} 仍有 ${bad.length} 行缺日期`);
  }
  console.log('VERIFY_OK');
} else {
  console.log('DRY_RUN — 加 --commit 执行写入');
}
console.log(JSON.stringify(summary));
