// 只读探针：竞品周更相关表的「现在长什么样」
//
// 目的：钉死两个在文档里互相矛盾的数字 ——
//   ① 周表的 尺寸/适用空间/数据状态/待补数据项/搜索关键词 现在有没有值、有值率多少；
//   ② 这些字段现在是什么类型（Text(1) 还是 Lookup(19) 还是 Formula(20)）。
// 只发 GET，不写任何东西。
//
// 用法：node D:/Retire/probe-live/competitor-weekly-state.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/competitor-weekly-state.txt';

const { activeProfileName, competitorBaseToken, envFilePath, tableId } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const { CompetitorV2FeishuClient } = await import(`file:///${REPO}/skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs`);

const lines = [];
const say = (s) => { lines.push(String(s)); };

const profile = activeProfileName();
const base = competitorBaseToken(profile);
const envPath = envFilePath(profile);
say(`profile=${profile}`);
say(`base=${base}`);
say(`env=${envPath}`);

const values = {};
for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) continue;
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  values[line.slice(0, i).trim()] = v;
}

const client = new CompetitorV2FeishuClient({ appId: values.FEISHU_APP_ID, appSecret: values.FEISHU_APP_SECRET, appToken: base });
await client.authenticate();
say('auth=ok');

const tables = await client.listTables();
say('');
say(`=== base 里的表（${tables.length} 张）===`);
for (const t of tables) say(`  ${t.name}\t${t.tableId}`);

const KEY_FIELDS = ['搜索关键词', '尺寸', '适用空间', '数据状态', '待补数据项', '材质分类', '外形', '安装方式', '功能', '风格', '竞品分类', '商品ID'];

async function listFields(tableIdValue) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${tableIdValue}/fields?${q}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function readAllRecords(tableIdValue, cap = 5000) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${tableIdValue}/records?${q}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken && items.length < cap);
  return items;
}

function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'object') {
    const inner = v.text ?? v.value ?? v.name;
    if (inner !== undefined) return isBlank(inner);
    return false;
  }
  return false;
}

async function reportTable(label, tableIdValue) {
  say('');
  say(`### ${label} ${tableIdValue}`);
  const fields = await listFields(tableIdValue);
  say(`  字段数=${fields.length}`);
  for (const f of fields) {
    if (KEY_FIELDS.includes(f.field_name)) {
      const p = f.property ? JSON.stringify(f.property) : '';
      say(`  [字段] ${f.field_name}\ttype=${f.ui_type ?? f.type}\traw_type=${f.type}\t${p.slice(0, 120)}`);
    }
  }
  const recs = await readAllRecords(tableIdValue);
  say(`  记录数=${recs.length}`);
  for (const name of KEY_FIELDS) {
    const has = recs.filter((r) => !isBlank(r.fields?.[name])).length;
    const pct = recs.length ? (has / recs.length * 100).toFixed(1) : '0.0';
    say(`  [有值] ${name}\t${has}/${recs.length}\t${pct}%`);
  }
  return { fields, recs };
}

const weekly = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
say('');
say(`=== 竞品周表共 ${weekly.length} 张 ===`);
for (const t of weekly) say(`  ${t.name}\t${t.tableId}`);

if (weekly.length) {
  const latest = weekly[weekly.length - 1];
  await reportTable(`最新周表 ${latest.name}`, latest.tableId);
}
await reportTable('竞品主表', tableId('competitorMain', profile));
await reportTable('SKU明细', tableId('skuDetail', profile));

const skuWeekly = tables.filter((t) => /^SKU周_/u.test(t.name));
say('');
say(`=== SKU 周表共 ${skuWeekly.length} 张 ===`);
for (const t of skuWeekly) say(`  ${t.name}\t${t.tableId}`);

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
