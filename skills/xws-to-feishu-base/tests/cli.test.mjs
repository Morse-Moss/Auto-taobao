import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliArgs } from '../scripts/import-xws-to-feishu.mjs';

test('defaults to a network-free dry run', () => {
  const args = parseCliArgs([
    '--xlsx', 'source.xlsx',
    '--base-url', 'https://example.feishu.cn/base/base1?table=table1',
  ]);
  assert.equal(args.commit, false);
  assert.equal(args.prepareTarget, false);
  assert.equal(args.xlsx, 'source.xlsx');
});

test('requires an environment file for commit mode', () => {
  assert.throws(
    () => parseCliArgs([
      '--xlsx', 'source.xlsx',
      '--base-url', 'https://example.feishu.cn/base/base1?table=table1',
      '--commit',
    ]),
    /--env-file is required/i,
  );
});

test('accepts explicit target preparation only with commit mode', () => {
  assert.throws(
    () => parseCliArgs([
      '--xlsx', 'source.xlsx',
      '--base-url', 'https://example.feishu.cn/base/base1?table=table1',
      '--prepare-target',
    ]),
    /requires --commit/i,
  );
});
