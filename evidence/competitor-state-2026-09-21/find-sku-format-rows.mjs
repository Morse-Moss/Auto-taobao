// 只读探针：找出 09-13 周表里「尺寸」列呈 SKU 格式的那一行是谁
// 只发 GET。用法：node D:/Retire/probe-live/find-sku-format-rows.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/find-sku-format-rows.txt';

const { activeProfileName, competitorBaseToken, envFilePath } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
const { CompetitorV2FeishuClient } = await import(`file:///${REPO}/skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs`);

const lines = [];
const say = (s) => { lines.push(String(s)); };
const profile = activeProfileName();
const base = competitorBaseToken(profile);
const values = {};
for (const raw of readFileSync(envFilePath(profile), 'utf8').split(/\r?\n/u)) {
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
const tables = await client.listTables();
const latest = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name)).at(-1);

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? '');
  return String(v).trim();
}

async function readAll(tid) {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${tid}/records?${q}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

const recs = await readAll(latest.tableId);
const SKU_SIZE_RE = /^\d+(?:\.\d+)?[mM](?:[-,、]?\s*\d+(?:\.\d+)?[mM])*$/u;

say(`表=${latest.name}  总行=${recs.length}`);
say('');
say('=== 尺寸列呈 SKU 格式的行 ===');
for (const r of recs) {
  const v = text(r.fields?.尺寸);
  if (!SKU_SIZE_RE.test(v)) continue;
  say(`  尺寸=${v}`);
  say(`  分类=${text(r.fields?.竞品分类)}  有效=${text(r.fields?.是否有效竞品)}`);
  say(`  标题=${text(r.fields?.商品标题)}`);
  say(`  recordId=${r.record_id ?? r.recordId}`);
  say('');
}

say('=== 含 m/米 尺寸字样的行（前 12，看格式分布）===');
let n = 0;
for (const r of recs) {
  const v = text(r.fields?.尺寸);
  if (!/[mM]|\u7c73/u.test(v)) continue;
  // 只打印脱敏：值 + 分类，不打印标题
  say(`  [${text(r.fields?.竞品分类)}] ${v}`);
  n += 1;
  if (n >= 12) break;
}

// A/B 竞品那一条的尺寸现值
say('');
say('=== 本期 A/B 竞品行的尺寸现值 ===');
for (const r of recs) {
  const c = text(r.fields?.竞品分类);
  if (!/^(?:A-|B-)/u.test(c)) continue;
  say(`  分类=${c}  尺寸=${text(r.fields?.尺寸)}  适用空间=${text(r.fields?.适用空间)}  数据状态=${text(r.fields?.数据状态)}`);
  say(`  标题=${text(r.fields?.商品标题)}`);
}

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
