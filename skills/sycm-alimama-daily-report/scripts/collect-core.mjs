// 日报链「采集段」的纯函数：挑新下载的文件、认下载任务名、校验统计区间含目标日。
//
// 为什么要单独拎出来（2026-09-17）：采集段一直是**操作步骤**（SOP §3/§4 里写的点击路径），
// 现场靠 %Temp% 下的临时脚本点，没有仓库内的实现。对客户演示来说这是最容易出纰漏的一环：
// 临时脚本会被清理、参数写死、失败时只留一句沉默。收编时把「判断」与「点页面」分开 ——
// 判断留在本模块（可离线单测），点页面留在线脚本里（浏览器里现跑）。
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// 生意参谋店铺报表与阿里妈妈推广报表的文件名形状（实测）。
export const SHOP_REPORT_PATTERN = /^日报_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;
export const PROMOTION_ZIP_PATTERN = /^营销场景报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;
// 下载任务在「下载任务管理」里的行名（不含后缀）。
export const PROMOTION_TASK_PATTERN = /^营销场景报表_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/u;

// 浏览器的默认下载目录。写死在仓库里会把别人的机器路径带进来，所以从环境变量推。
export function defaultDownloadsDir(env = process.env) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) throw new Error('cannot derive the downloads directory: set USERPROFILE/HOME or pass --downloads');
  return path.join(home, 'Downloads');
}

export function listDownloads(dir, pattern) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot read downloads directory ${dir}: ${error.message}`);
  }
  return names
    .filter((name) => pattern.test(name))
    .map((name) => {
      // 「大小 + mtime」是本函数唯一的判据来源；读不到 stat 的条目直接不算候选（假文件不进候选集）。
      const stat = statSync(path.join(dir, name), { throwIfNoEntry: false });
      return stat ? { name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean);
}

// 「点击前记一份名单 → 点击后只认名单里没有的」——判据取文件系统，不取页面上的按钮状态。
// 页面说「生成成功」不等于文件落到了磁盘；反过来，页面卡在旧状态时文件也可能已经下来了。
//
// 两边都是**文件名数组**（不是 listDownloads 的对象）。写这条注释是因为第一版把右边按
// `entry.name` 取、左边是字符串数组，于是 `known.has(undefined)` 恒 false ——
// 过滤静默失效，「所有文件都算新的」，取件步骤会把旧 zip 当成刚下载的那一份。
export function newEntries(before, after) {
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}

// 多个新文件时取 mtime 最新的（浏览器可能一次性落两个：本体 + 临时文件）。
export function pickNewest(entries) {
  if (!entries.length) return null;
  return entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

// 从下载任务列表里认出新提交的那个：按名字里的时间戳取最大。
// 名字是可比较的（固定 6 位时间戳），所以取最大即可，不需要额外读页面的时间列。
export function newestTaskName(names, { exportDate } = {}) {
  const wanted = exportDate ? exportDate.replace(/-/gu, '') : null;
  const candidates = names
    .map((name) => name.trim())
    .filter((name) => PROMOTION_TASK_PATTERN.test(name))
    .filter((name) => !wanted || name.replace(/^营销场景报表_/u, '').startsWith(wanted));
  if (!candidates.length) return null;
  return candidates.slice().sort().at(-1);
}

// 统计区间必须**含**目标日：含不含是这一份工作簿能不能用的前提，不能靠「看起来对」。
export function dateWithinRange(range, date) {
  if (!Array.isArray(range) || range.length !== 2) throw new Error(`invalid range: ${JSON.stringify(range)}`);
  const [from, to] = range;
  for (const value of [from, to, date]) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) throw new Error(`invalid date in range check: ${value}`);
  }
  return from <= date && date <= to;
}

// ---------------------------------------------------------------------------
// 点击前的「滚动到能点到 + 复核命中」两段表达式（2026-09-17 加，两次实亏换来的）
// ---------------------------------------------------------------------------
// 只写 `block:'center'` 是不够的：`inline` 会取默认的 `'nearest'`，而阿里妈妈报表页在
// 窄窗口下「下载报表」整个落在视口**右边界之外**（实测 innerWidth=1203、元素 x∈[1305,1378]）
// ⇒ `elementFromPoint(中心)` 直接返回 null，复核报 not-hit。点击本身走 JS（`el.click()`）
// 不受遮挡影响，所以那不是「点不到」，是**判据不完整**：只看了中心点一个位置。
//
// 复核的判据因此改成：**矩形内至少存在一个「在视口内且命中自己」的采样点**。
// 只看中心点会被两类现象误判，而它们都不是「按钮不可点」：
//   ① 元素在视口外（点无效，返回 null）；
//   ② 中心被常驻浮层盖住 —— 阿里妈妈右侧有 fixed 悬浮条（实测 z-index 99999、rect [1258,286,60,322]），
//      正好盖住过按钮中心。
// 失败时把 `inViewportSamples` / `blocker` 一起带出来，好判断是「视口外」还是「被谁盖住」。
export function scrollIntoViewExpression(selector) {
  // 两个方向都要居中：垂直决定是否在视口内，水平决定「右侧被截掉」时能不能带回来。
  // 取元素时只认可见的那个 —— selector 可能是被多次运行标过的（见 hitCheckExpression 的注释）。
  return `(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = matches.find((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || matches[0];
    if (!el) return JSON.stringify({ ok: false, reason: 'element-missing', matches: matches.length });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return JSON.stringify({ ok: true, matches: matches.length });
  })()`;
}

export function hitCheckExpression(selector) {
  return `(() => {
    const isVisible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 同一个 selector 可能匹配到**多个**元素：这些脚本用 data- 属性标记目标，而阿里妈妈是 hash 路由，
    // navigate 到别的子页**不会重新加载页面**，于是上一轮标过的元素留在 DOM 里。
    // querySelector 取文档序第一个 ⇒ 会拿到旧运行残留的隐藏元素，报 not-visible，
    // 却看不出「其实只是残留」（2026-09-17 实亏一次）。所以这里必须挑可见的那个。
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = matches.find(isVisible) || matches[0];
    if (!el) return JSON.stringify({ ok: false, reason: 'element-missing', matches: matches.length });
    const self = (node) => !!node && (node === el || el.contains(node) || node.contains(el));
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return JSON.stringify({ ok: false, reason: 'not-visible', matches: matches.length,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        y: Math.round(r.y), inViewport: false,
        hiddenSiblings: matches.filter((node) => !isVisible(node)).length });
    }
    const insets = [0.5, 0.25, 0.75, 0.12, 0.88];
    let inViewportSamples = 0;
    let insideSamples = 0;
    let firstHit = null;
    for (const fy of insets) {
      for (const fx of insets) {
        const x = Math.round(r.x + r.width * fx);
        const y = Math.round(r.y + r.height * fy);
        if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) continue;
        inViewportSamples += 1;
        if (self(document.elementFromPoint(x, y))) {
          insideSamples += 1;
          if (!firstHit) firstHit = [x, y];
        }
      }
    }
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const centerInViewport = cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight;
    const centerPoint = centerInViewport ? document.elementFromPoint(cx, cy) : null;
    const centerIsSelf = self(centerPoint);
    return JSON.stringify({
      ok: insideSamples > 0,
      reason: insideSamples > 0 ? null : (inViewportSamples === 0 ? 'outside-viewport' : 'not-hit'),
      matches: matches.length,
      hiddenSiblings: matches.filter((node) => !isVisible(node)).length,
      y: Math.round(r.y),
      inViewport: cy >= 0 && cy < window.innerHeight,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      inViewportSamples, insideSamples, firstHit, centerIsSelf,
      viewport: [window.innerWidth, window.innerHeight],
      blocker: centerIsSelf ? null : (centerPoint
        ? { tag: centerPoint.tagName, cls: String(centerPoint.className).slice(0, 60) }
        : (centerInViewport ? null : 'center-outside-viewport')),
    });
  })()`;
}

// ---------------------------------------------------------------------------
// 阿里妈妈「下载任务管理」取件的三段表达式（2026-09-17 改；此前那版模型是错的）
// ---------------------------------------------------------------------------
// 这一页的真实结构，逐条实测得来，别再按直觉推：
//   · 任务列表是「任务行 tr + 紧跟一行操作行 tr」**交替**；操作行里放着「下载 / 导入超级表格 / AI分析 / 删除」。
//   · **操作行默认 `display:none`**。任何时刻页面上可见的「下载」叶子**恰好 1 个** ——
//     实测 8 个任务行对应 8 个叶子，7 个 rect 全 [0,0,0,0]。
//   · 让某一行激活（从而让它的操作行显形）的可靠动作是**真实鼠标点击该行的复选框**，
//     点完必须**回读** `checked===true` 才算数。
//   · 因此「底部操作栏」这个说法是错的（我曾据此写过一版）：那个位置上的按钮，其实就是
//     当时恰好激活的那一行的操作行按钮 —— 行内与底部是同一套东西的两个投影，不是两条路。
//   · **必须在点击前当场重新量矩形**：实测复核时报 y=350，下一秒按钮已在 y=391（差整一行 41px）；
//     拿旧坐标去点会静默落空 —— 落在相邻任务的单元格上，`clicked:true` 却什么都不发生。
//   · 零尺寸矩形一律 fail-closed：曾拿一个 rect 全零的元素的「中心」(0,0) 去点，正好点在页面
//     左上角，把阿里妈妈页从「下载任务管理」导航到了「首页」（一次探针事故，非站点问题）。
//   · **激活态会自行衰减**：实测激活后隔 15 秒再看，那个入口已经回到 rect [0,0,0,0]（操作行又隐藏了）。
//     所以定位与点击之间只允许隔一次网络往返 —— 「量完先去干点别的再回来点」在这里必然落空。
//   · 顺带钉死一条：同一次干净对照里，对**同一个正确元素**发 JS 的 `el.click()` 等了 15 秒
//     没有任何文件落盘，改真实鼠标点中心 3 秒落盘 ⇒ 取件这一下必须走真实鼠标事件，别退回 JS 点击。
export const TASK_DOWNLOAD_MARK = 'data-collect-task-download';

// 目标任务行：文件名 + 它的复选框坐标 + 当前勾选态。是「激活该行」的输入。
export function targetRowExpression(taskName) {
  return `(() => {
    const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rows = [...document.querySelectorAll('tr')];
    const names = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(taskName)} && isVisible(el));
    if (!names.length) return JSON.stringify({ found: false, reason: 'task-row-missing' });
    const tr = names[0].closest('tr');
    if (!tr) return JSON.stringify({ found: false, reason: 'no-row' });
    const box = tr.querySelector('input[type=checkbox]');
    const r = box ? box.getBoundingClientRect() : null;
    return JSON.stringify({
      found: true,
      trIndex: rows.indexOf(tr),
      hasCheckbox: !!box,
      checked: box ? box.checked : null,
      checkboxRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      checkboxCenter: r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null,
      rowText: tr.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120),
    });
  })()`;
}

// 取件入口：只认**目标任务行的下一行**（它的操作行）里那个可见的「下载」。
// 不再全页扫「第一个可见的下载」——那样会点到别的任务行的入口，而在这一页上「点错也不知道」。
export function downloadEntryExpression(taskName) {
  return `(() => {
    const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 先清掉上一轮的标记：阿里妈妈是 hash 路由，navigate 到别的子页**不重载页面**，旧标记会留在 DOM 里。
    document.querySelectorAll('[${TASK_DOWNLOAD_MARK}]').forEach((el) => el.removeAttribute('${TASK_DOWNLOAD_MARK}'));
    const rows = [...document.querySelectorAll('tr')];
    const names = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(taskName)} && isVisible(el));
    if (!names.length) return JSON.stringify({ ok: false, reason: 'task-row-missing' });
    const tr = names[0].closest('tr');
    const actionTr = tr.nextElementSibling;
    if (!actionTr) return JSON.stringify({ ok: false, reason: 'no-action-row' });
    const leaves = [...actionTr.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载');
    const entry = leaves.find(isVisible);
    if (!entry) {
      return JSON.stringify({ ok: false, reason: 'action-row-hidden',
        actionTrIndex: rows.indexOf(actionTr),
        actionRowDisplay: getComputedStyle(actionTr).display,
        leavesInActionRow: leaves.length,
        actionRowText: (actionTr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        taskRowText: tr.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) });
    }
    const target = entry.closest('button') || entry;
    target.setAttribute('${TASK_DOWNLOAD_MARK}', '1');
    const r = target.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return JSON.stringify({ ok: false, reason: 'zero-size',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    }
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const visibleDownloads = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载' && isVisible(el));
    return JSON.stringify({
      ok: true,
      actionTrIndex: rows.indexOf(actionTr),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      center: [cx, cy],
      inViewport: cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight,
      viewport: [window.innerWidth, window.innerHeight],
      leavesInActionRow: leaves.length,
      visibleDownloads: visibleDownloads.length,
    });
  })()`;
}

// 勾选集（下标）—— 用来在动手前记一份、在排练结束时恢复。
export function checkboxStateExpression() {
  return `JSON.stringify({
    checked: [...document.querySelectorAll('input[type=checkbox]')]
      .map((box, index) => (box.checked ? index : -1)).filter((index) => index >= 0),
    total: document.querySelectorAll('input[type=checkbox]').length,
  })`;
}

// 把勾选集恢复成给定的样子。`--locate-only` 用：排练要走到「选中目标任务行」这一步
// （不然操作行不显形，排练就成了「排练通过、真跑失败」），但排练结束必须把状态还回去。
export function restoreCheckboxesExpression(checkedIndexes) {
  return `(() => {
    const want = new Set(${JSON.stringify(checkedIndexes)});
    let changed = 0;
    [...document.querySelectorAll('input[type=checkbox]')].forEach((box, index) => {
      if (box.checked !== want.has(index)) { box.click(); changed += 1; }
    });
    return JSON.stringify({ changed,
      checked: [...document.querySelectorAll('input[type=checkbox]')]
        .map((box, index) => (box.checked ? index : -1)).filter((index) => index >= 0) });
  })()`;
}

// 入口定位失败的措辞。要说清「是文件名那行没找到、还是它的操作行没显形、还是显形了但零尺寸」，
// 否则只能重新手工复现一次才知道卡在哪一步。
export function describeEntryMiss(entry) {
  const parts = [String(entry.reason)];
  if (entry.actionTrIndex !== undefined) parts.push(`操作行=第 ${entry.actionTrIndex} 行`);
  if (entry.actionRowDisplay) parts.push(`操作行 display=${entry.actionRowDisplay}`);
  if (entry.leavesInActionRow !== undefined) parts.push(`操作行内「下载」叶子=${entry.leavesInActionRow}`);
  if (entry.actionRowText) parts.push(`操作行文本=${JSON.stringify(entry.actionRowText)}`);
  if (entry.rect) parts.push(`rect=${JSON.stringify(entry.rect)}`);
  return parts.join('，');
}

// 复核结果的措辞（也集中在这里，免得两个采集脚本各写一份、越写越不一样）。
// 失败要能自答「是视口外，还是被谁盖住」，否则只能重新手工复现一次才知道卡在哪。
export function describeHitMiss(hit) {
  const parts = [String(hit.reason), `y=${hit.y}`, `视口内=${hit.inViewport}`];
  parts.push(`视口内采样=${hit.inViewportSamples}/25`, `命中自己=${hit.insideSamples}`);
  if (hit.rect) parts.push(`rect=${JSON.stringify(hit.rect)}`);
  if (hit.viewport) parts.push(`视口=${JSON.stringify(hit.viewport)}`);
  if (hit.blocker) parts.push(`遮挡物=${JSON.stringify(hit.blocker)}`);
  return parts.join('，');
}

// 通过时也说清「凭什么算通过」：中心点，还是退让到别的采样点。
export function describeHitPass(hit) {
  return hit.centerIsSelf
    ? `y=${hit.y}（中心点命中）`
    : `y=${hit.y}（中心点被 ${JSON.stringify(hit.blocker)} 盖住，改用采样点 ${JSON.stringify(hit.firstHit)}）`;
}

// 采集段的参数解析。两个脚本共用，差别只在有没有 `--phase`。
export function parseCollectArgs(argv, options = {}) {
  const args = { date: null, downloads: null, proxy: null, task: null, phase: null,
    timeoutMs: options.timeoutMs ?? 30000, reportId: options.reportId ?? null };
  const allowed = new Set(options.flags ?? []);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${key} requires a value`);
      return value;
    };
    if (key === '--date') args.date = next();
    else if (key === '--downloads') args.downloads = next();
    else if (key === '--proxy') args.proxy = next();
    else if (key === '--task') args.task = next();
    else if (key === '--phase') args.phase = next();
    else if (key === '--timeout-ms') args.timeoutMs = Number(next());
    else if (key === '--report-id') args.reportId = next();
    // 布尔开关：`--locate-only` → args.locateOnly。带横线的名字一律转小驼峰，
    // 免得调用方去猜 `args['locate-only']` 还是 `args.locate_only`。
    else if (allowed.has(key)) {
      const name = key.replace(/^--/u, '').replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      args[name] = true;
    } else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.date ?? '')) throw new Error('missing or invalid --date (expected YYYY-MM-DD)');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  if (options.phases) {
    if (!options.phases.includes(args.phase)) {
      throw new Error(`--phase must be one of ${options.phases.join('|')} (got ${JSON.stringify(args.phase)})`);
    }
  } else if (args.phase !== null) {
    throw new Error('this script does not take --phase');
  }
  return args;
}
