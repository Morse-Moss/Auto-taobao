// 一次性实例真机探针：**登录页那个「同意协议」勾选框，到底能不能被点中**。
//
// 为什么要单独验这一件事（嫌疑来自两份真跑回执，不是猜的）：
//   · 商家浏览器那次：`afterGesture {idLen:8, passwordLen:9}`（值确实落进去了）→ `captcha:false`
//     → `agreementChecked:false` → 提交后**仍停在登录页** ⇒ `LOGIN_NOT_CONFIRMED`；
//   · 而淘宝不勾协议点登录是**不会走**的。
// ⇒ 假设：`centerOf(state,'agreement')` 算出来的点根本没落在那个勾选框上（比如元素是 0×0 的隐藏 input），
//   于是「点了等于没点」，提交被静默拒掉，现场只留下一句「密码不对或平台要额外验证」——
//   而这句会把排查引向**密码**，方向就错了。
//
// 判据（本文件只做这一件事）：在一次性的空 profile 上打开真登录页，然后
//   ① 记下 `#fm-agreement-checkbox` 的 `checked` / `rect` / `visible`；
//   ② 用**真机坐标点击**（`/clickPoint`，与产品代码同一个手法）再回读 —— `checked` 变没变；
//   ③ 点之前先问 `elementFromPoint(那个点)` 是**谁** ——
//      「点了没生效」到底是因为点歪了（点到别的元素），还是因为那个元素本身不可交互。
//      判「操作生效没」**不用页面文本**，用这个（本仓既有纪律）。
//   ④ 再用一次 DOM 直点（`el.click()`）做对照：如果 DOM 直点能勾上、坐标点击勾不上，
//      那就坐实是**坐标**的问题，而不是「这个框不给脚本勾」。
//
// 三条纪律（与既有演练一致）：只用未登记端口＋临时 profile；端口先探空再起；跑完 taskkill /T ＋端口回读。
//
// 用法：node evidence/login-agreement-probe-2026-09-23/probe-login-agreement.mjs
// 产物：同目录 `probe-login-agreement.json` ＋ `shots/` 两张截图。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const say = (line) => process.stdout.write(`${line}\n`);

const BROWSER_PORT = 19935;
const PROXY_PORT = 19945;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

const { FORM_STATE_EXPRESSION, TAOBAO_LOGIN_URL } = await import(
  new URL('../../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs', import.meta.url).href
);

const report = {
  startedAt: new Date().toISOString(),
  browserPort: BROWSER_PORT,
  proxyPort: PROXY_PORT,
  loginUrl: TAOBAO_LOGIN_URL,
  steps: [],
};
const note = (name, detail) => { report.steps.push({ name, detail }); say(`  · ${name}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return `HTTP ${r.status}`;
  } catch { return null; }
}

async function evalOn(targetId, expression) {
  const r = await fetch(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`POST /eval → HTTP ${r.status}`);
  const payload = await r.json();
  return payload?.value;
}

async function clickPoint(targetId, x, y) {
  const r = await fetch(`${PROXY}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x, y }), signal: AbortSignal.timeout(15000) });
  return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
}

async function screenshot(targetId, name) {
  const r = await fetch(`${PROXY}/screenshot?target=${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const dir = path.join(import.meta.dirname, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return path.relative(REPO, file);
}

const readState = async (targetId) => JSON.parse(await evalOn(targetId, FORM_STATE_EXPRESSION));

const children = [];
let profile = null;

async function cleanup(reason) {
  say(`\n=== 释放（${reason}）`);
  report.release = { reason, killed: [] };
  for (const child of children) {
    if (!child.pid) continue;
    const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    report.release.killed.push({ pid: child.pid, taskkill: `${kill.status}` });
  }
  await sleep(2500);
  report.release.browserPortAfter = await portAlive(BROWSER_PORT);
  report.release.proxyPortAfter = await portAlive(PROXY_PORT);
  report.release.ok = report.release.browserPortAfter === null && report.release.proxyPortAfter === null;
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); report.release.profileRemoved = true; }
    catch (error) { report.release.profileRemoved = String(error.message).slice(0, 200); }
  }
  say(`  端口回读：浏览器=${report.release.browserPortAfter} 代理=${report.release.proxyPortAfter}；profile 删除=${report.release.profileRemoved}`);
}

try {
  const browserBefore = await portAlive(BROWSER_PORT);
  const proxyBefore = await portAlive(PROXY_PORT);
  note('前提：两个端口事先是空的', { browserBefore, proxyBefore });
  if (browserBefore !== null || proxyBefore !== null) throw new Error('端口已被占用 ⇒ 停手');

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'login-agreement-'));
  report.temporaryProfile = profile;
  say(`=== 起一次性实例：port=${BROWSER_PORT} profile=${profile}`);

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
  const proxy = spawn(NODE, [path.join(REPO, 'runtime/isolated-proxy/cdp-proxy.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CDP_PROXY_PORT: String(PROXY_PORT),
      CDP_BROWSER_PORT: String(BROWSER_PORT),
      CDP_BROWSER_ID: 'login-agreement-probe',
      CDP_BROWSER_LABEL: '一次性探针实例（跑完就释放）',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proxy);

  // 等浏览器与代理都就绪
  for (const [label, url] of [['调试端口', `http://127.0.0.1:${BROWSER_PORT}/json/version`], ['代理', `${PROXY}/targets`]]) {
    const deadline = Date.now() + 60000;
    let last = '';
    for (;;) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok) break; last = `HTTP ${r.status}`; }
      catch (error) { last = error.cause?.code ?? error.message; }
      if (Date.now() > deadline) throw new Error(`${label} 没就绪（${last}）`);
      await sleep(500);
    }
    note(`${label} 就绪`, 'ok');
  }

  // 开真登录页（与产品代码同一个 URL）
  const created = await fetch(`${PROXY}/new?url=${encodeURIComponent(TAOBAO_LOGIN_URL)}&label=taobao-login-probe&pinned=1`,
    { method: 'POST', signal: AbortSignal.timeout(20000) }).then((r) => r.json());
  const targetId = created.targetId;
  report.targetId = targetId;
  say(`  开了登录页 targetId=${targetId}`);
  await sleep(9000);   // 让前端框架渲染完（登录页是异步挂表单的）

  const before = await readState(targetId);
  report.stateBefore = before;
  report.shotBefore = await screenshot(targetId, '01-login-page-before');
  say('\n=== 第一步：登录页表单现状');
  say(`  href=${before.href}`);
  say(`  #fm-login-id      valueLen=${before.id?.valueLen} rect=${JSON.stringify(before.id?.rect)} visible=${before.id?.visible}`);
  say(`  #fm-login-password valueLen=${before.password?.valueLen} rect=${JSON.stringify(before.password?.rect)} visible=${before.password?.visible}`);
  say(`  #fm-agreement-checkbox checked=${before.agreement?.checked} rect=${JSON.stringify(before.agreement?.rect)} visible=${before.agreement?.visible}`);
  say(`  button.fm-submit  rect=${JSON.stringify(before.submit?.rect)} visible=${before.submit?.visible}`);
  say(`  sliderVisible=${before.sliderVisible} captchaInputVisible=${before.captchaInputVisible}`);

  if (!before.agreement) {
    note('结论：这个页面上根本没有 #fm-agreement-checkbox', '勾协议那一步在这份 DOM 上无从谈起');
  } else {
    const [x, y, w, h] = before.agreement.rect;
    const cx = x + Math.round(w / 2);
    const cy = y + Math.round(h / 2);
    report.agreementPoint = { x: cx, y: cy };
    say(`\n=== 第二步：那个点位上到底是哪个元素（判「点生效没」用这个，不用页面文本）`);
    const at = await evalOn(targetId, `(() => {
      const el = document.elementFromPoint(${cx}, ${cy});
      if (!el) return JSON.stringify({ none: true });
      return JSON.stringify({
        tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120),
        text: (el.textContent || '').trim().slice(0, 40),
        isAgreementItself: el.id === 'fm-agreement-checkbox',
      });
    })()`);
    report.elementAtPoint = JSON.parse(at);
    say(`  elementFromPoint(${cx}, ${cy}) = ${at}`);

    say('\n=== 第三步：用与产品代码同一个手法点一次（/clickPoint）');
    report.clickResult = await clickPoint(targetId, cx, cy);
    await sleep(1500);
    const afterClick = await readState(targetId);
    report.stateAfterClick = afterClick;
    report.shotAfterClick = await screenshot(targetId, '02-after-coordinate-click');
    say(`  点完回读 checked=${afterClick.agreement?.checked} rect=${JSON.stringify(afterClick.agreement?.rect)}`);

    if (afterClick.agreement?.checked === false) {
      say('\n=== 第四步（对照）：绕开坐标，直接 el.click()');
      const domClick = await evalOn(targetId, `(() => {
        const el = document.querySelector('#fm-agreement-checkbox');
        if (!el) return 'no-element';
        el.click();
        return JSON.stringify({ checkedAfterDomClick: !!el.checked, cls: String(el.className) });
      })()`);
      report.domClickResult = domClick;
      await sleep(1200);
      const afterDom = await readState(targetId);
      report.stateAfterDomClick = afterDom;
      report.shotAfterDomClick = await screenshot(targetId, '03-after-dom-click');
      say(`  DOM 直点回读 checked=${afterDom.agreement?.checked}`);
    }
  }

  // 判据
  const b = before.agreement;
  const c = report.stateAfterClick?.agreement;
  report.verdict = {
    checkboxExists: Boolean(b),
    checkboxVisible: Boolean(b?.visible),
    rect: b?.rect ?? null,
    checkedInitially: b?.checked ?? null,
    checkedAfterCoordinateClick: c?.checked ?? null,
    coordinateClickWorked: Boolean(b) && c ? c.checked !== b.checked : null,
    checkedAfterDomClick: report.stateAfterDomClick?.agreement?.checked ?? null,
    domClickWorked: report.stateAfterDomClick?.agreement?.checked !== undefined && b
      ? report.stateAfterDomClick.agreement.checked !== b.checked
      : null,
  };
  say(`\n=== 结论：${JSON.stringify(report.verdict)}`);
} catch (error) {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  say(`\n!! 探针中断：${error.message}`);
} finally {
  await cleanup(report.fatal ? '中断也要释放' : '探针结束');
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(import.meta.dirname, 'probe-login-agreement.json'), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  say(`明细：evidence/login-agreement-probe-2026-09-23/probe-login-agreement.json`);
  process.exitCode = report.fatal ? 1 : 0;
}
