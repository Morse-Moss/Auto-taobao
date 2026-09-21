// 只读探针：竞品周表 与 SKU明细 能不能按「商品标题」接上
//
// 动机：周表「尺寸」列回落成了标题规则值（无注明/60宽），receipt 显示 skuBacked 只有 3。
// 要分清两种可能：①标题格式不同（能对上但键不对）②两周商品本就无交集（纯粹时序问题）。
// 只发 GET。用法：node D:/Retire/probe-live/title-join-check.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUT = 'D:/Retire/probe-live/title-join-check.txt';

const { activeProfileName, competitorBaseToken, envFilePath, tableId } = await import(`file:///${REPO}/runtime/feishu-targets.mjs`);
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
const tableByName = (name) => tables.find((t) => t.name === name)?.tableId;

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

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name ?? '');
  return String(v).trim();
}

const weeklyId = tableByName('竞品周_2026-09-13_2026-09-19');
const skuId = tableId('skuDetail', profile);
const skuWeeklyId = tableByName('SKU周_2026-08-23_2026-08-29');

const weekly = await readAll(weeklyId);
const sku = await readAll(skuId);
const skuWeekly = skuWeeklyId ? await readAll(skuWeeklyId) : [];

const weekTitles = new Set(weekly.map((r) => text(r.fields?.商品标题)).filter(Boolean));
const skuTitles = new Set(sku.map((r) => text(r.fields?.商品标题)).filter(Boolean));
const skuWeekTitles = new Set(skuWeekly.map((r) => text(r.fields?.商品标题)).filter(Boolean));

const inter = [...weekTitles].filter((t) => skuTitles.has(t));

say(`周表(09-13) 记录=${weekly.length}  去重商品标题=${weekTitles.size}`);
say(`SKU明细    记录=${sku.length}  去重商品标题=${skuTitles.size}`);
say(`SKU周(08-23) 记录=${skuWeekly.length} 去重商品标题=${skuWeekTitles.size}`);
say('');
say(`【交集】周表标题 ∩ SKU明细标题 = ${inter.length}`);
say(`【交集】周表标题 ∩ SKU周头(08-23)标题 = ${[...weekTitles].filter((t) => skuWeekTitles.has(t)).length}`);
say('');

say('--- SKU明细 的商品标题样本（前 8，截断 60 字）---');
for (const t of [...skuTitles].slice(0, 8)) say(`  [${t.length}] ${t.slice(0, 60)}`);
say('');
say('--- 周表(09-13) 的商品标题样本（前 8，截断 60 字）---');
for (const t of [...weekTitles].slice(0, 8)) say(`  [${t.length}] ${t.slice(0, 60)}`);
say('');

// 周表 A/B 竞品（B-高价值 1 条）的标题，看它是否在 SKU明细里
const abTitles = weekly
  .filter((r) => /^(?:A-|B-)/u.test(text(r.fields?.竞品分类)))
  .map((r) => text(r.fields?.商品标题));
say(`--- 周表 A/B 竞品 ${abTitles.length} 条，逐条看是否命中 SKU明细 ---`);
for (const t of abTitles) say(`  命中=${skuTitles.has(t) ? '是' : '否'}  ${t.slice(0, 60)}`);
say('');

// 周表「尺寸」列取值分布
const sizeDist = new Map();
for (const r of weekly) {
  const v = text(r.fields?.尺寸) || '(空)';
  sizeDist.set(v, (sizeDist.get(v) ?? 0) + 1);
}
say('--- 周表「尺寸」列取值分布（按次数降序，前 15）---');
for (const [k, n] of [...sizeDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const looksSku = /^\d+(?:\.\d+)?m(?:-\d+(?:\.\d+)?m)?$/u.test(k);
  say(`  ${String(n).padStart(5)}  ${k}${looksSku ? '   <= SKU 尺寸格式' : ''}`);
}
const skuFormat = [...sizeDist.entries()].filter(([k]) => /^\d+(?:\.\d+)?m(?:-\d+(?:\.\d+)?m)?$/u.test(k)).reduce((s, [, n]) => s + n, 0);
say('');
say(`【关键】周表「尺寸」是 SKU 格式的行数 = ${skuFormat} / ${weekly.length}`);

say('');
say('done');
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
