// 只读探针：验证「竞品周表 商品链接 里的 id」是否能接上「SKU明细 商品ID」
// 目的：为「尺寸写回」找一个不落空的稳定键（标题键交集仅 3）
import { readFileSync } from 'node:fs';
import { activeProfileName, competitorBaseToken, envFilePath, tableId } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = competitorBaseToken();
const WEEKLY = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;

function readEnv(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return out;
}

const env = readEnv(envFilePath());
const auth = await fetch(API_ROOT + '/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error('auth failed ' + auth.code + ' ' + auth.msg);
const headers = { Authorization: 'Bearer ' + auth.tenant_access_token };

async function api(path) {
  const res = await fetch(API_ROOT + path, { headers }).then((r) => r.json());
  if (res.code !== 0) throw new Error(path + ' -> ' + res.code + ' ' + res.msg);
  return res.data;
}

async function listRecords(tid) {
  const items = [];
  let token;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (token) q.set('page_token', token);
    const data = await api('/bitable/v1/apps/' + APP_TOKEN + '/tables/' + tid + '/records?' + q);
    items.push(...(data.items ?? []));
    token = data.has_more ? data.page_token : undefined;
  } while (token);
  return items;
}

const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(',');
  if (typeof v === 'object') return text(v.text ?? v.value ?? v.name);
  return String(v).trim();
};

const idOf = (link) => {
  const m = /[?&]id=(\d+)/u.exec(String(link ?? ''));
  return m ? m[1] : '';
};

console.log('profile=' + activeProfileName() + '  base=' + APP_TOKEN);

const tables = (await api('/bitable/v1/apps/' + APP_TOKEN + '/tables?page_size=100')).items ?? [];
const skuTableId = tableId('skuDetail');
const skuTable = tables.find((t) => t.table_id === skuTableId);
const weekly = tables.filter((t) => WEEKLY.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
if (!skuTable) throw new Error('SKU明细 table not found: ' + skuTableId);
if (!weekly.length) throw new Error('no weekly table');
const target = weekly[weekly.length - 1];

const skuRecords = await listRecords(skuTableId);
const weeklyRecords = await listRecords(target.table_id);

// SKU明细：按商品ID聚合尺寸与空间
const skuById = new Map();
for (const r of skuRecords) {
  const id = text(r.fields?.['商品ID']) || idOf(text(r.fields?.['商品链接']));
  if (!id) continue;
  const b = skuById.get(id) ?? { rows: 0, sizes: new Set(), summaries: new Set(), spaces: new Set(), titles: new Set() };
  b.rows += 1;
  const s = text(r.fields?.['SKU尺寸']);
  const sum = text(r.fields?.['尺寸汇总']);
  const sp = text(r.fields?.['适用空间']);
  if (s) b.sizes.add(s);
  if (sum) b.summaries.add(sum);
  if (sp) b.spaces.add(sp);
  const t = text(r.fields?.['商品标题']);
  if (t) b.titles.add(t);
  skuById.set(id, b);
}

console.log('SKU明细 ' + skuTableId + '：记录 ' + skuRecords.length + '，去重商品ID ' + skuById.size);

// 周表：提取链接 id
const weeklyRows = weeklyRecords.map((r) => ({
  recordId: r.record_id,
  id: idOf(text(r.fields?.['商品链接'])),
  link: text(r.fields?.['商品链接']),
  klass: text(r.fields?.['竞品分类']),
  size: text(r.fields?.['尺寸']),
  space: text(r.fields?.['适用空间']),
  title: text(r.fields?.['商品标题']),
}));
const weeklyNoId = weeklyRows.filter((r) => !r.id).length;
console.log('周表 ' + target.name + ' ' + target.table_id + '：记录 ' + weeklyRows.length + '，链接可提 id ' + (weeklyRows.length - weeklyNoId) + '，提不出 ' + weeklyNoId);

const hit = weeklyRows.filter((r) => r.id && skuById.has(r.id));
console.log('');
console.log('【交集】周表链接id ∩ SKU明细商品ID = ' + hit.length);
const klassCount = new Map();
for (const r of hit) klassCount.set(r.klass, (klassCount.get(r.klass) ?? 0) + 1);
console.log('  命中行 竞品分类 分布：' + [...klassCount.entries()].map(([k, v]) => k + '=' + v).join('  '));

console.log('');
console.log('--- 命中行明细（周表当前尺寸 -> SKU 可得尺寸）---');
for (const r of hit) {
  const b = skuById.get(r.id);
  console.log('  [' + r.klass + '] id=' + r.id + ' 周表尺寸="' + r.size + '" 周表空间="' + r.space + '"');
  console.log('        SKU可得 SKU尺寸=' + [...b.sizes].join('|') + '  尺寸汇总=' + [...b.summaries].join('|') + '  适用空间=' + [...b.spaces].join('|'));
}

// 周表 A/B 全量 vs 其中已采到 SKU 的
const ab = weeklyRows.filter((r) => r.klass.startsWith('A-') || r.klass.startsWith('B-'));
console.log('');
console.log('周表 A/B 行数 = ' + ab.length + '，其中已能拿到 SKU 尺寸的 = ' + ab.filter((r) => r.id && skuById.has(r.id)).length);
for (const r of ab) {
  const b = skuById.get(r.id);
  console.log('  ' + (b ? '[有SKU]' : '[缺SKU]') + ' ' + r.klass + ' id=' + (r.id || '(链接无id)') + ' 尺寸="' + r.size + '" 标题=' + r.title.slice(0, 30));
}

// SKU明细侧：这些商品在周表里出现吗
console.log('');
console.log('--- SKU明细 的 ' + skuById.size + ' 个商品，在周表里的分布 ---');
const weeklyIds = new Set(weeklyRows.map((r) => r.id).filter(Boolean));
for (const [id, b] of skuById) {
  const inWeekly = weeklyIds.has(id);
  console.log('  ' + (inWeekly ? '[周表有]' : '[周表无]') + ' id=' + id + ' 行数=' + b.rows + ' 汇总=' + [...b.summaries].join('|') + ' 标题=' + [...b.titles][0]?.slice(0, 28));
}
console.log('done');
