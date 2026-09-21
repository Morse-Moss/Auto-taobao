// 体检之前的「归位」：把某个浏览器上的期望页面补齐到**恰好各一个**。
//
// 为什么需要它（2026-09-21 的第一性原理分析）：这个浏览器不会关（登录态在里面），所以
// 上一轮结束时的页面位置就是这一轮的起点。链里已经有两处因此在自愈：成功路径的第 8 步回位、
// 失败路径的收尾。**第三处就是这里** —— 体检此前只会「报缺页」（`SHOP_BLOCKED` ⇒ 那家店一步
// 都不跑 ⇒ 要人手动去补），而缺页的绝大多数情形是**那一页没丢、只是被上一轮的第 5 步带走了**
// （2026-09-20 实测）。判定与动作都不是新写的：整段复用 `shop-pages.mjs` 的
// `planPageActions`（缺页时先领回、领不回来才新建）+ `planRequests` + `sendRequests`。
//
// 三条纪律（沿用 shop-pages，别在这里放宽）：
//   1) 已经在位的不动；同主机多于一页**只报不猜**（关哪个是人的决定）；
//   2) 新建一律 `pinned=1`（不带它会在闲置 15 分钟后被代理回收，表现为「今晚补好、明早没了」）；
//   3) 认不出该领回哪一页时**什么都不做**，把结论交回调用方 —— 自愈不许变成乱导航。
import { buildUrlByName, planPageActions, planRequests, sendRequests, settleSlots, slotsFrom } from './shop-pages.mjs';

/** 会被 `planRequests` 标成「知道该动却动不了」的动作 —— 这些不算成功。 */
const NOT_DONE = new Set(['reclaim-failed', 'create-failed', 'ambiguous', 'ambiguous-drift']);

/**
 * 纯函数：一次归位到底算不算「都就位了」。
 *
 * 与 `shop-pages` 的 `judgeSlotReport` 同一判据（每页恰好 1 个），但**必须再判一次动作结果**：
 * 「页签数量对了」不等于「我们把它弄对的」—— 例如多于一页时它本来就有 2 个，数量判据永远不过；
 * 而领回失败（代理 500、页签中途被关掉）在页签列表上可能暂时看不出差别。
 * 归位的**唯一目的**是让体检能过，所以这里只回答一件事：现在能不能过。
 */
export function judgeNormalize({ before = [], after = [], actions = [] } = {}) {
  const notDone = actions.filter((action) => NOT_DONE.has(action.action));
  const counts = (snapshot) => snapshot.map((slot) => `${slot.page}=${slot.count}`).join('  ');
  if (notDone.length) {
    return { ok: false, changed: false, notDone: notDone.map((action) => `${action.page}:${action.action}`),
      detail: `有一项不敢动或没做成（${notDone.map((a) => `${a.page}:${a.action}`).join('、')}），交给体检去报` };
  }
  const settled = after.every((slot) => slot.count === 1);
  const same = counts(before) === counts(after);
  return { ok: settled, changed: !same, notDone: [],
    detail: settled
      ? (same ? `本来就在位（${counts(after)}）` : `已归位（${counts(before)} → ${counts(after)}）`)
      : `归位后仍不齐（${counts(after)}）` };
}

/**
 * 归位一个浏览器。**只读时（dry）一个写请求都不发** —— 与 `shop-pages.mjs --open` 同一口径。
 *
 * 依赖注入（`fetchImpl`）与 `sendRequests` 同一个理由：这一层会真的改到运行中的浏览器，
 * 而「只能在真机上跑」正是上次漏掉写路径演练的原因。离线用一个有状态的假代理就能断言
 * 「挑了哪些请求、发了什么、失败怎么记」。
 */
export async function normalizePages({ proxyPort, expected, dry = false, fetchImpl = fetch,
  attempts = 3, intervalMs = 600, sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }) } = {}) {
  if (!Number.isInteger(proxyPort)) {
    throw new Error(`normalizePages 需要代理端口（整数），收到 ${JSON.stringify(proxyPort)}`
      + ' —— 不许猜一个端口（猜错就是往别的店/别的项目上写）');
  }
  const base = `http://127.0.0.1:${proxyPort}`;
  const urlByName = buildUrlByName();
  const read = async () => {
    const response = await fetchImpl(`${base}/targets`, { signal: AbortSignal.timeout(6000) });
    return response.json();
  };

  const targets = await read();
  const beforeUrls = targets.map((tab) => String(tab.url));
  const actions = planPageActions({ urls: beforeUrls, expected, urlByName, dry });
  const requests = planRequests({ actions, targets });
  await sendRequests({ base, requests, fetchImpl });

  const settled = await settleSlots({ expected, read: () => read().catch(() => []),
    attempts, intervalMs, sleep });
  const after = slotsFrom(settled.urls, expected);
  // 动作上的结论（reclaim/create 成功没成功）要一路带回调用方 —— 只留页签数量会把
  // 「领回失败」洗成「缺页」，而这两件事的下一步完全不同。
  return { proxyPort, dry, before: slotsFrom(beforeUrls, expected), after,
    changed: beforeUrls.join('|') !== settled.urls.join('|'),
    actions, requests: requests.map((request) => ({ kind: request.kind, page: request.action.page })),
    settleReads: settled.reads,
    verdict: judgeNormalize({ before: slotsFrom(beforeUrls, expected), after, actions }) };
}
