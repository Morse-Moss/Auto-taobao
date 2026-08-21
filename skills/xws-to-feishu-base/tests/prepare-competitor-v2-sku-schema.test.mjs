import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSkuSchemaArgs,
  relationValueHasLinkedRecords,
} from '../scripts/prepare-competitor-v2-sku-schema.mjs';

const baseArgs = [
  '--base-url', 'https://rcndesfqro3x.feishu.cn/base/appSku?table=tblMain',
  '--sku-table-id', 'tblSku',
  '--expected-main-rows', '1333',
  '--expected-sku-rows', '0',
];

test('SKU schema CLI keeps dry runs read-only and requires exact apply confirmations', () => {
  const dryRun = parseSkuSchemaArgs(baseArgs);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.appToken, 'appSku');
  assert.equal(dryRun.mainTableId, 'tblMain');
  assert.equal(dryRun.skuTableId, 'tblSku');
  assert.throws(() => parseSkuSchemaArgs([
    '--base-url', 'https://rcndesfqro3x.feishu.cn/base/appSku?table=tblMain',
    '--sku-table-id', 'tblSku',
    '--expected-sku-rows', '0',
  ]), /--expected-main-rows is required/u);
  assert.throws(() => parseSkuSchemaArgs([
    '--base-url', 'https://rcndesfqro3x.feishu.cn/base/appSku?table=tblMain',
    '--sku-table-id', 'tblSku',
    '--expected-main-rows', '1333',
  ]), /--expected-sku-rows is required/u);

  assert.throws(() => parseSkuSchemaArgs([
    ...baseArgs, '--apply', '--env-file', 'C:/credentials.env',
  ]), /confirm-app-token/u);
  assert.throws(() => parseSkuSchemaArgs([
    ...baseArgs, '--apply', '--env-file', 'C:/credentials.env',
    '--confirm-app-token', 'appSku', '--confirm-main-table-id', 'tblOther',
    '--confirm-sku-table-id', 'tblSku',
  ]), /confirm-main-table-id mismatch/u);
});

test('blank Feishu backlink placeholders do not count as SKU record links', () => {
  assert.equal(relationValueHasLinkedRecords([{
    record_ids: null,
    table_id: 'tblSku',
    text: null,
    text_arr: [],
    type: 'text',
  }]), false);
  assert.equal(relationValueHasLinkedRecords([{
    record_ids: ['recSku1'],
    table_id: 'tblSku',
    text: 'SKU A',
  }]), true);
});
