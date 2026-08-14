import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecordFields,
  parseBaseUrl,
  validateSourceHeaders,
  validateTarget,
} from '../scripts/import-core.mjs';

const headers = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
  '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
  '店铺类型', '地址', '收藏人数', '卖点',
];

test('parses base and table identifiers from an authorized copy URL', () => {
  assert.deepEqual(
    parseBaseUrl('https://example.feishu.cn/base/baseToken123?table=table456&view=view789'),
    { appToken: 'baseToken123', tableId: 'table456' },
  );
});

test('builds an attachment field and applies the template numeric contract', () => {
  const row = Object.fromEntries(headers.map((name) => [name, '']));
  Object.assign(row, {
    序号: 1,
    商品标题: '测试浴缸',
    商品链接: 'https://item.taobao.com/item.htm?id=1',
    价格: '612',
    月收货人数: '100+',
    收藏人数: '-',
  });

  const fields = buildRecordFields(row, 'file-token-1');

  assert.deepEqual(fields.商品图片, [{ file_token: 'file-token-1' }]);
  assert.equal(fields.价格, 612);
  assert.equal(fields.月收货人数, 100);
  assert.equal(fields.收藏人数, '-');
});

test('preserves the observed payment-count field contract', () => {
  const sourceHeaders = headers.with(5, '付款人数');
  const row = Object.fromEntries(sourceHeaders.map((name) => [name, '']));
  Object.assign(row, { 序号: 1, 价格: '612', 付款人数: '100+' });

  assert.equal(validateSourceHeaders(sourceHeaders), '付款人数');
  const fields = buildRecordFields(row, 'file-token-1', sourceHeaders);
  assert.equal(fields.付款人数, '100+');
  assert.equal('月收货人数' in fields, false);
});

test('preserves a displayed payment-count suffix instead of inferring a number', () => {
  const sourceHeaders = headers.with(5, '付款人数');
  const row = Object.fromEntries(sourceHeaders.map((name) => [name, '']));
  Object.assign(row, { 序号: 1, 价格: '612', 付款人数: '14人看过' });

  const fields = buildRecordFields(row, 'file-token-1', sourceHeaders);
  assert.equal(fields.付款人数, '14人看过');
});

test('rejects a non-empty target before any write', () => {
  assert.throws(
    () => validateTarget({ recordCount: 1, fields: [] }),
    /target table must be empty/i,
  );
});

test('requires 商品图片 to be an attachment field', () => {
  assert.throws(
    () => validateTarget({ recordCount: 0, fields: [{ fieldName: '商品图片', type: 2 }] }),
    /商品图片.*type 17/i,
  );
});

test('accepts an empty target with an attachment image field', () => {
  assert.doesNotThrow(() => validateTarget({
    recordCount: 0,
    fields: headers.map((fieldName) => ({
      fieldName,
      type: fieldName === '商品图片' ? 17 : 1,
    })),
  }));
});
