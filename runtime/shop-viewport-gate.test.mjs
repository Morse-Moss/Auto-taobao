// 守卫：**视口回读闸门**（2026-10-05 落地，`runtime/shop-viewport-gate.mjs`）。
//
// 这份守卫要防的不是「函数算错」，而是**接线没接上** —— 本仓反复栽在同一个坑上：
// 判据写好了、用例全绿，但那条判据根本没被主链调用（最近一次是 2026-09-29 的 `--auto-repair`：
// 四路 `===` 全落空、零动作执行过，而用例全绿）。
//
// 所以分两层：
//   第一层（行为）：纯判据 `judgeShopViewport` / 汇总 / 读盘重试 —— 用假 `fetch` 钉住，
//     只判意，不碰真端口。
//   第二层（接线）：直接读 `scripts/run-product-data-job.mjs` 的源码，钉住调用点的**位置与顺序**：
//     必须在 `start` **之后**、在 `login` **之前**，且不达标要 `throw`。
//     位置错了不会报错 —— 放在 login 之后只是白白多跑一趟登录预检；
//     放在 start 之前则**永远读不到东西**（实例还没起），而且会安静地每次都判红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SHOP_VIEWPORT_MIN_WIDTH, SHOP_VIEWPORT_MIN_HEIGHT,
  judgeShopViewport, summarizeShopViewports, describeViewportFailure, readShopViewport, checkShopViewports,
} from './shop-viewport-gate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'scripts/run-product-data-job.mjs';
const readSource = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');

test('阈值落在「历史成功读数 1506」与「被夹窄读数 1114」之间', () => {
  assert.ok(SHOP_VIEWPORT_MIN_WIDTH > 1114, `阈值 ${SHOP_VIEWPORT_MIN_WIDTH} 必须高于被夹窄读数 1114`);
  assert.ok(SHOP_VIEWPORT_MIN_WIDTH < 1506, `阈值 ${SHOP_VIEWPORT_MIN_WIDTH} 必须低于历史成功读数 1506`);
  assert.ok(SHOP_VIEWPORT_MIN_HEIGHT <= 642, '历史成功读数高度 642 必须达标');
});

test('判据：达标 / 太窄 / 太矮 / 读不到 四种结论分开', () => {
  assert.equal(judgeShopViewport({ width: 1506, height: 642 }).ok, true);
  assert.equal(judgeShopViewport({ width: 1114, height: 642 }).reason, 'VIEWPORT_TOO_NARROW');
  assert.equal(judgeShopViewport({ width: 1506, height: 500 }).reason, 'VIEWPORT_TOO_SHORT');
  assert.equal(judgeShopViewport({}).reason, 'VIEWPORT_UNREADABLE');
  assert.equal(judgeShopViewport({ width: null, height: null }).reason, 'VIEWPORT_UNREADABLE');
  // 「读不到」必须判红，不能当成「没事」—— 这正是本仓反复在治的病根。
  assert.equal(judgeShopViewport({ width: null, height: null }).ok, false);
});

test('汇总：一家红就整批红，且能点出是哪几家', () => {
  const entries = [
    { shop: 'A', verdict: judgeShopViewport({ width: 1506, height: 642 }) },
    { shop: 'B', verdict: judgeShopViewport({ width: 1114, height: 642 }) },
  ];
  const summary = summarizeShopViewports(entries);
  assert.equal(summary.ok, false);
  assert.equal(summary.checked, 2);
  assert.deepEqual(summary.failed.map((entry) => entry.shop), ['B']);
  assert.equal(summarizeShopViewports([{ shop: 'A', verdict: judgeShopViewport({ width: 1506, height: 642 }) }]).ok, true);
  // 一家都没有时不该自称达标（空集真值陷阱）。
  assert.equal(summarizeShopViewports([]).ok, true);
  assert.equal(summarizeShopViewports([]).checked, 0);
});

test('失败短语：带店名与成因，读盘失败时把错误也带上', () => {
  const text = describeViewportFailure(summarizeShopViewports([
    { shop: '盖文天猫', verdict: judgeShopViewport({ width: 1114, height: 642 }) },
    { shop: '网林家居', verdict: judgeShopViewport({}), readError: 'fetch failed' },
  ]));
  assert.match(text, /盖文天猫=VIEWPORT_TOO_NARROW/u);
  assert.match(text, /网林家居=VIEWPORT_UNREADABLE/u);
  assert.match(text, /fetch failed/u);
});

/** 假代理：`/targets` 给一个 page，`/eval` 按脚本产出一串回应（每次调用消费一个）。 */
function fakeProxy({ shopPort, evalResponses, targets = [{ targetId: 't1', type: 'page', url: 'file:///label.html' }] }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/targets')) return { ok: true, json: async () => targets };
    const next = evalResponses.shift();
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next };
  };
  return { calls, fetchImpl, base: `http://127.0.0.1:${shopPort}` };
}

test('读盘：成功一次到位，且 targetId 是从 /targets 现取的（不存第二份）', async () => {
  const proxy = fakeProxy({ shopPort: 19041, evalResponses: [{ value: JSON.stringify({ width: 1506, height: 642, dpr: 1.25 }) }] });
  const entry = await readShopViewport({ shop: '里可林淘宝', fetchImpl: proxy.fetchImpl, sleep: async () => {} });
  assert.equal(entry.verdict.ok, true);
  assert.equal(entry.width, 1506);
  assert.equal(entry.height, 642);
  assert.equal(entry.dpr, 1.25);
  assert.equal(entry.targetId, 't1');
  assert.equal(entry.readError, null);
  assert.equal(proxy.calls.filter((url) => url.endsWith('/targets')).length, 1);
  assert.match(proxy.calls.at(-1), /\/eval\?target=t1$/u);
});

test('读盘：先失败后成功算成功（首屏还在加载 ≠ 不达标），所以会重试', async () => {
  const proxy = fakeProxy({ shopPort: 19041, evalResponses: [
    { error: 'Cannot find context with specified id' },
    { value: JSON.stringify({ width: 1506, height: 642, dpr: 1.25 }) },
  ] });
  const entry = await readShopViewport({ shop: '里可林淘宝', fetchImpl: proxy.fetchImpl, sleep: async () => {} });
  assert.equal(entry.verdict.ok, true);
  assert.equal(proxy.calls.filter((url) => url.includes('/eval')).length, 2);
});

test('读盘：一直读不到 ⇒ VIEWPORT_UNREADABLE，且带上最后一次的错（不是静默放过）', async () => {
  const proxy = fakeProxy({ shopPort: 19041, evalResponses: [new Error('fetch failed'), new Error('fetch failed'), new Error('fetch failed')] });
  const entry = await readShopViewport({ shop: '里可林淘宝', fetchImpl: proxy.fetchImpl, attempts: 3, sleep: async () => {} });
  assert.equal(entry.verdict.ok, false);
  assert.equal(entry.verdict.reason, 'VIEWPORT_UNREADABLE');
  assert.match(String(entry.readError), /fetch failed/u);
});

test('读盘：代理上没有 page 页签时也判读不到', async () => {
  const proxy = fakeProxy({ shopPort: 19041, evalResponses: [], targets: [{ targetId: 'w1', type: 'service_worker', url: 'devtools://x' }] });
  const entry = await readShopViewport({ shop: '里可林淘宝', fetchImpl: proxy.fetchImpl, attempts: 2, sleep: async () => {} });
  assert.equal(entry.verdict.reason, 'VIEWPORT_UNREADABLE');
  assert.equal(proxy.calls.filter((url) => url.includes('/eval')).length, 0);
});

test('逐店读：串行、每家一个结论，一家红即整批红', async () => {
  const byPort = new Map([
    [19041, [{ value: JSON.stringify({ width: 1506, height: 642, dpr: 1.25 }) }]],
    [19042, [{ value: JSON.stringify({ width: 1114, height: 642, dpr: 2.5 }) }]],
  ]);
  const fetchImpl = async (url) => {
    const port = Number(new URL(url).port);
    const queue = byPort.get(port);
    if (String(url).endsWith('/targets')) return { ok: true, json: async () => [{ targetId: `t-${port}`, type: 'page', url: 'file:///label.html' }] };
    return { ok: true, json: async () => queue.shift() };
  };
  // 两个真实存在的店键（端口 19041 / 19042），读盘走假 fetch，不碰真实例。
  const summary = await checkShopViewports({ shops: ['里可林淘宝', '网林天猫'], fetchImpl, sleep: async () => {} });
  assert.equal(summary.ok, false);
  assert.equal(summary.checked, 2);
  assert.deepEqual(summary.failed.map((entry) => entry.shop), ['网林天猫']);
  assert.match(describeViewportFailure(summary), /网林天猫=VIEWPORT_TOO_NARROW/u);
});

test('接线①：视口闸门排在 start 之后、login 之前（顺序错了就静默失效）', () => {
  const source = readSource(ENTRY);
  const body = source.slice(source.indexOf('async function runRound('), source.indexOf('async function main('));
  const startAt = body.indexOf('PRODUCT_JOB_FILES.start');
  const checkAt = body.indexOf('checkShopViewports({ shops })');
  const loginAt = body.indexOf('PRODUCT_JOB_FILES.login');
  assert.ok(startAt > 0, 'runRound 里必须有启动实例那一步');
  assert.ok(checkAt > 0, 'runRound 里必须调用视口闸门（否则闸门是个死代码）');
  assert.ok(loginAt > 0, 'runRound 里必须有登录预检那一步');
  assert.ok(startAt < checkAt, '视口回读必须在启动实例之后 —— 放在之前永远读不到东西');
  assert.ok(checkAt < loginAt, '视口回读必须在登录预检之前 —— 放在之后白跑一趟登录');
});

test('接线②：不达标要 throw（只记日志等于没闸门），且读数无论成败都落盘', () => {
  const source = readSource(ENTRY);
  assert.match(source, /if \(!viewport\.ok\) throw new Error\(`浏览器视口不达标/u);
  assert.match(source, /viewport-\$\{tag\}\.json.*'viewport\.json'/u);
});

test('接线③：视口判红要能归到 start 段（否则收据里那一格永远是「未知」）', () => {
  const source = readSource(ENTRY);
  assert.match(source, /\[\/浏览器视口\/u, 'start'\]/u);
});
