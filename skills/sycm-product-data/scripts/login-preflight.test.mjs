import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLoginReady, DEFAULT_PRODUCT_SHOPS, loginPreflightArgs, parseLoginPreflightOutput, runParallelLoginPreflight } from './login-preflight.mjs';

test('builds the existing daily-report auto-login command', () => {
  assert.deepEqual(loginPreflightArgs({ shops: ['盖文淘宝', '盖文天猫'], timeoutMs: 1000 }).slice(1), [
    '--login', '--json', '--shops', '盖文淘宝,盖文天猫', '--timeout', '1000',
  ]);
});
test('defaults to the five isolated shops already covered by the daily flow', () => {
  assert.deepEqual(DEFAULT_PRODUCT_SHOPS, ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝']);
  assert.equal(loginPreflightArgs({ shops: DEFAULT_PRODUCT_SHOPS })[4], '里可林淘宝,网林天猫,盖文淘宝,盖文天猫,科塔淘宝');
});
test('accepts only an ALL_IN receipt', () => {
  const receipt = parseLoginPreflightOutput('{"verdict":"ALL_IN","roundNotify":{"status":"SKIPPED"}}');
  assert.equal(assertLoginReady({ code: 0, receipt }), receipt);
  assert.throws(() => assertLoginReady({ code: 2, receipt: { verdict: 'NEEDS_LOGIN', roundNotify: { alertId: 'x' } } }), /x/);
});
test('runs each shop as a parallel child instead of serializing the five shops', async () => {
  const seen = [];
  const fakeSpawn = (_exe, args) => {
    seen.push(args[args.indexOf('--shops') + 1]);
    const listeners = {};
    return {
      stdout: { on() {} }, stderr: { on() {} },
      on(event, handler) { listeners[event] = handler; if (event === 'close') queueMicrotask(() => handler(0)); return this; },
    };
  };
  const results = await runParallelLoginPreflight({ shops: ['甲', '乙'], spawnImpl: fakeSpawn });
  assert.deepEqual(seen.sort(), ['乙', '甲'].sort());
  assert.equal(results.length, 2);
});
