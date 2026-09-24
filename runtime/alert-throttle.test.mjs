// 跨轮告警去重的用例（2026-09-24 随模块抽出而建）。
//
// 原先这几条住在 `run-multi-shop-day.test.mjs` 里（判据当时也住在那个驱动里）。
// 搬出来一起走的理由：判据现在被**两条链**共用（日报链 `daily-round-<日>`、
// 跑前登录守卫 `sycm-login-round-<日>`），而这两条链会**写同一个状态文件** ——
// 那件事只有在这一层才测得到。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALERT_THROTTLE_FILE, readAlertThrottle, readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle,
} from './alert-throttle.mjs';

const tmpThrottle = () => path.join(mkdtempSync(path.join(tmpdir(), 'sycm-alert-throttle-')), 'alert-throttle.json');

test('默认状态文件落在 runtime/ 下（不进 git 的本机运行状态）', () => {
  assert.match(ALERT_THROTTLE_FILE.replaceAll('\\', '/'), /\/runtime\/alert-throttle\.json$/u);
});

test('告警去重：同一条编号在时间窗内不重复发，但「停的地方变了」算新信息', () => {
  const now = new Date('2026-09-20T03:00:00Z');
  const previous = { alertId: 'daily-round-20260919', fingerprint: 'SHOP_LEVEL|里可林淘宝@sycm-date', sentAt: '2026-09-20T02:00:00Z' };

  // 核心动机不是「少收几条」，而是**别把这个通道训练成噪音** —— 它是唯一会叫人动手的通道。
  const same = resolveAlertDedup({ previous, alertId: 'daily-round-20260919', fingerprint: previous.fingerprint, now });
  assert.equal(same.send, false, '一小时前刚发过同样一条，不该再发');
  assert.ok(same.reason, '不发也要有一句人看得懂的原因');

  const moved = resolveAlertDedup({ previous, alertId: 'daily-round-20260919', fingerprint: 'SHOP_LEVEL|里可林淘宝@push', now });
  assert.equal(moved.send, true, '同一个编号、但这次停在别的地方 —— 是新信息，不该被当成重复挡掉');

  assert.equal(resolveAlertDedup({ previous: null, alertId: 'daily-round-20260919', fingerprint: 'x', now }).send, true,
    '没发过就发');
  assert.equal(resolveAlertDedup({ previous, alertId: 'daily-round-20260918', fingerprint: 'x', now }).send, true,
    '换了一天就是另一条');
  assert.equal(resolveAlertDedup({ previous, alertId: null, fingerprint: 'x', now }).send, true, '没有编号就不去重（宁可多发）');

  const later = new Date('2026-09-20T09:00:00Z');
  assert.equal(resolveAlertDedup({ previous, alertId: 'daily-round-20260919', fingerprint: previous.fingerprint, now: later }).send, true,
    '过了时间窗就允许再发一次');
  // 时间读不懂时**宁可发**：沉默的代价比多收一条大
  assert.equal(resolveAlertDedup({ previous: { ...previous, sentAt: '看不懂' }, alertId: 'daily-round-20260919', fingerprint: previous.fingerprint, now }).send, true);
  assert.equal(resolveAlertDedup({ previous: { ...previous, sentAt: '2026-09-20T05:00:00Z' }, alertId: 'daily-round-20260919', fingerprint: previous.fingerprint, now }).send, true,
    '记录的时间在未来（时钟回拨/手改过），不当作「刚发过」');
});

test('读记录：按编号取，不读文件顶层 —— 顶层那条可能是**另一条链**刚写的', () => {
  const file = tmpThrottle();
  writeAlertThrottle({ alertId: 'daily-round-20260924', fingerprint: 'ROUND', sentAt: '2026-09-24T01:00:00.000Z' }, file);
  writeAlertThrottle({ alertId: 'sycm-login-round-20260924', fingerprint: 'LOGIN', sentAt: '2026-09-24T02:00:00.000Z' }, file);

  // 顶层是后写的那条（保持既有读法可见），但按编号取必须各拿各的。
  assert.equal(readAlertThrottle(file).alertId, 'sycm-login-round-20260924');
  assert.equal(readAlertThrottleEntry({ file, alertId: 'sycm-login-round-20260924' })?.fingerprint, 'LOGIN');
  assert.equal(readAlertThrottleEntry({ file, alertId: 'daily-round-20260924' })?.fingerprint, 'ROUND',
    '后写的那条**不能**把先写那条的（编号、指纹、时间）覆盖掉 —— 覆盖的后果是「去重只在相邻两次同编号时才生效」');

  // 「这个编号之前没发过」与「别的编号发过」必须能分开：认成后者会让新编号第一次就被挡。
  assert.equal(readAlertThrottleEntry({ file, alertId: 'daily-round-20260923' }), null);
  assert.equal(readAlertThrottleEntry({ file, alertId: null })?.alertId, 'sycm-login-round-20260924',
    '不给编号时退回顶层那条（旧口径）');
});

test('读记录：旧格式（顶层单条、没有 byAlertId）仍能读出来', () => {
  const file = tmpThrottle();
  writeFileSync(file, JSON.stringify({ alertId: 'daily-round-20260919', fingerprint: 'SHOP_LEVEL|x', sentAt: '2026-09-20T02:00:00.000Z' }), 'utf8');
  assert.equal(readAlertThrottleEntry({ file, alertId: 'daily-round-20260919' })?.sentAt, '2026-09-20T02:00:00.000Z');
  // 顶层是别家编号 ⇒ 对本编号等于「没发过」（否则新编号第一次发会被误挡）
  assert.equal(readAlertThrottleEntry({ file, alertId: 'sycm-login-round-20260924' }), null);
});

test('读记录：文件不存在或内容坏了，一律当「没发过」（宁可多发）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sycm-alert-throttle-'));
  assert.equal(readAlertThrottleEntry({ file: path.join(dir, '不存在.json'), alertId: 'x' }), null);
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{不是 JSON', 'utf8');
  assert.equal(readAlertThrottleEntry({ file: broken, alertId: 'x' }), null);
  assert.equal(readAlertThrottle(broken), null);
});

test('写记录：两条链共用同一个文件时，各自的记录都留得住', () => {
  const file = tmpThrottle();
  const now = new Date('2026-09-24T03:00:00Z');
  const login = { alertId: 'sycm-login-round-20260924', fingerprint: 'LOGIN|里可林淘宝:sycm', sentAt: now.toISOString() };
  writeAlertThrottle(login, file);
  // 日报链接着写自己那条（同一天、不同编号）
  writeAlertThrottle({ alertId: 'daily-round-20260924', fingerprint: 'SHOP_LEVEL|网林天猫@push', sentAt: now.toISOString() }, file);

  // 登录链的第二次判定仍能拿到自己那条 ⇒ 才可能被正确挡掉（这就是本次抽模块要保住的性质）
  const judged = resolveAlertDedup({
    previous: readAlertThrottleEntry({ file, alertId: login.alertId }),
    alertId: login.alertId, fingerprint: login.fingerprint, now: new Date('2026-09-24T03:10:00Z'),
  });
  assert.equal(judged.send, false, '同一天同一条登录告警不该因为「别条链刚发过」而重复发出去');
  // 顶层仍保留最近一次发送的字段（既有读法不许被改坏）
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.alertId, 'daily-round-20260924');
  assert.ok(raw.byAlertId['sycm-login-round-20260924'], 'byAlertId 里要留着登录链那条');
});
