// 「导航之后读页面」这一族的总守卫（2026-10-23 立）。
//
// 背景：本项目已经踩过**五次**同一个坑 —— **同 URL 的 navigate 是同文档导航，浏览器什么都不做**，
// 于是「导航 → 读」读到的是上一次渲染的那一版。每一次的表现都不一样，所以每次都是重新查一遍：
//   ① 2026-09-21 date-picker：设完日期再读，读到的还是旧日期；
//   ② 2026-10-12 提交确认循环；
//   ③ 2026-10-22 共享取件 openTaskList（判无候选 → 换通道补提交 → 「核不清」→ 整店失败）；
//   ④ 2026-10-23 科塔淘宝：重载本身有效，但**表格是重载之后异步拉的**，紧接着读会读到 0 行；
//      偶尔重载还会丢掉 hash 路由落回首页（`ffa39c60` 补的那一层）。
//   ⑤ 2026-10-23 本次盘点发现：`collect-product-core.mjs` 的 `collectProductReport()` 每次
//      attempt 都导航到同一个 `ITEM_RANK_URL`，第 2 次 attempt 时 URL 已经相同 ⇒ 空操作 ⇒
//      「重试换一张干净的页」这个设计目的**在第二次之后不成立**（见 REGISTRY 里的 KNOWN-RISK）。
//
// 这个守卫**不试图判断「到底该不该重载」** —— 那需要运行时的当前 URL，静态判不了。
// 它管的是两件能机器核对的事：
//   1. **表态完整性**：凡「函数体内既导航又读页面」的函数，必须在 REGISTRY 里有名字。
//      新增一个同类函数而忘了想这件事 ⇒ 直接红，报错里教怎么登记。
//   2. **声明与代码一致**：声明 `reload: true` 的，源码里必须真有重载调用；声明
//      `poll: 'xxx'` 的，必须真调那个轮询；`wrapper` / `why` 必须写清依据。
//
// 故意不做的事：不因为「这个函数没重载」就判红。有些地方只读 `location.href`、只读
// `/targets` 列表、或者自带一致性检测，重载反而是多余副作用。把它们压成一张表、
// 每条写清依据，比一个会假红的粗暴扫描有用 —— 也更容易在评审时被推翻。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 登记表：每条都写「为什么不重载」或「靠什么替代」。新增一条前先想清楚依据。
// ---------------------------------------------------------------------------
const REGISTRY = [
  // ① 已修真重载
  { file: 'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs', fn: 'openTaskList', reload: true },

  // ② 用有界轮询替代重载（等的是「目标东西出现」，比重载更贴切）
  { file: 'skills/sycm-promotion-data/scripts/collect-product-report.mjs', fn: 'submit', poll: 'pollNewProductTask' },
  { file: 'skills/sycm-promotion-data/scripts/collect-product-report.mjs', fn: 'produceTask', poll: 'pollReportReady' },

  // ③ 只读 href / target 列表 / HTTP 状态，不读页面内容 ⇒ 重载没有意义
  { file: 'runtime/feishu-ui-add-fields.mjs', fn: 'ensureTable', why: '条件导航（已在目标表就不导）+ 只读 location.href，不读表格内容' },
  { file: 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs', fn: 'siteLoggedIn', why: '只读 location.href 判登录态；同 URL 空操作时 href 本来就是目标值' },
  { file: 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs', fn: 'ensureLoginPage', why: '已在目标地址时提前返回不做多余导航；只返回 targetId，不读页面内容' },
  { file: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs', fn: 'resetSycmPage', why: '读的是 /targets 列表不是页面内容，判据是 URL 片段；且只在「恰好一个漂移页」时导航' },
  { file: 'runtime/shop-pages.mjs', fn: 'sendRequests', why: '批量发代理请求，只记 HTTP status，不读页面内容' },
  { file: 'runtime/shop-window-label.mjs', fn: 'ensureLabelTabOn', why: '读的是 /targets 列表不是页面内容；自带 3 次 × 600ms 回读预算（关页签后消失要 270ms）' },
  { file: 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs', fn: 'parkTabOn', why: '已显式跳过同 URL（url === currentHref 直接返回），且只读 location.href' },

  // ④ 自带别的一致性检测
  { file: 'skills/xws-export-market-analysis/scripts/export-market-analysis.mjs', fn: 'searchKeyword', why: '自带 hydration 一致性检测：反复读输入框值并与关键词比对，不匹配就重设（currentValueMatches）' },

  // ⑤ 已知风险，未修 —— 写在这里是为了不让它消失，不是为了把它标成没问题
  {
    file: 'skills/sycm-product-data/scripts/collect-product-core.mjs',
    fn: 'collectProductReport',
    knownRisk: '每次 attempt 都导航到同一个 ITEM_RANK_URL；第 2 次起 URL 已相同 ⇒ navigate 空操作，'
      + '「换一张干净的页」这个重试目的不成立。目前靠 clickDayExpr 的轮询兜底（不是一次性判死），'
      + '但没有真重载。2026-10-23 盘点发现，未修（改商品链行为要先拿到真机证据）。',
  },

  // ⑥ 纯导航封装：body 里的 request/evalOn 是它自己的实现，不读业务页面
  { file: 'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs', fn: 'navigateTo', wrapper: true },
  { file: 'skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-alimama-daily-report/scripts/date-picker.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-export-search-rank/scripts/export-search-rank.mjs', fn: 'navigate', wrapper: true },
  { file: 'skills/sycm-promotion-data/scripts/collect-product-report.mjs', fn: 'navigateDownloadList', wrapper: true },
];

// 顶层（不在任何函数里）的导航点：这类没法按函数名登记，只能按文件表态。
const TOP_LEVEL_REGISTRY = {
  'skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs':
    '导出链接用 pollInquiryLink 有界轮询（20s/1s），入口判定用 isInquiryPage 结构特征；'
    + '两处都由 inquiry-link-wiring.test.mjs 与 inquiry-core.test.mjs 钉住',
};

// ---------------------------------------------------------------------------
// 扫描基础设施
// ---------------------------------------------------------------------------

/** 跳过 node_modules / evidence / tmp / 点目录 / *-runs 之类非交付代码。 */
function isDeliverable(rel) {
  if (rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === 'evidence' || seg === 'tmp')) return false;
  if (rel.includes('-runs/')) return false;
  if (!rel.endsWith('.mjs')) return false;
  if (rel.endsWith('.test.mjs')) return false;
  return true;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'evidence' || entry.name === 'tmp') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(abs, acc); continue; }
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (isDeliverable(rel)) acc.push(rel);
  }
  return acc;
}

/**
 * 切出一个函数的 body（含花括号）。
 *
 * 两个坑都踩过，所以写在这里当文档：
 *   1. 必须**先跨过参数列表**：参数里常有 `{ settleMs = 7000 } = {}` 这种解构默认值，
 *      直接从第一个 `{` 起算会把参数当函数体（`openTaskList` 因此从清单里整个消失过一次）。
 *   2. 必须认字符串与注释：本仓代码里模板串含 `}` 很常见，不做状态机就会提前收尾。
 */
export function functionBodyAt(src, startIdx) {
  const parenOpen = src.indexOf('(', startIdx);
  if (parenOpen < 0) return null;
  let pd = 0;
  let j = parenOpen;
  let inS = null;
  for (; j < src.length; j += 1) {
    const c = src[j];
    if (inS) { if (c === '\\') { j += 1; continue; } if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '(') pd += 1;
    else if (c === ')') { pd -= 1; if (pd === 0) break; }
  }
  const open = src.indexOf('{', j);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  let inTemplate = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    const nx = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && nx === '/') { inBlock = false; i += 1; } continue; }
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    if (inTemplate) {
      if (c === '\\') { i += 1; continue; }
      if (c === '`') { inTemplate = false; continue; }
      continue;
    }
    if (c === '/' && nx === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && nx === '*') { inBlock = true; i += 1; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return { body: src.slice(open, i + 1), start: open, end: i + 1 }; }
  }
  return null;
}

const NAV = /navigateTo\(|\/navigate\?target/u;
const READ = /evalOn\(|evalPage\(|evalValue\(|proxyJson\(|proxyText\(|request\(|fetchImpl\(|fetch\(|readTaskRows\(|readProductTasks\(|readProductTaskRows\(/u;

/** 扫一个文件：返回既导航又读页面的函数，以及顶层导航点。 */
export function scanSource(src) {
  const fns = [];
  const spans = [];
  const fnRe = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gu;
  let m;
  while ((m = fnRe.exec(src)) !== null) {
    const name = m[1];
    const cut = functionBodyAt(src, m.index);
    if (!cut) continue;
    spans.push([m.index, cut.end]);
    const line = src.slice(0, m.index).split('\n').length;
    const hasNav = NAV.test(cut.body);
    if (!hasNav) continue;
    fns.push({
      name,
      line,
      reads: READ.test(cut.body),
      reloads: /reloadAndSettle\(|reloadListPage\(|createPageReloader\(/u.test(cut.body),
      body: cut.body,
    });
  }
  // 顶层代码 = 把函数体挖掉之后剩下的部分
  let rest = '';
  let cursor = 0;
  for (const [s, e] of spans.sort((a, b) => a[0] - b[0])) { rest += src.slice(cursor, s); cursor = e; }
  rest += src.slice(cursor);
  return { fns, topLevelNavigates: NAV.test(rest), topLevelReads: READ.test(rest) };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('切体：参数里有解构默认值时也要切对（openTaskList 当初就是这么消失的）', () => {
  const src = readFileSync(path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs'), 'utf8');
  const at = src.indexOf('async function openTaskList');
  assert.ok(at > 0, '占位：openTaskList 不在了？先确认函数名');
  const cut = functionBodyAt(src, at);
  assert.ok(cut, '切不出 body');
  // 参数里的 settleMs 不该出现在 body 里（它是参数，不是函数体内容）
  assert.doesNotMatch(cut.body.slice(0, 40), /settleMs = 7000/u,
    '切到了参数区而不是函数体 —— 参数解构那个坑又回来了');
  // 用业务无关的东西证明「切到的是函数体」：readTaskRows 是函数体自己的调用。
  // 这里**故意不用 reloadAndSettle** —— 那条是业务声明，删掉它应该只让第 5 条红，
  // 不该顺带把「切体对不对」也拖下水（2026-10-23 突变 M2 实测暴露了这个耦合）。
  assert.match(cut.body, /readTaskRows\(/u, '切出来的 body 里应该能找到函数体自己的调用');
});

test('切体：字符串里的花括号不许提前收尾', () => {
  const src = 'function a() { const s = "}"; const t = `x${1}y`; return 1; }\nfunction b() { return 2; }';
  const cut = functionBodyAt(src, 0);
  assert.match(cut.body, /return 1/u, '代码块被字符串里的 } 提前截断了');
  assert.doesNotMatch(cut.body, /function b/u, 'body 越界到下一个函数');
});

test('扫描：openTaskList 必须被认成「既导航又读页面」', () => {
  const src = readFileSync(path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs'), 'utf8');
  const { fns } = scanSource(src);
  const hit = fns.find((f) => f.name === 'openTaskList');
  assert.ok(hit, 'openTaskList 没进扫描结果 —— 切体或正则又坏了');
  assert.equal(hit.reads, true);
  assert.equal(hit.reloads, true);
});

test('表态完整性：每个「导航 + 读页面」的函数都必须在登记表里', () => {
  const declared = new Set(REGISTRY.map((r) => `${r.file}::${r.fn}`));
  const unregistered = [];
  for (const rel of walk(ROOT)) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (!NAV.test(src)) continue;
    const { fns } = scanSource(src);
    for (const f of fns) {
      if (!f.reads) continue; // 不读页面就不是这一族
      if (!declared.has(`${rel}::${f.name}`)) {
        unregistered.push(`${rel}:${f.line} ${f.name}()`);
      }
    }
  }
  assert.deepEqual(unregistered, [],
    '以下函数既导航又读页面，但没在本文件的 REGISTRY 里表态。\n'
    + '请逐个判断：能不能同 URL（能 ⇒ 大概率需要真重载或轮询），然后把结论写进 REGISTRY：\n'
    + '  reload: true —— 已修真重载（守卫会核对源码里真有 reloadAndSettle）\n'
    + '  poll: \'xxx\' —— 用有界轮询替代（守卫会核对源码里真调了那个函数）\n'
    + '  why: \'...\'  —— 不读页面内容 / 只读 href / 自带一致性检测，写清依据\n'
    + '  wrapper: true —— 纯导航封装，由调用方决定\n'
    + '未登记的：\n'
    + unregistered.map((s) => `  · ${s}`).join('\n'));
});

test('声明与代码一致：reload / poll / wrapper / knownRisk 四类各自可核对', () => {
  const problems = [];
  for (const r of REGISTRY) {
    const src = readFileSync(path.join(ROOT, r.file), 'utf8');
    const at = src.indexOf(`function ${r.fn}(`);
    if (at < 0) { problems.push(`${r.file}::${r.fn} —— 函数不在了，登记表过期`); continue; }
    const cut = functionBodyAt(src, at);
    if (!cut) { problems.push(`${r.file}::${r.fn} —— 切不出 body`); continue; }

    if (r.reload) {
      assert.match(cut.body, /reloadAndSettle\(|reloadListPage\(/u,
        `${r.file}::${r.fn} 登记为 reload:true，但源码里没有重载调用 —— 不是登记表过期，就是修复被回退了`);
    }
    if (r.poll) {
      assert.match(cut.body, new RegExp(`${r.poll}\\(`, 'u'),
        `${r.file}::${r.fn} 登记为 poll:${r.poll}，但源码里没调它`);
    }
    if (r.why !== undefined) assert.ok(String(r.why).trim().length >= 8, `${r.file}::${r.fn} 的 why 太短，等于没写依据`);
    if (r.knownRisk !== undefined) assert.ok(String(r.knownRisk).includes('2026-10-23'), `${r.file}::${r.fn} 的 knownRisk 必须带盘点日期`);
  }
  assert.deepEqual(problems, []);
});

test('已知风险必须在表里现形，不许被顺手删掉', () => {
  // 这条守的是「诚实」：collectProductReport 的重试目前拿不到干净页。
  // 修了就把 knownRisk 改成 reload:true；想直接删这条登记 ⇒ 上面那条表态完整性会红。
  const risky = REGISTRY.filter((r) => r.knownRisk);
  assert.ok(risky.length >= 1, 'knownRisk 一条都没有了？如果已修，请同时改登记项类型（不要只是删掉）');
  const target = risky.find((r) => r.fn === 'collectProductReport');
  assert.ok(target, 'collectProductReport 的 knownRisk 登记不见了');
});

test('顶层导航点也要表态（inquiry 那处不在任何函数里）', () => {
  const found = [];
  for (const rel of walk(ROOT)) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (!NAV.test(src)) continue;
    const { fns, topLevelNavigates, topLevelReads } = scanSource(src);
    void fns;
    if (topLevelNavigates && topLevelReads) found.push(rel);
  }
  const unregistered = found.filter((rel) => !(rel in TOP_LEVEL_REGISTRY));
  assert.deepEqual(unregistered, [],
    `以下文件的**顶层代码**既导航又读页面，但没在 TOP_LEVEL_REGISTRY 里表态：\n${unregistered.map((s) => `  · ${s}`).join('\n')}`);
});

test('反向自证：把 openTaskList 的重载删掉，reload 判据必须转红', () => {
  const src = readFileSync(path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs'), 'utf8');
  const at = src.indexOf('async function openTaskList');
  const cut = functionBodyAt(src, at);
  const broken = cut.body.replace(/await reloadAndSettle\(args, targetId\);/u, '');
  assert.notEqual(broken, cut.body, '反向自证没生效：没匹配到那行重载（源码形状变了？）');
  assert.doesNotMatch(broken, /reloadAndSettle\(/u,
    '去掉重载后判据仍为真 ⇒ 这条守卫没在判东西');
});
