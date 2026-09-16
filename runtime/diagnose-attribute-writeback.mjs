#!/usr/bin/env node
// Read-only P0 probe. Answers two numbers before anything is written to Feishu:
//   1) 有值率 —— how much of each weekly attribute column would buildCompetitorRecord fill?
//   2) 一致率 —— how faithful is it against the only week that carries real stored values (08-23)?
// Writes nothing. Touches no running service. Read-only by construction (GET only).
import { readFileSync } from 'node:fs';
import { buildCompetitorRecord } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.PROBE_APP_TOKEN ?? 'QcnhbEzYpacGvUskCbVcrcm3nFd';
const ENV_FILE = process.env.PROBE_ENV_FILE ?? 'E:/小红书/.env.feishu-kcne.local';
const ATTRS = ['材质分类', '外形', '安装方式', '功能', '风格'];
const GROUND_TRUTH = 'tblDpoBCxUJmNBR7'; // 竞品周_2026-08-23，唯一带真值的周表
const CURRENT = 'tbllWI45sK0DfHpr'; // 竞品周_2026-09-13，本周目标

const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/u)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
}

const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

const flat = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flat).join(' ').trim();
  if (typeof v === 'object') return flat(v.text ?? v.value ?? v.name ?? '');
  return String(v).trim();
};
const parts = (v) => flat(v).split(/[,，、;；\s]+/u).map((s) => s.trim()).filter(Boolean);
const subset = (a, b) => a.every((x) => b.includes(x));
const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;

async function load(tableId) {
  const items = [];
  let token;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (token) q.set('page_token', token);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${q}`, { headers }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`records failed ${tableId}: ${page.code} ${page.msg}`);
    items.push(...(page.data.items ?? []));
    token = page.data.has_more ? page.data.page_token : undefined;
  } while (token);
  return items;
}

const catalog = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers }).then((r) => r.json());
const nameOf = (id) => (catalog.data.items ?? []).find((t) => t.table_id === id)?.name ?? id;

for (const tableId of [GROUND_TRUTH, CURRENT]) {
  const items = await load(tableId);
  const f0 = items[0]?.fields ?? {};
  console.log(`\n${'='.repeat(74)}\n=== ${nameOf(tableId)}   ${items.length} 行   (${tableId})`);
  const need = ['商品标题', '价格', '是否有效竞品', '月收货人数', '卖点'];
  console.log(`  探针源字段: ${need.map((n) => `${n}${Object.hasOwn(f0, n) ? '' : ' [缺!]'}`).join('  ')}`);

  const rows = items.map((it) => {
    const f = it.fields ?? {};
    const row = {
      商品标题: flat(f['商品标题']),
      价格: flat(f['价格']),
      是否有效竞品: flat(f['是否有效竞品']),
      月收货人数: flat(f['月收货人数']),
      卖点: flat(f['卖点']),
    };
    return { raw: f, row, built: buildCompetitorRecord(row, { searchKeyword: flat(f['搜索关键词']) }) };
  });

  const validity = new Map();
  for (const r of rows) {
    const k = r.row.是否有效竞品 || '(空)';
    validity.set(k, (validity.get(k) ?? 0) + 1);
  }
  console.log(`  是否有效竞品分布: ${[...validity.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);

  console.log('  --- 有值率：buildCompetitorRecord 会写进去的值 ---');
  for (const attr of ATTRS) {
    const c = { 有值: 0, 无注明: 0, 不适用: 0, 空: 0 };
    for (const r of rows) {
      const v = r.built[attr];
      if (!Array.isArray(v) || v.length === 0) c.空 += 1;
      else if (v.includes('不适用')) c.不适用 += 1;
      else if (v.includes('无注明')) c.无注明 += 1;
      else c.有值 += 1;
    }
    const n = rows.length;
    console.log(`  ${attr.padEnd(6)} 有值 ${String(c.有值).padStart(5)}/${n} (${pct(c.有值, n).padStart(5)})   无注明 ${String(c.无注明).padStart(5)} (${pct(c.无注明, n).padStart(5)})   不适用 ${String(c.不适用).padStart(5)}   空 ${c.空}`);
  }

  const klass = new Map();
  for (const r of rows) klass.set(r.built.竞品分类, (klass.get(r.built.竞品分类) ?? 0) + 1);
  console.log(`  竞品分类(推导): ${[...klass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  const withStored = rows.filter((r) => parts(r.raw['材质分类']).length);
  if (!withStored.length) {
    console.log('  --- 该表属性列整列为空，没有可比对的真值 ---');
    continue;
  }
  console.log(`  --- 一致率：与已存真值逐字段比对（${withStored.length} 行可比对）---`);
  for (const attr of ATTRS) {
    let exact = 0; let noFabricate = 0; let noMiss = 0; let denom = 0; let storedNone = 0;
    const mism = [];
    for (const r of withStored) {
      const stored = parts(r.raw[attr]);
      if (!stored.length) continue;
      denom += 1;
      // 不清理「无注明」：真值里存的就是「无注明」，两边都无注明必须算一致。
      const derivedRaw = r.built[attr] ?? [];
      const d = [...derivedRaw].sort();
      const s = [...stored].sort();
      const same = JSON.stringify(d) === JSON.stringify(s);
      if (same) exact += 1;
      const dReal = derivedRaw.filter((x) => x !== '无注明');
      const sReal = stored.filter((x) => x !== '无注明');
      if (subset(dReal, sReal)) noFabricate += 1;
      if (subset(sReal, dReal)) noMiss += 1;
      if (sReal.length === 0) storedNone += 1;
      if (!same) mism.push(`${s.join('+')} → ${d.join('+') || '(空)'}`);
    }
    if (!denom) { console.log(`  ${attr.padEnd(6)} 真值也为空`); continue; }
    console.log(`  ${attr.padEnd(6)} n=${denom}  严格相等 ${pct(exact, denom).padStart(5)}   推导⊆真值(未编造) ${pct(noFabricate, denom).padStart(5)}   真值⊆推导(未漏) ${pct(noMiss, denom).padStart(5)}   真值自身无注明 ${pct(storedNone, denom).padStart(5)}`);
    const pairs = new Map();
    for (const m of mism) pairs.set(m, (pairs.get(m) ?? 0) + 1);
    if (pairs.size) {
      console.log(`        主要不一致(已存→推导): ${[...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`).join('   ')}`);
    }
  }
}
