import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROJECT_PORTS } from './browser-ports.mjs';

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
  // 本项目专用 CDP 代理端口来自 runtime/browser-ports.mjs；断言对着登记表而不是写死的数字，
  // 否则改端口时测试会把旧常量固化下来（坑 34）。
  // 3456 属于另一个项目且未装小旺神，默认值不得落在那里。
  assert.equal(options.proxy, `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`);
  assert.notEqual(options.proxy, 'http://127.0.0.1:3456');
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

// --- 2026-09-16 新增：把词表里缺的两个状态补进代码 ----------------------------
// docs/ops/LOGIN-STATE-MANAGEMENT.md §4 的表格里有 AUTH_UNKNOWN 与 ACCOUNT_MISMATCH，
// 而代码里此前没有。前者还顺手修掉一个真错判：探测什么都没返回时，旧逻辑落到
// SOURCE_MISMATCH（「页面商品不对」），会把运营送去改 URL —— 而真问题是页面/代理没就绪。

test('探测读不到东西时判 AUTH_UNKNOWN，而不是怪到「页面商品不对」头上', () => {
  const readNothing = [
    null,
    {},
    { pageProductId: '1' },
    { pageProductId: '1', pluginPresent: 'true', skuControlPresent: true },
  ];
  for (const snapshot of readNothing) {
    const result = classifyAuthSnapshot(snapshot, '1');
    assert.equal(result.status, 'AUTH_UNKNOWN', `${JSON.stringify(snapshot)} 必须判成「读不到结论」`);
    assert.ok(result.unreadable.length > 0);
  }
  // 页面确实是别的商品时仍如实报 SOURCE_MISMATCH：这是流程参数问题，不是读不到。
  assert.equal(
    classifyAuthSnapshot({ pageProductId: '2', pluginPresent: true, skuControlPresent: true }, '1').status,
    'SOURCE_MISMATCH',
  );
});

test('声明了期望账号才核对身份：不同判 ACCOUNT_MISMATCH，读不到判 AUTH_UNKNOWN', () => {
  const base = { pageProductId: '1', pluginPresent: true, skuControlPresent: true, loginMarkers: [] };

  const mismatch = classifyAuthSnapshot({ ...base, accountId: '别的店铺号' }, '1', { expectedAccount: '浴缸旗舰店' });
  assert.equal(mismatch.status, 'ACCOUNT_MISMATCH');
  assert.deepEqual(mismatch.identity, { expected: '浴缸旗舰店', observed: '别的店铺号', verdict: 'MISMATCH' });
  assert.match(mismatch.reason, /别的店铺号/u);

  const unreadable = classifyAuthSnapshot(
    { ...base, accountId: '', accountReadError: 'SELECTOR_NOT_FOUND' },
    '1',
    { expectedAccount: '浴缸旗舰店' },
  );
  assert.equal(unreadable.status, 'AUTH_UNKNOWN');
  assert.equal(unreadable.identity.verdict, 'UNREADABLE');

  const matched = classifyAuthSnapshot({ ...base, accountId: '浴缸旗舰店' }, '1', { expectedAccount: '浴缸旗舰店' });
  assert.equal(matched.status, 'AUTH_READY');
  assert.equal(matched.identity.verdict, 'MATCH');

  // 没声明期望账号＝没做身份核对：状态里不许出现 MATCH（那就是假装核对过了）。
  const undeclared = classifyAuthSnapshot({ ...base, accountId: '随便' }, '1');
  assert.equal(undeclared.status, 'AUTH_READY');
  assert.equal(undeclared.identity, undefined);
});

test('身份判据必须成对声明，只给半个直接拒', () => {
  const base = [
    '--product-id', '1',
    '--product-url', 'https://item.taobao.com/item.htm?id=1',
    '--record-id', 'recMain',
    '--classification', 'A-爆款竞品',
    '--validity', '是',
    '--output-directory', 'D:/tmp/batch',
  ];
  assert.throws(() => parsePreflightArgs([...base, '--expected-account', '浴缸旗舰店']), /must be supplied together/u);
  assert.throws(() => parsePreflightArgs([...base, '--account-selector', '.nick']), /must be supplied together/u);
  const both = parsePreflightArgs([...base, '--expected-account', '浴缸旗舰店', '--account-selector', '.nick']);
  assert.equal(both.expectedAccount, '浴缸旗舰店');
  assert.equal(both.accountSelector, '.nick');
});

test('每个需要人的状态都有自己的 type 与一句「下一步做什么」', () => {
  const source = { mainRecordId: 'recMain', productId: '1' };
  const types = new Map();
  for (const status of ['AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'AUTH_UNKNOWN', 'PLUGIN_UNAVAILABLE', 'PLUGIN_NOT_READY', 'SOURCE_MISMATCH']) {
    const alert = buildOperatorAlert({
      checkedAt: '2026-09-16T00:00:00.000Z',
      source,
      statusPath: 'auth-status.json',
      reason: 'probe reason',
      classificationStatus: status,
    });
    assert.ok(alert.action.length > 10, `${status} 必须带一句人话动作，不能只报状态码`);
    types.set(status, alert.type);
  }
  // type 不能全一样：否则去重会把「登录失效」和「登错账号」判成同一件事、只通知一次。
  assert.ok(new Set(types.values()).size >= 4);
  assert.equal(types.get('AUTH_REQUIRED'), 'XWS_LOGIN_REQUIRED');
  assert.equal(types.get('ACCOUNT_MISMATCH'), 'XWS_ACCOUNT_MISMATCH');
  assert.equal(types.get('AUTH_UNKNOWN'), 'XWS_AUTH_UNKNOWN');
  // PLUGIN_* 两个状态有意共用一个 type：它们的动作是同一件事（重开浏览器）。
  assert.equal(types.get('PLUGIN_UNAVAILABLE'), types.get('PLUGIN_NOT_READY'));
});

test('状态工件带上身份判据与「读不到什么」的清单', () => {
  const status = buildAuthStatus({
    checkedAt: '2026-09-16T00:00:00.000Z',
    source: { mainRecordId: 'recMain', productId: '1' },
    targetUrl: 'https://item.taobao.com/item.htm?id=1',
    snapshot: { pageProductId: '1', pluginPresent: true, skuControlPresent: true },
    classification: {
      status: 'AUTH_UNKNOWN',
      reason: 'Account identity is unreadable',
      unreadable: ['pageProductId'],
      identity: { expected: '浴缸旗舰店', observed: null, verdict: 'UNREADABLE' },
    },
  });
  assert.equal(status.status, 'AUTH_UNKNOWN');
  assert.deepEqual(status.unreadable, ['pageProductId']);
  assert.equal(status.identity.verdict, 'UNREADABLE');
});
