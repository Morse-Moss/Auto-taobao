import test from 'node:test';
import assert from 'node:assert/strict';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

test('batchDeleteRecords uses the authorized operator table and string record IDs', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) return response({ code: 0, tenant_access_token: 'tenant-token' });
    return response({ code: 0, data: {} });
  };
  const client = new CompetitorV2FeishuClient({ appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', transport });
  await client.authenticate();
  await client.batchDeleteRecords('tblRS5lo0nNN3DOJ', ['rec1', 'rec2']);
  const request = calls.at(-1);
  assert.match(request.url, /tables\/tblRS5lo0nNN3DOJ\/records\/batch_delete$/u);
  assert.deepEqual(JSON.parse(request.init.body), { records: ['rec1', 'rec2'] });
});

test('batchDeleteRecords rejects an unauthorized table', async () => {
  const client = new CompetitorV2FeishuClient({ appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', transport: async () => response({ code: 0, tenant_access_token: 'tenant-token' }) });
  await client.authenticate();
  await assert.rejects(() => client.batchDeleteRecords('tblNotAuthorized', ['rec1']), /Blocked record delete/u);
});
