import assert from 'node:assert/strict';
import test from 'node:test';

import { extractManifest, parseCliArgs } from '../scripts/import-xws-to-feishu.mjs';

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

test('extractManifest: 抽取子进程 stdio 守 EBUSY 纪律（stdin 必须 ignore）', () => {
  // 2026-10-16 真机导入实测：漏写 stdio ⇒ 默认 stdin 管道在宿主沙箱下 spawnSync 直接
  // EBUSY ⇒ status=null、stdout/stderr 全 undefined ⇒ 报错只剩
  // 「Cannot read properties of undefined (reading 'trim')」，导入一步都跑不了。
  // 与 1.7.1 / 1.9.2 / 1.9.4 同一病根，第四处调用点。
  const calls = [];
  const impl = (...args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify({ rows: [], images: [] }) };
  };
  const manifest = extractManifest({
    xlsx: 'C:/x/source.xlsx', outputDir: 'C:/x/images', python: 'py', spawnImpl: impl,
  });
  assert.deepEqual(manifest, { rows: [], images: [] });
  assert.equal(calls.length, 1);
  const [command, argv, options] = calls[0];
  assert.equal(command, 'py');
  assert.ok(argv.some((item) => String(item).endsWith('extract_xws_xlsx.py')), '必须调抽取脚本');
  assert.equal('input' in options, false, '不许用 input:（stdin 管道，沙箱下 EBUSY）');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('extractManifest: spawn 起不来（EBUSY 形状）⇒ 报错带得出原因，不是 undefined', () => {
  const impl = () => ({ status: null, stdout: undefined, stderr: undefined, error: Object.assign(new Error('spawnSync EBUSY'), { code: 'EBUSY' }) });
  assert.throws(
    () => extractManifest({ xlsx: 'a.xlsx', outputDir: 'out', python: 'py', spawnImpl: impl }),
    /XLSX extraction failed: spawn failed: EBUSY/u,
  );
});
