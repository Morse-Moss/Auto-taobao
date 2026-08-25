#!/usr/bin/env node
import fs from 'node:fs';

const ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = process.env.FEISHU_APP_TOKEN || 'OWebbPUcBa7B8JseYLccQCy9nkf';
const TABLE_ID = process.env.FEISHU_TABLE_ID || 'tbl7u5CUYiRei7AQ';
const SOURCE = process.env.FEISHU_SOURCE_CSV || 'D:/Retire/sycm-automation/runtime/latest-competitor-1-40-20260824.csv';
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/u, '')); rows.push(row); }
  return rows;
}

function idFromUrl(url) { return String(url).match(/[?&]id=(\d+)/u)?.[1] || ''; }
function numberOrText(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '-') return s;
  const n = Number(s.replace(/,/gu, ''));
  return Number.isFinite(n) ? n : s;
}
function hyperlink(value) { const s = String(value ?? '').trim(); return s ? { text: s, link: s } : null; }

const csvRows = parseCsv(fs.readFileSync(SOURCE, 'utf8').replace(/^\uFEFF/u, ''));
const headers = csvRows.shift();
const rows = csvRows.filter((r) => r.some((v) => String(v ?? '').trim()));
if (rows.length !== 1461) throw new Error(`Expected 1461 source rows, got ${rows.length}`);

const auth = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const authPayload = await auth.json();
if (!auth.ok || authPayload.code !== 0) throw new Error(`Feishu auth failed: ${auth.status} ${authPayload.code} ${authPayload.msg}`);
const token = authPayload.tenant_access_token;
const request = async (method, path, body) => {
  const response = await fetch(`${ROOT}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code} ${payload.msg}`);
  return payload.data ?? {};
};

const existing = []; let pageToken;
do {
  const query = new URLSearchParams({ page_size: '500' });
  if (pageToken) query.set('page_token', pageToken);
  const data = await request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${query}`);
  existing.push(...(data.items ?? []));
  pageToken = data.has_more ? data.page_token : undefined;
} while (pageToken);

const byKey = new Map();
for (const record of existing) {
  const key = String(record.fields?.['商品周期唯一键'] ?? '').trim();
  if (key) byKey.set(key, record.record_id);
}
const collectedAt = new Date('2026-08-24T00:00:00+08:00').getTime();
const makeFields = (r) => {
  const id = idFromUrl(r[3]);
  return {
    '商品周期唯一键': `${id}-20260824`,
    '商品ID': numberOrText(id),
    '商品图片': hyperlink(r[1]),
    '商品标题': r[2],
    '商品链接': hyperlink(r[3]),
    '价格': numberOrText(r[4]),
    '月收货人数': r[5],
    '类目': r[6],
    '同款数': numberOrText(r[7]),
    '平台': r[8],
    '店铺名': r[10],
    '店铺旺旺': r[11],
    '店铺类型': r[12],
    '地址': r[13],
    '收藏人数': r[14],
    '卖点': r[15],
    '搜索关键词': '浴缸',
    '采集时间': collectedAt,
    '公式版本': 'v2',
    'AI提示词版本': 'v1',
  };
};
const updates = []; const creates = [];
for (const row of rows) {
  const fields = makeFields(row);
  const recordId = byKey.get(fields['商品周期唯一键']);
  if (recordId) updates.push({ record_id: recordId, fields });
  else creates.push(fields);
}
async function batches(items, operation) {
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    await request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${operation}`, { records: operation === 'batch_update' ? batch : batch.map((fields) => ({ fields })) });
    console.error(JSON.stringify({ operation, completed: Math.min(i + batch.length, items.length), total: items.length }));
  }
}
await batches(updates, 'batch_update');
await batches(creates, 'batch_create');

const verify = []; let verifyToken;
do {
  const query = new URLSearchParams({ page_size: '500' });
  if (verifyToken) query.set('page_token', verifyToken);
  const data = await request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${query}`);
  verify.push(...(data.items ?? []));
  verifyToken = data.has_more ? data.page_token : undefined;
} while (verifyToken);
const mismatches = [];
for (const row of rows) {
  const key = `${idFromUrl(row[3])}-20260824`;
  const record = verify.find((item) => item.fields?.['商品周期唯一键'] === key);
  if (!record || String(record.fields?.['商品链接']?.link ?? record.fields?.['商品链接'] ?? '') !== row[3] || String(record.fields?.['商品标题'] ?? '') !== row[2]) mismatches.push(key);
}
if (mismatches.length) throw new Error(`Verification mismatches: ${mismatches.slice(0, 10).join(', ')}`);
console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', sourceRows: rows.length, existingRowsBefore: existing.length, updatedRows: updates.length, createdRows: creates.length, finalRows: verify.length, emptyPlaceholders: verify.filter((r) => !String(r.fields?.['商品周期唯一键'] ?? '').trim()).length, mismatches: 0 }, null, 2));
