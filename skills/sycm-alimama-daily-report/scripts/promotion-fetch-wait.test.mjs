import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { waitForDownloadEntry, classifyListRead } from './collect-promotion-report.mjs';

test('promotion-fetch：操作行延迟显形时等待后继续', async () => {
  const reads = [
    { ok: false, reason: 'action-row-hidden' },
    { ok: false, reason: 'action-row-hidden' },
    { ok: true, rect: [10, 20, 40, 20] },
  ];
  let now = 0;
  let sleeps = 0;
  const located = await waitForDownloadEntry({ downloadEntryWaitMs: 5000 }, 'target', '任务A', {
    read: async () => reads.shift(),
    sleep: async (ms) => { sleeps += 1; now += ms; },
    now: () => now,
  });
  assert.equal(located.ok, true);
  assert.equal(located.attempts, 3);
  assert.equal(sleeps, 2);
});

test('promotion-fetch：操作行持续隐藏超过预算时 fail-closed', async () => {
  let now = 0;
  await assert.rejects(
    waitForDownloadEntry({ downloadEntryWaitMs: 800 }, 'target', '任务B', {
      read: async () => ({ ok: false, reason: 'action-row-hidden' }),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }),
    /仍找不到 任务B 的下载入口/u,
  );
});

/**
 * 2026-10-05 真机连踩三轮后补：**整页重载之后必须重新定位目标元素**。
 *
 * 缺陷形态：`hitCheckDismissingOverlay` 的「关不掉遮挡 ⇒ 重载一次」那条分支
 * **只重载、不重定位** ⇒ 上一轮 `data-collect-alimama-download="1"` 那个标记
 * 被整页重载冲掉 ⇒ 紧接着的复核必然 `element-missing`。
 * 报出来是「复核未通过（element-missing，y=undefined…）」——
 * **看着像「按钮没了 / 页面没渲染」，实际是编排漏了一步**。
 *
 * 现场（科塔淘宝 promotion-submit，目标日 10-04，10-05 连续三轮）：
 *   [submit] 候选 1 个，取文档序第一个（SPAN，其可点祖先是 BUTTON…）  ← 定位成功
 *   [遮挡] 已重载页面（营销场景报表_万相台无界版）—— 在新现场上再走一遍
 *   采集失败：「下载报表」复核未通过（element-missing…）              ← 标记已被冲掉
 *
 * 修法：重载那条分支也调 `reLocate`；且**没传 reLocate 时直接抛错**，
 * 不静默退回 element-missing（那正是本缺陷的形态）。
 *
 * 这条守卫读源码断言「重载分支里必须有 reLocate 调用」——它守的是**编排顺序**，
 * 那种形状错误（含 else 分支、走空、参数没传）靠跑真实页面成本太高。
 */
test('整页重载后必须重新定位目标（重载会冲掉 data- 标记）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const fnStart = src.indexOf('async function hitCheckDismissingOverlay');
  assert.ok(fnStart > 0, '找不到 hitCheckDismissingOverlay —— 名字变了的话这条用例要跟着更新');
  // 结束标志用「最后一个独立的 `}` 独占一行」——不能用第一个，
  // 函数体里有嵌套 if 块（第一版用第一个 `\n}\n` 就提前截断了，害得这条用例一度漏判）。
  const rest = src.slice(fnStart);
  const marks = [...rest.matchAll(/\n\}/gu)].map((x) => x.index);
  const body = rest.slice(0, marks[marks.length - 1] + 2);
  assert.ok(body.includes('reloadAndSettle('), '函数体截取失败：没拿到重载那一步（截取边界不对）');

  // ① 重载那一步必须在场
  assert.match(body, /reloadAndSettle\(/u, '这条分支的语义就是「关不掉就重载一次」，重载调用不能没了');

  // ② ★核心：重载之后要有「重新定位」，且必须在**复核之前**。
  const reloadAt = body.indexOf('reloadAndSettle(');
  const reLocateAt = body.indexOf('reLocate({');
  const hitAfter = body.indexOf('hitCheck(', reloadAt);
  assert.ok(reLocateAt > reloadAt,
    '重载之后必须调 reLocate —— 整页重载会冲掉 data- 标记（2026-10-05 真机连踩三轮：'
    + '科塔淘宝 promotion-submit 报 element-missing，根因就是这里漏了一步）');
  assert.ok(hitAfter > 0 && reLocateAt < hitAfter,
    '重新定位必须**在复核之前**；顺序反了等于没重定位');

  // ③ 没传 reLocate 时必须**直接抛错**，不许静默退回 element-missing
  assert.match(body, /if \(!reLocate\)\s*\{[\s\S]{0,400}?throw/u,
    '调用方没给 reLocate 时要抛错点名，不能静默跳过 —— 静默跳过就退回本缺陷的形态了');
  // 反向自证：把「没传 reLocate 就抛错」那段去掉，**必须**判红 ——
  // 否则上面那条 assert 只是「源码里恰好有 if (!reLocate)」，判据可能整体失效。
  // 这里用同一个判据函数跑一遍被改坏的副本。
  // 判据只看「重载之后、下一次 hitCheck 之前」这个区间 ——
  // 函数里后面还有一处 reLocate（关完遮挡再重定位），光看「有没有 reLocate」会误判。
  const judge = (text) => {
    const r = text.slice(text.indexOf('async function hitCheckDismissingOverlay'));
    const mk = [...r.matchAll(/\n\}/gu)].map((x) => x.index);
    const b = r.slice(0, mk[mk.length - 1] + 2);
    const relAt = b.indexOf('reloadAndSettle(');
    const reAt = b.indexOf('reLocate({', relAt);
    const nextHit = b.indexOf('hitCheck(', relAt);
    return reAt > relAt && reAt < nextHit;
  };
  assert.equal(judge(body), true, '当前源码应当判为「重载后、下次复核前有重定位」');
  // 把**重载那处**的 reLocate 调用整行删掉（保留关遮挡那处），判据必须转红。
  const broken = body.replace(/^\s*await reLocate\(\{ reason: 'reloaded' \}\);\s*$/mu, '');
  assert.notEqual(broken, body, '反向自证没生效：没匹配到那行 reLocate 调用（源码形状变了？）');
  assert.equal(judge(broken), false,
    '守卫自证失败：把重载后的 reLocate 调用去掉后判据仍为真 ⇒ 判据没在判东西');

  // ④ submit 段那个调用点必须传第四个参数（reLocate）—— 原来**没传**，
  //    而这个函数只有重载分支与关遮挡分支会用到它。
  const callAt = src.indexOf("hitCheckDismissingOverlay(args, targetId, '[data-collect-alimama-download=\"1\"]'");
  assert.ok(callAt > 0, 'submit 段那个调用点找不到了 —— 选择器变了的话这条用例要跟着更新');
  // 结束位置不能找第一个 `);` —— 回调内部就有 `);`（delay(1500)），会提前截断。
  const call = src.slice(callAt, src.indexOf('\n  });', callAt) + 5);
  assert.match(call, /,\s*async\s*\(/u,
    'submit 段的调用必须传第四个参数 reLocate —— 不传就等于「重载后不重定位」');
  assert.match(call, /locateDownloadReportReady\(/u,
    'reLocate 回调必须真的重新定位（要调 locateDownloadReportReady）');
});

/**
 * 2026-10-22 真机误杀后补：**取件段读下载任务列表之前必须真重载**。
 *
 * 缺陷形态：`openTaskList` 只做 `navigateTo(LIST_URL)` + sleep + 读。
 * 目标 URL 与当前 URL 相同时，navigate 是「同文档导航」，浏览器什么都不做 ⇒
 * 读到的是这一屏**上一次渲染的那一版**，提交后刚生成成功的任务一条都读不到。
 *
 * 现场（2026-10-22 11:00 轮，网林淘宝，目标日 10-21）：
 *   提交段（走 openFreshTaskList = navigate + 真重载）已确认
 *   关键词报表_20261022_113048 / 人群报表_20261022_113102「生成成功」并写进台账；
 *   取件段从 openTaskList 进来，读到旧列表 ⇒ 判「没有日期范围等于 2026-10-21 的任务」
 *   ⇒ 换通道补提交 ⇒ 基线还是旧列表 ⇒ 「补提交结果核不清（看了 10 次）」⇒ 整店 STAGE_FAILED。
 *   **任务在平台上早就生成成功，飞书一个字没写。**
 *
 * 同一个坑的另外两次：09-21 date-picker、10-12 提交确认循环（驱动那边已修真重载）。
 * 这条守卫读源码断言「openTaskList 的读之前有 reloadAndSettle」——守的是**编排顺序**，
 * 靠跑真实页面验证成本太高（要真起浏览器、真提交、真等平台）。
 */
test('取件段读任务列表前必须真重载（同 URL navigate 是空操作）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8').replace(/\r\n/g, '\n');

  // 函数体边界按「独占一行的 `}`」取，不再用固定 900 字窗口 ——
  // 2026-10-23 给这个函数加了「读不到再等一屏」的循环后，窗口法会把 readTaskRows 切到窗口外。
  const bodyOf = (text) => {
    const start = text.indexOf('async function openTaskList');
    if (start < 0) return null;
    const rest = text.slice(start);
    const endMark = rest.indexOf('\n}\n');
    return endMark > 0 ? rest.slice(0, endMark) : rest;
  };

  const judge = (text) => {
    const body = bodyOf(text);
    if (body === null) return null;
    const navAt = body.indexOf('navigateTo(');
    const reloadAt = body.indexOf('reloadAndSettle(');
    const readAt = body.indexOf('readTaskRows(');
    if (navAt < 0 || readAt < 0) return null;
    // 判据：导航之后、读之前，必须有一次真重载。
    return reloadAt > navAt && reloadAt < readAt;
  };

  assert.equal(judge(src), true,
    'openTaskList 必须在 navigateTo 之后、readTaskRows 之前调用 reloadAndSettle —— '
    + '否则同 URL navigate 是空操作，读到的是旧列表（2026-10-22 网林淘宝就是这么被误杀的）');

  // 反向自证：把这次加的那行重载删掉，判据必须转红。
  const broken = src.replace(/^  \/\/ 真重载：重载会打断 eval 上下文[\s\S]{0,200}?await reloadAndSettle\(args, targetId\);\n/mu, '');
  assert.notEqual(broken, src, '反向自证没生效：没匹配到 openTaskList 里那行 reloadAndSettle（源码形状变了？）');
  assert.equal(judge(broken), false,
    '守卫自证失败：去掉真重载后判据仍为真 ⇒ 判据没在判东西');
});

/**
 * 2026-10-23 真机两次误杀后补：**读一次 0 行不等于「列表是空的」**。
 *
 * 缺陷形态：`openTaskList` 重载后**只读一次**就返回。而重载只等到 readyState=complete，
 * 任务表格是重载之后异步拉的 ⇒ 读到 0 行，调用方把它读成「判据失效（页面结构可能变了）」
 * ⇒ 整店 STAGE_FAILED；同一刻页面上 营销场景报表_20261023_082019 / 2026-10-22至2026-10-22 /
 * 生成成功 都在（证据：evidence/batches-2026-10-22/b1/科塔淘宝/06/07-promotion-fetch.txt）。
 * 另一半：重载偶尔把 hash 路由丢掉、落回首页（07 的标题从「下载任务管理_万相台无界版」
 * 变成「万相台无界版」），那一屏再怎么读都是 0 行 ⇒ 要能补一次导航。
 *
 * 守的是**形状**：读之后必须还有「等一屏再读」，且路由丢了要重新导航。
 */
test('取件段读任务列表：读到 0 行要再等一屏重读，路由丢了要补导航', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function openTaskList');
  assert.ok(start > 0, '找不到 openTaskList —— 名字变了的话这条用例要跟着更新');
  const rest = src.slice(start);
  const endMark = rest.indexOf('\n}\n');
  const body = endMark > 0 ? rest.slice(0, endMark) : rest;

  const reads = [...body.matchAll(/readTaskRows\(/gu)].length;
  assert.ok(reads >= 2, 'openTaskList 里必须至少读两次（首读 + 等一屏后重读）—— 只读一次就是本次缺陷的形态');
  assert.match(body, /rows\.length === 0/u, '循环条件必须盯住「读到 0 行」这个情形');
  assert.match(body, /!href\.includes\('download-list'\)/u, '路由丢了（落回首页）时必须能认出来');
  assert.match(body, /navigateTo\(/gu, '要么首读前导航、要么补导航 —— 总得有一次导航');
  assert.ok(body.lastIndexOf('navigateTo(') > body.indexOf('reloadAndSettle('),
    '重新导航必须在重载之后（补导航是「重载把路由丢了」的修法）');
});

/**
 * 2026-10-24 真机误杀后补（㊼）：**「读到 0 行」不等于「列表里没有这个任务」**。
 *
 * 现场（2026-10-24 11:00 轮，目标日 2026-10-23，盖文天猫）：
 *   台账里 关键词报表_20261024_111611（03:16:30）、人群报表_20261024_111638（03:16:49）
 *   两笔都是提交段确认「多出一条」之后才记的；平台上「下载任务管理」里这两行
 *   「生成成功 / 2026-10-23至2026-10-23」肉眼可见（当时另起浏览器实测读到 5 条关键词报表）。
 *   而取件段连读 3 次，每次都报「列表里没有任何任务名形状的条目」⇒ 整店 STAGE_FAILED、
 *   飞书零写入、证据目录没建。
 *
 * 病根与 ㊹（询单页判据）、㊹b（词表两份）同一个：**把「读不到」当成「不存在」**。
 * 这一条钉两件事：
 *   ① 三种页面状态必须给出三种结论（没渲染 / 就绪但这类型 0 条 / 就绪有行）；
 *   ② 预算耗尽且表格始终没渲染时，抛出的必须是「没读到」，不许再落到
 *      「--task 指定的 X 不在列表里」这种把锅推给任务的措辞上。
 */
test('取件段：三种页面状态必须给三种结论（没渲染 ≠ 这一类 0 条）', () => {
  const notReady = classifyListRead({
    probe: { href: 'https://one.alimama.com/index.html', title: '万相台无界版', trs: 0, hasTableHeader: false, hasRefresh: false, kinds: {} },
    rows: [],
  });
  assert.equal(notReady.state, 'not-ready');
  assert.equal(notReady.ok, false);
  assert.match(notReady.reason, /还没渲染/u);

  const emptyOfKind = classifyListRead({
    probe: { href: 'https://one.alimama.com/index.html#!/report/download-list', title: '下载任务管理_万相台无界版', trs: 41,
      hasTableHeader: true, hasRefresh: true, kinds: { 人群报表: 5, 营销场景报表: 7 } },
    rows: [],
  });
  assert.equal(emptyOfKind.state, 'empty-of-kind');
  assert.match(emptyOfKind.reason, /表格已就绪/u);
  // 直方图必须进结论 —— 下次再犯要能一眼看出「页面里有哪些类型」
  assert.match(emptyOfKind.reason, /人群报表 5/u);

  const ready = classifyListRead({
    probe: { href: 'https://one.alimama.com/index.html#!/report/download-list', title: '下载任务管理_万相台无界版', trs: 41,
      hasTableHeader: true, hasRefresh: true, kinds: { 关键词报表: 5 } },
    rows: [{ name: '关键词报表_20261024_111611' }],
  });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.ok, true);

  // CDP 没响应时不许当「就绪」
  assert.equal(classifyListRead({ probe: null, rows: [] }).state, 'unknown');
});

test('取件段：表格始终没渲染时必须抛「没读到」，不许说成「不在列表里」', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function openTaskList');
  const rest = src.slice(start);
  const endMark = rest.indexOf('\n}\n');
  const body = endMark > 0 ? rest.slice(0, endMark) : rest;

  // 每轮必须探就绪状态，否则分不出「没渲染」和「真的没有」。
  // ⚠️ 必须**数出现次数**：2026-10-24 突变 M3 实测，只查 `includes('probeListPage(')`
  // 时把循环里那次探测删掉仍然全绿 —— 首读那次还在，探到的永远是同一屏的旧状态。
  // 这与「多拼接点的守卫必须数次数」是同一条教训（M3 上一轮就是漏在这里）。
  const probes = [...body.matchAll(/probeListPage\(/gu)].length;
  assert.ok(probes >= 2, `openTaskList 里必须至少探两次就绪状态（首探 + 每轮重探），实际 ${probes} 次 —— `
    + '只探一次就是「拿首读的旧状态判后面的屏」');
  assert.match(body, /classifyListRead\(\{ probe, rows \}\)/u, '就绪判据必须走 classifyListRead（纯函数，被用例钉住）');
  // 收尾：not-ready / unknown 都要抛，且措辞必须自证「这是没读到」
  assert.match(body, /finalVerdict\.state === 'not-ready' \|\| finalVerdict\.state === 'unknown'/u,
    '表格没渲染 / CDP 无响应时必须抛错，不许把空数组交出去');
  assert.match(body, /这是「没读到」，不是「列表里没有这个任务」/u,
    '抛错措辞必须把「没读到」和「不存在」分开');
  assert.doesNotMatch(body, /不在列表里/u, 'openTaskList 不许自己下「不在列表里」的结论');
  // 迟迟不渲染时要有一次主动纠偏（点刷新），且只点一次
  assert.match(body, /refreshTaskTable\(/u, '表格迟迟不渲染时必须能点一次「刷新表格」');
  assert.match(body, /!nudged/u, '刷新只能点一次，不许无限点');
});
