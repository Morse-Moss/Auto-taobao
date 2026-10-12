import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureCollectorFailureScene } from './collect-failure-scene.mjs';

// 这一族用例**起真 HTTP 服务**来当代理，而不是把三个调用点 mock 掉。
// 理由（本项目反复吃过的那类亏）：mock 只能证明「调用侧以为自己在传什么」，
// 证明不了「对面真认不认」。这里让请求真的走一遍网卡，才能钉住
// 「URL 形状对、方法对、body 对、挑中的页签对」。

const makeDir = () => mkdtempSync(path.join(tmpdir(), 'collect-failure-scene-'));

const PAGE_STATE = {
  url: 'https://one.alimama.com/index.html#!/report/account',
  title: '阿里妈妈',
  viewport: { w: 1506, h: 642, dpr: 1.25, scrollY: 0 },
  visibleText: '生成成功 营销场景报表',
  dialogs: [], interactive: [], domSummary: { totalElements: 42, counts: {}, containers: [] }, tables: [],
};

/**
 * 起一个一次性代理服务。`handler(req, res, seen)` 自己回，
 * `seen` 用来把「真收到了什么」留下来给断言用。
 */
async function withProxy(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => handler(req, res, seen));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, seen);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

test('没给 --log-dir ⇒ 不采，且把「为什么不采」说出来（不许静默跳过）', async () => {
  const dir = makeDir();
  try {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };
    let lines = [];
    try {
      const result = await captureCollectorFailureScene({
        proxy: 'http://127.0.0.1:1', logDir: null, stage: 'promotion-fetch', pageHint: 'alimama',
        error: 'boom', shopKey: '网林天猫', log: (line) => lines.push(line),
      });
      assert.equal(result, null);
      assert.equal(fetchCalls, 0, '不采就一次代理都不该打');
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(lines.some((line) => /没给 --log-dir/.test(line)), lines.join('｜'));
    assert.ok(lines.some((line) => /编排层/.test(line)), '要说清「谁会在别的场合采」');
    assert.equal(existsSync(path.join(dir, '98-failure-state.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('给了 --log-dir ⇒ 三个代理调用真的发出去，且挑中的是出事那一站的页', async () => {
  const dir = makeDir();
  try {
    await withProxy((req, res, seen) => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: url.search, target: url.searchParams.get('target'), file: url.searchParams.get('file') });
      if (url.pathname === '/targets') {
        return json(res, [
          // 第一个非 about 页签是**店铺标识页** —— 旧代码会拍它（2026-10-12 实证的那一形态）。
          { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=x&port=19031' },
          { type: 'page', targetId: 'ALIMAMA', url: 'https://one.alimama.com/index.html#!/report/account' },
        ]);
      }
      if (url.pathname === '/eval') {
        // 形状必须与真代理一致：`{ value: <表达式返回值> }`（10-05 那次空壳事故的形状）。
        return json(res, { value: JSON.stringify(PAGE_STATE) });
      }
      if (url.pathname === '/screenshot') return json(res, { saved: '/tmp/x.png' });
      return json(res, { error: 'not found' }, 404);
    }, async (base, seen) => {
      const result = await captureCollectorFailureScene({
        proxy: base, logDir: dir, stage: 'promotion-fetch', pageHint: 'alimama',
        error: '30000ms 内没等到新 zip', shopKey: '网林天猫', log: () => {},
      });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      const evals = seen.filter((s) => s.path === '/eval');
      assert.equal(evals.length, 1);
      assert.equal(evals[0].method, 'POST');
      assert.equal(evals[0].target, 'ALIMAMA', '拍错页就等于白采 —— 这条钉的是「采到的那一页」');
      assert.equal(result.selected.how, 'pageHint');
      const shots = seen.filter((s) => s.path === '/screenshot');
      assert.equal(shots.length, 1);
      assert.equal(shots[0].target, 'ALIMAMA');
      assert.ok(shots[0].file.endsWith('98-failure-page.png'));
      assert.ok(existsSync(result.files.stateJson));
      assert.ok(existsSync(result.files.stateText));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('代理回非 2xx ⇒ 如实记进 errors，不崩、也不落一套空壳', async () => {
  const dir = makeDir();
  try {
    await withProxy((req, res, seen) => {
      const url = new URL(req.url, 'http://x');
      seen.push(url.pathname);
      if (url.pathname === '/targets') return json(res, [{ type: 'page', targetId: 'T1', url: 'https://one.alimama.com/index.html' }]);
      return json(res, 'gateway timeout', 504);
    }, async (base) => {
      let lines = [];
      const result = await captureCollectorFailureScene({
        proxy: base, logDir: dir, stage: 'promotion-fetch', pageHint: 'alimama',
        error: 'boom', log: (line) => lines.push(line),
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, null);
      assert.equal(result.files.stateJson, undefined, '采空了就不许落「看着像采到了」的空壳');
      assert.ok(result.errors.some((line) => /\/eval HTTP 504/.test(line)), result.errors.join('｜'));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('代理连不上（fetch 直接拒）⇒ 不抛，把原因记进 errors（感知失败＝学不到，不是又出错）', async () => {
  const dir = makeDir();
  try {
    let lines = [];
    const result = await captureCollectorFailureScene({
      // 1 号端口没人听 ⇒ ECONNREFUSED
      proxy: 'http://127.0.0.1:1', logDir: dir, stage: 'product-report', pageHint: 'alimama',
      error: '商品报表下载超时: xxx', shopKey: '盖文天猫', log: (line) => lines.push(line),
    });
    // 感知层本来就承诺永不抛 ⇒ 这里拿到的是它的返回（ok:false + 原因），不是 null、更不是异常。
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.equal(result.files.stateJson, undefined, '读不到页签就不落空壳');
    assert.ok(result.errors.some((line) => /读页签失败/.test(line)), result.errors.join('｜'));
    assert.ok(lines.some((line) => /现场感知降级/.test(line)), lines.join('｜'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('兜底：连 log 自己抛了都不许把主线失败原因盖掉', async () => {
  const dir = makeDir();
  try {
    const result = await captureCollectorFailureScene({
      proxy: 'http://127.0.0.1:1', logDir: dir, stage: 'product-report', pageHint: 'alimama',
      error: '主线失败原因一个字都不许被改写',
      // 第一行（「没给 --log-dir」那条）不抛，之后全抛 —— 专打感知层末尾那段 log。
      log: () => { throw new Error('log 自己坏了'); },
    });
    assert.equal(result, null, '外层兜底接住，返回 null');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
