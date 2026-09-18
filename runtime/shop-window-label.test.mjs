// 窗口标签页的离线用例。纯函数全测；`ensureLabelTabOn` 用注入的假 fetch 测「幂等」与「堆了多个就停手」——
// 这两条是它唯一会改浏览器状态的地方，必须能离线复现。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  LABEL_PAGE_NAME, LABEL_PAGE_PATH, TAB_KINDS, WINDOW_TITLE_SUFFIX, classifyShopTabs, ensureLabelTabOn,
  isLabelTab, labelPageUrlFor, leftoverTabs, tabKindOf, windowTitleFor,
} from './shop-window-label.mjs';
import { SHOP_BROWSERS } from './browser-ports.mjs';

// 真实页签清单：逐字取自 evidence/multi-shop-run-2026-09-18/15-identity-recheck.txt（2026-09-18 实测）。
// 用实测值而不是编的 URL，是为了让分类判据真的对着现场。
const REAL_WANG_LIN = [
  { type: 'page', targetId: 'a', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
  { type: 'page', targetId: 'b', url: 'https://one.alimama.com/index.html#!/report/download-list' },
  { type: 'page', targetId: 'c', url: 'file:///D:/Retire/edge-profiles/_window-label.html?shop=%E7%BD%91%E6%9E%97&port=19032' },
  { type: 'page', targetId: 'd', url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' },
];
const REAL_SUI_XIN = [
  { type: 'page', targetId: 'a', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
  { type: 'page', targetId: 'b', url: 'https://one.alimama.com/index.html#!/report/download-list' },
  { type: 'page', targetId: 'c', url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' },
  { type: 'page', targetId: 'd', url: 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao' },
];

test('窗口标题必须带店名：四家店的标题互不相同（否则收信人到了机器前还是要猜）', () => {
  const titles = Object.keys(SHOP_BROWSERS).map(windowTitleFor);
  assert.equal(new Set(titles).size, titles.length, `标题必须互不相同，实际：${titles.join(' / ')}`);
  assert.equal(windowTitleFor('盖文淘宝'), `盖文淘宝${WINDOW_TITLE_SUFFIX}`);
  for (const title of titles) assert.ok(title.trim().length > 0);
});

test('没有店名的标题一律抛错，不给一个「看起来标过了」的默认标题', () => {
  for (const bad of [null, undefined, '', '   ']) assert.throws(() => windowTitleFor(bad), /需要一个店名/u);
});

test('标签页 URL：中文店名要编码、端口带上、没量到状态就整条不带 state', () => {
  const url = labelPageUrlFor({ shop: '盖文淘宝', port: 19033, pagePath: 'D:/x/shop-window-label.html' });
  assert.match(url, /^file:\/\/\/D:\/x\/shop-window-label\.html\?/u, 'Windows 盘符要转成 file:/// 形式');
  assert.ok(url.includes(encodeURIComponent('盖文淘宝')), '中文店名必须编码');
  assert.ok(url.includes('port=19033'));
  assert.equal(url.includes('state='), false, '没量到登录状态时不该带 state —— 不写占位，那会让人以为量过了');
  assert.equal(url.includes('ok='), false);
});

test('标签页 URL：量到状态才带 state，并且只有 ok===true 才带 ok=1', () => {
  const bad = labelPageUrlFor({ shop: '科塔淘宝', state: '需要登录', ok: false });
  assert.ok(bad.includes(`state=${encodeURIComponent('需要登录')}`));
  assert.equal(bad.includes('ok='), false, 'ok 为 false 不是「已知状态为假」，是「这一格不该显示为绿」');
  const good = labelPageUrlFor({ shop: '科塔淘宝', state: '已登录', ok: true });
  assert.ok(good.includes('ok=1'));
});

test('页签分类：对着 2026-09-18 实测的两种窗口，必需/残留分得开', () => {
  const wangLin = classifyShopTabs(REAL_WANG_LIN);
  assert.equal(wangLin.filter((t) => t.kind === 'work').length, 2, '生意参谋 + 阿里妈妈是链路要用的');
  assert.equal(wangLin.filter((t) => t.kind === 'label').length, 1);
  assert.equal(wangLin.filter((t) => t.kind === 'qianniu').length, 1);
  assert.deepEqual(leftoverTabs(wangLin).map((t) => t.kind), ['qianniu'],
    '19032 那台除了千牛，没有别的残留');

  const suiXin = classifyShopTabs(REAL_SUI_XIN);
  assert.equal(suiXin.filter((t) => t.kind === 'work').length, 2);
  assert.equal(suiXin.filter((t) => t.kind === 'label').length, 0, '19033 当时**没有**标签页 —— 这就是要补的那件事');
  assert.deepEqual(leftoverTabs(suiXin).map((t) => t.kind).sort(), ['loginPage', 'qianniu']);
});

test('页签分类：工作页与标签页永远不算残留（否则整理页签会把链路要用的关掉）', () => {
  for (const kind of ['work', 'label']) {
    assert.equal(TAB_KINDS[kind].needed, true, `${kind} 必须标成必需`);
  }
  const tabs = classifyShopTabs([
    ...REAL_WANG_LIN,
    { type: 'page', targetId: 'e', url: 'about:blank' },
    { type: 'page', targetId: 'f', url: 'https://www.taobao.com/' },
  ]);
  const leftover = leftoverTabs(tabs).map((t) => t.kind).sort();
  assert.deepEqual(leftover, ['blank', 'other', 'qianniu']);
  assert.equal(classifyShopTabs([{ type: 'page', url: 'about:blank' }])[0].label, TAB_KINDS.blank.label);
});

test('isLabelTab：认仓库内那份，也认机器上遗留的旧文件名（不把它们当成两个不同标签页）', () => {
  assert.equal(isLabelTab(`file:///D:/a/${LABEL_PAGE_NAME}?shop=x`), true);
  assert.equal(isLabelTab('file:///D:/Retire/edge-profiles/_window-label.html?shop=x'), true,
    '2026-09-18 之前挂在 19032/19033 上的就是这个名字，必须认，否则会越堆越多');
  assert.equal(isLabelTab('https://sycm.taobao.com/'), false);
});

// ---------------------------------------------------------------------------
// IO：注入假 fetch，把「幂等」与「堆了多个就停手」钉住
// ---------------------------------------------------------------------------

function fakeProxy({ targets, calls }) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/targets')) {
      return { ok: true, status: 200, json: async () => targets, text: async () => JSON.stringify(targets) };
    }
    if (String(url).includes('/navigate')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    if (String(url).includes('/new')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"targetId":"new-1"}' };
    }
    throw new Error(`假代理没覆盖这个地址：${url}`);
  };
}

// 代理的两个入口都把「目标地址」当查询参数（`?url=<再编码一次>`），所以取回来要解一层才能看内容。
// 两层编码的对应关系容易搞错，踩过两次，写在这里：
//   代理地址里是 `...url=file%3A%2F%2F...%3Fshop%3D%25E9%2587%258C...`
//   `URLSearchParams.get('url')` **已经解了一层** ⇒ 得到 `file:///...?shop=%E9%87%8C...`
//   ⇒ 再对结果比对「店名的单层编码」才成立；**不要再 decodeURIComponent 一次**（那会解过头）。
const targetUrlOf = (call) => new URL(call.url).searchParams.get('url') ?? '';

test('挂标签页是幂等的：已经有一个就导航它，绝不新建第二个（否则每次都多一个页签）', async () => {
  const calls = [];
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19041',
    shop: '里可林淘宝',
    port: 19031,
    fetchImpl: fakeProxy({ targets: REAL_WANG_LIN, calls }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.targetId, 'c');
  assert.equal(calls.filter((c) => c.url.includes('/new')).length, 0, '已经有标签页时不该新建');
  const navigated = calls.filter((c) => c.url.includes('/navigate'));
  assert.equal(navigated.length, 1);
  assert.ok(targetUrlOf(navigated[0]).includes(encodeURIComponent('里可林淘宝')));
});

test('没有标签页时才新建一个，且建出来的是这家店的标签页', async () => {
  const calls = [];
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19043',
    shop: '盖文淘宝',
    port: 19033,
    fetchImpl: fakeProxy({ targets: REAL_SUI_XIN, calls }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  const created = calls.find((c) => c.url.includes('/new'));
  assert.ok(created, '没有标签页时必须新建');
  assert.ok(targetUrlOf(created).includes(encodeURIComponent('盖文淘宝')));
  assert.equal(calls.filter((c) => c.url.includes('/navigate')).length, 0, '没有可导航的目标时不该去导航别的页面');
});

test('堆了多个标签页就停手：既不导航也不新建（关哪一个都是替人做决定）', async () => {
  const calls = [];
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19041',
    shop: '里可林淘宝',
    fetchImpl: fakeProxy({
      targets: [...REAL_WANG_LIN, { type: 'page', targetId: 'z', url: `file:///D:/a/${LABEL_PAGE_NAME}?shop=x` }],
      calls,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /堆了 2 个标签页/u);
  assert.equal(calls.length, 1, '只该读一次 /targets，之后的动作一概不做');
});

test('仓库里那份标签页真的把店名写进了 window.title（这是它唯一真正起作用的地方）', () => {
  assert.ok(existsSync(LABEL_PAGE_PATH), `标签页文件不在仓库里：${LABEL_PAGE_PATH}`);
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  assert.ok(/document\.title\s*=\s*shop/u.test(html),
    '标签页没把店名写进 document.title ⇒ 任务栏里四个窗口还是一模一样，告警里那句「找标题写着 X 的窗口」就落空了');
  assert.ok(html.includes('id="shop"'), '标签页没有大字显示店名的地方');
});
