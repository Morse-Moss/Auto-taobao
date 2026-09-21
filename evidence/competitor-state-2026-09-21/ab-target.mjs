// 只读探针：从最新竞品周表取出 A/B 且「是否有效竞品=是」的目标，供第 6 步预检用
// 只发 GET。用法：node D:/Retire/probe-live/ab-target.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/ab-target.txt';

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
const weekly = tables.filter((t) => /^竞品周_/u.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
const latest = weekly[weekly.length - 1];
say(`最新周表 = ${latest.name} (${latest.tableId})`);

const items = [];
let pageToken;
do {
  const q = new URLSearchParams({ page_size: '500' });
  if (pageToken) q.set('page_token', pageToken);
  const data = await client.request('GET', `/bitable/v1/apps/${base}/tables/${latest.tableId}/records?${q}`);
  items.push(...(data.items ?? []));
  pageToken = data.has_more ? data.page_token : undefined;
} while (pageToken);

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? v.link ?? v.url ?? '');
  return String(v).trim();
}

const ab = items.filter((r) => {
  const c = text(r.fields?.竞品分类);
  const v = text(r.fields?.是否有效竞品);
  return /^(?:A-|B-)/u.test(c) && v === '是';
});

say(`总行数=${items.length}  A/B且有效=${ab.length}`);
say('');
for (const r of ab) {
  const link = text(r.fields?.商品链接);
  const id = link.match(/[?&]id=(\d+)/u)?.[1] ?? '';
  say(`recordId   = ${r.record_id ?? r.recordId}`);
  say(`竞品分类   = ${text(r.fields?.竞品分类)}`);
  say(`是否有效   = ${text(r.fields?.是否有效竞品)}`);
  say(`商品ID     = ${id}`);
  say(`商品链接   = ${link}`);
  say(`商品标题   = ${text(r.fields?.商品标题)}`);
  say(`尺寸列     = ${text(r.fields?.尺寸)}`);
  say(`周表记录ID = 见上`);
  say('');
}
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
