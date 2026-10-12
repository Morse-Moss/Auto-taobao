// 商品底单采集「编排与判据」的离线用例（2026-10-12 建）。
//
// 为什么要离线钉住写侧之外的这三件事：2026-10-12 里可林天猫报「下载超时」，翻浏览器自己的
// 下载历史库才知道**那次点击根本没产生下载请求**。而原版丢弃点击返回值、不重试、失败不落现场，
// 于是「锚点在点的时候不在了」与「点了没生效」两种成因事后无法分辨。这三条都是**静默**的
// （错了不会自己报错），所以必须有判据钉住，而不是只靠真机。
//
// 假代理按**逐字相等**分派请求：核心发出去的表达式一旦变了，这里立刻 404 而不是悄悄放过 ——
// 这同时是「这条链到底发了什么」的守据（表达式常量只有一份，在 core 里）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DOWNLOAD_FILE_PREFIX,
  ITEM_RANK_URL,
  clickDayExpr,
  clickDownloadExpr,
  collectProductReport,
  identityExpr,
  isReady,
  listDownloads,
  readStateExpr,
} from './collect-product-core.mjs';

const SHOP = '里可林天猫';
const IDENTITY = '里可林旗舰店';
const DATE = '2026-10-11';
const WORK_PAGE = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const noop = () => Promise.resolve();
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(8) });
const bad = (status, body = {}) => ({ ok: false, status, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });

/**
 * 有状态的假 CDP 代理。`scenario` 控制下载点击的返回值和「点了会不会真的落文件」。
 * 分派用**逐字相等**：核心换了表达式，这里就会走 404 分支让用例红。
 */
function fakeProxy({ clickReturns = [true], emitOnAcceptedClick = true } = {}) {
  const tab = { targetId: 't1', type: 'page', url: WORK_PAGE };
  const requests = [];
  let downloadClicks = 0;
  let targetsReads = 0;
  const state = { downloadAnchor: false };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push(`${init.method ?? 'GET'} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === '/targets') { targetsReads += 1; return ok([{ ...tab }]); }
    if (parsed.pathname === '/navigate') {
      assert.equal(parsed.searchParams.get('target'), 't1');
      assert.equal(parsed.searchParams.get('url'), ITEM_RANK_URL, '每一轮都要重新导航到商品排行');
      tab.url = ITEM_RANK_URL;
      return ok({ frameId: '0C6B' });
    }
    if (parsed.pathname === '/screenshot') return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), text: async () => '' };
    if (parsed.pathname !== '/eval') return bad(404, { error: 'unknown path' });
    const expression = String(init.body ?? '');
    if (expression === identityExpr(IDENTITY)) return ok({ value: JSON.stringify({ shop: IDENTITY }) });
    if (expression === clickDayExpr()) {
      // 点「日」之后，商品排行页 URL 才带上日粒度与目标日 —— 与真实页面一致（日期是带横线的形式）。
      tab.url = `${ITEM_RANK_URL}?dateType=day&startDate=${DATE}&endDate=${DATE}`;
      state.downloadAnchor = true;
      return ok({ value: true });
    }
    if (expression === readStateExpr()) return ok({ value: JSON.stringify({ url: tab.url, text: '商品排行', download: state.downloadAnchor }) });
    if (expression === clickDownloadExpr()) {
      downloadClicks += 1;
      const returned = clickReturns[downloadClicks - 1] ?? clickReturns.at(-1) ?? true;
      if (returned && emitOnAcceptedClick) {
        fs.writeFileSync(path.join(scenarioDir, `${DOWNLOAD_FILE_PREFIX}${DATE}_${DATE} (${downloadClicks}).xls`), `row-${downloadClicks}`);
      }
      return ok({ value: returned });
    }
    return bad(400, { error: `unexpected expression: ${expression.slice(0, 120)}` });
  };
  let scenarioDir = '';
  return {
    fetchImpl, requests,
    getName: () => ({ downloadClicks, targetsReads }),
    setDir: (dir) => { scenarioDir = dir; },
  };
}

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

async function run(scenario, overrides = {}) {
  const downloads = tempDir('sycm-dl-');
  const evidence = tempDir('sycm-ev-');
  const proxy = fakeProxy(scenario);
  proxy.setDir(downloads);
  const call = collectProductReport({
    proxy: 'http://127.0.0.1:19061', shop: SHOP, date: DATE, downloads, evidenceDir: evidence,
    expectedIdentity: IDENTITY, fetchImpl: proxy.fetchImpl, sleep: noop,
    attempts: 3, dayTimeoutMs: 800, readyTimeoutMs: 800, downloadTimeoutMs: 800, ...overrides,
  });
  return { call, proxy, downloads, evidence };
}

test('一次点击即成：只点一次下载、只读一次页签，返回落盘文件', async () => {
  const { call, proxy } = await run({ clickReturns: [true] });
  const result = await call;
  assert.equal(result.attempts, 1);
  assert.equal(result.missedClicks, 0);
  assert.equal(path.basename(result.file).startsWith(DOWNLOAD_FILE_PREFIX), true);
  assert.deepEqual(proxy.getName(), { downloadClicks: 1, targetsReads: 1 });
});

test('第一次点击时锚点已不在（返回 false）⇒ 重试拿干净页，第二次成功', async () => {
  const { call, proxy } = await run({ clickReturns: [false, true] });
  const result = await call;
  assert.equal(result.attempts, 2, '第一次没取到文件必须重试');
  assert.equal(result.missedClicks, 1, '「点的时候锚点不在」要被记下来 —— 这正是原版丢掉的那半个事实');
  assert.deepEqual(proxy.getName(), { downloadClicks: 2, targetsReads: 2 }, '重试必须重新发现页签并重新导航');
});

test('点了但没生效（三次都返回 true、始终没有文件）⇒ 抛「下载超时」并落现场', async () => {
  const { call, proxy, evidence } = await run({ clickReturns: [true, true, true], emitOnAcceptedClick: false });
  await assert.rejects(call, (error) => {
    assert.match(error.message, /下载超时/u, '错误信息必须保留「下载超时」：上层归类靠它判 TRANSIENT_EXTERNAL');
    return true;
  });
  assert.equal(proxy.getName().downloadClicks, 3, '三次都必须真的点出去');
  const jsonFile = path.join(evidence, `${DATE}-${SHOP}.failure.json`);
  assert.equal(fs.existsSync(jsonFile), true, '失败必须落现场，不许只留一句符号');
  const snapshot = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.equal(snapshot.attempts.length, 3);
  assert.deepEqual(snapshot.attempts.map((entry) => entry.clicked), [true, true, true]);
  assert.equal(snapshot.pages.length, 1);
  assert.equal(Array.isArray(snapshot.downloadsMatchingPrefix), true);
  assert.equal(fs.existsSync(path.join(evidence, `${DATE}-${SHOP}.failure.png`)), true, '截图也要落（端点失败时才会缺）');
});

test('日期/下载按钮一直不就绪 ⇒ 报「未就绪」而不是「下载超时」（两种失败要分开）', async () => {
  const downloads = tempDir('sycm-dl-');
  const evidence = tempDir('sycm-ev-');
  // 假代理让「日」按钮点不动 ⇒ 页面永远停在非日粒度，readState 也不会出现下载锚点。
  const proxy = fakeProxy({ clickReturns: [true] });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/eval' && String(init.body ?? '') === clickDayExpr()) return ok({ value: false });
    return proxy.fetchImpl(url, init);
  };
  await assert.rejects(collectProductReport({
    proxy: 'http://127.0.0.1:19061', shop: SHOP, date: DATE, downloads, evidenceDir: evidence,
    expectedIdentity: IDENTITY, fetchImpl, sleep: noop, attempts: 1, dayTimeoutMs: 1, readyTimeoutMs: 1, downloadTimeoutMs: 1,
  }), /日按钮未找到/u);
});

test('isReady 只认「日粒度 + 目标日 + 有锚点」三件事同时成立', () => {
  const base = `${ITEM_RANK_URL}?dateType=day&startDate=${DATE}&endDate=${DATE}`;
  assert.equal(isReady({ url: base, download: true }, DATE), true);
  assert.equal(isReady({ url: base, download: false }, DATE), false, '日期对了但按钮不在 ⇒ 不算就绪');
  assert.equal(isReady({ url: `${ITEM_RANK_URL}?dateType=week&startDate=${DATE}&endDate=${DATE}`, download: true }, DATE), false);
  assert.equal(isReady({ url: `${ITEM_RANK_URL}?dateType=day&startDate=2026-10-10&endDate=2026-10-10`, download: true }, DATE), false, '别的日子不算');
  assert.equal(isReady(null, DATE), false);
});

test('listDownloads 只认商品底单前缀（别的报表不会串进来）', () => {
  const dir = tempDir('sycm-list-');
  fs.writeFileSync(path.join(dir, `${DOWNLOAD_FILE_PREFIX}${DATE}_${DATE}.xls`), 'x');
  fs.writeFileSync(path.join(dir, '日报_20261011_abc.xlsx'), 'x');
  assert.deepEqual(listDownloads(dir), [`${DOWNLOAD_FILE_PREFIX}${DATE}_${DATE}.xls`]);
});
