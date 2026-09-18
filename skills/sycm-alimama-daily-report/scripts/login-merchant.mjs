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
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --commit        # 真的走登录，失败会发飞书
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --target sycm   # 只处理其中一个站点
//   ... --notify dry                                                                  # 只渲染告警文案，不发
//   ... --notify off                                                                  # 彻底不发
// 说明：不带 --commit 时是**只读排练**（量坐标、回读状态、截图），可以用来判断「现在到底要不要登录」。
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_PROFILES, PROJECT_PORTS, SHOP_BROWSERS, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
// 判据与纯逻辑都在 core 里（可离线测）；这里只留 IO。
import {
  FORM_STATE_EXPRESSION, SITES, TAOBAO_LOGIN_URL, alertForRun, captchaVisible, centerOf, needsHuman,
  parseArgs, sitesNeedingLogin,
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

async function ensureLoginPage(args) {
  const pages = await listPages(args);
  const existing = pages.filter((p) => String(p.url).includes('login.taobao.com/havanaone/login'));
  if (existing.length > 1) return { error: `堆了 ${existing.length} 个淘宝登录页，先去关到只剩一个` };
  if (existing.length === 1) return { targetId: existing[0].targetId, opened: false };
  const created = JSON.parse(await proxyText(`${args.proxy}/new?url=${encodeURIComponent(TAOBAO_LOGIN_URL)}&label=taobao-login`));
  await delay(4000);
  return { targetId: created.targetId, opened: true };
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

  // 第一步：先看两个站点是不是已经登录了。已登录就什么都不做 —— 登录是最该少做的事。
  for (const key of args.sites) {
    const site = SITES[key];
    const state = await siteLoggedIn(args, site);
    receipt.sites[key] = { label: site.label, loggedIn: state.loggedIn, href: state.href, reason: state.reason ?? null };
  }
  const needLogin = sitesNeedingLogin(receipt.sites);
  if (needLogin.length === 0) {
    receipt.verdict = 'ALREADY_LOGGED_IN';
    return finish(receipt);
  }

  // 第二步：打开（或复用）顶层淘宝登录页。
  const page = await ensureLoginPage(args);
  if (page.error) { receipt.verdict = 'STOP_AND_ALERT'; receipt.detail = page.error; return finish(receipt, 2); }
  const targetId = page.targetId;
  if (args.shots) await proxyText(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
  await delay(2500);

  let state = JSON.parse(await evalOn(args, targetId, FORM_STATE));
  receipt.login = { targetId, opened: page.opened, urlBefore: state.href, autofill: { id: state.id?.autofill ?? null, password: state.password?.autofill ?? null } };

  // 第三步：值已经在 DOM 里就直接用；否则补一次可信手势把浏览器的填充「敲实」。
  if ((state.id?.valueLen ?? 0) === 0) {
    if (state.id?.autofill !== true) {
      receipt.login.shots = await shot(args, targetId, 'login-no-autofill');
      receipt.verdict = 'NO_SAVED_CREDENTIAL';
      receipt.detail = '登录时请点浏览器提示里的「保存密码」，这样下次系统就能自己填了。';
      return finish(receipt, 2);
    }
    const point = centerOf(state, 'id');
    if (!point) {
      receipt.verdict = 'STOP_AND_ALERT';
      receipt.detail = '页面上找不到账号输入框的位置，系统没有乱点。请人工登录一次。';
      return finish(receipt, 2);
    }
    receipt.login.gesturePoint = point;
    if (!args.commit) {
      receipt.verdict = 'READY_TO_GESTURE';
      receipt.detail = '检测到浏览器填充预览态；加 --commit 才会补可信手势并提交。';
      receipt.login.shots = await shot(args, targetId, 'login-before-commit');
      return finish(receipt);
    }
    await clickPoint(args, targetId, point[0], point[1]);
    await delay(2000);
    state = JSON.parse(await evalOn(args, targetId, FORM_STATE));
  }
  receipt.login.afterGesture = { idLen: state.id?.valueLen ?? 0, passwordLen: state.password?.valueLen ?? 0 };

  if ((state.id?.valueLen ?? 0) === 0 || (state.password?.valueLen ?? 0) === 0) {
    receipt.login.shots = await shot(args, targetId, 'login-values-not-landed');
    receipt.verdict = 'NO_SAVED_CREDENTIAL';
    receipt.detail = '浏览器把账号画在了页面上，但页面上其实是空的 —— 人工登录一次，并在登录时点浏览器提示里的「保存密码」。';
    return finish(receipt, 2);
  }

  // 第四步：验证码/滑块显形就停手（SOP §10.2：中途弹登录/验证码立即停，不硬闯）。
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
  if (hrefAfter && /login\.taobao\.com\/.*login/u.test(String(hrefAfter))) {
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
