// 接线守卫：`collect-product-report.mjs` 页面侧探针是否真的**按宽判据**取候选（2026-10-21 加）。
//
// 为什么需要这一层：download-entry-core.test.mjs 钉的是「拿到候选之后怎么排、怎么过滤」，
// 但 2026-10-20 里可林天猫那次假红的病根不在排序，而在**页面侧根本没把候选取回来** ——
// 探针里写着 `children.length===0 && textContent==='下载'` 这种窄条件，按钮文字一包进 span
// 就取回空数组，Node 侧再正确也无从排起。
//
// 本项目已发作三次的同一条教训：「用例全绿 + 突变过了」不等于接线接上了。
// 排序层突变确实会红（已验），但把探针退回窄判据，排序层用例一条都不会红 —— 就是这里要堵的洞。
// 所以这条守卫不测行为，只钉**调用侧到底传了什么判据**（源码文本级断言）。
//
// 它读文件、不连浏览器 ⇒ 快、离线、可在任何机器上跑；代价是它只防「退回旧写法」，
// 不证明新写法在真实页面里一定取得到 —— 后者只能靠真跑留证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'collect-product-report.mjs'), 'utf8');

test('页面侧取候选用「包含下载」，不用「恰好等于下载」', () => {
  // 真实写法：filter(x=>(x.textContent||'').includes('下载'))
  assert.match(
    source,
    /filter\(\s*x\s*=>\s*\(\s*x\.textContent\s*\|\|\s*''\s*\)\.includes\(\s*'下载'\s*\)\s*\)/,
    '探针必须用 includes 取候选；退回 === 会把包了 span 的按钮漏掉（2026-10-20 里可林天猫假红的原因）',
  );
});

test('页面侧取候选不再要求叶子节点或宽度', () => {
  // 旧判据三件套：children.length===0 / 恰好相等 / width>0。放宽后前两条不许回来。
  assert.doesNotMatch(
    source,
    /filter\([^)]*children\.length\s*===\s*0[^)]*下载/,
    '取候选时不许再要求叶子节点：antd 按钮的文字常在 span 里',
  );
  assert.doesNotMatch(
    source,
    /\.trim\(\)\s*===\s*'下载'/,
    '取候选时不许用「恰好等于下载」当门槛；精确相等只用于排序（rank 在 download-entry-core.mjs）',
  );
});

test('候选排序与命中判定走抽出来的纯函数与浏览器复核', () => {
  // 排序必须在 Node 侧（可做离线用例 + 突变），命中必须问浏览器 elementFromPoint。
  assert.match(source, /rankDownloadCandidates\s*\(/, '排序必须调用 download-entry-core.mjs 的 rankDownloadCandidates');
  assert.match(source, /describeDownloadFailure\s*\(/, '失败时必须用 describeDownloadFailure 说清「看到了什么」');
  assert.match(source, /elementFromPoint\s*\(/, '命中判定必须是浏览器的 elementFromPoint，不许几何推算');
});

test('失败信息不再是同一句符号', () => {
  // 旧版所有失败都报「商品报表任务下载入口不可见」；新版要带上候选数/看到了什么。
  assert.match(
    source,
    /商品报表下载入口不可用/,
    '失败必须报「不可用 + 原因 + 看到了什么」，不能退回一句「入口不可见」',
  );
});

// ── 2026-10-29 加：关遮挡的两处接线 ───────────────────────────────────────────────
// 现场：2026-10-28 三家（盖文淘宝、网林淘宝、保拉天猫）的推广段全卡在弹窗上，
// 而日报链的三个采集器**同一天 7/7 全绿**。差别不在判据（都走 collect-core 的同一个
// overlayScanExpression），在**接线**：日报链注入了 ESC，商品链这两个脚本没注入；
// 日报链取件段有关遮挡，商品链的**提交段**（点「下载报表」→「确定」）一次都没查。
// 这条守卫因此只钉调用侧实参，不钉被调侧实现（那部分在 collect-core.test.mjs 里）。

test('关遮挡必须注入 pressEscape：ESC 是最安全的一招，不许只写日志说不注入', () => {
  const hits = source.match(/pressEscape\s*:/g) ?? [];
  assert.equal(hits.length, 1,
    `dismisser 必须恰好注入一处 pressEscape，实际 ${hits.length} 处（0 处 = 退回「跳过 ESC」的旧行为）`);
  assert.match(source, /\/key\?target=/, 'ESC 必须走代理的真实按键路由（页面里 dispatchEvent 造的伪键盘事件这一族页面不认）');
  assert.doesNotMatch(source, /dispatchEvent\(\s*new\s+KeyboardEvent/,
    '不许用页面内派发的假键盘事件冒充按键');
});

test('提交段必须先查遮挡再点「下载报表」：否则「确定」会被弹窗吃掉且误判成功', () => {
  const start = source.indexOf('async function submit(');
  assert.ok(start > 0, '找不到 submit 函数 —— 这段守卫的前提是它还在');
  const body = source.slice(start, start + 4000);
  const guardAt = body.indexOf('overlayScanExpression()');
  // 锚点用**那一行点击语句**，不用「下载报表」这四个字：
  // 守卫自己的注释里也写着这四个字，拿它当锚点会量到注释位置（第一版就这么假绿过）。
  const clickAt = body.indexOf('const clicked=await');
  assert.ok(guardAt > 0, 'submit 里必须有一次 overlayScanExpression() 做提交前守卫');
  assert.ok(clickAt > 0, 'submit 里必须还有「下载报表」那一下点击（锚点：const clicked=await）');
  assert.ok(guardAt < clickAt,
    '守卫必须在点击之前：先清干净再点，否则「确定」会落到弹窗上（盖文淘宝 10-28 就是这么丢的一天）');
  assert.match(body, /OVERLAY_NOT_DISMISSED|describeOverlayAttempt/,
    '关不掉时必须带上标记让链能分类，不能退化成一句普通失败');
});

// 2026-10-30：第二种形态「零安全出口」的营销弹窗（保拉天猫 DIV#wrapper_dlg_107，
// 层里只有两枚「立即体验」）。两条新接线必须钉住：
//   ① 只对「零安全候选」启用的视觉隐藏，作用域锁在两个报表页；
//   ② 撞层后**只重载一次**，第二次还清不掉就交人（循环重试是错的：同一层反复清不掉不是偶发）。
test('零安全出口：必须注入 hideLayer，且作用域锁在商品报表与下载任务页', () => {
  const hits = source.match(/hideLayer\s*:/g) ?? [];
  assert.equal(hits.length, 1,
    `dismisser 必须恰好注入一处 hideLayer，实际 ${hits.length} 处（0 处 = 这一族永远只能交人）`);
  assert.match(source, /overlayHideExpression\(\s*\{\s*scopes:/u,
    '藏层必须带 scopes 白名单，不许无条件藏 —— 藏错页面比卡住更难查');
  assert.match(source, /item_promotion\|download-list/u,
    '白名单必须同时覆盖商品报表与下载任务页');
  // 危险词表只有一份：collect-core 里那份。这里再写一份就会出现「两处判据打架」。
  assert.doesNotMatch(source, /OVERLAY_DISMISS_DANGER\s*=/u,
    '不许在采集脚本里重写危险词表（唯一来源是 collect-core 的 OVERLAY_DISMISS_DANGER）');
});

test('撞层后只重载一次：有界，且第二次还清不掉必须交人', () => {
  const start = source.indexOf('async function submit(');
  assert.ok(start > 0, '找不到 submit 函数 —— 这条守卫的前提是它还在');
  const body = source.slice(start, start + 5000);
  const retries = (body.match(/const back=await waitForDownloadButton/g) ?? []).length;
  assert.equal(retries, 1, `重载只许一处（有界），实际 ${retries} 处`);
  assert.match(body, /已重载一次仍未清掉/u,
    '第二次还清不掉必须抛错交人：同一层连着两次清不掉不是「偶发弹了一下」，是人的事');
  assert.match(body, /waitForDownloadButton\(proxy,target,45000\)/u,
    '重载后要等「下载报表」回来再扫，不能靠固定 sleep 猜页面何时就绪');
});
