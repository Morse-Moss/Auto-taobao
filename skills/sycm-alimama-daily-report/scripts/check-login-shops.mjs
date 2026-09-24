#!/usr/bin/env node

// 逐店登录态体检 / 跑前登录守卫 —— 五家店 × 两个后台，一家店一个隔离实例。
//
// 两种模式，**同一份判定逻辑、同一份登记表**，差别只在子进程带哪个开关：
//   （默认，不带 `--login`）**只读体检**：子进程走 `--check-only`，一个页面都不碰。
//   （带 `--login`）**跑前登录守卫**：子进程走 `--commit` —— 掉登录的当场自己登一次，
//     没成才把「要人做什么」报出来，并在**确定需要人**时发一条飞书（整轮汇总，见下面纪律 3）
//     （2026-09-23 按用户明确授权加，原话「可以自动登录把项目规则改了」）。
//   ⚠️ 带 `--login` 时这一条**不再是只读**：它会**先归位页面**（缺的先领回、确认没有的才新建），
//      再开登录页、补一次可信手势、提交表单 ⇒ 它同时成了一个**写入方与投递方**（页面 + 登录 + 告警）。
//      所以它只在「确实想让机器去登」的调用点带这个开关（定时链与分批驱动），
//      人工排查时想只看一眼就不要带。
//
// 第 0 步（2026-09-24 加，**只在 `--login` 档**）：先归位五家店的页面，再体检。
//   理由：体检只有一条判据 ——「读这个站点页面的最终地址」。窗口里根本没有那一页时它只能报
//   「读不到」，而这一档此前会因为「读不到」去开登录页 ⇒ 被仍然有效的主站会话直接送走
//   ⇒ 报 `MAIN_SESSION_ONLY`（一条「要人处理」的结论）⇒ 一次预检并发 5 条假红告警。
//   归位把这个前提修好：页面先补齐，体检才读得到**真实**的登录态。
//
// 为什么需要它（2026-09-23 建）：整条日报链没有一步看登录态（见 check-login-shops-core.mjs
// 的头部）。掉登录不会被提前发现，只会在采集阶段炸成一句「没跑完，但记录里没写停在哪一步」。
// 这一条命令把「哪家店的哪一个后台掉登录了、该用哪个账号登」在**开跑之前**说清楚。
//
// 它自己**不做探测**：探测全在 `login-merchant.mjs --check-only` 里（那一条已经实测过，
// 见 evidence/cold-start-rehearsal-2026-09-23/07）。本脚本只负责按登记表逐店调用它、
// 把回执翻成人话。所以这一条链上**没有第二份**「未登录 URL 长什么样」的判据。
//
// 三条纪律：
//   1. **切实例只能靠 `--proxy`**。`--shop` 只影响回执里的店名，不切浏览器；
//      2026-09-22 的一版探针把两者搞反了，五次体检其实都打在同一个实例上
//      （证据：全仓唯一那份「四份输出逐字相同」的假测）。端口从 runtime/browser-ports.mjs 取。
//   2. **不带 `--login` 时一个页面都不碰**：`--check-only` 让 login-merchant 在读完登录态之后
//      就返回，不会去 `/new` 那个淘宝登录页（不带这个开关时它会 —— 那是自动登录的第一步）。
//      带上 `--login` 就是**故意要它去登**，那时上面这句不成立，别拿它当只读用。
//   3. **告警与「有没有真的去登」绑在一起，而且整轮只叫一次**（绑定是 2026-09-23 用户拍板；
//      2026-09-24 改成整轮一条）。用户原话：「如果自动登录失败就飞书告警，但是前提是你要先自动登录」。
//      两个条件缺一不可：**① 真的去登过（`--login`）② 确定有店要人**。
//        · 只读档 ⇒ 一个字都不发（那一轮没有任何登录发生过，为一件没做的事叫人是骚扰）。
//        · `--login` 档 ⇒ 判定用 `shouldNotifyRound`（纯函数）、构造用 `buildRoundLoginAlert`、
//          投递与去重在 `deliverRoundAlert`；去重状态与日报链**共用同一个文件**
//          （`runtime/alert-throttle.json`，判据在 `runtime/alert-throttle.mjs`）。
//      2026-09-24 之前是「每店一个子进程各自发」（子进程拿 `notifyModeFor()` 给的 `auto`），
//      后果实测过两次：一次并发 5 条同一天的告警，其中一次**5 条全是假红**
//      （页面还没归位，却被报成「主站会话还在、后台要单独登」）。
//      病根是两层判定不一致（本层算出 `needHuman=[]`，子进程却发）＋ 这条路径根本没有去重。
//      现在的分工：**子进程一律闭嘴（`notifyModeFor()` 恒 `off`），投递权只在这一层**。
//      链那一条照旧：链失败时自己发一条，文案里点名「哪个店哪个后台掉登录」（编号 `daily-round-<日>`）。
//
// 刻意**不查**商家浏览器（dailyReport，19022/19023）：它用的是同一批账号，
// 而它的两个页面（生意参谋 + 飞书底单页）与五家店的采集无关 —— 它掉了登录会在
// 日报那一侧的失败里直接露出来。这一层只覆盖「一店一实例」那五个。
//
// 用法：
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --shops 盖文淘宝,科塔淘宝
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --json
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --login     # 归位 → 掉了就自己登（会碰页面）
// 退出码：0＝全部确认在登录态；2＝有后台明确掉登录（带 `--login` 时＝自动登录也试过了、没成）；
//        3＝这一层没有结论（读不到/子进程失败）；
//        4＝参数或用法错（**刻意与上面三个分开**，免得把「打错字」读成「掉登录」）。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 跨轮告警去重（2026-09-24 接）：这条链此前**根本没有去重** —— 一次预检能并发 5 条同一天的告警，
// 而收信人只收到一片刷屏。判据与状态文件都与日报链共用同一份（runtime/alert-throttle.mjs）。
import { ALERT_THROTTLE_FILE, readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from '../../../runtime/alert-throttle.mjs';
import { SHOP_BROWSERS, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
import { renderAlertText } from '../../../runtime/notify-feishu-core.mjs';
// 开跑前归位（2026-09-24 接）：复用 `runtime/page-normalize.mjs` 的 normalizePages ——
// 它本来就是为「体检**之前**的归位」写的（文件头第一句），只是此前没接在这条命令前面。
// 页面清单与开页 URL 来自 `runtime/shop-pages.mjs`，**不另造第二份补页实现**：
// 「新建页面」这条写路径全仓只有 shop-pages.mjs 一处，别的地方只管调它。
import { normalizePages } from '../../../runtime/page-normalize.mjs';
import { assertCoverage, buildPagePlan, buildUrlByName } from '../../../runtime/shop-pages.mjs';
import {
  buildRoundLoginAlert, exitCodeForPreflight, judgePreflight, judgeShopReceipt, notifyModeFor,
  parseCheckShopsArgs, renderReport, shouldNotifyRound,
} from './check-login-shops-core.mjs';

const LOGIN_CLI = fileURLToPath(new URL('./login-merchant.mjs', import.meta.url));
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// 带 `--login` 时两店之间的静默期。20 秒是**工程选择，不是实测出来的最优值**：
// 它唯一要保证的是「同一个出口 IP 上不会出现同一秒的连续登录提交」。
// 要改小它之前先想清楚：那是在拿账号安全换轮次时间（见 main 里那段理由）。
const LOGIN_GAP_MS = 20000;

// ---------------------------------------------------------------------------
// 通知出口（IO 侧）：**整轮一条**
// ---------------------------------------------------------------------------
//
// 走既有的投递 CLI（`runtime/notify-feishu.mjs`），**不另造一条 HTTP**：那条链已经带着
// 「没送达必然非零退出码」的性质，自己再写一遍就多出一个「以为发了、其实没人收到」的形态。
// 判定（该不该发、发什么内容）全在 core 的 `shouldNotifyRound` / `buildRoundLoginAlert` 里。
const NOTIFY_CLI = fileURLToPath(new URL('../../../runtime/notify-feishu.mjs', import.meta.url));
const NOTIFY_TIMEOUT_MS = 30000;

function runNotifyCli(payload) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(process.execPath, [NOTIFY_CLI], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      done({ code: null, out: '', err: `spawn failed: ${String(error?.message ?? error)}`, timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => done({ code: null, out, err: String(error?.message ?? error), timedOut: false }));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      done({ code: null, out, err: `${err}\nnotify CLI 超时（${NOTIFY_TIMEOUT_MS}ms），已终止`, timedOut: true });
    }, NOTIFY_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut: false }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * 把整轮那一条告警送出去，并如实报「送没送到」。返回的收据喂给 `renderRoundNotifyLines`。
 *
 * 三条次序都是有讲究的（每一条都对应一种「以为发了」的形态）：
 *   ① **不管发不发，先把收信人会看到的完整文案打进日志** —— 技术串已经从业务消息里撤掉了，
 *      日志成了事后唯一能对上「他到底看到了什么」的地方；
 *   ② **先判去重、再投递**（去重按「同一个编号 + 同一个停的地方」；判据在公共模块里）；
 *   ③ **只有真的 SENT 才记时间**：送失败还记账，会让下一次重跑被自己的记录挡掉（静默漏报）。
 */
async function deliverRoundAlert({ alert, log, throttleFile = ALERT_THROTTLE_FILE, now = () => new Date() }) {
  log(`[告警] 文案（收信人看到的）：\n${renderAlertText(alert)}`);
  const verdict = resolveAlertDedup({
    previous: readAlertThrottleEntry({ file: throttleFile, alertId: alert.alertId }),
    alertId: alert.alertId,
    fingerprint: alert.fingerprint,
    now: now(),
  });
  if (!verdict.send) {
    log(`[告警] 这一条没往外发：${verdict.reason}`);
    return { status: 'DEDUPED', alertId: alert.alertId, reason: verdict.reason };
  }
  const result = await runNotifyCli(alert);
  let receipt = null;
  try { receipt = result.out ? JSON.parse(result.out) : null; } catch { receipt = null; }
  const status = receipt?.status ?? (result.code === 0 ? 'UNKNOWN' : 'FAILED');
  if (status === 'SENT') {
    writeAlertThrottle({ alertId: alert.alertId, fingerprint: alert.fingerprint, sentAt: new Date(now()).toISOString() }, throttleFile);
    log(`[告警] 已投递（编号 ${alert.alertId}）`);
    return { status, alertId: alert.alertId, receipt };
  }
  const error = String(result.err || result.out || '').trim().slice(0, 400) || '投递没给出结论';
  log(`[告警] 没送出去（${status}）：${error}`);
  return { status, alertId: alert.alertId, error, receipt };
}

// ---------------------------------------------------------------------------
// 开跑前归位（IO 侧）
// ---------------------------------------------------------------------------
/**
 * 把「五家店各自的期望页面」补齐到**恰好各一个**。
 *
 * 为什么必须在体检**之前**做（2026-09-24，用户拍板「1.改」）：体检只有一条判据 ——
 * 「读这个站点页面的最终地址」。窗口里根本没有那一页时它只能报「读不到」，而**会去登**的
 * 那一档此前会因为「读不到」去开登录页 ⇒ 被仍然有效的主站会话直接送走
 * ⇒ 报 `MAIN_SESSION_ONLY`（一条「要人处理」的结论）⇒ 一次预检并发 5 条假红告警。
 * 归位把那个前提修好：页面先补齐，体检才读得到真实登录态。
 *
 * 三条纪律（沿用 shop-pages / page-normalize，别在这里放宽）：
 *   ① 已经在位的不动；同主机多于一页**只报不猜**（关哪一个是人的决定）；
 *   ② 新建一律 `pinned=1`（不带它会在闲置 15 分钟后被代理回收）；
 *   ③ 认不出该领回哪一页时什么都不做，把结论交回调用方 —— 自愈不许变成乱导航。
 *
 * **失败不阻断**：这一层是自愈、不是闸门。归位没做成时体检照跑、结论照报
 * （那时「读不到」是真的读不到，链的第 0 步还会再补一次）。
 */
async function normalizeShopPages(shops, log) {
  const plan = buildPagePlan().filter((entry) => shops.includes(entry.key));
  const urlByName = buildUrlByName();
  assertCoverage(plan, urlByName);
  const results = [];
  for (const entry of plan) {
    try {
      const outcome = await normalizePages({ proxyPort: entry.proxyPort, expected: entry.expected, dry: false });
      const moved = outcome.actions.filter((action) => action.action !== 'already-one')
        .map((action) => `${action.page}:${action.action}`);
      results.push({ shop: entry.key, proxyPort: entry.proxyPort, ok: outcome.verdict.ok === true,
        changed: outcome.changed, detail: outcome.verdict.detail, actions: moved });
      log(`[归位] ${entry.key}（代理 ${entry.proxyPort}）：${outcome.verdict.detail}`
        + `${moved.length ? `　动作 ${moved.join(' ')}` : ''}`);
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      results.push({ shop: entry.key, proxyPort: entry.proxyPort, ok: false, error: message });
      log(`[归位] ${entry.key}（代理 ${entry.proxyPort}）：没做成 —— ${message}`);
    }
  }
  return { asked: true, shops: results };
}

/**
 * 跑一家店。**不抛错**：任何失败都翻成「这条回执读不出来」，
 * 由 core 判成 `UNREADABLE` —— 五家店里坏一家，不该让另外四家的结论一起消失。
 */
function probeShop(shop, timeoutMs, { login = false } = {}) {
  return new Promise((resolve) => {
    const conf = SHOP_BROWSERS[shop];
    if (!conf) { resolve({ receipt: null, error: `未登记的店铺实例「${shop}」`, exitCode: null }); return; }
    let child;
    try {
      child = spawn(process.execPath, [
        LOGIN_CLI,
        // 两种模式**只在这里分叉**，其余参数完全相同 —— 免得两份调用各自漂移，
        // 而漂移的症状是「自动登录打到了另一个实例上」这种看不出来的事。
        login ? '--commit' : '--check-only',
        '--proxy', `http://127.0.0.1:${conf.proxyPort}`,
        '--shop', shop,
        // 子进程**一律闭嘴**（2026-09-24 改）：告警整轮只由本层发一条（`deliverRoundAlert`），
        // 因为「哪几家要人」是一个**跨店**的问题，而每个子进程只看得到自己那一家。
        // 原先只读档 `off`、带 `--login` 档 `auto` ⇒ 每店各发一条，实测一次预检并发 5 条告警
        // （且那一批全是假红）。取值仍走 core 的 `notifyModeFor()`（纯函数、有用例钉住），
        // 不在 IO 里拼字符串 —— 拼字符串的话「哪一档该不该发」这件事就只活在 IO 里，离线测不到。
        '--notify', notifyModeFor(),
      ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ receipt: null, error: `spawn 失败：${String(error?.message ?? error)}`, exitCode: null });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      done({ receipt: null, error: `超时（${timeoutMs}ms），已终止这家店的体检`, exitCode: null });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); done({ receipt: null, error: String(error?.message ?? error), exitCode: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 回执是 JSON.stringify(receipt, null, 1) —— 从**最后一处行首的 `{`** 起就是它。
      const marker = out.indexOf('\n{');
      const raw = marker === -1
        ? (out.trimStart().startsWith('{') ? out.trimStart() : null)
        : out.slice(marker + 1);
      let receipt = null;
      try { receipt = raw === null ? null : JSON.parse(raw); } catch { receipt = null; }
      done({
        receipt,
        exitCode: code,
        error: receipt ? null : `${err.trim() || out.trim()}`.slice(-400) || '没有可解析的回执',
      });
    });
  });
}

async function main(argv) {
  const valid = shopBrowserKeys();
  let opts;
  try {
    opts = parseCheckShopsArgs(argv, { shops: valid });
  } catch (error) {
    console.error(`${error.message}`);
    return 4;
  }
  if (opts.help) {
    console.log('node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs'
      + ' [--shops a,b] [--json] [--timeout 180000] [--login]');
    console.log('  （默认）只读体检：不开页面、不点东西、不归位、也不发任何告警');
    console.log('  --login：跑前登录守卫 —— 先归位页面（缺的先领回、确认没有的才新建），'
      + '再对掉登录的当场用浏览器密码库登一次；仍需要人时发**一条**飞书（整轮汇总，'
      + '同一天同一轮只叫一次）');
    console.log(`  店名取登记表（runtime/browser-ports.mjs）：${valid.join(' / ')}`);
    return 0;
  }

  // 过程日志往哪走：`--json` 时 stdout 必须是**纯 JSON**（宿主 run-daily-job 要把它落成
  // `login-preflight.json` 再交给链）。把归位/告警的细节混进 stdout 会让那份文件不可解析 ——
  // 而链那侧读不出来时只会说「这一轮没有先查登录态」，静默得很。所以走 stderr：
  // 宿主两个流都收进同一份 job.log，人翻日志时一个字都不少。
  const log = (line) => { if (opts.json) console.error(line); else console.log(line); };

  const shops = opts.shops ?? valid;

  // 第 0 步（2026-09-24 加）：**只在会碰页面的那一档归位**。
  // 只读档必须保持「一个页面都不碰」的承诺（这是那一档存在的全部意义）。
  // 归位自己失败（代理没起、飞书配置读不到）**不阻断体检**：它是自愈，不是闸门。
  let normalize = { asked: false };
  if (opts.login) {
    try {
      normalize = await normalizeShopPages(shops, log);
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      log(`[归位] 这一步整体没能跑起来：${message}（体检照跑，链的第 0 步还会再补一次）`);
      normalize = { asked: true, shops: [], error: message };
    }
  }

  let probed;
  if (!opts.login) {
    // 只读模式下**并行**：一家店一个浏览器实例、一个代理，互不相干。串行的话五家店要等 5 倍的长。
    probed = await Promise.all(shops.map(async (shop) => ({ shop, ...(await probeShop(shop, opts.timeoutMs)) })));
  } else {
    // 带 `--login` 时**必须串行 + 留间隔**，这是本次改动里唯一一处「为了不惹风控而放慢」。
    // 理由（不是保守，是实测口径，见 docs/ops/LOGIN-RECOVERY-OPTIONS.md §3.5）：
    //   五家店同时提交登录＝在同一个出口 IP 上短时间内五次登录，正是风控最敏感的形态；
    //   最坏结果不是「跑失败」，而是**一批账号被保护性锁定**——那比掉登录贵得多。
    //   串行 + 固定间隔把这件事的形态改掉：同一时刻只有一个登录在途，且两次之间有静默期。
    probed = [];
    for (const shop of shops) {
      probed.push({ shop, ...(await probeShop(shop, opts.timeoutMs, { login: true })) });
      if (shop !== shops[shops.length - 1]) await new Promise((r) => setTimeout(r, LOGIN_GAP_MS));
    }
  }
  const rows = probed.map((item) => ({
    ...judgeShopReceipt({ shop: item.shop, receipt: item.receipt }),
    // 子进程自己的退出码与「没有回执」时的原因也留着：只报结论不报凭据，复核时无从下手。
    childExitCode: item.exitCode,
    probeError: item.error,
  }));
  const judged = judgePreflight(rows);

  // 告警：**整轮一条**（2026-09-24 改，原先是每店一个子进程各发一条）。
  // 判定在 core 的 `shouldNotifyRound`（真的去登过 + 确定有店要人），构造在 `buildRoundLoginAlert`，
  // 去重与投递在 `deliverRoundAlert`。三者都只有一个来源。
  let roundNotify = null;
  if (shouldNotifyRound({ login: opts.login, judged })) {
    try {
      roundNotify = await deliverRoundAlert({ alert: buildRoundLoginAlert({ rows, judged }), log });
    } catch (error) {
      // 「判定说该发、构造/投递却抛」这一支不该把整条体检一起带下去：
      // 如实记成 FAILED —— 收信人至少能从报告里看到「本该叫人而没叫成」，而不是什么都没有。
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
      log(`[告警] 没能把这条告警送出去：${message}`);
      roundNotify = { status: 'FAILED', error: message };
    }
  } else {
    roundNotify = {
      status: 'SKIPPED',
      reason: opts.login
        ? '这一轮没有「确定要人处理」的店（读不到不算要人；链的第 0 步会先补页面）'
        : '这一轮是只读体检，没有去登，所以一个字都不发',
    };
  }

  if (opts.json) {
    console.log(JSON.stringify({
      machine: os.hostname(), verdict: judged.verdict, autoLogin: opts.login, normalize, roundNotify, ...judged, rows,
    }, null, 1));
  } else {
    console.log(renderReport({ rows, machine: os.hostname(), autoLogin: opts.login, normalize, roundNotify }));
    for (const row of rows) {
      if (row.probeError) console.log(`    （${row.shop} 的这次体检没拿到回执：${row.probeError}）`);
    }
  }
  return exitCodeForPreflight(judged.verdict);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
