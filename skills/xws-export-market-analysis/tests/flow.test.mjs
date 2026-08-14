import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_HEADERS,
  collectionDeadlineMs,
  classifyCollection,
  detectRiskMarkers,
  parseProgressText,
  parseOptions,
  selectTaobaoSearchTarget,
  validateDataset,
} from "../scripts/flow.mjs";

const resultText = ({ completed = 20, rows = 707 } = {}) => [
  "\u3010 \u6d74\u7f38 \u3011\u9500\u91cf\u6392\u5e8fTop" + rows + " - 2026-08-05 15:46 - \u5e02\u573a\u6570\u636e\u5206\u6790",
  "\u60a8\u641c\u7d22\u7684\u9875\u6570\uff1a\u7b2c 1 ~ 40 \u9875\uff0c\u5df2\u6210\u529f\u83b7\u53d6\uff1a\u7b2c 1 ~ " + completed + " \u9875",
  "\u5546\u54c1\u6570\u91cf\uff1a" + rows,
].join("\n");

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
