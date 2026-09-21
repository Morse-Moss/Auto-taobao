// 一键：把**五家店**的生意参谋工作页刷成「刚加载过」的状态。
//
// 为什么需要它（2026-09-21 的第一性原理分析）：这个浏览器不会关（登录态在里面），所以
// **上一轮结束时的页面位置就是这一轮的起点**。而生意参谋的「1天」是**相对预设**，只在页面
// 加载时解析一次 ⇒ 页面停在上一轮的渲染上时，点一个已选中的「1天」不会重新取数，
// DOM 就永远停在旧日期（2026-09-21 首次定时真跑就栽在这上面，五家店读数全是 09-19）。
//
// 链自己已经会自愈（读数不是目标日就先真重载一次，见 date-picker 的 `needsStaleReload`）。
// 这条命令是**同一个动作的人工出口**：出问题之后不必挨个窗口去按 F5，一条命令五家一起；
// 它同时也是「刷新之后到底好没好」的判据——不是「我按了 F5」，而是「读数变成了昨日」。
//
// **不另造第二份实现**：页面在位性（缺页先领回、再考虑新建、同主机多页只报不猜）整段复用
// `runtime/shop-pages.mjs` 的纯函数；读数复用落位脚本导出的 `readSiteState`。这里只多两样
// shop-pages 没有的东西：生意参谋的**读数字段**，和「重载 + 等到读数变对」这一小段循环。
//
// 用法：
//   node runtime/refresh-shop-pages.mjs          # 只读：五家店页面在哪、工作页读数是不是昨日
//   node runtime/refresh-shop-pages.mjs --open   # 真做：先补/领回缺页，读数不是昨日的真重载
//   node runtime/refresh-shop-pages.mjs --json   # 机器可读
// 退出码：0＝五家店都就位、且读数已是昨日（可以直接开跑）；
//         2＝有缺口、读数不对或代理连不上；3＝有需要人决定的项（同主机多于一个，或认不出该领回哪个）。
//
// 安全默认与 `shop-pages.mjs` 一致：**不带 `--open` 时只打印，不导航、不新建、不重载**。
// 唯一的例外是「读一次页面读数」——那是一次只读 eval（没有它，这条命令就只能回答「页面在不在」，
// 回答不了「刷不刷新」）。它不改页面。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSiteState, resolveAppliedDate, shiftIso, shanghaiToday } from '../skills/sycm-alimama-daily-report/scripts/date-picker.mjs';
import { shopBrowserKeys, shopInstance } from './browser-ports.mjs';
import {
  assertCoverage,
  buildPagePlan,
  buildUrlByName,
  judgeSlotReport,
  planPageActions,
  planRequests,
  sendRequests,
  settleSlots,
  slotsFrom,
} from './shop-pages.mjs';

/** 只有这一页需要刷新。阿里妈妈页的日期全在 URL hash 里、链每次都 navigate，不靠渲染。 */
export const REFRESH_PAGE = '生意参谋工作页';

const delay = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** 五家店自己的浏览器（不含商家浏览器 —— 它没有阿里妈妈页，刷新口径不同）。 */
export function buildShopPlan() {
  const keys = shopBrowserKeys();
  const plan = buildPagePlan().filter((entry) => keys.includes(entry.key));
  if (plan.length !== keys.length) {
    throw new Error(`五家店里有 ${keys.length - plan.length} 家没有拿到页面清单 —— 别在缺项的情况下往下刷`);
  }
  return plan;
}

/**
 * 「这一家现在能不能直接开跑」的只读判定（纯函数）。三种结论分开，因为要做的动作不同：
 *   ready      页面在位、读数已经是昨日 ⇒ 什么都不用做（重载一次是**空操作**，所以不必做）
 *   stale      页面在位、但读数不是昨日（或读不出单日）⇒ 需要真重载一次
 *   not-ready  工作页不是恰好一个 ⇒ 先补页/领回（那是 shop-pages 那一套的动作，刷新无从谈起）
 *
 * `yesterday` **必须给**，且必须是 YYYY-MM-DD：读不到读数时 `resolveAppliedDate` 返回 null，
 * 而 null === null 会让「读不到」被当成「已是昨日」—— 那条静默通道正是这条命令最该堵的。
 */
export function judgeShopRefresh({ slots = [], applied = null, yesterday = null, page = REFRESH_PAGE } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(yesterday ?? ''))) {
    throw new Error(`judgeShopRefresh 需要 YYYY-MM-DD 的 yesterday，收到 ${JSON.stringify(yesterday)}`
      + ' —— 缺了它「读不到读数」会被判成「已经是昨日」');
  }
  const count = slots.find((slot) => slot.page === page)?.count ?? 0;
  if (count !== 1) {
    return { state: 'not-ready', count, applied, resolved: null,
      detail: `${page} 现在有 ${count} 个（要恰好 1 个）—— 先补页/领回，刷新无从谈起` };
  }
  const resolved = resolveAppliedDate({ text: applied, yesterday });
  if (resolved === yesterday) {
    return { state: 'ready', count, applied, resolved, detail: `读数已是昨日（${String(applied).slice(0, 60)}）` };
  }
  if (applied === null || applied === undefined) {
    return { state: 'stale', count, applied, resolved: null, detail: '读数读不出来（页面没渲染好）—— 重载一次' };
  }
  return { state: 'stale', count, applied, resolved,
    detail: resolved
      ? `读数是 ${resolved}，不是昨日 ${yesterday} —— 重载一次`
      : `读数读不出单日（${String(applied).slice(0, 40)}）—— 页面可能停在别的预设上，重载一次` };
}

/**
 * 五家店的结论汇总（纯函数）：决定退出码，也决定「要不要人来看」。
 *
 * 在位性那半**直接复用 `shop-pages.mjs` 的 `judgeSlotReport`**（同一份判据、同一个输出形状），
 * 这里只加两样它没有的：读数是不是昨日（`stale`），以及由这两者共同决定的 `ok`。
 * 另起一套「缺口」判据就是等着两边漂移 —— 漂移的症状是「一个说就位、一个说缺」，而没人知道信谁。
 */
export function summarizeShopRefresh(entries = []) {
  const presence = judgeSlotReport(entries);
  const stale = entries.filter((entry) => entry.verdict?.state === 'stale');
  return { ...presence, stale, ok: presence.ok && stale.length === 0 };
}

/**
 * 重载一次并等到读数变对。
 *
 * 两条与 `date-picker` 里同一动作的注意事项（都踩过）：
 *   1) 必须是页面**自己** reload。`/navigate` 到同一个 URL 是**同文档导航**，浏览器什么都不做
 *      （看着返回成功，页签没被重置）。
 *   2) 这次 eval **报错是预期内的**：重载会把 eval 的执行上下文一起拆掉。真正的判据是
 *      「重载之后能不能读出目标日」，不是这次调用报没报错。
 */
export async function reloadAndWait({ base, targetId, yesterday, site = 'sycm',
  attempts = 8, intervalMs = 1500, fetchImpl = fetch, readState = (options) => readSiteState(options),
  sleep = delay } = {}) {
  let evalStatus = null;
  let evalError = null;
  const response = await fetchImpl(`${base}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: "window.location.reload(); 'reloading'", signal: AbortSignal.timeout(30000) })
    .catch((error) => { evalError = String(error?.message ?? error).split('\n')[0].slice(0, 200); return null; });
  evalStatus = response?.status ?? null;

  let applied = null;
  let reads = 0;
  let readFailures = 0;
  let lastReadError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    reads += 1;
    try {
      applied = (await readState({ proxy: base, site, targetId })).applied;
      lastReadError = null;
    } catch (error) {
      lastReadError = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      readFailures += 1;
      continue;
    }
    if (resolveAppliedDate({ text: applied, yesterday }) === yesterday) break;
  }
  return { evalStatus, evalError, applied, reads, readFailures, lastReadError };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

async function main() {
  const args = process.argv.slice(2);
  const DRY = !args.includes('--open');
  const AS_JSON = args.includes('--json');
  const unknown = args.find((value) => value.startsWith('--') && !['--open', '--json'].includes(value));
  if (unknown) {
    console.error(`未知参数 ${unknown}；可用：--open --json（不带 --open 时只盘点，不动页面）`);
    return 2;
  }

  const yesterday = shiftIso(shanghaiToday(), -1);
  const plan = buildShopPlan();
  const urlByName = buildUrlByName();
  assertCoverage(plan, urlByName);

  const getJson = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    return response.json();
  };

  const report = [];
  for (const entry of plan) {
    const base = `http://127.0.0.1:${entry.proxyPort}`;
    const row = { who: entry.key, proxyPort: entry.proxyPort, reachable: true, actions: [], slots: null,
      settleReads: null, applied: null, readError: null, reload: null, verdict: null };
    report.push(row);

    let before;
    try {
      before = await getJson(`${base}/targets`);
    } catch (error) {
      Object.assign(row, { reachable: false, error: error.message });
      continue;
    }

    const urls = before.map((tab) => String(tab.url));
    const actions = planPageActions({ urls, expected: entry.expected, urlByName, dry: DRY });
    row.actions = actions.map((action) => ({ page: action.page, action: action.action,
      from: action.from ?? null, found: action.found ?? null }));
    await sendRequests({ base, requests: planRequests({ actions, targets: before }) });

    const settled = await settleSlots({
      expected: entry.expected,
      read: () => getJson(`${base}/targets`).catch(() => []),
    });
    const targets = Array.isArray(settled.targets) ? settled.targets : [];
    row.slots = slotsFrom(settled.urls, entry.expected);
    row.settleReads = settled.reads;

    // 读数字段只对「恰好一个工作页」的那一页读 —— 页面不齐时读它没有意义（而读数不是判据）。
    const expectedPage = entry.expected.find((page) => page.name === REFRESH_PAGE);
    const tab = targets.find((item) => String(item.url).includes(expectedPage.urlFragment));
    if (tab) {
      try {
        row.applied = (await readSiteState({ proxy: base, site: 'sycm', targetId: tab.targetId })).applied;
      } catch (error) {
        row.readError = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      }
    }

    row.verdict = judgeShopRefresh({ slots: row.slots, applied: row.applied, yesterday });

    if (!DRY && row.verdict.state === 'stale' && tab) {
      row.reload = await reloadAndWait({ base, targetId: tab.targetId, yesterday });
      // 重载之后再判一次：仍不是昨日就不是「没刷」，而是「平台这一天还没有数」或「预设不是 1天」——
      // 两种都不该被含糊成「刷新失败」。
      row.verdict = judgeShopRefresh({ slots: row.slots, applied: row.reload.applied, yesterday });
    }
  }

  const verdict = summarizeShopRefresh(report);

  if (AS_JSON) {
    console.log(JSON.stringify({ dry: DRY, yesterday, report,
      verdict: { ok: verdict.ok, unreachable: verdict.unreachable.map((e) => e.who),
        gaps: verdict.gaps.map((e) => e.who), ambiguous: verdict.ambiguous.map((e) => e.who),
        stale: verdict.stale.map((e) => e.who) } }, null, 1));
  } else {
    console.log(`[五家店] ${DRY ? '只读盘点（不带 --open：不导航、不新建、不重载）' : '刷新模式'}`
      + `；目标读数 = 昨日 ${yesterday}`);
    for (const row of report) {
      if (!row.reachable) {
        console.log(`  ${row.who}  连不上（代理 ${row.proxyPort}）：${row.error}`);
        continue;
      }
      const slots = row.slots.map((slot) => `${slot.page}=${slot.count}`).join('  ');
      const reloaded = row.reload
        ? `  重载后读数 ${String(row.reload.applied).slice(0, 40)}（读 ${row.reload.reads} 次，读不到 ${row.reload.readFailures} 次）`
        : '';
      console.log(`  ${row.who}  代理 ${row.proxyPort}  ${slots}  ${row.verdict.state}${reloaded}`);
      if (row.readError) console.log(`      ↳ 读数读不出来：${row.readError}`);
      for (const action of row.actions) {
        if (action.action === 'ambiguous' || action.action === 'ambiguous-drift') {
          console.log(`      ↳ ${action.page}：${action.action}（本命令不动，关哪个/领回哪一页是人的决定）`);
        } else if (action.action !== 'already-one') {
          console.log(`      ↳ ${action.page}：${action.action}${DRY ? '（加 --open 才真做）' : ''}`);
        }
      }
      if (row.verdict.state !== 'ready') console.log(`      ↳ ${row.verdict.detail}`);
    }
    if (verdict.stale.length && DRY) {
      console.log(`  [要刷新] ${verdict.stale.map((e) => e.who).join('、')} —— 加 --open 才真重载`);
    }
    if (verdict.ambiguous.length) {
      console.log(`  [需人决定] ${verdict.ambiguous.map((e) => e.who).join('、')} —— 本命令不动`);
    }
    if (verdict.unreachable.length) {
      console.log(`  [连不上] ${verdict.unreachable.map((e) => e.who).join('、')} —— 代理没起，先起代理`);
    }
    console.log(`[判据] ${verdict.ok ? '五家店页面都就位、读数都已是昨日（可以直接开跑）'
      : '有未就位项（见上）'}`);
  }

  return verdict.ok ? 0 : (verdict.ambiguous.length ? 3 : 2);
}

if (isMain) process.exitCode = await main();
