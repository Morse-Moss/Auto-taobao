// 一次性实例真机探针（2026-10-06 复跑）：**登录页那个「同意协议」勾选框，今天到底长什么样**。
//
// 为什么要重跑 09-23 那次：09-23 的结论是「勾选框可见（16×16）、坐标点击一点就 false→true」，
// 而 2026-10-05 的真跑回执里是 `agreementChecked:false` ＋ `agreement.text:null`
// （文本取不到 ⇒ `#fm-agreement` 那个节点找不着了）＋ `submitOutcome:NONE`
// ⇒ 页面在那之后**改过**，09-23 的结论不能直接拿来当 10-06 的依据。
//
// 本文件只回答四件事（全部是**测量**，不是推断）：
//   ① `#fm-agreement-checkbox` 在不在、可不可见（rect / computedStyle / pointer-events）；
//   ② `#fm-agreement` 在不在、协议那一行的文本从哪个节点能取到；
//   ③ 勾选框中心点上 `elementFromPoint` 返回的是**谁**（判「点得中」用这个，不用页面文本）；
//   ④ 用**与产品代码同一个手法**（`/clickPoint` 真机坐标点击）点一次，checked 变没变；
//      没变的话再依次试「点可见 label 的中心」与「DOM 直点」，并各自回读。
//
// 三条纪律（与既有演练一致）：只用未登记端口＋临时 profile；端口先探空再起；跑完 taskkill /T ＋端口回读。
//
// 用法：node evidence/login-agreement-probe-2026-10-06/probe-login-agreement.mjs
// 产物：同目录 `probe-login-agreement.json` ＋ `shots/`。
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

const { FORM_STATE_EXPRESSION, LOGIN_URL_CANDIDATES } = await import(
  new URL('../../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs', import.meta.url).href
);

// 登录页那一行的结构：一次问全，免得来回猜。
const DOM_SHAPE = `(() => {
  const info = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 120),
      text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents,
    };
  };
  const box = document.querySelector('#fm-agreement-checkbox');
  const chain = [];
  for (let el = box, i = 0; el && i < 5; i += 1, el = el.parentElement) {
    chain.push({ tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 120) });
  }
  const labelFor = box && box.id ? document.querySelector('label[for="' + CSS.escape(box.id) + '"]') : null;
  const closestLabel = box ? box.closest('label') : null;
  // 「画在屏幕上的那个框」——不是 input 本身时，它是谁。
  let painter = null;
  if (box) {
    const r = box.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      painter = hit ? { tag: hit.tagName, id: hit.id || '', cls: String(hit.className || '').slice(0, 120),
        isTheInput: hit === box } : null;
    }
  }
  return JSON.stringify({
    href: location.href,
    title: document.title,
    hasAgreementCheckbox: !!box,
    hasAgreementLine: !!document.querySelector('#fm-agreement'),
    checkbox: info(box),
    ancestorChain: chain,
    labelFor: info(labelFor),
    closestLabel: info(closestLabel),
    elementAtCheckboxCenter: painter,
    agreementLineText: (() => {
      const line = box ? (box.closest('label') || box.parentElement) : null;
      return line ? String(line.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : null;
    })(),
    checkboxesOnPage: [...document.querySelectorAll('input[type=checkbox]')]
      .map((el) => ({ id: el.id || '', cls: String(el.className || '').slice(0, 60), checked: !!el.checked })),
    pageTextHead: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
  });
})()`;

const report = {
  startedAt: new Date().toISOString(),
  browserPort: BROWSER_PORT,
  proxyPort: PROXY_PORT,
  loginCandidates: LOGIN_URL_CANDIDATES,
  steps: [],
};
const note = (name, detail) => {
  report.steps.push({ name, detail });
  say(`  · ${name}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return `HTTP ${r.status}`;
  } catch { return null; }
}

async function evalOn(targetId, expression) {
  const r = await fetch(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression, signal: AbortSignal.timeout(20000) });
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
  const r = await fetch(`${PROXY}/screenshot?target=${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) return null;
  const dir = path.join(import.meta.dirname, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return path.relative(REPO, file);
}

const readState = async (targetId) => JSON.parse(await evalOn(targetId, FORM_STATE_EXPRESSION));
const readShape = async (targetId) => JSON.parse(await evalOn(targetId, DOM_SHAPE));

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

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'login-agreement-1006-'));
  report.temporaryProfile = profile;
  say(`=== 起一次性实例：port=${BROWSER_PORT} profile=${profile}`);

  const browser = spawn(NODE, [path.join(REPO, 'runtime/start-project-browser.mjs')], {
    cwd: REPO,
    env: { ...process.env, PROJECT_BROWSER_PORT: String(BROWSER_PORT),
      PROJECT_BROWSER_PROFILE: profile, PROJECT_BROWSER_URL: 'about:blank' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(browser);
  const proxy = spawn(NODE, [path.join(REPO, 'runtime/isolated-proxy/cdp-proxy.mjs')], {
    cwd: REPO,
    env: { ...process.env, CDP_PROXY_PORT: String(PROXY_PORT), CDP_BROWSER_PORT: String(BROWSER_PORT),
      CDP_BROWSER_ID: 'login-agreement-probe-1006', CDP_BROWSER_LABEL: '一次性探针实例（跑完就释放）' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proxy);

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

  // 两个候选地址各开一页：10-05 那次跑的是 havanaone，而它上面的 `#fm-agreement` 取不到文本。
  report.perCandidate = [];
  for (const candidate of LOGIN_URL_CANDIDATES) {
    say(`\n########## 候选 ${candidate.id}：${candidate.url}`);
    const created = await fetch(`${PROXY}/new?url=${encodeURIComponent(candidate.url)}&label=probe-${candidate.id}&pinned=1`,
      { method: 'POST', signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    const targetId = created.targetId;
    await sleep(9000);

    const entry = { candidate, targetId };
    entry.stateBefore = await readState(targetId);
    entry.shape = await readShape(targetId);
    entry.shotBefore = await screenshot(targetId, `01-${candidate.id}-before`);

    say(`  href=${entry.shape.href}`);
    say(`  #fm-login-id=${JSON.stringify(entry.stateBefore.id?.rect)} visible=${entry.stateBefore.id?.visible}`
      + `  #fm-login-password visible=${entry.stateBefore.password?.visible}`
      + `  button.fm-submit=${JSON.stringify(entry.stateBefore.submit?.rect)}`);
    say(`  #fm-agreement-checkbox 存在=${entry.shape.hasAgreementCheckbox}`
      + ` rect=${JSON.stringify(entry.shape.checkbox?.rect)} display=${entry.shape.checkbox?.display}`
      + ` visibility=${entry.shape.checkbox?.visibility} opacity=${entry.shape.checkbox?.opacity}`
      + ` pointerEvents=${entry.shape.checkbox?.pointerEvents}`);
    say(`  #fm-agreement（协议那一行）存在=${entry.shape.hasAgreementLine}`);
    say(`  祖先链=${JSON.stringify(entry.shape.ancestorChain)}`);
    say(`  label[for]=${JSON.stringify(entry.shape.labelFor)}`);
    say(`  closest('label')=${JSON.stringify(entry.shape.closestLabel)}`);
    say(`  页面上所有 checkbox=${JSON.stringify(entry.shape.checkboxesOnPage)}`);

    const box = entry.stateBefore.agreement;
    if (!box) {
      note(`${candidate.id}：页面上没有 #fm-agreement-checkbox`, '勾协议那一步在这份 DOM 上无从谈起');
      report.perCandidate.push(entry);
      continue;
    }

    const [x, y, w, h] = box.rect;
    const cx = x + Math.round(w / 2);
    const cy = y + Math.round(h / 2);
    entry.checkboxPoint = { x: cx, y: cy };
    entry.elementAtCheckboxCenter = entry.shape.elementAtCheckboxCenter;

    entry.clickCheckboxResult = await clickPoint(targetId, cx, cy);
    await sleep(1500);
    entry.stateAfterCheckboxClick = await readState(targetId);
    entry.shotAfterCheckboxClick = await screenshot(targetId, `02-${candidate.id}-after-checkbox-click`);
    say(`  坐标点击(${cx},${cy}) 后 checked=${entry.stateAfterCheckboxClick.agreement?.checked}`);

    if (entry.stateAfterCheckboxClick.agreement?.checked !== true) {
      // 退一步：点「画在屏幕上的那个框」——label[for] / closest('label') / 可见祖先。
      const fallback = [entry.shape.labelFor, entry.shape.closestLabel]
        .filter((el) => el && el.rect[2] > 0 && el.rect[3] > 0);
      if (fallback.length > 0) {
        const target = fallback[0];
        const lx = target.rect[0] + Math.round(target.rect[2] / 2);
        const ly = target.rect[1] + Math.round(target.rect[3] / 2);
        entry.labelPoint = { x: lx, y: ly, of: target.tag };
        entry.clickLabelResult = await clickPoint(targetId, lx, ly);
        await sleep(1500);
        entry.stateAfterLabelClick = await readState(targetId);
        say(`  坐标点击可见 label(${lx},${ly}) 后 checked=${entry.stateAfterLabelClick.agreement?.checked}`);
      }
    }

    if (entry.stateAfterLabelClick?.agreement?.checked !== true
      && entry.stateAfterCheckboxClick.agreement?.checked !== true) {
      const domClick = await evalOn(targetId, `(() => {
        const el = document.querySelector('#fm-agreement-checkbox');
        if (!el) return JSON.stringify({ noElement: true });
        el.click();
        return JSON.stringify({ checkedAfterDomClick: !!el.checked });
      })()`);
      entry.domClickResult = JSON.parse(domClick);
      await sleep(1200);
      entry.stateAfterDomClick = await readState(targetId);
      say(`  DOM 直点后 checked=${entry.stateAfterDomClick.agreement?.checked}`);
    }

    report.perCandidate.push(entry);
  }
} catch (error) {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  say(`\n!! 探针中断：${error.message}`);
} finally {
  await cleanup(report.fatal ? '中断也要释放' : '探针结束');
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(import.meta.dirname, 'probe-login-agreement.json'), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  say('明细：evidence/login-agreement-probe-2026-10-06/probe-login-agreement.json');
  process.exitCode = report.fatal ? 1 : 0;
}
