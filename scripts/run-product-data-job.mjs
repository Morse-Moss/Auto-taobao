#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { shopBrowserKeys, shopInstance } from '../runtime/browser-ports.mjs';
import { buildProductJobPlan, PRODUCT_JOB_FILES, SKIP_PROMOTION_REASON } from '../runtime/product-data-job-core.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
import { acquireWorkflowLock, WORKFLOW_LOCK_NAME } from '../runtime/workflow-lock.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { classifyWorkflowError, createWorkflowReceipt, writeWorkflowReceipt } from '../runtime/workflow-receipt.mjs';
import { runEnvironmentPreflight } from '../runtime/environment-preflight.mjs';
import { readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from '../runtime/alert-throttle.mjs';
// 分批的「该切成几批、每批跑哪几家」**唯一口径**在 `runtime/batch-plan.mjs`（纯函数、有离线判据）：
// 与日报链共用同一层，**不在这里再写一份切法** —— 两处实现最后一定不一致，而切错了只会**静默漏做**
// （跑完了，但有两家没被处理）。逐批登录结论的文件名同样从那里取（`batchLoginArtifactName`）。
import { batchLoginArtifactName, describeBatch, planBatches } from '../runtime/batch-plan.mjs';
// 起完实例的「视口回读」闸门。为什么必须在采集之前：窗口被屏幕尺寸夹窄时，
// 采集脚本只会报一堆 `not-hit`，等看到那些读数，这一家已经白跑完了。
import { checkShopViewports, describeViewportFailure } from '../runtime/shop-viewport-gate.mjs';
// 补页能力的**唯一实现**是 `runtime/page-normalize.mjs`（它自己再调 `shop-pages.mjs`）。
// 这里只是把它接到「登录预检读到『这个窗口里没有它的页面』」这条路径上 —— 不另写一份补页。
import { normalizePages } from '../runtime/page-normalize.mjs';
// 期望页面清单的唯一来源（守卫 `runtime/arch-boundary.test.mjs` 钉着它）。
import { expectedPagesForShop } from '../skills/sycm-alimama-daily-report/scripts/expected-pages.mjs';
// 站点名（生意参谋 / 阿里妈妈）的唯一来源。**不在这里另抄一份中英对照** ——
// 抄一份就会出现「告警里写的是另一个名字」，而收信人照着找不到那个后台。
import { SITES } from '../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function parseArgs(argv) { const o = { date: 'yesterday', shops: null, commit: false, notify: false, batches: null, skipPromotion: false }; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === '--date') o.date = argv[++i]; else if (a === '--shops') o.shops = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean); else if (a === '--commit') o.commit = true; else if (a === '--notify') o.notify = true; else if (a === '--skip-promotion') o.skipPromotion = true; else if (a === '--batches') { const raw = argv[++i]; const value = Number(raw); if (!Number.isInteger(value) || value < 1) throw new Error(`--batches 要一个 ≥1 的整数（每批几家），收到 ${JSON.stringify(raw)}`); o.batches = value; } else if (a === '--help' || a === '-h') o.help = true; else throw new Error(`unknown argument ${a}`); } return o; }
function run(file, args, { capture = false } = {}) { return new Promise((resolve) => { const child = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] }); let out = ''; let err = ''; if (capture) { child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { err += x; }); } child.on('close', (code) => resolve({ code: code ?? -1, out, err })); child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) })); }); }
function jsonTail(text) { const i = text.lastIndexOf('{'); if (i < 0) return null; try { return JSON.parse(text.slice(i)); } catch { return null; } }
// 子 CLI 的收据（notify-feishu / 释放包装）是**缩进过的** JSON，jsonTail 那种「从最后一个 `{` 开始解析」
// 会切到内层对象上、解析失败 —— 那时会被误读成「没送到」。所以先整体解析，再退回 jsonTail（兼容一行式 JSON）。
function parseJsonOutput(text) { const raw = String(text ?? '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch { return jsonTail(raw); } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

// 收据里阶段状态只用四个词：PENDING（没轮到）/ COMPLETED / FAILED / **SKIPPED（有意跳过）**。
// SKIPPED 是 2026-10-05 加的：那三个词表达不了「这段我们决定不做」——
// 写成 PENDING 会被读成「还没轮到、下次会跑」，写成 COMPLETED 是假绿，写成 FAILED 会让整轮报错。
// 「停在哪一段」另记 `failedStage` —— 否则 PENDING 会同时表示「没轮到」和「跑失败了」。
// 阶段＝采集＋导入：导入失败时要把已经记成 COMPLETED 的那一段改回 FAILED（见下面的信息映射）。
function markStage(receipt, name, status) { const stage = receipt.stages?.find((entry) => entry.name === name); if (stage) stage.status = status; }

// 从失败信息归因到「停在哪一段」。采集与导入两类信息用的是同一组词（商品底单/询单/推广），
// 所以一张表就够；前三段（预检/启动/登录）不是阶段名，只用来写日志、不改进度表。
const STAGE_OF_MESSAGE = [
  [/商品底单/u, 'product'],
  [/商品询单/u, 'inquiry'],
  [/商品推广/u, 'promotion'],
  [/环境预检/u, 'preflight'],
  [/浏览器启动/u, 'start'],
  // 视口闸门拦下来的归到 `start`：它不是某一家采集失败，而是「这批实例的启动结果不可用」。
  [/浏览器视口/u, 'start'],
  [/登录预检/u, 'login'],
];
function stageFromMessage(message) { return STAGE_OF_MESSAGE.find(([pattern]) => pattern.test(String(message)))?.[1] ?? null; }

/**
 * 失败时叫人（只在给了 `--notify` 时；成功不叫 —— 与日报链同一口径）。
 *
 * 三个不能省的点：
 *   ① 去重走公共模块 `runtime/alert-throttle.mjs`（别再各自抄一份）；指纹里含「停在哪一段」，
 *      同一编号但停的地方变了算新信息，不该被挡掉。
 *   ② 投递结论以 CLI 收据为准（SENT / DEDUPED / FAILED / NOT_CONFIGURED），**只真送出去了才记账** ——
 *      送失败还记账，会让下一次重跑被自己的记录挡掉。
 *   ③ 告警载荷同时落盘成 `alert.json`，收信人照着能自己去看证据目录。
 */
async function notifyFailure({ date, runId, evidence, failure, failedStage, log, shopCount = null }) {
  const alertId = `product-data-${date}`;
  const fingerprint = `${failure?.class ?? 'FAILED'}|${failure?.reason ?? 'UNKNOWN'}|${failedStage ?? '-'}`;
  const decision = resolveAlertDedup({ previous: readAlertThrottleEntry({ alertId }), alertId, fingerprint });
  if (!decision.send) { log(`告警未发（去重）：${decision.reason}`); return { status: 'DEDUPED', reason: decision.reason }; }
  const alertFile = path.join(evidence, 'alert.json');
  fs.writeFileSync(alertFile, `${JSON.stringify({
    severity: 'ERROR',
    title: `商品数据采集未完成（${date}）`,
    // 家数从计划里来，不写死：2026-09-30 起是「参与采集」的店铺数（12），
    // 而写死「五家」的旧文案在扩编之后就是一句假话 —— 收信人会按错误的家数去找缺口。
    targetLabel: `${date} ${shopCount === null ? '' : `${shopCount} 家`}店铺商品数据`,
    period: date,
    capability: '商品数据采集与导入',
    machine: os.hostname(),
    reason: `${failure?.class ?? 'FAILED'}/${failure?.reason ?? 'UNKNOWN'}：${failure?.message ?? '未知原因'}`,
    action: `打开 ${evidence} 看 job.log 与 collection.json，确认停在哪家店哪一段；证据齐了再决定是否重跑该日`,
    evidence: { runReceipt: path.join(evidence, 'run-receipt.json'), collection: path.join(evidence, 'collection.json'), jobLog: path.join(evidence, 'job.log') },
    createdAt: new Date().toISOString(),
    alertId,
    runId,
  }, null, 2)}\n`);
  const sent = await run('runtime/notify-feishu.mjs', ['--alert-file', alertFile], { capture: true });
  // 送成功时收据在 stdout；送失败时 CLI 把收据打到 stderr 并以非零退出码收场。
  const receipt = parseJsonOutput(sent.code === 0 ? sent.out : sent.err) ?? parseJsonOutput(sent.out) ?? { status: 'FAILED', error: (sent.err || sent.out || '').trim().slice(0, 300) };
  if (sent.code === 0 && receipt?.status === 'SENT') writeAlertThrottle({ alertId, fingerprint, sentAt: new Date().toISOString() });
  log(`告警投递：${receipt?.status ?? 'FAILED'}（exit ${sent.code}）`);
  return receipt;
}

// ---------------------------------------------------------------------------
// 跑前登录预检：**不是闸门**（2026-10-05 改）
// ---------------------------------------------------------------------------
//
// 与日报链同一约定 —— `runtime/batch-plan.mjs` 的 `buildLoginPreflightStep()` 写死
// `blocking: false`，`scripts/run-batches.mjs` 里那句原话是「守卫不是闸门」，
// `scripts/run-daily-job.mjs` 是 `if (command.blocking) chainStatus = status;`
// ⇒ 非阻塞步不进整轮退出码。理由（`runtime/daily-job-plan.mjs`）：
//   「链的第 0 步体检才是『今天能不能写』的权威判据。在这里截断只会让告警少一层信息；
//     而它自己判『读不到』时（冷启动后页面还没归位）更不该停。」
//
// 为什么这条链必须改（2026-10-05 真机实测，`evidence/product-data-job-2026-10-04/
// 2026-10-04-20261005141212788-7e3ec402/`）：第 1 批里**盖文天猫**的阿里妈妈页签不在位，
// 探针只能回 `loggedIn: null` ⇒ 该店 `UNKNOWN` ⇒ 预检退出码 3 ⇒ 旧代码 `throw`
// ⇒ **整批 5 家一步采集都没跑**。而事后只读复查：同一家店两个站点都是 `LOGGED_IN`
// —— 账号一直是好的，预检报的是「页签没就位」。
// 那个代价与日报链 2026-09-25 翻默认值时的实测同形（「停整轮 ⇒ 另外四家一步都没跑」）。
//
// 现在的分工：
//   · 退出码 **0/2/3 都不再中断**本批（`2`＝有店被实锤踢回登录页，`3`＝这一层没有结论）；
//   · 逐店按 `rows[]` 把 **verdict !== OK** 的店从**本批采集名单里剔除**，其余照采照导照释放；
//   · 剔除这件事**逐条记进 `gaps`**（点名店 + 后台），所以整轮**照旧退 1 并告警**，不静默降级；
//   · 读不到（UNREADABLE）而**没有任何店被实锤踢回登录页**时，先补一次页面再复查一次 ——
//     这就是日报链那句「链的第 0 步会先把页面补齐再体检」。只补一次，不循环。
//
// 唯一的 fail-closed：`rows` 解析不出来（子进程没起来、输出不是 JSON）⇒ 无法归因 ⇒ 仍然停手。
// 那一条不能放宽 —— 非阻塞的前提是「结论确实读到了」。
const SITE_LABELS = Object.fromEntries(Object.entries(SITES).map(([key, site]) => [key, site.label]));
const siteLabel = (key) => SITE_LABELS[key] ?? String(key);

/** 一行回执 → 给人看的一句话（只点后台名，不抄整段 detail）。 */
function describeLoginRow(row) {
  const kicked = Array.isArray(row?.needsLogin) ? row.needsLogin : [];
  const unread = Array.isArray(row?.unreadable) ? row.unreadable : [];
  const parts = [];
  if (kicked.length) parts.push(`掉登录=${kicked.map(siteLabel).join('、')}`);
  if (unread.length) parts.push(`读不到=${unread.map(siteLabel).join('、')}`);
  return parts.length ? parts.join('；') : `verdict=${row?.verdict ?? '未知'}`;
}

/** 逐店回执 → 「本批先不采的店」表。**只有 `OK` 才算通过**（`UNKNOWN` 是没结论，不是通过）。 */
function blockedShopsFrom(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const blocked = new Map();
  for (const row of rows) {
    if (!row?.shop || row.verdict === 'OK') continue;
    blocked.set(row.shop, `未通过（${describeLoginRow(row)}）`);
  }
  return blocked;
}

/**
 * 该不该「先补页再复查」。
 *
 * 判据要**两个条件同时成立**（与 `login-merchant.mjs` 里 PAGES_ABSENT 那道闸同源）：
 *   ① 有站点读不到（`unreadable` 非空）；
 *   ② **没有任何店被实锤踢回登录页**（`needsLogin` 全空）。
 * 第 ② 条是关键：真的有店被踢回登录页时补页没用、也不该拿补页去掩盖它。
 */
function shouldRepairPages(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  if (!rows.length) return false;
  const anyKickedOut = rows.some((row) => (row?.needsLogin?.length ?? 0) > 0);
  const anyUnreadable = rows.some((row) => (row?.unreadable?.length ?? 0) > 0);
  return anyUnreadable && !anyKickedOut;
}

/** 给本批每一家补页（走 `page-normalize.mjs` 的现成实现，不带第二份补页逻辑）。 */
async function repairBatchPages({ shops, log }) {
  const expected = expectedPagesForShop();
  for (const shop of shops) {
    try {
      const result = await normalizePages({ proxyPort: shopInstance(shop).proxyPort, expected });
      // 结论在 `verdict` 里（`normalizePages` 返回 `{before, after, actions, verdict}`）——
      // 2026-10-05 第一次接的时候读的是 `result.detail`（顶层没有这个键），日志打出一串
      // 「补页 X：undefined」。**日志打 undefined 比不打更坏**：它看起来像「补页成功了、只是没写说明」。
      log(`[登录] 补页 ${shop}：${result?.verdict?.detail ?? '未返回结论'}`);
    } catch (error) {
      // 补页失败不抛：它是**尽力而为**的自愈，成不成由复查那一次说了算。
      log(`[登录] 补页 ${shop} 失败：${String(error?.message ?? error)}`);
    }
  }
}

/**
 * 跑一次登录预检；必要时补页后复查一次。返回最终那一次的 `{code, out, report}`。
 *
 * **复查那一遍刻意不带 `--login`**（2026-10-05 真机教训，见下面那段注释）：
 * 补页解决的是「页签不在」，不是「凭据不对」；再跑一遍自动登录会在同一个窗口里
 * 再开一次淘宝登录页、再试一遍候选地址 —— 实测后果是页签**翻倍**（用户看到「打开了好几个页面」），
 * 而且同一个出口 IP 上连着提交两次正是登录守卫自己警告过的事。
 */
async function runBatchLogin({ shops, shopArg, loginFile, log }) {
  const attempt = async ({ autoLogin }) => {
    const flags = autoLogin ? ['--shops', shopArg, '--json', '--login'] : ['--shops', shopArg, '--json'];
    const result = await run(PRODUCT_JOB_FILES.login, flags, { capture: true });
    return { ...result, report: parseJsonOutput(result.out) };
  };
  let result = await attempt({ autoLogin: true });
  fs.writeFileSync(loginFile, result.out);
  if (result.code !== 0 && shouldRepairPages(result.report)) {
    // 第一次那份也落盘：它是「为什么触发补页」的唯一依据，复查会把它盖掉。
    fs.writeFileSync(loginFile.replace(/\.json$/u, '-initial.json'), result.out);
    log(`[登录] 预检退出码 ${result.code}：有站点读不到、且没有店被踢回登录页 ⇒ 先补页再复查一次（复查只读，不再登）`);
    await repairBatchPages({ shops, log });
    result = await attempt({ autoLogin: false });
    fs.writeFileSync(loginFile, result.out);
  }
  return result;
}

/**
 * 一轮（＝一家或一批店铺）的完整工作：起这批 → 查这批登录 → 采三类 → 导入三类。
 *
 * **释放不在这里**，而且这是刻意的：分批存在的理由就是「这一批跑完立刻放掉、把内存让给下一批」，
 * 释放的时机与「这一轮跑完成没成」是两件事。所以收尾（释放）留在 `main` 里 ——
 * 不分批时它只有一次（与从前逐字相同），分批时它每批一次。
 *
 * 出错**不往外抛**，而是把结论装在返回值里：调用方无论成败都要释放这一批，
 * 且「这一批挂了」不该让前面已经采到的几家从 `collection.json` 里消失。
 */
async function runRound({ round, rounds, batched, evidence, date, options, log, receipt }) {
  const shops = round.shops;
  const tag = batched ? `b${round.index}` : null;
  const shopArg = shops.join(',');
  const results = shops.map((shop) => ({ shop }));
  const gaps = [];
  const outcome = { round, results, gaps, failure: null, failedStage: null };
  const collectionFile = path.join(evidence, tag ? `collection-${tag}.json` : 'collection.json');
  const loginFile = path.join(evidence, tag ? batchLoginArtifactName(round.index) : 'login-preflight.json');
  try {
    log(`--- ${batched ? `${describeBatch(round, rounds.length)}；` : ''}${shops.length} 家：${shops.join('、')}`);
    const started = await run(PRODUCT_JOB_FILES.start, ['--only', shopArg]); if (started.code !== 0) throw new Error(`浏览器启动失败（${started.code}）`);
    // 起完立刻回读**本批每一家**的视口，读数不论达不达标都落盘（`viewport.json` / `viewport-b<N>.json`）——
    // 达标时它是「这一轮的窗口多大」的可核对现场，不达标时它是那句判红的依据。
    // 判据与阈值只有一处实现（`runtime/shop-viewport-gate.mjs`），这里不许再写一份。
    const viewport = await checkShopViewports({ shops });
    fs.writeFileSync(path.join(evidence, tag ? `viewport-${tag}.json` : 'viewport.json'), `${JSON.stringify(viewport, null, 2)}\n`);
    if (!viewport.ok) throw new Error(`浏览器视口不达标（${describeViewportFailure(viewport)}），已停止采集`);
    log(`视口回读通过：${viewport.entries.map((entry) => `${entry.shop}=${entry.width}x${entry.height}`).join('、')}`);
    const login = await runBatchLogin({ shops, shopArg, loginFile, log });
    // 拿不到逐店结论就没法归因 ⇒ **这一条是唯一的 fail-closed**（理由见上面 runBatchLogin 那段）。
    // 退出码非 0 但 `rows` 读得出来时**不中断**：逐店剔除，其余照跑。
    if (login.code !== 0 && !Array.isArray(login.report?.rows)) {
      throw new Error(`登录预检未通过（${login.code}）且没有可归因的逐店结论，已停止采集`);
    }
    const blocked = blockedShopsFrom(login.report);
    for (const [shop, reason] of blocked) gaps.push(`${shop}/登录 ${reason}`);
    if (blocked.size) {
      log(`[登录] 预检退出码 ${login.code}：${blocked.size} 家先不采（${[...blocked.entries()].map(([shop, reason]) => `${shop} ${reason}`).join('；')}），`
        + `本批其余 ${results.length - blocked.size} 家照常采集`);
    }
    // 采集脚本一律**用它们自己的默认下载目录**（`%USERPROFILE%\Downloads`）—— 那是浏览器真的会写进去的地方，
    // 由 profile 的 `download.default_directory` 决定，脚本侧改不了。别再传 `--downloads <证据目录>`：
    // 上一版就是这么传的，结果是「下载其实成功了、采集脚本盯错目录」⇒ 五家全部报「下载超时」。
    // 阶段一：商品底单 —— **必须串行**（不是偷懒，是判据）。
    // 五个店铺浏览器共用同一个真实下载目录，而 SYCM 导出的文件名里**不含店铺标识**
    // （`【生意参谋平台】商品_全部_<日>_<日>.xls`）。并行点击时每个进程都在取「目录里新出现的那份」，
    // 两家会抢到同一份文件、把别家的商品写进自己店铺的底单 —— 静默串数据，比直接失败更糟。
    // 串行之后，每家的 before 快照已经包含前面几家的产物，只可能取到自己那一份。
    // （阶段二不必串行：询单走显式 `--out`，脚本自己把内容写进指定路径；推广按任务名唯一匹配
    //   `商品报表_YYYYMMDD_HHMMSS`，含时间戳、跨店不重复。）
    for (const item of results) {
      const shop = item.shop;
      // 登录预检点名先不采的店：**在这里就退出采集循环**，而不是让它去跑一遍注定失败、
      // 还会把共享下载目录搅乱的采集（五家共用一个真实下载目录，见下面那段注释）。
      // 它的缺口已经在上面记过 `登录 未通过`，这里不重复记，也不进阶段二。
      if (blocked.has(shop)) { item.stoppedAt = 'login'; continue; }
      ensureDir(path.join(evidence, shop));
      const product = await run(PRODUCT_JOB_FILES.productCollect, ['--shop', shop, '--date', date], { capture: true });
      item.product = product; item.productFile = jsonTail(product.out)?.file ?? null;
      if (product.code !== 0 || !item.productFile) { item.stoppedAt = 'product-collect'; item.error = (product.err || product.out || '').trim(); log(`[底单] ${shop} 失败：${item.error || '未返回文件'}（exit ${product.code}）`); }
      else log(`[底单] ${shop} 已采集 ${item.productFile}`);
    }
    markStage(receipt, 'product', results.every((item) => item.productFile) ? 'COMPLETED' : 'FAILED');
    // 阶段二：询单 + 推广 —— 也串行，理由与阶段一同源：推广的任务名只精确到秒
    // （`商品报表_YYYYMMDD_HHMMSS`），五家在同一秒提交会拿到**同名任务** ⇒ ZIP 文件名相同、
    // 只差 ` (n)` 后缀，并行时各家会在共享下载目录里抢到别人的 ZIP（静默串数据）。
    // 询单本身写显式 `--out`、不受共享目录影响，它在这条循环里跟着走，代价只有几秒。
    for (const item of results.filter((entry) => entry.productFile)) {
      const shop = item.shop; const inst = shopInstance(shop); const dir = path.join(evidence, shop);
      const inquiryFile = path.join(dir, 'inquiry.xls'); const inquiry = await run(PRODUCT_JOB_FILES.inquiryCollect, ['--proxy', `http://127.0.0.1:${inst.proxyPort}`, '--shop', shop, '--date', date, '--out', inquiryFile], { capture: true });
      item.inquiry = inquiry; item.inquiryFile = inquiryFile;
      if (inquiry.code !== 0 || !fs.existsSync(inquiryFile)) { item.stoppedAt = 'inquiry-collect'; item.error = (inquiry.err || inquiry.out || '').trim(); log(`[询单] ${shop} 失败：${item.error || '未落盘'}（exit ${inquiry.code}）`); continue; }
      log(`[询单] ${shop} 已落盘 ${inquiryFile}`);
      // 推广段：`--skip-promotion` 时**整段不跑**（连采集脚本都不起）—— 理由见 product-data-job-core
      // 的 `SKIP_PROMOTION_REASON`：它的导入目标还指向 9 月的 base，跑一次就是把 10 月数据写进关账的表。
      if (options.skipPromotion) continue;
      const promotion = await run(PRODUCT_JOB_FILES.promotionCollect, ['--shop', shop, '--date', date], { capture: true });
      item.promotion = promotion; item.promotionFile = jsonTail(promotion.out)?.file ?? null;
      if (promotion.code !== 0 || !item.promotionFile) { item.stoppedAt = 'promotion-collect'; item.error = (promotion.err || promotion.out || '').trim(); log(`[推广] ${shop} 失败：${item.error || '未返回文件'}（exit ${promotion.code}）`); }
      else log(`[推广] ${shop} 已采集 ${item.promotionFile}`);
    }
    // 这一批的采集快照**先落盘再导入**：导入段崩了也要留下「采到了什么」。
    fs.writeFileSync(collectionFile, JSON.stringify(results, null, 2));
    // 导入阶段：**逐店独立推进** —— 一家失败不再把另外几家已经采好的数据一起丢掉。
    // 为什么改（2026-09-27 实测三次）：旧版是「先把五家三段全验一遍，任一处不合格就 throw」，
    // 于是「底单 5/5、询单 5/5、推广 4/5」这样的一轮，飞书一个字都没写、整晚白跑。
    // 导入本身按 `统计日期+店铺+商品ID` 去重（09-25 审计：重跑新增 0 行）⇒ 先写没有副作用。
    // **成功口径不变**：任何一家/一段没采到或没导成，整轮照样以失败收场（退出码 1 + 告警），
    // 逐条缺口写进 `gaps`，不静默降级。
    const common = options.commit ? ['--apply'] : [];
    for (const item of results) {
      // 登录预检剔掉的店在采集段已经记过缺口，这里不再记「底单/询单 未采集」——
      // 同一件事记两条会让收据里的缺口数虚高，归因也会被带到 `product-import` 上（它其实停在登录）。
      if (blocked.has(item.shop)) continue;
      if (!item.productFile) { gaps.push(`${item.shop}/底单 未采集`); continue; }
      const r = await run(PRODUCT_JOB_FILES.productImport, ['--file', item.productFile, '--shop', item.shop, '--date', date, ...common, '--evidence', path.join(evidence, item.shop, 'product-import')]);
      if (r.code !== 0) { gaps.push(`${item.shop}/底单 导入失败`); log(`[导入] ${item.shop} 底单失败（exit ${r.code}）`); } else log(`[导入] ${item.shop} 底单已写入`);
      if (!item.inquiryFile || !fs.existsSync(item.inquiryFile)) gaps.push(`${item.shop}/询单 未采集`);
      else { const q = await run(PRODUCT_JOB_FILES.inquiryImport, ['--file', item.inquiryFile, '--date', date, '--shop', item.shop, ...common, '--evidence', path.join(evidence, item.shop, 'inquiry-import')]); if (q.code !== 0) { gaps.push(`${item.shop}/询单 导入失败`); log(`[导入] ${item.shop} 询单失败（exit ${q.code}）`); } else log(`[导入] ${item.shop} 询单已写入`); }
      // 有意跳过的段**不记缺口** —— 与下面 catch 段那句逐字同口径。
      // （2026-10-05 修：这一行原先漏了 `skipPromotion`，于是 `--skip-promotion` 的那一轮
      //   即使收据里推广段已经正确记成 SKIPPED，整轮也会被自己这条缺口判成失败 ——
      //   实测形态见 evidence/product-data-job-2026-10-04/…/run-receipt.json 的「13 处」，
      //   其中 3 条就是「推广 未采集」。带 `--skip-promotion` 的定时入口默认就会撞上它。）
      if (!options.skipPromotion && !item.promotionFile) gaps.push(`${item.shop}/推广 未采集`);
    }
    // 推广：这一批齐时按小手册的形状做一次批量调用（收据落 `promotion-import/receipt.json`）；
    // 有人缺 ZIP 或批量失败时退成逐店导入（收据落 `promotion-import/<店>/`），把能写的先写掉。
    //
    // ⚠️ 未修的已知缺陷（2026-09-30 记录，**故意没动**）：下面那个批量调用把几家塞进**同一次**
    // CLI 调用，而该进程只建一个 FeishuClient（一个 base）、只读那一个 base 的既存记录做去重。
    // 商品数据已改成「按月 × 按部门」分 base（见 runtime/feishu-targets.mjs 的
    // PRODUCT_DATA_MONTH_BASES），所以只要一轮里出现**跨部门**的两家店，批量这条路必然让
    // 一半写进错的 base；拆开后去重集合也会跟着变。
    // 2026-09-30 给这条链加了分批（每批默认 5 家）**不改变这个缺陷的性质**（一批里仍可能跨部门），
    // 只是把「一轮几家」从 12 变成 5 —— 所以这一段仍然一行不改。
    // 用户 2026-09-30 原话「推广数据这个流程我还没开发，你先放着不管，先全部注意商品数据」
    // ⇒ 等推广链一起改造时把批量路径改成「按 (月,部门) 分组后各组一次调用」。
    // 底单与询单不受影响：它们是**逐店一次调用**（上面那个循环里），各自按自己的店铺解析 base。
    // `--skip-promotion`：**连导入都不做**。这里必须一起跳过 —— 只跳采集不跳导入的话，
    // `promoReady` 会是空数组而静默走完，看起来一样，但收据里就没有任何「有意跳过」的痕迹。
    if (options.skipPromotion) {
      log(`[导入] 推广段有意跳过：${SKIP_PROMOTION_REASON}`);
    } else {
      const importPromotionPerShop = async (items) => { for (const item of items) { const r = await run(PRODUCT_JOB_FILES.promotionImport, ['--file', item.promotionFile, '--shop', item.shop, ...common, '--evidence', path.join(evidence, 'promotion-import', item.shop)]); if (r.code !== 0) { gaps.push(`${item.shop}/推广 导入失败`); log(`[导入] ${item.shop} 推广失败（exit ${r.code}）`); } else log(`[导入] ${item.shop} 推广已写入`); } };
      const promoReady = results.filter((item) => item.promotionFile);
      if (promoReady.length === results.length) {
        const promotionArgs = promoReady.flatMap((item) => ['--file', item.promotionFile, '--shop', item.shop]);
        const promo = await run(PRODUCT_JOB_FILES.promotionImport, [...promotionArgs, ...common, '--evidence', path.join(evidence, 'promotion-import')]);
        if (promo.code === 0) log(`[导入] 推广 ${promoReady.length} 家已批量写入`);
        else { gaps.push('推广 批量导入失败'); await importPromotionPerShop(promoReady); }
      } else if (promoReady.length) {
        log(`[导入] 推广有 ${results.length - promoReady.length} 家未采到，改为逐店导入已采到的 ${promoReady.length} 家`);
        await importPromotionPerShop(promoReady);
      }
    }
    markStage(receipt, 'inquiry', results.every((item) => item.inquiryFile && fs.existsSync(item.inquiryFile)) ? 'COMPLETED' : 'FAILED');
    // 有意跳过 ≠ 失败，也 ≠ 没轮到：收据里必须能一眼分出这三件事，否则「跑成功但少了推广」
    // 会被读成「推广还没轮到」，下一次重跑也不会有任何提示。
    markStage(receipt, 'promotion', options.skipPromotion
      ? 'SKIPPED'
      : (results.every((item) => item.promotionFile) ? 'COMPLETED' : 'FAILED'));
  } catch (error) {
    outcome.failure = classifyWorkflowError(error);
    outcome.failedStage = stageFromMessage(error.message);
    // 「这一批在采集之前就挂了」（起不来 / 登录预检没过）时，上面那个导入循环**根本没跑**
    // ⇒ 缺口一条都没记 ⇒ 整轮会被判成成功（整批没采到却退 0，正是本仓反复在治的假绿）。
    // 所以这里按「实到手的东西」补记缺口；用 addGap 去重，避免与导入段已经记过的重复。
    const addGap = (gap) => { if (!gaps.includes(gap)) gaps.push(gap); };
    for (const item of results) {
      if (!item.productFile) addGap(`${item.shop}/底单 未采集`);
      if (!item.inquiryFile || !fs.existsSync(item.inquiryFile)) addGap(`${item.shop}/询单 未采集`);
      // 有意跳过的段**不记缺口** —— 否则整轮会被自己的闸门判成失败，而闸门是配置、不是故障。
      if (!options.skipPromotion && !item.promotionFile) addGap(`${item.shop}/推广 未采集`);
    }
    log(`${batched ? `[批次] ${describeBatch(round, rounds.length)} ` : ''}未完成：${error.message}`
      + `（${outcome.failure.class}/${outcome.failure.reason}；停在哪一段=${outcome.failedStage ?? '未知'}）`);
  }
  return outcome;
}

async function main(argv) {
  let options; try { options = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (options.help) { console.log('node scripts/run-product-data-job.mjs [--date yesterday] [--shops a,b] [--commit] [--notify] [--batches N] [--skip-promotion]'); return 0; }
  const date = resolveTargetDate(options.date); const plan = buildProductJobPlan({ dateInput: options.date, shops: options.shops, commit: options.commit, skipPromotion: options.skipPromotion });
  const runId = `${date}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
  const evidence = path.join(ROOT, 'evidence', `product-data-job-${date}`, runId); ensureDir(evidence);
  const receiptPath = path.join(evidence, 'run-receipt.json');
  const receipt = createWorkflowReceipt({ workflow: 'product-data', runId, date, shops: plan.shops, stages: plan.reportOrder.map((name) => ({ name, status: 'PENDING' })) });
  const logPath = path.join(evidence, 'job.log'); const log = (line) => { const text = `[${new Date().toISOString()}] ${line}\n`; fs.appendFileSync(logPath, text); process.stdout.write(text); };
  // 分批计划：切法**唯一**来自 `runtime/batch-plan.mjs`（与日报链同一层）。
  // 不给 `--batches` 时 `rounds` 就是「一整轮」⇒ 一条命令、起齐、最后释放一次，与从前逐字相同。
  const batched = options.batches !== null;
  const rounds = batched
    ? planBatches({ shops: plan.shops, size: options.batches }).batches
    : [{ index: 1, shops: plan.shops }];
  let status = 0; let lock = null; let failure = null; let failedStage = null;
  const allResults = []; const gaps = [];
  const releasedTags = [];
  const logLine = `${options.date} → ${date}；${plan.shops.length} 店；`
    + (batched ? `分 ${rounds.length} 批（每批最多 ${options.batches} 家，**每批跑完立刻释放**）` : '一次全起、结束统一释放');
  try {
    lock = acquireWorkflowLock(WORKFLOW_LOCK_NAME, 'product-data', { directory: path.join(ROOT, 'runtime', '.workflow-locks') });
    if (lock.staleReclaimed) log(`回收过期锁：原持有者=${lock.reclaimedFrom?.owner ?? '未知'}、pid=${lock.reclaimedFrom?.pid ?? '未知'}（该进程已不在）`);
    writeWorkflowReceipt(receiptPath, receipt);
    const preflight = runEnvironmentPreflight({ root: ROOT, workflow: 'product-data' });
    fs.writeFileSync(path.join(evidence, 'environment-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
    if (!preflight.ok) throw new Error(`环境预检失败：${preflight.checks.filter(check => !check.ok).map(check => check.name).join(', ')}`);
    log(`商品数据自动采集开始：${logLine}；底单串行、询单/推广并行；模式 ${options.commit ? 'commit' : 'dry-run'}`
      + (options.skipPromotion ? `；**推广段有意跳过**（${SKIP_PROMOTION_REASON}）` : ''));

    for (const round of rounds) {
      const outcome = await runRound({ round, rounds, batched, evidence, date, options, log, receipt });
      allResults.push(...outcome.results);
      gaps.push(...outcome.gaps);
      failure = failure ?? outcome.failure;
      failedStage = failedStage ?? outcome.failedStage;
      // **这一批的释放**（**只在分批形态**）：不管成没成都放 —— 分批存在的理由就是把内存让给下一批。
      // 不分批时释放**不在这里**，而是收尾那一段的 `finally`（与从前逐字相同：一次运行、一次释放）。
      // 两处都放会变成「释放两次」，而第二次面对的是一个已经空掉的目标 —— 它的退出码不再说明任何事。
      if (!batched) continue;
      // 释放判据不能只看退出码：既有的释放路径出过「假绿」（见 AGENTS.md），
      // 这里再要求收据别自称没释放。
      const tag = `b${round.index}`;
      const shopArg = round.shops.join(',');
      const released = await run(PRODUCT_JOB_FILES.release, ['--shops', shopArg], { capture: true });
      const releasePath = path.join(evidence, `release-${tag}.json`);
      fs.writeFileSync(releasePath, released.out || released.err);
      const releaseReceipt = parseJsonOutput(released.out) ?? parseJsonOutput(released.err);
      if (released.code !== 0 || releaseReceipt?.released === false) {
        status = 1; failure = failure ?? { class: 'FAILED', reason: 'RELEASE_FAILED', message: 'browser release failed' }; failedStage = failedStage ?? 'release';
        log(`浏览器释放未确认（${shopArg}；exit ${released.code}${releaseReceipt?.released === false ? '、released=false' : ''}）`);
      } else { releasedTags.push(shopArg); log(`浏览器已释放并完成端口二次回读（${shopArg}）`); }
    }

    // 分批时另写一份**全轮聚合**的 collection.json：读证据的人只看这一个文件也不该漏家。
    // （不分批时 `runRound` 写的那份就是全量，不再重复写 —— 「打印的与执行的一致」同理。）
    if (batched) fs.writeFileSync(path.join(evidence, 'collection.json'), JSON.stringify(allResults, null, 2));
    writeWorkflowReceipt(receiptPath, receipt);
    markStage(receipt, 'product', gaps.some((gap) => gap.includes('底单')) ? 'FAILED' : 'COMPLETED');
    markStage(receipt, 'inquiry', gaps.some((gap) => gap.includes('询单')) ? 'FAILED' : 'COMPLETED');
    markStage(receipt, 'promotion', options.skipPromotion
      ? 'SKIPPED'
      : (gaps.some((gap) => gap.includes('推广')) ? 'FAILED' : 'COMPLETED'));
    if (gaps.length) {
      // 缺口归因：登录 → 底单 → 询单 → 推广。登录排第一是因为它最先发生：
      // 被预检剔掉的店根本不会有采集缺口之外的记录，归到 `product-import` 会把人指到错的地方去。
      // 跳过推广时最后一档**不可能**出现（有意跳过不记缺口），
      // 真出现说明有人往 gaps 里塞了新东西 ⇒ 报 unknown 比错报成「推广导入」更诚实。
      failedStage = gaps.some((gap) => gap.includes('登录')) ? 'login'
        : gaps.some((gap) => gap.includes('底单')) ? 'product-import'
        : gaps.some((gap) => gap.includes('询单')) ? 'inquiry-import'
          : (options.skipPromotion ? 'unknown' : 'promotion-import');
      throw new Error(`本轮不完整（${gaps.length} 处）：${gaps.join('；')}`);
    }
    if (failure) throw new Error(`有批次未完成：${failure.message ?? failure.reason}`);
    log('商品三类数据采集与导入完成');
  } catch (error) { status = 1; failure = classifyWorkflowError(error); failedStage = failedStage ?? stageFromMessage(error.message); if (failedStage && receipt.stages.some((stage) => stage.name === failedStage)) markStage(receipt, failedStage, 'FAILED'); log(`失败：${error.message}（${failure.class}/${failure.reason}；停在哪一段=${failedStage ?? '未知'}）`); } finally {
    // 不分批时释放发生在**这里**（与从前逐字相同）；分批时每批的释放已经在上面的循环里做过。
    if (lock && !batched) {
      const released = await run(PRODUCT_JOB_FILES.release, ['--shops', plan.shops.join(',')], { capture: true });
      fs.writeFileSync(path.join(evidence, 'release.json'), released.out || released.err);
      // 不能只看退出码：既有的释放路径出过「假绿」（见 AGENTS.md）。这里再要求收据别自称没释放。
      const releaseReceipt = parseJsonOutput(released.out) ?? parseJsonOutput(released.err);
      if (released.code !== 0 || releaseReceipt?.released === false) { status = 1; failure = failure ?? { class: 'FAILED', reason: 'RELEASE_FAILED', message: 'browser release failed' }; failedStage = failedStage ?? 'release'; log(`浏览器释放未确认（exit ${released.code}${releaseReceipt?.released === false ? '、released=false' : ''}）`); }
      else log('浏览器已释放并完成端口二次回读');
    } else if (lock && !releasedTags.length) log('分批形态：没有批次跑到释放这一步（未起任何实例）');
    if (lock) lock.release();
    else log('未获得运行锁，跳过浏览器释放以保护其他流程');
    receipt.status = status === 0 ? 'COMPLETED' : 'FAILED';
    receipt.failure = failure; receipt.failedStage = failedStage; receipt.finishedAt = new Date().toISOString();
    writeWorkflowReceipt(receiptPath, receipt);
    if (options.notify && status !== 0) { try { await notifyFailure({ date, runId, evidence, failure, failedStage, log, shopCount: plan.shops.length }); } catch (error) { log(`告警投递自身出错：${error.message}`); } }
  }
  log(`商品数据自动采集结束：退出码 ${status}`); return status;
}
if (pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
export { main, parseArgs };
// 登录预检的三个纯函数导出**只为离线用例**（守卫 `runtime/product-data-login-preflight-wiring.test.mjs`）：
// 「哪几家被剔除」「要不要先补页」这两条判断的错法都是**静默**的（剔除多了少采一家、
// 剔除少了白跑一家，两种都不会报错），所以它们必须有一条离线判据钉住，而不是只靠真机。
export { blockedShopsFrom, describeLoginRow, shouldRepairPages };
