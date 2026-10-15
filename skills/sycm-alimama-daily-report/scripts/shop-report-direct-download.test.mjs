import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { shopReportNamePattern } from './collect-core.mjs';
import {
  fetchDirectDownload, fileNameFromDirectUrl, installDirectDownloadCaptureExpression,
  isDirectDownloadCandidate, pickDirectDownloadUrl, readDirectDownloadUrlsExpression,
} from './shop-report-direct-download.mjs';

// 夹具＝2026-10-15 根因探针**真机捕获**的那条 OSS 签名 URL
// （tmp/rootcause-20261015/oss-url-full.txt，网林天猫、统计日 2026-10-14 那份工作簿）。
// 用真URL而不是我编的短串：这条链路全是「形状差一点就静默失败」的病
// （编码路径、Signature 查询参数、Expires），编造的夹具验不到那些。
const OSS_URL_A = 'https://one-fetch-report.oss-cn-zhangjiakou.aliyuncs.com/reports/2219095772127'
  + '/report/202610/%E6%97%A5%E6%8A%A5_20261015_65141cc3c0fd0c526f65e7da28ff800b.xlsx'
  + '?Expires=1792052246&OSSAccessKeyId=LTAI5t6Ra3JTBxbA2mkDoCSn&Signature=%2BLN4tDDP2Uih85maxrpVrnhXK5Y%3D';
// 探针实验 B 实测形状：同一次点击后出现**两条同路径、不同 Expires** 的候选。
const OSS_URL_B = OSS_URL_A.replace('Expires=1792052246', 'Expires=1792052307');
const REAL_NAME = '日报_20261015_65141cc3c0fd0c526f65e7da28ff800b.xlsx';

// 一个最小 xlsx（zip）：PK 头 + 凑数内容。真实产物是 19732 字节（探针实测），
// 这里只验「头两字节是 PK」这道门，不需要真工作簿。
const FAKE_XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'direct-dl-test-'));
}

test('fileNameFromDirectUrl：真实签名 URL → 解码后的中文文件名', () => {
  // 这条钉的是「百分号路径必须解码」—— 不解码落盘的名字判据根本不认
  // （2026-10-05 同款病：文件下来了却没人认）。
  assert.equal(fileNameFromDirectUrl(OSS_URL_A), REAL_NAME);
  assert.equal(fileNameFromDirectUrl(OSS_URL_B), REAL_NAME);
});

test('fileNameFromDirectUrl：不是可下载 URL 的形态 ⇒ null（不猜）', () => {
  assert.equal(fileNameFromDirectUrl('not a url'), null);
  assert.equal(fileNameFromDirectUrl(''), null);
  assert.equal(fileNameFromDirectUrl(null), null);
  assert.equal(fileNameFromDirectUrl('https://oss.example.com/'), null, '没有路径段 ⇒ 取不到文件名');
  assert.equal(fileNameFromDirectUrl('blob:https://sycm.taobao.com/abc-123'), null, 'blob: 不是 http(s)');
});

test('判据门：真实文件名必须过得去店家的 reportPattern（含盖文天猫的登记形态）', () => {
  // 网林天猫未登记行标题 ⇒ 默认形态（含「日报」即可）
  assert.equal(isDirectDownloadCandidate(OSS_URL_A, shopReportNamePattern(null)), true);
  // 盖文天猫登记了「活动-店铺-整体-近30天」⇒ 登记名**或**默认形态都收
  // （collect-core 的 shopReportNamePattern：登记名是补充，不是替换）
  assert.equal(isDirectDownloadCandidate(OSS_URL_A, shopReportNamePattern('活动-店铺-整体-近30天')), true);
});

test('判据门：形状不对的文件名一律拒（锁文件/短日期/完全不像）', () => {
  const pattern = shopReportNamePattern(null);
  assert.equal(isDirectDownloadCandidate('https://oss.example.com/%E6%97%A5%E6%8A%A5_2026101_abc.xlsx', pattern),
    false, '日期段不是 8 位 ⇒ 不是平台产物');
  assert.equal(isDirectDownloadCandidate('https://oss.example.com/~%24%E6%97%A5%E6%8A%A5_20261015_abc.xlsx', pattern),
    false, 'Excel 锁文件 ~$ 开头 ⇒ 不收');
  assert.equal(isDirectDownloadCandidate('https://oss.example.com/report.csv', pattern), false, '不是 xlsx');
  assert.equal(isDirectDownloadCandidate('https://oss.example.com/', pattern), false, '没有文件名');
});

test('判据门：pattern 不是 RegExp ⇒ 抛错，不静默当成不匹配', () => {
  // 把「判据没给对」演成「平台没给 URL」是这个项目反复栽过的静默失败形态
  assert.throws(() => isDirectDownloadCandidate(OSS_URL_A, '日报'), /RegExp/u);
  assert.throws(() => isDirectDownloadCandidate(OSS_URL_A, null), /RegExp/u);
});

test('pickDirectDownloadUrl：多个候选取**最后一条**（签名最新，探针 B 实测形状）', () => {
  const pattern = shopReportNamePattern(null);
  assert.equal(pickDirectDownloadUrl([OSS_URL_A, OSS_URL_B], pattern), OSS_URL_B,
    '同路径不同 Expires：拿旧签名去下只会 403');
  assert.equal(pickDirectDownloadUrl([OSS_URL_B, OSS_URL_A], pattern), OSS_URL_A);
  // 混进不像的也不许把对的挤掉（从后往前找第一个合格的）
  assert.equal(pickDirectDownloadUrl([OSS_URL_A, 'https://x.example.com/a.csv'], pattern), OSS_URL_A);
  assert.equal(pickDirectDownloadUrl([], pattern), null);
  assert.equal(pickDirectDownloadUrl(null, pattern), null, '读不到页面数组时 ⇒ 没有候选');
});

test('仪表表达式：三个渠道都装上、href 一律拿全（不许 slice）', () => {
  const expression = installDirectDownloadCaptureExpression();
  assert.equal(typeof expression, 'string');
  // 探针第一版把 href slice(0,200)，Signature 被截 ⇒ 残缺 URL 直下只会 403。
  // 这条钉的是**表达式本身**，不是注释。
  assert.ok(!expression.includes('slice'), '表达式里不许出现 slice：href/URL 必须拿全');
  // 不硬编码任何主机名：平台换 OSS 桶/换 Viewer 域名都不该让链路瞎
  assert.ok(!expression.includes('aliyuncs'), '不许硬编码 OSS 主机名');
  assert.ok(!expression.includes('officeapps'), '不许硬编码 Viewer 主机名');
  for (const hook of ['HTMLAnchorElement.prototype.click', 'window.open', 'MutationObserver']) {
    assert.ok(expression.includes(hook), `仪表必须接 ${hook}`);
  }
  // Viewer 地址要从 src 参数里取回 OSS URL（探针实测的另一条拿全 URL 的路）
  assert.ok(expression.includes("searchParams.get('src')"));
});

test('读回表达式：读的就是仪表那个数组', () => {
  const expression = readDirectDownloadUrlsExpression();
  assert.ok(expression.includes('__sycmDirectUrls'));
});

test('仪表表达式在假 DOM 里真跑：三渠道各自能记到、且记的是全 URL', () => {
  // 表达式不是「看着对」就行 —— 必须真能被调用一次（本项目吃过
  // 「判据包成 RegExp 恒不命中」的亏，同理适用于页面表达式）。
  const expression = installDirectDownloadCaptureExpression();
  globalThis.window = globalThis; // 表达式里的 window 就是全局（Node 原本没有 window）
  globalThis.open = () => null; // 仪表要包装的原生 window.open
  globalThis.HTMLAnchorElement = class FakeAnchor {
    constructor(href) { this.href = href; }
    click() { /* 平台原本的动作 */ }
  };
  globalThis.MutationObserver = class FakeObserver {
    constructor(callback) { this.callback = callback; }
    observe() { /* 记录用 */ }
  };
  globalThis.document = { documentElement: {} };

  // eslint-disable-next-line no-eval
  assert.equal(eval(expression), 'installed');

  // 渠道 ①：平台自建锚点后调 a.click()（不可信手势下也会走 —— 探针实验 A）
  const anchor = new globalThis.HTMLAnchorElement(OSS_URL_A);
  anchor.click();
  anchor.click();
  assert.deepEqual(globalThis.__sycmDirectUrls, [OSS_URL_A], '点两次同一条 ⇒ 只记一条，且是完整 URL');

  // 渠道 ②：window.open 一个 Office Viewer 地址 ⇒ 取出 src 里的 OSS URL
  const viewer = 'https://view.officeapps.live.com/op/view.aspx?src='
    + encodeURIComponent(OSS_URL_A);
  globalThis.open(viewer);
  assert.deepEqual(globalThis.__sycmDirectUrls, [OSS_URL_A],
    'Viewer 的 src 解出来与渠道 ① 是同一条 ⇒ 去重后仍是一条');

  // 渠道 ③：DOM 里新插入的锚点（没被点也该记到）。
  // 表达式里的 observer 实例拿不到 ⇒ 把 MutationObserver 的回调存下来再喂记录。
  let observerCallback = null;
  globalThis.MutationObserver = class FakeObserver2 {
    constructor(callback) { observerCallback = callback; }
    observe() { /* 记录用 */ }
  };
  delete globalThis.__sycmDirectUrls;
  // eslint-disable-next-line no-eval
  eval(expression);
  const inserted = new globalThis.HTMLAnchorElement(OSS_URL_B);
  const host = { nodeType: 1, tagName: 'DIV', querySelectorAll: () => [inserted] };
  observerCallback([{ addedNodes: [host] }]);
  assert.deepEqual(globalThis.__sycmDirectUrls, [OSS_URL_B],
    '新插进 DOM 的锚点（含子树里的）也要记到');

  delete globalThis.window;
  delete globalThis.open;
  delete globalThis.HTMLAnchorElement;
  delete globalThis.MutationObserver;
  delete globalThis.document;
  delete globalThis.__sycmDirectUrls;
});

test('fetchDirectDownload：200 + PK 头 ⇒ 落盘并回传与老通道同形的三件套', async () => {
  const dir = tempDir();
  try {
    const result = await fetchDirectDownload({
      url: OSS_URL_A, dir, pattern: shopReportNamePattern(null),
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => FAKE_XLSX }),
    });
    assert.equal(result.name, REAL_NAME);
    assert.equal(result.size, FAKE_XLSX.length);
    assert.equal(result.path, path.join(dir, REAL_NAME));
    assert.ok(existsSync(result.path), '文件必须真在磁盘上');
    assert.deepEqual(readFileSync(result.path), FAKE_XLSX, '落盘内容与响应体逐字节一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchDirectDownload：文件名过不了判据 ⇒ 连 fetch 都不发起（fail-closed）', async () => {
  const dir = tempDir();
  let called = false;
  try {
    await assert.rejects(() => fetchDirectDownload({
      url: 'https://oss.example.com/report.csv', dir, pattern: shopReportNamePattern(null),
      fetchImpl: async () => { called = true; return { ok: true, status: 200, arrayBuffer: async () => FAKE_XLSX }; },
    }), /过不了店家文件名判据/u);
    assert.equal(called, false, '判据不过就不该去取');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchDirectDownload：非 200 ⇒ 抛错且不落盘（签名过期就是这个形态）', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(() => fetchDirectDownload({
      url: OSS_URL_A, dir, pattern: shopReportNamePattern(null),
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'AccessDenied' }),
    }), /直下 HTTP 403/u);
    assert.equal(existsSync(path.join(dir, REAL_NAME)), false, '失败不许留下半个文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchDirectDownload：200 但不是 zip（PK）⇒ 抛错且不落盘', async () => {
  // 平台返回错误页/HTML 时也是 200 —— 没有这道门，一个 HTML 会被当成
  // 「下载成功」写进回执、推到底单里。
  const dir = tempDir();
  try {
    await assert.rejects(() => fetchDirectDownload({
      url: OSS_URL_A, dir, pattern: shopReportNamePattern(null),
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('<html>oops') }),
    }), /不是 xlsx/u);
    assert.equal(existsSync(path.join(dir, REAL_NAME)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
