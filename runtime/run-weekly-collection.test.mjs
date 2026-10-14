// 周采集驱动的离线测试。重点钉 2026-10-14 新增的起跑前登录态预检接线：
// ① 调用形状守 EBUSY 纪律；② 预检结论可解析；③ 读不到 ⇒ 非阻断放行（不冒充）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lastAdaptiveDone, parseDriverArgs, parseRanges, runLoginPreflightStep } from './run-weekly-collection.mjs';

const fakeSpawn = (result) => {
  const calls = [];
  const impl = (...args) => { calls.push(args); return result; };
  return { impl, calls };
};

test('parseRanges: START-END 形式，非法输入直接拒', () => {
  assert.deepEqual(parseRanges('1-4,5-8'), [{ id: '1-4', start: 1, end: 4 }, { id: '5-8', start: 5, end: 8 }]);
  assert.throws(() => parseRanges('4'), /START-END/u);
  assert.throws(() => parseRanges('8-5'), /不合法/u);
  assert.throws(() => parseRanges(''), /required/u);
});

test('lastAdaptiveDone: 从 stdout 里取最后一条 ADAPTIVE_DONE', () => {
  const text = [
    '{"event":"ADAPTIVE_RUN_STARTED","runId:"x"}',
    'noise',
    '{"event":"ADAPTIVE_DONE","runId":"r1","final":{"ok":true,"rows":10}}',
    '{"event":"ADAPTIVE_DONE","runId":"r2","final":{"ok":true,"rows":20}}',
  ].join('\n');
  const done = lastAdaptiveDone(text);
  assert.equal(done.runId, 'r2');
  assert.equal(done.final.rows, 20);
  assert.equal(lastAdaptiveDone('nothing here'), null);
});

test('runLoginPreflightStep: 预检入参全走 argv，stdio 守 EBUSY 纪律', () => {
  // stdout 用预检 CLI 的真实形状：pretty **多行** JSON。2026-10-14 活体接线验证抓到的
  // 真 bug 就是「只取最后一行」⇒ 多行 JSON 末行是 `}` ⇒ LOGIN_REQUIRED 被误判成
  // PREFLIGHT_UNREADABLE、驱动照样起段白烧。这条用例把多行形状钉死。
  const { impl, calls } = fakeSpawn({ status: 0, stdout: JSON.stringify({ status: 'READY', reason: 'ok', blocking: false }, null, 2) });
  const result = runLoginPreflightStep({ proxy: 'http://127.0.0.1:3457', notify: true }, { spawnImpl: impl });
  assert.equal(result.status, 'READY');
  assert.equal(calls.length, 1);
  const [command, argv, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.ok(argv.some((item) => item.endsWith('xws-weekly-login-preflight.mjs')), '必须调预检模块');
  assert.ok(argv.includes('--proxy'));
  assert.equal(argv.includes('--no-notify'), false, 'notify 模式不许静默预检');
  assert.equal('input' in options, false, '不许用 input:（stdin 管道，沙箱下 EBUSY）');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('runLoginPreflightStep: 单行 JSON（包装器场景）也认', () => {
  const { impl } = fakeSpawn({ status: 0, stdout: `${JSON.stringify({ status: 'NO_XWS_TAB', blocking: false })}\n` });
  const result = runLoginPreflightStep({ proxy: 'http://127.0.0.1:3457', notify: true }, { spawnImpl: impl });
  assert.equal(result.status, 'NO_XWS_TAB');
});

test('runLoginPreflightStep: dry-run 驱动给预检显式静音', () => {
  const { impl, calls } = fakeSpawn({ status: 0, stdout: JSON.stringify({ status: 'READY' }) });
  runLoginPreflightStep({ proxy: 'http://127.0.0.1:3457', notify: false }, { spawnImpl: impl });
  assert.ok(calls[0][1].includes('--no-notify'), '彩排时预检也不许真发飞书');
});

test('runLoginPreflightStep: 登录墙结论原样带回（驱动据此弃跑）', () => {
  const { impl } = fakeSpawn({
    status: 2,
    stdout: `${JSON.stringify({ status: 'LOGIN_REQUIRED', reason: '小旺神登录墙在位', blocking: true }, null, 2)}\n`,
  });
  const result = runLoginPreflightStep({ proxy: 'http://127.0.0.1:3457', notify: true }, { spawnImpl: impl });
  assert.equal(result.status, 'LOGIN_REQUIRED');
  assert.equal(result.blocking, true);
});

test('runLoginPreflightStep: 预检起不来（EBUSY 形状）⇒ PREFLIGHT_UNREADABLE，非阻断', () => {
  const { impl } = fakeSpawn({ status: null, error: Object.assign(new Error('spawnSync EBUSY'), { code: 'EBUSY' }) });
  const result = runLoginPreflightStep({ proxy: 'http://127.0.0.1:3457', notify: true }, { spawnImpl: impl });
  assert.equal(result.status, 'PREFLIGHT_UNREADABLE');
  assert.match(result.reason, /EBUSY/u);
});

test('parseDriverArgs: 必填项与 notify 开关', () => {
  const options = parseDriverArgs([
    '--ranges', '1-4', '--output-dir', 'C:/Users/Administrator/Downloads',
    '--checkpoint-prefix', 'runtime/xws-weekly-20261014', '--proxy', 'http://127.0.0.1:3457',
    '--notify',
  ]);
  assert.equal(options.notify, true);
  assert.equal(options.outputDir, 'C:/Users/Administrator/Downloads');
  assert.throws(() => parseDriverArgs(['--ranges', '1-4']), /required/u);
});
