#!/usr/bin/env node
// 淘宝详情页采集器（自采，承接小旺神停摆后的 SKU 与评价能力）。
//
// 取数路径（2026-10-26 实测可通）：
//   Node ──CDP──▶ 竞品浏览器(:9222) 新开 tab ──▶ item.taobao.com/item.htm?id=...
//        ├─ Runtime.evaluate 调 window.lib.mtop.request(mtop.taobao.pcdetail.data.get)  → skuBase
//        └─ Runtime.evaluate 调 window.lib.mtop.request(mtop.taobao.rate.detaillist.get) → rateList
//
// 为什么不自己算签名：mtop 的 sign 可解，但 bx-ua/bx-umidtoken 是 baxia 混淆产物；
// 借页面 SDK 现算，成本远低于逆向。这与 collect-taobao-search.mjs 同一原则。
//
// 买家秀（mtop.taobao.ugc.itemshow.list）实测四种调用形态全部 ABORT，
// 小旺神原本是自己算 sign 直打 h5api，不依赖页面 SDK——那条要单独做，本文件不含。
//
// 用法：
//   node runtime/collect-taobao-detail.mjs --items 597600994634,678598686014 \
//        --out-sku runtime/sku.csv --out-review runtime/reviews.csv [--out-sku-attr runtime/sku-attr.csv] \
//        [--review-pages 1] [--page-size 40] [--frequency 3-6] [--checkpoint-prefix tmp/detail-1026]
//
//   或从周表取商品：--from-csv runtime/taobao-weekly-20261026.csv --limit 20
//
// 退出码：0 = 全部商品成功；1 = 有商品失败（已采到的仍落盘）。
// 写盘保护：本次 0 行时不落盘、原文件保持不动（加 --allow-empty 才写空表）。

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_PORTS } from './browser-ports.mjs';
import { toCsv } from './taobao-search-core.mjs';
import {
  SKU_API,
  SKU_API_VERSION,
  REVIEW_API,
  REVIEW_API_VERSION,
  APP_KEY,
  DEFAULT_REVIEW_PAGE_SIZE,
  SKU_COLUMNS,
  SKU_ATTR_COLUMNS,
  REVIEW_COLUMNS,
  buildSkuRequestData,
  buildReviewRequestData,
  readItemPayload,
  parseSkuBase,
  buildSkuRows,
  buildSkuAttributeRows,
  parseReviewResponse,
  buildReviewRows,
} from './taobao-detail-core.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const NAV_TIMEOUT_MS = 60_000;
const EVAL_TIMEOUT_MS = 60_000;
// mtop 正常几十到几百毫秒就回。同一个商品短时间被反复请求后，接口会挂住不返回
// （2026-10-26 实测：同一商品连续 6 次后必挂），所以这里的超时要短，让它快速失败，
// 而不是把整批拖死。
const MTOP_TIMEOUT_MS = 25_000;
const DETAIL_HOSTS = new Set(['item.taobao.com', 'detail.tmall.com', 'chaoshi.detail.tmall.com', 'detail.tmall.hk']);

const VALUE_OPTIONS = new Map([
  ['--items', 'items'],
  ['--from-csv', 'fromCsv'],
  ['--limit', 'limit'],
  ['--out-sku', 'outSku'],
  ['--out-sku-attr', 'outSkuAttr'],
  ['--out-review', 'outReview'],
  ['--raw-out', 'rawOut'],
  ['--review-pages', 'reviewPages'],
  ['--page-size', 'pageSize'],
  ['--frequency', 'frequency'],
  ['--checkpoint-prefix', 'checkpointPrefix'],
  ['--port', 'port'],
]);

function parseArgs(argv) {
  const options = {
    frequency: '3-6',
    reviewPages: '1',
    pageSize: String(DEFAULT_REVIEW_PAGE_SIZE),
    port: PROJECT_PORTS.competitorBrowser,
    dryRun: false,
    allowEmpty: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--allow-empty') { options.allowEmpty = true; continue; }
    const key = VALUE_OPTIONS.get(arg);
    if (!key) throw new Error(`未知参数：${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
    options[key] = value;
    i += 1;
  }
  if (!options.items && !options.fromCsv) throw new Error('--items 或 --from-csv 必填');
  if (!options.outSku && !options.outReview) throw new Error('--out-sku 与 --out-review 至少要给一个');
  options.reviewPageCount = Number(options.reviewPages);
  if (!Number.isInteger(options.reviewPageCount) || options.reviewPageCount < 1) {
    throw new Error(`--review-pages 必须是 >=1 的整数，收到 ${options.reviewPages}`);
  }
  options.pageSizeNumber = Number(options.pageSize);
  if (!Number.isInteger(options.pageSizeNumber) || options.pageSizeNumber < 1 || options.pageSizeNumber > 100) {
    throw new Error(`--page-size 必须是 1..100，收到 ${options.pageSize}`);
  }
  options.frequencyRange = parseFrequency(options.frequency);
  return options;
}

export function parseFrequency(spec) {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(String(spec ?? '').trim());
  if (!match) throw new Error(`--frequency 需为 MIN-MAX（秒），收到 "${spec}"`);
  const min = Number(match[1]) * 1000;
  const max = Number(match[2] ?? match[1]) * 1000;
  if (min <= 0) throw new Error('--frequency 最小值必须 > 0');
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

// 从周表 CSV 的「商品链接」列取 ID。序号重复是正常的（同名商品多 SKU 展示），这里只取 ID 去重。
export function itemIdsFromCsv(text) {
  const ids = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    for (const match of line.matchAll(/[?&]id=(\d{6,30})/gu)) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = ({ min, max }) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));

class CdpSession {
  constructor(ws) { this.ws = ws; this.nextId = 0; this.pending = new Map(); }

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

  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

async function resolveBrowser(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`浏览器 ${port} 不可用：HTTP ${response.status}`);
  const info = await response.json();
  if (!info.webSocketDebuggerUrl) throw new Error(`浏览器 ${port} 没有返回 webSocketDebuggerUrl`);
  return info;
}

async function evaluateJson(session, sessionId, expression, timeoutMs = EVAL_TIMEOUT_MS) {
  const result = await session.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '';
    throw new Error(`页面内求值抛异常：${String(text).slice(0, 300)}`);
  }
  const value = result.result?.value;
  if (typeof value !== 'string') throw new Error(`页面内求值未返回字符串（实际 ${typeof value}）`);
  return JSON.parse(value);
}

// 页面是否被要求过验证。请求挂住时用它给出可读结论，而不是只报「超时」。
const CAPTCHA_PROBE_EXPR = `JSON.stringify({
  text: (document.body ? document.body.innerText : '').slice(0, 4000),
  hasPuzzle: !!document.querySelector('#nocaptcha,[class*="nc_iconfont"],[id*="nc_1_wrapper"],iframe[src*="punish"]')
})`;

export async function detectChallenge(session, sessionId) {
  try {
    const state = await evaluateJson(session, sessionId, CAPTCHA_PROBE_EXPR, 5000);
    const text = String(state.text || '');
    const hints = ['滑动验证', '安全验证', '验证后继续', '请完成验证', '身份验证', '访问验证'];
    const hit = hints.find((h) => text.includes(h));
    if (hit) return hit;
    if (state.hasPuzzle) return '验证控件';
    return '';
  } catch {
    return '';
  }
}

const PAGE_STATE_EXPR = `JSON.stringify({
  hasSdk: !!(window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function'),
  url: location.href,
  readyState: document.readyState
})`;

// 在页面主世界发一次 mtop。签名与风控参数由页面自算，这里不碰。
function mtopExpression({ api, version, data }) {
  return `(async () => {
    const mtop = window.lib && window.lib.mtop;
    if (!mtop || typeof mtop.request !== 'function') return JSON.stringify({ ok: false, reason: 'NO_MTOP_SDK' });
    try {
      const response = await mtop.request({
        api: ${JSON.stringify(api)},
        v: ${JSON.stringify(version)},
        appKey: ${JSON.stringify(APP_KEY)},
        type: 'get',
        dataType: 'jsonp',
        data: ${JSON.stringify(data)}
      });
      const ret = (response && response.ret) || [];
      const ok = Array.isArray(ret) ? ret.some(r => typeof r === 'string' && r.startsWith('SUCCESS::')) : false;
      if (!ok) return JSON.stringify({ ok: false, reason: 'NON_SUCCESS', ret });
      return JSON.stringify({ ok: true, ret, data: (response && response.data) || null });
    } catch (error) {
      const message = error && typeof error === 'object'
        ? JSON.stringify(error).slice(0, 300)
        : String(error).slice(0, 300);
      return JSON.stringify({ ok: false, reason: 'REQUEST_THREW', message });
    }
  })()`;
}

async function waitForSdk(session, sessionId, { expectItemId, timeoutMs = NAV_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    try { last = await evaluateJson(session, sessionId, PAGE_STATE_EXPR); } catch { continue; }
    if (!last.hasSdk) continue;
    if (expectItemId) {
      // 详情页会从 item.taobao.com 跳到 detail.tmall.com，但 id 必须还是同一个。
      const currentId = new URL(last.url).searchParams.get('id');
      if (String(currentId) !== String(expectItemId)) continue;
    }
    if (last.readyState === 'complete') return last;
  }
  throw new Error(`详情页未就绪（最后状态：${JSON.stringify(last)}）`);
}

async function collectSku(session, sessionId, itemId) {
  const payload = await evaluateJson(session, sessionId, mtopExpression({
    api: SKU_API,
    version: SKU_API_VERSION,
    data: buildSkuRequestData(itemId),
  }), MTOP_TIMEOUT_MS);
  if (!payload.ok) {
    throw new Error(`SKU 接口失败：${payload.reason}${payload.message ? ` / ${payload.message}` : ''}`);
  }
  return readItemPayload({ data: payload.data }, itemId);
}

async function collectReviews(session, sessionId, itemId, { pages, pageSize }) {
  const all = [];
  let meta = { total: '', totalPage: '', hasNext: false };
  for (let page = 1; page <= pages; page += 1) {
    const payload = await evaluateJson(session, sessionId, mtopExpression({
      api: REVIEW_API,
      version: REVIEW_API_VERSION,
      data: buildReviewRequestData(itemId, { page, pageSize }),
    }), MTOP_TIMEOUT_MS);
    if (!payload.ok) {
      throw new Error(`评价接口第 ${page} 页失败：${payload.reason}${payload.message ? ` / ${payload.message}` : ''}`);
    }
    const parsed = parseReviewResponse({ data: payload.data }, itemId);
    if (page === 1) meta = { total: parsed.total, totalPage: parsed.totalPage, hasNext: parsed.hasNext };
    all.push(...parsed.reviews);
    if (!parsed.hasNext) break;
    if (page < pages) await sleep(700);
  }
  return { reviews: all, meta };
}

// 现有文件的数据行数（不含表头）。文件不存在或读不了都算 0。
export function existingDataRows(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0);
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}

// 写 CSV，默认拒绝把已有数据覆盖成 0 行。
//
// 2026-10-26 事故：第 1 轮采到 110 行 SKU，第 2 轮被淘宝滑块挡住、每个商品都失败，
// 结尾仍然按原路径写出了只有表头的 CSV，把第 1 轮的结果覆盖成空表。
// 空表比没有更误导——下游会把它当成「采过了，这个商品没有 SKU」。
// 所以这里改成：本次 0 行就不落盘，原文件保持不动，除非显式给 --allow-empty。
export function writeCsvFile(filePath, rows, columns, { allowEmpty = false } = {}) {
  if (!rows.length && !allowEmpty) {
    const existing = existingDataRows(filePath);
    const where = existing > 0 ? `保留原文件里的 ${existing} 行` : '文件不存在，不创建空表';
    console.warn(`[详情] 跳过写入 ${filePath}：本次 0 行，${where}`);
    return { written: false, rows: 0, existing };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, toCsv(rows, columns), 'utf8');
  console.log(`[详情] 写出 ${filePath}（${rows.length} 行）`);
  return { written: true, rows: rows.length, existing: 0 };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
}

export function resolveItemIds(options) {
  if (options.items) {
    const ids = String(options.items).split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!/^\d{1,30}$/u.test(id)) throw new Error(`--items 里有非法 ID：${id}`);
    return ids;
  }
  const text = fs.readFileSync(options.fromCsv, 'utf8');
  let ids = itemIdsFromCsv(text);
  if (options.limit) {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit 必须是 >=1 的整数`);
    ids = ids.slice(0, limit);
  }
  if (!ids.length) throw new Error(`${options.fromCsv} 里没有解析到商品 ID`);
  return ids;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const itemIds = resolveItemIds(options);

  if (options.dryRun) {
    console.log(JSON.stringify({
      itemCount: itemIds.length,
      firstIds: itemIds.slice(0, 5),
      reviewPages: options.reviewPageCount,
      pageSize: options.pageSizeNumber,
      frequencyMs: options.frequencyRange,
      outSku: options.outSku ?? null,
      outReview: options.outReview ?? null,
      port: options.port,
    }, null, 1));
    return 0;
  }

  const browser = await resolveBrowser(options.port);
  console.log(`[详情] 浏览器 ${options.port}（${browser.Browser}），${itemIds.length} 个商品`);
  const session = await CdpSession.connect(browser.webSocketDebuggerUrl);
  let targetId = null;
  let sessionId = null;

  const skuRows = [];
  const skuAttrRows = [];
  const reviewRows = [];
  const perItem = [];
  let failures = 0;

  try {
    const created = await session.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await session.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attached.sessionId;
    await session.send('Page.enable', {}, sessionId);

    for (let index = 0; index < itemIds.length; index += 1) {
      const itemId = itemIds[index];
      const record = { itemId, ok: false, skuCount: 0, reviewCount: 0 };
      try {
        const url = `https://item.taobao.com/item.htm?id=${itemId}`;
        await session.send('Page.navigate', { url }, sessionId, NAV_TIMEOUT_MS);
        const state = await waitForSdk(session, sessionId, { expectItemId: itemId });
        const host = new URL(state.url).hostname;
        if (!DETAIL_HOSTS.has(host)) throw new Error(`不在详情页（${state.url}）`);

        const item = await collectSku(session, sessionId, itemId);
        record.title = item.title;
        record.shopName = item.seller.shopName;
        if (item.skuBase) {
          const parsed = parseSkuBase(item.skuBase, { skuCore: item.skuCore });
          skuRows.push(...buildSkuRows(parsed, { itemId, title: item.title }));
          skuAttrRows.push(...buildSkuAttributeRows(parsed, { itemId, title: item.title }));
          record.skuCount = parsed.skus.length;
          record.attrNames = parsed.props.map((p) => `${p.name}(${p.values.length})`);
        } else {
          // 单规格商品没有 skuBase，是正常情况，不是失败。
          record.skuCount = 0;
          record.note = '无 skuBase（单规格）';
        }

        const { reviews, meta } = await collectReviews(session, sessionId, itemId, {
          pages: options.reviewPageCount,
          pageSize: options.pageSizeNumber,
        });
        reviewRows.push(...buildReviewRows(reviews));
        record.reviewCount = reviews.length;
        record.reviewTotal = meta.total;
        record.ok = true;
        console.log(`[详情] ${index + 1}/${itemIds.length} ${itemId} SKU ${record.skuCount}，评价 ${record.reviewCount}/${meta.total || '?'}`
          + `｜${String(item.title).slice(0, 24)}`);
      } catch (error) {
        failures += 1;
        record.error = error && error.message ? error.message : String(error);
        const challenge = await detectChallenge(session, sessionId);
        if (challenge) record.error += `（页面出现${challenge}，需人工处理后再跑）`;
        console.error(`[详情] ${index + 1}/${itemIds.length} ${itemId} 失败：${record.error}`);
      }
      perItem.push(record);

      if (options.checkpointPrefix) {
        writeJson(`${options.checkpointPrefix}.progress.json`, {
          done: index + 1, total: itemIds.length, failures, skuRows: skuRows.length,
          reviewRows: reviewRows.length, items: perItem, updatedAt: new Date().toISOString(),
        });
      }

      if (index < itemIds.length - 1) {
        const wait = jitter(options.frequencyRange);
        console.log(`[详情] 等 ${(wait / 1000).toFixed(1)} 秒再取下一个商品`);
        await sleep(wait);
      }
    }

    const allowEmpty = options.allowEmpty === true;
    const written = [];
    if (options.outSku) written.push(writeCsvFile(options.outSku, skuRows, SKU_COLUMNS, { allowEmpty }));
    if (options.outSkuAttr) written.push(writeCsvFile(options.outSkuAttr, skuAttrRows, SKU_ATTR_COLUMNS, { allowEmpty }));
    if (options.outReview) written.push(writeCsvFile(options.outReview, reviewRows, REVIEW_COLUMNS, { allowEmpty }));
    if (options.rawOut) {
      writeJson(options.rawOut, {
        at: new Date().toISOString(), port: options.port,
        reviewPages: options.reviewPageCount, pageSize: options.pageSizeNumber,
        itemCount: itemIds.length, failures, items: perItem,
        outputs: written,
      });
    }
    console.log(`[详情] 完成：${itemIds.length - failures}/${itemIds.length} 个商品成功`);
    const skipped = written.filter((entry) => !entry.written).length;
    if (skipped) console.warn(`[详情] 有 ${skipped} 个输出因 0 行被跳过，原文件未改动`);
    return failures === 0 ? 0 : 1;
  } finally {
    if (targetId) {
      try { await session.send('Target.closeTarget', { targetId }, undefined, 5000); } catch { /* 关不掉就算了 */ }
    }
    session.close();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[详情] 失败：${error && error.message ? error.message : error}`);
      process.exit(1);
    });
}

export { main, parseArgs, resolveBrowser, mtopExpression, waitForSdk, collectSku, collectReviews };
