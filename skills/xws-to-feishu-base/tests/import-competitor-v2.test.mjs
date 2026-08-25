import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliArgs } from '../scripts/import-competitor-v2.mjs';

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
