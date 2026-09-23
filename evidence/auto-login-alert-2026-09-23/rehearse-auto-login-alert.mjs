// 一次性实例真机演练：**自动登录失败 ⇒ 飞书真的收到告警**（1.5.0 新增行为）。
//
// 用户 2026-09-23 拍板原话：「如果自动登录失败就飞书告警，但是前提是你要先自动登录」。
// 这条行为在离线用例里只能被验到「`notifyModeFor({login})` 算出哪个值」+「源码里真的用了它」，
// 而这两条都不回答那个唯一重要的问题：**告警对象被构造出来之后，真的走上投递链了吗？**
// 离线用例里的 notify 是我自己写的假装配 —— 它把「alert 非 null」直接建模成「CLI 被调用了」，
// 而那恰恰是要验证的那件事。所以真机上必须再跑一次：
// 真 Edge、真 cdp-proxy、真登录流程、真投递 CLI。
//
// 三条纪律（不是新发明的，是这几轮一直在用的）：
//   1) **只在未登记的端口 + 临时 profile 上跑**（19933 / 19943，登记表里没有这两个号）
//      ⇒ 不碰五家店、商家浏览器、竞品链、日报链的任何实例。
//      这一条在本轮是**硬要求**：用户此刻正在那六个窗口里手工登录，碰一下就是帮倒忙。
//   2) **先探测端口是空的**再起：万一那里已经有别人的实例，本脚本**停手**而不是接上去。
//   3) **跑完释放并复核**：显式 taskkill 整棵进程树，再回读端口确认真的没了（自报「已释放」不算数）。
//
// 为什么要用一次性实例而不是直接打 19045（盖文天猫）：那次真登录**从不提交密码**
// （它的密码库里本来就没有那条可用凭据 ⇒ `NO_SAVED_CREDENTIAL`），所以**没有锁号风险**；
// 但它会去**动用户正在登的那个窗口**（开/复用登录页、补一次手势）。两条相权，
// 用一次性实例把「扰动」降到零，代价只是多起一个浏览器。
//
// 归属判据（本文件只做这一件事）：
//   · 一次 `--commit`（真的去登了）在**没有可用凭据**的新实例上 ⇒ 结论需要人；
//   · 该结论下 `--notify auto` 必须**真的发出去**（收据 `status: SENT`），
//     且告警编号里带店名与日期（去重锚）；
//   · 同一次跑改成 `--check-only --notify off`（＝只读档那条口径）⇒ 收据必须是 `SKIPPED`、
//     **一个字都不发**。这一条是「前提是你要先自动登录」的反面：没登过就不许叫人。
//
// 产物：同目录 `rehearsal-auto-login-alert.json`（结构化断言，**收件人 id 已打码**）、
//       `login-commit-receipt.json` / `login-checkonly-receipt.json`（两次回执，同样打码）。
// 用法（任意目录均可；路径按**自身位置**算，收进 evidence/ 后仍可跑）：
//   node evidence/auto-login-alert-2026-09-23/rehearse-auto-login-alert.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const say = (line) => process.stdout.write(`${line}\n`);

// 未登记端口：登记表里 9231/9232/3457/19022-19035/19041-19045/19931/19941 都已占用，
// 19933/19943 谁都不用（19931/19941 被 label-converge 那次演练用过，避开它免得撞上残留）。
const BROWSER_PORT = 19933;
const PROXY_PORT = 19943;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
// 店名必须是登记表里真实存在的那几个之一：告警的「去哪个窗口、用哪个 profile」全靠它，
// 而 `profileForShop` 对没登记的店名**抛错**（那是刻意的 fail-closed，别绕过它）。
const SHOP = '盖文天猫';

const report = { startedAt: new Date().toISOString(), browserPort: BROWSER_PORT, proxyPort: PROXY_PORT, shop: SHOP, checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  say(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
};

// ---- 打码：收件人 id / 应用 id / 密钥 / Bearer 绝不进证据文件 -------------------
// 投递收据里带 `target`（收件人 open_id），这正是仓库既有那条纪律要挡的东西
// （见 runtime 用例「投递收据要留平台回执号，但不能把收件人抄进证据文件」）。
// 这里在**写盘之前**统一打码，而不是靠人记得检查。
const REDACTIONS = [
  [/\bou_[0-9a-z]{10,}\b/giu, '<redacted-open-id>'],
  [/\boc_[0-9a-z]{10,}\b/giu, '<redacted-chat-id>'],
  [/\bcli_[0-9a-z]{10,}\b/giu, '<redacted-app-id>'],
  [/\bBearer\s+[A-Za-z0-9._-]+/giu, 'Bearer <redacted>'],
];
const redact = (value) => {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, to] of REDACTIONS) out = out.replace(re, to);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
};
const writeRedacted = (file, data) => {
  const text = redact(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  fs.writeFileSync(path.join(import.meta.dirname, file), `${text}\n`, 'utf8');
};

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return `HTTP ${r.status}`;
  } catch {
    return null; // 连不上＝空闲（这里只接受这一种「空闲」证据，别的一律停手）
  }
}

async function waitFor(label, url, timeoutMs = 60000) {
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

/** 跑一次 login-merchant.mjs，把 stdout 末尾那段 JSON 回执解析出来。 */
function runLoginCli(extraArgs, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve) => {
    const args = ['skills/sycm-alimama-daily-report/scripts/login-merchant.mjs',
      '--proxy', PROXY, '--shop', SHOP, ...extraArgs];
    const child = spawn(NODE, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let receipt = null;
      const marker = out.indexOf('\n{');
      try { receipt = JSON.parse(marker === -1 ? out.trimStart() : out.slice(marker + 1)); } catch { receipt = null; }
      resolve({ code, out, err, receipt, args });
    });
  });
}

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
    `浏览器 ${BROWSER_PORT}=${report.release.browserPortAfter}，代理 ${PROXY_PORT}=${report.release.proxyPortAfter}`);
  if (profile) {
    let removed;
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); removed = true; }
    catch (error) { removed = String(error.message).slice(0, 200); }
    report.release.profile = profile;
    report.release.profileRemoved = removed;
    say(`   临时 profile：${profile}（删除结果：${removed}）`);
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

  // ---- 1) 起一次性实例（临时 profile ⇒ 密码库必然是空的）--------------------
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-login-alert-'));
  report.temporaryProfile = profile;
  say(`=== 起一次性实例：port=${BROWSER_PORT} profile=${profile}`);

  const browserLog = [];
  const browser = spawn(NODE, [path.join(REPO, 'runtime/start-project-browser.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PROJECT_BROWSER_PORT: String(BROWSER_PORT),
      PROJECT_BROWSER_PROFILE: profile,
      PROJECT_BROWSER_URL: 'about:blank',
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
      CDP_BROWSER_ID: 'auto-login-alert-rehearsal',
      CDP_BROWSER_LABEL: '一次性演练实例（跑完就释放）',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proxy);
  proxy.stdout.on('data', (d) => proxyLog.push(String(d)));
  proxy.stderr.on('data', (d) => proxyLog.push(String(d)));
  await waitFor('代理 /targets', `${PROXY}/targets`);
  say(proxyLog.join('').trim().split('\n').map((l) => `    [proxy] ${l}`).join('\n'));

  // ---- 2) 反面：只读档那条口径（--check-only --notify off）不许叫人 ----------
  say('\n=== 对照 1：只读档口径（--check-only --notify off）');
  const checkOnly = await runLoginCli(['--check-only', '--notify', 'off']);
  report.checkOnly = { code: checkOnly.code, receipt: null };
  if (checkOnly.receipt) {
    report.checkOnly.receipt = {
      verdict: checkOnly.receipt.verdict,
      notify: checkOnly.receipt.notify ?? null,
      sites: Object.fromEntries(Object.entries(checkOnly.receipt.sites ?? {})
        .map(([k, v]) => [k, { label: v?.label, loggedIn: v?.loggedIn }])),
    };
    writeRedacted('login-checkonly-receipt.json', checkOnly.receipt);
  }
  check('只读档真的读到了回执', checkOnly.receipt !== null,
    `exit=${checkOnly.code}，stderr 尾：${(checkOnly.err || '').trim().slice(-200)}`);
  check('只读档的收据是 SKIPPED（「没去登过就一个字都不发」）',
    checkOnly.receipt?.notify?.status === 'SKIPPED',
    JSON.stringify(report.checkOnly.receipt?.notify ?? null));
  say(JSON.stringify(report.checkOnly.receipt, null, 1));

  // ---- 3) 正面：真的去登了（--commit --notify auto）⇒ 必须真的发出去 ---------
  say('\n=== 对照 2：真的去登（--commit --notify auto）');
  const commit = await runLoginCli(['--commit', '--notify', 'auto']);
  report.commit = { code: commit.code, receipt: null };
  if (commit.receipt) {
    writeRedacted('login-commit-receipt.json', commit.receipt);
    report.commit.receipt = {
      verdict: commit.receipt.verdict,
      notify: commit.receipt.notify ?? null,
      login: commit.receipt.login
        ? {
          opened: commit.receipt.login.opened,
          autofill: commit.receipt.login.autofill ?? null,
          urlAfter: commit.receipt.login.urlAfter ?? null,
        }
        : null,
      sites: Object.fromEntries(Object.entries(commit.receipt.sites ?? {})
        .map(([k, v]) => [k, { label: v?.label, loggedIn: v?.loggedIn }])),
    };
  }
  check('真的去登的那一次拿到了回执', commit.receipt !== null,
    `exit=${commit.code}，stderr 尾：${(commit.err || '').trim().slice(-200)}`);
  say(JSON.stringify(report.commit.receipt, null, 1));

  // 新实例的密码库是空的 ⇒ 结论必然需要人（具体是哪一个词由现场决定，这里不预设）。
  const NEEDS_HUMAN = ['NO_SAVED_CREDENTIAL', 'MAIN_SESSION_ONLY', 'CAPTCHA_REQUIRED',
    'LOGIN_NOT_CONFIRMED', 'PARTIAL', 'NEEDS_LOGIN', 'STOP_AND_ALERT'];
  check('照实记下这次落在哪一个结论上（结论是实测出来的，不是预设的）',
    NEEDS_HUMAN.includes(commit.receipt?.verdict),
    `verdict=${commit.receipt?.verdict}`);
  check('结论需要人 ⇒ 告警真的被投递了（收据 status=SENT）',
    commit.receipt?.notify?.status === 'SENT',
    `notify=${JSON.stringify(report.commit.receipt?.notify ?? null)}`);
  check('告警编号里带店名与日期（同一天同一家店只会叫一次）',
    typeof commit.receipt?.notify?.alertId === 'string'
      && commit.receipt.notify.alertId.includes(SHOP)
      && /\d{8}$/u.test(commit.receipt.notify.alertId),
    `alertId=${commit.receipt?.notify?.alertId ?? null}`);
  check('投递收据里带了投递模式 auto（证明走的是新接线，不是写死的 off）',
    commit.receipt?.notify?.mode === 'auto',
    `mode=${commit.receipt?.notify?.mode ?? null}`);

  report.verdict = report.checks.every((c) => c.ok) ? '全部成立' : '有不成立的项';
} catch (error) {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  say(`\n!! 演练中断：${error.message}`);
} finally {
  await cleanup(report.fatal ? '演练中断也要释放' : '演练结束');
  report.finishedAt = new Date().toISOString();
  writeRedacted('rehearsal-auto-login-alert.json', report);
  say(`\n结论：${report.verdict ?? '未完成'}；明细：evidence/auto-login-alert-2026-09-23/rehearsal-auto-login-alert.json`);
  // 退出码只由**两件事同时成立**决定：每一项检查都过、且中途没有致命中断。
  process.exitCode = (report.checks.length > 0 && report.checks.every((c) => c.ok) && !report.fatal) ? 0 : 1;
}
