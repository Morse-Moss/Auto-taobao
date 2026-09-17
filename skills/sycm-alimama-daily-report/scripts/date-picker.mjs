#!/usr/bin/env node
// 日报 SOP 的「日期落位」原语：把「页面统计日期」变成受断言保护的一步。
//
// 为什么需要它（见 docs/ops/DAILY-REPORT-RUN-2026-09-14-FINDINGS.md §1、§3）：
//   1. 日历里同一个日号会出现多次（左右两块日历可能同显一个月），按文本取「第一个」会静默点错；
//   2. 面板一开一合就改变布局，绝对坐标随时失效；
//   3. 「点过了」不等于「生效了」——尤其预设日期是相对时间。
// 所以对外只暴露 applyDate()：读 → 点 → 回读断言，任何一条不成立就抛错，绝不「猜」。
//
// 两个站点落位方式不同，这是实测结论，不是设计偏好：
//   alimama —— 筛选状态完整编码在 URL hash（startTime/endTime/effectEqual/bizCodeIn）。
//             实测：直接用带参 URL 打开 2026-09-14，页面回显 2026-09-14 ＋ 关键词推广/人群推广
//             ＋ 30天累计数据 ＋ 分日，无需任何点击。所以这里走「构造 URL + 回读断言」，
//             日历路径整个不需要（未实测的日历代码不留在交付物里）。
//   sycm    —— URL 不含日期，只能操作控件：预设「1天」＝昨日（唯一能拿到同行同层对比行的模式），
//             或「自定义」＋日历（回填历史日；代价是对比行消失）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';

const SITE_TIME_ZONE = 'Asia/Shanghai';
const ALIMAMA_BASE = 'https://one.alimama.com/index.html#!/report/account';
// 场景编码：onebpSearch=关键词推广、onebpDisplay=人群推广。
// 目标表只认这两行，所以它们必须进 URL，而不是靠页面默认值（页面默认是「全部营销场景」）。
const ALIMAMA_SCENES = Object.freeze(['onebpSearch', 'onebpDisplay']);
// 场景在筛选栏上的中文回显，用于断言 URL 参数真的落到了页面上
const ALIMAMA_SCENE_LABELS = Object.freeze(['关键词推广', '人群推广']);
// 归因方式：目标表口径是「末次点击归因」+「30天累计数据」，两者必须都在
const ALIMAMA_REQUIRED_TRIGGERS = Object.freeze(['末次点击归因', '30天累计数据', '分日']);

// ---------------------------------------------------------------- 纯函数区

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function shiftIso(isoDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(isoDate ?? '')) throw new Error(`invalid iso date: ${isoDate}`);
  const cursor = new Date(`${isoDate}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

// auto 的判定：目标日等于站点时区的昨日就走预设。调用方在开始那一刻冻结 now，
// 执行过程中不再取 now，否则跨零点会把「昨日」漂到另一天（相对日期的最大风险）。
export function resolveDateMode({ requested, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(requested ?? '')) throw new Error(`invalid requested date: ${requested}`);
  const today = shanghaiToday(now);
  const yesterday = shiftIso(today, -1);
  return { requested, today, yesterday, mode: requested === yesterday ? 'preset' : 'explicit' };
}

export function extractIsoDates(text) {
  return String(text ?? '').match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
}

export function buildAlimamaUrl({ requested, effectCycle = 30, granularity = 'day' }) {
  const [start, end] = [requested, requested];
  const params = new URLSearchParams({
    rptType: 'account',
    startTime: start,
    endTime: end,
    effectEqual: String(effectCycle),
    bizCodeIn: JSON.stringify(ALIMAMA_SCENES),
    granularity,
  });
  return `${ALIMAMA_BASE}?${params.toString()}`;
}

// 页面把「等于某个预设」的区间回显成预设名（实测：09-15 回显「昨日」），所以要允许预设名换算。
export function resolveAppliedDate({ text, yesterday }) {
  const dates = extractIsoDates(text);
  if (dates.length === 0) {
    if (/昨日/u.test(String(text ?? ''))) return yesterday;
    return null;
  }
  if (dates.length === 1 && dates[0] === yesterday && /昨日/u.test(String(text ?? ''))) {
    // 既给了日期又带预设名（形如「昨日 2026-09-15」），两个来源必须一致
    return dates[0];
  }
  const unique = [...new Set(dates)];
  return unique.length === 1 ? unique[0] : null;
}

// 断言按「语义」而非「索引」：筛选栏的 trigger 顺序是页面实现细节，索引一变就静默断言错对象。
// 实测筛选栏（2026-09-16）共 11 个 trigger：
//   [0] 关键词推广 人群推广 · [1] 末次点击归因 · [2] 30天累计数据 · [3] " 2026-09-14" · [4] 分日 · …
export function assertAlimamaState({ state, requested, yesterday }) {
  const triggers = state?.triggers ?? [];
  if (triggers.length < 6) {
    throw new Error(`alimama filter bar not ready; triggers=${triggers.length}`);
  }
  const joined = triggers.join(' | ');
  const applied = resolveAppliedDate({ text: state.applied, yesterday });
  if (applied !== requested) {
    throw new Error(`alimama applied date is ${JSON.stringify(state.applied)} -> ${applied}; expected ${requested}`);
  }
  for (const scene of ALIMAMA_SCENE_LABELS) {
    if (!joined.includes(scene)) {
      throw new Error(`alimama 营销场景 missing ${scene}; triggers=${JSON.stringify(triggers)}`);
    }
  }
  for (const required of ALIMAMA_REQUIRED_TRIGGERS) {
    if (!joined.includes(required)) {
      throw new Error(`alimama filter missing ${required}; triggers=${JSON.stringify(triggers)}`);
    }
  }
  return {
    applied,
    filters: {
      scenes: triggers.find((text) => text.includes(ALIMAMA_SCENE_LABELS[0])) ?? null,
      effectCycle: triggers.find((text) => text.includes('天累计数据')) ?? null,
      granularity: triggers.find((text) => text === '分日') ?? null,
    },
  };
}

// 日历面板的真实结构（2026-09-16 实测，不是猜测）：
//   .oui-date-picker-menu.open
//     .oui-dt-calendar-content.rangeLeft  → .oui-dt-calendar-pannel
//         .oui-dt-calendar-control.year  = "2026年"
//         .oui-dt-calendar-control.month = "9月"      ← 年月是两个独立元素，不能按整体文本解析
//         .oui-dt-calendar-table td.oui-dt-calendar-day-N.current-month|previous-month|next-month
//     同一个月会出现两次（rangeLeft / rangeRight），所以同一天在两个块里各有一个格子：
//     单日区间＝左块点一次、右块点一次（面板自己写明「最少选择 1 天」）。
//     .oui-dt-calendar-control[data-role="prev-month"|"next-month"] 是翻月箭头，禁用时带 .disabled
// 「本月」由 current-month 类直接给出，不需要早期那套「靠两个 1 划月」的几何推算——那套已删除。
export function shiftMonth(isoDate, delta) {
  const [year, month] = isoDate.split('-').map(Number);
  const cursor = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function selectDayHits(blocks, isoDate) {
  const dayNumber = Number(isoDate.slice(8, 10));
  const [year, month] = isoDate.split('-').map(Number);
  const matched = (blocks ?? []).filter((block) => block.year === year && block.month === month);
  if (matched.length === 0) {
    const visible = (blocks ?? []).map((block) => `${block.year}-${String(block.month).padStart(2, '0')}`).join(', ');
    throw new Error(`calendar does not show ${isoDate.slice(0, 7)}; visible: ${visible}`);
  }
  const hits = [];
  for (const block of matched) {
    const matches = block.cells.filter((cell) => Number(cell.text) === dayNumber);
    if (matches.length !== 1) {
      throw new Error(`calendar block ${block.index}: expected one day ${dayNumber}, got ${matches.length}`);
    }
    hits.push({ blockIndex: block.index, cell: matches[0] });
  }
  return { dayNumber, hits };
}

// 选择的区间是否就是单个目标日（面板文本形如「已选择：2026-09-14 至 2026-09-14」）
export function isSingleDaySelection(text, isoDate) {
  const dates = extractIsoDates(text ?? '');
  return dates.length === 2 && dates[0] === isoDate && dates[1] === isoDate;
}


// ---------------------------------------------------------------- 页面读取

const READ_EXPRESSIONS = Object.freeze({
  alimama: `(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const triggers = [...document.querySelectorAll('.mx-trigger')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => clean(el.textContent));
    if (triggers.length < 6) throw new Error('alimama filter bar not ready; triggers=' + triggers.length);
    const dateLike = triggers.filter((text) => /\\d{4}-\\d{2}-\\d{2}|昨日|今日/.test(text));
    if (dateLike.length !== 1) throw new Error('alimama date trigger ambiguous: ' + JSON.stringify(dateLike));
    return JSON.stringify({ applied: dateLike[0], triggers });
  })()`,
  sycm: `(() => {
    const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('.oui-date-picker-current-date')];
    if (nodes.length !== 1) throw new Error('sycm date readout count=' + nodes.length);
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')].map((el) => ({
      text: clean(el.textContent),
      active: /ant-tabs-tab-active/.test(String(el.className || '')),
    }));
    return JSON.stringify({
      applied: clean(nodes[0].textContent),
      tabs: tabs.map((tab) => tab.text).filter((text) => text !== ''),
      activeTabs: tabs.filter((tab) => tab.active).map((tab) => tab.text).filter((text) => text !== ''),
    });
  })()`,
});

// 页面内共用前置。三个实测坑都在这里一次性处理：
//   1. innerText 对「1天/按7天为周期/按30天为周期」返回空串（textContent 正常）→ 一律用 textContent；
//   2. 元素可能落在视口外（实测视口 1031x667，自定义按钮在 x=1035）→ 真实鼠标点击会静默落空，
//      所以先 scrollIntoView 再取点，并用 elementFromPoint 复核命中，把「点了个空气」变成显式报错；
//   3. 文案匹配必须唯一，命中 0 个或多个都报错，绝不「取第一个」。
const SYCM_PRELUDE = `
  const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const digits = (value) => Number(String(value ?? '').replace(/[^0-9]/g, ''));
  const inside = (r) => r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
  const rendered = (el) => { const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0; };
  const one = (matches, label) => {
    if (matches.length !== 1) throw new Error(label + ' count=' + matches.length);
    return matches[0];
  };
  const pointOf = (el) => { const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; };
  const aim = (el, label) => {
    if (!inside(el.getBoundingClientRect())) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) throw new Error(label + ': not rendered');
    if (!inside(r)) throw new Error(label + ': still outside viewport after scrollIntoView; rect='
      + JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])
      + ' viewport=' + window.innerWidth + 'x' + window.innerHeight);
    const [x, y] = pointOf(el);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) {
      throw new Error(label + ': point (' + x + ',' + y + ') is covered by '
        + (hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 40) : 'nothing'));
    }
    return [x, y];
  };
`;

// 页签必须切对：活动页签是「汇总分析」时，日期控件是另一套，读出的按钮文案也不同。
// 「日期读对了」不等于「页签对了」——两件事都断言。
function sycmTabExpression(tab) {
  return `(() => {
  ${SYCM_PRELUDE}
  const wanted = ${JSON.stringify(tab)};
  const el = one([...document.querySelectorAll('.ant-tabs-tab')]
    .filter((node) => rendered(node) && clean(node.textContent) === wanted), 'sycm tab ' + wanted);
  return JSON.stringify({
    active: /ant-tabs-tab-active/.test(String(el.className || '')),
    point: aim(el, 'sycm tab ' + wanted),
  });
})()`;
}

function sycmButtonExpression(label) {
  return `(() => {
  ${SYCM_PRELUDE}
  const wanted = ${JSON.stringify(label)};
  const el = one([...document.querySelectorAll('.oui-date-picker-particle-button button')]
    .filter((node) => rendered(node) && clean(node.textContent) === wanted), 'sycm button ' + wanted);
  return JSON.stringify({ point: aim(el, 'sycm button ' + wanted) });
})()`;
}

const SYCM_PRESET_EXPRESSION = sycmButtonExpression('1天');
const SYCM_OPEN_EXPRESSION = sycmButtonExpression('自定义');


// 日历面板读取。年/月分别读 .year 与 .month；本月日格由 current-month 类直接给出。
// 顺带把翻月箭头与「确定」的点一起算好：省一次往返，也保证取点与读取是同一时刻的状态。
const SYCM_PANEL_EXPRESSION = `(() => {
  ${SYCM_PRELUDE}
  // 关闭时的菜单仍然在 DOM 里（display:none，格子 rect 全 0），
  // 用 querySelector 找它会得到「面板已打开、格子都在 (0,0)」的假状态 —— 必须按「真的渲染出来」筛。
  const menu = [...document.querySelectorAll('.oui-date-picker-menu')].filter((el) => rendered(el))[0];
  if (!menu) throw new Error('sycm date picker menu is not open');
  if (!inside(menu.getBoundingClientRect())) menu.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const navPoint = (role) => {
    const el = [...menu.querySelectorAll('.oui-dt-calendar-control[data-role="' + role + '"]')]
      .filter((node) => !/disabled/.test(String(node.className || '')))[0];
    return el ? pointOf(el) : null;
  };
  const blocks = [...menu.querySelectorAll('.oui-dt-calendar-content')].map((content, index) => {
    const pannel = content.querySelector('.oui-dt-calendar-pannel');
    const yearEl = pannel ? pannel.querySelector('.oui-dt-calendar-control.year') : null;
    const monthEl = pannel ? pannel.querySelector('.oui-dt-calendar-control.month') : null;
    // 日格类名是 oui-dt-calendar-day-0/1/...（带星期数字后缀），
    // 「td.oui-dt-calendar-day」匹配不到任何东西——必须用 [class*=] 前缀匹配。
    const cells = [...content.querySelectorAll('td[class*="oui-dt-calendar-day-"]')]
      .filter((td) => /current-month/.test(String(td.className || '')) && rendered(td))
      .map((td) => {
        const r = td.getBoundingClientRect();
        return { text: clean(td.textContent), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          inside: inside(r) };
      });
    return { index, year: digits(yearEl && yearEl.textContent), month: digits(monthEl && monthEl.textContent), cells };
  });
  // 取最内层的「已选择：…」节点：外层容器会把「最少选择/日粒度/确定」都拼进来。
  const selection = [...document.querySelectorAll('div, span')]
    .map((el) => clean(el.textContent))
    .filter((text) => /已选择/.test(text) && /\\d{4}-\\d{2}-\\d{2}/.test(text))
    .sort((left, right) => left.length - right.length)[0] || null;
  const confirm = [...menu.querySelectorAll('button')]
    .find((button) => clean(button.textContent).replace(/\\s/g, '') === '确定');
  return JSON.stringify({
    menuInside: inside(menu.getBoundingClientRect()),
    blocks,
    selection,
    confirmPoint: confirm ? pointOf(confirm) : null,
    prevMonthPoint: navPoint('prev-month'),
    nextMonthPoint: navPoint('next-month'),
  });
})()`;

const SITES = Object.freeze({
  alimama: {
    label: '阿里妈妈 / 营销场景报表',
    urlFragment: 'one.alimama.com',
    route: 'url-hash',
    defaultExpectTab: null,
  },
  sycm: {
    label: '生意参谋 / 店铺绩效',
    urlFragment: 'sycm.taobao.com/qos/service/frame/shop/performance',
    route: 'preset-or-calendar',
    defaultExpectTab: '询单到付款',
  },
});

export function siteAdapter(site) {
  const adapter = SITES[site];
  if (!adapter) throw new Error(`unknown site: ${site} (expected ${Object.keys(SITES).join(' | ')})`);
  return adapter;
}

// ---------------------------------------------------------------- 代理调用

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`proxy ${url} failed: HTTP ${response.status} ${String(payload?.error ?? text).slice(0, 200)}`);
  }
  return payload;
}

async function evaluate(proxy, targetId, expression) {
  const payload = await proxyJson(`${proxy}/eval?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: expression });
  const value = payload?.value ?? payload;
  if (typeof value !== 'string') throw new Error(`eval returned ${typeof value}, expected string`);
  return JSON.parse(value);
}

async function clickPoint(proxy, targetId, point) {
  await proxyJson(`${proxy}/clickPoint?target=${encodeURIComponent(targetId)}`, {
    method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }),
  });
  return point;
}

async function navigate(proxy, targetId, url) {
  return proxyJson(`${proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`,
    { method: 'POST', body: '' });
}

function delay(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

export async function resolveTarget({ proxy, site }) {
  const adapter = siteAdapter(site);
  const targets = await proxyJson(`${proxy}/targets`);
  const matches = targets.filter((target) => target.type === 'page' && String(target.url).includes(adapter.urlFragment));
  if (matches.length !== 1) throw new Error(`expected one ${site} page on ${proxy}, got ${matches.length}`);
  return matches[0].targetId;
}

export async function readSiteState({ proxy, site, targetId }) {
  siteAdapter(site);
  const page = targetId ?? await resolveTarget({ proxy, site });
  const state = await evaluate(proxy, page, READ_EXPRESSIONS[site]);
  return { ...state, targetId: page };
}

// ---------------------------------------------------------------- 主流程

// 失败时把 trace 一起带出来：否则只看到一行错，得重新手工复现一遍才知道卡在哪一步。
export async function applyDate(options = {}) {
  const trace = [];
  try {
    return await runApplyDate({ ...options, trace });
  } catch (error) {
    error.trace = trace;
    throw error;
  }
}

async function runApplyDate({ proxy, site, targetId, requested, mode: requestedMode = 'auto',
  expectTab, now = new Date(), settleMs = 1200, dryRun = false, trace = [] } = {}) {
  const adapter = siteAdapter(site);
  const resolved = resolveDateMode({ requested, now });
  const mode = requestedMode === 'auto' ? resolved.mode : requestedMode;
  if (!['preset', 'explicit'].includes(mode)) throw new Error(`invalid mode: ${requestedMode}`);
  const page = targetId ?? await resolveTarget({ proxy, site });
  const say = (step, extra = {}) => trace.push({ step, ...extra });
  // 「动作前读取」只是信息性的（用于报告 before 与判断 REAPPLIED）：
  // 页面还没渲染完时不该在真正动手之前就失败，所以这里容忍读不到。
  const before = await readSiteState({ proxy, site, targetId: page })
    .catch((error) => ({ applied: null, unreadable: error.message, targetId: page }));
  // 措辞要如实（2026-09-17）：这一步读不到是**设计上允许的**，不是故障。
  // 原先记成 `read-before-failed` 并在 stdout 里带出 `HTTP 400 …`，客户演示时看着像脚本报错 ——
  // 而它下面的 status 其实是 APPLIED。所以名字与字段都按「可缺省」写，原始文本收在 detail 里备查。
  if (before.unreadable) {
    say('read-before-skipped', {
      tolerated: true,
      reason: '动作前页面尚未就绪；这一步只用于报告 before 与判断 REAPPLIED，按设计可缺省（随后的回读断言才是判据）',
      detail: String(before.unreadable).split('\n')[0].slice(0, 160),
    });
  }

  const settle = async (label) => {
    let last = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await delay(settleMs);
      last = await readSiteState({ proxy, site, targetId: page });
      if (site === 'alimama') {
        try {
          const checked = assertAlimamaState({ state: last, requested, yesterday: resolved.yesterday });
          return { state: last, applied: checked.applied };
        } catch (error) { last.error = error.message; }
      } else if (resolveAppliedDate({ text: last.applied, yesterday: resolved.yesterday }) === requested) {
        return { state: last, applied: requested };
      }
    }
    throw new Error(`${label}: state did not settle to ${requested}; last=${JSON.stringify(last)}`);
  };

  const finish = (status, settled) => {
    if (expectTab && !(settled.state.activeTabs ?? []).includes(expectTab)) {
      throw new Error(`expected active tab ${expectTab}; got ${JSON.stringify(settled.state.activeTabs ?? settled.state.tabs)}`);
    }
    return { site, requested, mode, route: adapter.route, targetId: page,
      observedBefore: before.applied, observedAfter: settled.state.applied, filters: settled.state.triggers ?? null,
      tabs: settled.state.tabs ?? null, activeTabs: settled.state.activeTabs ?? null, status, trace };
  };

  if (dryRun) {
    say('dry-run', { observed: before.applied });
    return { site, requested, mode, route: adapter.route, targetId: page,
      observedBefore: before.applied, observedAfter: null, tabs: before.tabs ?? null,
      activeTabs: before.activeTabs ?? null, status: 'DRY_RUN', trace };
  }

  if (site === 'alimama') {
    const url = buildAlimamaUrl({ requested });
    say('navigate', { url });
    await navigate(proxy, page, url);
    const settled = await settle('alimama');
    say('settled', { applied: settled.applied });
    return finish(before.applied === settled.applied ? 'REAPPLIED' : 'APPLIED', settled);
  }

  // sycm 第一件事是确认页签。页签错了，日期控件就是「另一套」：
  // 汇总分析下「1天」按钮存在但不可见，只有 日/月/自定义，硬点会点到别的东西。
  if (expectTab) {
    const tab = await evaluate(proxy, page, sycmTabExpression(expectTab));
    say('tab', { expectTab, alreadyActive: tab.active, point: tab.point });
    if (!tab.active) {
      await clickPoint(proxy, page, tab.point);
      await delay(settleMs);
      const after = await readSiteState({ proxy, site, targetId: page });
      if (!(after.activeTabs ?? []).includes(expectTab)) {
        throw new Error(`sycm tab did not activate: wanted ${expectTab}; active=${JSON.stringify(after.activeTabs)}`);
      }
      say('tab-activated', { activeTabs: after.activeTabs });
    }
  }

  // sycm：预设「1天」＝昨日；否则「自定义」＋日历。
  if (mode === 'preset') {
    if (requested !== resolved.yesterday) {
      throw new Error(`preset mode only resolves the yesterday ${resolved.yesterday}; requested ${requested}`);
    }
    const preset = await evaluate(proxy, page, SYCM_PRESET_EXPRESSION);
    say('click-preset', { text: '1天', point: preset.point });
    await clickPoint(proxy, page, preset.point);
    const settled = await settle('sycm preset');
    say('settled', { applied: settled.applied });
    return finish('APPLIED', settled);
  }

  // 幂等：面板已经开着就直接用，不重复点「自定义」（重复点会把它切回去）。
  const readPanel = async () => {
    try { return await evaluate(proxy, page, SYCM_PANEL_EXPRESSION); } catch { return null; }
  };
  let panel = await readPanel();
  if (!panel) {
    const opener = await evaluate(proxy, page, SYCM_OPEN_EXPRESSION);
    say('open-explicit', { point: opener.point });
    await clickPoint(proxy, page, opener.point);
    panel = null;
  } else {
    say('panel-already-open', { selection: panel.selection });
  }

  // 目标月不在面板里就翻月（跨月回填必备：10-01 的「昨天」是 09-30）。
  const targetMonth = requested.slice(0, 7);
  for (let attempt = 0; attempt < 12 && !panel; attempt += 1) {
    await delay(settleMs);
    panel = await readPanel();
    if (!panel) continue;
    if ((panel.blocks ?? []).some((block) =>
      `${block.year}-${String(block.month).padStart(2, '0')}` === targetMonth)) break;
    const shown = (panel.blocks ?? []).map((block) => `${block.year}-${String(block.month).padStart(2, '0')}`);
    const direction = shown.length && shown[0] > targetMonth ? 'prevMonthPoint' : 'nextMonthPoint';
    const point = panel[direction];
    if (!point) throw new Error(`sycm calendar shows ${shown.join(', ')}; cannot reach ${targetMonth} (no ${direction})`);
    say('turn-month', { attempt, direction, point, shown });
    await clickPoint(proxy, page, point);
    panel = null;
  }
  if (!panel) throw new Error(`sycm calendar did not open / reach ${targetMonth} within 12 turns`);

  const { hits } = selectDayHits(panel.blocks, requested);
  say('panel', { shown: panel.blocks.map((block) => `${block.year}-${block.month}`), selection: panel.selection,
    hits: hits.map((hit) => hit.cell.text) });
  if (!panel.menuInside) throw new Error('sycm calendar panel is not fully inside the viewport');
  for (const hit of hits) {
    if (!hit.cell.inside) throw new Error(`sycm day cell ${hit.cell.text} is outside the viewport`);
  }

  // 单日区间＝左块点一次、右块点一次；点完回读，只有确实是「X 至 X」才确认。
  for (const hit of hits) {
    say('click-day', { block: hit.blockIndex, text: hit.cell.text, point: [hit.cell.x, hit.cell.y] });
    await clickPoint(proxy, page, [hit.cell.x, hit.cell.y]);
    await delay(settleMs);
    const after = await evaluate(proxy, page, SYCM_PANEL_EXPRESSION);
    if (isSingleDaySelection(after.selection, requested)) {
      panel = after;
      say('selection-settled', { selection: after.selection, clicks: hit.blockIndex + 1 });
      break;
    }
    panel = after;
  }
  if (!isSingleDaySelection(panel?.selection, requested)) {
    throw new Error(`sycm panel selection is ${JSON.stringify(panel?.selection)}; expected ${requested} 至 ${requested}`);
  }
  if (!panel.confirmPoint) throw new Error('sycm 确定 button missing');
  say('confirm', { selection: panel.selection, point: panel.confirmPoint });
  await clickPoint(proxy, page, panel.confirmPoint);

  const settled = await settle('sycm explicit');
  say('settled', { applied: settled.applied });
  return finish('APPLIED', settled);
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { mode: 'auto', proxy: process.env.CDP_PROXY || `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') args.dryRun = true;
    else if (key === '--site') args.site = argv[++index];
    else if (key === '--date') args.requested = argv[++index];
    else if (key === '--mode') args.mode = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--target') args.targetId = argv[++index];
    else if (key === '--expect-tab') args.expectTab = argv[++index];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.site) throw new Error('missing --site');
  if (!args.requested) throw new Error('missing --date');
  if (args.expectTab === undefined) args.expectTab = siteAdapter(args.site).defaultExpectTab;
  return args;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  applyDate(parseArgs(process.argv.slice(2)))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => {
      console.error(error.stack || error.message);
      if (error.trace?.length) console.error(`TRACE ${JSON.stringify(error.trace, null, 2)}`);
      process.exitCode = 1;
    });
}
