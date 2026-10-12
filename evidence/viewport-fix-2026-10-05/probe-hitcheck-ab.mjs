// 真机 A/B：在同一现场跑「旧写法」与「修复后写法」两版**真实判据源码**
//
// 目标：把「8 家店全停在 promotion-submit」的原因与修法，在同一次现场里当场复现并当场证伪。
//   · broken 版 = hitCheckExpression 的源码里 `doc.elementFromPoint` 换回 `win.elementFromPoint`
//     （即 b29f64c~1ff609e 那三笔的实际行为）→ 期望 ok=false、insideSamples=0
//   · fixed  版 = 当前 HEAD 的 hitCheckExpression                              → 期望 ok=true、insideSamples>0
//
// 全程只读：只做 导航 / locate（打 data- 标记）/ scrollIntoView / hitCheck（elementFromPoint）。
// 不点击、不提交、不写任何外部系统。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  hitCheckExpression,
  scrollIntoViewExpression,
} from 'file:///D:/Retire/sycm-automation/skills/sycm-alimama-daily-report/scripts/collect-core.mjs';
// 定位表达式在 collect-promotion-report.mjs 里；该文件有 invokedDirectly 保护，import 不会跑 CLI 主体。
import {
  LOCATE_DOWNLOAD_REPORT_EXPRESSION,
} from 'file:///D:/Retire/sycm-automation/skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 19997;
const PROFILE = 'D:/Retire/sycm-automation/tmp/probe-efp-20261005';
const OUT_DIR = 'D:/Retire/sycm-automation/tmp/probe-efp';
const SEL = '[data-collect-alimama-download="1"]';
const TARGET_URL = 'https://one.alimama.com/index.html#!/report/account'
  + '?rptType=account&startTime=2026-10-04&endTime=2026-10-04&effectEqual=30'
  + '&bizCodeIn=%5B%22onebpSearch%22%2C%22onebpDisplay%22%5D&granularity=day';

const lines = [];
const log = (s) => { lines.push(String(s)); console.log(String(s)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('页面内抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function waitJsonVersion(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
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

// 「旧写法」：把命中判据里的 doc.elementFromPoint 换回 win.elementFromPoint（就是那三笔的实际行为）
const FIXED_SRC = hitCheckExpression(SEL);
const BROKEN_SRC = FIXED_SRC.replace(/doc\.elementFromPoint/g, 'win.elementFromPoint');
const replaced = (FIXED_SRC.match(/doc\.elementFromPoint/g) || []).length;

let child = null;
const report = { fatal: null };
const checks = [];

function finish() {
  const ok = checks.length > 0 && checks.every((c) => c.ok) && !report.fatal;
  log('');
  log('===== 逐项断言 =====');
  for (const c of checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  if (report.fatal) log(`  FATAL ${report.fatal}`);
  fs.writeFileSync(path.join(OUT_DIR, 'verify-transcript.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'verify-report.json'), JSON.stringify(report, null, 1), 'utf8');
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}

try {
  log(`一次性实例（真机 A/B）：浏览器端口 :${PORT}（未登记）｜profile=${PROFILE}`);
  log(`判据源码：broken 版替换了 ${replaced} 处 doc.elementFromPoint → win.elementFromPoint`);
  checks.push({ ok: replaced >= 2, name: 'broken 版确实只改了命中判据那几处', detail: `替换 ${replaced} 处` });

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--window-size=1528,732',
    '--force-device-scale-factor=1.25',
    'about:blank',
  ];
  child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += String(d); });

  const version = await waitJsonVersion(60000);
  checks.push({ ok: !!version, name: '浏览器调试端口 60s 内就绪', detail: version ? version.Browser : `未就绪；stderr=${stderrBuf.slice(0, 200)}` });
  if (!version) throw new Error('调试端口未就绪');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const pages = list.filter((t) => t.type === 'page');
  const page = pages.find((p) => p.url.includes('one.alimama.com')) || pages.find((p) => p.url === 'about:blank') || pages[0];
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  log(`导航到 ${TARGET_URL}`);
  await cdp.send('Page.navigate', { url: TARGET_URL });

  // 等页面渲染出「下载报表」，最多 5 轮 × 12s
  let locate = null;
  let last = null;
  for (let i = 1; i <= 5; i += 1) {
    await sleep(12000);
    const info = JSON.parse(await cdp.eval(
      `JSON.stringify({url: location.href, title: document.title, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio})`));
    last = info;
    locate = JSON.parse(await cdp.eval(LOCATE_DOWNLOAD_REPORT_EXPRESSION));
    log(`[第 ${i} 轮] url=${info.url.slice(0, 90)}｜title=${info.title}｜视口=${info.iw}x${info.ih}/dpr${info.dpr}｜候选=${locate.found}`);
    if (locate.found > 0) break;
  }
  report.page = last;
  report.locate = locate;
  checks.push({ ok: locate && locate.found > 0, name: '页面上找到「下载报表」候选', detail: locate ? `found=${locate.found} tag=${locate.tag}` : '未测量' });
  if (!locate || locate.found === 0) throw new Error('没找到「下载报表」——大概率是这一份临时 profile 的登录态没带过来');

  // 滚进视口（真实编排里点击前就是这么做的）
  const scroll = JSON.parse(await cdp.eval(scrollIntoViewExpression(SEL)));
  log(`滚动到目标：${JSON.stringify(scroll)}`);
  await sleep(1500);

  const broken = JSON.parse(await cdp.eval(BROKEN_SRC));
  const fixed = JSON.parse(await cdp.eval(FIXED_SRC));
  report.broken = broken;
  report.fixed = fixed;
  log('');
  log('===== 同一现场、同一目标、两版判据 =====');
  log('  broken（win.elementFromPoint）: ' + JSON.stringify(broken));
  log('  fixed （doc.elementFromPoint）: ' + JSON.stringify(fixed));

  checks.push({
    ok: broken.ok === false && broken.insideSamples === 0,
    name: 'broken 版当场复现线上失败（ok=false / insideSamples=0）',
    detail: `ok=${broken.ok} insideSamples=${broken.insideSamples} reason=${broken.reason} blocker=${JSON.stringify(broken.blocker)}`,
  });
  checks.push({
    ok: fixed.ok === true && fixed.insideSamples > 0,
    name: 'fixed 版当场判通过（ok=true / insideSamples>0）',
    detail: `ok=${fixed.ok} insideSamples=${fixed.insideSamples} inScope=${fixed.inScope} rect=${JSON.stringify(fixed.rect)} viewport=${JSON.stringify(fixed.viewport)}`,
  });
  checks.push({
    ok: broken.blocker === null && fixed.blocker === null,
    name: '两版都报不出「遮挡物」—— 说明线上那句「没有遮挡物」也是这个缺陷的产物',
    detail: `broken.blocker=${JSON.stringify(broken.blocker)} fixed.blocker=${JSON.stringify(fixed.blocker)}`,
  });

  cdp.close();
} catch (e) {
  report.fatal = String(e && e.stack ? e.stack : e).slice(0, 800);
  log('FATAL: ' + report.fatal);
} finally {
  if (child && child.pid) {
    const k = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    log(`[收尾] taskkill 退出码=${k.status}（这不是释放判据）`);
  }
  await sleep(2500);
  const st = await portState(PORT);
  log(`[收尾] 端口回读 ${PORT} = ${st}`);
  report.portAfter = st;
  finish();
}
