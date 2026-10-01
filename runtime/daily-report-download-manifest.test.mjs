import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDownloadManifest, writeDownloadManifest } from './daily-report-download-manifest.mjs';

test('日报下载 manifest 记录归属、大小、mtime 和 sha256', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-report-manifest-'));
  const file = path.join(dir, '日报_20261001_abcd.xlsx');
  writeFileSync(file, 'sample report', 'utf8');
  const manifest = buildDownloadManifest({ filePath: file, reportType: 'shop-report', date: '2026-10-01', shop: '盖文淘宝', member: '盖文旗舰店:小瓜', observedAt: new Date('2026-10-01T02:00:00Z') });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.fileName, '日报_20261001_abcd.xlsx');
  assert.equal(manifest.bytes, 13);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.shop, '盖文淘宝');
});

test('日报下载 manifest 写入后可直接回读', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-report-manifest-'));
  const file = path.join(dir, '营销场景报表_20261001_101755.zip');
  const output = path.join(dir, 'promotion-report-manifest.json');
  writeFileSync(file, 'zip payload', 'utf8');
  writeDownloadManifest({ outputPath: output, filePath: file, reportType: 'promotion-report', date: '2026-10-01', shop: '盖文淘宝' });
  const parsed = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(parsed.reportType, 'promotion-report');
  assert.equal(parsed.fileName, path.basename(file));
});
