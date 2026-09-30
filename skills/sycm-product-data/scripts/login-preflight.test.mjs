import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLoginReady, DEFAULT_PRODUCT_SHOPS, loginPreflightArgs, parseLoginPreflightOutput, runParallelLoginPreflight } from './login-preflight.mjs';
import { ISOLATED_PROFILES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';

test('builds the existing daily-report auto-login command', () => {
  assert.deepEqual(loginPreflightArgs({ shops: ['盖文淘宝', '盖文天猫'], timeoutMs: 1000 }).slice(1), [
    '--login', '--json', '--shops', '盖文淘宝,盖文天猫', '--timeout', '1000',
  ]);
});
test('defaults to the shops registered for the product flow (no hardcoded list)', () => {
  // 2026-09-30 改：原来这里写死的是那 5 家。13 家扩编后它会红，而红的原因**不是代码坏了**，
  // 是断言自己过期 —— 更糟的是它会诱导后来者「把 5 改成 13」而不是去问「这个数为什么在这儿」。
  // 真正的判据是：默认值＝隔离 profile 登记表，且与店铺登记表同集合（两边各写一份就会漏店）。
  const expected = Object.keys(ISOLATED_PROFILES);
  assert.deepEqual([...DEFAULT_PRODUCT_SHOPS], expected);
  assert.equal(loginPreflightArgs({ shops: DEFAULT_PRODUCT_SHOPS })[4], expected.join(','));
  // 「这张表与店铺登记表必须同集合」那条判据不在这里 —— 它由
  // runtime/browser-ports.test.mjs「profile 必须与身份登记表逐键一致」守着，
  // 而那是 runtime → skills 方向（本文件再 import 一次 runtime 只会给
  // 「skills → runtime 依赖清单」添一行没必要的登记，见 runtime/arch-boundary.test.mjs）。
});
test('accepts only an ALL_IN receipt', () => {
  const receipt = parseLoginPreflightOutput('{"verdict":"ALL_IN","roundNotify":{"status":"SKIPPED"}}');
  assert.equal(assertLoginReady({ code: 0, receipt }), receipt);
  assert.throws(() => assertLoginReady({ code: 2, receipt: { verdict: 'NEEDS_LOGIN', roundNotify: { alertId: 'x' } } }), /x/);
});
test('runs each shop as a parallel child instead of serializing the shops', async () => {
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
