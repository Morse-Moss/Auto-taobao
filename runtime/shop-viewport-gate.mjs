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
import { PROJECT_PORTS, shopInstance } from './browser-ports.mjs';

export const SHOP_VIEWPORT_MIN_WIDTH = 1200;
export const SHOP_VIEWPORT_MIN_HEIGHT = 600;
export const VIEWPORT_READ_ATTEMPTS = 5;
export const VIEWPORT_READ_INTERVAL_MS = 800;
export const VIEWPORT_EVAL_TIMEOUT_MS = 8000;

/** 退出码口径（2026-10-14 抽出来，让调用方不必各写一份）：
 *  0＝全达标｜2＝量到了、就是不达标（查屏幕与缩放）｜3＝读不到、没有结论（查实例）。 */
export const VIEWPORT_EXIT_CODES = Object.freeze({ OK: 0, TOO_SMALL: 2, UNREADABLE: 3 });

/** 共用商家浏览器在视口读数里显示成什么。它是唯一那个不属于任何一家店的实例。 */
export const SHARED_BROWSER_VIEWPORT_LABEL = '共用商家浏览器';

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
 * 读**任意一个**实例的视口（按代理端口）。
 *
 * 为什么抽成这一层（2026-10-14）：原来只有「按店名读」—— `readShopViewport` 里直接
 * `shopInstance(shop).proxyPort`。而 2026-10-14 那次故障出在**共用商家浏览器 19023** 上，
 * 它不是任何一家店 ⇒ 旧函数读不到它，于是这条链唯一那个「会走坐标点击登录」的实例
 * 从来没有视口读数。判据本来就只有一条（读 innerWidth/innerHeight），不该因为「不是店」
 * 就少一个入口。
 *
 * **带重试**：刚起完的实例首屏还在加载，第一次 eval 可能打在一个还没有文档的页签上
 * —— 那是「还没好」，不是「不达标」。
 *
 * 每一轮重新取 `/targets`（`targetId` 会变，别存下来用第二次）；
 * 页签挑 `type === 'page'` 且不是 devtools 的第一个。
 */
export async function readViewportAtProxy({
  proxyPort, label = null, fetchImpl = fetch, attempts = VIEWPORT_READ_ATTEMPTS,
  intervalMs = VIEWPORT_READ_INTERVAL_MS, sleep = delay,
} = {}) {
  const base = `http://127.0.0.1:${proxyPort}`;
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
    shop: label, proxyPort, targetId,
    width: reading?.width ?? null, height: reading?.height ?? null, dpr: reading?.dpr ?? null,
    readError: lastError, verdict,
  };
}

/**
 * 读一家店的视口。判据与读数都走 `readViewportAtProxy`（一处实现），
 * 这里只负责把「店名」翻成「这个店自己的代理端口」。
 */
export async function readShopViewport({ shop, ...options } = {}) {
  const instance = shopInstance(shop);
  return readViewportAtProxy({ proxyPort: instance.proxyPort, label: shop, ...options });
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

/**
 * 按「一对一的实例清单」读 —— 每项是 `{ proxyPort, label }`。
 * 与 `checkShopViewports` 共用同一份判据与汇总，只是允许清单里出现**不是店**的实例
 * （如共用商家浏览器）。这条入口是 2026-10-14 那次故障的直接修法。
 */
export async function checkProxyViewports({ targets = [], ...options } = {}) {
  const entries = [];
  for (const target of targets) {
    entries.push(await readViewportAtProxy({ proxyPort: target.proxyPort, label: target.label ?? null, ...options }));
  }
  return { ...summarizeShopViewports(entries), entries };
}

/**
 * 一行一个实例的读数（**给人读的那一份**）。抽出来是因为它现在有**两个出口**（见 `main`）：
 * `--json` 时 JSON 走 stdout（编排层把它接成工件文件），人读的这几行走 stderr（编排层把它接进日志）。
 */
export function viewportLines(summary) {
  return (summary?.entries ?? []).map((entry) => `${entry.verdict.ok ? 'PASS' : 'FAIL'} `
    + `${entry.shop ?? `:${entry.proxyPort}`}: ${entry.verdict.detail}`
    + `${entry.readError ? `（${entry.readError}）` : ''}`);
}

/** 把结论压成一句人话（日志与异常都用它，避免两处措辞漂移）。 */
export function describeViewportFailure(summary) {
  return summary.failed
    .map((entry) => `${entry.shop ?? `:${entry.proxyPort}`}=${entry.verdict.reason}${entry.readError ? `（${entry.readError}）` : ''}`)
    .join('；');
}

/**
 * 纯判据：这份汇总该退什么码。
 *
 * 三档分得开是因为**下一步动作不同**：
 *   0 = 全达标；
 *   2 = 至少一家**量到了**、就是不达标 ⇒ 查屏幕与缩放（这是「今天真的会出事」那一档）；
 *   3 = 没有一家量到不达标，但至少一家**读不到** ⇒ 没有结论，去查实例。
 * 「读不到」不许退成 0（那正是本仓反复在治的病根），也不该混进 2 ——
 * 报一个量出来的数字和报「我读不到」对操作者是两件事。
 */
export function viewportExitCode(summary) {
  if (summary?.ok) return VIEWPORT_EXIT_CODES.OK;
  const failed = summary?.failed ?? [];
  const measured = failed.some((entry) => entry.verdict?.reason !== 'VIEWPORT_UNREADABLE');
  return measured ? VIEWPORT_EXIT_CODES.TOO_SMALL : VIEWPORT_EXIT_CODES.UNREADABLE;
}

/** `--proxy` 既收裸端口（19023）也收完整 URL（http://127.0.0.1:19023）。认不出来返回 null。 */
export function parseProxyPort(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/(?:^|:)(\d{1,5})\/?$/u);
  const port = match ? Number(match[1]) : Number(text);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

const isMain = Boolean(process.argv[1]) && process.argv[1].replace(/\\/gu, '/').endsWith('shop-viewport-gate.mjs');

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const readOption = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const shops = String(readOption('--shops') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const proxyRaw = readOption('--proxy');
  const label = readOption('--label');

  const targets = shops.map((shop) => ({ proxyPort: shopInstance(shop).proxyPort, label: shop }));
  if (proxyRaw !== null) {
    const proxyPort = parseProxyPort(proxyRaw);
    if (proxyPort === null) {
      // 例子里的端口**刻意用一个不属于本项目的数字**：本仓有守卫禁止把登记端口写成字面量
      // （`browser-ports.test.mjs`），usage 文案也算 —— 换成登记表里的真端口会被当场判红。
      console.error(`--proxy 要一个端口或 URL（如 9000 / http://127.0.0.1:9000），收到 ${JSON.stringify(proxyRaw)}`);
      return VIEWPORT_EXIT_CODES.TOO_SMALL;
    }
    targets.push({ proxyPort, label: label ?? null });
  }
  if (!targets.length) {
    console.error('用法：node runtime/shop-viewport-gate.mjs --shops 店A,店B [--json]');
    console.error('      node runtime/shop-viewport-gate.mjs --proxy <代理端口> [--label 共用商家浏览器] [--json]');
    console.error('      （两者可以一起给：先读这几家店，再读那个按端口指定的实例）');
    return VIEWPORT_EXIT_CODES.TOO_SMALL;
  }

  const summary = await checkProxyViewports({ targets });
  // 两个出口**刻意分开**（2026-10-14）：编排层把 stdout 接成工件文件（`viewport.json`），
  // 而人翻的日志接 stderr。若 `--json` 时只往 stdout 写 JSON，那么：
  //   ① 日志里就只剩一段 JSON（阅读成本高），或者更糟 —— 编排层若只把 stdout 落文件、不回显，
  //      那个读数的**唯一直接证据**就只剩一个文件，而事后翻日志的人看不到它。
  // 分开口之后：工件是纯 JSON（可被程序读），日志里既有 JSON 也有人读的那几行。
  const lines = viewportLines(summary);
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    for (const line of lines) console.error(line);
  } else {
    for (const line of lines) console.log(line);
  }
  return viewportExitCode(summary);
}

if (isMain) process.exit(await main());

export { main };
