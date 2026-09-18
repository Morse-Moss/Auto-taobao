// 窗口标签页的离线用例。纯函数全测；`ensureLabelTabOn` 用注入的假 fetch 测「幂等」与「堆了多个就停手」——
// 这两条是它唯一会改浏览器状态的地方，必须能离线复现。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  LABEL_PAGE_NAME, LABEL_PAGE_PATH, LOGIN_PAGE_PATTERNS, PRUNE_POLICY, TAB_KINDS, WINDOW_TITLE_SUFFIX,
  classifyShopTabs, describeTab, ensureLabelTabOn, isLabelTab, labelPageUrlFor, leftoverTabs, loginStateHint,
  looksLikeLoginPage, parseCli, prunePlan, pruneTabsOn, tabKindOf, windowTitleFor,
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
  // 关掉的 target 要从后续 `/targets` 里消失 —— 假代理必须模拟「关掉之后的世界」，
  // 否则 `pruneTabsOn` 的回读校验（不信 HTTP 200）会认为「一个都没关掉」，
  // 用例就会红在一个假问题上。
  const closed = new Set();
  return async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? 'GET' });
    if (href.endsWith('/targets')) {
      const visible = targets.filter((t) => !closed.has(t.targetId));
      return { ok: true, status: 200, json: async () => visible, text: async () => JSON.stringify(visible) };
    }
    if (href.includes('/navigate')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    if (href.includes('/new')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"targetId":"new-1"}' };
    }
    if (href.includes('/close')) {
      closed.add(new URL(href).searchParams.get('target'));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    if (href.includes('/bringToFront')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    throw new Error(`假代理没覆盖这个地址：${url}`);
  };
}

// 顽固假代理：`/close` 一律回 `{"success":true}`，但页面**根本不消失**。
// 这就是 `edge://nurturing/` 在真机上的行为（2026-09-18 深夜实测）。
function fakeProxyStubborn({ targets, calls }) {
  return async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? 'GET' });
    if (href.endsWith('/targets')) {
      return { ok: true, status: 200, json: async () => targets, text: async () => JSON.stringify(targets) };
    }
    if (href.includes('/close')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"success":true}' };
    }
    throw new Error(`顽固假代理没覆盖这个地址：${url}`);
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

// ---------------------------------------------------------------------------
// 标签页 URL 与页面之间的接线（第三个「契约齐、测试绿、接线没接上」的实例）
// ---------------------------------------------------------------------------
// 原判据只断言了 `document.title = shop` 与 `id="shop"`，于是**状态行那一段完全没人守**：
// 把 HTML 里 `q.get('state')` 改名、或把 `state` 分支整段删掉，测试照样全绿，
// 而「需要登录」在页面上永远不会出现 —— 症状是「照着做也看不到提示」，没有任何报错。

test('标签页 URL 的参数名必须与页面读的参数名一一对得上', () => {
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  const read = new Set([...html.matchAll(/\.get\('([A-Za-z]+)'\)/gu)].map((m) => m[1]));
  // 用「状态齐全」的那一份 URL 来算脚本会写哪些键（`ok` 只在 true 时才写，所以要用 ok:true 取样）
  const written = new Set(new URL(labelPageUrlFor({
    shop: '盖文淘宝', port: 19033, state: '需要登录', ok: true,
  })).searchParams.keys());

  for (const key of written) {
    assert.ok(read.has(key), `脚本写了 ?${key}= 但页面里没有任何地方读它 ⇒ 这一格永远是空的`);
  }
  for (const key of read) {
    assert.ok(written.has(key), `页面里读了 ?${key}= 但脚本从不写它 ⇒ 页面拿到的是 null`);
  }
  assert.deepEqual([...read].sort(), ['ok', 'port', 'shop', 'state'].sort());
});

test('登录状态必须真的落到页面元素上，且是「量到才显示」', () => {
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  assert.ok(html.includes('id="state"'), '页面上没有显示登录状态的地方');
  assert.match(html, /getElementById\('state'\)[\s\S]{0,200}textContent/u,
    '登录状态没有写进页面元素 ⇒ 窗口上还是看不出这家店要不要登录');
  assert.match(html, /if\s*\(state\)/u,
    '状态行必须是有条件的：没量到就整行不显示（不能显示空行或占位）');
  // 反例：无条件显示会让四台窗口上出现一行空白状态，等于又回到「看不出来」
  assert.equal(/class="s[^"]*"[^>]*>\s*需要登录/u.test(html), false,
    '状态不许写死在 HTML 里 —— 那是「四台都写着需要登录」，比不写更坏');
});

// ---------------------------------------------------------------------------
// 清理计划：哪些页签可以关
// ---------------------------------------------------------------------------
//
// 真实清单（19034 科塔淘宝，2026-09-18 深夜实测）：千牛三个（其中两个逐字相同的 myseller）、
// 空白页一个、工作页两个。它就是要被清的那一台。

const REAL_KE_TA = [
  { type: 'page', targetId: 'k1', url: 'https://loginmyseller.taobao.com/?from=&f=top&redirect_url=x' },
  { type: 'page', targetId: 'k2', url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' },
  { type: 'page', targetId: 'b1', url: 'about:blank' },
  { type: 'page', targetId: 'k3', url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' },
  { type: 'page', targetId: 'a1', url: 'https://one.alimama.com/index.html#!/login/index' },
  { type: 'page', targetId: 's1', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
];

test('清理计划：19034 那台实测清单 —— 关掉多余千牛与空白页，工作页一个不动', () => {
  const plan = prunePlan(classifyShopTabs(REAL_KE_TA));
  assert.deepEqual(plan.close.map((t) => t.targetId).sort(), ['b1', 'k2', 'k3'],
    '该关的是两个多余千牛 + 空白页');
  assert.deepEqual(plan.keep.map((t) => t.targetId).sort(), ['a1', 'k1', 's1'],
    '工作页与「第一个千牛」必须留下');
});

test('清理计划：19032 那台（已有标签页）——标签页只留一个，不被当成重复清掉', () => {
  const plan = prunePlan(classifyShopTabs([...REAL_WANG_LIN, { type: 'page', targetId: 'b9', url: 'about:blank' }]));
  assert.equal(plan.keep.some((t) => t.kind === 'label'), true, '唯一的标签页被清掉了 —— 那会让窗口又变成认不出');
  assert.equal(plan.close.some((t) => t.kind === 'work'), false, '工作页不该被清');
  assert.equal(plan.close.some((t) => t.kind === 'qianniu'), false, '首个千牛该留下');
  assert.deepEqual(plan.close.map((t) => t.targetId), ['b9'], '这台只该关掉那个空白页');
});

test('清理计划：同一个后台的两个页面都要关掉一个 —— 那不是「看着乱」，是会让判据直接失败', () => {
  // 链的判据是「这个后台恰好一个页面」。两个的时候 `expected one ... got 2` ⇒ 整家店停在第一步。
  const plan = prunePlan(classifyShopTabs([
    { type: 'page', targetId: 's1', url: 'https://sycm.taobao.com/a' },
    { type: 'page', targetId: 's2', url: 'https://sycm.taobao.com/b' },
    { type: 'page', targetId: 'a1', url: 'https://one.alimama.com/index.html' },
  ]));
  assert.deepEqual(plan.close.map((t) => t.targetId), ['s2']);
  assert.deepEqual(plan.keep.map((t) => t.targetId).sort(), ['a1', 's1']);
});

test('清理计划的安全阀：任何「必须保留一个」的类只要存在，就至少留一个（永不把某类清空）', () => {
  // 安全阀只对 `keepFirst: true` 的那些类生效 —— 空白页/无关页本来就该全关，
  // 把它们也要求「留一个」是判据写错（这一条踩过）。
  const mustKeep = Object.entries(PRUNE_POLICY).filter(([, p]) => p.keepFirst).map(([k]) => k);
  assert.ok(mustKeep.includes('work') && mustKeep.includes('label'));
  for (const targets of [REAL_KE_TA, REAL_WANG_LIN, REAL_SUI_XIN]) {
    const classified = classifyShopTabs(targets);
    const plan = prunePlan(classified);
    for (const kind of new Set(classified.map((t) => t.kind))) {
      if (!mustKeep.includes(kind)) continue;
      assert.ok(plan.keep.some((t) => t.kind === kind), `${kind} 这一类被清空了 —— 安全阀失效`);
    }
  }
  // 每一类都必须有明确策略（新增一类却忘了写策略时，会静默按 other 全关）
  for (const kind of Object.keys(TAB_KINDS)) {
    assert.ok(PRUNE_POLICY[kind], `${kind} 没有清理策略 —— 会静默按 other 处理`);
  }
});

test('清理默认不开：不带 --prune 时它就不该存在这个动作', () => {
  assert.equal(parseCli([]).prune, false);
  assert.equal(parseCli(['--commit']).prune, false, '--commit 只授权「挂标签页」，不授权「关页签」');
  assert.equal(parseCli(['--prune']).prune, true);
  assert.throws(() => parseCli(['--prune-more']), /Unknown argument/u);
  assert.throws(() => parseCli(['--only']), /--only requires a value/u);
});

test('pruneTabsOn 默认是干跑：一次 /close 都不发', async () => {
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19044', fetchImpl: fakeProxy({ targets: REAL_KE_TA, calls }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.closed.length, 0);
  assert.equal(calls.filter((c) => c.url.includes('/close')).length, 0, '干跑竟然关东西了');
  assert.equal(result.plan.close.length, 3, '干跑也要把计划如实报出来');
});

test('pruneTabsOn 真跑：只关计划里的那三个，工作页一个都不碰', async () => {
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19044', dryRun: false, fetchImpl: fakeProxy({ targets: REAL_KE_TA, calls }),
  });
  const closedIds = calls.filter((c) => c.url.includes('/close'))
    .map((c) => new URL(c.url).searchParams.get('target')).sort();
  assert.deepEqual(closedIds, ['b1', 'k2', 'k3']);
  for (const keep of ['a1', 'k1', 's1']) {
    assert.equal(closedIds.includes(keep), false, `工作页/首个千牛 ${keep} 被关掉了`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.closed.length, 3);
});

// ---------------------------------------------------------------------------
// 「一个开关管两件事」踩过；「停在登录页看不出是登录页」也踩过
// ---------------------------------------------------------------------------
//
// 2026-09-18 深夜实测：`--prune --commit` 把「清页签」与「挂标签页」两件事一起做了，
// 我原计划「先清 → 量内存 → 再挂」的中间那次内存对照里混进了 2 个新建标签页，收益数字直接作废。
//
// 同一轮实测还拿到：19033 盖文淘宝的两个工作页**都停在登录页**（用户说「也没有登录」就是这件事），
// 但按主机分类它们必然是 `work`，报告里显示成「工作页（链路要用）」—— 人眼完全看不出这家没登录。

const REAL_SUI_XIN_LOGGED_OUT = [
  {
    type: 'page',
    targetId: 's1',
    url: 'https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
  },
  { type: 'page', targetId: 'a1', url: 'https://one.alimama.com/index.html#!/login/index' },
];

test('--prune 是独占意图：带它就只清页签，不会顺手把标签页也挂了', () => {
  assert.equal(parseCli([]).label, true, '不带 --prune 时默认就是挂标签页');
  assert.equal(parseCli(['--commit']).label, true);
  assert.equal(parseCli(['--prune']).label, false, '--prune 之下不该再有挂标签页这个动作');
  assert.equal(parseCli(['--prune', '--commit']).label, false,
    '就是这条：两件事被一个 --commit 一起触发，会让「先清、量、再挂」无法分开下达');
  assert.equal(parseCli(['--label', '--prune', '--commit']).label, true, '要两件一起做必须显式写 --label');
  assert.equal(parseCli(['--label']).label, true);
});

test('登录页识别：对着实测的两种登录页 URL 为真，正常工作页为假', () => {
  for (const url of REAL_SUI_XIN_LOGGED_OUT.map((t) => t.url)) {
    assert.equal(looksLikeLoginPage(url), true, `这明明是登录页：${url}`);
  }
  for (const url of ['https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
    'https://one.alimama.com/index.html', 'https://one.alimama.com/index.html#!/report/download-list']) {
    assert.equal(looksLikeLoginPage(url), false, `这不是登录页：${url}`);
  }
  assert.ok(LOGIN_PAGE_PATTERNS.length > 0);
});

test('停在登录页的后台页面仍然是 work —— 改成 loginPage 会让窗口少一个后台页面', () => {
  // 分组键对 work 是按主机、对其它 kind 是按 kind。若把这两个页面改成 loginPage，
  // 它们会被合成一组只留一个 ⇒ 窗口只剩一个后台页面，而 SOP 的判据是「每个后台恰好一个」。
  const classified = classifyShopTabs(REAL_SUI_XIN_LOGGED_OUT);
  assert.deepEqual(classified.map((t) => t.kind), ['work', 'work']);
  assert.deepEqual(classified.map((t) => t.loggedOut), [true, true]);
  const plan = prunePlan(classified);
  assert.equal(plan.close.length, 0, '两个后台页面都必须留下，一个都不能关');
  assert.equal(plan.keep.length, 2);
});

test('这家店没登录这件事必须落在人看的那一行上，而不是只挂在对象字段里', () => {
  const classified = classifyShopTabs(REAL_SUI_XIN_LOGGED_OUT);
  const shown = classified.map(describeTab).join('\n');
  assert.ok(shown.includes('还没登录'), `报告的行里必须有这句：\n${shown}`);
  assert.equal(shown.includes('登录页'), true);
  // 正常的窗口不该被加上这句（否则每台都写着「没登录」，等于没提示）
  const healthy = classifyShopTabs([
    { type: 'page', targetId: 's', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
  ]).map(describeTab).join('\n');
  assert.equal(healthy.includes('还没登录'), false);
});

test('没证据时不许说「已登录」：URL 不是登录页 ≠ 会话有效', () => {
  const healthy = classifyShopTabs([
    { type: 'page', targetId: 's', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
    { type: 'page', targetId: 'a', url: 'https://one.alimama.com/index.html' },
    { type: 'page', targetId: 'q', url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' },
  ]);
  assert.equal(loginStateHint(healthy), null, '没有正面证据时必须是「不给值」，让状态行整个不显示');
  assert.equal(loginStateHint([]), null);
  const hint = loginStateHint(classifyShopTabs(REAL_SUI_XIN_LOGGED_OUT));
  assert.equal(hint.state, '需要登录');
  assert.equal(hint.ok, false);
  assert.deepEqual(hint.sites.sort(), ['one.alimama.com', 'sycm.taobao.com']);
  // 这条判据守着那个已经犯过两次的错误：把「尚未触发」写成「不需要」。
  const allStates = [loginStateHint(healthy), loginStateHint(classifyShopTabs(REAL_SUI_XIN_LOGGED_OUT))]
    .filter(Boolean).map((h) => h.state);
  for (const state of allStates) assert.notEqual(state, '已登录');
});

test('浏览器自带的页面单列一类（不塞进「其它页面」，那等于没说），且不进关闭计划', () => {
  assert.equal(tabKindOf('edge://nurturing/'), 'browserPage');
  assert.equal(TAB_KINDS.browserPage.needed, false);
  assert.equal(PRUNE_POLICY.browserPage.unclosable, true,
    '实测 /close 对它返回 success 但页面不消失 ⇒ 必须标成关不掉');
  assert.equal(PRUNE_POLICY.browserPage.keepFirst, undefined,
    '关不掉的类不该再挂「保留第一个」这套说法 —— 那会让人以为这里做过取舍');
  const plan = prunePlan(classifyShopTabs([
    { type: 'page', targetId: 'n', url: 'edge://nurturing/' },
    { type: 'page', targetId: 's', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
  ]));
  assert.deepEqual(plan.close, [], '把关不掉的页面列进关闭计划 = 每轮报一个假动作');
  assert.deepEqual(plan.keep.map((t) => t.targetId).sort(), ['n', 's']);
  assert.equal(plan.keep.find((t) => t.targetId === 'n').unclosable, true, '报告里要能看出它是关不掉的');
});

test('关完必须回读：/close 报成功但页面还在 ⇒ 进 failed，不许当成功', async () => {
  // 这是 2026-09-18 深夜在真机上撞到的：`/close` 回 `{"success":true}`，
  // 3 秒后回读同一个 targetId 仍在。只信返回码，清理报告就会写「关掉了」而事实没变。
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19041', dryRun: false,
    fetchImpl: fakeProxyStubborn({ targets: REAL_KE_TA, calls }),
  });
  assert.equal(result.closed.length, 0, '一个都没真的消失，closed 必须是空的');
  assert.equal(result.failed.length, 3, '三个都该进 failed');
  assert.equal(result.ok, false, '没达成就是没达成');
  assert.equal(result.attempted.length, 3, '尝试过几个也要如实报出来');
  for (const item of result.failed) assert.match(item.error, /回读/u);
});

test('回读校验不能把真关掉的也判成失败（否则 cleaned 永远为空，等于没清理）', async () => {
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19044', dryRun: false,
    fetchImpl: fakeProxy({ targets: REAL_KE_TA, calls }),
  });
  assert.deepEqual(result.closed.map((t) => t.targetId).sort(), ['b1', 'k2', 'k3']);
  assert.deepEqual(result.failed, []);
  assert.equal(result.ok, true);
});

test('「是否停在登录页」只影响提示，不影响清理处置（改提示不该有副作用）', () => {
  const loggedIn = [
    { type: 'page', targetId: 's1', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
    { type: 'page', targetId: 'a1', url: 'https://one.alimama.com/index.html' },
    { type: 'page', targetId: 'b1', url: 'about:blank' },
  ];
  const loggedOut = [
    { type: 'page', targetId: 's1', url: 'https://sycm.taobao.com/custom/login.htm?_target=x' },
    { type: 'page', targetId: 'a1', url: 'https://one.alimama.com/index.html#!/login/index' },
    { type: 'page', targetId: 'b1', url: 'about:blank' },
  ];
  const a = prunePlan(classifyShopTabs(loggedIn));
  const b = prunePlan(classifyShopTabs(loggedOut));
  assert.deepEqual(b.close.map((t) => t.targetId), a.close.map((t) => t.targetId),
    '登录与否不该改变清理计划 —— 否则「只是加了个提示」会静默改掉处置');
  assert.deepEqual(b.keep.map((t) => t.targetId), a.keep.map((t) => t.targetId));
});
