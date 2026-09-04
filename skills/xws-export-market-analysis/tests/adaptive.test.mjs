import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAdaptiveRun,
  checkpointOptions,
  createAdaptiveCheckpoint,
  lastJsonLine,
  loadAdaptiveCheckpoint,
  nextAdaptiveRange,
  parseAdaptiveOptions,
  writeAdaptiveCheckpoint,
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
  assert.equal(options.resume, false);
  assert.equal("segmentSize" in options, false);
  assert.equal(options.exportPartialOnStall, true);
});

test("parses resume as an explicit mode without treating checkpoint as resume", () => {
  const fresh = parseAdaptiveOptions(["--keyword", "浴缸", "--checkpoint", "fresh.json"]);
  const resume = parseAdaptiveOptions(["--keyword", "浴缸", "--checkpoint", "old.json", "--resume"]);
  assert.equal(fresh.resume, false);
  assert.equal(fresh.checkpointExplicit, true);
  assert.equal(resume.resume, true);
  assert.equal(resume.checkpointExplicit, true);
});

test("fresh adaptive tasks ignore no history and refuse to overwrite an existing checkpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-adaptive-"));
  const file = path.join(directory, "fresh.json");
  const expected = {
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
    frequency: { min: 30, max: 45 },
    options: checkpointOptions({
      channel: "all",
      sort: "sales",
      price: { min: 0, max: null },
      exportModes: ["csv", "xlsx-images"],
      stallSeconds: 300,
    }),
  };
  const checkpoint = createAdaptiveCheckpoint(expected);
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 16, rowCount: 10 },
    artifacts: { csv: "old.csv" },
  });
  await writeFile(file, JSON.stringify(checkpoint));
  await assert.rejects(loadAdaptiveCheckpoint(file, { expected }), /checkpoint already exists/u);
  const freshFile = path.join(directory, "new.json");
  const fresh = await loadAdaptiveCheckpoint(freshFile, { expected });
  assert.deepEqual(nextAdaptiveRange(fresh), { start: 1, end: 40 });
  assert.deepEqual(fresh.parts, {});
});

test("only explicit resume loads verified progress and rejects contract mismatches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-adaptive-"));
  const file = path.join(directory, "resume.json");
  const expected = {
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
    frequency: { min: 30, max: 45 },
    options: checkpointOptions({
      channel: "all",
      sort: "sales",
      price: { min: 0, max: null },
      exportModes: ["csv", "xlsx-images"],
      stallSeconds: 300,
    }),
  };
  const checkpoint = createAdaptiveCheckpoint(expected);
  checkpoint.options = expected.options;
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 16, rowCount: 10 },
    artifacts: { csv: "old.csv" },
  });
  await writeFile(file, JSON.stringify(checkpoint));
  const resumed = await loadAdaptiveCheckpoint(file, { resume: true, expected });
  assert.deepEqual(nextAdaptiveRange(resumed), { start: 17, end: 40 });
  await assert.rejects(
    loadAdaptiveCheckpoint(file, {
      resume: true,
      expected: { ...expected, keyword: "台盆" },
    }),
    /checkpoint keyword does not match/u,
  );
  await assert.rejects(
    loadAdaptiveCheckpoint(path.join(directory, "missing.json"), { resume: true, expected }),
    (error) => error?.code === "ENOENT",
  );
});

test("explicit resume reopens a HUMAN_REQUIRED checkpoint after the control is cleared", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-adaptive-"));
  const file = path.join(directory, "human-required.json");
  const expected = {
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
    frequency: { min: 30, max: 45 },
    options: checkpointOptions({
      channel: "all",
      sort: "sales",
      price: { min: 0, max: null },
      exportModes: ["csv"],
      stallSeconds: 300,
    }),
  };
  const checkpoint = createAdaptiveCheckpoint(expected);
  checkpoint.options = expected.options;
  applyAdaptiveRun(checkpoint, {
    start: 1,
    end: 40,
    status: "HUMAN_REQUIRED",
    progress: { completedStart: 1, completedEnd: 16, rowCount: 10 },
    artifacts: { csv: "old.csv" },
  });
  await writeFile(file, JSON.stringify(checkpoint));

  const resumed = await loadAdaptiveCheckpoint(file, { resume: true, expected });

  assert.equal(resumed.status, "RUNNING");
  assert.deepEqual(nextAdaptiveRange(resumed), { start: 17, end: 40 });
});

test("writes a checkpoint to a temporary file before atomically renaming it", async () => {
  const calls = [];
  const fsApi = {
    writeFile: async (file, data, encoding) => calls.push({ operation: "writeFile", file, data, encoding }),
    rename: async (from, to) => calls.push({ operation: "rename", from, to }),
  };

  await writeAdaptiveCheckpoint("checkpoint.json", { status: "RUNNING" }, fsApi);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].operation, "writeFile");
  assert.match(calls[0].file, /^checkpoint\.json\.tmp-/u);
  assert.equal(calls[0].encoding, "utf8");
  assert.equal(calls[1].operation, "rename");
  assert.equal(calls[1].from, calls[0].file);
  assert.equal(calls[1].to, "checkpoint.json");
});

test("returns null for missing events so stdout can be used as a fallback", () => {
  assert.equal(lastJsonLine("diagnostic output"), null);
  assert.deepEqual(lastJsonLine('diagnostic output\n{"status":"DONE"}'), { status: "DONE" });
});
