import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from '../browser-ports.mjs';

// 用一个不属于任何链的合成端口：退役值（9223 等）不许再出现在测试里，
// 否则它会被下一个人当成「示例默认值」抄回去（坑 52 的成因之一）。
const SYNTHETIC_PORT = 19999;

const ENV_NAMES = ['CDP_BROWSER_PORT', 'CDP_BROWSER_ID', 'CDP_BROWSER_LABEL'];

function withEnv(values, body) {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return body().finally(() => {
    for (const name of ENV_NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
}

function mockFetchOn(port) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }),
  });
  return () => { globalThis.fetch = originalFetch; };
}

// 模块在 import 期读环境变量，所以每次都要用查询串破缓存。
function freshModule() {
  return import(`./browser-discovery.mjs?test=${Date.now()}-${Math.random()}`);
}

test('显式环境变量优先于登记表默认值', async () => {
  await withEnv({
    CDP_BROWSER_PORT: String(SYNTHETIC_PORT),
    CDP_BROWSER_ID: 'edge-synthetic',
    CDP_BROWSER_LABEL: 'Synthetic Browser',
  }, async () => {
    const restoreFetch = mockFetchOn(SYNTHETIC_PORT);
    try {
      const module = await freshModule();
      const selected = await module.selectBrowser();
      assert.equal(selected.browser.id, 'edge-synthetic');
      assert.equal(selected.browser.label, 'Synthetic Browser');
      assert.equal(selected.browser.port, SYNTHETIC_PORT);
    } finally {
      restoreFetch();
    }
  });
});

test('默认值来自登记表，且身份与目标同链（不许再自称买家、实连商家）', async () => {
  await withEnv({
    CDP_BROWSER_PORT: undefined,
    CDP_BROWSER_ID: undefined,
    CDP_BROWSER_LABEL: undefined,
  }, async () => {
    const restoreFetch = mockFetchOn(PROJECT_PORTS.competitorBrowser);
    try {
      const module = await freshModule();
      const selected = await module.selectBrowser();
      // 三个值必须一起取自同一条链：只对上一个，就会出现「身份 A、目标 B」。
      assert.equal(selected.browser.port, PROJECT_PORTS.competitorBrowser);
      assert.equal(selected.browser.id, BROWSER_IDS.competitor);
      assert.equal(selected.browser.label, BROWSER_LABELS.competitor);
      // 反向断言：默认端口不得再落在退役值上（9223 是日报链迁移前的值）。
      assert.notEqual(selected.browser.port, 9223);
    } finally {
      restoreFetch();
    }
  });
});

test('端口是非法值时抛错，而不是静默回落到默认值', async () => {
  await withEnv({ CDP_BROWSER_PORT: 'not-a-port' }, async () => {
    const restoreFetch = mockFetchOn(SYNTHETIC_PORT);
    try {
      await assert.rejects(freshModule(), /CDP_BROWSER_PORT/u);
    } finally {
      restoreFetch();
    }
  });
});
