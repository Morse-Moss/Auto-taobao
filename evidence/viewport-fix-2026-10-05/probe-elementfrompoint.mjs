// 一次性实例只读探针：回答「hitCheckExpression 为什么 25 点全不命中」
//
// 只做三件事的取证（全部只读，无点击、无导航副作用、无写请求）：
//   1. 页面里有哪些「文档作用域」（外层 + 同源 iframe），各自的 window 是不是外层 window；
//   2. 每个作用域里的「下载报表」叶节点，其 ownerDocument / defaultView / elementFromPoint 可用性；
//   3. 同一批采样点，分别用 `document.elementFromPoint` 与「元素自己那个窗口的 elementFromPoint」
//      判命中，两套结论是否一致、各命中几个。
//
// 铁律（照 throwaway-instance-write-path-rehearsal 技能）：
//   · 端口必须未登记且空闲（调用方先跑 check-ports.mjs）；
//   · profile 是一次性临时目录，不与任何登记实例重叠；
//   · 脚本自己起、自己杀，释放判据是「端口回读」而不是 taskkill 退出码；
//   · 全程落盘一份转录，退出码跟着断言走。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 19997;
const PROFILE = 'D:/Retire/sycm-automation/tmp/probe-efp-20261005';
const OUT_DIR = 'D:/Retire/sycm-automation/tmp/probe-efp';
const TARGET_URL = 'https://one.alimama.com/index.html#!/report/account'
  + '?rptType=account&startTime=2026-10-04&endTime=2026-10-04&effectEqual=30'
  + '&bizCodeIn=%5B%22onebpSearch%22%2C%22onebpDisplay%22%5D&granularity=day';

const lines = [];
const log = (s) => { lines.push(String(s)); console.log(String(s)); };

// ------------------------------------------------------------------ CDP 最小封装
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJsonVersion(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { last = await r.json(); return last; }
    } catch (e) { last = String(e).slice(0, 80); }
    await sleep(500);
  }
  return null;
}

async function portState(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(900);
    s.on('connect', () => { s.destroy(); res('OCCUPIED'); });
    s.on('error', () => res('FREE'));
    s.on('timeout', () => { s.destroy(); res('FREE(timeout)'); });
  });
}

// ------------------------------------------------------------------ 测量表达式
const EXPR = `(() => {
  const r2 = (r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  const describe = (node) => node ? {
    tag: node.tagName, id: node.id || null, cls: String(node.className || '').slice(0, 60),
  } : null;
  const scopes = [{ name: 'outer', doc: document, win: window, src: null, rect: null }];
  for (const f of document.querySelectorAll('iframe')) {
    const entry = { name: 'iframe', src: f.src || '(about:blank)', rect: r2(f.getBoundingClientRect()) };
    try {
      if (f.contentDocument && f.contentDocument.body) {
        entry.doc = f.contentDocument;
        entry.win = f.contentWindow || f.contentDocument.defaultView;
      } else {
        entry.name = 'iframe-no-doc';
      }
    } catch (e) { entry.name = 'iframe-cross-origin'; entry.err = String(e).slice(0, 60); }
    scopes.push(entry);
  }
  const scopeInfo = scopes.map((s) => ({
    name: s.name, src: s.src, rect: s.rect,
    hasDoc: !!s.doc,
    winIsOuterWindow: s.win ? (s.win === window) : null,
    winInner: s.win ? [s.win.innerWidth, s.win.innerHeight] : null,
    hasEFP: s.win ? typeof s.win.elementFromPoint : null,
  }));
  const insets = [0.5, 0.25, 0.75, 0.12, 0.88];
  const hits = [];
  for (const s of scopes) {
    if (!s.doc) continue;
    let cands = [];
    try {
      cands = [...s.doc.querySelectorAll('button,a,div,span')]
        .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载报表');
    } catch (e) { continue; }
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const doc = el.ownerDocument;
      const win = (doc && doc.defaultView) || window;
      const selfOf = (node) => !!node && (node === el || el.contains(node) || node.contains(el));
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      let outerHit = null, outerErr = null, ownHit = null, ownErr = null;
      try { outerHit = describe(document.elementFromPoint(cx, cy)); } catch (e) { outerErr = String(e).slice(0, 60); }
      try { ownHit = describe(win.elementFromPoint(cx, cy)); } catch (e) { ownErr = String(e).slice(0, 60); }
      // 两套 25 点采样
      const sample = (effpFn, w) => {
        let inVp = 0, inside = 0, nonNull = 0;
        for (const fy of insets) {
          for (const fx of insets) {
            const x = Math.round(r.x + r.width * fx);
            const y = Math.round(r.y + r.height * fy);
            if (x < 0 || x >= w.innerWidth || y < 0 || y >= w.innerHeight) continue;
            inVp += 1;
            const h = effpFn(x, y);
            if (h) nonNull += 1;
            if (selfOf(h)) inside += 1;
          }
        }
        return { inVp, inside, nonNull };
      };
      let outerSample = null, ownSample = null;
      try { outerSample = sample((x, y) => document.elementFromPoint(x, y), window); } catch (e) { outerSample = { err: String(e).slice(0, 60) }; }
      try { ownSample = sample((x, y) => win.elementFromPoint(x, y), win); } catch (e) { ownSample = { err: String(e).slice(0, 60) }; }
      hits.push({
        scope: s.name,
        tag: el.tagName,
        rect: r2(r),
        center: [cx, cy],
        ownerDocIsOuterDoc: doc === document,
        ownerWinIsOuterWindow: win === window,
        ownerWinInner: [win.innerWidth, win.innerHeight],
        ownerWinHasEFP: typeof win.elementFromPoint,
        outerHit, outerErr,
        ownHit, ownErr,
        outerSelf: selfOf(document.elementFromPoint ? (() => { try { return document.elementFromPoint(cx, cy); } catch { return null; } })() : null),
        outerSample, ownSample,
      });
    }
  }
  return JSON.stringify({
    url: location.href, title: document.title,
    outerViewport: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
    scopeInfo, hits,
  });
})()`;

// ------------------------------------------------------------------ 主流程
let child = null;
let report = { fatal: null };
const checks = [];

function finish() {
  const ok = checks.length > 0 && checks.every((c) => c.ok) && !report.fatal;
  log('');
  log('===== 逐项断言 =====');
  for (const c of checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  if (report.fatal) log(`  FATAL ${report.fatal}`);
  fs.writeFileSync(path.join(OUT_DIR, 'transcript.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
  process.exitCode = ok ? 0 : 1;
  // 子进程的 stdio 管道可能还挂着，显式退出，别让脚本卡在事件循环里
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}

try {
  log(`一次性实例：浏览器端口 :${PORT}（未登记）｜profile=${PROFILE}`);
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--window-size=1528,732',
    '--force-device-scale-factor=1.25',
    'about:blank',
  ];
  log('argv: ' + [EDGE, ...args].join(' '));
  child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += String(d); });
  child.on('exit', (code, sig) => { log(`[edge] exit code=${code} signal=${sig}`); });

  const version = await waitJsonVersion(60000);
  checks.push({ ok: !!version, name: '浏览器调试端口 60s 内就绪', detail: version ? (version.Browser || 'ok') : `未就绪；stderr=${stderrBuf.slice(0, 300)}` });
  if (!version) throw new Error('调试端口未就绪');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const pages = list.filter((t) => t.type === 'page');
  log(`页面目标 ${pages.length} 个：` + pages.map((p) => p.url.slice(0, 60)).join(' | '));
  const page = pages.find((p) => p.url.includes('one.alimama.com')) || pages.find((p) => p.url === 'about:blank') || pages[0];
  checks.push({ ok: !!page, name: '找到可用的 page 目标' });
  if (!page) throw new Error('没有 page 目标');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  log(`导航到 ${TARGET_URL}`);
  await cdp.send('Page.navigate', { url: TARGET_URL });

  // 等页面 + SPA 渲染：最多 4 轮 × 15s，直到出现「下载报表」
  let measured = null;
  for (let i = 1; i <= 4; i += 1) {
    await sleep(15000);
    const r = await cdp.send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: false });
    const v = JSON.parse(r.result.value);
    log(`[第 ${i} 轮] url=${v.url.slice(0, 100)}｜title=${v.title}｜视口=${JSON.stringify(v.outerViewport)}｜dpr=${v.dpr}｜候选 ${v.hits.length} 个`);
    measured = v;
    if (v.hits.length > 0) break;
  }
  report.measure = measured;
  checks.push({ ok: !!(measured && measured.hits.length > 0), name: '页面上找到「下载报表」候选', detail: measured ? `候选 ${measured.hits.length} 个` : '未测量' });

  if (measured) {
    log('');
    log('===== 文档作用域 =====');
    for (const s of measured.scopeInfo) log('  ' + JSON.stringify(s));
    log('');
    log('===== 候选详情 =====');
    for (const h of measured.hits) log('  ' + JSON.stringify(h));
  }

  cdp.close();
} catch (e) {
  report.fatal = String(e && e.stack ? e.stack : e).slice(0, 800);
  log('FATAL: ' + report.fatal);
} finally {
  if (child && child.pid) {
    const k = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    log(`[收尾] taskkill 退出码=${k.status}（这不是释放判据）`);
  }
  await sleep(2500);
  const st = await portState(PORT);
  log(`[收尾] 端口回读 ${PORT} = ${st}`);
  report.portAfter = st;
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); log('[收尾] 临时 profile 已删除'); report.profileRemoved = true; }
  catch (e) { log('[收尾] 临时 profile 删不掉：' + String(e).slice(0, 120)); report.profileRemoved = false; }
  finish();
}
