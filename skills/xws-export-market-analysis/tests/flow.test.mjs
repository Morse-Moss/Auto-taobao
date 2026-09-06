import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_HEADERS,
  assertProxyBrowserHealth,
  collectionActivitySignature,
  collectionDeadlineMs,
  collectionStallReason,
  classifyCollection,
  collectionResultSnapshot,
  createCollectionAttemptTracker,
  isSuccessfulCollectionResponse,
  detectRiskMarkers,
  parseProgressText,
  parseOptions,
  selectExportResultDialog,
  selectPendingRequest,
  selectTaobaoSearchTarget,
  validateDataset,
} from "../scripts/flow.mjs";

const resultText = ({ completed = 20, rows = 707 } = {}) => [
  "\u3010 \u6d74\u7f38 \u3011\u9500\u91cf\u6392\u5e8fTop" + rows + " - 2026-08-05 15:46 - \u5e02\u573a\u6570\u636e\u5206\u6790",
  "\u60a8\u641c\u7d22\u7684\u9875\u6570\uff1a\u7b2c 1 ~ 40 \u9875\uff0c\u5df2\u6210\u529f\u83b7\u53d6\uff1a\u7b2c 1 ~ " + completed + " \u9875",
  "\u5546\u54c1\u6570\u91cf\uff1a" + rows,
].join("\n");

test("selects only the result dialog that matches the current export attempt", () => {
  const current = "【 浴缸 】销量排序Top118 - 2026-09-05 17:27 - 市场数据分析\n您搜索的页数：第 22 ~ 40 页，已成功获取：第 22 ~ 24 页\n商品数量：118";
  const stale = "【 浴缸 】销量排序Top921 - 2026-09-05 16:31 - 市场数据分析\n您搜索的页数：第 1 ~ 40 页，已成功获取：第 1 ~ 21 页\n商品数量：921";

  assert.equal(selectExportResultDialog([stale, current], {
    keyword: "浴缸",
    requestedStart: 22,
    requestedEnd: 40,
    completedStart: 22,
    completedEnd: 24,
    rowCount: 118,
  }), 1);
  assert.throws(() => selectExportResultDialog([stale], {
    keyword: "浴缸",
    requestedStart: 22,
    requestedEnd: 40,
    completedStart: 22,
    completedEnd: 24,
    rowCount: 118,
  }), /matching result dialog/iu);
});

test("rejects ambiguous result dialogs for the same export attempt", () => {
  const current = "【 浴缸 】销量排序Top118 - 2026-09-05 17:27 - 市场数据分析\n您搜索的页数：第 22 ~ 40 页，已成功获取：第 22 ~ 24 页\n商品数量：118";
  assert.throws(() => selectExportResultDialog([current, current], {
    keyword: "浴缸",
    requestedStart: 22,
    requestedEnd: 40,
    completedStart: 22,
    completedEnd: 24,
    rowCount: 118,
  }), /received 2/iu);
});

test("selects the matching result dialog owned by the current attempt", () => {
  const text = "【 浴缸 】销量排序Top118 - 2026-09-05 17:27 - 市场数据分析\n您搜索的页数：第 22 ~ 40 页，已成功获取：第 22 ~ 24 页\n商品数量：118";
  assert.equal(selectExportResultDialog([
    { text, attemptMarker: "historical-attempt" },
    { text, attemptMarker: "current-attempt" },
  ], {
    keyword: "浴缸",
    requestedStart: 22,
    requestedEnd: 40,
    completedStart: 22,
    completedEnd: 24,
    rowCount: 118,
    attemptMarker: "current-attempt",
  }), 1);
  assert.throws(() => selectExportResultDialog([
    { text, attemptMarker: "historical-attempt" },
  ], {
    keyword: "浴缸",
    requestedStart: 22,
    requestedEnd: 40,
    completedStart: 22,
    completedEnd: 24,
    rowCount: 118,
    attemptMarker: "current-attempt",
  }), /received 0/iu);
});

test("proxy health must identify the bound Edge browser", () => {
  assert.equal(assertProxyBrowserHealth({ status: "ok", connected: true, browser: { id: "edge" } }), true);
  assert.throws(
    () => assertProxyBrowserHealth({ status: "ok", connected: false, browser: { id: "edge" } }),
    /not connected to edge/iu,
  );
  assert.throws(
    () => assertProxyBrowserHealth({ status: "ok", connected: true, browser: { id: "browser-service" } }),
    /browser mismatch.*edge.*browser-service/iu,
  );
  assert.throws(
    () => assertProxyBrowserHealth({ status: "ok", connected: true, browser: {} }),
    /browser mismatch.*<missing>/iu,
  );
});

test("result snapshot ignores decoration text outside structured collection progress", () => {
  const progress = "您搜索的页数：第 22 ~ 40 页，已成功获取：第 22 页\n商品数量：45";
  assert.deepEqual(
    collectionResultSnapshot(`提示 A\n${progress}`),
    collectionResultSnapshot(`提示 B\n${progress}`),
  );
});

test("accepts only explicitly successful collection responses", () => {
  assert.equal(isSuccessfulCollectionResponse({ retCode: 0 }), true);
  assert.equal(isSuccessfulCollectionResponse({ ret: 0, data: {} }), true);
  assert.equal(isSuccessfulCollectionResponse({ status: 200 }), true);
  assert.equal(isSuccessfulCollectionResponse({ ret: 1, data: {} }), false);
  assert.equal(isSuccessfulCollectionResponse({ retCode: 1 }), false);
  assert.equal(isSuccessfulCollectionResponse({ status: 500 }), false);
  assert.equal(isSuccessfulCollectionResponse({ error: "failed" }), false);
  assert.equal(isSuccessfulCollectionResponse({ retCode: null }), false);
  assert.equal(isSuccessfulCollectionResponse({ status: null }), false);
  assert.equal(isSuccessfulCollectionResponse({}), false);
});

test("does not bind a request that starts outside the real start-click dispatch", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.recordRequest("attempt", { page: 22 });
  tracker.beginClick("attempt");
  tracker.endClick("attempt");
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("ignores unrelated requests during the real start-click dispatch", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { page: 1, flag: "UNRELATED_REQUEST" });
  tracker.endClick("attempt");
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("rejects an unrelated API request that carries the expected page", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", {
    apiKey: "analytics",
    page: 22,
    flag: "ANALYTICS_PAGE_22",
  });
  tracker.endClick("attempt");
  tracker.recordResponse("attempt", { flag: "ANALYTICS_PAGE_22" });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("binds a real collection request when the plugin omits its page parameter", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.endClick("attempt");
  tracker.recordRequest("attempt", {
    apiKey: "request",
    flag: "XWS_PAGE_REQUEST_06272008929073556",
  });
  tracker.recordResponse("attempt", {
    flag: "XWS_PAGE_REQUEST_06272008929073556",
    retCode: 0,
  });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), true);
});

test("rejects a page-less background request during the click window", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", {
    apiKey: "analytics",
    flag: "BACKGROUND_REQUEST",
  });
  tracker.endClick("attempt");
  tracker.recordResponse("attempt", { flag: "BACKGROUND_REQUEST" });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("binds an expected-page request deferred until after click dispatch", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, clickWindowMs: 2_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.endClick("attempt");
  currentTime += 25;
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  currentTime += 25;
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });

  assert.equal(tracker.isOwned("attempt"), true);
});

test("rejects a matching result generation long after the request response", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, resultWindowMs: 15_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  currentTime += 15_001;
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("pairs duplicate collection flags with the first pending request", () => {
  const first = { flag: "XWS_PAGE_REQUEST_22", pending: true, id: "first" };
  const second = { flag: "XWS_PAGE_REQUEST_22", pending: true, id: "second" };
  assert.equal(selectPendingRequest([first, second]).id, "first");
  first.pending = false;
  assert.equal(selectPendingRequest([first, second]).id, "second");
});

test("does not accept a collection finish without an explicit success code", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22" });

  assert.equal(tracker.isStarted("attempt"), false);
  assert.equal(tracker.isFailed("attempt"), true);
});

test("accepts the plugin ret success code for request startup", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  assert.equal(tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", ret: 0 }), true);
  assert.equal(tracker.isStarted("attempt"), true);
});

test("does not report startup for a failed collection response", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", retCode: 500, error: "failed" });

  assert.equal(tracker.isStarted("attempt"), false);
});

test("does not own a result until the accepted request flag finishes", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.endClick("attempt");
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isStarted("attempt"), true);
  assert.equal(tracker.isOwned("attempt"), false);
  tracker.recordResponse("attempt", { flag: "BACKGROUND_REQUEST" });
  assert.equal(tracker.isOwned("attempt"), false);
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  assert.equal(tracker.isOwned("attempt"), true);
});

test("keeps a delayed collection running after startup evidence arrives", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", flag: "XWS_PAGE_REQUEST_22" });
  tracker.endClick("attempt");

  assert.equal(tracker.isStarted("attempt"), true);
  assert.equal(tracker.isOwned("attempt"), false);
});

test("binds a collection request that arrives several seconds after the click", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 }, { now: () => currentTime });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.endClick("attempt");
  currentTime += 5_000;
  tracker.recordRequest("attempt", { apiKey: "request", flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), true);
});

test("rejects a result observed after a pending request exceeds the result window", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, resultWindowMs: 15_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.endClick("attempt");
  currentTime += 15_001;
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });
  currentTime += 1;
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("refreshes result baselines until the first start click", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  const initial = { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 };
  const latest = { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 };
  tracker.arm("attempt", initial);
  tracker.arm("attempt", latest);
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  tracker.recordResult("attempt", latest);

  assert.equal(tracker.isOwned("attempt"), false);
});

test("keeps a late first-click request in the same logical start after DOM fallback", () => {
  let currentTime = 0;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, clickWindowMs: 10_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  currentTime = 11_000;
  tracker.retryClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), true);
});

test("does not let a stale response settle a newer click generation", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_1" });
  tracker.endClick("attempt");

  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_2" });
  tracker.endClick("attempt");
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_1", status: 200 });

  assert.equal(tracker.isOwned("attempt"), false);
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_2", status: 200 });
  assert.equal(tracker.isOwned("attempt"), true);
});

test("rejects an expected-page request after the click correlation window", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, clickWindowMs: 2_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.endClick("attempt");
  currentTime += 2_001;
  tracker.recordRequest("attempt", { page: 22, flag: "BACKGROUND_PAGE_REQUEST" });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("expires click correlation even when click propagation never reaches the end listener", () => {
  let currentTime = 10_000;
  const tracker = createCollectionAttemptTracker(
    { start: 22, end: 40 },
    { now: () => currentTime, clickWindowMs: 2_000 },
  );
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  currentTime += 2_001;
  tracker.recordRequest("attempt", { page: 22, flag: "LATE_PAGE_REQUEST" });
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });

  assert.equal(tracker.isOwned("attempt"), false);
});

test("ignores historical result text changes without structured progress change", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  const baseline = { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 };
  tracker.arm("attempt", baseline);
  tracker.beginClick("attempt");
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.endClick("attempt");
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });
  tracker.recordResult("attempt", baseline);

  assert.equal(tracker.isOwned("attempt"), false);
});

test("reconciles one structured result generation observed before its click-bound request", () => {
  const tracker = createCollectionAttemptTracker({ start: 22, end: 40 });
  tracker.arm("attempt", { requestedStart: 1, requestedEnd: 40, completedEnd: 21, rowCount: 921 });
  tracker.beginClick("attempt");
  tracker.recordResult("attempt", { requestedStart: 22, requestedEnd: 40, completedEnd: 22, rowCount: 45 });
  tracker.recordRequest("attempt", { apiKey: "request", page: 22, flag: "XWS_PAGE_REQUEST_22" });
  tracker.endClick("attempt");
  tracker.recordResponse("attempt", { flag: "XWS_PAGE_REQUEST_22", status: 200 });

  assert.equal(tracker.isOwned("attempt"), true);
});

test("parses partial collection progress", () => {
  assert.deepEqual(parseProgressText(resultText()), {
    keyword: "\u6d74\u7f38",
    sortLabel: "\u9500\u91cf\u6392\u5e8f",
    requestedStart: 1,
    requestedEnd: 40,
    completedStart: 1,
    completedEnd: 20,
    rowCount: 707,
    complete: false,
  });
});

test("parses the next-page countdown as collection activity", () => {
  const progress = parseProgressText(`${resultText({ completed: 4, rows: 151 })}\n22 秒后获取：第 5 页`);
  assert.equal(progress.nextPage, 5);
  assert.equal(progress.waitSeconds, 22);
});

test("parses an in-flight page as collection activity", () => {
  const progress = parseProgressText(`${resultText({ completed: 19, rows: 720 })}\n正在获取：第 20 页`);
  assert.equal(progress.activePage, 20);
});

test("marks a collection complete only at the requested final page", () => {
  const progress = parseProgressText(resultText({ completed: 40, rows: 1333 }));
  assert.equal(progress.complete, true);
  assert.equal(progress.rowCount, 1333);
});

test("detects platform controls and classifies them as human required", () => {
  const text = "\u8bf7\u5b8c\u6210\u9a8c\u8bc1\u7801\u540e\u7ee7\u7eed";
  assert.deepEqual(detectRiskMarkers(text), ["CAPTCHA"]);
  assert.equal(classifyCollection({ text }), "HUMAN_REQUIRED");
});

test("detects Taobao's sliding-verification wording", () => {
  const text = "因出现滑动验证，本次分析不扣除使用次数";
  assert.deepEqual(detectRiskMarkers(text), ["CAPTCHA"]);
  assert.equal(classifyCollection({ text }), "HUMAN_REQUIRED");
});

test("classifies active and completed collection snapshots", () => {
  assert.equal(classifyCollection({ text: resultText() }), "COLLECTING");
  assert.equal(classifyCollection({ text: resultText({ completed: 40, rows: 1333 }) }), "COMPLETE");
});

test("selects the Taobao search target for the requested keyword", () => {
  const targets = [
    { type: "page", targetId: "home", url: "https://www.taobao.com/" },
    { type: "page", targetId: "other", url: "https://s.taobao.com/search?q=%E6%B5%B4%E7%9B%86" },
    { type: "page", targetId: "wanted", url: "https://s.taobao.com/search?page=1&q=%E6%B5%B4%E7%BC%B8" },
  ];
  assert.equal(selectTaobaoSearchTarget(targets, "\u6d74\u7f38").targetId, "wanted");
});

test("validates the 16-column competitor dataset", () => {
  const rows = [
    [1, "", "A", "https://item.taobao.com/item.htm?id=1", "100", "10", "c", "0", "\u6dd8\u5b9d", "\u81ea\u7136\u4f4d", "s", "w", "t", "a", "-", "-"],
    [2, "", "B", "https://item.taobao.com/item.htm?id=2", "200", "100+", "c", "-", "\u5929\u732b", "\u5e7f\u544a\u4f4d", "s", "w", "t", "a", "-", "-"],
  ];
  assert.deepEqual(validateDataset(REQUIRED_HEADERS, rows), {
    rowCount: 2,
    rankRange: "1-2",
    emptyLinks: 0,
    duplicateLinks: 0,
  });
});

test("validates the observed payment-count header variant", () => {
  const headers = REQUIRED_HEADERS.with(5, "付款人数");
  const row = [1, "", "A", "https://item.taobao.com/item.htm?id=1", "100", "10", "c", "0", "淘宝", "自然位", "s", "w", "t", "a", "-", "-"];
  assert.equal(validateDataset(headers, [row]).rowCount, 1);
});

test("rejects duplicate links instead of publishing an incomplete dataset", () => {
  const row = [1, "", "A", "https://item.taobao.com/item.htm?id=1", "100", "10", "c", "0", "\u6dd8\u5b9d", "\u81ea\u7136\u4f4d", "s", "w", "t", "a", "-", "-"];
  assert.throws(() => validateDataset(REQUIRED_HEADERS, [row, [2, ...row.slice(1)]]), /duplicate product links/u);
});

test("ignores countdown ticks but tracks request changes as collection activity", () => {
  const progress = { completedEnd: 4, rowCount: 151, complete: false, nextPage: 5, waitSeconds: 22 };
  const diagnostics = { requests: [{ page: 4, status: 200 }], messages: [] };
  assert.equal(
    collectionActivitySignature(progress, diagnostics),
    collectionActivitySignature({ ...progress, waitSeconds: 21 }, diagnostics),
  );
  assert.notEqual(
    collectionActivitySignature(progress, diagnostics),
    collectionActivitySignature(progress, { requests: [...diagnostics.requests, { page: 5, pending: true }], messages: [] }),
  );
});

test("a stale active-page label does not bypass the idle threshold after the request completes", () => {
  assert.equal(
    collectionStallReason({
      idleMs: 301_000,
      elapsedMs: 600_000,
      stallMs: 300_000,
      deadlineMs: 1_700_000,
      diagnosticKind: "REQUEST_COMPLETED",
      activePage: 20,
    }),
    "idle",
  );
});

test("only an in-flight request bypasses the idle threshold", () => {
  const base = { idleMs: 301_000, elapsedMs: 600_000, stallMs: 300_000, deadlineMs: 1_700_000 };
  assert.equal(collectionStallReason({ ...base, diagnosticKind: "REQUEST_PENDING" }), "");
  assert.equal(collectionStallReason({ ...base, diagnosticKind: "BACKGROUND_TAB" }), "idle");
  assert.equal(collectionStallReason({ ...base, diagnosticKind: "REQUEST_COMPLETED" }), "idle");
  assert.equal(collectionStallReason({ ...base, elapsedMs: 1_700_000, diagnosticKind: "REQUEST_PENDING" }), "deadline");
});

test("uses a bounded overall collection deadline", () => {
  assert.equal(collectionDeadlineMs({ pageCount: 40, frequencyMaxSeconds: 15 }), 1_700_000);
});

test("parses the reusable default run contract", () => {
  const options = parseOptions(["--keyword", "\u6d74\u7f38"]);
  assert.equal(options.keyword, "\u6d74\u7f38");
  assert.deepEqual(options.pages, { start: 1, end: 40 });
  assert.deepEqual(options.frequency, { min: 10, max: 15 });
  assert.equal(options.channel, "all");
  assert.equal(options.sort, "sales");
  assert.equal(options.fromTaobaoHome, true);
  assert.equal(options.allowTrial, false);
});

test("accepts the controlled partial-export-on-stall flag", () => {
  const options = parseOptions(["--keyword", "浴缸", "--export-partial-on-stall"]);
  assert.equal(options.exportPartialOnStall, true);
});
