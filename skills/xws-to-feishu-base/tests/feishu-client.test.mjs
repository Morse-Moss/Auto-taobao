import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuClient } from '../scripts/feishu-client.mjs';

// 假 Response 必须同时提供 `json` **和** `text`：客户端改成「先 text 再解析」，
// 少了 text 会以 `response.text is not a function` 变红 —— 那是 mock 不完整，不是被测代码的问题。
function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** 造一个「正文是 HTML、`json()` 必炸」的假 Response，用来钉住状态码不被吞掉。 */
function htmlResponse(status) {
  const body = `<!DOCTYPE html><html><body><h1>${status} error</h1></body></html>`;
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => { throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'); },
  };
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

// 2026-10-06 商品链实测的真因：写后回读收到 HTML（网关 / 限流拦截页），
// 客户端先 `await response.json()` ⇒ 只抛一句 `Unexpected token '<'`，**真实状态码被吞掉**，
// 事后无法区分 429 限流与 502/503 —— 判因时只能靠猜。这两条钉住修复后的契约。
test('读接口收到 HTML 时，错误信息带出真实状态码与正文片段', async () => {
  const transport = async (url) => (url.endsWith('/auth/v3/tenant_access_token/internal')
    ? response({ code: 0, tenant_access_token: 'tenant-token' })
    : htmlResponse(502));
  const client = new FeishuClient({
    appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', tableId: 'table-id', transport,
  });

  await assert.rejects(() => client.listRecords(), (error) => {
    assert.match(error.message, /Feishu API failed: 502/u, '错误信息里必须有真实状态码');
    assert.match(error.message, /non-JSON body/u, '并且要说明「正文不是 JSON」');
    assert.doesNotMatch(error.message, /Unexpected token/u,
      '走到 json() 才抛的语法错误不许再出现 —— 那正是吞掉状态码的那条路径');
    return true;
  });
});

test('认证接口收到 HTML 时，同样带出状态码', async () => {
  const transport = async () => htmlResponse(503);
  const client = new FeishuClient({
    appId: 'app-id', appSecret: 'app-secret', appToken: 'base-token', tableId: 'table-id', transport,
  });

  await assert.rejects(() => client.listRecords(), (error) => {
    assert.match(error.message, /Feishu authentication failed: 503/u);
    return true;
  });
});
