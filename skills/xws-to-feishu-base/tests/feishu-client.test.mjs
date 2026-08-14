import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuClient } from '../scripts/feishu-client.mjs';

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

test('uploads an image to the target bitable and returns its file token', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
      return response({ code: 0, tenant_access_token: 'tenant-token' });
    }
    return response({ code: 0, data: { file_token: 'file-token-1' } });
  };
  const client = new FeishuClient({
    appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', tableId: 'table-id', transport,
  });

  const token = await client.uploadFile({ name: 'image.png', bytes: Buffer.from('png') });

  assert.equal(token, 'file-token-1');
  const upload = calls.at(-1);
  assert.equal(upload.init.body.get('parent_type'), 'bitable_file');
  assert.equal(upload.init.body.get('parent_node'), 'base-token');
  assert.equal(upload.init.body.get('size'), '3');
});

test('batch creates records without exposing authorization in the payload', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
      return response({ code: 0, tenant_access_token: 'tenant-token' });
    }
    return response({ code: 0, data: { records: [{ record_id: 'record-1' }] } });
  };
  const client = new FeishuClient({
    appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', tableId: 'table-id', transport,
  });

  const ids = await client.batchCreateRecords([{ 商品标题: '测试浴缸' }]);

  assert.deepEqual(ids, ['record-1']);
  const request = calls.at(-1);
  assert.match(request.url, /records\/batch_create$/);
  assert.deepEqual(JSON.parse(request.init.body), { records: [{ fields: { 商品标题: '测试浴缸' } }] });
});
