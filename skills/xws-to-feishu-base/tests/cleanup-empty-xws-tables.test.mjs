import assert from 'node:assert/strict';
import test from 'node:test';

import { ALLOWED_CLEANUP_TABLE_NAMES, parseCleanupArgs } from '../scripts/cleanup-empty-xws-tables.mjs';

test('cleanup accepts only the explicit empty XWS test-table allowlist', () => {
  assert.equal(ALLOWED_CLEANUP_TABLE_NAMES.has('XWS API Stability Round 1'), true);
  assert.equal(ALLOWED_CLEANUP_TABLE_NAMES.has('竞品主表'), false);
  assert.throws(() => parseCleanupArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app?table=tbl',
    '--env-file', 'E:/private.env',
    '--confirm-app-token', 'app',
    '--table-name', '竞品主表',
  ]), /not allowlisted/u);
});

test('cleanup requires explicit app-token confirmation and at least one table name', () => {
  assert.throws(() => parseCleanupArgs([]), /--base-url/u);
  assert.throws(() => parseCleanupArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app?table=tbl',
    '--env-file', 'E:/private.env',
  ]), /--confirm-app-token/u);
  assert.throws(() => parseCleanupArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app?table=tbl',
    '--env-file', 'E:/private.env',
    '--confirm-app-token', 'app',
  ]), /--table-name/u);
});
