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
// 用法：
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs                 # 只检测，不点任何东西
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --commit        # 真的走登录
//   node skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --target sycm   # 只处理其中一个站点
// 说明：不带 --commit 时是**只读排练**（量坐标、回读状态、截图），可以用来判断「现在到底要不要登录」。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
// 判据与纯逻辑都在 core 里（可离线测）；这里只留 IO。
import {
  FORM_STATE_EXPRESSION, SITES, TAOBAO_LOGIN_URL, captchaVisible, centerOf, parseArgs, sitesNeedingLogin,
} from './login-merchant-core.mjs';

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

async function main() {
  const args = parseArgs(process.argv.slice(2), { defaultProxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}` });
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 22).join('\n'));
    return;
  }

  const receipt = { proxy: args.proxy, commit: args.commit, sites: {}, login: null };

  // 第一步：先看两个站点是不是已经登录了。已登录就什么都不做 —— 登录是最该少做的事。
  for (const key of args.sites) {
    const site = SITES[key];
    const state = await siteLoggedIn(args, site);
    receipt.sites[key] = { label: site.label, loggedIn: state.loggedIn, href: state.href, reason: state.reason ?? null };
  }
  const needLogin = sitesNeedingLogin(receipt.sites);
  if (needLogin.length === 0) {
    receipt.verdict = 'ALREADY_LOGGED_IN';
    console.log(JSON.stringify(receipt, null, 1));
    return;
  }

  // 第二步：打开（或复用）顶层淘宝登录页。
  const page = await ensureLoginPage(args);
  if (page.error) { receipt.verdict = 'STOP_AND_ALERT'; receipt.detail = page.error; console.log(JSON.stringify(receipt, null, 1)); process.exitCode = 2; return; }
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
      receipt.detail = '这个 profile 的密码库里没有该站点的凭据（:autofill 为 false）⇒ 只能人工登录一次并让浏览器记住密码；脚本不猜账号密码。';
      console.log(JSON.stringify(receipt, null, 1));
      process.exitCode = 2;
      return;
    }
    const point = centerOf(state, 'id');
    if (!point) {
      receipt.verdict = 'STOP_AND_ALERT';
      receipt.detail = '账号输入框没有可点坐标（rect 为零或缺失）⇒ 不点可疑坐标';
      console.log(JSON.stringify(receipt, null, 1));
      process.exitCode = 2;
      return;
    }
    receipt.login.gesturePoint = point;
    if (!args.commit) {
      receipt.verdict = 'READY_TO_GESTURE';
      receipt.detail = '检测到浏览器填充预览态；加 --commit 才会补可信手势并提交。';
      receipt.login.shots = await shot(args, targetId, 'login-before-commit');
      console.log(JSON.stringify(receipt, null, 1));
      return;
    }
    await clickPoint(args, targetId, point[0], point[1]);
    await delay(2000);
    state = JSON.parse(await evalOn(args, targetId, FORM_STATE));
  }
  receipt.login.afterGesture = { idLen: state.id?.valueLen ?? 0, passwordLen: state.password?.valueLen ?? 0 };

  if ((state.id?.valueLen ?? 0) === 0 || (state.password?.valueLen ?? 0) === 0) {
    receipt.login.shots = await shot(args, targetId, 'login-values-not-landed');
    receipt.verdict = 'NO_SAVED_CREDENTIAL';
    receipt.detail = '补了可信手势之后账号/密码仍然是空的 ⇒ 浏览器没把凭据写进 DOM，不硬填。';
    console.log(JSON.stringify(receipt, null, 1));
    process.exitCode = 2;
    return;
  }

  // 第四步：验证码/滑块显形就停手（SOP §10.2：中途弹登录/验证码立即停，不硬闯）。
  const captcha = captchaVisible(state);
  receipt.login.captcha = captcha;
  if (captcha) {
    receipt.login.shots = await shot(args, targetId, 'login-captcha');
    receipt.verdict = 'CAPTCHA_REQUIRED';
    receipt.detail = '出现滑块/图片验证码 ⇒ 需要人到这台机器上完成一次；账号密码已经填好，不用重输。';
    console.log(JSON.stringify(receipt, null, 1));
    process.exitCode = 2;
    return;
  }

  if (!args.commit) {
    receipt.verdict = 'READY_TO_SUBMIT';
    receipt.login.shots = await shot(args, targetId, 'login-ready');
    console.log(JSON.stringify(receipt, null, 1));
    return;
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
    receipt.detail = '登录按钮没有可点坐标';
    console.log(JSON.stringify(receipt, null, 1));
    process.exitCode = 2;
    return;
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
    receipt.detail = '提交后仍停在登录页 —— 可能密码不对、可能要求验证码，如实报「没成」，不假装成功。';
    console.log(JSON.stringify(receipt, null, 1));
    process.exitCode = 2;
    return;
  }
  for (const key of args.sites) {
    const site = SITES[key];
    const after = await siteLoggedIn(args, site);
    receipt.sites[key] = { ...receipt.sites[key], loggedInAfter: after.loggedIn, hrefAfter: after.href };
  }
  const allIn = args.sites.every((k) => receipt.sites[k].loggedInAfter === true);
  receipt.verdict = allIn ? 'LOGGED_IN' : 'PARTIAL';
  console.log(JSON.stringify(receipt, null, 1));
  if (!allIn) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({ verdict: 'STOP_AND_ALERT', detail: String(error?.message ?? error) }, null, 1));
  process.exitCode = 3;
}
