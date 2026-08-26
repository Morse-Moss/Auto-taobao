import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAuthStatus,
  buildOperatorAlert,
  classifyAuthSnapshot,
  parsePreflightArgs,
  runAuthPreflight,
} from './xws-sku-auth-preflight.mjs';

test('classifies the observed Xiaowangshen login wall before any click', () => {
  const result = classifyAuthSnapshot({
    pageProductId: '1059970355633',
    pluginPresent: true,
    skuControlPresent: true,
    loginMarkers: ['XWS_LOGIN'],
    visibleLoginDialog: false,
  }, '1059970355633');

  assert.equal(result.status, 'AUTH_REQUIRED');
  assert.deepEqual(result.loginMarkers, ['XWS_LOGIN']);
});

test('classifies a product page with the plugin control and no login wall as ready', () => {
  const result = classifyAuthSnapshot({
    pageProductId: '1059970355633',
    pluginPresent: true,
    skuControlPresent: true,
    loginMarkers: [],
    visibleLoginDialog: false,
  }, '1059970355633');

  assert.equal(result.status, 'AUTH_READY');
});

test('does not treat another product page as an authenticated source', () => {
  const result = classifyAuthSnapshot({
    pageProductId: '999',
    pluginPresent: true,
    skuControlPresent: true,
    loginMarkers: [],
  }, '1059970355633');

  assert.equal(result.status, 'SOURCE_MISMATCH');
});

test('builds sanitized status and operator alert artifacts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-auth-'));
  const source = {
    mainRecordId: 'recMain',
    productId: '1059970355633',
    productUrl: 'https://item.taobao.com/item.htm?id=1059970355633',
    classification: 'A-爆款竞品',
    validity: '是',
  };
  const status = buildAuthStatus({
    checkedAt: '2026-08-23T04:00:00.000Z',
    source,
    targetUrl: source.productUrl,
    snapshot: { pageProductId: source.productId, pluginPresent: true, skuControlPresent: true, loginMarkers: ['XWS_LOGIN'] },
    classification: { status: 'AUTH_REQUIRED', reason: 'Xiaowangshen login is required', loginMarkers: ['XWS_LOGIN'] },
  });
  const statusPath = path.join(directory, 'auth-status.json');
  const alert = buildOperatorAlert({
    checkedAt: '2026-08-23T04:00:00.000Z',
    source,
    statusPath,
    reason: status.reason,
  });

  assert.equal(status.version, 'xws-sku-auth-preflight-v1');
  assert.equal(status.status, 'AUTH_REQUIRED');
  assert.equal(alert.type, 'XWS_LOGIN_REQUIRED');
  assert.equal(alert.evidence.authStatusFile, 'auth-status.json');
  assert.doesNotMatch(JSON.stringify({ status, alert }), /cookie|token|password|Authorization/iu);
  await readFile(statusPath).catch(() => undefined);
});

test('requires source identity and output directory', () => {
  assert.throws(
    () => parsePreflightArgs(['--product-id', '1']),
    /--product-url is required/u,
  );
  const options = parsePreflightArgs([
    '--product-id', '1',
    '--product-url', 'https://item.taobao.com/item.htm?id=1',
    '--record-id', 'recMain',
    '--classification', 'A-爆款竞品',
    '--validity', '是',
    '--output-directory', 'D:/tmp/batch',
  ]);
  assert.equal(options.productId, '1');
  assert.equal(options.proxy, 'http://127.0.0.1:3456');
});

test('writes and deduplicates an AUTH_REQUIRED operator alert without external notification', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-auth-alert-'));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/targets') {
      response.end(JSON.stringify([{ targetId: 'target-1', type: 'page', url: 'https://detail.tmall.com/item.htm?id=1059970355633' }]));
      return;
    }
    response.end(JSON.stringify({ value: {
      pageProductId: '1059970355633',
      pluginPresent: true,
      skuControlPresent: true,
      loginMarkers: ['XWS_LOGIN'],
      visibleLoginDialog: false,
    } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const options = {
    proxy: `http://127.0.0.1:${address.port}`,
    productId: '1059970355633',
    productUrl: 'https://item.taobao.com/item.htm?id=1059970355633',
    recordId: 'recMain',
    classification: 'A-爆款竞品',
    validity: '是',
    outputDirectory: directory,
    checkedAt: new Date().toISOString(),
  };
  try {
    await assert.rejects(runAuthPreflight(options), (error) => error.code === 'HUMAN_REQUIRED');
    const firstAlert = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    assert.equal(firstAlert.type, 'XWS_LOGIN_REQUIRED');
    assert.equal(firstAlert.delivery.status, 'NOT_CONFIGURED');

    await assert.rejects(runAuthPreflight(options), (error) => error.code === 'HUMAN_REQUIRED');
    const secondAlert = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    assert.equal(secondAlert.delivery.status, 'DEDUPED');
    assert.equal(secondAlert.delivery.previousAlertId, firstAlert.alertId);
    const index = JSON.parse(await readFile(path.join(directory, 'batch-index.json'), 'utf8'));
    assert.equal(index.status, 'AUTH_REQUIRED');
    assert.equal(index.artifacts.operatorAlert, 'xws-sku-operator-alert.json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
