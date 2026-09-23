// 一次性实例真机演练：**一个窗口里堆了两个店铺标识页 → 收敛成一个**。
//
// 为什么必须有这一步（本仓库反复吃过的亏，也是本轮改动唯一真正有风险的地方）：
// 「函数级用例全绿 ≠ 那件事真的发生了」。离线用例里那个假代理**是我自己写的** ——
// 它把 `/close` 建模成「关掉就从 /targets 里消失」，而这恰恰是要验证的那件事。
// 所以真机上必须再跑一次：真的 Edge、真的 cdp-proxy、真的 `/close`，看多余的页签是不是真没了。
//
// 三条纪律（都不是新发明的，是这几轮一直在用的）：
//   1) **只在未登记的端口 + 临时 profile 上跑**（19931 / 19941，登记表里没有这两个号）
//      ⇒ 不碰任何已登记的店铺实例，也不碰竞品/日报那两条链的浏览器。
//   2) **先探测端口是空的**再起：万一那里已经有别人的实例，本脚本**停手**而不是接上去。
//   3) **跑完释放并复核**：显式 taskkill 整棵进程树，再回读端口确认真的没了（自报「已释放」不算数）。
//
// 归属判据（本文件只做这一件事）：写进去两个标识页 → 跑 `ensureLabelTabOn` → 断言
//   · 只留下**一个**，且它就是 `/targets` 顺序里的第一个（与 `prunePlan` 的 `keepFirst` 同口径）；
//   · 其余标识页**每一个**都被关掉，并且真的从 `/targets` 里消失；
//   · 留下的那个**已经被重新导航**到本次 URL —— 这一步才是「留哪个都不影响最终事实」的兜底；
//   · **其余页签一个都没变**（工作页/千牛/登录页的 URL 与数量都相同）—— 「只动标识页」这句话的证据。
//
// 2026-09-23 跑出来的一个**原先没料到的顺序事实**（见下面那条「顺序记录」检查）：
// `/targets` 的顺序**不是页签条顺序，也不是创建顺序** —— 而且**两次运行还不一样**：
//   · 第一次：新建的重复页排在首屏那个**前面**（于是活下来的是新的那个）；
//   · 第二次：首屏那个排在前面（于是活下来的是首屏那个）。
// 第一次按「留的必是首屏那个」写的断言当场变红 ⇒ 改的是**断言**（它断言了一个不影响正确性的细节），
// 代码没动：真正必须成立的是「与 prunePlan 同一口径」，那条由「两边都取 /targets 顺序」保证；
// 而「窗口上写的是什么」由「留下的那个重新导航成本次 URL」保证 —— 两者都与顺序无关。
// 这条事实也顺便证明：**「留第一个」这个说法只有在「和 prunePlan 同一个顺序」时才有意义**。
//
// 用法（任意目录均可；路径按**自身位置**算，收进 evidence/ 后仍然可跑）：
//   node evidence/label-converge-2026-09-23/rehearse-converge-throwaway-2026-09-23.mjs
// 产物：同目录 `throwaway-rehearsal.json`（结构化断言）＋ stdout（另存为 `throwaway-rehearsal.txt`）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureLabelTabOn, labelPageUrlFor } from '../../runtime/shop-window-label.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const say = (line) => process.stdout.write(`${line}\n`);

// 未登记端口。挑这两个数的理由：登记表里 9231/9232/3457/19022-19035/19041-19045 都已占用，
// 19931/19941 谁都不用；本文件里出现它们**不算写死生产端口**（这里是一次性实例的入参）。
const BROWSER_PORT = 19931;
const PROXY_PORT = 19941;
const SHOP = '里可林淘宝';
const SHOP_PORT = 19031;   // 只用来拼标识页 URL 里的 `port=` 显示参数，**不连这个端口**
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

const report = { startedAt: new Date().toISOString(), browserPort: BROWSER_PORT, proxyPort: PROXY_PORT, shop: SHOP, checks: [], artifacts: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  say(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
};

const fetchImplWithLedger = (ledger) => async (url, init) => {
  ledger.push({ url: String(url), method: init?.method ?? 'GET' });
  return fetch(url, init);
};

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return `HTTP ${r.status}`;
  } catch (error) {
    return null; // 连不上＝空闲（这里只接受这一种「空闲」证据，别的一律停手）
  }
}

async function waitFor(label, url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
    } catch (error) { last = error.cause?.code ?? error.message; }
    await sleep(500);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没就绪（最后错误：${last}）`);
}

const readTargets = async (ledger) => {
  const r = await fetch(`${PROXY}/targets`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GET /targets → HTTP ${r.status}`);
  return r.json();
};
const labelTabs = (list) => list.filter((t) => String(t.url).includes('shop-window-label.html'));
const nonLabel = (list) => list.filter((t) => !String(t.url).includes('shop-window-label.html'))
  .map((t) => `${t.targetId} ${t.url}`).sort();

const children = [];
let profile = null;

async function cleanup(reason) {
  say(`\n=== 释放（${reason}）`);
  report.release = { reason, killed: [] };
  for (const child of children) {
    if (!child.pid) continue;
    const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    report.release.killed.push({ pid: child.pid, taskkill: `${kill.status}` });
    say(`   taskkill /PID ${child.pid} /T /F → ${kill.status}`);
  }
  await sleep(2500);
  report.release.browserPortAfter = await portAlive(BROWSER_PORT);
  report.release.proxyPortAfter = await portAlive(PROXY_PORT);
  check('释放后两个端口都不再应答（自报「已释放」不算数）',
    report.release.browserPortAfter === null && report.release.proxyPortAfter === null,
    `/json/version=${report.release.browserPortAfter}，/targets 端口=${report.release.proxyPortAfter}`);
  if (profile) {
    // 临时 profile 留一份「有多大、删掉成没成」的记录：删不掉要说出来，不能假装干净。
    let size = null;
    try { size = fs.statSync(profile).size; } catch { /* 目录本身不许 stat 大小，忽略 */ }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      report.release.profileRemoved = true;
    } catch (error) { report.release.profileRemoved = String(error.message).slice(0, 200); }
    report.release.profile = profile;
    say(`   临时 profile：${profile}（删除结果：${report.release.profileRemoved}）`);
  }
}

try {
  // ---- 0) 前提：两个端口必须是空的 -----------------------------------------
  const browserBefore = await portAlive(BROWSER_PORT);
  const proxyBefore = await portAlive(PROXY_PORT);
  check('演练端口事先是空的（不是接上别人的实例）',
    browserBefore === null && proxyBefore === null,
    `浏览器 ${BROWSER_PORT}=${browserBefore}，代理 ${PROXY_PORT}=${proxyBefore}`);
  if (browserBefore !== null || proxyBefore !== null) {
    throw new Error('端口已被占用 ⇒ 停手，绝不接上去（那会把别人的浏览器当成演练对象）');
  }

  // ---- 1) 起一次性实例（临时 profile）--------------------------------------
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'label-converge-'));
  const firstScreenUrl = labelPageUrlFor({ shop: SHOP, port: SHOP_PORT });
  report.temporaryProfile = profile;
  report.firstScreenUrl = firstScreenUrl;
  say(`=== 起一次性实例：port=${BROWSER_PORT} profile=${profile}`);
  say(`    首屏＝标识页（与店铺实例同一口径）：${firstScreenUrl}`);

  const browserLog = [];
  const browser = spawn(NODE, [path.join(REPO, 'runtime/start-project-browser.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PROJECT_BROWSER_PORT: String(BROWSER_PORT),
      PROJECT_BROWSER_PROFILE: profile,
      PROJECT_BROWSER_URL: firstScreenUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(browser);
  browser.stdout.on('data', (d) => browserLog.push(String(d)));
  browser.stderr.on('data', (d) => browserLog.push(String(d)));
  await waitFor('调试端口', `http://127.0.0.1:${BROWSER_PORT}/json/version`);
  say(browserLog.join('').trim().split('\n').map((l) => `    [browser] ${l}`).join('\n'));

  const proxyLog = [];
  const proxy = spawn(NODE, [path.join(REPO, 'runtime/isolated-proxy/cdp-proxy.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CDP_PROXY_PORT: String(PROXY_PORT),
      CDP_BROWSER_PORT: String(BROWSER_PORT),
      CDP_BROWSER_ID: 'label-converge-rehearsal',
      CDP_BROWSER_LABEL: '一次性演练实例（跑完就释放）',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proxy);
  proxy.stdout.on('data', (d) => proxyLog.push(String(d)));
  proxy.stderr.on('data', (d) => proxyLog.push(String(d)));
  await waitFor('代理 /targets', `${PROXY}/targets`);
  say(proxyLog.join('').trim().split('\n').map((l) => `    [proxy] ${l}`).join('\n'));

  // ---- 2) 造出现场：再写一个标识页（模拟「上一轮 --commit 留下的那个」）------
  const before = await readTargets();
  report.tabsBefore = before.map((t) => ({ targetId: t.targetId, url: t.url }));
  say(`\n=== 起完时的页签（${before.length} 个）：`);
  for (const t of before) say(`    ${t.targetId}  ${t.url}`);
  const firstLabel = labelTabs(before)[0];
  check('冷启动首屏就是一个标识页（1.3.0 的首屏改动在这一档也成立）',
    labelTabs(before).length === 1 && firstLabel !== undefined,
    `标识页 ${labelTabs(before).length} 个`);

  // 第二个标识页刻意用**真实现场那种形状**：带上 member/state/actual，也就是 `--commit` 写出来的那种。
  const duplicateUrl = labelPageUrlFor({
    shop: SHOP, port: SHOP_PORT, state: '已登录', ok: true,
    member: '里可林家居:阿彦', actual: '里可林家居:阿彦',
  });
  const created = await fetch(
    `${PROXY}/new?url=${encodeURIComponent(duplicateUrl)}&label=label-duplicate&pinned=1`,
    { method: 'POST', signal: AbortSignal.timeout(15000) },
  ).then((r) => r.json());
  await sleep(800);
  const twoLabels = await readTargets();
  report.tabsWithDuplicate = twoLabels.map((t) => ({ targetId: t.targetId, url: t.url }));
  say(`\n=== 造出现场后的页签（${twoLabels.length} 个）：`);
  for (const t of twoLabels) say(`    ${t.targetId}  ${t.url}`);
  check('现场成立：这个窗口里现在有 2 个标识页',
    labelTabs(twoLabels).length === 2,
    `标识页 ${labelTabs(twoLabels).length} 个（新建的 ${created.targetId}）`);

  const nonLabelBefore = nonLabel(twoLabels);
  // `/targets` 给回来的顺序。**它既不是页签条顺序、也不是创建顺序**（两次运行实测，而且两次相反）——
  // 所以「谁活下来」只能按这个顺序断言，按「首屏那个」断言会红，而那是断言写错了。
  const labelOrder = labelTabs(twoLabels).map((t) => t.targetId);

  // ---- 3) 真跑收敛（用的是真 fetch，不注入假代理）--------------------------
  say('\n=== 真跑 ensureLabelTabOn（真代理、真 /close、真回读）');
  const ledger = [];
  const t0 = Date.now();
  const result = await ensureLabelTabOn({
    proxyUrl: PROXY,
    shop: SHOP,
    port: SHOP_PORT,
    fetchImpl: fetchImplWithLedger(ledger),
  });
  const elapsedMs = Date.now() - t0;
  report.result = {
    ok: result.ok, converged: result.converged, reused: result.reused, adoptedBlank: result.adoptedBlank,
    targetId: result.targetId, url: result.url, labelsAfter: result.labelsAfter, reads: result.reads,
    closed: result.closed.map((t) => t.targetId), failed: result.failed, error: result.error ?? null,
    pinned: result.pinned, elapsedMs,
  };
  say(JSON.stringify(report.result, null, 1));
  report.ledger = ledger.map((c) => `${c.method} ${c.url}`);

  check('收敛报成功，且如实标出走的是收敛这一路',
    result.ok === true && result.converged === true, `ok=${result.ok} converged=${result.converged}`);
  check('留下的必须是 /targets 顺序里的第一个（与 prunePlan 的 keepFirst 同一口径）',
    result.targetId === labelOrder[0],
    `留 ${result.targetId}；/targets 顺序 ${labelOrder.join(' → ')}；新建的重复页 ${created.targetId}；首屏那个 ${firstLabel.targetId}`);
  check('其余的每一个都被关掉（本轮 2 个 ⇒ 关 1 个）',
    JSON.stringify(result.closed.map((t) => t.targetId)) === JSON.stringify(labelOrder.slice(1)),
    `closed=${JSON.stringify(result.closed.map((t) => t.targetId))}，应为 ${JSON.stringify(labelOrder.slice(1))}`);
  check('顺序记录（不是判据，是这次实测到的事实）：/targets 顺序 ≠ 创建顺序',
    true,
    `${labelOrder.join(' → ')}（新建的 ${created.targetId}；首屏的 ${firstLabel.targetId}）`);
  check('关完回读确认：恰好剩 1 个标识页',
    result.labelsAfter === 1, `labelsAfter=${result.labelsAfter}，reads=${result.reads}`);
  check('留下的那个已被重新导航到本次 URL（URL 里带本次店名、不带旧 member=）',
    String(result.url).includes(encodeURIComponent(SHOP)),
    report.result.url);

  const after = await readTargets();
  report.tabsAfter = after.map((t) => ({ targetId: t.targetId, url: t.url }));
  say(`\n=== 收敛后的页签（${after.length} 个）：`);
  for (const t of after) say(`    ${t.targetId}  ${t.url}`);

  check('真机事实：窗口里只剩 1 个标识页（不是「报告说关了」）',
    labelTabs(after).length === 1, `标识页 ${labelTabs(after).length} 个`);
  check('被关掉的那些 targetId 真的从 /targets 里消失了（不是「报告说关了」）',
    result.closed.every((t) => !after.some((x) => x.targetId === t.targetId)),
    `closed=${JSON.stringify(result.closed.map((t) => t.targetId))}`);
  check('**其余页签一个都没变**（「只动标识页」这句话的证据）',
    JSON.stringify(nonLabel(after)) === JSON.stringify(nonLabelBefore),
    `前：${JSON.stringify(nonLabelBefore)}；后：${JSON.stringify(nonLabel(after))}`);
  check('关的只有那一个标识页 —— 没有顺手关掉别的东西',
    ledger.filter((c) => c.url.includes('/close')).length === 1,
    `本函数一共发了 ${ledger.filter((c) => c.url.includes('/close')).length} 次 /close`);

  // ---- 4) 幂等：再跑一次不该再关任何东西 -----------------------------------
  say('\n=== 再跑一次（幂等检查）');
  const ledger2 = [];
  const second = await ensureLabelTabOn({
    proxyUrl: PROXY, shop: SHOP, port: SHOP_PORT, fetchImpl: fetchImplWithLedger(ledger2),
  });
  report.secondRun = {
    ok: second.ok, converged: second.converged, reused: second.reused, targetId: second.targetId,
    url: second.url, closes: ledger2.filter((c) => c.url.includes('/close')).length,
  };
  say(JSON.stringify(report.secondRun, null, 1));
  check('第二次跑走的是「复用」而不是「收敛」，且一次 /close 都没发',
    second.converged === false && second.reused === true && report.secondRun.closes === 0,
    `converged=${second.converged} reused=${second.reused} closes=${report.secondRun.closes}`);

  report.verdict = report.checks.every((c) => c.ok) ? '全部成立' : '有不成立的项';
} catch (error) {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  say(`\n!! 演练中断：${error.message}`);
} finally {
  await cleanup(report.fatal ? '演练中断也要释放' : '演练结束');
  report.finishedAt = new Date().toISOString();
  const outPath = path.join(import.meta.dirname, 'throwaway-rehearsal.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  say(`\n结论：${report.verdict ?? '未完成'}；明细：${path.relative(REPO, outPath)}`);
  // 退出码只由**两件事同时成立**决定：每一项检查都过、且中途没有致命中断。
  // （第一次跑时漏了后半句：中途 `labelOrder is not defined` 中断，而退出码是 0 —— 一个
  //  「崩了却报成功」的退出码，正是这套证据最不该有的东西。）
  process.exitCode = (report.checks.length > 0 && report.checks.every((c) => c.ok) && !report.fatal) ? 0 : 1;
}
