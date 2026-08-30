import assert from 'node:assert/strict';
import test from 'node:test';

import { CompetitorV2FeishuClient, parseCliArgs } from '../scripts/import-competitor-v2.mjs';

const required = [
  '--xlsx', 'C:/source.xlsx',
  '--base-url', 'https://tenant.feishu.cn/base/app123?table=tblSource',
  '--work-dir', 'D:/work',
  '--search-keyword', '浴缸',
];

test('dry-run does not require credentials or a mutation confirmation', () => {
  const options = parseCliArgs([...required, '--expected-rows', '3']);
  assert.equal(options.apply, false);
  assert.equal(options.expectedRows, 3);
  assert.equal(options.searchKeyword, '浴缸');
});

test('row count must be explicit instead of defaulting to a historical snapshot size', () => {
  assert.throws(() => parseCliArgs(required), /--expected-rows is required/u);
});

test('apply requires an env file and explicit app-token confirmation', () => {
  const withRows = [...required, '--expected-rows', '3'];
  assert.throws(() => parseCliArgs([...withRows, '--apply']), /--env-file/u);
  assert.throws(() => parseCliArgs([
    ...withRows, '--apply', '--env-file', 'E:/private.env',
  ]), /--confirm-app-token/u);
  const options = parseCliArgs([
    ...withRows, '--apply', '--env-file', 'E:/private.env',
    '--confirm-app-token', 'app123', '--upload-concurrency', '3',
  ]);
  assert.equal(options.confirmAppToken, 'app123');
  assert.equal(options.uploadConcurrency, 3);
});

test('numeric options reject zero, negative, and non-integer values', () => {
  assert.throws(() => parseCliArgs([...required, '--expected-rows', '0']), /positive integer/u);
  assert.throws(() => parseCliArgs([...required, '--upload-concurrency', '1.5']), /positive integer/u);
});

test('competitor client only permits the fixed visualization history table name', () => {
  const client = new CompetitorV2FeishuClient({ appId: 'id', appSecret: 'secret', appToken: 'app' });
  client.request = async () => ({ table_id: 'tblHistory' });
  return client.createTable('竞品历史总表 V1', [{ name: '商品周期唯一键', type: 1 }]).then((id) => {
    assert.equal(id, 'tblHistory');
    return assert.rejects(() => client.createTable('任意新表', [{ name: 'x', type: 1 }]), /Blocked table creation/u);
  });
});

test('competitor client authorizes only the exact visualization history table for record writes', async () => {
  const client = new CompetitorV2FeishuClient({ appId: 'id', appSecret: 'secret', appToken: 'app' });
  client.request = async () => ({ records: [{ record_id: 'rec-1' }] });

  client.authorizeHistoryTarget('tblHistory', '竞品历史总表 V1');
  assert.deepEqual(await client.batchCreateRecords('tblHistory', [{ 商品周期唯一键: 'key-1' }]), ['rec-1']);
  await assert.rejects(
    () => client.batchCreateRecords('tblOther', [{ 商品周期唯一键: 'key-2' }]),
    /Blocked record write outside authorized competitor tables/u,
  );
  assert.deepEqual(await client.batchUpdateRecords('tblHistory', [{ record_id: 'rec-1', fields: { 商品周期唯一键: 'key-1' } }]), ['rec-1']);
  await assert.rejects(
    () => client.batchUpdateRecords('tblOther', [{ record_id: 'rec-2', fields: { 商品周期唯一键: 'key-2' } }]),
    /Blocked record write outside authorized competitor tables/u,
  );
  assert.deepEqual(await client.batchDeleteRecords('tblHistory', ['rec-1']), ['rec-1']);
  await assert.rejects(
    () => client.batchDeleteRecords('tblOther', ['rec-2']),
    /Blocked record write outside authorized competitor tables/u,
  );
  assert.throws(() => client.authorizeHistoryTarget('tblOther', '任意新表'), /Blocked history target/u);
});
