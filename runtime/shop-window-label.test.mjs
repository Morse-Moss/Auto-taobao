// 窗口标签页的离线用例。纯函数全测；`ensureLabelTabOn` 用注入的假 fetch 测「幂等」与「堆了多个就停手」——
// 这两条是它唯一会改浏览器状态的地方，必须能离线复现。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  LABEL_PAGE_NAME, LABEL_PAGE_PATH, LOGIN_PAGE_PATTERNS, PRUNE_POLICY, TAB_KINDS, WINDOW_TITLE_SUFFIX,
  classifyShopTabs, describeTab, ensureLabelTabOn, isLabelTab, labelPageUrlFor, leftoverTabs, loginStateHint,
  looksLikeLoginPage, memberNameFor, memberVerdictFor, parseCli, prunePlan, pruneTabsOn,
  readLoggedInMemberOn, tabKindOf, windowTitleFor,
} from './shop-window-label.mjs';
import { SHOP_BROWSERS } from './browser-ports.mjs';
import { SHOP_IDENTITIES } from '../skills/sycm-alimama-daily-report/scripts/shop-identities.mjs';
// 只读「页面实际登的是谁」用的表达式。**必须从采集链那一份 import**：本用例有一条断言
// 把「脚本发的 body 逐字等于它」钉住 —— 另写一份选择器在这里就当场红。
import { alimamaIdentityExpression } from '../skills/sycm-alimama-daily-report/scripts/collect-core.mjs';

// 标签页 URL 的参数名**全量**（已排序）。两处判据都用它：
//   · 「脚本写了 ?k= 但页面从不读它」⇒ 这一格永远是空的；
//   · 「页面读了 ?k= 但脚本从不写它」⇒ 页面拿到的是 null。
// 写成一份共享常量而不是各写一行字面量：否则新增参数时只改一处，另一处会**静默**放过。
const LABEL_URL_KEYS = ['actual', 'member', 'ok', 'port', 'shop', 'state'];

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

function fakeProxy({ targets, calls, evalReading, evalStatus = 200 }) {
  // 关掉的 target 要从后续 `/targets` 里消失 —— 假代理必须模拟「关掉之后的世界」，
  // 否则 `pruneTabsOn` 的回读校验（不信 HTTP 200）会认为「一个都没关掉」，
  // 用例就会红在一个假问题上。
  const closed = new Set();
  return async (url, init = {}) => {
    const href = String(url);
    // body 也记下来：`/eval` 的 body 就是那条表达式，而「读法用的是不是采集链那一份」
    // 只能从 body 上验（只记 url 的话，两套选择器里哪一套都查不出来）。
    calls.push({ url: href, method: init.method ?? 'GET', body: init.body ?? null });
    if (href.endsWith('/targets')) {
      const visible = targets.filter((t) => !closed.has(t.targetId));
      return { ok: true, status: 200, json: async () => visible, text: async () => JSON.stringify(visible) };
    }
    if (href.includes('/eval')) {
      // 真代理回 `{value: '<表达式自己 stringify 的那层 JSON>'}`（见 cdp-proxy.mjs 的 /eval，
      // 表达式是 collect-core 的 alimamaIdentityExpression）。**两层包装必须照真代理的样子来**：
      // 只回一层的话，脚本里的「解两层」会静默解不出来 → 实际值永远是 null → 页面上那一行
      // 永远空着，而离线用例照样全绿。这正是本仓库反复吃过的「假绿灯」。
      if (evalStatus !== 200) {
        const body = JSON.stringify({ error: `Runtime.evaluate 失败（假代理 status=${evalStatus}）` });
        return { ok: false, status: evalStatus, json: async () => JSON.parse(body), text: async () => body };
      }
      const reading = evalReading ?? {
        href: 'https://one.alimama.com/index.html', memberName: null, memberId: null, raw: null,
      };
      const payload = JSON.stringify({ value: JSON.stringify(reading) });
      return { ok: true, status: 200, json: async () => JSON.parse(payload), text: async () => payload };
    }
    if (href.includes('/navigate')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    if (href.includes('/new')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"targetId":"new-1"}' };
    }
    if (href.includes('/pin')) {
      // 真代理回 `{"pinned":true,"targetId":...}`（见 cdp-proxy.mjs 的 /pin 端点）。
      // 假代理这里必须也认这个地址：不认的话 pinLabelTab 会走到它的 catch 分支，
      // 于是「有没有钉住」这件事在离线用例里被静默吞掉 —— 见下面那条专门断言它的用例。
      return { ok: true, status: 200, json: async () => ({ pinned: true }), text: async () => '{"pinned":true}' };
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

// 慢一拍假代理：`/close` 之后的**第一遍**回读仍然列出它，第二遍才没有。
// 这就是真机上的行为（2026-09-20 实测：`about:blank` 从 `/close` 到从 `/targets` 消失要 270ms；
// 采样 8ms 还在 → 270ms 已消失）。回读只做一遍时，这一拍会把成功的关闭报成失败。
function fakeProxySlowDisappear({ targets, calls }) {
  const closed = new Set();
  let postCloseReads = 0;
  return async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? 'GET' });
    if (href.endsWith('/targets')) {
      if (closed.size > 0) postCloseReads += 1;
      // 第 1 遍仍然列着（CDP 还没摘掉），第 2 遍起才消失。
      const visible = targets.filter((t) => !(closed.has(t.targetId) && postCloseReads >= 2));
      return { ok: true, status: 200, json: async () => visible, text: async () => JSON.stringify(visible) };
    }
    if (href.includes('/close')) {
      closed.add(new URL(href).searchParams.get('target'));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"success":true}' };
    }
    throw new Error(`慢一拍假代理没覆盖这个地址：${url}`);
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
    shop: '盖文淘宝', port: 19033, state: '需要登录', ok: true, member: '随心品质定制:阿彦',
    actual: '随心品质定制:阿彦',
  })).searchParams.keys());

  for (const key of written) {
    assert.ok(read.has(key), `脚本写了 ?${key}= 但页面里没有任何地方读它 ⇒ 这一格永远是空的`);
  }
  for (const key of read) {
    assert.ok(written.has(key), `页面里读了 ?${key}= 但脚本从不写它 ⇒ 页面拿到的是 null`);
  }
  assert.deepEqual([...read].sort(), LABEL_URL_KEYS);
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
// 会员名上窗口：一套「运营叫法」对不上另一套「会员名」时，人站在机器前认不出这是哪家
// ---------------------------------------------------------------------------
// 2026-09-18 深夜，用户贴出运营给他的四组账号（里可林家居:阿彦 / 网林家居旗舰店:阿彦 /
// 随心品质定制:阿彦 / j873522735:阿彦）并问「没有科塔啊，五个店铺哪里有科塔」——
// 窗口标题写的是登记表与飞书「店铺」列里的**运营叫法**（科塔淘宝），而他手里是**阿里妈妈会员名**；
// 科塔的会员名干脆是一串数字（`j873522735`），字面上没有「科塔」二字。
// 两套名字都存在且都合法，对不上的是「人」—— 所以把会员名也写到窗口上。

test('会员名从登记表读，不在标签页这一层另抄一份（另抄的那份会慢慢和登记表对不上）', () => {
  const fromRegistry = (shop) => SHOP_IDENTITIES.find((row) => row.key === shop)?.alimamaMemberName ?? null;
  for (const shop of Object.keys(SHOP_BROWSERS)) {
    assert.ok(fromRegistry(shop), `${shop} 在登记表里没有会员名 —— 那这一格本来就该是空的，先补实测值`);
    assert.equal(memberNameFor(shop), fromRegistry(shop),
      `${shop} 的会员名与登记表不一致 —— 那就成了第二份真相`);
  }
  // 登记表是**数组**。这里守的是本轮真栽的那一跤（见 shop-window-label.mjs 的 memberNameFor 注释）：
  // 写成对象下标 `identities[name]` 会永远返回 null，页面上那一行永远空着且不报错，
  // 症状与「这家店确实没登记」完全一样。
  assert.ok(Array.isArray(SHOP_IDENTITIES), '登记表的形状变了，取值的写法要跟着改');
  assert.throws(() => memberNameFor('盖文淘宝', { 盖文淘宝: { alimamaMemberName: 'x' } }), /数组形状/u,
    '形状不对必须炸：静默返回 null 会让「会员名那一行永远空着」看起来像正常结果');
  // 用户手里那四组账号必须逐字能对上（这是这条修复存在的唯一理由）
  const held = ['里可林家居:阿彦', '网林家居旗舰店:阿彦', '随心品质定制:阿彦', 'j873522735:阿彦'];
  const shown = Object.keys(SHOP_BROWSERS).map((shop) => memberNameFor(shop));
  for (const account of held) {
    assert.ok(shown.includes(account),
      `运营给的账号「${account}」在四台窗口上找不到对应 —— 用户又会问「哪里有我手里这个」`);
  }
  assert.equal(shown.length, new Set(shown).size, '两个窗口挂同一个会员名 ⇒ 又分不出是哪家');
  assert.equal(memberNameFor('科塔淘宝'), 'j873522735:阿彦',
    '科塔的会员名是一串数字，它正是用户看不出「哪里有科塔」的原因');
  // 读不到就是 null，页面上整行不显示（不写占位 —— 那会让人以为量过了）
  assert.equal(memberNameFor('不存在的店'), null);
  assert.equal(memberNameFor(''), null);
  assert.equal(memberNameFor(null), null);
  // CLI 口子：显式覆盖可用，没给时为 null（由 main 从登记表取）
  assert.equal(parseCli([]).member, null);
  assert.equal(parseCli(['--member', 'j873522735:阿彦']).member, 'j873522735:阿彦');
  assert.throws(() => parseCli(['--member']), /--member requires a value/u);
  assert.throws(() => parseCli(['--member', '--commit']), /--member requires a value/u);
});

test('会员名必须真的落到页面元素上，且是「量到才显示」', () => {
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  assert.ok(html.includes('id="member"'), '页面上没有显示会员名的地方');
  assert.match(html, /getElementById\('member'\)[\s\S]{0,200}textContent/u,
    '会员名没有写进页面元素 ⇒ 窗口上还是对不上「哪一组账号是哪一家」');
  assert.match(html, /if\s*\(member\)/u,
    '会员名必须是有条件的：没量到就整行不显示（不能显示空行或占位）');
  assert.equal(/id="member"[^>]*>[^<]*:阿彦/u.test(html), false,
    '会员名不许写死在 HTML 里 —— 那会把某一家店的账号贴到四台窗口上');
});

// 2026-09-19 加。用户原话：「已登录随心，还有[截图]，这个浏览器不是给随心定制的吗」——
// 他看的是那张标签页截图（大标题写着「盖文淘宝」），而那个窗口登的会员名是
// 「随心品质定制:阿彦」。两套名字字面上毫无关系，所以「并排放两行」还不够，
// 得把「这是同一家店」这句话直接写出来（「同店四名」这个坑在界面侧的第三次发作）。
test('窗口上必须明说「两套名字是同一家店」，而且两个名字都量到才显示', () => {
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  assert.ok(html.includes('id="alias"'), '没有那一行 —— 收信人到了机器前还是要自己推「这两个名字是不是一家」');
  // 只截「那一行自己的代码」：从 alias 赋值到登录状态那段为止（底部提示里本来就有「密码」二字，
  // 整段截下来会把提示的文案也算进来 —— 那就成了一条永远红的假判据）。
  //
  // 截下来之后**必须先剥注释**：上面紧挨着的就是一段解释「为什么要加这一行」的说明，里面同样
  // 会出现 `innerHTML =` 这种字样。突变 M2 实测过——把赋值那两行整段注释掉，本判据照样全绿，
  // 因为注释掉的 `// alias.innerHTML = …` 仍然匹配得上。源码判据要先剥注释，本仓库记过这条，
  // 这里是它的第二次发作（第一次在登录告警那批）。
  const raw = html.slice(html.indexOf("getElementById('alias')"), html.indexOf('const state ='));
  const block = raw.split('\n').map((line) => line.replace(/\/\/.*$/u, '')).join('\n');
  assert.match(block, /innerHTML\s*=/u, '这一行必须真的写到页面上（只放一个空 div、或把赋值注释掉都不算）');
  // 匹配**赋值进去的那句话**，不是整个文件：上面那段说明里也写着「同一个店的两个名字」，
  // 拿整个文件去 includes，等于让注释替代码通过（本仓库记过这条：源码判据要先剥注释）。
  // 取 `同一[家个]店` 而不是写死一种说法：这句话的措辞会改（「同一家店」「同一个店」都通），
  // 判据要守的是「这句关系被说出来了」，不是某个具体用词 —— 写死用词只会制造一条假红灯
  //（2026-09-19 就是这么红的：页面写「同一个店」而我断言找「同一家店」）。
  assert.match(block, /innerHTML\s*=[\s\S]{0,200}?同一[家个]店/u,
    '那句话必须真的写进页面，而不是只写在注释里');
  assert.match(block, /shop/u, '要把飞书叫法（大标题那个）写进这句话里');
  assert.match(block, /member/u, '要把会员名写进这句话里');
  // 与上面两行同一口径：缺一个就整行不显示 —— 半句话（「飞书里叫 X」但没有会员名）比不显示更误导。
  assert.match(block, /if\s*\(shop\s*&&\s*member/u,
    '两个名字都量到才显示；只量到一个时写半句会让人以为「另一套名字不存在」');
  assert.equal(/id="alias"[^>]*>[^<]+</u.test(html), false, '这一行同样不许把店名/账号写死在 HTML 里');
  // 这一行不许出现凭据面（这个 URL 会进浏览历史）
  assert.equal(/password|密码/u.test(block), false, '这里只许放名字，不许放密码');
});

test('挂标签页时把会员名一起带上（不透传的话页面上那一行永远是空的）', async () => {
  const calls = [];
  await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19043',
    shop: '盖文淘宝',
    port: 19033,
    member: memberNameFor('盖文淘宝'),
    fetchImpl: fakeProxy({ targets: REAL_SUI_XIN, calls }),
  });
  const created = calls.find((c) => c.url.includes('/new'));
  assert.ok(created, '这一台当时没有标签页，必须新建');
  assert.equal(new URL(targetUrlOf(created)).searchParams.get('member'), '随心品质定制:阿彦',
    'ensureLabelTabOn 没有把 member 透传给 labelPageUrlFor ⇒ 页面上那一行永远空着');
});

// ---------------------------------------------------------------------------
// 「实际登的是谁」上窗口（2026-09-22 加）
// ---------------------------------------------------------------------------
//
// 由来：`login-merchant.mjs` 的 `sites.*.loggedIn` 只回答「**有没有**会话」，
// 不回答「**以谁的身份**持有会话」。2026-09-13 的事故正是「登录态完全正常、但登的是别人」，
// 而串号的下游代价是**静默**的：文件照落、数字照进飞书，阿里妈妈那份产物里连一个店铺身份
// 字段都没有，事后从产物里查不出来。所以窗口上要多一行 —— **实际登录的会员名**（读页面得来），
// 与登记表不符时标红。

test('标签页 URL：没读到实际会员名就整条不带 actual（不写占位）', () => {
  const without = labelPageUrlFor({ shop: '盖文淘宝', port: 19033, member: '随心品质定制:阿彦' });
  assert.equal(without.includes('actual='), false,
    '没读到实际值时不该带这个参数 —— 写「未知」会让人以为量过了');
  // 空白串同样是「没读到」（否则页面上会出现一行只有前缀、没有值的「实际登录」）
  assert.equal(labelPageUrlFor({ shop: '盖文淘宝', actual: '   ' }).includes('actual='), false);
  const shown = labelPageUrlFor({ shop: '盖文淘宝', actual: '随心品质定制:阿彦' });
  assert.equal(new URL(shown).searchParams.get('actual'), '随心品质定制:阿彦');
});

test('判定四种结果各不相同：「没量到」不是「一致」，「登记表没有期望值」也不下判定', () => {
  assert.equal(memberVerdictFor({ expected: 'a', actual: null }), null);
  assert.equal(memberVerdictFor({ expected: 'a', actual: '   ' }), null);
  assert.equal(memberVerdictFor({ actual: '随心品质定制:阿彦' }), 'unregistered',
    '登记表里没有期望值时只能报实际值 —— 判成「一致」等于用一个没核对过的判断题冒充核对过');
  assert.equal(memberVerdictFor({ expected: '随心品质定制:阿彦', actual: '随心品质定制:阿彦' }), 'match');
  assert.equal(memberVerdictFor({ expected: '随心品质定制:阿彦', actual: ' 随心品质定制:阿彦 ' }), 'match',
    '首尾空白不该把一个真匹配判成不一致（两端必须是同一个归一化口径）');
  assert.equal(memberVerdictFor({ expected: '随心品质定制:阿彦', actual: 'j873522735:阿彦' }), 'mismatch',
    '科塔的会员名出现在盖文淘宝的窗口上 —— 这就是串号，必须判成不一致');
  assert.equal(memberVerdictFor(), null);
  assert.equal(memberVerdictFor({}), null);
});

test('读实际登录会员名：照真代理的两层包装解，读法复用采集链那一份表达式', async () => {
  const calls = [];
  const reading = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19043',
    fetchImpl: fakeProxy({
      targets: REAL_SUI_XIN,
      calls,
      evalReading: {
        href: 'https://one.alimama.com/index.html',
        memberName: '随心品质定制:阿彦', memberId: '887360146', raw: '随心品质定制:阿彦 ID：887360146',
      },
    }),
  });
  assert.equal(reading.memberName, '随心品质定制:阿彦',
    '解不出两层包装的话这里会是 null，页面上那一行就永远空着，而离线用例照样全绿');
  assert.equal(reading.memberId, '887360146');
  assert.equal(reading.reason, null);
  const evals = calls.filter((c) => c.url.includes('/eval'));
  assert.equal(evals.length, 1);
  assert.equal(evals[0].method, 'POST');
  assert.equal(new URL(evals[0].url).searchParams.get('target'), 'b',
    '必须读阿里妈妈那一页：读错页拿到的是另一种东西（生意参谋页头只有店铺名）');
  assert.equal(evals[0].body, alimamaIdentityExpression(),
    '读法必须逐字用采集链那一份 —— 另写一份选择器迟早漂移，而漂移的表现是结论错');
});

test('读实际登录会员名：读不到一律 null 且带原因，绝不抛错（登录前必然读不到）', async () => {
  // ① 窗口里根本没有阿里妈妈页签（还停在登录页时就是这样）
  const noPage = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19041', fetchImpl: fakeProxy({ targets: [], calls: [] }),
  });
  assert.equal(noPage.memberName, null);
  assert.match(noPage.reason, /没有阿里妈妈页签/u);
  // 只有生意参谋页时同理：那是「读不到」，不是错
  const onlySycm = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19041',
    fetchImpl: fakeProxy({
      targets: [{ type: 'page', targetId: 's', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' }],
      calls: [],
    }),
  });
  assert.equal(onlySycm.memberName, null);
  assert.match(onlySycm.reason, /没有阿里妈妈页签/u);
  // ② 页面确实在，但还停在登录页：表达式读得到，只是里面没有「会员名 + ID」那一段
  const loggedOut = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19043',
    fetchImpl: fakeProxy({
      targets: REAL_SUI_XIN,
      calls: [],
      evalReading: {
        href: 'https://one.alimama.com/index.html#!/login/index', memberName: null, memberId: null, raw: null,
      },
    }),
  });
  assert.equal(loggedOut.memberName, null);
  assert.match(loggedOut.reason, /登录页/u, '原因要说清「多半还停在登录页」，否则与故障分不开');
  // ③ 代理 /eval 回 400（表达式抛了或页面在导航中）：原因里必须带 HTTP 码
  const bad = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19043',
    fetchImpl: fakeProxy({ targets: REAL_SUI_XIN, calls: [], evalStatus: 400 }),
  });
  assert.equal(bad.memberName, null);
  assert.match(bad.reason, /400/u);
  // ④ 代理没起：fetch 直接抛 —— 这是最常见的一种（脚本比浏览器先跑）
  const down = await readLoggedInMemberOn({
    proxyUrl: 'http://127.0.0.1:19999',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/targets')) {
        return { ok: true, status: 200, json: async () => REAL_SUI_XIN, text: async () => JSON.stringify(REAL_SUI_XIN) };
      }
      throw new Error('fetch failed');
    },
  });
  assert.equal(down.memberName, null);
  assert.match(down.reason, /没打通/u);
});

test('挂标签页时把「实际登录的会员名」一起带上（不透传的话那一行永远是空的）', async () => {
  const calls = [];
  await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19043',
    shop: '盖文淘宝',
    port: 19033,
    member: memberNameFor('盖文淘宝'),
    actual: '随心品质定制:阿彦',
    fetchImpl: fakeProxy({ targets: REAL_SUI_XIN, calls }),
  });
  const created = calls.find((c) => c.url.includes('/new'));
  assert.ok(created, '这一台当时没有标签页，必须新建');
  assert.equal(new URL(targetUrlOf(created)).searchParams.get('actual'), '随心品质定制:阿彦',
    'ensureLabelTabOn 没有把 actual 透传给 labelPageUrlFor ⇒ 页面上那一行永远空着');
});

test('实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红', () => {
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  assert.ok(html.includes('id="actual"'), '页面上没有显示「实际登录会员名」的地方');
  assert.match(html, /getElementById\('actual'\)[\s\S]{0,300}textContent/u,
    '实际会员名没有写进页面元素 ⇒ 串号时还是看不出来');
  assert.match(html, /if\s*\(actual\)/u,
    '这一行必须「量到才显示」：没量到就整行不显示（登录前必然读不到）');
  // 只截这一段自己的代码（到 alias 那一段为止）。**必须先剥注释**：上面紧挨着的就是一段
  // 解释「为什么要加这一行」的说明，里面同样会出现 mismatch / bad 这些字样 ——
  // 拿含注释的整段去匹配，等于让注释替代码通过（本仓库记过这条，突变验证实测过一次）。
  const raw = html.slice(html.indexOf('const actual ='), html.indexOf('const alias'));
  const block = raw.split('\n').map((line) => line.replace(/\/\/.*$/u, '')).join('\n');
  assert.match(block, /mismatch/u, '页面没有「不一致」这一态');
  assert.match(block, /actual === member/u,
    '页面必须拿实际值与登记表的值**逐字**比 —— 这是判据本身，不是措辞');
  assert.match(block, /'bad'/u, '不一致时必须挂到 bad 类上，否则那一行与普通信息长得一样');
  // 「登记表里没有期望值」必须是**单独一态**。只断言文案里出现过「没有这家的期望值」是不够的：
  // 把判定写成 `!member ? 'match'` 时，那一句文案仍然在（因为它挂在「非 match 非 mismatch」那一支上），
  // 于是「用一个没核对过的判断题冒充核对过」照样上线、用例全绿。突变 M8 实测过这件事。
  assert.match(block, /!\s*member\s*\?[^:]{0,10}'unknown'/u,
    '「登记表里没有期望值」必须单独成一态（unknown），不能算成 match');
  assert.match(block, /没有这家的期望值/u,
    '那一态在页面上要说人话（只报实际值、不下判定）');
  // 只挂类名、没有 .x.bad 规则 ⇒ 页面上根本不红。这就是「契约齐、测试绿、接线没接上」的形态。
  assert.match(html, /\.x\.bad\s*\{[^}]*color/u, '.x.bad 没有颜色规则 ⇒ 挂着 bad 类也不会红');
  assert.equal(/id="actual"[^>]*>[^<]+</u.test(html), false, '不许把会员名写死在 HTML 里');
});

test('标签页 URL 里只许出现账号名，绝不许出现密码（这个 URL 会进浏览历史）', () => {
  const url = labelPageUrlFor({
    shop: '科塔淘宝', port: 19034, state: '需要登录', ok: true, member: 'j873522735:阿彦',
    actual: '随心品质定制:阿彦',
  });
  const keys = [...new URL(url).searchParams.keys()].sort();
  assert.deepEqual(keys, LABEL_URL_KEYS,
    '标签页 URL 的键集合是封闭的：多一个键就等于多一个可能漏凭据的口子');
  const suspicious = /pass|pwd|secret|token|credential|cookie/iu;
  for (const key of keys) assert.equal(suspicious.test(key), false, `键名可疑：${key}`);
  // 页面上也不许有读密码的入口
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  for (const key of new Set([...html.matchAll(/\.get\('([A-Za-z]+)'\)/gu)].map((m) => m[1]))) {
    assert.equal(suspicious.test(key), false, `页面在读可疑参数：${key}`);
  }
  assert.equal(/type\s*=\s*["']password/iu.test(html), false, '标签页里不该有任何密码输入框');
});

test('底部提示必须随登录态变：没量到登录态时不许说「右边那个就是登录页」', () => {
  // 已登录的窗口里**没有**登录页。四台窗口写同一句「登录页就在本标签页右边那一个里」，
  // 会让人照着去找一个不存在的页面。这里守的是「这句指路必须挂在 state 上」。
  const html = readFileSync(LABEL_PAGE_PATH, 'utf8');
  const parts = html.split(/innerHTML\s*=\s*state\s*\?/u);
  assert.equal(parts.length, 2, '底部提示没有按登录态分叉 ⇒ 已登录的窗口会指着一个不存在的登录页');
  const tail = parts[1];
  const altIndex = tail.search(/:\s*'/u);
  assert.ok(altIndex > 0, '底部提示没有「另一支」文案');
  assert.ok(tail.slice(0, altIndex).includes('登录页就在本标签页右边那一个里'),
    '量到「需要登录」时要指路 —— 不指路等于又让人自己找');
  const conditional = tail.slice(altIndex);
  assert.equal(conditional.includes('登录页就在本标签页右边那一个里'), false,
    '没量到登录态时不能说一个不存在的登录页');
  assert.ok(conditional.includes('如果'), '没量到时给的是条件句，不替浏览器下结论');
  assert.equal([...html.matchAll(/登录页就在本标签页右边那一个里/gu)].length, 1,
    '这句只能出现一次（出现在无条件的位置就等于对四台窗口都成立）');
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

// 上一条的镜像（2026-09-20 真机踩到）：关**成功**了，但 CDP 还没把目标从 `/targets` 里摘掉。
// 原先回读紧接着 `/close` 就做 ⇒ 报告写「关完回读它还在」，而隔一会儿再看那两条页签已经没了。
// 两个坑方向相反，合起来才是完整口径：**返回码不可信（要回读），回读也不能只读一遍（要等一拍）**。
test('回读要允许「慢一拍」：第一遍还列着、第二遍没了 ⇒ 判成功', async () => {
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19044', dryRun: false,
    sleep: async () => {},   // 真机等 600ms；离线用例把等待换掉，别让跑测试的人白等
    fetchImpl: fakeProxySlowDisappear({ targets: REAL_KE_TA, calls }),
  });
  assert.deepEqual(result.closed.map((t) => t.targetId).sort(), ['b1', 'k2', 'k3'],
    '慢一拍被当成「关不掉」= 清理报告每轮都在说假话');
  assert.deepEqual(result.failed, []);
  assert.equal(result.ok, true);
  assert.ok(result.reads >= 2, '必须真的读到「消失了」才收手 —— 读到第一遍就下结论正是这次的 bug');
});

test('回读有上限：一直不消失就如实判失败，且错误里写清读了几次', async () => {
  const calls = [];
  const result = await pruneTabsOn({
    proxyUrl: 'http://127.0.0.1:19041', dryRun: false,
    readAttempts: 2, sleep: async () => {},
    fetchImpl: fakeProxyStubborn({ targets: REAL_KE_TA, calls }),
  });
  assert.equal(result.reads, 2, '读的次数必须等于上限：既不能提前放弃，也不能无限读下去');
  assert.equal(result.failed.length, 3);
  assert.equal(result.ok, false);
  assert.match(result.failed[0].error, /回读 2 次/u,
    '错误里要写清读了几次 —— 否则分不清「真关不掉」和「读得太早」');
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

// ---------------------------------------------------------------------------
// 钉住标签页（2026-09-19）
//
// 这一段的由来：店名标签页是「让客户知道哪个窗口是哪家店」的唯一落点，而它也是用 `/new`
// 建的 ⇒ 进代理的 managedTabs ⇒ **闲置 15 分钟被自动回收、代理退出再关一轮**。
// 现场表现是「页面自己消失了」，而没有任何一处报错。修法是 `/pin`。
// 判定本身在 isolated-proxy/managed-tabs.test.mjs；这里守的是「标签页这一侧真的把针扎下去了没」。

const pinCalls = (calls) => calls.filter((c) => c.url.includes('/pin'));
const pinTargetOf = (call) => new URL(call.url).searchParams.get('target');

test('复用已有标签页时也要钉一次：老版本挂的标签页照样会被 15 分钟收走', async () => {
  const calls = [];
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19041',
    shop: '里可林淘宝',
    port: 19031,
    fetchImpl: fakeProxy({ targets: REAL_WANG_LIN, calls }),
  });
  assert.equal(result.reused, true);
  const pins = pinCalls(calls);
  assert.equal(pins.length, 1, '复用分支必须补一次 /pin —— 不补的话它会在 15 分钟后消失，而那种失效要等一刻钟才显形');
  assert.equal(pinTargetOf(pins[0]), result.targetId, '钉的必须是这个标签页本身');
  assert.equal(result.pinned.pinned, true, '钉住了就要如实报 true');
});

test('新建标签页时既带 pinned=1、也显式钉一次（旧版代理会把 pinned=1 当无关参数吞掉）', async () => {
  const calls = [];
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19041',
    shop: '里可林淘宝',
    port: 19031,
    fetchImpl: fakeProxy({ targets: [], calls }),
  });
  assert.equal(result.reused, false);
  assert.equal(result.targetId, 'new-1');
  const created = calls.find((c) => c.url.includes('/new'));
  assert.ok(created.url.includes('pinned=1'), '新建时就该把意图带上（新代理一步到位）');
  const pins = pinCalls(calls);
  assert.equal(pins.length, 1, '还要显式钉一次：那一刻的代理可能还不认 pinned=1，不补就静默失效');
  assert.equal(pinTargetOf(pins[0]), 'new-1');
});

test('钉不住不抛错，但必须如实报出来 —— 挂标签页不该因为这一步整个失败', async () => {
  const calls = [];
  const notImplemented = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url).endsWith('/targets')) {
      return { ok: true, status: 200, json: async () => REAL_WANG_LIN, text: async () => JSON.stringify(REAL_WANG_LIN) };
    }
    if (String(url).includes('/navigate')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
    }
    // 旧版代理：没有 /pin 这个端点（升级前就是这样）。
    return { ok: false, status: 404, json: async () => ({}), text: async () => '{"error":"Not found"}' };
  };
  const result = await ensureLabelTabOn({
    proxyUrl: 'http://127.0.0.1:19041',
    shop: '里可林淘宝',
    port: 19031,
    fetchImpl: notImplemented,
  });
  assert.equal(result.ok, true, '标签页已经挂好了，不该因为钉不住而报整件事失败');
  assert.equal(result.pinned.pinned, false);
  assert.match(result.pinned.reason, /404/u, '原因要带上 HTTP 码，否则「钉住了吗」只能靠猜');
  assert.match(result.pinned.reason, /重启代理/u, '要说清下一步动作 —— 这正是客户看得懂的那句话');
});

test('代理侧必须真的提供 /pin 与 pinned=1（否则标签页这边发了也没人听）', () => {
  const source = readFileSync(new URL('./isolated-proxy/cdp-proxy.mjs', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  assert.ok(code.includes("pathname === '/pin'"),
    '代理没有 /pin 端点 ⇒ 标签页那侧的钉住请求永远 404，而失败被吞成「不抛错」⇒ 静默退回被回收的老行为');
  assert.ok(code.includes("q.pinned === '1'"),
    '/new 要认 pinned=1；不认的话「新建即钉住」这半条路是空的');
});

