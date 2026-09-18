// 四层体检模块的离线用例。
//
// 这个文件守的不是「函数返回值对不对」这一层，而是几条**方向性**约束 —— 它们错了不会报错，
// 只会让体检停止工作或者开始撒谎：
//   1. 探针没读到 ≠ 有问题（读不到只能降级告警；读到了并且不对才停线）；
//   2. 未实现的层不许静默（必须点名，且不得写成通过）；
//   3. 发出的理由必须在通知判据表里表过态（否则运营收到的是「未登记的故障理由」）。
//
// 第 1、2 条各自都有**反向断言**：把判据改坏（例如把「读不到」改成 blocking）用例必须变红。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_PROFILES,
  PROJECT_PORTS,
} from './browser-ports.mjs';
import {
  HEALTH_CODES,
  HEALTH_LAYERS,
  HEALTH_REASONS,
  HEALTH_STATES,
  LAYER_IMPLEMENTATION,
  buildHealthResult,
  classifyBrowserPort,
  classifyEgress,
  classifyExpectedPages,
  createPlatformHealthCheck,
  parseEgressProxy,
} from './xws-platform-health-preflight.mjs';
import {
  NO_AUTO_RETRY_REASONS,
  missingPolicyKeys,
  resolveNotifyRule,
} from './sop-runtime/round-notify-policy.mjs';

const OUR_PROFILE = BROWSER_PROFILES.dailyReport;
const OUR_PORT = PROJECT_PORTS.dailyReportBrowser;

// 用例必须与**跑测试的那台机器**无关：下面有几条断言的是「没给探测地址时走端口探测」这条路径，
// 若这台机器恰好设了 PROJECT_EGRESS_PROBE_URL，它们就会去走真代理请求而变成随机红绿。
process.env.PROJECT_EGRESS_PROBE_URL = '';

// ---------------------------------------------------------------- 词表

test('状态词表包含 LOGIN-STATE-MANAGEMENT §4 的每一个值，且只加不删', () => {
  // 用「包含」而不是「相等」：相等会让新增状态必须改测试（于是有人直接把测试里的清单也删了），
  // 包含则只拦住「悄悄删掉一个已有状态」。
  for (const state of [
    'AUTH_READY', 'AUTH_EXPIRING', 'AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'RISK_BLOCKED',
    'PLUGIN_UNAVAILABLE', 'PLUGIN_NOT_READY', 'SOURCE_MISMATCH', 'AUTH_UNKNOWN',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(HEALTH_STATES, state), `缺少状态 ${state}`);
  }
});

test('NOT_IMPLEMENTED 与 AUTH_UNKNOWN 必须是两个值', () => {
  // 合成一个值会让「我们还没做过这项检查」看起来像「检查发现有问题」，
  // 或者反过来 —— 让「判据读不出来」看起来像「功能还没做」，两种都会误导处置。
  assert.notEqual(HEALTH_STATES.NOT_IMPLEMENTED, HEALTH_STATES.AUTH_UNKNOWN);
});

test('未实现的层必须写清卡在哪，不许留空', () => {
  for (const [layer, value] of Object.entries(LAYER_IMPLEMENTATION)) {
    if (value.implemented) {
      assert.equal(value.blockedBy, null, `${layer} 已实现，不该再有 blockedBy`);
      continue;
    }
    assert.equal(typeof value.blockedBy, 'string', `${layer} 未实现却没写原因`);
    assert.ok(value.blockedBy.trim().length > 20, `${layer} 的 blockedBy 太短，等于没写`);
  }
});

test('L1 环境层已实现；L0/L2/L3 尚未（本轮的事实，不许被顺手改成已实现）', () => {
  assert.equal(LAYER_IMPLEMENTATION[HEALTH_LAYERS.ENVIRONMENT].implemented, true);
  assert.equal(LAYER_IMPLEMENTATION[HEALTH_LAYERS.IDENTITY].implemented, false);
  assert.equal(LAYER_IMPLEMENTATION[HEALTH_LAYERS.SESSION].implemented, false);
  assert.equal(LAYER_IMPLEMENTATION[HEALTH_LAYERS.END_TO_END].implemented, false);
});

// ---------------------------------------------------------------- L1 浏览器与 profile 身份

test('profile 对得上 ⇒ 这一项没有结论（返回 null，不产生 finding）', () => {
  const finding = classifyBrowserPort({
    inspection: { status: 'occupied', profile: OUR_PROFILE },
    expectedProfile: OUR_PROFILE,
    port: OUR_PORT,
  });
  assert.equal(finding, null);
});

test('端口没人监听 ⇒ 停线，理由是「调试端口不可用」', () => {
  const finding = classifyBrowserPort({ inspection: { status: 'free' }, expectedProfile: OUR_PROFILE, port: OUR_PORT });
  assert.equal(finding.code, HEALTH_CODES.CDP_ENDPOINT_MISSING);
  assert.equal(finding.blocking, true);
  assert.equal(finding.reason, HEALTH_REASONS.BROWSER_DEBUG_PORT);
});

test('端口被别的东西占着（在监听但不是 CDP）⇒ 停线', () => {
  const finding = classifyBrowserPort({
    inspection: { status: 'occupied-unidentified' },
    expectedProfile: OUR_PROFILE,
    port: OUR_PORT,
  });
  assert.equal(finding.code, HEALTH_CODES.CDP_ENDPOINT_UNIDENTIFIED);
  assert.equal(finding.blocking, true);
});

test('读出来是**别人的** profile ⇒ 停线（这是正面证据，不是猜的）', () => {
  const finding = classifyBrowserPort({
    inspection: { status: 'occupied', profile: BROWSER_PROFILES.competitor },
    expectedProfile: OUR_PROFILE,
    port: OUR_PORT,
  });
  assert.equal(finding.code, HEALTH_CODES.BROWSER_PROFILE_FOREIGN);
  assert.equal(finding.blocking, true);
});

test('CDP 连得上但读不出 profile ⇒ **不停线**（读不到不等于有问题）', () => {
  const finding = classifyBrowserPort({
    inspection: { status: 'occupied', profile: null },
    expectedProfile: OUR_PROFILE,
    port: OUR_PORT,
  });
  assert.equal(finding.code, HEALTH_CODES.BROWSER_PROFILE_UNREADABLE);
  // 反向断言：把这条改成 blocking 会让一次网络抖动变成一次停线事故（见 browser-ports.classifyPortUsage 的注释）。
  assert.equal(finding.blocking, false);
});

// ---------------------------------------------------------------- L1 目标页面

const PAGES = [{ name: '生意参谋', urlFragment: 'sycm.taobao.com/qos/service/frame/shop/performance' }];

test('目标页面恰好一个 ⇒ 通过', () => {
  const findings = classifyExpectedPages({
    targets: [{ type: 'page', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' }],
    expectedPages: PAGES,
  });
  assert.deepEqual(findings, []);
});

test('目标页面不在 ⇒ 停线', () => {
  const findings = classifyExpectedPages({ targets: [{ type: 'page', url: 'https://www.taobao.com/' }], expectedPages: PAGES });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, HEALTH_CODES.TARGET_PAGE_MISSING);
  assert.equal(findings[0].blocking, true);
  assert.equal(findings[0].reason, HEALTH_REASONS.TARGET_PAGE_MISSING);
});

test('目标页面多于一个 ⇒ 停线（认页面靠的是「恰好一个」）', () => {
  const findings = classifyExpectedPages({
    targets: [
      { type: 'page', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/a' },
      { type: 'page', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/b' },
    ],
    expectedPages: PAGES,
  });
  assert.equal(findings[0].code, HEALTH_CODES.TARGET_PAGE_AMBIGUOUS);
  assert.equal(findings[0].blocking, true);
});

test('读不到页面清单 ≠ 页面不在（两件事的处置不同，不能合并）', () => {
  const findings = classifyExpectedPages({ targets: [], expectedPages: PAGES, readable: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, HEALTH_CODES.TARGET_PAGE_UNREADABLE);
  assert.notEqual(findings[0].code, HEALTH_CODES.TARGET_PAGE_MISSING);
  assert.equal(findings[0].blocking, false);
});

test('没声明期望页面就不产生结论（不假装检查过）', () => {
  assert.deepEqual(classifyExpectedPages({ targets: [], expectedPages: [] }), []);
  assert.deepEqual(classifyExpectedPages({ targets: [], expectedPages: undefined }), []);
});

// ---------------------------------------------------------------- L1 出网路径

test('声明了出网代理且连得上 ⇒ 通过', () => {
  assert.equal(classifyEgress({ declaration: { host: '127.0.0.1', port: 7897 }, reachable: true }), null);
});

test('端口能连、但没拿它真发过一次代理请求 ⇒ 报「未证明」，不停线', () => {
  // 绿必须能被证明：任何服务占着那个端口都会让 TCP 探测通过。这条要显式不阻断，
  // 但缺口必须可见 —— 否则「检查过了」这句话没有依据。
  const finding = classifyEgress({
    declaration: { host: '127.0.0.1', port: 7897 },
    reachable: true,
    verified: false,
  });
  assert.equal(finding.code, HEALTH_CODES.EGRESS_PROXY_UNVERIFIED);
  assert.equal(finding.blocking, false);
  assert.match(finding.detail, /没有被证明/);
});

test('拿它真的发过一次代理请求并读到状态行 ⇒ 才是通过', () => {
  assert.equal(classifyEgress({
    declaration: { host: '127.0.0.1', port: 7897 },
    reachable: true,
    verified: true,
  }), null);
});

test('声明了出网代理但连不上 ⇒ 停线，且理由能直接落到判定表', () => {
  const finding = classifyEgress({ declaration: { host: '127.0.0.1', port: 7897 }, reachable: false });
  assert.equal(finding.code, HEALTH_CODES.EGRESS_PROXY_UNREACHABLE);
  assert.equal(finding.blocking, true);
  assert.equal(finding.reason, HEALTH_REASONS.EGRESS_PROXY_UNREACHABLE);
  assert.equal(resolveNotifyRule(finding.reason)?.plan, 'NOTIFY');
});

test('没声明出网代理 ⇒ 报缺口但不停线（缺口本身要可见，不能静默）', () => {
  const finding = classifyEgress({ declaration: null, reachable: null });
  assert.equal(finding.code, HEALTH_CODES.EGRESS_PROXY_NOT_DECLARED);
  assert.equal(finding.blocking, false);
  // 理由为 null 是刻意的：它是「没声明」而不是某条已登记故障。因为它不停线，
  // 所以不会被当成本轮结论拿去查判定表（round-runner 只在 blocking 里取 reason）。
  assert.equal(finding.reason, null);
});

test('探针自身出错 ⇒ 不停线，但结论是「没拿到」而不是「通」', () => {
  const finding = classifyEgress({ declaration: { host: '127.0.0.1', port: 7897 }, reachable: null });
  assert.equal(finding.code, HEALTH_CODES.EGRESS_PROXY_UNREADABLE);
  assert.equal(finding.blocking, false);
  assert.match(finding.detail, /得不到结论/);
});

test('出网代理的声明解析：只认 host:port，认不出来就当没声明（不猜端口）', () => {
  assert.deepEqual(parseEgressProxy('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.deepEqual(parseEgressProxy('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.equal(parseEgressProxy('  '), null);
  assert.equal(parseEgressProxy('http://127.0.0.1'), null);
  assert.equal(parseEgressProxy('127.0.0.1:99999'), null);
});

// ---------------------------------------------------------------- 汇总方向

test('ok 的判据是「有没有 blocking」，不是「findings 是不是空」', () => {
  const warn = { blocking: false, code: 'X', layer: HEALTH_LAYERS.ENVIRONMENT };
  const block = { blocking: true, code: 'Y', layer: HEALTH_LAYERS.ENVIRONMENT };
  assert.equal(buildHealthResult([warn]).ok, true);
  assert.equal(buildHealthResult([warn]).blocking.length, 0);
  assert.equal(buildHealthResult([warn, block]).ok, false);
  assert.equal(buildHealthResult([warn, block]).blocking.length, 1);
  assert.equal(buildHealthResult([]).ok, true);
});

// ---------------------------------------------------------------- 接线（注入 IO）

function stubPort({ profile = OUR_PROFILE } = {}) {
  return async () => ({ status: 'occupied', profile });
}

test('全绿时仍要点名「哪几层没检查过」，不得让人以为四层都过了', async () => {
  const health = await createPlatformHealthCheck({
    inspectPortImpl: stubPort(),
    readTargetsImpl: async () => [{ type: 'page', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/x' }],
    probeTcpImpl: async () => true,
    expectedPages: PAGES,
    egressProxy: '127.0.0.1:7897',
  })({ businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' });

  assert.equal(health.ok, true);
  assert.match(health.note, /未实现的层/);
  assert.match(health.note, /不表示通过/);
  assert.equal(health.layers.IDENTITY, 'NOT_IMPLEMENTED');
  assert.equal(health.layers.SESSION, 'NOT_IMPLEMENTED');
  assert.equal(health.layers.ENVIRONMENT, 'CHECKED');
});

test('出网代理连不上时，blocking 里的第一条理由就是判定表能认的那条', async () => {
  const health = await createPlatformHealthCheck({
    inspectPortImpl: stubPort(),
    readTargetsImpl: async () => [],
    probeTcpImpl: async () => false,
    egressProxy: '127.0.0.1:7897',
  })({ businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' });

  assert.equal(health.ok, false);
  assert.equal(health.blocking[0].reason, HEALTH_REASONS.EGRESS_PROXY_UNREACHABLE);
  assert.match(health.note, /未通过 1 项/);
});

test('探针自己抛错 ⇒ 不停线（体检崩了不等于环境坏了）', async () => {
  const health = await createPlatformHealthCheck({
    inspectPortImpl: async () => { throw new Error('boom'); },
    readTargetsImpl: async () => [],
    probeTcpImpl: async () => true,
    egressProxy: '127.0.0.1:7897',
  })({ businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' });

  assert.equal(health.ok, true);
  assert.equal(health.findings.every((finding) => finding.blocking === false), true);
  assert.match(health.note, /不阻断的告警/);
});

test('浏览器键写错在**创建时**就抛，不留到体检跑起来才变成「体检自己崩了」', () => {
  assert.throws(() => createPlatformHealthCheck({ browserKey: 'nope' }), /unknown browser key/u);
});

test('给了探测地址就走真代理请求（不再只看端口开没开）', async () => {
  let sawUrl = null;
  let tcpCalled = false;
  const health = await createPlatformHealthCheck({
    inspectPortImpl: stubPort(),
    readTargetsImpl: async () => [],
    probeTcpImpl: async () => { tcpCalled = true; return true; },
    probeEgressProxyImpl: async ({ url }) => { sawUrl = url; return false; },
    egressProxy: '127.0.0.1:7897',
    egressProbeUrl: 'http://probe.invalid/generate_204',
  })({ businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' });

  assert.equal(sawUrl, 'http://probe.invalid/generate_204');
  assert.equal(tcpCalled, false, '两条探测路径不该同时走');
  assert.equal(health.ok, false);
  assert.equal(health.blocking[0].code, HEALTH_CODES.EGRESS_PROXY_UNREACHABLE);
});

test('代理按协议应答 ⇒ 通过；没给探测地址 ⇒ 只报「未证明」且不停线', async () => {
  const base = {
    inspectPortImpl: stubPort(),
    readTargetsImpl: async () => [],
    egressProxy: '127.0.0.1:7897',
  };
  const verified = await createPlatformHealthCheck({
    ...base,
    probeEgressProxyImpl: async () => true,
    egressProbeUrl: 'http://probe.invalid/x',
  })({ businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' });
  assert.equal(verified.ok, true);
  assert.equal(verified.findings.some((f) => f.code === HEALTH_CODES.EGRESS_PROXY_UNVERIFIED), false);

  const unverified = await createPlatformHealthCheck({ ...base, probeTcpImpl: async () => true })(
    { businessKey: 'k', now: Date.now(), dayKey: '2026-09-18' },
  );
  assert.equal(unverified.ok, true);
  assert.equal(unverified.findings.some((f) => f.code === HEALTH_CODES.EGRESS_PROXY_UNVERIFIED), true);
});

// ---------------------------------------------------------------- 与通知判据表的对齐

test('体检会发出的每个理由都已在判定表里表态', () => {
  const missing = missingPolicyKeys(Object.values(HEALTH_REASONS));
  assert.deepEqual(missing, [], `没在判定表里表态的理由：${missing.join(', ')}`);
});

test('体检的两个新理由都允许自动重试（人修完就该继续，不该等人再点一次）', () => {
  for (const reason of [HEALTH_REASONS.EGRESS_PROXY_UNREACHABLE, HEALTH_REASONS.TARGET_PAGE_MISSING]) {
    const rule = resolveNotifyRule(reason);
    assert.equal(rule.plan, 'NOTIFY');
    assert.equal(typeof rule.title, 'string');
    assert.ok(rule.title.length > 0, `${reason} 的通知标题是空的`);
    assert.ok(rule.nextAction.length > 0, `${reason} 没写「下一步做什么」`);
    assert.equal(NO_AUTO_RETRY_REASONS.includes(reason), false);
  }
});

test('复用的既有理由 BROWSER_DEBUG_PORT 也在表里（复用也要表过态）', () => {
  assert.equal(resolveNotifyRule(HEALTH_REASONS.BROWSER_DEBUG_PORT)?.plan, 'NOTIFY');
});
