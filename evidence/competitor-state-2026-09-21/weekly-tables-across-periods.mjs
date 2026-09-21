// 只读探针：四张竞品周表 + SKU 周表的关键字段有值率，跨期对比
//
// 目的：回答「之前跑通的流程和表格现在长什么样」——
//   哪一期周表是真正写满的、本期（09-13~09-19）跟历史比差在哪。
// 只发 GET，不写任何东西。
//
// 用法：node D:/Retire/probe-live/weekly-tables-across-periods.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/weekly-tables-across-periods.txt';

const { activeProfileName, competitorBaseToken, envFilePath } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const { CompetitorV2FeishuClient } = await import(`file:///${REPO}/skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs`);

const lines = [];
const say = (s) => { lines.push(String(s)); };

const profile = activeProfileName();
const base = competitorBaseToken(profile);
const envPath = envFilePath(profile);
say(`profile=${profile}`);
say(`base=${base}`);

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

const KEY_FIELDS = ['搜索关键词', '尺寸', '适用空间', '数据状态', '待补数据项', '材质分类', '外形', '安装方式', '功能', '风格', '竞品分类', '商品ID', 'SKU唯一键', '商品ID'];

async function listFields(tid) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${tid}/fields?${q}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function readAllRecords(tid, cap = 5000) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${tid}/records?${q}`);
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

async function brief(label, tid, wantFields) {
  say('');
  say(`### ${label}  ${tid}`);
  const fields = await listFields(tid);
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const recs = await readAllRecords(tid);
  say(`  字段数=${fields.length}  记录数=${recs.length}`);
  for (const name of wantFields) {
    const f = byName.get(name);
    if (!f) { say(`  [缺字段] ${name}`); continue; }
    const rawType = f.type;
    const uiType = f.ui_type ?? f.type;
    const has = recs.filter((r) => !isBlank(r.fields?.[name])).length;
    const pct = recs.length ? (has / recs.length * 100).toFixed(1) : '0.0';
    say(`  [${name}] ui=${uiType} raw=${rawType}  有值 ${has}/${recs.length} ${pct}%`);
  }
  return { fieldCount: fields.length, recCount: recs.length };
}

const weekly = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
const skuWeekly = tables.filter((t) => /^SKU周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
const qBank = tables.filter((t) => /^问题库_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));

say('');
say(`=== 竞品周表 ${weekly.length} 张 ===`);
for (const t of weekly) await brief(t.name, t.tableId, KEY_FIELDS);

say('');
say(`=== SKU 周表 ${skuWeekly.length} 张 ===`);
for (const t of skuWeekly) await brief(t.name, t.tableId, ['SKU唯一键', '商品ID', '尺寸', '适用空间', '竞品分类']);

say('');
say(`=== 问题库 ${qBank.length} 张 ===`);
for (const t of qBank) say(`  ${t.name}\t${t.tableId}`);

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
