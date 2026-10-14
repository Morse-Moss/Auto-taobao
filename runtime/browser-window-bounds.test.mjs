// 守卫：**共用商家浏览器的窗口归位**（2026-10-14 落地，`runtime/browser-window-bounds.mjs`）。
//
// 为什么需要它（当天真机）：那台实例（19022/19023）的 argv 里既没有 `--window-size`
// 也没有 `--force-device-scale-factor` —— 那两条老命令行被 `browser-ports.test.mjs`
// 断言「逐字不变」，不许为这件事拆掉。代价是窗口尺寸**从没人负责**：
// 取 Windows 默认窗、或恢复 profile 里记住的上一次位置。
// 10:21 / 10:27 两轮它是 692x307（视口 670x216）⇒ 登录表单落到视口**下方** ⇒
// `login-merchant.mjs` 的坐标点击全打在窗口外 ⇒ 静默判「没登上」⇒ 整轮 8 家一家不开跑。
// 10:52 手工设成 1528x732 后，同一脚本同一账号一次通过。
//
// 这份守卫分两层（与 `shop-viewport-gate.test.mjs` 同一种分法）：
//   第一层（行为）：纯判据 + 「永不抛」的失败契约 —— 用假 HTTP 端点钉住，不碰真实例；
//   第二层（接线）：读 `start-project-browser.mjs` 的源码，钉住「谁会被归位、在哪一步、
//     失败会不会把启动器带崩」—— 接线没接上的症状是静默的（窗口照旧没人管）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  WINDOW_BOUNDS_TOLERANCE, applyWindowBounds, describeWindowBounds, windowBoundsMatch,
} from './browser-window-bounds.mjs';
import { BROWSER_WINDOW_BOUNDS, SHOP_BROWSER_WINDOW_SIZE } from './browser-ports.mjs';
import { SHOP_VIEWPORT_MIN_WIDTH, SHOP_VIEWPORT_MIN_HEIGHT } from './shop-viewport-gate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const readSource = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');

/** 一个只回这两个端点的假 CDP HTTP 面。返回 `{ port, close }`。 */
async function fakeCdp({ version = { webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }, list = [] } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/json/version')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(version));
      return;
    }
    if (req.url.startsWith('/json/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

test('目标尺寸与店铺实例**同一个数**（两处各写一个 1528 就会漂）', () => {
  // 窗口尺寸的数值形态只有一处定义（`BROWSER_WINDOW_BOUNDS`），店铺那条命令行由它派生。
  assert.equal(SHOP_BROWSER_WINDOW_SIZE, `--window-size=${BROWSER_WINDOW_BOUNDS.width},${BROWSER_WINDOW_BOUNDS.height}`);
  // 而且这个尺寸必须**能过视口闸门**：否则「归位成功」与「闸门通过」会互相打脸。
  // （视口 = 窗口 − 边框/标题栏；这里留 100 像素的余量做保守判断。）
  assert.ok(BROWSER_WINDOW_BOUNDS.width - 100 >= SHOP_VIEWPORT_MIN_WIDTH,
    `目标宽 ${BROWSER_WINDOW_BOUNDS.width} 减掉边框后必须仍高于视口阈值 ${SHOP_VIEWPORT_MIN_WIDTH}`);
  assert.ok(BROWSER_WINDOW_BOUNDS.height - 100 >= SHOP_VIEWPORT_MIN_HEIGHT,
    `目标高 ${BROWSER_WINDOW_BOUNDS.height} 减掉边框后必须仍高于视口阈值 ${SHOP_VIEWPORT_MIN_HEIGHT}`);
});

test('纯判据：容差内算达标（Windows 会把请求的尺寸微调 1-2 像素），差得多算没达标', () => {
  const want = { width: 1528, height: 732 };
  assert.equal(windowBoundsMatch({ width: 1528, height: 732 }, want), true);
  assert.equal(windowBoundsMatch({ width: 1529, height: 732 }, want), true, '实测 1528 会变成 1529，不许判红');
  assert.equal(windowBoundsMatch({ width: 1528 + WINDOW_BOUNDS_TOLERANCE, height: 732 }, want), true);
  assert.equal(windowBoundsMatch({ width: 1528 + WINDOW_BOUNDS_TOLERANCE + 1, height: 732 }, want), false);
  // 故障当天的那个尺寸必须判**不**达标 —— 否则这条判据放过了它自己。
  assert.equal(windowBoundsMatch({ width: 692, height: 307 }, want), false);
  // 读不到 ⇒ 不达标（与视口闸门同一条纪律：读不到不等于没事）。
  assert.equal(windowBoundsMatch(null, want), false);
  assert.equal(windowBoundsMatch({ width: null, height: 732 }, want), false);
  assert.equal(windowBoundsMatch({ width: 1528 }, want), false);
});

test('描述串：把状态带上（maximized 与 normal 在诊断里是两件事）', () => {
  assert.equal(describeWindowBounds({ width: 1528, height: 732, left: 40, top: 40 }), '1528x732 @40,40');
  assert.match(describeWindowBounds({ windowState: 'maximized', width: 1528, height: 732, left: 0, top: 0 }),
    /^maximized 1528x732/u);
  assert.equal(describeWindowBounds(null), '(读不到)');
});

test('失败契约：CDP 连不上 ⇒ 如实报 CDP_UNREACHABLE，**不抛**（不许把「窗口小」升级成「实例起不来」）', async () => {
  // 端口 1：连接立即被拒。不碰任何登记端口、更不碰任何真实例。
  const result = await applyWindowBounds({ port: 1, timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CDP_UNREACHABLE');
  assert.equal(result.changed, false);
  assert.match(result.detail, /连不上/u);
});

test('失败契约：/json/version 里没有 websocket 地址 ⇒ 同样算连不上（不当成「设成功」）', async () => {
  const server = await fakeCdp({ version: {} });
  try {
    const result = await applyWindowBounds({ port: server.port, timeoutMs: 1500 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CDP_UNREACHABLE');
  } finally { await server.close(); }
});

test('失败契约：一个 page 页签都没有 ⇒ NO_PAGE_TARGET（没有可定位的窗口，不猜）', async () => {
  const server = await fakeCdp({ list: [{ id: 'w1', type: 'service_worker' }] });
  try {
    const result = await applyWindowBounds({ port: server.port, timeoutMs: 1500 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_PAGE_TARGET');
    assert.match(result.detail, /一个 page 页签都没有/u);
  } finally { await server.close(); }
});

test('失败契约：websocket 连不上 ⇒ SET_FAILED（这一步**绝不**返回「成功」）', async () => {
  // 假 CDP 给的 websocket 指向端口 1（必然连不上）⇒ 会话打不开 ⇒ 走 SET_FAILED 那一档。
  const server = await fakeCdp({ list: [{ id: 'p1', type: 'page', url: 'about:blank' }] });
  try {
    const result = await applyWindowBounds({ port: server.port, timeoutMs: 1500 });
    assert.equal(result.ok, false);
    assert.ok(['SET_FAILED', 'CDP_UNREACHABLE'].includes(result.reason),
      `应当如实报失败，实际 ${result.reason}`);
    assert.equal(result.ok, false, '「设不成」永远不许被报成成功');
  } finally { await server.close(); }
});

test('接线①：只有共用商家浏览器（dailyReport）会被归位，店铺与竞品实例一律不动', () => {
  const src = readSource('runtime/start-project-browser.mjs');
  const helper = src.slice(src.indexOf('async function normalizeSharedWindow('), src.indexOf('// 同一个 profile 是否已经在'));
  assert.match(helper, /if \(BROWSER_KEY !== 'dailyReport'\) return;/u,
    '归位必须点名那一台实例：店铺实例的尺寸已经由 argv 钉死（并另有视口闸门复核），'
    + '竞品链不在本次故障的范围内 —— 顺手改它们是「没有证据支持的变更」');
  assert.match(helper, /applyWindowBounds\(\{ port: PORT \}\)/u,
    '要用浏览器级 CDP 设 bounds（写死坐标或改 argv 都是另一条路）');
  // 失败**不许**把启动器带崩：抛出去会把「窗口小」升级成「实例起不来」。
  assert.doesNotMatch(helper, /throw /u, '归位这一步不许往外抛 —— 它不是闸门');
  assert.match(helper, /console\.warn/u, '失败至少要留下一条能读的话（静默失败正是这次事故的形态）');
});

test('接线②：两个分支（REUSE 与 READY）都要归位 —— 只接一处就会漏掉一半的现场', () => {
  const src = readSource('runtime/start-project-browser.mjs');
  const call = 'await normalizeSharedWindow();';
  const at = [];
  for (let i = src.indexOf(call); i >= 0; i = src.indexOf(call, i + 1)) at.push(i);
  assert.equal(at.length, 2, `归位应当在这两处各调一次（REUSE / READY），实际 ${at.length} 处`);
  // REUSE 分支（那台实例已经在跑、只是窗口小）必须也归位 —— 这正是当天 10:52 手工修法的那条路：
  // 那时实例是活的，只是窗口被夹窄了，重启它反而会把登录态连同窗口一起丢掉。
  const reuse = src.indexOf("REUSE ${describeOccupant");
  const ready = src.indexOf('READY ${v.Browser}');
  assert.ok(reuse > 0 && ready > 0, '找不到 REUSE / READY 那两行（改代码时请同步这条判据）');
  assert.ok(at[0] > reuse && at[1] > ready, 'REUSE 与 READY 之后各要有一次归位');
  assert.ok(at[0] < ready, '第一处归位应当在 REUSE 分支里（不是都堆在 READY 后面）');
});

test('接线③：归位**不动 argv**（那两条老命令行的 argv 是防串号的，不许为这件事拆掉）', () => {
  // 归位走的是「起后用 CDP 设 bounds」，所以启动参数照旧由 buildBrowserLaunchArgs 拼，
  // 且没有任何一处往它里面塞 --window-size。
  const src = readSource('runtime/start-project-browser.mjs');
  const launch = src.slice(src.indexOf('const launchArgs = buildBrowserLaunchArgs'), src.indexOf('const child = spawn('));
  assert.doesNotMatch(launch, /--window-size|--force-device-scale-factor/u,
    '启动参数里不许出现这两个开关 —— 它们只属于店铺 profile（SHOP_BROWSER_EXTRA_ARGS）');
  const ports = readSource('runtime/browser-ports.mjs');
  // 两个老浏览器的 extraArgs 恒为空（这一条由 browser-ports.test.mjs 更严格地断言，
  // 这里只做一次交叉引用，防止有人把归位「顺手」改成改 argv）。
  assert.match(ports, /SHOP_BROWSER_EXTRA_ARGS/u);
});
