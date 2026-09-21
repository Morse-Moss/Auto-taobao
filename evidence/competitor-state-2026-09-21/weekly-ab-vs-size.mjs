// 只读探针：各期周表「A/B 竞品行数」 vs 「尺寸列有值行数」 vs 「SKU 格式行数」
//
// 目的：判断「尺寸列大量无注明」是 bug，还是口径（只有 A/B 才有尺寸）决定的正​常表现。
// 只发 GET。用法：node D:/Retire/probe-live/weekly-ab-vs-size.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/weekly-ab-vs-size.txt';

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

const SKU_SIZE_RE = /^\d+(?:\.\d+)?[mM](?:[-,、]?\s*\d+(?:\.\d+)?[mM])*$/u;
const weekly = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));

say('期次                 总行  A/B行  尺寸非空  尺寸是SKU格式  尺寸列类型');
say('-------------------------------------------------------------------------');
for (const t of weekly) {
  const fields = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (pageToken) q.set('page_token', pageToken);
    const d = await client.request('GET', `/bitable/v1/apps/${base}/tables/${t.tableId}/fields?${q}`);
    fields.push(...(d.items ?? []));
    pageToken = d.has_more ? d.page_token : undefined;
  } while (pageToken);
  const sizeField = fields.find((f) => f.field_name === '尺寸');
  const recs = await readAll(t.tableId);
  const abCount = recs.filter((r) => {
    const c = text(r.fields?.竞品分类);
    const v = text(r.fields?.是否有效竞品);
    return /^(?:A-|B-)/u.test(c) && v === '是';
  }).length;
  const nonEmpty = recs.filter((r) => text(r.fields?.尺寸)).length;
  const skuFmt = recs.filter((r) => SKU_SIZE_RE.test(text(r.fields?.尺寸))).length;
  const uiType = sizeField ? `${sizeField.ui_type ?? sizeField.type}(raw=${sizeField.type})` : '（无此字段）';
  say(`${t.name}  ${String(recs.length).padStart(4)}  ${String(abCount).padStart(4)}  ${String(nonEmpty).padStart(6)}  ${String(skuFmt).padStart(10)}  ${uiType}`);
}

say('');
say('判读：若「A/B行」≈「尺寸非空」⇒ 尺寸列大量无注明是口径正常，不是 bug。');

// 主表：A/B 行数 vs 尺寸有值行数
const main = tables.find((t) => t.name === '竞品主表');
const mainRecs = await readAll(main.tableId);
const mainAb = mainRecs.filter((r) => {
  const c = text(r.fields?.竞品分类);
  const v = text(r.fields?.是否有效竞品);
  return /^(?:A-|B-)/u.test(c) && v === '是';
}).length;
const mainSize = mainRecs.filter((r) => text(r.fields?.尺寸)).length;
say('');
say(`竞品主表：总行=${mainRecs.length}  A/B且有效=${mainAb}  尺寸有值=${mainSize}`);

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
