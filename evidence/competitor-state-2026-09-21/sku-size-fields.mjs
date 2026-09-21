// 只读探针：SKU明细 / SKU 周表 / 竞品周表的「尺寸」相关字段到底有没有值
//
// 上一轮探针查的是 `尺寸`（主表/周表的聚合列），漏了 SKU 侧的 `SKU尺寸` / `尺寸汇总`。
// 本探针把三张表的尺寸族字段全部列出来，并打印脱敏样本值（只看格式，不打印商品标题）。
//
// 只发 GET。用法：node D:/Retire/probe-live/sku-size-fields.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/sku-size-fields.txt';

const { activeProfileName, competitorBaseToken, envFilePath, tableId } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
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

async function readAllRecords(tid, cap = 3000) {
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

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? '');
  return String(v).trim();
}

async function full(tid, label) {
  say('');
  say(`########## ${label}  ${tid}`);
  const fields = await listFields(tid);
  const recs = await readAllRecords(tid);
  say(`字段数=${fields.length}  记录数=${recs.length}`);
  say('');
  say('--- 全部字段（名称 / ui_type / raw_type）---');
  for (const f of fields) {
    const has = recs.filter((r) => !isBlank(r.fields?.[f.field_name])).length;
    const pct = recs.length ? (has / recs.length * 100).toFixed(1) : '0.0';
    say(`  ${f.field_name}\tui=${f.ui_type ?? f.type}\traw=${f.type}\t有值 ${has}/${recs.length} ${pct}%`);
  }
  say('');
  say('--- 尺寸族字段的样本值（最多 6 条，去重）---');
  for (const name of ['SKU尺寸', '尺寸汇总', '尺寸', 'SKU规格', '空间判定状态', '空间判定依据', '适用空间', 'SKU唯一键']) {
    if (!fields.some((f) => f.field_name === name)) { say(`  [无此字段] ${name}`); continue; }
    const seen = [];
    for (const r of recs) {
      const t = text(r.fields?.[name]);
      if (t && !seen.includes(t)) seen.push(t);
      if (seen.length >= 6) break;
    }
    say(`  ${name}: ${seen.length ? seen.join(' | ') : '（全空）'}`);
  }
  return { fields, recs };
}

await full(tableId('skuDetail', profile), 'SKU明细（当前工作表）');

const skuWeekly = tables.filter((t) => /^SKU周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
for (const t of skuWeekly) await full(t.tableId, t.name);

const weekly = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
if (weekly.length) await full(weekly[weekly.length - 1].tableId, `最新周表 ${weekly[weekly.length - 1].name}`);

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
