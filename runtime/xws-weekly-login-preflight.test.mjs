// 周报竞品链登录态预检的离线测试。判据方向：登录墙要 fail-closed（拦＋叫人），
// 「读不到」不许冒充通过也不许冒充登录墙（两个方向的假绿都要挡）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ALERT_BY_STATUS,
  LOGIN_STATES,
  buildLoginAlert,
  classifyLoginTargets,
  deliverLoginAlert,
  parsePreflightArgs,
  persistLoginAlert,
  resolveLoginAlert,
  runLoginPreflight,
  shouldAbortForLogin,
} from './xws-weekly-login-preflight.mjs';

// 页签形状与 2026-10-14 买家浏览器实测一致（两个登录墙 + about:blank + 淘宝首页）。
const WALL_TAB = { type: 'page', targetId: 'tab-wall-1', url: 'https://xiaowangshen.com/user/base-login/?login_source=gzh', title: '用户登录' };
const WALL_TAB_2 = { type: 'page', targetId: 'tab-wall-2', url: 'https://xiaowangshen.com/user/base-login/?login_source=gzh', title: '用户登录' };
const ACCOUNT_TAB = { type: 'page', targetId: 'tab-account-1', url: 'https://xiaowangshen.com/user/base-login/', title: '个人中心' };
const TAOBAO_TAB = { type: 'page', targetId: 'tab-taobao', url: 'https://www.taobao.com/', title: '淘宝' };
const WALL_TEXT = '淘系版 首页 购买 登录 / 注册 登录 还没账号？注册 打开微信扫一扫 关注公众号登录/注册 账号';
const ACCOUNT_TEXT = '个人中心 账号安全 普通用户 退出';

test('classifyLoginTargets: 登录墙页签 ⇒ LOGIN_REQUIRED（2026-10-14 run4 实测形状）', () => {
  const result = classifyLoginTargets({
    targets: [WALL_TAB, TAOBAO_TAB],
    texts: { 'tab-wall-1': WALL_TEXT },
  });
  assert.equal(result.status, LOGIN_STATES.LOGIN_REQUIRED);
  assert.match(result.reason, /登录墙/u);
  assert.equal(result.loginTargets[0].verdict, 'wall');
});

test('classifyLoginTargets: 已登录账号页 ⇒ READY', () => {
  const result = classifyLoginTargets({
    targets: [ACCOUNT_TAB],
    texts: { 'tab-account-1': ACCOUNT_TEXT },
  });
  assert.equal(result.status, LOGIN_STATES.READY);
  assert.equal(result.loginTargets[0].verdict, 'account');
});

test('classifyLoginTargets: 没有任何小旺神页签 ⇒ NO_XWS_TAB（不是通过，是查不出）', () => {
  const result = classifyLoginTargets({ targets: [TAOBAO_TAB], texts: {} });
  assert.equal(result.status, LOGIN_STATES.NO_XWS_TAB);
});

test('classifyLoginTargets: 残留登录墙与账号页并存时按登录墙判（fail-closed）', () => {
  const result = classifyLoginTargets({
    targets: [WALL_TAB, ACCOUNT_TAB],
    texts: { 'tab-wall-1': WALL_TEXT, 'tab-account-1': ACCOUNT_TEXT },
  });
  assert.equal(result.status, LOGIN_STATES.LOGIN_REQUIRED);
});

test('classifyLoginTargets: 登录页签读不到时不判 READY 也不判 LOGIN_REQUIRED', () => {
  const result = classifyLoginTargets({
    targets: [WALL_TAB],
    texts: { 'tab-wall-1': null },
  });
  assert.equal(result.status, LOGIN_STATES.UNVERIFIABLE);
});

test('classifyLoginTargets: /targets 读不到 ⇒ TARGETS_UNREADABLE', () => {
  const result = classifyLoginTargets({ targets: [], readable: false });
  assert.equal(result.status, LOGIN_STATES.TARGETS_UNREADABLE);
});

test('shouldAbortForLogin: 只有 LOGIN_REQUIRED 让驱动停', () => {
  assert.equal(shouldAbortForLogin(LOGIN_STATES.LOGIN_REQUIRED), true);
  for (const status of [LOGIN_STATES.READY, LOGIN_STATES.NO_XWS_TAB, LOGIN_STATES.UNVERIFIABLE, LOGIN_STATES.TARGETS_UNREADABLE, LOGIN_STATES.PROXY_UNREACHABLE]) {
    assert.equal(shouldAbortForLogin(status), false, `${status} 不该拦`);
  }
});

test('buildLoginAlert: 动作文案是人话且不带 Markdown 强调标记', () => {
  const alert = buildLoginAlert({
    checkedAt: '2026-10-14T09:00:00.000Z',
    statusPath: '/state/login-status-x.json',
    reason: '小旺神登录墙在位',
    classificationStatus: LOGIN_STATES.LOGIN_REQUIRED,
  });
  assert.equal(alert.type, 'XWS_WEEKLY_LOGIN_REQUIRED');
  assert.equal(alert.severity, 'HIGH');
  assert.match(alert.action, /扫码/u);
  assert.equal(alert.action.includes('**'), false, '飞书是纯文本，不许出现 ** 强调');
  assert.equal(alert.status, 'OPEN');
});

test('buildLoginAlert: 恢复通知是 RESOLVED 形状', () => {
  const alert = buildLoginAlert({
    checkedAt: '2026-10-14T09:00:00.000Z',
    statusPath: '/state/login-status-x.json',
    reason: 'recovered',
    alertStatus: 'RESOLVED',
  });
  assert.equal(alert.status, 'RESOLVED');
  assert.equal(alert.type, 'XWS_WEEKLY_LOGIN_RESOLVED');
  assert.equal(alert.severity, 'INFO');
});

test('deliverLoginAlert: 走 --alert-file 临时文件，不碰 stdin 管道（EBUSY 回归）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-deliver-'));
  try {
    const calls = [];
    const spawnImpl = (...args) => { calls.push(args); return { status: 0, stdout: '{"status":"SENT"}' }; };
    const receipt = deliverLoginAlert(buildLoginAlert({
      checkedAt: '2026-10-14T09:00:00.000Z', statusPath: 's.json', reason: 'r', classificationStatus: LOGIN_STATES.LOGIN_REQUIRED,
    }), { spawnImpl, tmpDir: tmp });
    assert.deepEqual(receipt, { status: 'SENT' });
    assert.equal(calls.length, 1);
    const [, argv, options] = calls[0];
    assert.ok(argv.includes('--alert-file'));
    assert.equal('input' in options, false, '不许用 input:（隐含 stdin 管道，沙箱下 EBUSY）');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    // 临时文件投递后即清。
    const alertFile = argv[argv.indexOf('--alert-file') + 1];
    assert.equal(existsSync(alertFile), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('deliverLoginAlert: spawn 自身失败（EBUSY 形状）⇒ FAILED 且带上错误码', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-deliver-'));
  try {
    const spawnImpl = () => ({ status: null, error: Object.assign(new Error('spawnSync EBUSY'), { code: 'EBUSY' }) });
    const receipt = deliverLoginAlert({ alertId: 'x' }, { spawnImpl, tmpDir: tmp });
    assert.equal(receipt.status, 'FAILED');
    assert.match(receipt.error, /EBUSY/u);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('persistLoginAlert: 同 type 同原因的 OPEN 告警第二次只记 DEDUPED，不再叫人', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-state-'));
  try {
    let calls = 0;
    const deliver = () => { calls += 1; return { status: 'SENT' }; };
    const base = {
      stateDir, statusPath: 'login-status-x.json', checkedAt: '2026-10-14T09:00:00.000Z',
      reason: '小旺神登录墙在位', classificationStatus: LOGIN_STATES.LOGIN_REQUIRED, deliver,
    };
    const first = await persistLoginAlert(base);
    assert.equal(first.alert.delivery.status, 'SENT');
    const second = await persistLoginAlert(base);
    assert.equal(second.alert.delivery.status, 'DEDUPED');
    assert.equal(calls, 1, '去重生效：同一个开放告警不允许投递两次');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveLoginAlert: READY 之后给之前的 OPEN 告警补一条恢复通知', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-state-'));
  try {
    const calls = [];
    const deliver = (alert) => { calls.push(alert.status); return { status: 'SENT' }; };
    await persistLoginAlert({
      stateDir, statusPath: 'login-status-x.json', checkedAt: '2026-10-14T09:00:00.000Z',
      reason: '小旺神登录墙在位', classificationStatus: LOGIN_STATES.LOGIN_REQUIRED, deliver,
    });
    const resolved = await resolveLoginAlert({ stateDir, statusPath: 'login-status-y.json', checkedAt: '2026-10-14T09:05:00.000Z', deliver });
    assert.ok(resolved);
    assert.equal(resolved.alert.status, 'RESOLVED');
    assert.deepEqual(calls, ['OPEN', 'RESOLVED']);
    // 没有 OPEN 旧告警时再解析一次：什么都不发。
    const again = await resolveLoginAlert({ stateDir, statusPath: 'login-status-z.json', checkedAt: '2026-10-14T09:06:00.000Z', deliver });
    assert.equal(again, undefined);
    assert.deepEqual(calls, ['OPEN', 'RESOLVED']);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runLoginPreflight: 登录墙场景 ⇒ LOGIN_REQUIRED + 告警投递 + 状态落盘', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-run-'));
  try {
    let delivered = 0;
    const result = await runLoginPreflight(
      { proxy: 'http://127.0.0.1:3457', stateDir, notifyDisabled: false },
      {
        fetchTargetsImpl: async () => [WALL_TAB, WALL_TAB_2, TAOBAO_TAB],
        readTextsImpl: async (_proxy, tabs) => Object.fromEntries(tabs.map((t) => [t.targetId, WALL_TEXT])),
        deliver: () => { delivered += 1; return { status: 'SENT' }; },
      },
    );
    assert.equal(result.status, LOGIN_STATES.LOGIN_REQUIRED);
    assert.equal(result.blocking, true);
    assert.equal(result.notification.status, 'SENT');
    assert.equal(delivered, 1);
    assert.match(result.action, /扫码/u);
    const statusFile = path.join(stateDir, result.statusPath);
    assert.ok(existsSync(statusFile));
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(persisted.loginTargets.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runLoginPreflight: --no-notify 是显式静音，告警只记 MUTED 不起进程', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-run-'));
  try {
    const result = await runLoginPreflight(
      { proxy: 'http://127.0.0.1:3457', stateDir, notifyDisabled: true },
      {
        fetchTargetsImpl: async () => [WALL_TAB],
        readTextsImpl: async (_proxy, tabs) => Object.fromEntries(tabs.map((t) => [t.targetId, WALL_TEXT])),
      },
    );
    assert.equal(result.status, LOGIN_STATES.LOGIN_REQUIRED);
    assert.deepEqual(result.notification, { status: 'MUTED' });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runLoginPreflight: 代理读不到 ⇒ PROXY_UNREACHABLE，非阻断不叫人', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'weekly-login-run-'));
  try {
    let delivered = 0;
    const result = await runLoginPreflight(
      { proxy: 'http://127.0.0.1:3457', stateDir, notifyDisabled: false },
      {
        fetchTargetsImpl: async () => { throw new Error('fetch failed'); },
        deliver: () => { delivered += 1; return { status: 'SENT' }; },
      },
    );
    assert.equal(result.status, LOGIN_STATES.PROXY_UNREACHABLE);
    assert.equal(result.blocking, false);
    assert.equal(delivered, 0, '读不到不叫人（拿「查不出」告警就是轰炸）');
    assert.equal(result.notification, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('parsePreflightArgs: --no-notify 显式静音；未知名参数直接拒', () => {
  const options = parsePreflightArgs(['--proxy', 'http://127.0.0.1:9999', '--no-notify']);
  assert.equal(options.notifyDisabled, true);
  assert.equal(options.proxy, 'http://127.0.0.1:9999');
  // 默认（不显式静音）＝ 出事就叫人的。
  assert.equal(parsePreflightArgs([]).notifyDisabled, false);
  assert.throws(() => parsePreflightArgs(['--bogus']), /Unknown argument/u);
});
