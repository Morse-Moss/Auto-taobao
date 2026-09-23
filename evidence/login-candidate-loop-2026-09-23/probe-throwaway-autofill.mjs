// 一次性实例实验（2026-09-23）：**密码填充到底为什么没发生**。
//
// 为什么必须是「复制 profile + 未登记端口」的一次性实例：
//   ① 结论必须来自真机（本项目的刹车：函数级用例全绿 ≠ 接线接上了；排练全绿 ≠ 真跑能跑）；
//   ② 但六个生产 profile 全都挂在正在跑的浏览器上（`browser-inventory` 已确认），
//      往它们里面发点击/导航就是在动用户的活会话 —— 不许可。
//   ③ 复制 profile 到临时目录、在**未登记端口**起一个只属于本次实验的实例，
//      拿到的填充行为与原件同源（同一台机器 + 同一 DPAPI 用户 + 同一版 Edge），
//      跑完 taskkill /T 收回进程树、删临时目录，什么都不留下。
//
// 它回答的问题（一个 A/B，两个变量各自独立）：
//   · **A**：复制商家浏览器的 profile（那里有一条 `times_used=11` 的凭据 —— 填充**确实工作过**），
//          不加任何额外开关启动，打开登录页 → 填不填？
//   · **B**：同一份复制件，只多一个 `--disable-sync`（五个店铺 profile 都带着它）→ 填不填？
//   A 与 B 的差集就是「`--disable-sync` 会不会把填充关掉」这一个问题的答案。
//   若 A 也不填 ⇒ 「这台机器的填充整体坏了」，与单条凭据无关（那五家店全是「一过期就要人」）。
//
// 判据只用页面自身（不看文字有没有变）：
//   value.length / `el.matches(':autofill')` / elementFromPoint 命中。
// 另外两张截图是**唯一**能看见密码下拉的方式 —— Chromium 的自动填充弹窗是原生控件，不进 DOM。
//
// 用法：
//   node probe-throwaway-autofill.mjs --source D:/Retire/edge-daily-report-profile --label merchant-nosync
//   node probe-throwaway-autofill.mjs --source D:/Retire/edge-daily-report-profile --label merchant-withsync --disable-sync
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROBE_PORT = 19801;          // 刻意不在 runtime/browser-ports.mjs 的登记表里
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
const LABEL = arg('label', 'probe');
const DISABLE_SYNC = argv.includes('--disable-sync');

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// CDP 小客户端（只用内置 WebSocket；依赖 0）
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessions = new Map();
    ws.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) { const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id); resolve(msg); }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: { message: `timeout ${method}` } }); } }, 20000);
    });
  }
}

// ---------------------------------------------------------------------------
// 凭据只读盘点（证明「复制件里那条用过 11 次的凭据确实在」）
// ---------------------------------------------------------------------------
function credentialSummary(profileDir) {
  const file = path.join(profileDir, 'Default', 'Login Data');
  if (!fs.existsSync(file)) return '(复制件里没有 Login Data)';
  const rows = (() => {
    try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
  })();
  if (!rows) return '(复制件的 Login Data 打不开)';
  const out = rows.prepare('SELECT username_value, signon_realm, times_used FROM logins').all();
  const n = rows.prepare('SELECT count(*) AS n FROM logins').get().n;
  rows.close();
  const taobao = out.filter((r) => String(r.signon_realm).includes('taobao.com'))
    .map((r) => `${JSON.stringify(String(r.username_value))}@${r.signon_realm} 用过=${r.times_used}`);
  return `共 ${n} 行；淘宝相关 ${taobao.length} 条：\n     ${taobao.join('\n     ')}`;
}

// ---------------------------------------------------------------------------
// 复制「让密码填充能工作」所需的最小文件集
// ---------------------------------------------------------------------------
function stageProfile(source, target) {
  fs.mkdirSync(path.join(target, 'Default'), { recursive: true });
  const wanted = ['Local State', 'Default/Preferences', 'Default/Secure Preferences',
    'Default/Login Data', 'Default/Login Data For Account',
    'Default/Login Data-journal', 'Default/Login Data-wal', 'Default/Login Data-shm',
    'Default/History', 'Default/Web Data'];
  const copied = [];
  for (const rel of wanted) {
    const from = path.join(source, rel);
    if (!fs.existsSync(from)) continue;
    try { fs.copyFileSync(from, path.join(target, rel)); copied.push(rel); }
    catch (error) { copied.push(`${rel}（跳过：${error.code}）`); }
  }
  return copied;
}

// 页面判据（与 probe-gesture-fill.mjs 同一套，便于并排对照）
const STATE = `(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return { valueLen: (el.value || '').length, autofill: el.matches(':autofill'),
      visible: r.width > 0 && r.height > 0, point: [Math.round(cx), Math.round(cy)],
      pointHits: hit ? (hit.id || hit.tagName) : null, pointIsSelf: hit === el };
  };
  const f = document.activeElement;
  return JSON.stringify({ href: location.href, readyState: document.readyState,
    activeElement: f ? (f.id || f.tagName) : null,
    hasForm: !!document.querySelector('form'), inputs: document.querySelectorAll('input').length,
    id: probe('#fm-login-id'), password: probe('#fm-login-password') });
})()`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join('D:/Retire/', `tmp-autofill-${LABEL}-`));
const profile = path.join(root, 'profile');
log(`实验 ${LABEL}：源=${SOURCE}  临时 profile=${profile.replaceAll('/', '\\')}  --disable-sync=${DISABLE_SYNC}`);

log('\n① 源凭据（原件，只读复制一份库）');
const sourceProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
try { fs.copyFileSync(path.join(SOURCE, 'Default', 'Login Data'), path.join(sourceProbe, 'Login Data')); } catch (e) { log(`   源库复制失败：${e.code}`); }
log(`   ${credentialSummary(sourceProbe)}`);

log('\n② 组装临时 profile');
log(`   复制：${stageProfile(SOURCE, profile).join(', ')}`);
log(`   复制件凭据：${credentialSummary(profile)}`);

// 端口必须先探空（一次性实例纪律）
try {
  const res = await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
  if (res.ok) { log(`\n端口 ${PROBE_PORT} 已被占用 —— 不抢占，直接退出`); process.exit(2); }
} catch { /* 空 */ }

const args = [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PROBE_PORT}`,
  '--no-first-run', '--no-default-browser-check',
  ...(DISABLE_SYNC ? ['--disable-sync'] : []),
  'about:blank',
];
log(`\n③ 起一次性实例（argv：${args.join(' ')}）`);
const child = spawn(EDGE, args, { stdio: 'ignore', detached: false });
const pid = child.pid;
log(`   pid=${pid}`);

let version = null;
for (let i = 0; i < 40; i += 1) {
  await delay(500);
  try {
    const res = await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) { version = await res.json(); break; }
  } catch { /* 还没起来 */ }
}

let exitCode = 0;
try {
  if (!version) throw new Error(`实例在 20s 内没起来（端口 ${PROBE_PORT}）`);
  log(`   起来了：${version.Browser}  ${version['User-Agent']}`);

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) throw new Error(`attach 失败：${JSON.stringify(attached).slice(0, 300)}`);

  const evalOn = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const clickPoint = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  };
  const readState = async () => { try { return JSON.parse(await evalOn(STATE)); } catch (e) { return { error: String(e?.message ?? e) }; } };
  const shot = async (name) => {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (res.result?.data) { fs.writeFileSync(path.join(SHOTS, name), Buffer.from(res.result.data, 'base64')); log(`   截图 → shots/${name}`); }
  };

  log(`\n④ 导航到登录页：${LOGIN_URL.slice(0, 90)}…`);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: LOGIN_URL }, sessionId);
  for (let i = 0; i < 40; i += 1) {
    await delay(500);
    const s = await readState();
    if (s?.readyState === 'complete' && s?.id) break;
  }
  await delay(2500);   // 给「页面加载时填充」留足时间

  log('\n⑤ 页面加载后（零点击）');
  let s = await readState();
  log(`   ready=${s.readyState} hasForm=${s.hasForm} inputs=${s.inputs} active=${s.activeElement}`);
  log(`   id.valueLen=${s.id?.valueLen} id.autofill=${s.id?.autofill} pwd.valueLen=${s.password?.valueLen} pwd.autofill=${s.password?.autofill}`);
  await shot(`${LABEL}-1-onload.png`);

  for (const [name, sel] of [['用户名框', '#fm-login-id'], ['密码框', '#fm-login-password']]) {
    const r = await evalOn(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return ''; const b = e.getBoundingClientRect(); return JSON.stringify([b.x + b.width / 2, b.y + b.height / 2]); })()`);
    if (!r) { log(`\n⑥ 点不到 ${name}`); continue; }
    const [x, y] = JSON.parse(r);
    log(`\n⑥ 真实鼠标点击 ${name} @ (${Math.round(x)}, ${Math.round(y)})`);
    await clickPoint(x, y);
    await delay(1800);
    s = await readState();
    log(`   active=${s.activeElement} id.valueLen=${s.id?.valueLen} id.autofill=${s.id?.autofill} pwd.valueLen=${s.password?.valueLen} pwd.autofill=${s.password?.autofill}`);
    log(`   id 命中=${s.id?.pointHits}(self=${s.id?.pointIsSelf})  pwd 命中=${s.password?.pointHits}(self=${s.password?.pointIsSelf})`);
    await shot(`${LABEL}-2-after-${sel.includes('password') ? 'pwd' : 'id'}-click.png`);
  }

  // 换一种「手势」：直接在页面里派发 keydown（有些版本认这个）
  log('\n⑦ 在密码框里派发一次真实按键（Input.dispatchKeyEvent）');
  const pr = await evalOn(`(() => { const e = document.querySelector('#fm-login-password'); if (!e) return ''; e.focus(); const b = e.getBoundingClientRect(); return JSON.stringify([b.x + b.width / 2, b.y + b.height / 2]); })()`);
  if (pr) {
    const [px, py] = JSON.parse(pr);
    await clickPoint(px, py);
    for (const type of ['keyDown', 'char', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, text: 'a', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }, sessionId);
    }
    await delay(1200);
    const typed = await evalOn(`document.querySelector('#fm-login-password').value.length`);
    log(`   按键后密码框长度=${typed}（这里只验证「按键能落到框里」，随后清掉）`);
    await evalOn(`(() => { const e = document.querySelector('#fm-login-password'); e.value = ''; return 1; })()`);
    s = await readState();
    log(`   清掉后 id.valueLen=${s.id?.valueLen} id.autofill=${s.id?.autofill}`);
  }

  log(`\n结论（${LABEL}）：${(() => {
    if (!s?.id) return '没找到用户名框，本次无结论';
    if ((s.id.valueLen ?? 0) > 0 || s.id.autofill) return '**填上了**';
    return '**没填上**（连点击后的手势也没唤醒）';
  })()}`);
} catch (error) {
  exitCode = 1;
  log(`\n实验异常：${String(error?.message ?? error)}`);
} finally {
  log(`\n⑧ 回收：taskkill /PID ${pid} /T /F`);
  try {
    const { spawnSync } = await import('node:child_process');
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
  } catch (error) { log(`   taskkill 出错：${String(error?.message ?? error)}`); }
  await delay(2500);
  try {
    await fetch(`http://127.0.0.1:${PROBE_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    log(`   端口 ${PROBE_PORT} 仍在响应 —— 进程树没回收干净，请人工检查`);
    exitCode = 3;
  } catch { log(`   端口 ${PROBE_PORT} 已释放 ✓`); }
  try { fs.rmSync(root, { recursive: true, force: true }); log(`   临时 profile 已删：${root}`); }
  catch (error) { log(`   临时 profile 删不掉（${error.code}）—— 留在 ${root}，请人工清理`); }
}
process.exit(exitCode);
