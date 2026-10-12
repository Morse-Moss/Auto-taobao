import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { collectCodeFingerprint, isValidCodeFingerprintShape } from './code-fingerprint.mjs';

// 本仓本身就是一个 git 仓库 ⇒ 在这里采集应当拿得到真值（字段类型对得上即可，
// 具体值随仓库状态漂，钉死反而脆）。
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

test('在 git 仓库里采集：三字段类型齐、gitHead 是 40 hex', () => {
  const fp = collectCodeFingerprint({ cwd: REPO_ROOT });
  assert.match(fp.gitHead, /^[0-9a-f]{40}$/u, 'gitHead 应是 40 hex 提交号');
  assert.ok(Number.isInteger(fp.dirtyCount) && fp.dirtyCount >= 0, 'dirtyCount 应是非负整数');
  if (fp.dirtyCount > 0) {
    assert.match(fp.dirtySha256, /^[0-9a-f]{64}$/u, '有脏文件时 dirtySha256 应是 64 hex');
  }
  assert.equal(isValidCodeFingerprintShape(fp), true, '真值必须过形状判据');
});

test('不在 git 仓库里采集：三字段全 null、绝不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `code-fp-nogit-${crypto.randomUUID().slice(0, 8)}-`));
  try {
    const fp = collectCodeFingerprint({ cwd: dir });
    assert.deepEqual(fp, { gitHead: null, dirtyCount: null, dirtySha256: null },
      '采集失败的字段各归各的 null，不许抛错把链拖死');
    assert.equal(isValidCodeFingerprintShape(fp), true, '全 null 也是合法形状');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('形状判据：半截与坏形状都要拒', () => {
  assert.equal(isValidCodeFingerprintShape(null), false);
  assert.equal(isValidCodeFingerprintShape('x'), false);
  assert.equal(isValidCodeFingerprintShape({ gitHead: 'a'.repeat(40) }), false, '缺字段＝半截指纹');
  assert.equal(isValidCodeFingerprintShape({ gitHead: 'short', dirtyCount: 0, dirtySha256: null }), false, 'gitHead 非 40 hex');
  assert.equal(isValidCodeFingerprintShape({ gitHead: null, dirtyCount: -1, dirtySha256: null }), false, '负数 dirtyCount');
  assert.equal(isValidCodeFingerprintShape({ gitHead: null, dirtyCount: 0, dirtySha256: 'zz' }), false, 'dirtySha256 非 64 hex');
  assert.equal(isValidCodeFingerprintShape({ gitHead: null, dirtyCount: null, dirtySha256: null }), true, '全 null 合法');
});

test('同一工作区两次采集指纹一致（稳定性）', () => {
  const a = collectCodeFingerprint({ cwd: REPO_ROOT });
  const b = collectCodeFingerprint({ cwd: REPO_ROOT });
  assert.deepEqual(a, b, 'porcelain 排序后哈希 ⇒ 同一快照两次采集必须一致，否则对账无从谈起');
});
