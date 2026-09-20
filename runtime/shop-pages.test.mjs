// shop-pages.mjs 的离线判据。
//
// 四条必须钉住的事（都是踩过的坑的形态）：
//   ① 期望页面清单**只从 run-multi-shop-day.mjs 取**（另抄一份就会与体检/落位漂移）；
//   ② 补页 URL 的飞书那一项必须带 `?table=&view=`，字段名是 sourceTable/sourceView；
//   ③ 「多于一个」只能报、不能动 —— 它是人的决定；
//   ④ **缺页时先「领回」再考虑新建**（2026-09-20）：一页没丢、只是漂到别的 URL 时，
//      新建会把同主机变成两页 ⇒ 下一轮 `resetSycmPage` fail-closed，整家店一步都不跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertCoverage,
  buildPagePlan,
  buildUrlByName,
  findReclaimCandidates,
  hostOfUrl,
  judgeSlotReport,
  planPageActions,
  planRequests,
  sendRequests,
  settleSlots,
  slotsFrom,
} from './shop-pages.mjs';
import { PROJECT_PORTS, shopBrowserKeys, shopInstance } from './browser-ports.mjs';
import { siteAdapter } from '../skills/sycm-alimama-daily-report/scripts/date-picker.mjs';
import {
  expectedPagesForDailyBrowser,
  expectedPagesForShop,
} from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

test('计划 = 商家浏览器一个 ＋ 每家店一个，代理端口取自登记表', () => {
  const plan = buildPagePlan();
  assert.equal(plan.length, 1 + shopBrowserKeys().length);
  assert.equal(plan[0].proxyPort, PROJECT_PORTS.dailyReportProxy);
  assert.deepEqual(plan[0].expected, expectedPagesForDailyBrowser(), '商家浏览器的期望页面必须与驱动同源');
  for (const key of shopBrowserKeys()) {
    const entry = plan.find((item) => item.key === key);
    assert.ok(entry, `${key} 不在计划里`);
    assert.equal(entry.proxyPort, shopInstance(key).proxyPort);
    assert.deepEqual(entry.expected, expectedPagesForShop(), '店铺的期望页面必须与驱动同源');
  }
});

test('assertCoverage：期望页面没有开页 URL 时必须抛错（不许建 undefined 页）', () => {
  const plan = [{ who: '甲', expected: [{ name: '某个新页面', urlFragment: 'x' }] }];
  assert.throws(() => assertCoverage(plan, { 别的页面: 'https://example.com' }), /某个新页面/u);
  assert.doesNotThrow(() => assertCoverage(plan, { 某个新页面: 'https://example.com' }));
});

test('buildUrlByName：飞书页带 table/view，且字段名来自权威（不是 tableId/viewId）', (t) => {
  let urls;
  try {
    urls = buildUrlByName();
  } catch (error) {
    t.skip(`本机没有可解析的飞书 profile/目标（${error.message}）`);
    return;
  }
  assert.match(urls.飞书底单页, /^https:\/\/[^/]+\/base\/[^?]+\?table=[^&]+&view=[^&]+$/u);
  assert.doesNotMatch(urls.飞书底单页, /table=undefined|view=undefined/u, '字段名猜错会建出 undefined 页且不报错');
  assert.ok(urls.生意参谋工作页.startsWith('http'), '生意参谋页 URL 必须来自 date-picker 的 entryUrl');
  assert.ok(urls.阿里妈妈报表页.startsWith('http'), '阿里妈妈页 URL 必须来自 login-merchant-core 的 probeUrl');
});

test('planPageActions：已有 / 多于一个（只报）/ 同主机一页都没有时缺（补）', () => {
  const expected = [
    { name: '甲页', urlFragment: 'sycm.taobao.com' },
    { name: '乙页', urlFragment: 'one.alimama.com' },
    { name: '丙页', urlFragment: 'feishu.cn/base' },
  ];
  const urlByName = { 甲页: 'https://a', 乙页: 'https://b', 丙页: 'https://c' };
  const actions = planPageActions({
    urls: ['https://sycm.taobao.com/x', 'https://one.alimama.com/y', 'https://one.alimama.com/z'],
    expected,
    urlByName,
    dry: true,
  });
  assert.deepEqual(actions.map((a) => a.action), ['already-one', 'ambiguous', 'would-create']);
  assert.equal(actions[1].found, 2, '要报出有几个，人才知道关掉几个');
  assert.equal(actions[2].url, 'https://c', '缺的那一页要带上开页 URL');
});

test('planPageActions：非 dry 时缺的变成 create（且不带 url 之外的多余字段）', () => {
  const actions = planPageActions({
    urls: [],
    expected: [{ name: '甲页', urlFragment: 'sycm.taobao.com' }],
    urlByName: { 甲页: 'https://a' },
    dry: false,
  });
  assert.equal(actions[0].action, 'create');
});

test('slotsFrom 数的是「包含该片段」的页签数', () => {
  const slots = slotsFrom(
    ['https://sycm.taobao.com/a', 'https://sycm.taobao.com/b', 'https://feishu.cn/base/x'],
    [{ name: '生意参谋工作页', urlFragment: 'sycm.taobao.com' }, { name: '飞书底单页', urlFragment: 'feishu.cn/base' }],
  );
  assert.deepEqual(slots, [{ page: '生意参谋工作页', count: 2 }, { page: '飞书底单页', count: 1 }]);
});

test('judgeSlotReport：连不上、缺口、重复各归各的桶', () => {
  const verdict = judgeSlotReport([
    { who: '甲', reachable: true, slots: [{ count: 1 }], actions: [{ action: 'already-one' }] },
    { who: '乙', reachable: true, slots: [{ count: 0 }], actions: [{ action: 'would-create' }] },
    { who: '丙', reachable: true, slots: [{ count: 3 }], actions: [{ action: 'ambiguous' }] },
    { who: '丁', reachable: false, actions: [] },
  ]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unreachable.map((e) => e.who), ['丁']);
  assert.deepEqual(verdict.gaps.map((e) => e.who), ['乙', '丙']);
  assert.deepEqual(verdict.ambiguous.map((e) => e.who), ['丙']);
});

test('judgeSlotReport：全就位才是 ok', () => {
  const verdict = judgeSlotReport([
    { who: '甲', reachable: true, slots: [{ count: 1 }], actions: [{ action: 'already-one' }] },
  ]);
  assert.equal(verdict.ok, true);
});

// ---------------------------------------------------------------- 领回（2026-09-20）

const SYCM = siteAdapter('sycm');
const SYCM_ORIGIN = new URL(SYCM.entryUrl).origin;
/** 链的第 5 步会把工作页留在这类报表预览 URL 上（同主机，但片段认不出来）。 */
const SYCM_DRIFT = `${SYCM_ORIGIN}/lyone/auto_analysis/datafetch/page?reportId=1`;
const SYCM_EXPECTED = [{ name: '生意参谋工作页', urlFragment: SYCM.urlFragment }];
const SYCM_URLS = { 生意参谋工作页: SYCM.entryUrl };

test('hostOfUrl：只认「协议+主机」并归一大小写；认不出主机的返回 null', () => {
  assert.equal(hostOfUrl('HTTPS://Sycm.Taobao.COM/a/b'), 'https://sycm.taobao.com');
  assert.equal(hostOfUrl('http://127.0.0.1:19022/x'), 'http://127.0.0.1:19022');
  assert.equal(hostOfUrl('about:blank'), null, '认不出来就 null —— 靠它把 about:blank 挡在候选之外');
  assert.equal(hostOfUrl(''), null);
  assert.equal(hostOfUrl(undefined), null);
});

test('findReclaimCandidates：缺页但同主机有一页只是漂走了 ⇒ 领回，而不是新建', () => {
  const urlByName = { ...SYCM_URLS, 飞书底单页: 'https://kcne.feishu.cn/base/x?table=a&view=b' };
  const expected = [...SYCM_EXPECTED, { name: '飞书底单页', urlFragment: 'feishu.cn/base' }];
  const out = findReclaimCandidates({
    urls: [SYCM_DRIFT, urlByName.飞书底单页],
    expected,
    urlByName,
  });
  assert.deepEqual(out, [{
    page: '生意参谋工作页', action: 'reclaim', from: SYCM_DRIFT, url: SYCM_DRIFT, to: SYCM.entryUrl,
  }], '在位的飞书页不该出现在这里（那是 already-one 的事）');
});

test('findReclaimCandidates：同主机有多于一页、都不是它开的 ⇒ 只报不猜', () => {
  const urls = [`${SYCM_ORIGIN}/portal/home.htm`, SYCM_DRIFT];
  const out = findReclaimCandidates({ urls, expected: SYCM_EXPECTED, urlByName: SYCM_URLS });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'ambiguous-drift');
  assert.equal(out[0].found, 2, '要报出有几页，人才知道去看哪几个');
  assert.deepEqual(out[0].urls, urls);
});

test('findReclaimCandidates：同主机一页都没有 ⇒ 才是真的缺，新建', () => {
  const out = findReclaimCandidates({
    urls: ['https://one.alimama.com/report'],
    expected: SYCM_EXPECTED,
    urlByName: SYCM_URLS,
  });
  assert.deepEqual(out, [{ page: '生意参谋工作页', action: 'create', url: SYCM.entryUrl, to: SYCM.entryUrl }]);
});

test('findReclaimCandidates：认不出主机的页（about:blank 之类）永不当候选', () => {
  const out = findReclaimCandidates({
    urls: ['about:blank', 'devtools://devtools/bundled/x.html'],
    expected: SYCM_EXPECTED,
    urlByName: SYCM_URLS,
  });
  assert.equal(out[0].action, 'create', '把它们导航走是破坏，不是修复');
});

test('findReclaimCandidates：一个漂移页只被领回一次（两页同主机都缺时，第二个只能新建）', () => {
  const out = findReclaimCandidates({
    urls: [SYCM_DRIFT],
    expected: [
      { name: '甲页', urlFragment: 'nothing-matches-a' },
      { name: '乙页', urlFragment: 'nothing-matches-b' },
    ],
    urlByName: { 甲页: SYCM.entryUrl, 乙页: `${SYCM_ORIGIN}/other/entry` },
  });
  assert.deepEqual(out.map((entry) => entry.action), ['reclaim', 'create']);
  assert.equal(out[0].from, SYCM_DRIFT);
  assert.equal(out[1].url, `${SYCM_ORIGIN}/other/entry`, '同一个页签不能同时当两页的「领回源」');
});

test('planPageActions：可领回时 dry 报 would-reclaim、真跑才是 reclaim（并带上 from 与目标 URL）', () => {
  const dry = planPageActions({ urls: [SYCM_DRIFT], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: true });
  assert.equal(dry[0].action, 'would-reclaim');
  assert.equal(dry[0].from, SYCM_DRIFT, '要让人看见它准备动哪一页');
  assert.equal(dry[0].url, SYCM.entryUrl, '要带上「导航回哪里」');
  const wet = planPageActions({ urls: [SYCM_DRIFT], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: false });
  assert.equal(wet[0].action, 'reclaim');
});

test('planRequests：dry 计划一个写请求都不发（默认口径必须是不动运行中的浏览器）', () => {
  const actions = planPageActions({ urls: [SYCM_DRIFT], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: true });
  assert.equal(actions[0].action, 'would-reclaim');
  assert.deepEqual(planRequests({ actions, targets: [{ targetId: 'A', url: SYCM_DRIFT }] }), []);
});

test('planRequests：可领回 ⇒ 一条 /navigate，导航的是那一页本身，绝不新建', () => {
  const actions = planPageActions({ urls: [SYCM_DRIFT], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: false });
  const requests = planRequests({
    actions,
    targets: [{ targetId: 'A', url: 'https://one.alimama.com/x' }, { targetId: 'DRIFT-ID', url: SYCM_DRIFT }],
  });
  assert.deepEqual(requests.map((request) => request.kind), ['navigate']);
  assert.equal(requests[0].targetId, 'DRIFT-ID', '要导航的是漂走了的那一页');
  assert.equal(requests[0].url, SYCM.entryUrl);
});

test('planRequests：那一页找不到了 / 没有 targetId ⇒ blocked，既不猜也不新建', () => {
  const actions = planPageActions({ urls: [SYCM_DRIFT], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: false });
  const gone = planRequests({ actions, targets: [] });
  assert.equal(gone[0].kind, 'blocked');
  assert.match(gone[0].error, /找不到唯一的那一页（0 个）/u);
  const noId = planRequests({ actions, targets: [{ url: SYCM_DRIFT }] });
  assert.equal(noId[0].kind, 'blocked');
  assert.match(noId[0].error, /没有 targetId/u, '没有 targetId 就说没有，不许退化成新建');
});

test('planRequests：真缺（同主机一页都没有）才发一条 /new，且带上页面名当 label', () => {
  const actions = planPageActions({
    urls: ['https://one.alimama.com/x'],
    expected: SYCM_EXPECTED,
    urlByName: SYCM_URLS,
    dry: false,
  });
  const requests = planRequests({ actions, targets: [{ targetId: 'A', url: 'https://one.alimama.com/x' }] });
  assert.deepEqual(requests.map((request) => [request.kind, request.url, request.label]),
    [['new', SYCM.entryUrl, '生意参谋工作页']]);
});

/**
 * 有状态的假代理 —— 语义与真代理同形：`/targets` 是页面清单、`/navigate` 真的改 URL、
 * `/new` 真的加一页。有了它，「写侧到底发了什么」才能被离线断言（而不是只能上真机看）。
 */
function fakeProxy({ targets = [] } = {}) {
  const state = targets.map((tab) => ({ ...tab }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push(`${init.method ?? 'GET'} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === '/navigate') {
      const tab = state.find((entry) => entry.targetId === parsed.searchParams.get('target'));
      if (!tab) return { ok: false, status: 404, json: async () => ({ error: 'no such target' }) };
      tab.url = parsed.searchParams.get('url');
      return { ok: true, status: 200, json: async () => ({ frameId: 'alimama-page' }) };
    }
    if (parsed.pathname === '/new') {
      const created = { targetId: `T${state.length + 1}`, url: parsed.searchParams.get('url') };
      state.push(created);
      // 与真代理同形：只回 targetId，不回 pinned（真代理就是不回，别让假代理替它说好话）。
      return { ok: true, status: 200, json: async () => ({ targetId: created.targetId }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { state, calls, fetchImpl };
}

const reclaimOne = (proxy, { dry = false } = {}) => {
  const actions = planPageActions({
    urls: proxy.state.map((tab) => tab.url),
    expected: SYCM_EXPECTED,
    urlByName: SYCM_URLS,
    dry,
  });
  return { actions, requests: planRequests({ actions, targets: proxy.state }) };
};

test('sendRequests：领回发的是 POST /navigate，URL 真的换过去，页签数不变', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'A', url: 'https://one.alimama.com/x' }, { targetId: 'D', url: SYCM_DRIFT }] });
  const { actions, requests } = reclaimOne(proxy);
  await sendRequests({ base: 'http://127.0.0.1:1', requests, fetchImpl: proxy.fetchImpl });
  assert.equal(actions[0].targetId, 'D', '导航的是漂走的那一页');
  assert.equal(actions[0].status, 200);
  assert.equal(actions[0].action, 'reclaim', '成功了就不该改写动作名');
  assert.equal(proxy.state.length, 2, '领回不许新建页签 —— 页签数必须不变');
  assert.equal(proxy.state.find((tab) => tab.targetId === 'D').url, SYCM.entryUrl);
  assert.match(proxy.calls[0], /^POST \/navigate\?target=D&url=/u);
});

test('sendRequests：代理报错 ⇒ 如实记 reclaim-failed（不抛、也不假装成功）', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'D', url: SYCM_DRIFT }] });
  const { actions, requests } = reclaimOne(proxy);
  const failing = { ...proxy, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) };
  await sendRequests({ base: 'http://b', requests, fetchImpl: failing.fetchImpl });
  assert.equal(actions[0].action, 'reclaim-failed');
  assert.match(actions[0].error, /HTTP 500/u);
});

test('sendRequests：连不上代理也要有结论（一次抽风不该中断整轮盘点）', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'D', url: SYCM_DRIFT }] });
  const { actions, requests } = reclaimOne(proxy);
  await sendRequests({
    base: 'http://b',
    requests,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(actions[0].action, 'reclaim-failed');
  assert.match(actions[0].error, /连不上/u);
});

test('sendRequests：blocked 只写结论，一个请求都不发', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'D', url: SYCM_DRIFT }] });
  const { actions } = reclaimOne(proxy);
  await sendRequests({ base: 'http://b', requests: planRequests({ actions, targets: [] }), fetchImpl: proxy.fetchImpl });
  assert.deepEqual(proxy.calls, []);
  assert.equal(actions[0].action, 'reclaim-failed');
  assert.match(actions[0].error, /找不到唯一的那一页（0 个）/u);
});

test('sendRequests：新建发 /new 并带 label 与 pinned=1，把 targetId 记回动作', async () => {
  const proxy = fakeProxy();
  const actions = planPageActions({ urls: [], expected: SYCM_EXPECTED, urlByName: SYCM_URLS, dry: false });
  assert.equal(actions[0].action, 'create');
  await sendRequests({ base: 'http://b', requests: planRequests({ actions, targets: [] }), fetchImpl: proxy.fetchImpl });
  assert.equal(actions[0].targetId, 'T1');
  assert.equal('pinned' in actions[0], false, '代理没回 pinned 就别编一个出来（钉没钉住问 /health 的 pinnedTabs）');
  assert.match(proxy.calls[0], /^GET \/new\?url=/u, '新建这一路的调用形态与历史逐字相同');
  assert.match(proxy.calls[0], /label=/u);
  assert.match(proxy.calls[0], /pinned=1/u);
  assert.equal(proxy.state.length, 1);
});

test('整轮（假代理）：dry 一个写请求都不发，但判据仍如实报「没就位」', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'D', url: SYCM_DRIFT }] });
  const { actions, requests } = reclaimOne(proxy, { dry: true });
  assert.equal(actions[0].action, 'would-reclaim');
  await sendRequests({ base: 'http://b', requests, fetchImpl: proxy.fetchImpl });
  assert.deepEqual(proxy.calls, [], '不带 --open 绝不发写请求');
  const verdict = judgeSlotReport([{
    who: '甲',
    reachable: true,
    slots: slotsFrom(proxy.state.map((tab) => tab.url), SYCM_EXPECTED),
    actions,
  }]);
  assert.equal(verdict.ok, false, 'dry 不等于就位 —— 不许用「没动」冒充「就位」');
  assert.deepEqual(verdict.gaps.map((entry) => entry.who), ['甲']);
});

test('整轮（假代理）：领回之后 settleSlots 在真实回读里认出来', async () => {
  const proxy = fakeProxy({ targets: [{ targetId: 'D', url: SYCM_DRIFT }] });
  const { actions, requests } = reclaimOne(proxy);
  await sendRequests({ base: 'http://b', requests, fetchImpl: proxy.fetchImpl });
  const result = await settleSlots({
    expected: SYCM_EXPECTED,
    read: async () => proxy.state.map((tab) => ({ ...tab })),
    sleep: async () => {},
  });
  assert.equal(result.settled, true);
  assert.equal(result.reads, 1, '第一遍就该认出来，不该白等两拍');
  assert.deepEqual(result.urls, [SYCM.entryUrl]);
  assert.deepEqual(slotsFrom(result.urls, SYCM_EXPECTED), [{ page: '生意参谋工作页', count: 1 }]);
});

test('judgeSlotReport：ambiguous-drift 进「需人决定」桶（退出码 3 的依据），且同时算缺口', () => {
  const verdict = judgeSlotReport([
    { who: '甲', reachable: true, slots: [{ count: 0 }], actions: [{ action: 'ambiguous-drift' }] },
  ]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.ambiguous.map((entry) => entry.who), ['甲']);
  assert.deepEqual(verdict.gaps.map((entry) => entry.who), ['甲'], '人还要知道这家店现在没就位');
});

test('settleSlots：第一遍就认出来 ⇒ 只读一次（不给真机加无谓的等待）', async () => {
  let reads = 0;
  const result = await settleSlots({
    expected: [{ name: '甲页', urlFragment: 'sycm.taobao.com/qos' }],
    read: async () => { reads += 1; return [{ url: 'https://sycm.taobao.com/qos/service/x' }]; },
    sleep: async () => { throw new Error('已经满足了，不该再睡'); },
  });
  assert.equal(result.reads, 1);
  assert.equal(reads, 1);
  assert.equal(result.settled, true);
});

test('settleSlots：导航晚一拍 ⇒ 等到它出现（读太早会把成功的领回报成「还缺」）', async () => {
  const sequence = [
    [{ url: `${SYCM_ORIGIN}/lyone/auto_analysis/x` }],
    [{ url: `${SYCM_ORIGIN}/lyone/auto_analysis/x` }],
    [{ url: `${SYCM_ORIGIN}/qos/service/frame/shop/performance/new#/shop` }],
  ];
  let slept = 0;
  const result = await settleSlots({
    expected: SYCM_EXPECTED,
    read: async () => sequence.shift() ?? [],
    sleep: async () => { slept += 1; },
  });
  assert.equal(result.reads, 3);
  assert.equal(slept, 2);
  assert.equal(result.settled, true);
});

test('settleSlots：一直不满足 ⇒ 读满上限并如实报 settled:false（不许假装就位）', async () => {
  let reads = 0;
  const result = await settleSlots({
    expected: SYCM_EXPECTED,
    read: async () => { reads += 1; return [{ url: 'about:blank' }]; },
    sleep: async () => {},
  });
  assert.equal(result.reads, 3, '默认上限 3 次');
  assert.equal(reads, 3);
  assert.equal(result.settled, false);
});

test('settleSlots：read 抛错也要有结果（否则一家代理抽风会中断整轮盘点）', async () => {
  const result = await settleSlots({
    expected: SYCM_EXPECTED,
    read: async () => null,
    attempts: 1,
    sleep: async () => {},
  });
  assert.deepEqual(result.urls, []);
  assert.equal(result.settled, false);
});

test('settleSlots：只认出一个期望页面不算就位（体检要的是每个都恰好一个）', async () => {
  const result = await settleSlots({
    expected: [...SYCM_EXPECTED, { name: '阿里妈妈报表页', urlFragment: 'one.alimama.com' }],
    read: async () => [{ url: SYCM.entryUrl }],
    attempts: 1,
    sleep: async () => {},
  });
  assert.equal(result.settled, false, '少一页也不算就位 —— 只看第一个会把「还缺一页」判成绿');
});

test('源码级：回读走 settleSlots、写请求由 planRequests 挑并由 sendRequests 发', async () => {
  const source = await readFile(new URL('./shop-pages.mjs', import.meta.url), 'utf8');
  assert.match(source, /await settleSlots\(\{/u, '动作后的回读要容一拍，否则成功的领回会被报成「还缺」');
  assert.match(source, /await sendRequests\(\{ base, requests: planRequests\(\{ actions, targets: before \}\) \}\)/u,
    '写请求要由纯函数挑、由 sendRequests 发，才可能被离线断言（事故就在写侧）');
  assert.match(source, /findReclaimCandidates\(\{ urls, expected, urlByName \}\)/u,
    'planPageActions 必须真的调用领回判据，不许另抄一份');
  assert.match(source, /\/navigate\?target=/u, '领回就是导航，没有只读版本');
  assert.match(source, /\/new\?url=/u, '补页仍然走 /new');
  assert.match(source, /pinned=1/u, '不带 pinned=1 的页会在闲置 15 分钟后被回收，且不报错');
});
