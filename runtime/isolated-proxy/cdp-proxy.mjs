#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常浏览器（Chrome / Edge / Chromium 等）
// 要求：浏览器已开启 remote debugging（chrome://inspect#remote-debugging toggle）
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { selectBrowser, describeIsolatedTarget } from './browser-discovery.mjs';
import { waitForDocumentReady } from './wait-for-load.mjs';
import { selectIdleTabs, selectShutdownTabs, countPinned } from './managed-tabs.mjs';
import { PROJECT_PORTS, resolvePort } from '../browser-ports.mjs';

// 2026-09-17 删掉两处死代码（坑 38）：
//   ① `--browser <名>` 参数解析 —— 解析出来的值只被传给 selectBrowser(...)，
//      而它是**无参**的，那个实参从来没被读过。指定浏览器一律走环境变量。
//   ② discoverChromePort 里 kind==='mismatch' / source==='override' / findFallbackPort() 三条分支
//      —— selectBrowser 要么返回 kind:'ok'，要么抛错，这三段永远不会执行。
// 现在「连不上该说什么」搬到了真正会走的那条路径（catch 里），不再挂在死分支上。
// 监听端口也必须来自登记表：原先的默认值是 3456 —— 那是**别的项目**的共享代理端口
// （见 runtime/browser-ports.mjs 的 FOREIGN_PORTS）。裸跑本脚本会去抢别人的端口；
// 真被占着时更糟：下面的 checkPortAvailable 会探到对方 /health 返回 ok，
// 于是打印「已有实例运行在端口 3456，退出」并以 0 退出 —— 看起来成功，其实什么都没起。
// 现在默认落在本项目竞品链的代理端口上，与 browser-discovery 的默认浏览器同链。
const PORT = resolvePort('CDP_PROXY_PORT', PROJECT_PORTS.competitorProxy);
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const fileChooserWaiters = new Set();
const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const targetLabels = new Map(); // targetId -> short-lived automation label
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// proxy 启动时连接到的浏览器（用于 /health 暴露给 check-deps 比较）
let connectedBrowser = null; // { id, label, source }

// --- 发现浏览器调试端口 ---
// 决策完全委派给 browser-discovery.selectBrowser；此处只做日志、错误信息与返回结构包装。
//
// 这里原先还有两段：pin 住首次连上的浏览器 id（重连时不许切到别的 id），以及末尾的
// findFallbackPort() 兜底。两者都**永远不会执行**：selectBrowser 是无参的、恒返回同一个 id，
// pin 的判据恒为假，而它一旦返回就是 kind:'ok'，末尾兜底根本到不了。2026-09-17 一并删掉。
async function discoverChromePort() {
  let result;
  try {
    result = await selectBrowser();
  } catch (error) {
    const target = describeIsolatedTarget();
    throw new Error(
      `连不上浏览器调试端口 ${target.port}（本次进程自报的身份是 ${target.id}）：${error.message}\n` +
      '本项目请用启动器起专用浏览器，端口与 profile 的唯一来源是 runtime/browser-ports.mjs：\n' +
      '  竞品/买家链: node runtime/start-project-browser.mjs\n' +
      '  日报/商家链: node runtime/start-daily-report-browser.mjs\n' +
      '代理侧同样用启动器（它会把浏览器端口一起设好）：日报链 node runtime/start-daily-report-proxy.mjs；\n' +
      '竞品链见 docs/ops/PROJECT-BROWSER-AND-PORTS.md。不要手写端口，也不要用地址栏的 "Allow remote debugging"（那样端口是随机的）。'
    );
  }
  connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };
  console.log(`[CDP Proxy] 选用 ${result.browser.label} (端口 ${result.browser.port}${result.browser.wsPath ? '，带 wsPath' : ''}) [登记表/环境变量]`);
  return { port: result.browser.port, wsPath: result.browser.wsPath };
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWsPath = null;

let connectingPromise = null;
async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;  // 复用进行中的连接

  if (!chromePort) {
    // 这里原先还有一段 `if (!discovered) throw「请用启动器起浏览器」`：同样到不了 ——
    // discoverChromePort 要么返回端口，要么自己抛错。那段文案已搬进它的 catch。
    const discovered = await discoverChromePort();
    chromePort = discovered.port;
    chromeWsPath = discovered.wsPath;
  }

  const wsUrl = getWebSocketUrl(chromePort, chromeWsPath);
  if (!wsUrl) throw new Error('无法获取 Chrome WebSocket URL');

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      console.log(`[CDP Proxy] 已连接浏览器 (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      const msg = e.message || e.error?.message || '连接失败';
      console.error('[CDP Proxy] 连接错误:', msg, '（端口缓存已清除，下次将重新发现）');
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      chromeWsPath = null;
      sessions.clear();
      managedTabs.clear();
      targetLabels.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      // 拦截页面对 Chrome 调试端口的探测请求（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
      }
      if (msg.method === 'Page.fileChooserOpened') {
        for (const waiter of fileChooserWaiters) {
          if (waiter.sessionId !== msg.sessionId) continue;
          clearTimeout(waiter.timer);
          fileChooserWaiters.delete(waiter);
          waiter.resolve(msg.params);
        }
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    // 让被遮挡/后台的页面保持活跃渲染（详见函数注释）
    await enableFocusEmulation(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

const focusEmulatedSessions = new Set();

// 让不处于最前台的页面保持"活跃"渲染。
// 2026-09-15 实测：浏览器窗口被遮挡或标签在后台时，Edge 会把 document.hidden 置为 true，
// 并冻结 requestAnimationFrame。此时任何依赖 Vue <Transition> 的组件都永远停在动画首帧
// （opacity:0 / transform:scaleY(0)，即 getBoundingClientRect() 高度为 0），
// 于是"元素是否可见"这类判据恒为假——小旺神导出下拉正是这样被误判为"菜单项不存在"的。
// 开启 focus emulation 后 document.hidden 变 false、rAF 恢复，动画可正常推进。
// 该设置依附于 CDP session，session 断开即失效，所以必须在每次建立 session 时设置一次。
async function enableFocusEmulation(sessionId) {
  if (focusEmulatedSessions.has(sessionId)) return;
  try {
    await sendCDP('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    focusEmulatedSessions.add(sessionId);
  } catch { /* 该命令不可用时不影响主流程 */ }
}

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 闲置 Tab 自动清理 ---
//
// **「钉住的标签页」不参与清理**（2026-09-19 加，起因是一次实测，不是设想）：
// 店名标签页（`runtime/shop-window-label.mjs` 挂的那个 —— 客户靠它认「这个窗口是哪家店」）
// 也是用 `/new` 建的 ⇒ 一样进 managedTabs ⇒ **空闲 15 分钟就被这里关掉**，
// 而且代理退出时还会被 closeAllManagedTabs 一并关掉。
// 现场症状正是本项目反复见过的「页面自己消失了」：客户打开窗口，标签页没了，
// 四个窗口又长得一模一样 —— 而「让客户知道哪个窗口是哪家店」恰恰是它存在的唯一理由。
//
// 所以钉住的页要**两头都豁免**：闲置不关、代理退出也不关。
// （代理重启是常事 —— 起跑前重起代理是 SOP 的一部分，标签页跟着消失就等于没挂。）
// 不钉的页保持原行为：采集工作页本来就该被回收，那个「清页签省内存」的口径不变。
//
// 判定本身**不在这里**：`isPinned` / `selectIdleTabs` / `selectShutdownTabs` 住在
// `./managed-tabs.mjs`（纯函数，有单测）。这段之所以要搬出去，是因为本模块 import 就起
// 服务器 ⇒ 内联在这里的判定**没有测试碰得到**，而「测试碰不到」在这个仓库里等于
// 「下次改坏了没人知道」。这里只负责：拿到要关的 id 列表，交给 Target.closeTarget。
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

async function cleanupIdleTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  for (const targetId of selectIdleTabs(managedTabs, { now: Date.now(), idleTimeoutMs: TAB_IDLE_TIMEOUT })) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* tab may already be closed */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    targetLabels.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  const closable = selectShutdownTabs(managedTabs);
  const kept = countPinned(managedTabs);
  for (const targetId of closable) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    targetLabels.delete(targetId);
  }
  if (closable.length) console.log(`[CDP Proxy] Shutdown: closed ${closable.length} managed tab(s)`);
  if (kept > 0) console.log(`[CDP Proxy] Shutdown: 留下 ${kept} 个钉住的标签页（店名标签页这类，客户要一直看得到）`);
}

// --- 等待页面加载 ---
async function waitForLoad(sessionId, timeoutMs = 15000) {
  await sendCDP('Page.enable', {}, sessionId);
  return waitForDocumentReady({
    timeoutMs,
    readState: async (remainingMs) => {
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, sessionId, Math.max(50, Math.min(2000, remainingMs)));
      return resp.result?.result?.value;
    },
  });
}

function waitForFileChooser(sessionId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const waiter = { sessionId, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      fileChooserWaiters.delete(waiter);
      reject(new Error('file chooser did not open before timeout'));
    }, timeoutMs);
    fileChooserWaiters.add(waiter);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  if (q.target) touchTab(q.target);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接浏览器
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({
        status: 'ok',
        connected,
        browser: connectedBrowser,
        sessions: sessions.size,
        managedTabs: managedTabs.size,
        // 钉住的页数单独报出来（2026-09-19）：店名标签页是否真的被钉住，
        // 原本只能靠「过 15 分钟再来看还在不在」，现在起手一句 /health 就能核。
        pinnedTabs: countPinned(managedTabs),
        chromePort,
      }));
      return;
    }

    if (pathname === '/help') {
      res.end(JSON.stringify({
        '/paste?target=': 'POST - activate target and send Ctrl+V using the shared CDP connection',
        '/key?target=': 'POST JSON { key } - activate target and send one allowlisted navigation/edit key',
        '/chooseFile?target=': 'POST JSON { selector, files } - click a file chooser and select local files',
        '/hover?target=': 'POST JSON { selector } - move the real pointer over a visible element',
        '/rightClickPoint?target=': 'POST JSON { x, y } - real right click at a viewport point',
        '/label?target=&label=': 'GET - assign an in-memory automation label to a page target',
      }));
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page').map(t => (
        targetLabels.has(t.targetId) ? { ...t, automationLabel: targetLabels.get(t.targetId) } : t
      ));
      res.end(JSON.stringify(pages, null, 2));
    }

    // GET /new?url=xxx[&label=yyy][&pinned=1] - 创建新后台 tab
    // `pinned=1` ⇒ 这个页不参与闲置回收、代理退出也不关（见上面「钉住的标签页」那段）。
    // 不传就与从前逐字相同 —— 采集工作页要靠回收把内存还回去。
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now(), pinned: q.pinned === '1' });
      if (q.label) targetLabels.set(targetId, q.label.slice(0, 200));

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /label?target=&label= - attach a short-lived label without touching page storage
    else if (pathname === '/label') {
      const label = String(q.label || '');
      if (!q.target || !label || label.length > 200 || /[\u0000-\u001f]/u.test(label)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target and a valid label up to 200 characters are required' }));
        return;
      }
      const targets = await sendCDP('Target.getTargets');
      const exists = targets.result?.targetInfos?.some(t => t.targetId === q.target && t.type === 'page');
      if (!exists) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target must be an existing page target' }));
        return;
      }
      targetLabels.set(q.target, label);
      res.end(JSON.stringify({ labeled: true, label }));
    }

    // GET /pin?target=xxx - 把某个页钉住：闲置不回收、代理退出也不关
    // 用在店名标签页上（客户靠它认窗口）。**已经存在的页也能钉** —— 否则「标签页是旧版本挂的」
    // 就只能靠先关再建，而关掉客户正在看的页是另一件要人同意的事。
    else if (pathname === '/pin') {
      const targets = await sendCDP('Target.getTargets');
      const exists = targets.result?.targetInfos?.some(t => t.targetId === q.target && t.type === 'page');
      if (!exists) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target must be an existing page target' }));
        return;
      }
      managedTabs.set(q.target, { lastAccessed: Date.now(), pinned: true });
      res.end(JSON.stringify({ pinned: true, targetId: q.target }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      targetLabels.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: q.url }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /bringToFront?target=xxx - bring a managed tab to the foreground
    else if (pathname === '/bringToFront') {
      const sid = await ensureSession(q.target);
      await sendCDP('Page.bringToFront', {}, sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        const detail = resp.result.exceptionDetails;
        const message = String(detail.exception?.description || detail.text || 'Runtime.evaluate failed')
          .replace(/[\r\n]+/gu, ' ').slice(0, 1000);
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /clickPoint?target=xxx - real mouse click at an explicit viewport point.
    // This is intentionally coordinate-only and reuses the existing CDP session.
    else if (pathname === '/clickPoint') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'body must contain finite x and y' }));
        return;
      }
      const sid = await ensureSession(target);
      await sendCDP('Target.activateTarget', { targetId: target });
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      }, sid);
      touchTab(target);
      res.end(JSON.stringify({ clicked: true, target, x, y }));
    }

    // POST /rightClickPoint?target=xxx - real context-menu click at an explicit viewport point.
    else if (pathname === '/rightClickPoint') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'body must contain finite x and y' }));
        return;
      }
      const sid = await ensureSession(target);
      await sendCDP('Target.activateTarget', { targetId: target });
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'right', clickCount: 1,
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'right', clickCount: 1,
      }, sid);
      touchTab(target);
      res.end(JSON.stringify({ rightClicked: true, target, x, y }));
    }

    // POST /clickText?target=xxx - click one visible accessibility node by exact name.
    else if (pathname === '/clickText') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').trim();
      if (!text) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'body must contain non-empty text' }));
        return;
      }
      const sid = await ensureSession(target);
      const tree = await sendCDP('Accessibility.getFullAXTree', {}, sid);
      const matches = (tree.result?.nodes || []).filter(node =>
        node.name?.value === text && node.backendDOMNodeId
      );
      if (matches.length !== 1) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `expected one accessibility node named ${text}, got ${matches.length}` }));
        return;
      }
      const box = await sendCDP('DOM.getBoxModel', {
        backendNodeId: matches[0].backendDOMNodeId,
      }, sid);
      const quad = box.result?.model?.border;
      if (!quad || quad.length !== 8) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `accessibility node ${text} has no clickable box` }));
        return;
      }
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await sendCDP('Target.activateTarget', { targetId: target });
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      }, sid);
      touchTab(target);
      res.end(JSON.stringify({ clicked: true, target, text, x, y }));
    }

    // POST /key?target=xxx - send one bounded navigation/edit key to the page.
    else if (pathname === '/key') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const allowed = {
        Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
        Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
        Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
        End: { code: 'End', windowsVirtualKeyCode: 35 },
        Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
        SelectAll: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      };
      const key = String(body.key || '');
      const spec = allowed[key];
      if (!spec) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'key must be one of Escape, Delete, Enter, End, Tab, SelectAll' }));
        return;
      }
      const targets = await sendCDP('Target.getTargets');
      const targetInfo = targets.result?.targetInfos?.find(t => t.targetId === target && t.type === 'page');
      if (!targetInfo) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target must be an existing page target' }));
        return;
      }
      await sendCDP('Target.activateTarget', { targetId: target });
      const sid = await ensureSession(target);
      await sendCDP('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: spec.key || key, code: spec.code, modifiers: spec.modifiers || 0, windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      }, sid);
      await sendCDP('Input.dispatchKeyEvent', {
        type: 'keyUp', key: spec.key || key, code: spec.code, modifiers: spec.modifiers || 0, windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      }, sid);
      touchTab(target);
      res.end(JSON.stringify({ keyed: true, target, key, title: targetInfo.title }));
    }

    // POST /chooseFile?target=xxx - intercept one visible file chooser and set local files.
    else if (pathname === '/chooseFile') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const selector = String(body.selector || '');
      const files = Array.isArray(body.files) ? body.files.map(String) : [];
      if (!selector || files.length === 0 || files.some(file => !path.isAbsolute(file) || !fs.existsSync(file))) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'body must contain a selector and existing absolute file paths' }));
        return;
      }
      const targets = await sendCDP('Target.getTargets');
      const targetInfo = targets.result?.targetInfos?.find(t => t.targetId === target && t.type === 'page');
      if (!targetInfo) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target must be an existing page target' }));
        return;
      }
      const sid = await ensureSession(target);
      await sendCDP('Target.activateTarget', { targetId: target });
      await sendCDP('Page.enable', {}, sid);
      await sendCDP('Page.setInterceptFileChooserDialog', { enabled: true }, sid);
      try {
        const selectorJson = JSON.stringify(selector);
        const coordResp = await sendCDP('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${selectorJson});
            if (!el) return { error: 'element not found' };
            el.scrollIntoView({ block: 'center' });
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }, sid);
        const coord = coordResp.result?.result?.value;
        if (!coord || coord.error) throw new Error(coord?.error || 'file chooser element has no coordinates');
        const chooserPromise = waitForFileChooser(sid);
        await sendCDP('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
        }, sid);
        await sendCDP('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
        }, sid);
        await sendCDP('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${selectorJson}); if (el) el.click(); return true; })()`,
          returnByValue: true,
        }, sid);
        try {
          const chooser = await chooserPromise;
          await sendCDP('DOM.setFileInputFiles', {
            files,
            backendNodeId: chooser.backendNodeId,
          }, sid);
        } catch (error) {
          // Some web apps invoke a hidden file input without emitting the chooser event.
          await sendCDP('DOM.enable', {}, sid);
          const doc = await sendCDP('DOM.getDocument', {}, sid);
          const input = await sendCDP('DOM.querySelector', {
            nodeId: doc.result.root.nodeId,
            selector: 'input[type="file"]',
          }, sid);
          if (!input.result?.nodeId) throw error;
          await sendCDP('DOM.setFileInputFiles', { files, nodeId: input.result.nodeId }, sid);
          await sendCDP('Runtime.evaluate', {
            expression: `(() => { const input = document.querySelector('input[type="file"]'); if (!input) return false; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
            returnByValue: true,
          }, sid);
        }
      } finally {
        await sendCDP('Page.setInterceptFileChooserDialog', { enabled: false }, sid).catch(() => {});
      }
      touchTab(target);
      res.end(JSON.stringify({ chosen: true, target, files: files.map(file => path.basename(file)) }));
    }

    // POST /hover?target=xxx - dispatch one real pointer move at a selector center.
    else if (pathname === '/hover') {
      const target = q.target;
      const body = JSON.parse(await readBody(req));
      const selector = String(body.selector || '');
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'body must contain a selector' }));
        return;
      }
      const sid = await ensureSession(target);
      const selectorJson = JSON.stringify(selector);
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${selectorJson});
          if (!el) return { error: 'element not found' };
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || { error: 'element has no coordinates' }));
        return;
      }
      await sendCDP('Target.activateTarget', { targetId: target });
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: coord.x, y: coord.y,
      }, sid);
      touchTab(target);
      res.end(JSON.stringify({ hovered: true, target, x: coord.x, y: coord.y }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    // POST /paste?target=xxx - activate the page and send a real Ctrl+V
    // through this proxy's existing browser connection. No arbitrary keys are exposed.
    else if (pathname === '/paste') {
      const target = q.target;
      const targets = await sendCDP('Target.getTargets');
      const targetInfo = targets.result?.targetInfos?.find(t => t.targetId === target && t.type === 'page');
      if (!targetInfo) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'target must be an existing page target' }));
        return;
      }
      await sendCDP('Target.activateTarget', { targetId: target });
      const sid = await ensureSession(target);
      await sendCDP('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17 }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 }, sid);
      touchTab(target);
      res.end(JSON.stringify({ pasted: true, target, title: targetInfo.title }));
    }

    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new?url=': 'GET - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 验证已有实例是否健康
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch { /* 端口占用但非 proxy，继续报错 */ }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    // 启动时尝试连接 Chrome（非阻塞）
    connect().catch(e => console.error('[CDP Proxy] 初始连接失败:', e.message, '（将在首次请求时重试）'));
  });

  // 定时清理闲置 tab
  const cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();

  const shutdown = async (sig) => {
    console.log(`[CDP Proxy] ${sig}, cleaning up...`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
