import assert from 'node:assert/strict';
import test from 'node:test';

import { findFieldDifferences, runCompetitorV2 } from '../scripts/competitor-v2-runner.mjs';

const headers = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
  '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
  '店铺类型', '地址', '收藏人数', '卖点',
];

function row(rank, overrides = {}) {
  return {
    序号: rank,
    商品图片: `https://example.test/${rank}.jpg`,
    商品标题: `亚克力独立浴缸 ${rank}`,
    商品链接: `https://item.taobao.com/item.htm?id=${rank}`,
    价格: 2500,
    月收货人数: '10',
    类目: '普通浴缸',
    同款数: '0',
    平台: '淘宝',
    占位类型: '自然位',
    店铺名: '店铺',
    店铺旺旺: '旺旺',
    店铺类型: '非金牌店铺',
    地址: '广东 佛山',
    收藏人数: '-',
    卖点: '包邮',
    ...overrides,
  };
}

function manifest() {
  return {
    headers,
    rows: [row(1), row(2), row(3)],
    images: [1, 2, 3].map((rank) => ({
      row: rank + 1,
      path: `C:/images/${rank}.png`,
    })),
  };
}

class FakeClient {
  constructor() {
    this.tables = [];
    this.fields = new Map();
    this.records = new Map();
    this.uploads = [];
  }

  async listTables() { return this.tables; }

  async createTable(name, definitions) {
    const tableId = `tbl${this.tables.length + 1}`;
    this.tables.push({ tableId, name });
    this.fields.set(tableId, definitions.map((field) => ({ fieldName: field.name, type: field.type })));
    this.records.set(tableId, []);
    return tableId;
  }

  async listFields(tableId) { return this.fields.get(tableId) ?? []; }
  async listRecords(tableId) { return this.records.get(tableId) ?? []; }

  async uploadFile({ name }) {
    this.uploads.push(name);
    return `token-${name}`;
  }

  async batchCreateRecords(tableId, fieldsList) {
    const records = this.records.get(tableId);
    records.push(...fieldsList.map((fields, index) => ({
      recordId: `rec-${records.length + index + 1}`,
      fields,
    })));
    return fieldsList.map((_, index) => `rec-${index + 1}`);
  }
}

const readFile = async (path) => Buffer.from(path);

test('field diagnostics identify the exact comparable differences', () => {
  assert.deepEqual(findFieldDifferences(
    { price: 2, title: 'same' },
    { price: 1, title: 'same', missing: 'value' },
  ), ['missing', 'price']);
  assert.deepEqual(findFieldDifferences(
    { 价格: '2650.72', 功能: null },
    { 价格: 2650.72 },
  ), []);
});

test('dry-run validates rows and images without touching Feishu', async () => {
  const client = new FakeClient();
  const result = await runCompetitorV2({
    manifest: manifest(),
    client,
    apply: false,
    searchKeyword: '浴缸',
    expectedRows: 3,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.sourceRows, 3);
  assert.equal(result.sourceImages, 3);
  assert.deepEqual(client.tables, []);
  assert.deepEqual(client.uploads, []);
});

test('apply creates three tables and imports all main records with attachments', async () => {
  const client = new FakeClient();
  const result = await runCompetitorV2({
    manifest: manifest(),
    client,
    apply: true,
    searchKeyword: '浴缸',
    expectedRows: 3,
    readFile,
    uploadConcurrency: 2,
  });
  assert.equal(result.importedRows, 3);
  assert.equal(result.attachmentCount, 3);
  assert.deepEqual(client.tables.map((table) => table.name), ['竞品主表', 'SKU明细', '问题库']);
  assert.equal(client.records.get('tbl2').length, 0);
  assert.equal(client.records.get('tbl3').length, 0);
  assert.equal(client.uploads.length, 3);
});

test('resume imports only missing rows after verifying existing records', async () => {
  const client = new FakeClient();
  await runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  });
  client.records.get('tbl1').splice(1);
  client.uploads.length = 0;

  const result = await runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  });
  assert.equal(result.resumedFromRows, 1);
  assert.equal(result.importedThisRun, 2);
  assert.equal(client.uploads.length, 2);
});

test('resume accepts approved formula-backed calculated fields', async () => {
  const client = new FakeClient();
  await runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  });
  for (const field of client.fields.get('tbl1')) {
    if ([
      '月收货人数计算值', '计算口径', '月收货金额',
      '客单价带分类', '竞品分类', '数据状态', '待补数据项',
    ].includes(field.fieldName)) field.type = 20;
  }
  const result = await runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  });
  assert.equal(result.importedThisRun, 0);
  assert.equal(result.importedRows, 3);
});

test('resume refuses a mismatched existing row before uploading files', async () => {
  const client = new FakeClient();
  await runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  });
  client.records.get('tbl1')[0].fields.价格 = 1;
  client.uploads.length = 0;

  await assert.rejects(() => runCompetitorV2({
    manifest: manifest(), client, apply: true, searchKeyword: '浴缸', expectedRows: 3,
    readFile, uploadConcurrency: 2,
  }), /existing record differs/u);
  assert.equal(client.uploads.length, 0);
});
