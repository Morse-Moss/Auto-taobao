import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROJECT_PORTS } from './browser-ports.mjs';
import { TITLE_BY_TYPE } from './notify-feishu-core.mjs';

import {
  ALERT_BY_STATUS,
  ALERTING_STATUSES,
  buildAuthStatus,
  buildOperatorAlert,
  classifyAuthSnapshot,
  notifyTargetForPath,
  parsePreflightArgs,
  resolveNotifyTarget,
  runAuthPreflight,
} from './xws-sku-auth-preflight.mjs';

// 必填参数的最小集合。多个用例共用一份，免得每处各抄一遍、抄漏一个就变成另一条用例在测别的东西。
const REQUIRED_ARGS = [
  '--product-id', '1059970355633',
  '--product-url', 'https://item.taobao.com/item.htm?id=1059970355633',
  '--record-id', 'recMain',
  '--classification', 'A-爆款竞品',
  '--validity', '是',
  '--output-directory', 'D:/tmp/batch',
];

// 假 CDP 代理：`/targets` 与 `POST /eval` 都按传入的台本回。
// 用完必须 close（同 feishu-shared-page.test.mjs 那套写法）。
async function startFakeProxy({ targets, snapshot }) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/targets') {
      response.end(JSON.stringify(targets));
      return;
    }
    response.end(JSON.stringify({ value: snapshot }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

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

test('writes and deduplicates an AUTH_REQUIRED operator alert when notification is explicitly muted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-auth-alert-'));
  const { server, base } = await startFakeProxy({
    targets: [{ targetId: 'target-1', type: 'page', url: 'https://detail.tmall.com/item.htm?id=1059970355633' }],
    snapshot: {
      pageProductId: '1059970355633',
      pluginPresent: true,
      skuControlPresent: true,
      loginMarkers: ['XWS_LOGIN'],
      visibleLoginDialog: false,
    },
  });
  const options = {
    proxy: base,
    productId: '1059970355633',
    productUrl: 'https://item.taobao.com/item.htm?id=1059970355633',
    recordId: 'recMain',
    classification: 'A-爆款竞品',
    validity: '是',
    outputDirectory: directory,
    checkedAt: new Date().toISOString(),
    // 这条用例测的是「写告警 + 去重」，**不许真的发飞书**。
    // 2026-09-22 之前这里什么都不用给（默认就是不发 = 正是 bug 本身）；
    // 现在不发必须显式说，所以这里必须写出来——这也让「离线用例不会碰到外部世界」变成可见的。
    notifyDisabled: true,
  };
  try {
    await assert.rejects(runAuthPreflight(options), (error) => error.code === 'HUMAN_REQUIRED');
    const firstAlert = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    assert.equal(firstAlert.type, 'XWS_LOGIN_REQUIRED');
    // 静音写 MUTED，不是 NOT_CONFIGURED：后者的含义是「投递线没接上」，
    // 拿它表示「我故意不发」会把「线断了」和「按我说的别发」混成同一个值。
    assert.equal(firstAlert.delivery.status, 'MUTED');

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

// --- 2026-09-22 新增：把「卡点无人知晓」这条线接上 --------------------------
// 背景（一句话）：预检原来把 notifyCommand 留空 ⇒ 告警写进证据文件、**没有任何人会被叫到**。
// docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:124 记的「飞书未收到提醒」就是它。
// 下面这几条钉住的是「这条线还在」——少一条都可能悄悄退回去。

test('不给 --notify-command 时，默认出口就是仓库里那条投递 CLI（不是「不通知」）', () => {
  const target = resolveNotifyTarget(parsePreflightArgs(REQUIRED_ARGS));
  assert.ok(target, '默认必须有一个投递目标；返回 null 就等于「卡点无人知晓」又回来了');
  // 为什么必须是 node + 路径，而不是把 .mjs 直接当命令：
  // Windows 上 .mjs 不是可执行文件，直接 spawn 会 EINVAL。
  assert.equal(target.command, process.execPath);
  assert.equal(target.args.length, 1, '投递 CLI 是零参数契约：配置全部从飞书 profile 的 env 文件读');
  assert.match(target.args[0], /runtime[\\/]notify-feishu\.mjs$/u);
  assert.ok(existsSync(target.args[0]), '默认目标必须是真实存在的文件：指向不存在的路径 = 每轮都投递失败');
});

test('--no-notify 是显式静音，并且压过 --notify-command（「不发」必须赢）', () => {
  const muted = parsePreflightArgs([...REQUIRED_ARGS, '--no-notify', '--notify-command', 'C:/op/wrapper.cmd']);
  assert.equal(resolveNotifyTarget(muted), null, '同时给了两个时，静音必须赢：否则「明确说了不发」会变成「还是发了」');

  const wrapper = parsePreflightArgs([...REQUIRED_ARGS, '--notify-command', 'C:/op/custom.cmd']);
  assert.deepEqual(resolveNotifyTarget(wrapper), { command: 'C:/op/custom.cmd', args: [] });
  assert.throws(() => parsePreflightArgs(['--no-notify=true']), /Unknown argument/u, '旗标不接受 =值 写法');
});

test('.mjs / .js 形状的 --notify-command 自动用 node 跑（.cmd 那条兜底路是死的）', () => {
  // 实测（2026-09-22，Node 22.22.2）：`spawn('x.cmd', [], { shell: false })` **同步抛 EINVAL** ——
  // Node ≥18.20.2 的 CVE-2024-27980 加固后，.cmd/.bat 必须走 shell 才能起。
  // 所以文档里「.mjs 外面包一个 .cmd」那条建议是跑不通的，这里把 .mjs/.js 直接收进来。
  assert.deepEqual(
    notifyTargetForPath('D:/op/notify.mjs'),
    { command: process.execPath, args: ['D:/op/notify.mjs'] },
  );
  assert.deepEqual(
    notifyTargetForPath('D:/op/notify.js'),
    { command: process.execPath, args: ['D:/op/notify.js'] },
  );
  assert.deepEqual(notifyTargetForPath('D:/op/notify.exe'), { command: 'D:/op/notify.exe', args: [] });
});

test('预检能发出的每个 type 都要有人话标题（少了就是运营收到一行机器词）', () => {
  // 为什么是跨模块判据：type 在本文件定义、标题在 notify-feishu-core 的 TITLE_BY_TYPE 里。
  // 两边是同一条链的两端，只改一端**不会报任何错**，只是那条告警从此说不了人话
  // （渲染成「【需要处理】XWS_ACCOUNT_MISMATCH」）。这正是本项目最常踩的「接线断了但全绿」。
  for (const [status, entry] of Object.entries(ALERT_BY_STATUS)) {
    const title = TITLE_BY_TYPE[entry.type];
    assert.ok(title, `${status} → ${entry.type}：标题表里没有它，渲染出来第一行会是机器标识`);
    assert.doesNotMatch(title, /^[A-Z_]+$/u, `${status} 的标题不能还是大写标识`);
  }
});

test('「要叫人」的每个状态都必须有文案与动作（漏一个 = 那个状态永远发不出下一步）', () => {
  for (const status of ALERTING_STATUSES) {
    const entry = ALERT_BY_STATUS[status];
    assert.ok(entry, `${status} 在 ALERTING_STATUSES 名单里，但 ALERT_BY_STATUS 里没有它`);
    assert.ok(entry.action.length > 10, `${status} 的动作必须是一句人话，不能只报状态码`);
  }
  // AUTH_READY 不进「要叫人」名单：它是恢复态，只在 resolveAlert 里补一条「已恢复」。
  assert.equal(ALERTING_STATUSES.includes('AUTH_READY'), false);
});

test('商品页不在位也要落一条可通知的告警（原来这条路上一个告警都不产生）', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-page-missing-'));
  // 假代理里只有**别的**商品页：discoverTarget 找不到目标 ⇒ 原来直接 throw，连分类器都没进。
  const { server, base } = await startFakeProxy({
    targets: [{ targetId: 'target-other', type: 'page', url: 'https://item.taobao.com/item.htm?id=999999999999' }],
    snapshot: {},
  });
  try {
    await assert.rejects(
      runAuthPreflight({
        proxy: base,
        productId: '1059970355633',
        productUrl: 'https://item.taobao.com/item.htm?id=1059970355633',
        recordId: 'recMain',
        classification: 'A-爆款竞品',
        validity: '是',
        outputDirectory: directory,
        checkedAt: new Date().toISOString(),
        notifyDisabled: true,
      }),
      // 退出码语义不变：仍然走 stalled（CLI 层是 exit 3），caller 的分支不用改。
      (error) => error.code === 'STALLED',
    );

    const alert = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    assert.equal(alert.type, 'XWS_PAGE_UNAVAILABLE');
    assert.equal(alert.severity, 'HIGH');
    assert.match(alert.reason, /Product page target is unavailable/u, '原因要带原始报文，否则现场无从下手');
    assert.match(alert.action, /买家/u, '动作要说清去哪个账号的配置里打开');
    assert.equal(alert.delivery.status, 'MUTED');

    const names = await readdir(directory);
    const statusFile = names.find((name) => name.startsWith('xws-sku-auth-status-'));
    const status = JSON.parse(await readFile(path.join(directory, statusFile), 'utf8'));
    assert.equal(status.status, 'PAGE_UNAVAILABLE');
    assert.equal(status.source.productId, '1059970355633');
    // 「没读到页面」不许写成 `false`：`false` 的含义是「看过了，它不在」，
    // 把两者混在一起会把运营送去重装插件，而不是去把商品页打开。
    assert.equal(status.page.pluginPresent, null);
    assert.equal(status.page.skuControlPresent, null);

    const index = JSON.parse(await readFile(path.join(directory, 'batch-index.json'), 'utf8'));
    assert.equal(index.status, 'PAGE_UNAVAILABLE');
    assert.equal(index.artifacts.operatorAlert, 'xws-sku-operator-alert.json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('页面不在位的告警也去重：同一个商品同一句原因只吵一次', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-page-missing-dedup-'));
  const { server, base } = await startFakeProxy({ targets: [], snapshot: {} });
  const options = {
    proxy: base,
    productId: '1059970355633',
    productUrl: 'https://item.taobao.com/item.htm?id=1059970355633',
    recordId: 'recMain',
    classification: 'A-爆款竞品',
    validity: '是',
    outputDirectory: directory,
    checkedAt: new Date().toISOString(),
    notifyDisabled: true,
  };
  try {
    await assert.rejects(runAuthPreflight(options), (error) => error.code === 'STALLED');
    const first = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    await assert.rejects(runAuthPreflight(options), (error) => error.code === 'STALLED');
    const second = JSON.parse(await readFile(path.join(directory, 'xws-sku-operator-alert.json'), 'utf8'));
    assert.equal(first.delivery.status, 'MUTED');
    assert.equal(second.delivery.status, 'DEDUPED');
    assert.equal(second.delivery.previousAlertId, first.alertId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
