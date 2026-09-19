// 工作页的盘点与补齐 —— 从仓库外的探针（D:/Retire/probe-live/86-open-shop-pages.mjs）收编进仓库。
//
// 为什么必须收进来：它是**定时链的前提**（体检要求每个期望页面「恰好一个」，缺一个那家店一步都不跑），
// 而它一直住在仓库外 —— 换台机器、换个人，就没有这一步了。收进来之后「缺页自愈」才有落点。
//
// 三条硬要求（都是实测踩出来的，别退回旧版）：
//   1) 新建一律 `/new?url=…&label=…&pinned=1`。不带 `pinned=1` 的页会在闲置 15 分钟后被
//      CDP 代理回收，表现为「今晚补好、明早没了」，而且**全程不报错**。
//   2) 已有页不动：同一个后台出现多于一页时只报不修（关哪一个是人的决定）。
//   3) 飞书页必须带 `?table=&view=`，字段名是 `sourceTable` / `sourceView`（不是 tableId/viewId）——
//      猜错会建出 `table=undefined` 的页，飞书把它重定向到别的表，**不报错**。
//
// 安全默认：**不带 `--open` 时只打印计划，不发任何写请求**（与仓库外那版相反 —— 那一版不带
// `--dry-run` 就真开。收进仓库时把默认改成「不动」，因为补页会改变运行中浏览器的状态）。
//
// 用法：
//   node runtime/shop-pages.mjs            # 只读盘点：每家店缺哪一页（不写）
//   node runtime/shop-pages.mjs --json     # 同上，机器可读
//   node runtime/shop-pages.mjs --open     # 真开缺的那几页（只开缺的；已有一页的不动；多于一个的只报）
//   退出码：0＝每个期望页面都恰好一个；2＝有缺口或代理连不上；3＝有「多于一个」需要人决定
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { siteAdapter } from '../skills/sycm-alimama-daily-report/scripts/date-picker.mjs';
import { SITES } from '../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs';
import {
  expectedPagesForDailyBrowser,
  expectedPagesForShop,
} from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
import { PROJECT_PORTS, ROUTES, shopBrowserKeys, shopInstance } from './browser-ports.mjs';
import { dailyReportTargets, getProfile } from './feishu-targets.mjs';

/**
 * 每家「带代理的浏览器」要开哪些页、通过哪个代理开。
 * 期望页面清单来自 run-multi-shop-day.mjs（与体检、落位**同源**）—— 这里不另抄一份。
 */
export function buildPagePlan() {
  return [
    {
      who: `商家浏览器（${ROUTES.dailyReport.label}）`,
      key: 'dailyReport',
      proxyPort: PROJECT_PORTS.dailyReportProxy,
      expected: expectedPagesForDailyBrowser(),
    },
    ...shopBrowserKeys().map((key) => ({
      who: key,
      key,
      proxyPort: shopInstance(key).proxyPort,
      expected: expectedPagesForShop(),
    })),
  ];
}

/** 「期望页面名」→「开页 URL」。三个值分别来自各自的唯一权威。 */
export function buildUrlByName() {
  const targets = dailyReportTargets();
  const { host } = getProfile();
  return {
    生意参谋工作页: siteAdapter('sycm').entryUrl,
    阿里妈妈报表页: SITES.alimama.probeUrl,
    飞书底单页: `https://${host}/base/${targets.baseToken}?table=${targets.sourceTable}&view=${targets.sourceView}`,
  };
}

/**
 * 覆盖断言：每个期望页面都得知道「怎么开它」。
 * 补不了 URL 就说明「怎么开它」还没确定 —— 那更该停手，而不是建一个 `undefined` 的页。
 */
export function assertCoverage(plan, urlByName) {
  const names = new Set(plan.flatMap((entry) => entry.expected.map((page) => page.name)));
  const missing = [...names].filter((name) => !urlByName[name]);
  if (missing.length) {
    throw new Error(`这些期望页面没有对应的开页 URL：${missing.join('、')}`
      + ' —— 新增期望页面时要在 buildUrlByName 里补一条（补不了就说明「怎么开它」还没确定，那更该停手）');
  }
}

/**
 * 纯函数：拿「当前页签 URL 列表」定出要做什么。
 * 返回值里的 action 只有三种，每种对应一个不同的处置者：
 *   already-one  已经有了，不动
 *   ambiguous    多于一个 —— 只有人能决定关哪个
 *   create       缺 —— 补页（dry 时为 would-create）
 */
export function planPageActions({ urls, expected, urlByName, dry = true }) {
  return expected.map((page) => {
    const hit = urls.filter((url) => url.includes(page.urlFragment)).length;
    const url = urlByName[page.name];
    if (hit === 1) return { page: page.name, action: 'already-one', found: 1 };
    if (hit > 1) return { page: page.name, action: 'ambiguous', found: hit };
    return { page: page.name, action: dry ? 'would-create' : 'create', found: 0, url };
  });
}

/** 一家店盘完之后是不是「全就位」。 */
export function slotsFrom(urls, expected) {
  return expected.map((page) => ({
    page: page.name,
    count: urls.filter((url) => url.includes(page.urlFragment)).length,
  }));
}

export function judgeSlotReport(entries) {
  const unreachable = entries.filter((entry) => !entry.reachable);
  const gaps = entries.filter((entry) => entry.slots?.some((slot) => slot.count !== 1));
  const ambiguous = entries.filter((entry) => entry.actions?.some((action) => action.action === 'ambiguous'));
  return { unreachable, gaps, ambiguous, ok: unreachable.length === 0 && gaps.length === 0 && ambiguous.length === 0 };
}

// 只在自己被直接跑时执行主流程 —— 这样 doctor 之类可以 import 上面的纯函数，
// 而不会顺手把五个后台都探一遍。
const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

async function main() {
  const args = process.argv.slice(2);
  const DRY = !args.includes('--open');
  const AS_JSON = args.includes('--json');
  const unknown = args.find((value) => value.startsWith('--') && !['--open', '--json'].includes(value));

  if (unknown) {
    console.error(`未知参数 ${unknown}；可用：--open --json（不带 --open 时只盘点，不写）`);
    return 2;
  }

  const plan = buildPagePlan();
  const urlByName = buildUrlByName();
  assertCoverage(plan, urlByName);

  const getJson = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    return response.json();
  };

  const report = [];
  for (const entry of plan) {
    const base = `http://127.0.0.1:${entry.proxyPort}`;
    let before;
    try {
      before = await getJson(`${base}/targets`);
    } catch (error) {
      report.push({ who: entry.who, proxyPort: entry.proxyPort, reachable: false, error: error.message, actions: [] });
      continue;
    }
    const urls = before.map((tab) => String(tab.url));
    const actions = planPageActions({ urls, expected: entry.expected, urlByName, dry: DRY });
    for (const action of actions) {
      if (action.action !== 'create') continue;
      const response = await fetch(`${base}/new?url=${encodeURIComponent(action.url)}`
        + `&label=${encodeURIComponent(action.page)}&pinned=1`);
      const created = await response.json().catch(() => ({}));
      action.targetId = created.targetId ?? null;
      action.pinned = created.pinned ?? null;
    }
    const after = await getJson(`${base}/targets`).catch(() => []);
    const afterUrls = after.map((tab) => String(tab.url));
    const health = await getJson(`${base}/health`).catch(() => null);
    report.push({
      who: entry.who,
      proxyPort: entry.proxyPort,
      reachable: true,
      actions,
      slots: slotsFrom(afterUrls, entry.expected),
      pinnedTabs: health?.pinnedTabs ?? null,
      managedTabs: health?.managedTabs ?? null,
      tabs: afterUrls.map((url) => url.slice(0, 120)),
    });
  }

  const verdict = judgeSlotReport(report);

  if (AS_JSON) {
    console.log(JSON.stringify({
      dry: DRY,
      report,
      verdict: {
        ok: verdict.ok,
        unreachable: verdict.unreachable.map((entry) => entry.who),
        gaps: verdict.gaps.map((entry) => entry.who),
        ambiguous: verdict.ambiguous.map((entry) => entry.who),
      },
    }, null, 1));
  } else {
    console.log(`[工作页] ${DRY ? '只读盘点（不带 --open）' : '补齐模式'}；${plan.length} 个后台`);
    for (const entry of report) {
      if (!entry.reachable) {
        console.log(`  连不上 ${entry.who}（代理 ${entry.proxyPort}）：${entry.error}`);
        continue;
      }
      const slots = entry.slots.map((slot) => `${slot.page}=${slot.count}`).join('  ');
      const planned = entry.actions
        .filter((action) => action.action !== 'already-one')
        .map((action) => `${action.page}:${action.action}`)
        .join(' ');
      console.log(`  ${entry.who}  代理 ${entry.proxyPort}  ${slots}${planned ? `  ← ${planned}` : ''}`);
    }
    if (verdict.ambiguous.length) {
      console.log(`  [需人决定] ${verdict.ambiguous.map((entry) => entry.who).join('、')}`
        + ' 同一个后台有多于一页 —— 关哪一个是人的决定，本命令不动');
    }
    if (verdict.unreachable.length) {
      console.log(`  [连不上] ${verdict.unreachable.map((entry) => entry.who).join('、')} —— 代理没起，先起代理`);
    }
    if (verdict.gaps.length) {
      console.log(`  [缺页] ${verdict.gaps.map((entry) => entry.who).join('、')}`
        + (DRY ? ' —— 加 --open 才会真开' : ' —— 上面动作已执行，仍有缺口，看 actions 里的返回值'));
    }
    console.log(`[判据] ${verdict.ok ? '每个期望页面都恰好一个' : '有未就位项（见上）'}`);
  }

  return verdict.ok ? 0 : (verdict.ambiguous.length ? 3 : 2);
}

if (isMain) process.exitCode = await main();
