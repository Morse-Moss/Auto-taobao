import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

import { createConsoleServer, parseServerArgs } from './server.mjs';
import { PROJECT_PORTS } from '../browser-ports.mjs';

// 真起一个服务、真发请求。这一层要钉住的是「协议层的承诺」：
// 只读、只监听回环、取不到就给能看的形状。这些是页面之外的人（curl、托盘、以后的服务）
// 会依赖的东西，所以不能只靠读代码相信。
async function withServer(run) {
  const server = createConsoleServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// 绕过 fetch 的 URL 规范化：fetch 会把 `/api/../index.html` 在客户端就折成 `/index.html`，
// 那样测的就不是服务端行为。走原始 http 请求才真的把未规范化的路径送到服务端。
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: hostname, port, method: 'GET', path: rawPath }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolvePromise({ status: response.statusCode, type: response.headers['content-type'] ?? '', body }));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

test('the console binds to loopback only', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.console.host, '127.0.0.1');
    assert.equal(payload.console.readonly, true);
    assert.ok(base.startsWith('http://127.0.0.1:'));
  });
});

test('read-only is enforced at the protocol layer, with an explanation', async () => {
  await withServer(async (base) => {
    // 一期没有写动作。与其让按钮悄悄失败，不如在协议层就说清「还没有这个动作」。
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${base}/api/runs`, { method });
      assert.equal(response.status, 405, `${method} 应当是 405`);
      const payload = await response.json();
      assert.equal(payload.error, 'METHOD_NOT_ALLOWED');
      assert.match(payload.message, /只读/u);
      assert.equal(payload.method, method);
    }
  });
});

test('page and assets are served from a fixed allow-list', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/u);
    const html = await page.text();
    assert.match(html, /运营台/u);
    // 页面引用的两个资源必须真的拿得到，否则页面会静默少掉样式或脚本。
    for (const asset of ['/app.js', '/styles.css']) {
      const response = await fetch(`${base}${asset}`);
      assert.equal(response.status, 200, `${asset} 拿不到`);
    }
    // 白名单外的路径一律 404。
    for (const bad of ['/state.mjs', '/server.mjs', '/nope']) {
      const response = await fetch(`${base}${bad}`);
      assert.equal(response.status, 404, `${bad} 应当是 404`);
    }
    const unknownApi = await fetch(`${base}/api/nope`);
    assert.equal(unknownApi.status, 404);
    const body = await unknownApi.json();
    assert.equal(body.error, 'UNKNOWN_ENDPOINT');
    assert.deepEqual(body.available.sort(), ['/api/accounts', '/api/env', '/api/health', '/api/runs']);
  });
});

// 服务端从不把请求路径拼进文件路径，所以「绕不出去」这件事要单独证明一次。
// URL 规范化会把 `/api/../index.html` 折回 `/index.html`，那是白名单内的文件、返回 200 是对的；
// 关键是**任何一个穿越写法都不许拿到白名单外的文件**（判据：拿到的是 JSON 错误而不是文件内容）。
test('path traversal variants never reach a file outside the allow-list', async () => {
  await withServer(async (base) => {
    for (const raw of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/../../package.json', '/api/../../package.json']) {
      const { status, type } = await rawGet(base, raw);
      assert.equal(status, 404, `${raw} 应当是 404，实际 ${status}`);
      assert.match(type, /application\/json/u, `${raw} 返回的不是错误响应，可能泄漏了文件`);
    }
    // 规范化的那一种要说明清楚它是「折回白名单」而不是「穿越成功」。
    const folded = await rawGet(base, '/api/../index.html');
    assert.equal(folded.status, 200);
    assert.match(folded.body, /运营台/u);
  });
});

test('the api endpoints answer with the shapes the page renders', async () => {
  await withServer(async (base) => {
    const env = await (await fetch(`${base}/api/env`)).json();
    assert.equal(env.console.port, PROJECT_PORTS.operatorConsole);
    assert.ok(env.routes.length > 0);
    assert.ok(env.browsers.length > 0);
    for (const browser of env.browsers) {
      for (const light of Object.values(browser.lights)) {
        assert.ok(['green', 'amber', 'red', 'grey', 'blue'].includes(light.lamp), `灯色不合法：${light.lamp}`);
      }
    }
    const accounts = await (await fetch(`${base}/api/accounts`)).json();
    assert.equal(accounts.probed, false);
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.ok(Array.isArray(runs.runs));
    // 每个不可用的运行都必须带 reasonCode —— 没有理由的灰块等于没有信息。
    for (const run of runs.runs.filter((item) => !item.available)) {
      assert.ok(run.reasonCode, `${run.period} 缺 reasonCode`);
      assert.ok(run.reason);
    }
  });
});

test('the port comes from the registry and a bad override is rejected, not silently ignored', () => {
  assert.equal(parseServerArgs([]).port, PROJECT_PORTS.operatorConsole);
  assert.equal(parseServerArgs(['--port', '19100']).port, 19100);
  // 「静默回落」正是坑 35 的成因：非法值必须抛错。
  assert.throws(() => parseServerArgs(['--port', 'abc']), /1-65535/u);
  assert.throws(() => parseServerArgs(['--port', '70000']), /1-65535/u);
  assert.throws(() => parseServerArgs(['--nope']), /Unknown argument/u);
  assert.equal(parseServerArgs([]).host, '127.0.0.1');
});
