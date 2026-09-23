// 一次性实例实验 v2（2026-09-23）：**抓「填了又被擦掉」的那个瞬间**。
//
// 为什么需要 v2：v1（probe-throwaway-autofill.mjs）已经排除了「页面不正常」「点击没落到框上」
// 「手势不够真实」三条，但它有个方法论缺陷 —— 判据是「2 秒后读一次」。而 `logins.date_last_used`
// 的时间线显示：09-22、09-23 每次我们跑登录，这条凭据的「最后使用」都被刷新了。
// 如果 Chromium 记账的时机是「**决定**把这条凭据填进表单」，那就意味着
// **值真的落进过输入框，随后被页面自己的 JS 擦掉**，而所有「两秒后读一次」的探针都正好错过它。
//
// 所以 v2 只做一件事：把观测频率提到 25ms，并且直接挂钩 `HTMLInputElement.prototype.value` 的 setter，
// 记录**每一次写入**（含调用栈片段）。判据分三种，互斥：
//   · 全程 valueLen=0 且 :autofill 恒 false ⇒ Chromium 根本没填（问题在「为什么不出手」）
//   · 出现过 valueLen>0 / :autofill=true，随后归零 ⇒ **填了又被擦**（问题在「谁擦的」，修法完全不同）
//   · 出现过 `setter:fm-login-id` 的页面写入 ⇒ 直接点名擦除者及其调用栈
//
// v2 同时补齐 v1 的一处不公平：走代理的登录流程每次建 session 都会开
// `Emulation.setFocusEmulationEnabled`（cdp-proxy.mjs:215），v1 的裸 CDP 没开。
// 这里补上 `setFocusEmulationEnabled` + `Page.bringToFront`，让对照条件一致。
//
// 用法：node probe-throwaway-autofill2.mjs [--source=D:/...] [--label=...] [--disable-sync]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROBE_PORT = 19801;
const LOGIN_URL = 'https://havanalogin.taobao.com/mini_login.htm?lang=zh_cn&appName=taobao'
  + '&appEntrance=sycm_new&styleType=vertical&bizParams=&notLoadSsoView=true&notKeepLogin=false'
  + '&isMobile=false&cssUrl=https://g.alicdn.com/dt/sycm-login-css/0.0.1/sycm-iframe-style.css'
  + '&returnUrl=https://sycm.taobao.com/portal/home.htm&rnd=0.1234567890';
const SHOTS = new URL('./shots/', import.meta.url).pathname.replace(/^\//u, '');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((v) => v.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SOURCE = arg('source', 'D:/Retire/edge-daily-report-profile');
const LABEL = arg('label', 'probe2');
const DISABLE_SYNC = argv.includes('--disable-sync');
// 对照组用的登录地址。默认是淘宝那条；换成别家（例如 https://github.com/login）
// 就能回答「是这一页在对抗自动填充，还是这版 Edge 根本不填」。
const URL_OVERRIDE = arg('url', null);
const ID_SEL = arg('idSel', '#fm-login-id');
const PWD_SEL = arg('pwdSel', '#fm-login-password');
const TARGET_URL = URL_OVERRIDE ?? LOGIN_URL;
const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => console.log(...a);

// 采样器：在**任何页面脚本之前**注入（Page.addScriptToEvaluateOnNewDocument）。
// 只记「状态变化」的样本，避免 25ms × 30s 灌出上千条噪声。
const RECORDER = `(() => {
  const T0 = Date.now();
  const log = [];
  window.__fillLog = log;
  let last = null;
  const sample = (why) => {
    const id = document.querySelector('${ID_SEL}');
    const pwd = document.querySelector('${PWD_SEL}');
    const now = {
      why,
      t: Date.now() - T0,
      idLen: id ? id.value.length : -1,
      idAf: id ? id.matches(':autofill') : null,
      pwdLen: pwd ? pwd.value.length : -1,
      pwdAf: pwd ? pwd.matches(':autofill') : null,
      focused: document.hasFocus(),
      vis: document.visibilityState,
    };
    const key = [now.idLen, now.idAf, now.pwdLen, now.pwdAf].join('|');
    if (key !== last || why !== 'poll') { last = key; log.push(now); }
  };
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) {
        if (this.id === '${ID_SEL.replace('#', '')}' || this.id === '${PWD_SEL.replace('#', '')}') {
          log.push({ why: 'setter:' + this.id, t: Date.now() - T0, len: String(v).length,
            stack: String(new Error().stack || '').split('\\n').slice(1, 5).map((s) => s.trim()).join(' <- ') });
        }
        return d.set.call(this, v);
      },
    });
  } catch (e) { log.push({ why: 'hook-failed', error: String(e && e.message || e) }); }
  document.addEventListener('DOMContentLoaded', () => sample('DOMContentLoaded'));
  window.addEventListener('load', () => sample('load'));
  const timer = setInterval(() => { sample('poll'); if (Date.now() - T0 > 30000) clearInterval(timer); }, 25);
})()`;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m); }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: { message: `timeout ${method}` } }); } }, 20000);
    });
  }
}

function stageProfile(source, target) {
  fs.mkdirSync(path.join(target, 'Default'), { recursive: true });
  const wanted = ['Local State', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Login Data',
    'Default/Login Data For Account', 'Default/Login Data-wal', 'Default/Login Data-shm'];
  return wanted.filter((rel) => {
    const from = path.join(source, rel);
    if (!fs.existsSync(from)) return false;
    try { fs.copyFileSync(from, path.join(target, rel)); return true; } catch { return false; }
  });
}

function taobaoCredentialCount(profileDir) {
  const file = path.join(profileDir, 'Default', 'Login Data');
  if (!fs.existsSync(file)) return -1;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const n = db.prepare("SELECT count(*) AS n FROM logins WHERE signon_realm LIKE '%taobao.com%'").get().n;
    db.close();
    return n;
  } catch { return -2; }
}

const root = fs.mkdtempSync('D:/Retire/tmp-autofill2-');
const profile = path.join(root, 'profile');
log(`实验 ${LABEL}：源=${SOURCE}  --disable-sync=${DISABLE_SYNC}`);
log(`临时 profile=${profile}`);
log(`复制：${stageProfile(SOURCE, profile).join(', ')}`);
log(`复制件里的淘宝凭据：${taobaoCredentialCount(profile)} 条`);

try {
  const res = await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
  if (res.ok) { log(`端口 ${PROBE_PORT} 已被占用 —— 不抢占，退出`); process.exit(2); }
} catch { /* 空 */ }

const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PROBE_PORT}`, '--no-first-run',
  '--no-default-browser-check', ...(DISABLE_SYNC ? ['--disable-sync'] : []), 'about:blank'];
log(`\n起一次性实例：${args.join(' ')}`);
const child = spawn(EDGE, args, { stdio: 'ignore' });
const pid = child.pid;
log(`pid=${pid}`);

let version = null;
for (let i = 0; i < 40 && !version; i += 1) {
  await delay(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) version = await r.json();
  } catch { /* 未就绪 */ }
}

let exitCode = 0;
const facts = { everNonZero: false, everAutofill: false, pageWrites: [], lastState: null };
try {
  if (!version) throw new Error('实例 20s 内没起来');
  log(`起来了：${version.Browser}`);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  if (!sessionId) throw new Error('attach 失败');

  // 与 cdp-proxy 的 ensureSession 保持一致：开焦点模拟（v1 少了这一步）
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Target.activateTarget', { targetId });
  await cdp.send('Page.bringToFront', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }, sessionId);

  const evalOn = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const clickPoint = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (r.result?.data) { fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64')); log(`   截图 → shots/${name}`); }
  };

  log(`\n导航 → ${TARGET_URL.slice(0, 80)}…`);
  await cdp.send('Page.navigate', { url: TARGET_URL }, sessionId);
  await delay(12000);   // 采样器自己跑 12 秒，覆盖「加载期填充」的全部窗口

  const dump = (entries, title) => {
    log(`\n=== ${title}（${entries.length} 条状态变化）===`);
    for (const e of entries.slice(0, 40)) {
      if (e.why?.startsWith('setter:')) {
        facts.pageWrites.push(e);
        log(`  [${e.t}ms] ${e.why} 写入长度=${e.len}\n        调用栈：${e.stack}`);
        continue;
      }
      if ((e.idLen ?? 0) > 0 || e.idAf || (e.pwdLen ?? 0) > 0 || e.pwdAf) {
        facts.everNonZero = true;
        if (e.idAf || e.pwdAf) facts.everAutofill = true;
      }
      log(`  [${e.t}ms] ${e.why}  idLen=${e.idLen} idAf=${e.idAf} pwdLen=${e.pwdLen} pwdAf=${e.pwdAf} focused=${e.focused} vis=${e.vis}`);
    }
    if (entries.length > 40) log(`  …（共 ${entries.length} 条，只打印前 40 条）`);
  };

  const log1 = JSON.parse(await evalOn('JSON.stringify(window.__fillLog || [])'));
  facts.lastState = await evalOn(`(() => { const e = document.querySelector(${JSON.stringify(ID_SEL)}); const p = document.querySelector(${JSON.stringify(PWD_SEL)}); return JSON.stringify({ idLen: e ? e.value.length : -1, idAf: e ? e.matches(':autofill') : null, pwdLen: p ? p.value.length : -1, focused: document.hasFocus(), vis: document.visibilityState }); })()`);
  dump(log1, '从导航到 +12s 的全部取值变化');
  log(`  +12s 终态：${facts.lastState}`);
  await shot(`${LABEL}-1-onload.png`);

  log('\n再点一次用户名框（手势），然后读最后 6 秒的采样');
  const r = await evalOn(`(() => { const e = document.querySelector(${JSON.stringify(ID_SEL)}); if (!e) return ''; const b = e.getBoundingClientRect(); return JSON.stringify([b.x + b.width / 2, b.y + b.height / 2]); })()`);
  if (r) {
    const [x, y] = JSON.parse(r);
    await clickPoint(x, y);
    await delay(6000);
    const log2 = JSON.parse(await evalOn('JSON.stringify((window.__fillLog || []).slice(-25))'));
    dump(log2, '手势之后最后 25 条');
    await shot(`${LABEL}-2-after-click.png`);
  }

  log('\n=== 结论 ===');
  if (facts.pageWrites.length > 0) log(`  · 页面自己写入了输入框 ${facts.pageWrites.length} 次（见上面的调用栈）`);
  if (facts.everAutofill || facts.everNonZero) {
    log('  · **出现过非空/已填充状态** ⇒ Chromium 确实出手填过，随后被擦掉（或只短暂存在）');
  } else {
    log('  · 全程未出现任何非空值、也未出现 :autofill ⇒ Chromium 从出手环节就没发生');
  }
} catch (error) {
  exitCode = 1;
  log(`\n实验异常：${String(error?.message ?? error)}`);
} finally {
  log(`\n回收：taskkill /PID ${pid} /T /F`);
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  await delay(2500);
  try {
    await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    log(`端口 ${PROBE_PORT} 仍在响应 —— 未回收干净，请人工检查`); exitCode = 3;
  } catch { log(`端口 ${PROBE_PORT} 已释放 ✓`); }
  try { fs.rmSync(root, { recursive: true, force: true }); log(`临时 profile 已删：${root}`); }
  catch (e) { log(`临时 profile 删不掉（${e.code}）：${root}`); }
}
process.exit(exitCode);
