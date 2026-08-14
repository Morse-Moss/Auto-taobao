import assert from 'node:assert/strict';
import test from 'node:test';

import { XWS_HEADERS } from '../scripts/import-core.mjs';
import { runImport } from '../scripts/import-runner.mjs';

function row(rank) {
  return Object.fromEntries(XWS_HEADERS.map((name) => [name, ({
    序号: rank,
    商品标题: `商品 ${rank}`,
    商品链接: `https://item.taobao.com/item.htm?id=${rank}`,
    价格: String(600 + rank),
    月收货人数: '100+',
    收藏人数: '-',
  })[name] ?? '']));
}

function fields(imageType) {
  return XWS_HEADERS.map((fieldName) => ({
    fieldId: `field-${fieldName}`,
    fieldName,
    type: fieldName === '商品图片' ? imageType : 1,
  }));
}

test('prepares an empty target, uploads every image, and verifies attachments', async () => {
  let currentFields = fields(2);
  let createdFields;
  const client = {
    getRecordCount: async () => 0,
    listFields: async () => currentFields,
    updateFieldType: async (fieldId, type) => {
      assert.equal(fieldId, 'field-商品图片');
      assert.equal(type, 17);
      currentFields = fields(17);
    },
    uploadFile: async ({ name, bytes }) => `${name}-${bytes.toString()}`,
    batchCreateRecords: async (items) => {
      createdFields = items;
      return ['record-1', 'record-2'];
    },
    listRecords: async () => createdFields.map((record, index) => ({
      record_id: `record-${index + 1}`,
      fields: record,
    })),
  };

  const result = await runImport({
    manifest: {
      headers: XWS_HEADERS,
      rows: [row(1), row(2)],
      images: [
        { row: 2, path: 'row-2.png' },
        { row: 3, path: 'row-3.png' },
      ],
    },
    client,
    commit: true,
    prepareTarget: true,
    readFile: async (path) => Buffer.from(path),
    sleep: async () => {},
  });

  assert.equal(result.importedRows, 2);
  assert.equal(result.attachmentCount, 2);
  assert.deepEqual(createdFields.map((item) => item.商品图片), [
    [{ file_token: 'row-2.png-row-2.png' }],
    [{ file_token: 'row-3.png-row-3.png' }],
  ]);
});

test('rejects a workbook row without exactly one embedded image', async () => {
  await assert.rejects(
    () => runImport({
      manifest: { headers: XWS_HEADERS, rows: [row(1)], images: [] },
      commit: false,
    }),
    /exactly one embedded image/i,
  );
});

test('dry-run accepts and reports the observed payment-count field', async () => {
  const headers = XWS_HEADERS.with(5, '付款人数');
  const sourceRow = Object.fromEntries(headers.map((name) => [name, name === '序号' ? 1 : '']));
  const result = await runImport({
    manifest: {
      headers,
      rows: [sourceRow],
      images: [{ row: 2, path: 'row-2.png' }],
    },
    commit: false,
  });
  assert.match(result.numericTransform, /付款人数/u);
});
