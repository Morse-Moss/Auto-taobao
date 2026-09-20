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
//   4) **缺页时先「领回」，不要先新建**（2026-09-20 补，踩过一次）：链的第 5 步会把工作页留在
//      报表预览 URL 上，于是体检报「缺工作页」—— 但那一页**没丢，只是漂到别的 URL 了**。
//      此时新建会变成「同主机两页」，第 5 步再把新的那个也留在预览页 ⇒ 下一轮 `resetSycmPage`
//      看到 2 个漂移页、按 fail-closed 停手（它宁可报错也不乱导航，这是对的）。所以：
//      同主机恰好有一页「不属于任何期望页面」⇒ 把它**导航回**期望 URL（reclaim）；
//      多于一页 ⇒ 只报不猜（关哪个/领回哪个是人的决定）；一页都没有 ⇒ 才新建。
//
// 安全默认：**不带 `--open` 时只打印计划，不发任何写请求**（与仓库外那版相反 —— 那一版不带
// `--dry-run` 就真开。收进仓库时把默认改成「不动」，因为补页会改变运行中浏览器的状态）。
//
// 用法：
//   node runtime/shop-pages.mjs            # 只读盘点：每家店缺哪一页、哪一页能领回（不写）
//   node runtime/shop-pages.mjs --json     # 同上，机器可读
//   node runtime/shop-pages.mjs --open     # 可领回的导航回去；确实没有的才真开；多于一个的只报
//   退出码：0＝每个期望页面都恰好一个；2＝有缺口或代理连不上；3＝有需要人决定的项（同主机多于一个，或漂移页认不出该领回哪个）
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
 * URL 的「主机」——协议 + 主机名（含端口），统一小写。认不出来返回 null。
 *
 * 为什么是「主机相等」而不是「片段包含」：漂移页的特点恰恰是**片段不再匹配**
 * （2026-09-20 现场：工作页被第 5 步留在报表预览 URL 上，`sycm.taobao.com/qos/.../performance`
 * 这个片段就认不出它了）。唯一还认得出来的，是它还在同一个站点上。
 * 认不出主机的值（`about:blank`、`devtools://…`）一律返回 null ⇒ **永远不当候选**：
 * 它们不是「漂走的那一页」，把它们导航走是破坏而不是修复。
 */
export function hostOfUrl(value) {
  const match = String(value ?? '').match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/iu);
  return match ? `${match[1].toLowerCase()}${match[2].toLowerCase()}` : null;
}

/**
 * 纯函数：缺的那一页，到底是「真没了」还是「只是漂到别的 URL 了」。
 *
 * 2026-09-20 现场（这就是它存在的原因）：链的第 5 步把工作页留在了报表预览 URL 上，
 * 于是体检报「缺工作页」—— 但那一页**一页都没丢**。旧版这里直接新建 ⇒ 同一个主机
 * 变成两页 ⇒ 下一轮 `resetSycmPage` 看到 2 个漂移页、按 fail-closed 停手
 * （它宁可报错也不乱导航，这是对的），整家店一步都不跑。修法是「先领回，再考虑新建」。
 *
 * 判据只有一条：**同主机、且不匹配任何期望页面的片段**。三种结局：
 *   { page, action:'reclaim',           from, url, to }  恰好一个候选 ⇒ 导航回 `to`
 *   { page, action:'ambiguous-drift',   urls, found, to } 多于一个 ⇒ 只报不猜（与 ambiguous 同一纪律：
 *                                                        领回哪个、关哪个都是人的决定）
 *   { page, action:'create',            url, to }         一个候选都没有 ⇒ 真的没有，才新建
 *
 * 已经在位的页面不在这里出现（「在位」和「多于一个」都归 planPageActions 判）。
 * 「一个候选只能被一页领回」：两页同主机又同时缺时，不能让它们都去领同一个页签 ——
 * 第一页领走后第二页就只剩 create，这是对的。
 */
export function findReclaimCandidates({ urls = [], expected = [], urlByName = {} } = {}) {
  const list = urls.map((url) => String(url));
  const foreign = (url) => !expected.some((page) => url.includes(page.urlFragment));
  const taken = new Set();
  const out = [];
  for (const page of expected) {
    if (list.some((url) => url.includes(page.urlFragment))) continue;
    const to = urlByName[page.name];
    const host = hostOfUrl(to);
    const candidates = host
      ? list.filter((url) => hostOfUrl(url) === host && foreign(url) && !taken.has(url))
      : [];
    if (candidates.length === 1) {
      taken.add(candidates[0]);
      out.push({ page: page.name, action: 'reclaim', from: candidates[0], url: candidates[0], to });
    } else if (candidates.length > 1) {
      out.push({ page: page.name, action: 'ambiguous-drift', found: candidates.length, urls: candidates, to });
    } else {
      out.push({ page: page.name, action: 'create', url: to, to });
    }
  }
  return out;
}

/**
 * 纯函数：拿「当前页签 URL 列表」定出要做什么。
 * 返回值里的 action 每种对应一个不同的处置者：
 *   already-one     已经有了，不动
 *   ambiguous       多于一个 —— 只有人能决定关哪个
 *   reclaim         缺，但同主机有一页只是漂走了 ⇒ 导航回去（dry 时为 would-reclaim）
 *   ambiguous-drift 缺，同主机有多页都不是它开的 ⇒ 只报不猜（进 ambiguous 桶，退出码 3）
 *   create          缺，且同主机一页都没有 ⇒ 新建（dry 时为 would-create）
 */
export function planPageActions({ urls, expected, urlByName, dry = true }) {
  const missing = new Map(
    findReclaimCandidates({ urls, expected, urlByName }).map((entry) => [entry.page, entry]),
  );
  return expected.map((page) => {
    const hit = urls.filter((url) => url.includes(page.urlFragment)).length;
    const url = urlByName[page.name];
    if (hit === 1) return { page: page.name, action: 'already-one', found: 1 };
    if (hit > 1) return { page: page.name, action: 'ambiguous', found: hit };
    const drift = missing.get(page.name);
    if (drift?.action === 'reclaim') {
      return { page: page.name, action: dry ? 'would-reclaim' : 'reclaim', found: 0, url, from: drift.from };
    }
    if (drift?.action === 'ambiguous-drift') {
      return {
        page: page.name, action: 'ambiguous-drift', found: 0, url, drifted: drift.found, from: drift.urls,
      };
    }
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

/** 「需要人决定」的动作 —— 这两种都不许自己动手。 */
const NEEDS_HUMAN = new Set(['ambiguous', 'ambiguous-drift']);

export function judgeSlotReport(entries) {
  const unreachable = entries.filter((entry) => !entry.reachable);
  const gaps = entries.filter((entry) => entry.slots?.some((slot) => slot.count !== 1));
  const ambiguous = entries.filter((entry) => entry.actions?.some((action) => NEEDS_HUMAN.has(action.action)));
  return { unreachable, gaps, ambiguous, ok: unreachable.length === 0 && gaps.length === 0 && ambiguous.length === 0 };
}

/**
 * 动作发完之后回读，直到每个期望页面都被认出来（或读满预算）。
 *
 * 为什么不能只读一遍（2026-09-20 实测，与 `shop-window-label.mjs` 的 `/close` 那条同源）：
 * `/navigate` 自己会 `waitForLoad`，但「代理的 `/targets` 里 URL 已经换掉」仍可能晚一拍。
 * 读太早会把**成功的领回**报成「还缺」，方向与「只信返回码」相反、但同样是假报告 ——
 * 而这一份报告的读者是「要不要再加 --open 补页」的人。
 *
 * 依赖注入（`read` / `sleep`）是为了可离线测：真机上这里只花最多两次 600ms。
 */
export async function settleSlots({
  expected = [],
  read,
  attempts = 3,
  intervalMs = 600,
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
} = {}) {
  const satisfied = (list) => expected.every((page) => list.some((url) => String(url).includes(page.urlFragment)));
  let targets = [];
  let urls = [];
  let reads = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    targets = await read();
    urls = (Array.isArray(targets) ? targets : []).map((tab) => String(tab.url));
    reads += 1;
    if (satisfied(urls)) break;
  }
  return { targets, urls, reads, settled: satisfied(urls) };
}

/**
 * 纯函数：把「要做什么」翻成「要发哪些写请求」。
 *
 * 为什么这一步必须是纯的、可离线断言的：写侧的逻辑留在 `main()` 里就永远测不到，
 * 而这个文件唯一一次真事故恰恰出在写侧 —— 缺页时它选了「新建」而不是「领回」。
 * 「哪个动作会真的落到浏览器上」这件事，不该只有跑到真机才知道。
 *
 * 返回请求列表（`kind`）：
 *   navigate  领回：把 drifted 那一页导航回 `url`
 *   new       新建：`/new?url=…&label=…&pinned=1`
 *   blocked   知道该动却动不了（两次读之间页签被关掉、没有 targetId）—— 必须报出来，不许静默跳过
 * dry 计划里的动作名是 `would-reclaim` / `would-create` ⇒ 落到这里一个请求都不产生。
 */
export function planRequests({ actions = [], targets = [] } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const requests = [];
  for (const action of actions) {
    if (action.action === 'reclaim') {
      const matches = list.filter((tab) => String(tab.url) === String(action.from));
      const targetId = matches.length === 1 ? (matches[0].targetId ?? matches[0].id ?? null) : null;
      if (!targetId) {
        requests.push({
          kind: 'blocked',
          action,
          error: matches.length === 1
            ? '那一页没有 targetId，没敢动'
            : `按 URL 找不到唯一的那一页（${matches.length} 个），没敢动`,
        });
        continue;
      }
      requests.push({ kind: 'navigate', action, targetId, url: action.url });
      continue;
    }
    if (action.action === 'create') requests.push({ kind: 'new', action, url: action.url, label: action.page });
  }
  return requests;
}

/**
 * 把 `planRequests` 挑出来的请求发出去，并把结果写回动作对象上。**只发送，不判断。**
 *
 * 与 `planRequests` 分开的理由：挑了请求不等于发对了请求（方法、参数名、编码、代理是否认），
 * 而这一层是唯一**真的会改到运行中浏览器**的地方。分开之后：
 *   · `planRequests` 可以在离线里断言「挑了什么」；
 *   · 这一层可以在离线里用一个有状态的假代理断言「发了什么、失败怎么记」；
 *   · 真机上还能拿一个演练实例跑一遍（`--open` 的写路径必须真跑过一次）。
 * `base` 与 `fetchImpl` 都可注入 —— 「只能在真机上跑」正是上次漏掉这一步的原因。
 */
export async function sendRequests({ base, requests = [], fetchImpl = fetch } = {}) {
  for (const request of requests) {
    const { action } = request;
    if (request.kind === 'blocked') {
      action.action = 'reclaim-failed';
      action.error = request.error;
      continue;
    }
    if (request.kind === 'navigate') {
      action.targetId = request.targetId;
      const response = await fetchImpl(`${base}/navigate?target=${encodeURIComponent(request.targetId)}`
        + `&url=${encodeURIComponent(request.url)}`, { method: 'POST' }).catch(() => null);
      action.status = response?.status ?? null;
      if (!response?.ok) {
        action.action = 'reclaim-failed';
        action.error = `代理 /navigate 回 HTTP ${action.status ?? '连不上'}`;
      }
      continue;
    }
    const response = await fetchImpl(`${base}/new?url=${encodeURIComponent(request.url)}`
      + `&label=${encodeURIComponent(request.label)}&pinned=1`).catch(() => null);
    // 只记代理**真回的东西**：真代理的 `/new` 回的是 `{ targetId }`，不回 pinned。
    // 原先这里还记了一个 `created.pinned`，读出来永远是 null —— 一个看着有数据、其实什么都
    // 没说的字段。钉住没钉住要问 `/health` 的 `pinnedTabs`（下面 report 里就有）。
    let created = {};
    try { created = (await response.json()) ?? {}; } catch { created = {}; }
    action.targetId = created.targetId ?? null;
    if (!response?.ok) {
      action.action = 'create-failed';
      action.error = `代理 /new 回 HTTP ${response?.status ?? '连不上'}`;
    }
  }
  return requests;
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
    // 写请求由纯函数挑（planRequests）、由 sendRequests 发；main 只做编排。
    // 「领回」就是导航本身，没有只读版本 ⇒ 不带 `--open` 时动作停在 `would-reclaim`，一个请求都不发。
    await sendRequests({ base, requests: planRequests({ actions, targets: before }) });
    // 回读要**容一拍**（见 settleSlots 的注释）：读太早会把成功的领回报成「还缺」。
    // 代理连不上时沿用旧口径：当成空列表，绝不抛穿。
    const settled = await settleSlots({
      expected: entry.expected,
      read: () => getJson(`${base}/targets`).catch(() => []),
    });
    const afterUrls = settled.urls;
    const health = await getJson(`${base}/health`).catch(() => null);
    report.push({
      who: entry.who,
      proxyPort: entry.proxyPort,
      reachable: true,
      actions,
      settleReads: settled.reads,
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
    const brief = (url) => String(url).slice(0, 100);
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
      console.log(`  ${entry.who}  代理 ${entry.proxyPort}  ${slots}${planned ? `  ← ${planned}` : ''}`
        + (entry.settleReads > 1 ? `  （回读×${entry.settleReads}）` : ''));
      for (const action of entry.actions) {
        if (action.action === 'would-reclaim' || action.action === 'reclaim') {
          console.log(`      ↳ 领回 ${action.page}：${brief(action.from)} → ${brief(action.url)}`
            + (action.action === 'reclaim' ? `（HTTP ${action.status}）` : '（加 --open 才真做）'));
        }
        if (action.action === 'reclaim-failed') {
          console.log(`      ↳ 领回 ${action.page} 失败：${action.error}`);
        }
        if (action.action === 'ambiguous-drift') {
          console.log(`      ↳ ${action.page} 缺，但同主机有 ${action.drifted} 页都不是它开的，`
            + '认不出该领回哪一页（不猜，交给人）：');
          for (const url of action.from) console.log(`         · ${brief(url)}`);
        }
      }
    }
    if (verdict.ambiguous.length) {
      console.log(`  [需人决定] ${verdict.ambiguous.map((entry) => `${entry.who}（`
        + `${entry.actions.filter((action) => NEEDS_HUMAN.has(action.action))
          .map((action) => `${action.page}:${action.action}`).join(' ')}）`).join('、')}`
        + ' —— 这几项本命令不动：关哪个、领回哪一页都是人的决定');
    }
    if (verdict.unreachable.length) {
      console.log(`  [连不上] ${verdict.unreachable.map((entry) => entry.who).join('、')} —— 代理没起，先起代理`);
    }
    if (verdict.gaps.length) {
      console.log(`  [缺页] ${verdict.gaps.map((entry) => entry.who).join('、')}`
        + (DRY ? ' —— 加 --open 才会领回/真开（见上面每一行 ↳）'
          : ' —— 上面动作已执行，仍有缺口，看 actions 里的 status/error 与回读次数'));
    }
    console.log(`[判据] ${verdict.ok ? '每个期望页面都恰好一个' : '有未就位项（见上）'}`);
  }

  return verdict.ok ? 0 : (verdict.ambiguous.length ? 3 : 2);
}

if (isMain) process.exitCode = await main();
