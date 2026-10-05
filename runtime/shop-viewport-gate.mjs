// 起完店铺实例之后的「视口回读」闸门（2026-10-05 落地）。
//
// 为什么需要它：`SHOP_BROWSER_SCALE_FACTOR`（`--force-device-scale-factor=1.25`）只解决了
// 「系统缩放变」这一种成因；**屏幕物理尺寸变**（换屏、远程桌面改分辨率、窗口落到另一块屏）
// 仍可能把 1528 DIP 的窗口夹成 1120 ⇒ 视口从 1506 掉到 1114。同一条命令行、两次冷启动就能不一样
// （见 `runtime/browser-ports.mjs` 里 2026-10-05 的真机 A/B 读数）。那条注释把这道闸门记为
// 「尚未做」—— 这里就是它。
//
// ⚠️ 别把这道闸门当成 2026-10-05「8 家全挂」的解法：那次故障的真因是命中判据把
// `document.elementFromPoint` 写成了 `win.elementFromPoint`（提交 `a4245c2`），与视口宽度无关。
// 这道闸门治的是**另一件事**：让「窗口多大」这件事在每一轮开始时都有一份可核对的读数，
// 而不是等采集脚本报一堆 `not-hit` 之后才发现窗口被夹窄了。
//
// 判据只有一条：**读一次每个实例的 innerWidth / innerHeight**，宽度低于阈值就判红、不往下跑。
// 阈值取 1200：历史成功轮与今天活实例实测 1506、被夹窄时实测 1114
// ⇒ 1200 落在两端中间且两边都留余量（不把一次抖动判成红，也不把真被夹窄的放过去）。
//
// 「读不到」**不等于**「达标」：读失败会重试有限次，仍读不到判 `VIEWPORT_UNREADABLE` 并按红处理。
// 「读不到就当没事」正是本仓反复在治的那个病根（把读不到当成掉了／不存在）。
import { shopInstance } from './browser-ports.mjs';

export const SHOP_VIEWPORT_MIN_WIDTH = 1200;
export const SHOP_VIEWPORT_MIN_HEIGHT = 600;
export const VIEWPORT_READ_ATTEMPTS = 5;
export const VIEWPORT_READ_INTERVAL_MS = 800;
export const VIEWPORT_EVAL_TIMEOUT_MS = 8000;

/** 页面里返回**字符串**（代理会把 `Runtime.evaluate` 的返回值原样放进 `value`，所以再 parse 一层）。 */
export const VIEWPORT_EXPRESSION =
  "JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })";

/**
 * 纯判据：给一组读数出结论。没有 IO，所以能被离线用例钉住。
 *
 * 三个结论分开报（`reason`），因为下一步动作不同：
 *   `VIEWPORT_UNREADABLE` = 读数拿不到（实例没起 / 页签没有 / eval 报错）⇒ 查实例；
 *   `VIEWPORT_TOO_NARROW` = 量到了、就是窄 ⇒ 查屏幕与缩放；
 *   `VIEWPORT_TOO_SHORT`  = 同上，纵向。
 */
export function judgeShopViewport({ width = null, height = null } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, reason: 'VIEWPORT_UNREADABLE', detail: `视口读数缺失（width=${width}、height=${height}）` };
  }
  if (width < SHOP_VIEWPORT_MIN_WIDTH) {
    return { ok: false, reason: 'VIEWPORT_TOO_NARROW', detail: `视口宽 ${width} < 阈值 ${SHOP_VIEWPORT_MIN_WIDTH}` };
  }
  if (height < SHOP_VIEWPORT_MIN_HEIGHT) {
    return { ok: false, reason: 'VIEWPORT_TOO_SHORT', detail: `视口高 ${height} < 阈值 ${SHOP_VIEWPORT_MIN_HEIGHT}` };
  }
  return { ok: true, reason: null, detail: `视口 ${width}x${height}` };
}

/** 纯汇总：一家红就整批红（采集是同一条链，视口不够那几家的结果不可信）。 */
export function summarizeShopViewports(entries = []) {
  const failed = entries.filter((entry) => !entry.verdict?.ok);
  return {
    ok: failed.length === 0,
    threshold: { width: SHOP_VIEWPORT_MIN_WIDTH, height: SHOP_VIEWPORT_MIN_HEIGHT },
    checked: entries.length,
    failed,
  };
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = VIEWPORT_EVAL_TIMEOUT_MS } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

const delay = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * 读一家店的视口。**带重试**：刚 `start-all` 完的实例首屏还在加载，
 * 第一次 eval 可能打在一个还没有文档的页签上 —— 那是「还没好」，不是「不达标」。
 *
 * 每一轮重新取 `/targets`（`targetId` 会变，别存下来用第二次）；
 * 页签挑 `type === 'page'` 且不是 devtools 的第一个。
 */
export async function readShopViewport({
  shop, fetchImpl = fetch, attempts = VIEWPORT_READ_ATTEMPTS,
  intervalMs = VIEWPORT_READ_INTERVAL_MS, sleep = delay,
} = {}) {
  const instance = shopInstance(shop);
  const base = `http://127.0.0.1:${instance.proxyPort}`;
  let lastError = null;
  let reading = null;
  let targetId = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    targetId = null;
    reading = null;
    try {
      const targets = await getJson(`${base}/targets`, { fetchImpl });
      const page = (Array.isArray(targets) ? targets : [])
        .find((entry) => entry?.type === 'page' && !String(entry?.url ?? '').startsWith('devtools://'));
      if (!page) throw new Error('/targets 里没有可用的 page 页签');
      targetId = page.targetId;
      const response = await fetchImpl(`${base}/eval?target=${encodeURIComponent(targetId)}`, {
        method: 'POST', body: VIEWPORT_EXPRESSION, signal: AbortSignal.timeout(VIEWPORT_EVAL_TIMEOUT_MS),
      });
      const payload = await response.json();
      if (payload?.error) throw new Error(String(payload.error).slice(0, 200));
      // 代理把 `Runtime.evaluate` 的值原样放进 `value`；我们那句表达式返回的是**字符串**。
      const raw = payload?.value;
      reading = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!reading) throw new Error('/eval 没返回值');
      lastError = null;
    } catch (error) {
      reading = null;
      lastError = String(error?.message ?? error).split('\n')[0].slice(0, 200);
    }
    if (reading) break;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  const verdict = judgeShopViewport(reading ?? {});
  return {
    shop, proxyPort: instance.proxyPort, targetId,
    width: reading?.width ?? null, height: reading?.height ?? null, dpr: reading?.dpr ?? null,
    readError: lastError, verdict,
  };
}

/**
 * 逐店读（**串行**：每家一个代理进程，同时打不会更快，只会让失败读数互相干扰）。
 * 任何一家读不到或读到的宽度不达标 ⇒ `ok=false`，且列表里带上是哪几家、为什么。
 */
export async function checkShopViewports({ shops = [], ...options } = {}) {
  const entries = [];
  for (const shop of shops) entries.push(await readShopViewport({ shop, ...options }));
  return { ...summarizeShopViewports(entries), entries };
}

/** 把结论压成一句人话（日志与异常都用它，避免两处措辞漂移）。 */
export function describeViewportFailure(summary) {
  return summary.failed
    .map((entry) => `${entry.shop}=${entry.verdict.reason}${entry.readError ? `（${entry.readError}）` : ''}`)
    .join('；');
}

const isMain = Boolean(process.argv[1]) && process.argv[1].replace(/\\/gu, '/').endsWith('shop-viewport-gate.mjs');

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const idx = args.indexOf('--shops');
  const shops = idx >= 0 ? String(args[idx + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (!shops.length) {
    console.error('用法：node runtime/shop-viewport-gate.mjs --shops 店A,店B [--json]');
    return 2;
  }
  const summary = await checkShopViewports({ shops });
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else for (const entry of summary.entries) console.log(`${entry.verdict.ok ? 'PASS' : 'FAIL'} ${entry.shop}: ${entry.verdict.detail}${entry.readError ? `（${entry.readError}）` : ''}`);
  return summary.ok ? 0 : 2;
}

if (isMain) process.exit(await main());

export { main };
