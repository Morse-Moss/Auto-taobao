// shop-pages.mjs 的离线判据。
//
// 三条必须钉住的事（都是踩过的坑的形态）：
//   ① 期望页面清单**只从 run-multi-shop-day.mjs 取**（另抄一份就会与体检/落位漂移）；
//   ② 补页 URL 的飞书那一项必须带 `?table=&view=`，字段名是 sourceTable/sourceView；
//   ③ 「多于一个」只能报、不能动 —— 它是人的决定。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCoverage,
  buildPagePlan,
  buildUrlByName,
  judgeSlotReport,
  planPageActions,
  slotsFrom,
} from './shop-pages.mjs';
import { PROJECT_PORTS, shopBrowserKeys, shopInstance } from './browser-ports.mjs';
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

test('planPageActions 三分类：已有 / 多于一个（只报）/ 缺（补）', () => {
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
