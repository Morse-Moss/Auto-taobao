// 五家店「刷新页面」这条一键命令的离线判据。
//
// 测什么、为什么测这些：这条命令的**唯一价值**是「回答『刷没刷好』的那个判据是真的」。
// 三个最容易出错、而且错了不会有人发现的地方：
//   1) 读不到读数时 `resolveAppliedDate` 返回 null —— 一旦让它跟「yesterday 也是 null」相等，
//      就会判成「已经是昨日」，于是这条命令变成一台**只会报喜的机器**（这是这条命令最该堵的坑）；
//   2) 在位性判据必须**复用** shop-pages 那一套，不许另起一套（两边漂移时没人知道信谁）；
//   3) 重载这一步的成败判据是「读数变成目标日」，**不是「eval 报没报错」** ——
//      重载会把 eval 的执行上下文一起拆掉，报错是预期内的。
import assert from 'node:assert/strict';
import test from 'node:test';

import { shopBrowserKeys, shopInstance } from './browser-ports.mjs';
import { buildShopPlan, judgeShopRefresh, reloadAndWait, summarizeShopRefresh } from './refresh-shop-pages.mjs';

const YESTERDAY = '2026-09-20';
const SYCM_URL = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const ALIMAMA_URL = 'https://one.alimama.com/index.htm#/report/account';
const slot = (count, page = '生意参谋工作页') => [{ page, count }];
// 片段从**生产计划**取（与真跑时判「页面在不在」用的是同一份），不在用例里另抄。
const PAGE_FRAGMENTS = buildShopPlan()[0].expected.map((page) => page.urlFragment);

test('刷新判定：读数是昨日才算 ready，读不到一律不算（不许把「不知道」判成「已是昨日」）', () => {
  assert.equal(judgeShopRefresh({ slots: slot(1), applied: '统计时间 2026-09-20', yesterday: YESTERDAY }).state, 'ready');
  assert.equal(judgeShopRefresh({ slots: slot(1), applied: '昨日 2026-09-20', yesterday: YESTERDAY }).state, 'ready',
    '回显成预设名也要认（页面实测就是「昨日 2026-09-15」这种写法）');

  const stale = judgeShopRefresh({ slots: slot(1), applied: '统计时间 2026-09-19', yesterday: YESTERDAY });
  assert.equal(stale.state, 'stale');
  assert.match(stale.detail, /2026-09-19/u, '要说清现在读到的到底是哪一天');

  // 这一条就是这条命令最该堵的静默通道：applied 读不到 ⇒ resolved 是 null
  const unreadable = judgeShopRefresh({ slots: slot(1), applied: null, yesterday: YESTERDAY });
  assert.equal(unreadable.state, 'stale', '读不到就读不到 —— 绝不能判成 ready');
  assert.match(unreadable.detail, /读不出来/u);

  // 页面停在别的预设（7 天）时读回的是区间 ⇒ 解析不出单日，同样算 stale
  assert.equal(judgeShopRefresh({ slots: slot(1), applied: '统计时间 2026-09-14 ~ 2026-09-20', yesterday: YESTERDAY }).state,
    'stale', '区间读不出单日 ⇒ 不许蒙一个日期');
});

test('刷新判定：缺了 yesterday 直接抛 —— 它是「读不到」与「已是昨日」之间唯一的分界', () => {
  for (const bad of [undefined, null, '', '昨天', '2026/09/20']) {
    assert.throws(() => judgeShopRefresh({ slots: slot(1), applied: null, yesterday: bad }),
      /需要 YYYY-MM-DD/u, `yesterday=${JSON.stringify(bad)} 必须当场抛`);
  }
});

test('刷新判定：工作页不是恰好一个时先补页，刷新无从谈起（判据与体检同源：0 个和 2 个都不行）', () => {
  assert.equal(judgeShopRefresh({ slots: slot(0), applied: null, yesterday: YESTERDAY }).state, 'not-ready');
  assert.equal(judgeShopRefresh({ slots: slot(2), applied: '统计时间 2026-09-20', yesterday: YESTERDAY }).state, 'not-ready',
    '两页时读数再对也不算 ready —— 链那边体检会直接拦住');
  assert.equal(judgeShopRefresh({ slots: [], applied: null, yesterday: YESTERDAY }).state, 'not-ready',
    '连这一页都没进清单时同样不放行');
});

test('刷新汇总：在位性沿用 shop-pages 的判据（缺口 / 需人决定 / 连不上都算不 ok）', () => {
  const ok = { who: '里可林淘宝', reachable: true, slots: slot(1), actions: [{ action: 'already-one' }],
    verdict: { state: 'ready' } };
  assert.equal(summarizeShopRefresh([ok]).ok, true);

  const stale = { ...ok, who: '科塔淘宝', verdict: { state: 'stale' } };
  const judged = summarizeShopRefresh([ok, stale]);
  assert.equal(judged.ok, false, '还有一家要刷新就不算「可以直接开跑」');
  assert.deepEqual(judged.stale.map((entry) => entry.who), ['科塔淘宝']);

  assert.deepEqual(summarizeShopRefresh([{ ...ok, reachable: false }]).unreachable.length, 1);
  assert.deepEqual(summarizeShopRefresh([{ ...ok, slots: slot(0) }]).gaps.length, 1);
  assert.deepEqual(summarizeShopRefresh([{ ...ok, actions: [{ action: 'ambiguous-drift' }] }]).ambiguous.length, 1,
    '同主机多页要进「需人决定」，本命令不许自己挑一个（这是 shop-pages 的纪律，只沿用不重写）');
});

test('五家店清单来自路线表本身，且每家都要两页（不许在这里另抄一份店名）', () => {
  const plan = buildShopPlan();
  const keys = shopBrowserKeys();
  assert.deepEqual(plan.map((entry) => entry.key).sort(), [...keys].sort());
  assert.equal(plan.length, 5, '五家店');
  for (const entry of plan) {
    assert.equal(entry.expected.length, 2, `${entry.key} 应当有工作页 + 阿里妈妈页两个期望页面`);
    assert.equal(entry.proxyPort, shopInstance(entry.key).proxyPort, '代理端口必须来自这家店自己的登记');
    assert.ok(entry.expected.some((page) => page.name === '生意参谋工作页'), '要刷的是工作页');
  }
});

test('重载：判据是「读数变成目标日」，eval 报错不算失败；一直读不到也不许判成成功', async () => {
  const evalBoom = () => Promise.reject(new Error('Execution context was destroyed.'));
  const okRead = () => Promise.resolve({ applied: '统计时间 2026-09-20' });
  const noSleep = () => Promise.resolve();

  // 前两次还没渲染好（抛），第三次读到目标日 ⇒ 成功，且如实记下读过几次
  let reads = 0;
  const recovering = () => {
    reads += 1;
    return reads < 3 ? Promise.reject(new Error('eval returned object, expected string')) : okRead();
  };
  const settled = await reloadAndWait({ base: 'http://127.0.0.1:19041', targetId: 't1', yesterday: YESTERDAY,
    attempts: 8, intervalMs: 0, sleep: noSleep, fetchImpl: evalBoom, readState: recovering });
  assert.equal(settled.applied, '统计时间 2026-09-20');
  assert.equal(settled.reads, 3);
  assert.equal(settled.readFailures, 2, '渲染前的读失败要记成「读不到几次」，不是「这一步输了」');
  assert.match(settled.evalError, /Execution context was destroyed/u,
    'eval 的报错要如实留下（重载会拆掉执行上下文，这是预期内的），但它不是判据');

  // 读满预算仍是旧日期 ⇒ 如实把最后一次读数带出来（调用方据此判「平台没数据 / 预设不对」）
  const stuck = await reloadAndWait({ base: 'http://127.0.0.1:19041', targetId: 't1', yesterday: YESTERDAY,
    attempts: 3, intervalMs: 0, sleep: noSleep,
    fetchImpl: () => Promise.resolve({ status: 200 }),
    readState: () => Promise.resolve({ applied: '统计时间 2026-09-19' }) });
  assert.equal(stuck.applied, '统计时间 2026-09-19');
  assert.equal(stuck.reads, 3);
  assert.equal(stuck.readFailures, 0, '读成功但那一天不对，与「读不到」是两回事，分得开才判得对');

  // 一次都没读成 ⇒ applied 为 null（不许编一个日期出来）
  const blind = await reloadAndWait({ base: 'http://127.0.0.1:19041', targetId: 't1', yesterday: YESTERDAY,
    attempts: 2, intervalMs: 0, sleep: noSleep,
    fetchImpl: () => Promise.resolve({ status: 200 }),
    readState: () => Promise.reject(new Error('proxy not reachable')) });
  assert.equal(blind.applied, null);
  assert.equal(blind.readFailures, 2);
  assert.match(blind.lastReadError, /proxy not reachable/u);
});

test('重载：走的是页面自己 reload，不是 navigate（同 URL 的 navigate 是同文档导航，什么都不做）', async () => {
  const seen = [];
  await reloadAndWait({ base: 'http://127.0.0.1:19041', targetId: 't1', yesterday: YESTERDAY,
    attempts: 1, intervalMs: 0, sleep: () => Promise.resolve(),
    fetchImpl: (url, init) => { seen.push({ url, init }); return Promise.resolve({ status: 200 }); },
    readState: () => Promise.resolve({ applied: '统计时间 2026-09-20' }) });
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/eval\?target=t1$/u, '必须打 /eval（reload 只能由页面自己执行）');
  assert.match(seen[0].init.body, /window\.location\.reload\(\)/u);
  assert.equal(seen.some(({ url }) => /\/navigate/u.test(url)), false,
    '一次 navigate 都不许发 —— 2026-09-21 实测同 URL navigate 返回成功但页签没被重置');

  // 夹具 URL 与站点片段互锁：片段改了而不改夹具，用例就会在断言一个不存在的世界。
  assert.ok(PAGE_FRAGMENTS.some((fragment) => SYCM_URL.includes(fragment)), '工作页夹具要含生产计划里那个片段');
  assert.ok(PAGE_FRAGMENTS.some((fragment) => ALIMAMA_URL.includes(fragment)), '阿里妈妈页夹具要含生产计划里那个片段');
});
