#!/usr/bin/env node
const ROOT = 'https://open.feishu.cn/open-apis';
const APP = process.env.FEISHU_APP_TOKEN || 'OWebbPUcBa7B8JseYLccQCy9nkf';
const TABLE = process.env.FEISHU_TABLE_ID || 'tbl7u5CUYiRei7AQ';
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
const auth = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
const authBody = await auth.json();
if (!auth.ok || authBody.code !== 0) throw new Error(`Feishu auth failed: ${auth.status} ${authBody.code} ${authBody.msg}`);
const token = authBody.tenant_access_token;
const request = async (method, path, body) => {
  const response = await fetch(`${ROOT}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code} ${payload.msg}`);
  return payload.data ?? {};
};
async function listFields() { return (await request('GET', `/bitable/v1/apps/${APP}/tables/${TABLE}/fields?page_size=100`)).items ?? []; }
async function listRecords() {
  const out = []; let pageToken;
  do { const q = new URLSearchParams({ page_size: '500' }); if (pageToken) q.set('page_token', pageToken); const data = await request('GET', `/bitable/v1/apps/${APP}/tables/${TABLE}/records?${q}`); out.push(...(data.items ?? [])); pageToken = data.has_more ? data.page_token : undefined; } while (pageToken);
  return out;
}
const placeholderNames = Array.from({ length: 10 }, (_, i) => `字段 ${i + 1}`);
const beforeRecords = await listRecords();
const beforeFields = await listFields();
const placeholders = beforeFields.filter((field) => placeholderNames.includes(field.field_name));
if (placeholders.length !== 10) throw new Error(`Expected 10 placeholder fields, found ${placeholders.length}`);
const clearUpdates = beforeRecords.filter((record) => placeholderNames.some((name) => record.fields?.[name] !== null && record.fields?.[name] !== undefined && record.fields?.[name] !== ''))
  .map((record) => ({ record_id: record.record_id, fields: Object.fromEntries(placeholderNames.map((name) => [name, null])) }));
for (let i = 0; i < clearUpdates.length; i += 500) await request('POST', `/bitable/v1/apps/${APP}/tables/${TABLE}/records/batch_update`, { records: clearUpdates.slice(i, i + 500) });
const afterClear = await listRecords();
const remainingValues = afterClear.reduce((total, record) => total + placeholderNames.filter((name) => record.fields?.[name] !== null && record.fields?.[name] !== undefined && record.fields?.[name] !== '').length, 0);
if (remainingValues) throw new Error(`Placeholder values remain: ${remainingValues}`);
for (const field of placeholders) await request('DELETE', `/bitable/v1/apps/${APP}/tables/${TABLE}/fields/${field.field_id}`);
const afterFields = await listFields();
const remainingFields = afterFields.filter((field) => placeholderNames.includes(field.field_name)).map((field) => field.field_name);
if (remainingFields.length) throw new Error(`Placeholder fields remain: ${remainingFields.join(', ')}`);
const afterRecords = await listRecords();
if (afterRecords.length !== beforeRecords.length) throw new Error(`Record count changed: ${beforeRecords.length} -> ${afterRecords.length}`);
console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', clearedRecordUpdates: clearUpdates.length, deletedFields: placeholderNames, recordsBefore: beforeRecords.length, recordsAfter: afterRecords.length, remainingPlaceholderFields: [] }, null, 2));
