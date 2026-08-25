import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSegmentPlan,
  nextPendingSegment,
  parseSegmentOptions,
  summarizeSegmentResult,
} from "../scripts/segments.mjs";

test("builds deterministic page segments without overlap", () => {
  assert.deepEqual(buildSegmentPlan({ start: 1, end: 40, size: 8 }), [
    { id: "1-8", start: 1, end: 8 },
    { id: "9-16", start: 9, end: 16 },
    { id: "17-24", start: 17, end: 24 },
    { id: "25-32", start: 25, end: 32 },
    { id: "33-40", start: 33, end: 40 },
  ]);
});

test("selects the first segment that is not complete from a checkpoint", () => {
  const plan = buildSegmentPlan({ start: 1, end: 20, size: 5 });
  const checkpoint = {
    segments: {
      "1-5": { status: "DONE", rows: 240 },
      "6-10": { status: "STALLED", rows: 192 },
    },
  };
  assert.equal(nextPendingSegment(plan, checkpoint).id, "6-10");
});

test("summarizes a completed segment without exposing request payloads", () => {
  assert.deepEqual(summarizeSegmentResult({
    segment: { id: "1-8", start: 1, end: 8 },
    status: "DONE",
    rows: 384,
    artifacts: { csv: "C:\\out\\part-1-8.csv" },
    diagnostics: {
      requests: [{ url: "https://example.test/api?page=8&sign=secret", status: 200, resultKeys: ["items"] }],
      messages: [{ type: "XWS_PAGE_REQUEST_abc_FINISH", error: "" }],
    },
  }), {
    id: "1-8",
    start: 1,
    end: 8,
    status: "DONE",
    rows: 384,
    artifacts: { csv: "C:\\out\\part-1-8.csv" },
    diagnostics: {
      requestCount: 1,
      lastRequest: { url: "https://example.test/api", method: "", status: 200, elapsedMs: null, resultKeys: ["items"] },
      messageCount: 1,
      lastMessage: { type: "XWS_PAGE_REQUEST_abc_FINISH" },
    },
  });
});

test("uses a faster but explicit segmented frequency contract", () => {
  const options = parseSegmentOptions(["--keyword", "浴缸"]);
  assert.deepEqual(options.frequency, { min: 30, max: 45 });
  assert.equal(options.segmentSize, 8);
  assert.equal(options.pages.end, 40);
});
