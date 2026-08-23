import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildWindowsClipboardCommand,
  captureClipboard,
  persistSkuClipboardCapture,
} from './capture-xws-sku-payload.mjs';

async function authReadyFile(directory, source) {
  const filePath = path.join(directory, 'auth-ready.json');
  await writeFile(filePath, JSON.stringify({
    version: 'xws-sku-auth-preflight-v1',
    checkedAt: new Date().toISOString(),
    status: 'AUTH_READY',
    source,
  }));
  return filePath;
}

test('requests UTF-8 output from Windows PowerShell before reading the clipboard', () => {
  const command = buildWindowsClipboardCommand();
  assert.match(command, /\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8/u);
  assert.match(command, /Get-Clipboard\s+-Raw/u);
});

test('stores the copied SKU payload separately from its safe receipt', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-capture-'));
  const rawPayload = 'SKU A: 1.2m';
  const capture = await persistSkuClipboardCapture({
    outputDirectory,
    rawPayload,
    metadata: { recordId: 'recSkuProbe', productId: '1053695212757' },
    capturedAt: '2026-08-21T08:00:00.000Z',
  });

  assert.equal(await readFile(capture.payloadPath, 'utf8'), rawPayload);
  const receiptText = await readFile(capture.receiptPath, 'utf8');
  assert.match(receiptText, /1053695212757/u);
  assert.doesNotMatch(receiptText, /SKU A: 1\.2m/u);
  assert.equal(capture.sha256.length, 64);
});

test('rejects an empty clipboard payload', async () => {
  await assert.rejects(
    persistSkuClipboardCapture({
      outputDirectory: os.tmpdir(),
      rawPayload: '',
      metadata: { recordId: 'recSkuProbe', productId: '1053695212757' },
    }),
    /clipboard payload is empty/u,
  );
});

test('captures the clipboard once, validates source metadata, and persists a hash-bound batch index', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-capture-cli-'));
  const authStatusFile = await authReadyFile(outputDirectory, {
    mainRecordId: 'recSkuProbe',
    productId: '1038622504551',
  });
  const capture = await captureClipboard({
    outputDirectory,
    authStatusFile,
    capturedAt: '2026-08-23T03:00:00.000Z',
    metadata: {
      recordId: 'recSkuProbe',
      productId: '1038622504551',
      productUrl: 'https://item.taobao.com/item.htm?id=1038622504551',
      classification: 'A-高销量高GMV竞品',
      validity: '是',
      copiedItem: 'SKU',
      copyFeedback: '已复制',
    },
    readClipboard: async () => 'SKU B: 2.4m',
  });

  assert.equal(capture.sha256.length, 64);
  const index = JSON.parse(await readFile(capture.batchIndexPath, 'utf8'));
  assert.equal(index.version, 'xws-sku-batch-index-v1');
  assert.equal(index.source.productId, '1038622504551');
  assert.equal(index.artifacts.payload, path.basename(capture.payloadPath));
  assert.equal(index.artifacts.captureReceipt, path.basename(capture.receiptPath));
  assert.doesNotMatch(await readFile(capture.batchIndexPath, 'utf8'), /SKU B: 2\.4m/u);
});

test('rejects clipboard capture without the copy confirmation or source identity', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-capture-reject-'));
  const authStatusFile = await authReadyFile(outputDirectory, {
    mainRecordId: 'recSkuProbe',
    productId: '1038622504551',
  });
  await assert.rejects(
    captureClipboard({
      outputDirectory,
      authStatusFile,
      metadata: { recordId: 'recSkuProbe', productId: '1038622504551', copyFeedback: '' },
      readClipboard: async () => 'non-empty',
    }),
    /copyFeedback must confirm/u,
  );
});

test('rejects clipboard capture when the preflight source is missing or not ready', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-capture-auth-'));
  await assert.rejects(
    captureClipboard({
      outputDirectory,
      metadata: { recordId: 'recSkuProbe', productId: '1038622504551', copyFeedback: '已复制' },
      readClipboard: async () => 'non-empty',
    }),
    /authStatusFile is required/u,
  );
});

test('rejects a stale auth preflight before reading the clipboard', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-capture-stale-auth-'));
  const authStatusFile = path.join(outputDirectory, 'auth-stale.json');
  await writeFile(authStatusFile, JSON.stringify({
    version: 'xws-sku-auth-preflight-v1',
    checkedAt: '2020-01-01T00:00:00.000Z',
    status: 'AUTH_READY',
    source: { mainRecordId: 'recSkuProbe', productId: '1038622504551' },
  }));
  await assert.rejects(
    captureClipboard({
      outputDirectory,
      authStatusFile,
      metadata: { recordId: 'recSkuProbe', productId: '1038622504551', copyFeedback: '已复制' },
      readClipboard: async () => { throw new Error('clipboard should not be read'); },
    }),
    /auth preflight is stale/u,
  );
});
