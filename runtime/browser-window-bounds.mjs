// 起完浏览器之后，用 CDP 把窗口 bounds **归位**成登记表里的那个尺寸。
//
// 为什么需要它（2026-10-14，当天真机踩到）：**共用商家浏览器**（19022/19023）的 argv 里
// 既没有 `--window-size` 也没有 `--force-device-scale-factor` —— 这是刻意的，那两个老浏览器的
// argv 被 `browser-ports.test.mjs` 断言「逐字不变」（改它们有静默串号风险，见 browser-ports.mjs 里
// `SHOP_BROWSER_EXTRA_ARGS` 那一段）。代价是它的窗口尺寸**从没人负责**：取 Windows 给的默认窗，
// 或者恢复 profile 里记住的上一次窗口位置。
//
// 后果不是「难看」，是**登录静默失败**：`login-merchant.mjs` 靠坐标点击驱动真实手势
// （gesturePoint / 提交点都是固定坐标），窗口一小，登录表单整体落到视口折叠线下，
// 点击打在视口外 ⇒ 表单没提交 ⇒ 判据只报「没登上」，不报「窗口太小」。
// 2026-10-14 10:21 / 10:27 两轮整轮被挡就是这个形态；10:52 手工把窗口设成 1528x732 后，
// 同一脚本同一账号一次通过 ⇒ 窗口尺寸是充分条件。
//
// **为什么不走 argv**：那条「两个老浏览器 argv 逐字不变」的断言是防串号的，不该为了这个拆掉。
// 起后用 CDP 归位能达到同样的效果，且完全不碰 argv。
//
// 纪律（与修复层同一立场）：
//   1) **回读判定，不自证**：设完之后重新 `getWindowForTarget` 读一次，`bounds` 落进容差才算成。
//   2) **认不出目标就什么都不做**：没有 page 页签、CDP 连不上 ⇒ 如实报原因，不猜、不硬设。
//   3) **失败不致命**：这一步的兜底是视口闸门（`runtime/shop-viewport-gate.mjs`）——
//      它读的是页面里的 `innerWidth/innerHeight`，那才是真正的判据。所以这里失败只报事实，
//      不让启动器跟着失败（启动器失败会把「窗口小」升级成「实例起不来」）。
import { BROWSER_WINDOW_BOUNDS, pickWebPage } from './browser-ports.mjs';

/** 容差：Windows 会把请求的尺寸微调 1-2 像素（实测 1528→1529），所以判等要留余量。 */
export const WINDOW_BOUNDS_TOLERANCE = 16;

/** 纯判据：读到的 bounds 是否已经是我们要的那个尺寸。没有 IO，所以能被离线用例钉住。 */
export function windowBoundsMatch(actual, want = BROWSER_WINDOW_BOUNDS, tolerance = WINDOW_BOUNDS_TOLERANCE) {
  if (!actual || !Number.isFinite(actual.width) || !Number.isFinite(actual.height)) return false;
  const near = (a, b) => Math.abs(a - b) <= tolerance;
  return near(actual.width, want.width) && near(actual.height, want.height);
}

export function describeWindowBounds(bounds) {
  if (!bounds) return '(读不到)';
  const state = bounds.windowState && bounds.windowState !== 'normal' ? `${bounds.windowState} ` : '';
  return `${state}${bounds.width}x${bounds.height} @${bounds.left ?? '?'},${bounds.top ?? '?'}`;
}

async function getJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 一次 CDP 调用。用 /json/version 给的浏览器级 websocket（`Browser.*` 域在这里才可用）。 */
function cdpSession(wsUrl, timeoutMs) {
  const pending = new Map();
  let seq = 0;
  const socket = new WebSocket(wsUrl);
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket 在 ${timeoutMs}ms 内没连上`)), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket 连接失败')); });
  });
  socket.addEventListener('message', (event) => {
    let message = null;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message ?? 'CDP error'}（code ${message.error.code}）`));
    else entry.resolve(message.result ?? {});
  });
  return {
    opened,
    call(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 在 ${timeoutMs}ms 内没有回应`)); }, timeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* 已经关了 */ } },
  };
}

/**
 * 把 `port` 这个实例的窗口归位到 `bounds`（默认取登记表的 `BROWSER_WINDOW_BOUNDS`）。
 *
 * **永不抛**：一切异常翻成 `{ ok:false, reason, detail }`，由调用方决定怎么报。
 * `reason` 是闭集：`CDP_UNREACHABLE` / `NO_PAGE_TARGET` / `SET_FAILED` / `VERIFY_FAILED`。
 */
export async function applyWindowBounds({
  port, bounds = BROWSER_WINDOW_BOUNDS, timeoutMs = 8000,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  let version = null;
  try {
    version = await getJson(`${base}/json/version`, timeoutMs);
    if (!version?.webSocketDebuggerUrl) throw new Error('/json/version 里没有 webSocketDebuggerUrl');
  } catch (error) {
    return { ok: false, changed: false, reason: 'CDP_UNREACHABLE', detail: `连不上 ${base}：${String(error?.message ?? error)}` };
  }

  let page = null;
  try {
    const list = await getJson(`${base}/json/list`, timeoutMs);
    // 2026-10-24：不能取「第一个 type=page」—— Edge 下载浮窗也是 page，
    // 拿它的窗口 ID 去 setWindowBounds 会把浮窗当采集窗归位。与视口闸门共用同一份判据。
    page = pickWebPage(list);
  } catch (error) {
    return { ok: false, changed: false, reason: 'NO_PAGE_TARGET', detail: `/json/list 读不到：${String(error?.message ?? error)}` };
  }
  if (!page) {
    return { ok: false, changed: false, reason: 'NO_PAGE_TARGET', detail: '这个实例当前没有业务 page 页签（可能只剩 edge:// 等内部页，没有可定位的窗口）' };
  }

  const session = cdpSession(version.webSocketDebuggerUrl, timeoutMs);
  // `changed` 要如实反映「我们到底动没动过它」：中途失败时窗口可能已经被改了一半，
  // 而调用方（启动器日志、事后复盘）正是靠这个字段分清「没动过」与「动了但没成」。
  let changed = false;
  try {
    await session.opened;
    const before = await session.call('Browser.getWindowForTarget', { targetId: page.id });
    const beforeBounds = before?.bounds ?? null;
    if (windowBoundsMatch(beforeBounds, bounds)) {
      return { ok: true, changed: false, reason: null, before: beforeBounds, after: beforeBounds,
        detail: `窗口已经是 ${describeWindowBounds(beforeBounds)}，不用改` };
    }
    // 先归位成 normal 再设尺寸：CDP 在窗口处于 maximized/minimized 时**不保证**一次设成功
    // （`Browser.setWindowBounds` 的已知行为），所以分两步，且窗口状态本来就不是 normal 时也得先还原。
    if (beforeBounds?.windowState && beforeBounds.windowState !== 'normal') {
      changed = true;
      await session.call('Browser.setWindowBounds', { windowId: before.windowId, bounds: { windowState: 'normal' } });
    }
    changed = true;
    await session.call('Browser.setWindowBounds', {
      windowId: before.windowId,
      bounds: { windowState: 'normal', left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
    });
    const after = await session.call('Browser.getWindowForTarget', { targetId: page.id });
    const afterBounds = after?.bounds ?? null;
    const ok = windowBoundsMatch(afterBounds, bounds);
    return {
      ok, changed: true,
      reason: ok ? null : 'VERIFY_FAILED',
      before: beforeBounds, after: afterBounds,
      detail: ok
        ? `窗口已从 ${describeWindowBounds(beforeBounds)} 归位到 ${describeWindowBounds(afterBounds)}`
        : `设完回读到 ${describeWindowBounds(afterBounds)}，与期望 ${bounds.width}x${bounds.height} 不符`,
    };
  } catch (error) {
    return { ok: false, changed, reason: 'SET_FAILED', detail: `设窗口 bounds 失败：${String(error?.message ?? error)}` };
  } finally {
    session.close();
  }
}
