#!/usr/bin/env node
//
// 采集段第 1 步：生意参谋 → 自助分析 · 公共空间 → 日报 → 预览 → 下载报表。
//
// 为什么会有这个脚本（2026-09-17）：SOP §3 一直把这一步写成「操作步骤」，现场靠 %Temp% 下的
// 临时脚本点。对客户演示而言这是最容易出纰漏的一环 —— 临时脚本会被清理、失败只说一句沉默。
// 收编时**不改点页面的逻辑**，只把「日期/目录/断言」变成参数：这份点击顺序是 2026-09-17
// 11:1x 实跑通过的那一份（轮询等元素、点击前 elementFromPoint 复核、判据取文件系统）。
//
// 全流程只有一个目标日，所以 --date 不是「选项」而是断言的一部分：统计区间必须含它。
import path from 'node:path';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import {
  SHOP_REPORT_PATTERN, assertShopIdentity, createOverlayDismisser, dateWithinRange, defaultDownloadsDir,
  describeHitMiss, describeHitPass, describeOverlayAttempt, hitCheckExpression, listDownloads, newEntries,
  parseCollectArgs, pickNewest, scrollIntoViewExpression, sycmShopIdentityExpression,
} from './collect-core.mjs';

// 已验证的报表定义 id（SOP §3）；它进文件名哈希，变了就说明取的不是同一份报表。
const KNOWN_REPORT_ID = '4300764';
const SYCM_APP_URL = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const SYCM_SPACE_URL = 'https://sycm.taobao.com/lyone/auto_analysis/my_space'
  + '?insertType=sycm&layoutHide=1&useDebug=false&activeKey=common';

// 「哪个页面才算生意参谋那个**工作页**」—— 与 date-picker.mjs 的
// `siteAdapter('sycm').urlFragment`、run-inquiry-backfill.mjs 的 discoverSycmTarget 逐字相同
// （三方一致由 collect-core.test.mjs 的一条守卫扫，改一处就红）。
//
// 2026-09-18 修：这里原先写的是 `String(target.url).includes('sycm.taobao.com')` —— 只要同主机就算。
// 两个后果，一个当场炸、另一个更安静：
//   · 同主机下有两个页面时（工作页 + `portal/home.htm` 门户首页）⇒ 报
//     `expected one sycm page on …, got 2`，第 4 步直接停（2026-09-18 实跑就是这一条）；
//   · 同主机下只剩门户首页时 ⇒ 判据会**选中首页**并往上导航，而 SOP §3 实测过
//     「从门户首页跳这道 iframe 地址，12 秒后它自己跳回门户」（11:18:27 → 11:18:39）⇒
//     后面每一步都在错页面上做，全是静默失败。
// 它要的是那个能点开「日报 → 预览 → 下载报表」的工作页，不是「任意一个生意参谋页面」。
const SYCM_PAGE_FRAGMENT = 'sycm.taobao.com/qos/service/frame/shop/performance';

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

async function evalOn(args, targetId, expression) {
  const text = await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression });
  const payload = JSON.parse(text);
  const value = payload?.value;
  try { return JSON.parse(value); } catch { return value; }
}

async function navigate(args, targetId, url) {
  return proxyJson(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`);
}

async function bringToFront(args, targetId) {
  await proxyJson(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
}

async function click(args, targetId, selector) {
  return proxyJson(`${args.proxy}/click?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: selector });
}

// 关遮挡层那一步必须走**真实鼠标点击**（这一族页面上 JS 点击常常无效 —— 阿里妈妈侧做过干净对照：
// 同一元素 `el.click()` 等 15 秒无反应、真实鼠标点中心 3 秒见效），所以本脚本也要有这个原语。
async function clickPoint(args, targetId, point) {
  return proxyJson(`${args.proxy}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }) });
}

// 发一个真实按键（CDP 的 rawKeyDown → keyUp，走代理既有的 `/key` 白名单路由）。
// 只用来发 Escape：那是模态框最常见的出口，而且**不用点页面上的任何东西**，没有「点错」的风险。
async function pressKey(args, targetId, key) {
  return proxyJson(`${args.proxy}/key?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ key }) });
}

// 生意参谋这一侧同样会被**平台自己的全屏弹窗**盖住（新手引导/活动弹窗那一族），
// 而定时任务里没人去手点它 ⇒ 接上「主动关掉再复核」。编排在 collect-core（见那里的长注释）。
// 2026-09-26：与阿里妈妈侧共用同一套关法（先 ESC，再按有序候选逐个试，封顶 collect-core 里那个常量）；
// 但**不接**「关不掉就重载页面」那一步 —— 那一侧有现场证据、这一侧没有，没有证据就不加带副作用的动作。
const dismissBlockingOverlay = createOverlayDismisser({
  evalOn: (args, targetId, expression) => evalOn(args, targetId, expression),
  clickPoint: (args, targetId, point) => clickPoint(args, targetId, point),
  pressEscape: (args, targetId) => pressKey(args, targetId, 'Escape'),
  delay,
  log: (...parts) => console.log(...parts),
});

async function findSycmPage(args) {
  const targets = JSON.parse(await proxyJson(`${args.proxy}/targets`));
  const matches = targets.filter((target) => target.type === 'page'
    && String(target.url).includes(SYCM_PAGE_FRAGMENT));
  if (matches.length !== 1) throw new Error(`expected one sycm page on ${args.proxy}, got ${matches.length}`);
  return matches[0].targetId;
}

// 只做「命中复核」，不点击 —— 给 --locate-only 排练与 clickVerified 共用。
// 判据在 collect-core 的 hitCheckExpression 里（矩形内是否存在「视口内且命中自己」的采样点）。
async function hitCheckOnly(args, targetId, selector) {
  return evalOn(args, targetId, hitCheckExpression(selector));
}

// 预览行必须真的能点到：按钮可能在视口外（实测过 x=1035 而视口宽 1031），
// 那样「点了」会静默落空且不报错 —— 所以点击前一律复核。
// 2026-09-17 补：滚动必须**两个方向**都居中。只写 block:'center' 时，元素整个落在
// 视口右边界之外的情况不会被带回来，复核会误判成「点不到」（阿里妈妈侧就是这样中过一次）。
async function clickVerified(args, targetId, { selector, label, scroll }) {
  if (scroll) {
    await evalOn(args, targetId, scrollIntoViewExpression(selector));
  }
  await delay(1200);
  let hit = await hitCheckOnly(args, targetId, selector);
  if (!hit.ok) {
    // 平台自己的全屏弹窗挡住整页时**等不好**（与右侧会自收的浮层相反）⇒ 主动关掉再复核一次。
    // 关不掉、或本来就不是这一类遮挡：仍按原措辞报错（失败方向不变），只把「试过什么」补进去。
    const attempt = await dismissBlockingOverlay(args, targetId, selector);
    if (!attempt.dismissed) {
      throw new Error(`${label} 复核未通过（${describeHitMiss(hit)}）${describeOverlayAttempt(attempt)}`);
    }
    hit = await hitCheckOnly(args, targetId, selector);
  }
  if (!hit.ok) {
    throw new Error(`${label} 复核未通过（${describeHitMiss(hit)}）`
      + '（全屏遮挡层已关掉，这次不是它挡的）');
  }
  return `${describeHitPass(hit)} → ${(await click(args, targetId, selector)).slice(0, 80)}`;
}

async function main() {
  const args = parseCollectArgs(process.argv.slice(2), { reportId: KNOWN_REPORT_ID, flags: ['--locate-only'] });
  args.proxy = args.proxy ?? `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  args.downloads = path.resolve(args.downloads ?? defaultDownloadsDir());
  if (args.reportId !== KNOWN_REPORT_ID) {
    throw new Error(`报表定义 id 变了（${args.reportId} ≠ ${KNOWN_REPORT_ID}）：确认取的是同一份日报报表再继续`);
  }

  const targetId = await findSycmPage(args);
  await bringToFront(args, targetId);

  // 动手之前先认这一屏是哪家店（2026-09-18 加）。
  // 用户原话：「肯定是要是同一家店铺的数据的，绝对不能串数据」。
  // 生意参谋页头写的是**店铺名**（如「盖文全卫定制 主店」），这里把它读出来：
  // 给了 `--expect-shop` 就必须一致，不一致当场停 —— 因为这一屏点下去的下载，
  // 文件名里**只有日期和哈希、没有店名**，落盘之后再也回推不出它是谁家的。
  // 先回位、再认身份（2026-09-18 修，实亏两次）。
  // 为什么顺序必须是这样：`--locate-only` 排练会点「预览」，把**同一个页签**导到
  // 日报预览页（lyone/…/report_generation），那一页没有页头「xxx 主店」。
  // 而原来的次序是「先认身份、再 navigate 回位」⇒「排练通过 → 立刻真跑」必然读不到身份，
  // 报出来的却是「店铺身份读不到（期望…）」—— 看起来像窗口坏了或串店，实际只是次序问题；
  // 更糟的是**任何一次失败之后的正常重跑**都会踩它（第一次跑失败时也会把页留在预览页）。
  // 回位本身无害（只导航、不碰任何数据），所以挪到身份核对之前是安全的：
  // 「恰好一个 sycm 页」的判据仍在 findSycmPage 里，代理连错浏览器照样当场停。
  //
  // 从门户直跳应用内地址会被弹回门户（SOP §3.1），所以先落到应用内页再进公共空间。
  console.log('[0/4] 先回位到应用内页（上一次运行/排练可能把这一页留在日报预览页）');
  await navigate(args, targetId, SYCM_APP_URL);
  await delay(6000);

  // 动手之前先认这一屏是哪家店（2026-09-18 加）。
  // 用户原话：「肯定是要是同一家店铺的数据的，绝对不能串数据」。
  // 生意参谋页头写的是**店铺名**（如「盖文全卫定制 主店」），这里把它读出来：
  // 给了 `--expect-shop` 就必须一致，不一致当场停 —— 因为这一屏点下去的下载，
  // 文件名里**只有日期和哈希、没有店名**，落盘之后再也回推不出它是谁家的。
  const identity = await evalOn(args, targetId, sycmShopIdentityExpression());
  const identityCheck = assertShopIdentity({
    expected: args.expectShop, observed: identity.shopName, label: '生意参谋店铺',
  });
  console.log(`[身份] 生意参谋店铺名 = ${JSON.stringify(identity.shopName)}`
    + `（${identity.nodeType ?? '读不到'}）`
    + (args.expectShop
      ? `｜期望 ${JSON.stringify(args.expectShop)} ✓`
      : '｜未给 --expect-shop：只记录，不拦'));

  const before = listDownloads(args.downloads, SHOP_REPORT_PATTERN).map((entry) => entry.name);
  console.log(`      → 生意参谋页 ${targetId}｜已有日报 xlsx ${before.length} 个｜下载目录 ${args.downloads}`
    + `｜身份核对=${identityCheck.checked ? '已做' : '未做（没有期望值）'}`);

  console.log('[1/4] 再进 自助分析 · 公共空间');
  await navigate(args, targetId, SYCM_SPACE_URL);

  const findPreview = `(() => {
    document.querySelectorAll('[data-collect-preview]')
      .forEach((el) => el.removeAttribute('data-collect-preview'));
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0
      && el.textContent.trim() === '预览');
    const info = leaves.map((el, i) => {
      const row = el.closest('tr') || el.closest('[class*=row]') || el.parentElement;
      el.setAttribute('data-collect-preview', String(i));
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      return { i, rowText: (row ? row.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 70),
        inViewport: r.y >= 0 && r.y < window.innerHeight,
        hitOk: !!hit && (hit === el || el.contains(hit) || hit.contains(el)) };
    });
    return JSON.stringify({ href: location.href, count: leaves.length, info });
  })()`;

  let found = null;
  for (let round = 1; round <= 10; round += 1) {
    await delay(2500);
    const state = await evalOn(args, targetId, findPreview);
    const daily = (state.info || []).find((entry) => entry.rowText.includes('日报'));
    console.log(`[2/4] ${round * 2.5}s：预览按钮 ${state.count} 个`
      + `${daily ? `，日报行 #${daily.i}（命中复核=${daily.hitOk}，视口内=${daily.inViewport}）` : ''}`);
    if (daily && daily.hitOk) { found = daily; break; }
    if (daily && round === 10) found = daily;
  }
  if (!found) throw new Error('等不到「日报」这一行的预览按钮');
  console.log(`[2/4] 点开「日报」预览（#${found.i}）→ ${await click(args, targetId, `[data-collect-preview="${found.i}"]`)}`);

  let preview = null;
  for (let round = 1; round <= 8; round += 1) {
    await delay(3000);
    preview = await evalOn(args, targetId, `(() => {
      document.querySelectorAll('[data-collect-download]')
        .forEach((el) => el.removeAttribute('data-collect-download'));
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const range = text.match(/统计日期[：:]\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\\s*[～~]\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
      const button = [...document.querySelectorAll('button,a,div,span')]
        .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载报表')[0];
      if (button) { button.scrollIntoView({ block: 'center', inline: 'center' }); button.setAttribute('data-collect-download', '1'); }
      return JSON.stringify({ href: location.href, range: range ? [range[1], range[2]] : null, downloadButton: !!button });
    })()`);
    console.log(`[3/4] ${round * 3}s：统计区间=${JSON.stringify(preview.range)}｜下载按钮=${preview.downloadButton}`);
    if (preview.range && preview.downloadButton) break;
  }
  if (!preview?.downloadButton) throw new Error('没进到预览页（找不到「下载报表」按钮）');
  if (!preview.range) throw new Error('进了预览页但读不到「统计日期」区间：无法确认这份工作簿含目标日，停');
  if (!dateWithinRange(preview.range, args.date)) {
    throw new Error(`统计区间 ${preview.range.join(' ~ ')} 不含目标日 ${args.date}：这份工作簿用不了，停`);
  }
  console.log(`[3/4] 统计区间 ${preview.range.join(' ~ ')} 含目标日 ${args.date} ✓`);

  // 排练开关：把「找得到 + 点得到 + 区间含目标日」全验一遍，但不真的点下载。
  // 有它才能在不动任何东西的前提下先证明定位逻辑是对的（这正是最容易出纰漏的部分）。
  if (args.locateOnly) {
    // 排练也要真走一次「滚动 + 复核」，否则会排练通过、真跑失败 —— 那正是最容易出纰漏的地方。
    // 同样接上关遮挡：排练撞上全屏弹窗也得自己过得去，否则「排练红」会被人当成「选择器坏了」，
    // 而真正的原因只是有个弹窗盖着 —— 那种误判会浪费一整个下午。
    await evalOn(args, targetId, scrollIntoViewExpression('[data-collect-download="1"]'));
    await delay(1200);
    let hit = await hitCheckOnly(args, targetId, '[data-collect-download="1"]');
    if (!hit.ok) {
      const attempt = await dismissBlockingOverlay(args, targetId, '[data-collect-download="1"]');
      if (attempt.dismissed) hit = await hitCheckOnly(args, targetId, '[data-collect-download="1"]');
      if (!hit.ok) {
        throw new Error(`下载报表按钮 复核未通过（${describeHitMiss(hit)}）`
          + describeOverlayAttempt(attempt));
      }
    }
    console.log(`[4/4] --locate-only：定位与复核都通过（${describeHitPass(hit)}），未点击`);
    return;
  }

  console.log('[4/4] 点「下载报表」');
  console.log(`      → ${await clickVerified(args, targetId,
    { selector: '[data-collect-download="1"]', label: '下载报表按钮', scroll: true })}`);

  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await delay(3000);
    const fresh = newEntries(before, listDownloads(args.downloads, SHOP_REPORT_PATTERN).map((entry) => entry.name));
    if (fresh.length) {
      const newest = pickNewest(listDownloads(args.downloads, SHOP_REPORT_PATTERN)
        .filter((entry) => fresh.includes(entry.name)));
      console.log(`      新文件：${newest.name}（${newest.size} bytes）`);
      console.log(`      shopXlsxPath = ${path.join(args.downloads, newest.name)}`);
      return;
    }
    console.log(`      等待下载… ${Math.round((args.timeoutMs - (deadline - Date.now())) / 1000)}s`);
  }
  throw new Error(`${args.timeoutMs}ms 内没等到新的店铺报表：判据取文件系统，页面说「已触发下载」不算数`);
}

main().catch((error) => {
  console.error(`\n采集失败：${error.message}`);
  process.exitCode = 1;
});
