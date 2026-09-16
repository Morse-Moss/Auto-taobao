import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { createConsoleServer, parseServerArgs } from './server.mjs';
import { PROJECT_PORTS } from '../browser-ports.mjs';
import { FAQ_AI_PROMPT_VERSION, FAQ_AI_REVIEW_VERSION } from '../faq-ai-review.mjs';
import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from '../faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from '../faq-local-summary.mjs';

// 真起一个服务、真发请求。这一层要钉住的是「协议层的承诺」：
// 读只走 GET、动作只走 POST、只监听回环、取不到就给能看的形状、动作白名单在服务端。
// 这些是页面之外的人（curl、托盘、以后的服务）会依赖的东西，所以不能只靠读代码相信。
async function withServer(run, options = {}) {
  const server = createConsoleServer(options);
  await new Promise((resolveListen) => server.listen(options.port ?? 0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolveClose) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close(resolveClose);
    });
  }
}

async function freePort() {
  return new Promise((resolvePort) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

// 动作测试一律指向临时数据根 —— 绝不拿仓库的 runtime/ 试写动作。
async function tempRoot(label) {
  return mkdtemp(join(tmpdir(), `console-${label}-`));
}

async function postAction(base, name, body, headers = {}) {
  const response = await fetch(`${base}/api/actions/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
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

test('the console binds to loopback only and declares its read/action split', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.console.host, '127.0.0.1');
    assert.ok(base.startsWith('http://127.0.0.1:'));
    // 二期起 health 不再自称 readonly：它把「哪些是读、哪些是动作」摊开说。
    // 动作清单必须显式标出谁会改数据、谁需要确认 —— 页面靠这个决定敢不敢一步点到底。
    assert.equal(payload.console.readonly, undefined, '不许再自称纯只读，那与动作端点矛盾');
    assert.ok(Array.isArray(payload.console.actions) && payload.console.actions.length > 0);
    for (const action of payload.console.actions) {
      assert.ok(action.name && action.label, '每个动作都要有名字和给运营看的标签');
      assert.equal(typeof action.mutating, 'boolean');
      assert.equal(typeof action.requiresConfirm, 'boolean');
    }
    assert.equal(payload.console.actions.find((action) => action.name === 'advance-faq').requiresConfirm, true, '推进阶段必须要求确认');
    assert.equal(payload.console.actions.find((action) => action.name === 'preview-faq').mutating, false, '预览是只读干跑');
    assert.match(payload.console.auditLog, /actions\.jsonl$/u);
  });
});

test('reads accept GET only and actions accept POST only', async () => {
  await withServer(async (base) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${base}/api/runs`, { method });
      assert.equal(response.status, 405, `${method} 打读接口应当是 405`);
      const payload = await response.json();
      assert.equal(payload.error, 'METHOD_NOT_ALLOWED');
      assert.match(payload.message, /POST \/api\/actions/u, '405 要说清写动作该走哪里');
      assert.equal(payload.method, method);
      assert.ok(Array.isArray(payload.actions) && payload.actions.length > 0);
    }
    // 写动作不许藏在 GET 里：一次预取就能触发副作用是最容易犯的错。
    const getOnAction = await fetch(`${base}/api/actions/preview-faq`);
    assert.equal(getOnAction.status, 405);
    assert.match((await getOnAction.json()).message, /只接受 POST/u);
    // HEAD 只断言状态码：HEAD 按 HTTP 语义不该有 body（Node 会把它剥掉），
    // 所以这里不是「服务端少写了报文」。
    assert.equal((await fetch(`${base}/api/actions/preview-faq`, { method: 'HEAD' })).status, 405);
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

test('the server reports the port it actually listens on, not the registry default', async () => {
  const port = await freePort();
  await withServer(async (base) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.console.port, port, '自报端口必须是实际监听端口');
    assert.equal(health.console.registryPort, PROJECT_PORTS.operatorConsole);
    const env = await (await fetch(`${base}/api/env`)).json();
    // env 也要报实际端口：页面顶栏显示的是它，说错端口等于让运营去连一个没有服务的端口。
    assert.equal(env.console.port, port);
    assert.equal(env.console.registryPort, PROJECT_PORTS.operatorConsole);
  }, { port });
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

// ---------------------------------------------------------------------------
// 动作层
// ---------------------------------------------------------------------------

// 这两份收据的形状由 run-faq-operator.mjs 的判据定义，这里只是照抄「已核验」的那一套。
// 抄错一个字段，夹具就会落在一个不是我们想测的阶段上 —— 所以断言里都带 nextAction。
const labels = FAQ_LABEL_CATALOG.map((label) => label.label);
const summaryReceipt = (period) => ({
  mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION,
  summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION,
  painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION, operatorContentVersion: FAQ_OPERATOR_CONTENT_VERSION,
  source: { operatorXlsx: { path: 'operator.xlsx', sha256: 'a'.repeat(64) } },
  weekly: { path: 'weekly-summary.json', rows: 21, labels }, cumulative: { path: 'cumulative-summary.json', rows: 21, labels },
});
const aiReceipt = (period, needsHumanReview = 0) => ({
  mode: 'AI_REVIEWED', period, analysisVersion: FAQ_ANALYSIS_VERSION,
  aiReviewVersion: FAQ_AI_REVIEW_VERSION, aiPromptVersion: FAQ_AI_PROMPT_VERSION,
  taskCount: 10, resultCount: 10, autoAccepted: 10 - needsHumanReview, needsHumanReview, batchFailures: [],
});

// 一个「清单已锁定、证据齐全、快照已建、还没做分析」的夹具 ⇒ 下一步 = ANALYZE_LOCAL。
async function fixtureLockedFiveProducts(root, period) {
  const collection = join(root, 'question-library-collection', period);
  const products = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) }));
  await writeJson(join(collection, 'top5-manifest.json'), { period, products });
  for (const product of products) {
    const directory = join(collection, product.productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'qa.csv'), '问题,回答\n', 'utf8');
    await writeFile(join(directory, 'reviews.csv'), '评论内容\n有效评论\n', 'utf8');
    await writeFile(join(directory, 'reviews-source.zip'), 'PK\u0003\u0004', 'utf8');
    await writeJson(join(directory, 'qa-receipt.json'), { productId: product.productId, status: 'EMPTY_SOURCE_ROWS' });
    await writeJson(join(directory, 'reviews-receipt.json'), { productId: product.productId, status: 'COMPLETED' });
  }
  await writeJson(join(collection, 'raw-snapshot-receipt.json'), {
    mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, snapshot: { format: 'jsonl' },
  });
  return products;
}

test('an unknown action, a bad body and a wrong content-type are refused with reasons', async () => {
  const root = await tempRoot('actions-shape');
  await withServer(async (base) => {
    const unknown = await postAction(base, 'nuke-everything', {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error, 'UNKNOWN_ACTION');
    assert.deepEqual(unknown.payload.available.sort(), ['advance-faq', 'preview-faq', 'refresh-faq-status']);

    const badJson = await fetch(`${base}/api/actions/preview-faq`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'BAD_JSON');

    const wrongType = await fetch(`${base}/api/actions/preview-faq`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'periodStart=2026-08-23',
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error, 'UNSUPPORTED_MEDIA_TYPE');

    const badPeriod = await postAction(base, 'preview-faq', { periodStart: '2026/08/23', periodEnd: 'nope' });
    assert.equal(badPeriod.status, 400);
    assert.equal(badPeriod.payload.error, 'BAD_PERIOD');

    // 与上面任何一条一样重要：这些被拒的请求不许留下任何东西。
    await assert.rejects(() => stat(join(root, 'operator-console', 'actions.jsonl')), /ENOENT/u, '被拒的请求不该写审计');
  }, { runtimeRoot: root });
});

test('preview-faq is a real read-only dry run against the injected root', async () => {
  const root = await tempRoot('actions-preview');
  await withServer(async (base) => {
    const result = await postAction(base, 'preview-faq', { periodStart: '2026-08-23', periodEnd: '2026-08-29' });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    // 空根目录 ⇒ 判到第一阶段 ⇒ 干跑返回 DRY_RUN。若子进程偷用了仓库的 runtime/，这里会变成 DONE。
    assert.equal(result.payload.decision, 'DRY_RUN');
    assert.equal(result.payload.period, '2026-08-23_2026-08-29');
    assert.match(result.payload.willRun, /run-flow-orchestrator\.mjs/u);
    assert.equal(typeof result.payload.durationMs, 'number');
    // 只读动作：不许写 operator-status.json（它由「重新检查」负责）。
    await assert.rejects(() => stat(join(root, 'faq-analysis', '2026-08-23_2026-08-29', 'operator-status.json')), /ENOENT/u);
    // 但**要**写审计：动作有副作用就得留收据，哪怕这次是只读的。
    const audit = await readFile(join(root, 'operator-console', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"preview-faq"/u);
    assert.match(audit, /"mutating":false/u);
  }, { runtimeRoot: root });
});

test('refresh-faq-status rewrites the status receipt in the injected root', async () => {
  const root = await tempRoot('actions-refresh');
  await withServer(async (base) => {
    const statusPath = join(root, 'faq-analysis', '2026-08-23_2026-08-29', 'operator-status.json');
    await assert.rejects(() => stat(statusPath), /ENOENT/u, '前置条件：一开始没有状态文件');
    const result = await postAction(base, 'refresh-faq-status', { periodStart: '2026-08-23', periodEnd: '2026-08-29' });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.nextAction, 'LOCK_TOP5', '空根目录只能判到第一阶段');
    const written = JSON.parse(await readFile(statusPath, 'utf8'));
    assert.equal(written.nextAction, 'LOCK_TOP5');
    assert.ok(written.checkedAt, '状态文件必须带检查时间，运营台的「上次检查」靠它');
    const audit = await readFile(join(root, 'operator-console', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"refresh-faq-status"/u);
    assert.match(audit, /"mutating":true/u);
  }, { runtimeRoot: root });
});

test('advance-faq refuses to run before anything is confirmed, and hands back the exact command', async () => {
  const root = await tempRoot('actions-confirm');
  const period = '2026-08-23_2026-08-29';
  await fixtureLockedFiveProducts(root, period);
  await withServer(async (base) => {
    const result = await postAction(base, 'advance-faq', { periodStart: '2026-08-23', periodEnd: '2026-08-29' });
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'CONFIRM_REQUIRED');
    assert.equal(result.payload.nextAction, 'ANALYZE_LOCAL', '判据必须来自真实收据，不是请求里说的');
    assert.match(result.payload.willRun, /run-faq-operator\.mjs --advance/u);
    // 没确认就什么都没发生：既没推进，也没写状态（推进前的探测是 --no-persist）。
    await assert.rejects(() => stat(join(root, 'faq-analysis', period, 'operator-status.json')), /ENOENT/u);
    await assert.rejects(() => stat(join(root, 'operator-console', 'actions.jsonl')), /ENOENT/u);
  }, { runtimeRoot: root });
});

test('advance-faq refuses the human-collection stage outright', async () => {
  const root = await tempRoot('actions-human');
  const period = '2026-08-23_2026-08-29';
  // 清单锁定但证据没采 ⇒ 下一步是浏览器采集，运营台不许代做。
  await writeJson(join(root, 'question-library-collection', period, 'top5-manifest.json'), {
    period, products: Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) })),
  });
  await withServer(async (base) => {
    const result = await postAction(base, 'advance-faq', { periodStart: '2026-08-23', periodEnd: '2026-08-29', confirm: true });
    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'HUMAN_STAGE');
    assert.equal(result.payload.nextAction, 'COLLECT_EVIDENCE');
    assert.match(result.payload.message, /浏览器采集|人来/u);
  }, { runtimeRoot: root });
});

test('advance-faq can never publish to Feishu, even with confirm:true', async () => {
  const root = await tempRoot('actions-publish');
  const period = '2026-08-23_2026-08-29';
  await fixtureLockedFiveProducts(root, period);
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  await writeJson(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 5 });
  await writeJson(join(analysis, 'aggregate-receipt.json'), summaryReceipt(period));
  await writeJson(join(analysis, 'ai-review', 'ai-review-receipt.json'), aiReceipt(period, 0));
  await writeJson(join(analysis, 'final-classification-receipt.json'), {
    mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: FAQ_ANALYSIS_VERSION, publishable: true, humanQueueCount: 0,
  });
  await withServer(async (base) => {
    const result = await postAction(base, 'advance-faq', { periodStart: '2026-08-23', periodEnd: '2026-08-29', confirm: true });
    assert.equal(result.payload.nextAction ?? result.payload.preview?.nextAction, 'PUBLISH_FEISHU_SUMMARIES', JSON.stringify(result.payload));
    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'EXTERNAL_WRITE_NEEDS_AUTHORIZATION');
    assert.match(result.payload.message, /--authorize-publish/u, '要说清正确的方式是命令行显式授权');
    // 发布收据没有出现 ⇒ 一个字节都没往飞书写。
    await assert.rejects(() => stat(join(analysis, 'detail-enrichment-receipt.json')), /ENOENT/u);
  }, { runtimeRoot: root });
});

test('a confirmed advance really spawns the stage runner and lands in the audit log', async () => {
  const root = await tempRoot('actions-advance');
  const period = '2026-08-23_2026-08-29';
  await fixtureLockedFiveProducts(root, period);
  await withServer(async (base) => {
    const result = await postAction(base, 'advance-faq', { periodStart: '2026-08-23', periodEnd: '2026-08-29', confirm: true });
    // 夹具只到「该做分析了」，所以真的会去跑 run-faq-text-analysis.mjs；它没有输入快照，
    // 结果可能成功也可能失败 —— 这里断言的是「命令真的被执行了」，不是「阶段跑成功了」。
    // 阶段成不成功由它自己的收据说了算，那也是运营台重读后显示的东西。
    assert.ok([200, 502].includes(result.status), `未预期的状态：${result.status}`);
    assert.equal(typeof result.payload.exitCode, 'number', '子进程必须真的结束了，并带回退出码');
    assert.equal(result.payload.action, 'advance-faq');
    assert.equal(result.payload.period, period);
    const audit = await readFile(join(root, 'operator-console', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"advance-faq"/u);
    assert.match(audit, /"confirm":true/u);
  }, { runtimeRoot: root });
});
