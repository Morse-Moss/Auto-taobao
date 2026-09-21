// 体检前「归位」这一段的离线判据。
//
// 为什么必须离线把**写侧**也断言掉：这一段是**真的会改到运行中浏览器**的地方
// （导航一页、或新建一页）。这个仓库上一次的写侧事故恰恰是「缺页时它选了新建而不是领回」，
// 而当时那些逻辑留在 `main()` 里、离线根本断言不到。所以这里用**有状态的假代理**把
// 「挑了哪些请求、发了什么、失败怎么记」逐条钉住 —— 真机上再跑一次演练，两步都不能省。
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROJECT_PORTS, shopBrowserKeys } from './browser-ports.mjs';
import { judgeNormalize, normalizePages } from './page-normalize.mjs';
// 期望页面清单从**生产计划**里取，不自己拼一份：用例断言的页面与真跑时补的那两页永远是同一份。
import { buildPagePlan } from './shop-pages.mjs';

// 端口取**登记表里的值**而不是写字面量：这一段完全不碰网络（fetch 全是注入的），
// 用真端口只是省得被「端口字面量」那类守卫盯上，同时保证 URL 形状与真实一致。
const PORT = PROJECT_PORTS.dailyReportProxy;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP_EXPECTED = buildPagePlan()
  .find((entry) => entry.key === shopBrowserKeys()[0]).expected;

const ALIMAMA_URL = 'https://one.alimama.com/index.htm#/report/account';
const DRIFTED_URL = 'https://sycm.taobao.com/lyone/auto_analysis/datafetch/index.htm?taskId=1';
const DRIFTED_URL_2 = 'https://sycm.taobao.com/lyone/auto_analysis/datafetch/index.htm?taskId=2';
const noop = () => Promise.resolve();
const ok = (value) => ({ ok: true, status: 200, json: async () => value });

/** 有状态的假 CDP 代理：`/targets` 读、`/navigate` 与 `/new` 真改内部状态。 */
function fakeProxy(initialUrls = []) {
  const tabs = initialUrls.map((url, index) => ({ targetId: `t${index + 1}`, type: 'page', url }));
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    const parsed = new URL(url);
    if (parsed.pathname === '/targets') return ok(tabs.map((tab) => ({ ...tab })));
    if (parsed.pathname === '/navigate') {
      const target = tabs.find((tab) => tab.targetId === parsed.searchParams.get('target'));
      if (!target) return { ok: false, status: 404, json: async () => ({}) };
      target.url = parsed.searchParams.get('url');
      return ok({ frameId: '0C6B' });
    }
    if (parsed.pathname === '/new') {
      tabs.push({ targetId: `t${tabs.length + 1}`, type: 'page', url: parsed.searchParams.get('url') });
      return ok({ targetId: `t${tabs.length}` });
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unknown path' }) };
  };
  return { tabs, requests, fetchImpl };
}

const runNormalize = ({ initialUrls, dry = false }) => {
  const proxy = fakeProxy(initialUrls);
  return normalizePages({ proxyPort: PORT, expected: SHOP_EXPECTED, dry,
    fetchImpl: proxy.fetchImpl, attempts: 2, intervalMs: 0, sleep: noop }).then((result) => ({ result, proxy }));
};

test('归位判定：就位与否看页签数量，但**动作没做成**也要单独算不 ok（两者下一步不同）', () => {
  const ones = [{ page: '生意参谋工作页', count: 1 }, { page: '阿里妈妈报表页', count: 1 }];
  const zeros = [{ page: '生意参谋工作页', count: 0 }, { page: '阿里妈妈报表页', count: 1 }];

  const already = judgeNormalize({ before: ones, after: ones, actions: [{ page: 'x', action: 'already-one' }] });
  assert.equal(already.ok, true);
  assert.equal(already.changed, false, '本来就在位要如实写「没动过」——不然 summary 上分不出「修好了」和「本来就好」');

  const fixed = judgeNormalize({ before: zeros, after: ones, actions: [{ page: 'x', action: 'reclaim' }] });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.changed, true);
  assert.match(fixed.detail, /已归位/u);

  const failed = judgeNormalize({ before: zeros, after: ones, actions: [{ page: '生意参谋工作页', action: 'reclaim-failed' }] });
  assert.equal(failed.ok, false, '页签数量恰好 1 个，但那是它本来的样子、不是我们弄的 ⇒ 不算成功');
  assert.deepEqual(failed.notDone, ['生意参谋工作页:reclaim-failed']);

  const ambiguous = judgeNormalize({ before: zeros, after: zeros, actions: [{ page: '生意参谋工作页', action: 'ambiguous-drift' }] });
  assert.equal(ambiguous.ok, false, '同主机多页只报不猜 ⇒ 归位失败，交给体检去拦');

  assert.equal(judgeNormalize({ before: zeros, after: zeros, actions: [] }).ok, false, '归位后仍不齐');
});

test('归位：缺页时先领回（导航回去），一个新建请求都不发', async () => {
  const { result, proxy } = await runNormalize({ initialUrls: [DRIFTED_URL, ALIMAMA_URL] });

  assert.equal(result.verdict.ok, true);
  assert.equal(result.verdict.changed, true);
  assert.deepEqual(result.before.map((slot) => slot.count), [0, 1], '停手时工作页是缺的');
  assert.deepEqual(result.after.map((slot) => slot.count), [1, 1]);

  const writes = proxy.requests.filter((entry) => !entry.endsWith('/targets'));
  assert.equal(writes.length, 1, `只该发一个写请求，实际：${writes.join(' | ')}`);
  assert.match(writes[0], new RegExp(`^POST ${BASE.replace('.', '\\.')}/navigate\\?target=t1&url=`, 'u'));
  assert.equal(writes.some((entry) => entry.includes('/new')), false,
    '有页可领回时**不许新建** —— 旧版就是这里选了新建，于是同主机两页、下一轮 fail-closed 停手');
  assert.equal(proxy.tabs.length, 2, '页签数不该变（领回是导航，不是开新页）');
  assert.ok(proxy.tabs[0].url.includes('qos/service/frame/shop/performance'), '被领回的那一页回到了工作页地址');
});

test('归位：同主机多页**只报不猜**，一个写请求都不发（那几页不许被乱导航）', async () => {
  const { result, proxy } = await runNormalize({ initialUrls: [DRIFTED_URL, DRIFTED_URL_2] });

  assert.equal(result.verdict.ok, false);
  assert.ok(result.verdict.notDone.includes('生意参谋工作页:ambiguous-drift'));
  // 阿里妈妈页这一侧是真的没有 ⇒ 该新建就新建，不受另一边的影响
  const writes = proxy.requests.filter((entry) => !entry.endsWith('/targets'));
  assert.equal(writes.some((entry) => entry.includes('/navigate')), false);
  assert.deepEqual(proxy.tabs.slice(0, 2).map((tab) => tab.url), [DRIFTED_URL, DRIFTED_URL_2],
    '认不出该领回哪一页时，那两页必须原样待着');
});

test('归位：一页都没有才新建，且必须 pinned=1（不带它会在闲置 15 分钟后被代理回收，全程不报错）', async () => {
  const { result, proxy } = await runNormalize({ initialUrls: [] });

  const writes = proxy.requests.filter((entry) => !entry.endsWith('/targets'));
  assert.equal(writes.length, 2, '两个期望页面各新建一个');
  for (const entry of writes) {
    assert.ok(entry.includes('/new?url='), `新建要走 /new：${entry}`);
    assert.ok(entry.includes('&pinned=1'), `新建必须钉住：${entry}`);
  }
  assert.equal(result.verdict.ok, true);
  assert.deepEqual(result.after.map((slot) => slot.count), [1, 1]);
});

test('归位：只读时一个写请求都不发（与 shop-pages 的 --open 口径一致）', async () => {
  const { result, proxy } = await runNormalize({ initialUrls: [DRIFTED_URL], dry: true });
  assert.deepEqual(proxy.requests.filter((entry) => !entry.endsWith('/targets')), [],
    'dry 下不许导航、不许新建');
  assert.equal(result.verdict.ok, false, '只读时缺口照样算缺口');
  assert.equal(result.verdict.changed, false);
});

test('归位：代理端口必须是整数，缺了直接抛（不许回落到某个默认端口）', async () => {
  for (const bad of [undefined, null, '19041', 19041.5]) {
    await assert.rejects(() => normalizePages({ proxyPort: bad, expected: SHOP_EXPECTED }),
      /需要代理端口/u, `proxyPort=${JSON.stringify(bad)} 必须当场抛`);
  }
});
