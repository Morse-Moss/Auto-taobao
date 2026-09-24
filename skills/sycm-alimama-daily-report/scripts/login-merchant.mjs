#!/usr/bin/env node

// 商家账号自动登录（生意参谋 / 阿里妈妈）。
//
// 为什么需要它：日报链的第一步就卡在「两个站点掉登录」，而登录只能人到机器上扫码/输密码。
// 2026-09-18 在真实账号上把三条判据实测出来了，这个脚本就是那一次的固化：
//
//   ① **跨站 iframe 里的登录表单，Chrome 不会自动填充；顶层表单才会。**
//      同一 profile、同一账号、同一时刻的对照：阿里妈妈页内嵌的
//      `login.taobao.com/member/login.jhtml?...style=mini` iframe 与生意参谋页的
//      `havanalogin.taobao.com/mini_login.htm` iframe 都填不进去（后者跨域，主文档连 input 都数不到）；
//      而顶层的 `login.taobao.com/havanaone/login/login.htm` 上，`#fm-login-id` 与
//      `#fm-login-password` 的 `matches(':autofill')` 为 true，截图能看见账号已画出、密码是点。
//   ② **「预览态 → 补一次可信手势 → 值落地」**：`:autofill` 在预览态和落地态都会是 true，
//      **不能拿它当判据**；判据是补一次真实鼠标点击之后回读 `value.length > 0`。
//   ③ **凭据来自浏览器自己的密码库，本脚本不接触明文**：`<profile>/Default/Login Data` 的 logins 表里
//      `https://login.taobao.com/member/login.jhtml` 与 `https://havanalogin.taobao.com/mini_login.htm`
//      各有一条（列名是 `password_value`）。脚本只驱动浏览器自己的填充，不读、不写、不传密码。
//
// fail-closed 的三处（踩过就明白为什么必须有）：
//   - 拿不到 `:autofill`（= 密码库里没有这份凭据）⇒ 报 NO_SAVED_CREDENTIAL 停下，**不去猜账号密码**；
//   - 图片验证码 / 滑块显形（rect 非零）⇒ 报 CAPTCHA_REQUIRED 停下，**不硬闯**（这是 SOP §10.2 的纪律）；
//   - 点了登录但页面没离开登录页 ⇒ 报 LOGIN_NOT_CONFIRMED，如实说没成，不假装成功。
//
// 需要人处理时会**发飞书提醒**（2026-09-18 接）：复用既有的三跳链
// `runtime/notify-feishu.mjs`，告警里写清「哪台机器、哪个浏览器配置、下一步做什么」。
// 口径是 `--notify auto`（默认）：**只有真的试过了**（带 --commit）且没成，才叫人 ——
// 不带 --commit 的只读排练撞到登录墙不惊动人。通知失败**不改变**登录结论与退出码。
//
// 用法：
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs                 # 只检测，不点任何东西
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --check-only    # 纯读：连登录页都不开
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --commit        # 真的走登录，失败会发飞书
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --target sycm   # 只处理其中一个站点
//   ... --notify dry                                                                  # 只渲染告警文案，不发
//   ... --notify off                                                                  # 彻底不发
//
// ⚠️ `--shop X` **必须配那家店自己的 `--proxy`**（2026-09-23 起强制，见 core 的 judgeShopTarget）：
//   `--proxy` 是唯一的实例选择器，`--shop` 只写店名。两者对不上时脚本**什么都不碰**就停 ——
//   2026-09-22 那次「五家体检其实都打在同一个实例上、还把那个共用浏览器登进了某个卖家号」
//   就是这么发生的，而当时的输出从文字上看不出来。
//     node .../login-merchant.mjs --commit --proxy http://127.0.0.1:19045 --shop 盖文天猫   ✅
//     node .../login-merchant.mjs --commit --shop 盖文天猫                                  ❌ 默认代理是商家浏览器，会停
//   只想看那个共用浏览器本身时**别给 `--shop`**（没给就不判，旧用法不变）。
//
// 说明：不带 --commit 时是**只读排练**（量坐标、回读状态、截图），可以用来判断「现在到底要不要登录」。
// 而 `--check-only` 比它更严：**一个页面都不碰**（不开登录页、不量坐标），代价是它只能回答
// 「在不在登录态」，不能接着往下走。多店逐店体检（`check-login-shops.mjs`）与定时链的
// 跑前那一步用的就是它。
//
// 2026-09-24 加：`--commit` 档在进登录流程**之前**会先判一次「窗口里到底有没有这两个后台的页面」
// （core 的 `absentSites`）。两个站点都读不到、且没有一个是实锤掉登录时，报 `PAGES_ABSENT`、
// 退出码 3、**不发任何告警** —— 那是「页面还没归位」，链的第 0 步会补上，不是登录故障。
// 加它的直接原因：冷启动后的跑前预检把这类现场报成了 `MAIN_SESSION_ONLY`，并连发 5 条飞书告警。
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_PROFILES, PROJECT_PORTS, SHOP_BROWSERS, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
// 判据与纯逻辑都在 core 里（可离线测）；这里只留 IO。
import {
  FORM_STATE_EXPRESSION, LOGIN_ID_VALUE_EXPRESSION, LOGIN_URL_CANDIDATES, SITES, absentSites, alertForRun,
  captchaVisible, centerOf, detectLoginDetour, expectedMemberFor, finalLoginVerdict, isTaobaoLoginUrl,
  judgeFilled, judgeShopTarget, loggedOutSites, loginFormVisible, needsHuman, parseArgs, sitesNeedingLogin,
} from './login-merchant-core.mjs';

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 通知出口：复用既有 CLI，不新造一条投递链（不另写一份 app_id/secret 的读法）。
const NOTIFY_CLI = fileURLToPath(new URL('../../../runtime/notify-feishu.mjs', import.meta.url));
const NOTIFY_TIMEOUT_MS = 30000;

async function proxyText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

async function evalOn(args, targetId, expression) {
  const payload = JSON.parse(await proxyText(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression }));
  return payload?.value;
}

async function listPages(args) {
  const list = JSON.parse(await proxyText(`${args.proxy}/targets`));
  return (Array.isArray(list) ? list : (list.targets ?? [])).filter((t) => t.type === 'page');
}

async function clickPoint(args, targetId, x, y) {
  return JSON.parse(await proxyText(`${args.proxy}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x, y }) }));
}

async function shot(args, targetId, name) {
  if (!args.shots) return null;
  const response = await fetch(`${args.proxy}/screenshot?target=${encodeURIComponent(targetId)}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(args.shots, { recursive: true });
  const file = path.join(args.shots, `${name}.png`);
  writeFileSync(file, buffer);
  return file;
}

// 表达式与坐标选取都来自 core（那份是离线测过的同一份）。
const FORM_STATE = FORM_STATE_EXPRESSION;

// 站点是否已经登录：导航到只有登录态才进得去的那一页，看最终 URL 有没有被踢回登录。
async function siteLoggedIn(args, site) {
  const pages = await listPages(args);
  const match = pages.filter((p) => String(p.url).includes(site.pageMatch));
  if (match.length !== 1) return { loggedIn: null, reason: `expected one ${site.label} page, got ${match.length}` };
  const targetId = match[0].targetId;
  await proxyText(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(site.probeUrl)}`)
    .catch(() => {});
  await delay(5000);
  const href = await evalOn(args, targetId, 'location.href');
  return { loggedIn: !site.loggedOut.test(String(href)), href, targetId };
}

// 打开（或复用）顶层淘宝登录页，并把它导航到**指定的那一条候选地址**。
//
// 与 2026-09-23 之前的差别：多收一个 `url`，且「已有登录页」的识别改用 core 的
// `isTaobaoLoginUrl`（结构判据，认两台主机）。两件事都是「逐条试候选」的前提：
//   · 识别口径放宽到两台主机 ⇒ 第二条候选开出来的页面也能被认成登录页（否则会再开一个，
//     一头撞上下面那个堆叠检查，第二条还没试就把流程卡死）；
//   · 复用时不新开页签、改成原地导航 ⇒ 五条候选也只有一个登录页签，
//     而且**不破坏 `--check-only` 那条「一个页面都不碰」的账**（这一函数只在 `--commit` 支被调到）。
async function ensureLoginPage(args, url) {
  const pages = await listPages(args);
  const existing = pages.filter((p) => isTaobaoLoginUrl(p.url));
  if (existing.length > 1) return { error: `堆了 ${existing.length} 个淘宝登录页，先去关到只剩一个` };
  if (existing.length === 1) {
    const targetId = existing[0].targetId;
    // 已经在目标地址上就不再导一次（多余导航会把「页面读到一半」变成常态）
    if (String(existing[0].url) === url) return { targetId, opened: false, navigated: false };
    await proxyText(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`).catch(() => {});
    await delay(4000);
    return { targetId, opened: false, navigated: true };
  }
  const created = JSON.parse(await proxyText(`${args.proxy}/new?url=${encodeURIComponent(url)}&label=taobao-login`));
  await delay(4000);
  return { targetId: created.targetId, opened: true, navigated: false };
}

// ---------------------------------------------------------------------------
// 飞书提醒（IO 侧）
// ---------------------------------------------------------------------------
//
// 「该不该发」在 core 的 shouldNotify / alertForRun 里（离线测过）；这里只负责把告警交给 CLI。
// 三条不许破的纪律：
//   1. 通知的结果**只写进 receipt.notify**，绝不改变 verdict 与退出码 ——
//      「通知失败」不能变成「这次登录失败」，也不能反过来把失败说成成功；
//   2. 凭据绝不进告警（core 那边的拼装只吃本脚本自己产出的说明文字）；
//   3. 有超时。CLI 卡住时不能把整个日报链一起挂住 —— 杀掉的是我们自己刚起的子进程。
function runNotifyCli(cliArgs, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(process.execPath, cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      done({ code: null, out, err: `${err}\nnotify CLI 超时（${NOTIFY_TIMEOUT_MS}ms），已终止` , timedOut: true });
    }, NOTIFY_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut: false }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

// 告警里那条「浏览器配置」该指向哪个 profile：
//   给了 `--shop` ⇒ core 的 profileForShop 去**店铺登记表**里取那家店自己的隔离实例
//   （每店一个 profile，见 SHOP_BROWSERS）；没给 ⇒ 回落到日报那个（`--shop` 之前的老用法，行为不变）。
//
// 「哪家店 → 哪个 profile」这一步刻意留在 core（可离线测）：原先它写在这个 IO 脚本里，
// 于是「接线接对了没有」没有任何判据 —— 实测到的后果就是四家店的告警都写着同一个
// `edge-daily-report-profile`，收信人照着这个路径去找，四个窗口长得一模一样。
async function deliverAlert(args, receipt) {
  const verdict = receipt?.verdict ?? null;
  const mode = args?.notify ?? 'auto';
  // 「该不该叫人」与「叫人的话是哪家店、哪个配置」都在 core 的 alertForRun 里（离线可测）。
  // 返回 null 就等于「这次不该叫人」—— 判定不再散落在这个 IO 脚本里。
  const alert = alertForRun({
    args,
    receipt,
    machine: os.hostname(),
    shops: SHOP_BROWSERS,
    fallbackProfile: process.env.PROJECT_BROWSER_PROFILE || BROWSER_PROFILES.dailyReport,
  });
  if (!alert) {
    receipt.notify = {
      mode,
      status: 'SKIPPED',
      reason: needsHuman(verdict) ? 'mode_or_not_attempted' : 'verdict_needs_no_human',
    };
    return;
  }
  const cliArgs = [NOTIFY_CLI, ...(mode === 'dry' ? ['--dry-run'] : [])];
  const result = await runNotifyCli(cliArgs, alert);
  let delivered = null;
  try {
    delivered = result.out ? JSON.parse(result.out) : null;
  } catch {
    delivered = null; // CLI 会写人类可读的错误，那就只留 status
  }
  receipt.notify = {
    mode,
    alertId: alert.alertId,
    // 交付状态是 CLI 报的（SENT / DRY_RUN / NOT_CONFIGURED / FAILED），这里不替它下结论。
    status: delivered?.status ?? (result.code === 0 ? 'UNKNOWN' : 'FAILED'),
    exitCode: result.code,
    ...(mode === 'dry' && typeof delivered?.text === 'string' ? { text: delivered.text } : {}),
    ...(result.code === 0 || result.timedOut ? {} : { error: result.err.trim().slice(0, 400) }),
  };
}

// ---------------------------------------------------------------------------
// 逐条试候选登录地址（2026-09-23）
// ---------------------------------------------------------------------------

// 在给定页签上读出「浏览器往账号框里填的是谁」。
//
// 为什么单独一个函数而不是塞进 FORM_STATE：账号那一条有个硬边界（见 core 里
// LOGIN_ID_VALUE_EXPRESSION 的注释）—— **只读账号框，永远不许扩到密码框**，
// 因为它会被抄进回执、还会被 --shots 那一路写进证据目录。表单状态那一份刻意只给长度、不给值。
async function readFilledAccount(args, targetId) {
  return evalOn(args, targetId, LOGIN_ID_VALUE_EXPRESSION);
}

// 把页签导回「告警承诺的那一页」。
//
// 为什么必须有：逐条试会把页签留在**最后一条**候选上，而结论可能是**前一条**产出的。
// 告警里那句「登录页已经开在{窗口}了」是收信人唯一能核对的承诺 —— 页不在那里，这句话就是假的，
// 而假承诺的代价是「下次不再信这条提醒」（2026-09-18 的教训：文案承诺错了比不说更贵）。
// 只在真的需要时导（地址已经对上了就不碰页面）。
async function parkTabOn(args, targetId, url, currentHref) {
  if (!url || String(url) === String(currentHref)) return { navigated: false, href: currentHref ?? null };
  await proxyText(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`)
    .catch(() => {});
  await delay(4000);
  const href = await evalOn(args, targetId, 'location.href').catch(() => null);
  return { navigated: true, href: href ?? null };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
//
// 所有出口都过 finish()：它只记账不打印 —— 因为告警要在**打印之前**发出去，
// 好让「通知成没成」和登录结论出现在同一份收据里（一次运行一个 JSON，不追加第二行）。
let args = null;
let finalReceipt = null;
let finalExitCode = 0;

function finish(receipt, code = 0) {
  finalReceipt = receipt;
  if (code) finalExitCode = code;
  return receipt;
}

async function attempt() {
  const receipt = { proxy: args.proxy, commit: args.commit, notify: args.notify, sites: {}, login: null };

  // 第零步（2026-09-23 加）：给了店名，就必须落在那家店自己的代理端口上，否则**什么都不碰就停**。
  //
  // 为什么把它放在第一步之前：`--proxy` 是唯一的实例选择器，`--shop` 只写店名
  // （2026-09-22 的硬教训）。两者对不上时，接下来做的每一件事都会落在**别的浏览器**上 ——
  // 五份输出逐字相同、从文字上看不出来，而 2026-09-22 就是这么把那个共用浏览器
  // 登进了某个淘宝卖家号的。判据本身在 core 的 `judgeShopTarget`（纯函数、有用例钉住）；
  // 这里只负责在**动任何页面之前**把它问到，并如实收尾。
  const target = judgeShopTarget({ shop: args.shop, proxy: args.proxy, shops: SHOP_BROWSERS });
  receipt.session = { shop: args.shop ?? null, proxyPort: target.port ?? null, judged: target.judged !== false };
  if (target.judged !== false && target.ok === false) {
    receipt.verdict = 'STOP_AND_ALERT';
    receipt.detail = target.reason === 'other_shop'
      ? `「${target.shop}」用的是 ${SHOP_BROWSERS[target.shop]?.proxyPort} 这个端口，而这次指向的是 ${target.port}（那是「${target.owner}」的）。系统没有动那一台。`
      : `「${target.shop}」用的是 ${SHOP_BROWSERS[target.shop]?.proxyPort} 这个端口，而这次指向的是 ${target.port}，它不属于任何一家店。系统没有动那一台。`;
    return finish(receipt, 3);
  }

  // 第一步：先看两个站点是不是已经登录了。已登录就什么都不做 —— 登录是最该少做的事。
  for (const key of args.sites) {
    const site = SITES[key];
    const state = await siteLoggedIn(args, site);
    receipt.sites[key] = { label: site.label, loggedIn: state.loggedIn, href: state.href, reason: state.reason ?? null };
  }
  // 只有**两个站点都确认已登录**才会走到这里（见 sitesNeedingLogin 的新语义）。
  // 读不到（null，例如窗口里根本没有这个后台的页面）会落进 needLogin ⇒ 进登录流程 ⇒
  // 顺便把页面打开。这里绝不能再对 null 网开一面 —— 那正是 2026-09-19 那次静默的入口：
  // 空窗口被判成 ALREADY_LOGGED_IN，于是不叫人、不做事，`--commit` 也什么都不做。
  const needLogin = sitesNeedingLogin(receipt.sites);
  if (needLogin.length === 0) {
    receipt.verdict = 'ALREADY_LOGGED_IN';
    return finish(receipt);
  }

  // 第一步半（`--check-only`，2026-09-23 加）：只回答「有没有登录态」，**到此为止**。
  //
  // 这一支存在的唯一理由：下面第二步的 `ensureLoginPage()` 会 `/new` 一个淘宝登录页。
  // 于是**不带 --check-only 时，「只读检测」在掉登录的现场恰恰会开一个页签** ——
  // 而「跑前登录态体检」要接进定时链、在没人看着的时候跑，一次体检顺手开个登录页
  // 是没有人授权过的副作用。开关默认关，所以不带它时行为与原样**逐字相同**。
  //
  // 如实分两种情形（这是这一支唯一有价值的信息，不能糊成一句）：
  //   `loggedIn === false` ⇒ 被平台踢回了登录页，实锤；
  //   `loggedIn === null`  ⇒ **读不到**（这个窗口里没有它的页面）—— 不许写成「掉登录」，
  //                          那会把「还没归位」当成「要人登录」报出去（假红比不报更坏）。
  if (args.checkOnly) {
    receipt.verdict = 'NEEDS_LOGIN';
    const because = (key) => (receipt.sites[key].loggedIn === false
      ? `${SITES[key].label}（被踢回登录页）`
      : `${SITES[key].label}（读不到：这个窗口里没有它的页面）`);
    receipt.detail = `要留意的是：${needLogin.map(because).join('、')}。`;
    return finish(receipt, 2);
  }

  // 第一步又四分之一（**页面不在 ≠ 掉登录**，2026-09-24 加）：这一道只挡「会去登」的那一档。
  //
  // 为什么放在 check-only 之后：只读档一个页面都不开，所以它不需要这道闸（它的 detail 已经把
  // 「被踢回登录页」与「读不到」分开写了）；而这一档下面第二步的 `ensureLoginPage()` 会
  // **开一个淘宝登录页** —— 冷启动（浏览器刚起、页面还没归位）时那一步的真实后果是：
  // 登录页被仍然有效的主站会话直接送走 ⇒ 逐条候选都 DETOUR ⇒ 报 `MAIN_SESSION_ONLY`
  // ⇒ 那是一条「要人处理」的结论 ⇒ 一次预检并发 5 条飞书告警，而**每一家其实只是页面还没归位**
  // （链的第 0 步会补上）。一个「页签不在」的问题被改写成了「登录问题」。
  //
  // 判据要**两个条件同时成立**（缺一不可）：
  //   ① 有站点读不到（`loggedIn === null`）；
  //   ② 没有任何站点是实锤掉登录（`loggedIn === false`）。
  // 第 ② 条是关键：只要有一个后台真被踢回登录页，那就是**真问题**，照旧走登录流程去修它 ——
  // 这道闸不许把「真的掉登录」一起挡掉；混合情形（一个读不到 + 一个掉登录）同样走登录流程。
  //
  // 退出码 3 与只读档的「没有结论」同码：这一层的三个退出码本来就这么分工
  // （0 确认在登录态 / 2 确定要人动手 / 3 没有结论），而这一条属于第三类。
  const absent = absentSites(receipt.sites);
  const kickedOut = loggedOutSites(receipt.sites);
  if (absent.length > 0 && kickedOut.length === 0) {
    receipt.verdict = 'PAGES_ABSENT';
    receipt.detail = `读不到的是「${absent.map((key) => SITES[key].label).join('、')}」`
      + '—— 这个窗口里现在没有它们的页面（浏览器刚起、页面还没归位时就是这样）。'
      + '这一次没有开登录页、也没有判「掉登录」；链的第 0 步会先把页面补齐再体检。';
    return finish(receipt, 3);
  }

  // 第二步：逐条打开候选登录地址，**试到浏览器真的肯填为止**。
  //
  // 为什么是循环而不是一条固定地址（2026-09-23 实测，理由与候选表本身在 core 的
  // LOGIN_URL_CANDIDATES 头部）：Chromium 的自动填充**按 origin 匹配**
  // （保存凭据的 `origin_url` 的 origin 必须等于当前登录页的 origin），而
  // 「这台机器上那条凭据的 origin 是哪个」每一台都不一样 —— 固定只开一条，
  // 就必然有机器永远填不上（盖文天猫实测：一次也填不上，报的却是「没存凭据」）。
  //
  // 三条纪律（都是「做错了也不会报错」的那一类）：
  //   1. 判据是「这一页肯不肯填」（`:autofill` / 值落地），**不是**「这一页看起来像不像登录页」；
  //   2. **验证码一露面就交人，绝不换下一条地址继续试** —— 换掉会把已经弹出来的验证码页丢掉，
  //      人回来看到的是一张没有验证码的页，等于白交一次人工；
  //   3. **填进来的人不是这家店就绝不提交**（身份守卫），但可以继续试下一条 ——
  //      「这台浏览器里存着别家的凭据」与「这条 origin 上根本没凭据」是两件事，值得分开试。
  //
  // 每条候选的现场记进 `receipt.login.attempts`（**只记结构与账号名，永远不记密码**）；
  // 全部试完之后报哪一条，由 core 的 `finalLoginVerdict` 决定（五选一的取舍写在那里、有用例钉住）。
  const expected = expectedMemberFor({ shop: args.shop });
  receipt.login = {
    attempts: [],
    expectedMember: expected,
    // 身份守卫的依据从哪来。没有期望值（没给店名、或这家店还没实测过会员名）时**如实记下来**，
    // 不假装守卫过了 —— 见 core 的 expectedMemberFor / judgeFilled 里那两条注释。
    guardBasis: expected ? null : (args.shop ? 'shop_has_no_verified_member' : 'no_expected_member'),
  };

  let targetId = null;
  let state = null;

  for (const candidate of LOGIN_URL_CANDIDATES) {
    const page = await ensureLoginPage(args, candidate.url);
    if (page.error) { receipt.verdict = 'STOP_AND_ALERT'; receipt.detail = page.error; return finish(receipt, 2); }
    targetId = page.targetId;
    // 无条件前置（2026-09-19 改）。原先这里挂着 `if (args.shots)` —— 只有带 --shots 的跑法才前置，
    // 而多店铺驱动（run-multi-shop-day.mjs）不传 --shots ⇒ 失败交人时窗口还留在后台，
    // 人在任务栏里翻不出是哪一个，告警正文那句「去那个窗口」就成了一句空话。
    // 对坐标点击来说这本来也是前提：窗口不在前台时，clickPoint 的坐标会落到别的窗口上。
    await proxyText(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
    await delay(2500);

    state = JSON.parse(await evalOn(args, targetId, FORM_STATE));
    // 每一条候选都留一份记录：**这是「逐条试」唯一能被事后复盘的地方** ——
    // 只写「最后报了什么」，将来没人能回答「第二条到底试没试、它当时长什么样」。
    const attempt = {
      id: candidate.id,
      url: candidate.url,
      opened: page.opened,
      navigated: page.navigated,
      href: state.href,
    };
    receipt.login.attempts.push(attempt);
    receipt.login.targetId = targetId;


    // 这一页**还是不是登录页**。判定本身在 core 的 detectLoginDetour（离线可测；写在这里就没人碰得到）。
    //
    // 2026-09-19 实测出来的假事实：淘宝**主站**会话还有效时，打开顶层登录页会被直接送去
    // 卖家后台（19033 实测落到 myseller.taobao.com/home.htm/QnworkbenchHome/），
    // 页面上没有任何输入框 ⇒ 原先那句「拿不到 :autofill」就把它误判成 NO_SAVED_CREDENTIAL，
    // 而告警让人去点浏览器提示里的「保存密码」。密码库里凭据是有的，缺的是这两个后台
    // **自己的**会话 —— 收信人照着那句做，问题不会好。
    // 口径：报错文案是收信人唯一看到的解释，**说错解释比不说更贵**。
    //
    // 2026-09-23 加一道前置：**页面自己长出了账号框与密码框 ⇒ 它就是登录页**，不再问 URL。
    // 逐条试时这一步跑在「导过去只等了 4s」之后，而「页面还在导」与「真的被送走了」
    // 在只读观测里长得很像 —— 有了这一道，「表单先生出来、地址还没跟上」就不会被白扔掉
    // （扔掉一条本来能填的候选，去报一句「主站会话还在」，是最贵的一种错）。
    const detour = loginFormVisible(state) ? null : detectLoginDetour(state.href);
    if (detour) {
      attempt.outcome = 'DETOUR';
      attempt.host = detour.host;
      continue;
    }
    if (!loginFormVisible(state)) {
      // 这一页既不是登录页、也没有可填的账号框 —— 换下一条地址，不在这里乱点。
      attempt.outcome = 'NO_FORM';
      continue;
    }
    attempt.autofill = { id: state.id?.autofill ?? null, password: state.password?.autofill ?? null };

    // 第三步：值已经在 DOM 里就直接用；否则补一次可信手势把浏览器的填充「敲实」。
    if ((state.id?.valueLen ?? 0) === 0) {
      if (state.id?.autofill !== true) {
        // 这一页有表单，但**这个 origin** 上没有凭据。`:autofill` 是唯一能在不点任何东西的
        // 前提下回答这个问题的判据（实测：预览态也会是 true，所以它不回答「值落地了没有」）。
        attempt.outcome = 'NO_AUTOFILL';
        continue;
      }
      const point = centerOf(state, 'id');
      if (!point) { attempt.outcome = 'NO_FORM'; continue; }
      attempt.gesturePoint = point;
      if (!args.commit) {
        // 排练档：**只报「浏览器肯填」这件事，不报「已经成了」**。
        // 演练不是一次尝试，所以既不下结论也不叫人（判定在 core 的 shouldNotify）。
        receipt.login.candidate = candidate.id;
        receipt.login.urlBefore = state.href;
        receipt.login.gesturePoint = point;
        receipt.verdict = 'READY_TO_GESTURE';
        receipt.detail = '检测到浏览器填充预览态；加 --commit 才会补可信手势并提交。';
        receipt.login.shots = await shot(args, targetId, 'login-before-commit');
        return finish(receipt);
      }
      await clickPoint(args, targetId, point[0], point[1]);
      await delay(2000);
      state = JSON.parse(await evalOn(args, targetId, FORM_STATE));
      attempt.afterGesture = { idLen: state.id?.valueLen ?? 0, passwordLen: state.password?.valueLen ?? 0 };
      if ((state.id?.valueLen ?? 0) === 0 || (state.password?.valueLen ?? 0) === 0) {
        // 浏览器把账号**画**在了页面上、页面上其实是空的（2026-09-18 实测的形态）⇒ 换下一条。
        attempt.outcome = 'NO_VALUE_LANDED';
        continue;
      }
    }

    // 第三步半（身份守卫，2026-09-23 加）：**提交之前**读一次账号框，确认填进来的是这家店。
    //
    // 为什么必须有：同一个 origin 下可以有多条凭据（实测：商家浏览器那个 profile 的
    // `login.taobao.com` 下有两条，分属**两家不同的店**），那时浏览器**自己挑一条**，
    // 脚本控制不了。挑错了不会报任何错 —— 页面照开、导出照成、报表里的数字看起来都对，
    // 而**每一个数字都属于另一家店**，链上没有任何一步会发现。
    // ⇒ 「登录失败」是响亮的安全失败；「登成了别人」是静默的、更贵的那种。
    //
    // 读的**只有账号**（表达式来自 core，永远不许扩到密码框），比对在内存里做；
    // 回执里留「期望值 + 判定 + 实际填进来的账号名」—— 账号名不是秘密（它就写在阿里妈妈页头上），
    // 密码从头到尾不经过本脚本。
    const filled = await readFilledAccount(args, targetId);
    const guard = judgeFilled({ filled, expected });
    attempt.guard = { verdict: guard, expected, filled };
    if (guard === 'WRONG_ACCOUNT') { attempt.outcome = 'WRONG_ACCOUNT'; continue; }
    if (guard === 'EMPTY') { attempt.outcome = 'NO_VALUE_LANDED'; continue; }
    // `UNKNOWN`（没有期望值可依）**照旧往下走** —— 但它是「这条守卫没有依据」，
    // 不是「守卫通过了」。依据缺失已经写在 receipt.login.guardBasis 里，谁看回执都看得见。

    // 到这里这条候选就是**被选中的那一条**了（下面每一条路径都会离开循环）。
    receipt.login.candidate = candidate.id;
    receipt.login.urlBefore = state.href;
    receipt.login.guard = attempt.guard;

    // 第四步：验证码/滑块显形就停手（SOP §10.2：中途弹登录/验证码立即停，不硬闯）。
    // **不换下一条地址继续试** —— 换掉会把已经弹出来的验证码页丢掉（见本步头部第 2 条纪律）。
    const captcha = captchaVisible(state);
    receipt.login.captcha = captcha;
    if (captcha) {
      receipt.login.shots = await shot(args, targetId, 'login-captcha');
      receipt.verdict = 'CAPTCHA_REQUIRED';
      receipt.detail = '出现滑块或图片验证码了 —— 请在这台机器上把验证做完，账号密码已经填好了，不用重输。';
      return finish(receipt, 2);
    }

    if (!args.commit) {
      receipt.verdict = 'READY_TO_SUBMIT';
      receipt.login.shots = await shot(args, targetId, 'login-ready');
      return finish(receipt);
    }

    // 第五步：勾协议（默认未勾）→ 点登录。
    if (state.agreement && state.agreement.checked === false) {
      const point = centerOf(state, 'agreement');
      if (point) { await clickPoint(args, targetId, point[0], point[1]); await delay(1200); state = JSON.parse(await evalOn(args, targetId, FORM_STATE)); }
    }
    receipt.login.agreementChecked = state.agreement?.checked ?? null;
    const submitPoint = centerOf(state, 'submit');
    if (!submitPoint) {
      receipt.verdict = 'STOP_AND_ALERT';
      receipt.detail = '页面上找不到「登录」按钮的位置，系统没有乱点。请人工登录一次。';
      return finish(receipt, 2);
    }
    await clickPoint(args, targetId, submitPoint[0], submitPoint[1]);
    receipt.login.submitPoint = submitPoint;
    await delay(6000);

    // 第六步：判成败 —— 看它有没有离开登录页，再回到两个站点各验一次。
    const hrefAfter = await evalOn(args, targetId, 'location.href').catch(() => null);
    receipt.login.urlAfter = hrefAfter ?? null;
    receipt.login.shots = await shot(args, targetId, 'login-after-submit');
    // 「还在不在登录页上」只由 core 的 isTaobaoLoginUrl 解释（这里原先内联了一份同样的正则，
    // 而这次新增的 MAIN_SESSION_ONLY 判断也要用 —— 两份口径迟早会各自漂移，漂移的表现是结论错）。
    if (hrefAfter && isTaobaoLoginUrl(hrefAfter)) {
      receipt.verdict = 'LOGIN_NOT_CONFIRMED';
      receipt.detail = '页面还停在登录页 —— 可能是密码不对，也可能是平台要求额外验证。系统没有再试一遍（连着试会把账号锁住）。';
      return finish(receipt, 2);
    }
    for (const key of args.sites) {
      const site = SITES[key];
      const after = await siteLoggedIn(args, site);
      receipt.sites[key] = { ...receipt.sites[key], loggedInAfter: after.loggedIn, hrefAfter: after.href };
    }
    const allIn = args.sites.every((k) => receipt.sites[k].loggedInAfter === true);
    receipt.verdict = allIn ? 'LOGGED_IN' : 'PARTIAL';
    if (!allIn) {
      // 点名**哪一个**后台没进去：只说「有一个没进去」，收信人还得自己去两个后台各试一遍。
      // 也不要写「先看截图」—— 截图落在**这台机器**的证据目录里，收信人在飞书里根本看不到它。
      const missing = args.sites
        .filter((k) => receipt.sites[k].loggedInAfter !== true)
        .map((k) => SITES[k].label);
      receipt.detail = `没进去的是「${missing.join('、')}」。`;
    }
    return finish(receipt, allIn ? 0 : 2);
  }

  // 候选全试完还没成 ⇒ 报哪一条、把人送到哪一页，由 core 的 `finalLoginVerdict` 决定。
  // 取舍在那边（五选一，有用例钉住）；这里只负责把结论翻成人话、并**把页签停回那一页**。
  //
  // 「停回那一页」不是锦上添花：逐条试会把页签留在**最后一条**候选上，而结论可能是**前一条**
  // 产出的。告警里那句「登录页已经开在窗口里了」是收信人唯一能核对的承诺 ——
  // 页不在那里，这句话就是假的，而假承诺的代价是「下次不再信这条提醒」。
  const final = finalLoginVerdict(receipt.login.attempts);
  receipt.login.stoppedAt = final.stoppedAt?.id ?? null;
  if (final.parkOnLoginPage && final.stoppedAt?.url) {
    const parked = await parkTabOn(args, targetId, final.stoppedAt.url, state?.href ?? null);
    receipt.login.parkedBack = parked.navigated;
    receipt.login.parkedAt = parked.href;
  }

  if (final.outcome === 'WRONG_ACCOUNT') {
    const other = final.stoppedAt?.guard?.filled ?? null;
    receipt.verdict = 'WRONG_ACCOUNT';
    receipt.detail = other
      ? `这家店该填的是「${expected}」，浏览器填进来的却是「${other}」—— 系统没有提交。`
      : '浏览器往登录框里填的不是这家店的账号 —— 系统没有提交。';
  } else if (final.outcome === 'DETOUR') {
    const host = final.stoppedAt?.host ?? null;
    receipt.verdict = 'MAIN_SESSION_ONLY';
    receipt.detail = host
      ? `打开登录页后，页面落到了 ${host} —— 说明淘宝主站的会话还在。`
      : '打开登录页后，页面没有停在登录页上。';
  } else if (final.outcome === 'NO_VALUE_LANDED') {
    receipt.verdict = 'NO_SAVED_CREDENTIAL';
    receipt.detail = '浏览器把账号画在了页面上，但页面上其实是空的 —— 人工登录一次，并在登录时点浏览器提示里的「保存密码」。';
  } else if (final.outcome === 'NO_AUTOFILL') {
    receipt.verdict = 'NO_SAVED_CREDENTIAL';
    // 文案要点（2026-09-23 晚按真机结论改写）：**保存密码时站在哪个登录页上，决定下次填不填。**
    // 实测：`havanalogin.taobao.com/mini_login.htm` 上存下来的密码，即使再开回那一页也不会被填；
    // 只有 `login.taobao.com` 那条入口上的凭据才会被填。所以不能只说「保存一下密码」——
    // 那样收信人很可能正好在错的那一页上保存，做完之后症状一字不变，却以为已经修好了。
    receipt.detail = '这台机器上没有能自动填的账号密码。请在那个窗口里手工登录一次，'
      + '登录时点浏览器提示里的「保存密码」；保存的时候要让地址栏停在以 login.taobao.com 开头的登录页上，'
      + '在别的登录页保存的话，下次还是填不上。';
  } else {
    // `NO_FORM`，以及「一条记录都没有」这种本层没有结论的情形 —— 两种都不许猜，一律交人。
    receipt.verdict = 'STOP_AND_ALERT';
    receipt.detail = '几条登录地址上都没有可填的账号框，系统没有乱点。请人工登录一次。';
  }
  receipt.login.shots = await shot(args, targetId, 'login-unsolved');
  return finish(receipt, 2);
}

function printHeader() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const cut = source.findIndex((line) => line.startsWith('import '));
  console.log(source.slice(0, cut === -1 ? 30 : cut).join('\n'));
}

async function main() {
  try {
    args = parseArgs(process.argv.slice(2), {
      defaultProxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
      // 合法店名来自登记表（单一来源），不在这里另抄一份。
      shops: shopBrowserKeys(),
    });
    if (args.help) { printHeader(); return; }
    await attempt();
  } catch (error) {
    // 参数拼错也走这里。args 为 null 时 deliverAlert 不会发（判定缺输入，不猜）。
    finalReceipt = { verdict: 'STOP_AND_ALERT', detail: String(error?.message ?? error) };
    finalExitCode = 3;
  }
  if (!finalReceipt) return;
  try {
    await deliverAlert(args, finalReceipt);
  } catch (error) {
    finalReceipt.notify = { status: 'FAILED', error: String(error?.message ?? error).slice(0, 400) };
  }
  console.log(JSON.stringify(finalReceipt, null, 1));
  if (finalExitCode) process.exitCode = finalExitCode;
}

await main();
