import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAdaptiveRun,
  createAdaptiveCheckpoint,
  nextAdaptiveRange,
  parseAdaptiveOptions,
} from "../scripts/adaptive.mjs";

test("starts one adaptive run across the complete requested range", () => {
  const checkpoint = createAdaptiveCheckpoint({
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
    frequency: { min: 30, max: 45 },
  });
  assert.deepEqual(nextAdaptiveRange(checkpoint), { start: 1, end: 40 });
});

test("resumes immediately after the last verified page instead of restarting", () => {
  const checkpoint = createAdaptiveCheckpoint({
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
  });
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 32, rowCount: 1224 },
    artifacts: { csv: "part-1-32.csv", xlsx: "part-1-32.xlsx" },
  });
  assert.deepEqual(nextAdaptiveRange(checkpoint), { start: 33, end: 40 });
  assert.equal(checkpoint.completedEnd, 32);
});

test("advances through multiple stall points and marks complete only at the target end", () => {
  const checkpoint = createAdaptiveCheckpoint({ keyword: "浴缸", pages: { start: 1, end: 40 } });
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 32, rowCount: 1224 },
    artifacts: { csv: "part-a.csv" },
  });
  applyAdaptiveRun(checkpoint, {
    start: 33,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 33, completedEnd: 35, rowCount: 96 },
    artifacts: { csv: "part-b.csv" },
  });
  assert.deepEqual(nextAdaptiveRange(checkpoint), { start: 36, end: 40 });
  applyAdaptiveRun(checkpoint, {
    start: 36,
    end: 40,
    status: "DONE",
    progress: { completedStart: 36, completedEnd: 40, rowCount: 160 },
    artifacts: { csv: "part-c.csv" },
  });
  assert.equal(nextAdaptiveRange(checkpoint), null);
  assert.equal(checkpoint.status, "DONE");
  assert.equal(checkpoint.completedEnd, 40);
});

test("does not invent a resume page when a run stalled before any verified page", () => {
  const checkpoint = createAdaptiveCheckpoint({ keyword: "浴缸", pages: { start: 1, end: 40 } });
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 0, completedEnd: 0, rowCount: 0 },
  });
  assert.equal(nextAdaptiveRange(checkpoint), null);
  assert.equal(checkpoint.status, "STALLED");
});

test("parses adaptive options without a fixed total runtime or segment size", () => {
  const options = parseAdaptiveOptions(["--keyword", "浴缸"]);
  assert.deepEqual(options.pages, { start: 1, end: 40 });
  assert.deepEqual(options.frequency, { min: 30, max: 45 });
  assert.equal(options.stallSeconds, 300);
  assert.equal("segmentSize" in options, false);
  assert.equal(options.exportPartialOnStall, true);
});
