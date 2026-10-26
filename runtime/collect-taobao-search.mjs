#!/usr/bin/env node
// 淘宝搜索页采集器（自采，替代已停摆的小旺神市场分析导出）。
//
// 为什么是这样做的（2026-10-26 起）：
//   小旺神 2.1.0.6 的淘宝搜索/详情能力被厂商服务端置为 retired-20261024，
//   界面代码不再显示（见 E:\REA\xiaowangshen-逆向分析报告.md）。自采不重写它的逻辑，
//   而是直接调淘宝页面自己的 mtop SDK：签名和 bx-ua 由页面现算，我们不去逆向风控。
//
// 取数路径：
//   Node ──CDP──▶ 竞品浏览器(:9222) 新开 tab ──▶ s.taobao.com/search
//        └─ Runtime.evaluate 调 window.lib.mtop.request(...) ─▶ data.itemsArray
//
// 为什么不用纯 HTTP：mtop 的 sign 可解，但 bx-ua/bx-umidtoken/bx-et 是 baxia 混淆产物，
// 逆它成本远高于直接借页面现成的 SDK。这条约束在扩展壳里同样成立。
//
// 用法：
//   node runtime/collect-taobao-search.mjs --keyword 浴缸 --pages 1-4 \
//        --out runtime/taobao-part-1-4.csv [--raw-out runtime/taobao-part-1-4.json] \
//        [--frequency 10-15] [--sort _sale] [--checkpoint-prefix runtime/taobao-weekly-20261026]
//
// 退出码：0 = 全部页成功；1 = 有页失败（已采到的页仍会落盘，便于续跑）。

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_PORTS } from './browser-ports.mjs';
import { CATEGORY_MAP, categoryCoverage } from './category-map.mjs';
import {
  WEEKLY_COLUMNS,
  SALE_SORT,
  SEARCH_API,
  SEARCH_API_VERSION,
  SEARCH_APP_ID,
  buildSearchParams,
  normalizeItems,
  dedupeByItemId,
  toCsv,
} from './taobao-search-core.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const SEARCH_PAGE = 'https://s.taobao.com/search';
const NAV_TIMEOUT_MS = 45_000;
const EVAL_TIMEOUT_MS = 60_000;
const SDK_POLL_MS = 500;

const VALUE_OPTIONS = new Map([
  ['--keyword', 'keyword'],
  ['--pages', 'pages'],
  ['--out', 'out'],
  ['--raw-out', 'rawOut'],
  ['--frequency', 'frequency'],
  ['--sort', 'sort'],
  ['--checkpoint-prefix', 'checkpointPrefix'],
  ['--port', 'port'],
]);

function parseArgs(argv) {
  const options = { frequency: '10-15', sort: SALE_SORT, port: PROJECT_PORTS.competitorBrowser, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    const key = VALUE_OPTIONS.get(arg);
    if (!key) throw new Error(`未知参数：${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
    options[key] = value;
    i += 1;
  }
  if (!options.keyword) throw new Error('--keyword 必填');
  if (!options.pages) throw new Error('--pages 必填，例如 1-4');
  if (!options.out) throw new Error('--out 必填');
  options.range = parsePageRange(options.pages);
  options.frequencyRange = parseFrequency(options.frequency);
  return options;
}

// '1-4' → {start:1,end:4}；也接受单页 '3'。
export function parsePageRange(spec) {
  const text = String(spec ?? '').trim();
  const single = /^(\d+)$/u.exec(text);
  if (single) {
    const page = Number(single[1]);
    if (page < 1) throw new Error(`--pages 页码必须 >= 1，收到 ${spec}`);
    return { start: page, end: page };
  }
  const match = /^(\d+)-(\d+)$/u.exec(text);
  if (!match) throw new Error(`--pages 需为 START-END 或单页，收到 "${spec}"`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) throw new Error(`--pages 区间不合法：${spec}`);
  return { start, end };
}

// '10-15' → {min:10000,max:15000}
export function parseFrequency(spec) {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(String(spec ?? '').trim());
  if (!match) throw new Error(`--frequency 需为 MIN-MAX（秒），收到 "${spec}"`);
  const min = Number(match[1]) * 1000;
  const max = Number(match[2] ?? match[1]) * 1000;
  if (min <= 0) throw new Error(`--frequency 最小值必须 > 0`);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jitter({ min, max }) {
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

// 极简 CDP 会话。只实现本项目需要的四个动作：建页、附页、求值、关页。
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
  }

  static async connect(browserUrl) {
    const ws = new WebSocket(browserUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 连接失败：${browserUrl}`)), { once: true });
    });
    const session = new CdpSession(ws);
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const waiter = message.id ? session.pending.get(message.id) : null;
      if (!waiter) return;
      session.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method} 失败：${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
    });
    return session;
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = EVAL_TIMEOUT_MS) {
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

// 发现浏览器。端口来自 browser-ports，不写死——写死会变成「默认值即目标」。
async function resolveBrowser(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`浏览器 ${port} 不可用：HTTP ${response.status}`);
  const info = await response.json();
  if (!info.webSocketDebuggerUrl) throw new Error(`浏览器 ${port} 没有返回 webSocketDebuggerUrl`);
  return info;
}

// 页面里求值，把结果 JSON 带回来。
async function evaluateJson(session, sessionId, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? JSON.stringify(result.exceptionDetails);
    throw new Error(`页面内求值抛异常：${String(text).slice(0, 300)}`);
  }
  const value = result.result?.value;
  if (typeof value !== 'string') throw new Error(`页面内求值未返回字符串（实际 ${typeof value}）`);
  return JSON.parse(value);
}

const SDK_READY_EXPR = `JSON.stringify({
  hasSdk: !!(window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function'),
  url: location.href,
  readyState: document.readyState
})`;

// 单页请求：在页面主世界调 mtop。签名与风控参数由页面自算，这里不碰。
function buildPageExpression(params) {
  return `(async () => {
    const mtop = window.lib && window.lib.mtop;
    if (!mtop || typeof mtop.request !== 'function') return JSON.stringify({ ok: false, reason: 'NO_MTop_SDK' });
    try {
      const response = await mtop.request({
        api: ${JSON.stringify(SEARCH_API)},
        v: ${JSON.stringify(SEARCH_API_VERSION)},
        type: 'GET',
        dataType: 'json',
        data: { appId: ${JSON.stringify(SEARCH_APP_ID)}, params: ${JSON.stringify(JSON.stringify(params))} }
      });
      const items = (response && response.data && response.data.itemsArray) || [];
      return JSON.stringify({ ok: true, ret: response && response.ret, items });
    } catch (error) {
      return JSON.stringify({ ok: false, reason: 'REQUEST_THREW', message: String(error && (error.message || error)).slice(0, 300) });
    }
  })()`;
}

async function collectPage(session, sessionId, { keyword, page, sort, pageSize }) {
  const params = buildSearchParams({ keyword, page, pageSize, sort });
  const payload = await evaluateJson(session, sessionId, buildPageExpression(params));
  if (!payload.ok) {
    throw new Error(`第 ${page} 页请求失败：${payload.reason}${payload.message ? ` / ${payload.message}` : ''}`);
  }
  const ret = Array.isArray(payload.ret) ? payload.ret.join(' | ') : String(payload.ret ?? '');
  if (!/SUCCESS/u.test(ret)) throw new Error(`第 ${page} 页返回非 SUCCESS：${ret}`);
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error(`第 ${page} 页返回 0 条商品（可能是风控降级或关键词无结果）`);
  }
  return payload.items;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
}

function writeCsvFile(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, toCsv(rows, WEEKLY_COLUMNS), 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { range, frequencyRange, keyword, sort } = options;

  if (options.dryRun) {
    const plan = {
      keyword,
      pages: range,
      sort,
      frequencyMs: frequencyRange,
      out: options.out,
      rawOut: options.rawOut ?? null,
      port: options.port,
      pageCount: range.end - range.start + 1,
    };
    console.log(JSON.stringify(plan, null, 1));
    return 0;
  }

  const browser = await resolveBrowser(options.port);
  console.log(`[自采] 浏览器 ${options.port}（${browser.Browser}）`);
  const session = await CdpSession.connect(browser.webSocketDebuggerUrl);
  let targetId = null;
  let sessionId = null;
  const collected = [];
  const pageRecord = [];

  try {
    const created = await session.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await session.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    await session.send('Page.enable', {}, sessionId);
    await session.send('Page.navigate', { url: `${SEARCH_PAGE}?q=${encodeURIComponent(keyword)}&tab=all` }, sessionId, NAV_TIMEOUT_MS);

    // 等 SDK 就绪。这不是等「页面好看」，是等 mtop 挂上——没挂上就不能开始。
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    let sdkReady = false;
    let lastState = null;
    while (Date.now() < deadline) {
      await sleep(SDK_POLL_MS);
      try {
        lastState = await evaluateJson(session, sessionId, SDK_READY_EXPR);
      } catch {
        continue;
      }
      if (lastState.hasSdk) { sdkReady = true; break; }
    }
    if (!sdkReady) {
      throw new Error(`页面里没有 window.lib.mtop（最后状态：${JSON.stringify(lastState)}）。`
        + `可能是未登录、被风控拦截，或淘宝改了 SDK 挂载方式。`);
    }
    console.log(`[自采] SDK 就绪：${lastState.url}`);

    for (let page = range.start; page <= range.end; page += 1) {
      const items = await collectPage(session, sessionId, { keyword, page, sort });
      const normalized = normalizeItems(items, { startIndex: collected.length + 1, categoryMap: CATEGORY_MAP });
      collected.push(...normalized);
      pageRecord.push({ page, items: items.length, at: new Date().toISOString() });
      console.log(`[自采] 第 ${page} 页 ${items.length} 条（累计 ${collected.length} 条）`);

      // 段内进度落盘：中途挂了，已采的不会白跑。
      if (options.checkpointPrefix) {
        writeJson(`${options.checkpointPrefix}.progress.json`, {
          keyword, sort, range, pages: pageRecord, rows: collected.length,
          updatedAt: new Date().toISOString(),
        });
      }

      if (page < range.end) {
        const wait = jitter(frequencyRange);
        console.log(`[自采] 等 ${(wait / 1000).toFixed(1)} 秒再取下一页`);
        await sleep(wait);
      }
    }

    // 去重放在最后：分页之间会有广告位/推荐位重复，序号按去重后重排。
    const rows = dedupeByItemId(collected);
    writeCsvFile(options.out, rows);
    if (options.rawOut) {
      writeJson(options.rawOut, {
        keyword, sort, range,
        pages: pageRecord,
        rowCount: rows.length,
        collectedCount: collected.length,
        duplicatesRemoved: collected.length - rows.length,
        at: new Date().toISOString(),
        rows,
      });
    }
    console.log(`[自采] 完成：去重后 ${rows.length} 行（原始 ${collected.length} 行）`);
    const dropped = rows.dedupeReport ?? { droppedBlank: 0, droppedDuplicate: 0 };
    if (dropped.droppedDuplicate || dropped.droppedBlank) {
      console.log(`[自采] 丢弃：重复 ${dropped.droppedDuplicate} 条，无商品链接 ${dropped.droppedBlank} 条`
        + (dropped.droppedBlank ? '（无链接行会让下游 validateDataset 整批失败，必须丢）' : ''));
    }
    // 类目覆盖率必须显式报出来：转成中文的比例不明时，下游「按类目统计」就是含糊其辞。
    const coverage = categoryCoverage(rows);
    console.log(`[自采] 类目覆盖：${coverage.named}/${coverage.total} 转中文（${coverage.namedPct}%），`
      + `保留 ID ${coverage.raw} 行，空 ${coverage.blank} 行`);
    if (coverage.unknownIds.length) {
      console.warn(`[自采] 未收录的类目 ID：${coverage.unknownIds.map((x) => `${x.id}×${x.count}`).join(', ')}`
        + `（请确认后补进 runtime/category-map.mjs）`);
    }
    console.log(`[自采] CSV → ${options.out}`);
    return 0;
  } finally {
    if (targetId) {
      try { await session.send('Target.closeTarget', { targetId }, undefined, 5000); } catch { /* 关不掉就算了 */ }
    }
    session.close();
  }
}

// 只在直接执行时跑主流程，被 import 时只暴露纯函数（供测试）。
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[自采] 失败：${error && error.message ? error.message : error}`);
      process.exit(1);
    });
}

export { parseArgs, resolveBrowser, buildPageExpression, collectPage };
