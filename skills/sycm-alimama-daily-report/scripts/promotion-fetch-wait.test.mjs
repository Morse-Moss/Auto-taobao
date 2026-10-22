import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { waitForDownloadEntry } from './collect-promotion-report.mjs';

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
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8');
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
  const src = readFileSync(path.join(here, 'collect-promotion-report.mjs'), 'utf8');

  const judge = (text) => {
    const start = text.indexOf('async function openTaskList');
    if (start < 0) return null;
    const rest = text.slice(start, start + 900);
    const endMark = rest.indexOf('\n}');
    const body = endMark > 0 ? rest.slice(0, endMark) : rest;
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
