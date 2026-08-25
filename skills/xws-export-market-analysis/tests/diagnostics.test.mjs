import assert from "node:assert/strict";
import test from "node:test";

import { classifyDiagnosticState, normalizeDiagnosticSnapshot } from "../scripts/diagnostics.mjs";

test("normalizes request diagnostics without query strings or payloads", () => {
  const snapshot = normalizeDiagnosticSnapshot({
    capturedAt: "2026-08-23T09:00:00.000Z",
    visibility: "hidden",
    readyState: "complete",
    requests: [{
      url: "https://h5api.m.taobao.com/api?page=18&sign=secret",
      method: "POST",
      status: 429,
      elapsedMs: 1200,
      error: "rate limited",
      body: "sensitive payload",
    }],
    messages: [{ type: "XWS_MARKET_FINISH", error: "rate limited", result: "sensitive" }],
  });

  assert.deepEqual(snapshot.requests, [{
    url: "https://h5api.m.taobao.com/api",
    method: "POST",
    status: 429,
    elapsedMs: 1200,
    error: "rate limited",
  }]);
  assert.deepEqual(snapshot.messages, [{ type: "XWS_MARKET_FINISH", error: "rate limited" }]);
  assert.equal(snapshot.visibility, "hidden");
  assert.equal(snapshot.readyState, "complete");
  assert.equal("body" in snapshot.requests[0], false);
});

test("classifies a non-200 request as a rate-limit or security failure", () => {
  assert.equal(classifyDiagnosticState({ requests: [{ status: 403 }] }), "RATE_LIMIT_OR_SECURITY");
  assert.equal(classifyDiagnosticState({ requests: [{ status: 429 }] }), "RATE_LIMIT_OR_SECURITY");
});

test("classifies a silent pending request separately from a background tab", () => {
  assert.equal(classifyDiagnosticState({ requests: [{ status: null, pending: true }] }), "REQUEST_PENDING");
  assert.equal(classifyDiagnosticState({ requests: [], visibility: "hidden" }), "BACKGROUND_TAB");
  assert.equal(classifyDiagnosticState({ requests: [], visibility: "visible" }), "NO_REQUEST_SIGNAL");
});

test("classifies successful page requests instead of reporting no request signal", () => {
  assert.equal(
    classifyDiagnosticState({
      requests: [{ status: 200 }],
      messages: [{ type: "XWS_PAGE_REQUEST_FINISH" }],
      visibility: "visible",
    }),
    "REQUEST_COMPLETED",
  );
});

test("preserves safe xws page-request metadata and response summary", () => {
  const snapshot = normalizeDiagnosticSnapshot({
    requests: [{
      apiKey: "searchApi",
      page: 33,
      flag: "XWS_PAGE_REQUEST_abc",
      url: "https://api.example.test/search?page=33&sign=secret",
      method: "GET",
      status: 200,
      elapsedMs: 812,
      resultKeys: ["data", "success"],
      itemCount: 48,
    }],
    messages: [{
      type: "XWS_PAGE_REQUEST_abc_FINISH",
      resultKeys: ["data", "success"],
      itemCount: 48,
    }],
  });
  assert.deepEqual(snapshot.requests, [{
    apiKey: "searchApi",
    page: 33,
    flag: "XWS_PAGE_REQUEST_abc",
    url: "https://api.example.test/search",
    method: "GET",
    status: 200,
    elapsedMs: 812,
    resultKeys: ["data", "success"],
    itemCount: 48,
  }]);
  assert.deepEqual(snapshot.messages, [{
    type: "XWS_PAGE_REQUEST_abc_FINISH",
    resultKeys: ["data", "success"],
    itemCount: 48,
  }]);
});
