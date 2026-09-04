import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  resumeAdaptiveCheckpoint,
  writeAdaptiveCheckpoint,
} from "../scripts/adaptive.mjs";
import { marketAnalysisLockPath, shouldAcquireRuntimeLock } from "../scripts/export-market-analysis.mjs";
import { acquireMarketAnalysisLock, defaultLockPath } from "../scripts/runtime-lock.mjs";
import {
  buildAdaptiveIdentity,
  canAdvanceAttempt,
  chooseAttemptSnapshot,
  commitCheckpointMutation,
  openAuthoritativeRun,
  requireDatabaseUrl,
  snapshotMetadata,
  validateProgressSnapshot,
  verifyArtifactSet,
  verifyRecordedArtifacts,
  withAdaptiveOwnership,
} from "../scripts/run-adaptive-export.mjs";

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

test("explicit resume reopens a FAILED checkpoint without inventing progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-adaptive-"));
  const file = path.join(directory, "failed.json");
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
    status: "FAILED",
    progress: { completedStart: 0, completedEnd: 0, rowCount: 0 },
  });
  await writeFile(file, JSON.stringify(checkpoint));

  const resumed = await loadAdaptiveCheckpoint(file, { resume: true, expected });

  assert.equal(resumed.status, "RUNNING");
  assert.deepEqual(nextAdaptiveRange(resumed), { start: 1, end: 40 });
});

test("explicit resume retries a no-progress STALLED checkpoint", () => {
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
    status: "STALLED",
    progress: { completedStart: 0, completedEnd: 0, rowCount: 0 },
  });

  const resumed = resumeAdaptiveCheckpoint(checkpoint, expected);

  assert.equal(resumed.status, "RUNNING");
  assert.deepEqual(nextAdaptiveRange(resumed), { start: 1, end: 40 });
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

test("includes output directory and trial authorization in the immutable run identity", () => {
  const options = parseAdaptiveOptions([
    "--keyword", "浴缸",
    "--output-dir", "C:/Downloads/xws",
    "--allow-trial",
  ]);
  assert.deepEqual(buildAdaptiveIdentity(options), {
    keyword: "浴缸",
    pagesStart: 1,
    pagesEnd: 40,
    channel: "all",
    sort: "sales",
    price: { min: 0, max: null },
    frequency: { min: 30, max: 45 },
    exportModes: ["csv", "xlsx-images"],
    outputDir: path.resolve("C:/Downloads/xws"),
    allowTrial: true,
    stallSeconds: 300,
  });
});

test("requires PostgreSQL state without exposing the connection string", () => {
  assert.throws(() => requireDatabaseUrl({}), /XWS_DATABASE_URL is required/u);
  assert.equal(requireDatabaseUrl({ XWS_DATABASE_URL: "postgres://secret@example/xws" }), "postgres://secret@example/xws");
});

test("uses one manifest snapshot instead of mixing it with a child event", () => {
  const manifest = {
    runId: "manifest-run",
    status: "STALLED",
    progress: { completedEnd: 12 },
    diagnostics: { request: "manifest" },
    error: "manifest error",
  };
  const event = {
    runId: "event-run",
    status: "DONE",
    error: "event error must not leak into a manifest snapshot",
    details: { progress: { completedEnd: 40 }, diagnostics: { request: "event" } },
  };
  assert.deepEqual(chooseAttemptSnapshot({ path: "manifest.json", manifest }, event), {
    source: "manifest",
    sourceId: "manifest-run",
    manifestPath: "manifest.json",
    status: "STALLED",
    progress: { completedEnd: 12 },
    diagnostics: { request: "manifest" },
    artifacts: {},
    validation: {},
    error: "manifest error",
  });
  assert.deepEqual(chooseAttemptSnapshot({ path: "", manifest: null }, event), {
    source: "event",
    sourceId: "event-run",
    manifestPath: "",
    status: "DONE",
    progress: { completedEnd: 40 },
    diagnostics: { request: "event" },
    artifacts: {},
    validation: {},
    error: "event error must not leak into a manifest snapshot",
  });
});

test("labels a merge from different source runs as a mixed snapshot", () => {
  assert.deepEqual(snapshotMetadata([
    { sourceId: "run-a", at: "2026-09-04T01:00:00.000Z" },
    { sourceId: "run-b", at: "2026-09-04T02:00:00.000Z" },
  ]), {
    snapshot: "mixed_snapshot",
    sourceIds: ["run-a", "run-b"],
    sourceTimes: ["2026-09-04T01:00:00.000Z", "2026-09-04T02:00:00.000Z"],
  });
});

test("creates a fresh PostgreSQL run with its initial checkpoint atomically", async () => {
  const expected = {
    keyword: "浴缸",
    pages: { start: 1, end: 40 },
    frequency: { min: 30, max: 45 },
    options: checkpointOptions({
      channel: "all",
      sort: "sales",
      price: { min: 0, max: null },
      exportModes: ["csv"],
      outputDir: "C:/Downloads",
      allowTrial: false,
      stallSeconds: 300,
    }),
  };
  const calls = [];
  const state = {
    createAdaptiveRun: async (_pool, identity, checkpoint) => {
      calls.push({ identity, checkpoint: structuredClone(checkpoint) });
      return { id: "fresh-run", checkpoint };
    },
    updateAdaptiveCheckpoint: async () => assert.fail("fresh creation must not require a second state write"),
  };
  const fresh = await openAuthoritativeRun({
    pool: {},
    options: { resume: false, runId: "" },
    identity: { keyword: "浴缸" },
    expected,
    state,
  });
  assert.equal(fresh.id, "fresh-run");
  assert.equal(fresh.checkpoint.runId, "fresh-run");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].checkpoint.strategy, "adaptive");
});

test("reads resume state only from PostgreSQL and rejects a missing run", async () => {
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
      outputDir: "C:/Downloads",
      allowTrial: false,
    }),
  };
  const saved = createAdaptiveCheckpoint(expected);
  saved.options = expected.options;
  saved.completedEnd = 7;
  const calls = [];
  const state = {
    createAdaptiveRun: async () => assert.fail("fresh creation must not run during resume"),
    getAdaptiveRun: async (_pool, id, identity) => {
      calls.push({ operation: "get", id, identity });
      return id === "existing-run" ? { id, checkpoint: saved } : null;
    },
    updateAdaptiveCheckpoint: async (_pool, id, checkpoint) => {
      calls.push({ operation: "update", id, checkpoint });
    },
  };
  const resumed = await openAuthoritativeRun({
    pool: {},
    options: { resume: true, runId: "existing-run" },
    identity: { keyword: "浴缸" },
    expected,
    state,
  });
  assert.equal(resumed.id, "existing-run");
  assert.equal(resumed.checkpoint.completedEnd, 7);
  assert.deepEqual(calls.map((call) => call.operation), ["get", "update"]);
  await assert.rejects(
    openAuthoritativeRun({ pool: {}, options: { resume: true, runId: "missing" }, identity: {}, expected, state }),
    /adaptive run not found/u,
  );
});

test("all entry points use one global browser lock independent of artifact directories", () => {
  const canonical = defaultLockPath();
  assert.equal(marketAnalysisLockPath({}), canonical);
  assert.equal(marketAnalysisLockPath({ XWS_RUNTIME_DIR: "C:/attempt-artifacts" }), canonical);
  assert.equal(marketAnalysisLockPath({ XWS_MARKET_ANALYSIS_LOCK: "C:/locks/custom.lock" }), path.resolve("C:/locks/custom.lock"));
});

test("global lock acquisition creates its parent directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-lock-parent-"));
  const lockPath = path.join(directory, "nested", "market.lock");
  const lock = await acquireMarketAnalysisLock({ XWS_MARKET_ANALYSIS_LOCK: lockPath });
  assert.equal(await lock.release(), true);
});

test("child exporters inherit wrapper ownership instead of reacquiring the runtime lock", () => {
  assert.equal(shouldAcquireRuntimeLock({}), true);
  assert.equal(shouldAcquireRuntimeLock({ XWS_ADAPTIVE_LOCK_OWNER: "1" }), false);
});

test("releases runtime and PostgreSQL ownership for every terminal result", async () => {
  for (const terminal of ["DONE", "STALLED", "HUMAN_REQUIRED", "FAILED"]) {
    const released = [];
    const result = await withAdaptiveOwnership({
      acquireRuntime: async () => ({ release: async () => released.push("runtime") }),
      acquireDatabase: async () => ({ release: async () => released.push("database") }),
      work: async () => terminal,
    });
    assert.equal(result, terminal);
    assert.deepEqual(released, ["database", "runtime"]);
  }
});

test("releases both ownership layers when work throws", async () => {
  const released = [];
  await assert.rejects(
    withAdaptiveOwnership({
      acquireRuntime: async () => ({ release: async () => released.push("runtime") }),
      acquireDatabase: async () => ({ release: async () => released.push("database") }),
      work: async () => { throw new Error("child failed"); },
    }),
    /child failed/u,
  );
  assert.deepEqual(released, ["database", "runtime"]);
});

test("keeps the authoritative checkpoint unchanged when a transactional part commit fails", async () => {
  const checkpoint = createAdaptiveCheckpoint({ keyword: "浴缸", pages: { start: 1, end: 40 } });
  checkpoint.options = {};
  await assert.rejects(
    commitCheckpointMutation({
      checkpoint,
      mutate: (draft) => applyAdaptiveRun(draft, {
        start: 1,
        end: 40,
        status: "STALLED",
        progress: { completedStart: 1, completedEnd: 10, rowCount: 20 },
        artifacts: { csv: "part.csv" },
      }),
      commit: async () => { throw new Error("database unavailable"); },
    }),
    /database unavailable/u,
  );
  assert.equal(checkpoint.completedEnd, 0);
  assert.deepEqual(checkpoint.parts, {});
});

test("does not advance a stalled snapshot without a validated CSV artifact", () => {
  assert.equal(canAdvanceAttempt("DONE", {
    progress: { completedEnd: 40 },
    artifacts: {},
    validation: {},
  }, { start: 1 }), true);
  assert.equal(canAdvanceAttempt("STALLED", {
    progress: { completedEnd: 3 },
    artifacts: {},
    validation: {},
  }, { start: 1 }), false);
  assert.equal(canAdvanceAttempt("STALLED", {
    progress: { completedEnd: 3 },
    artifacts: { csv: "part.csv" },
    validation: { ok: true },
  }, { start: 1 }), false);
  assert.equal(canAdvanceAttempt("STALLED", {
    progress: { completedEnd: 3 },
    artifacts: { csv: "part.csv" },
    validation: { ok: true, validation: { rows: 115 } },
  }, { start: 1 }), true);
});

test("advances only from a validator-confirmed snapshot for the requested range", () => {
  assert.deepEqual(validateProgressSnapshot({
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 10, rowCount: 20 },
    artifacts: { csv: "part.csv" },
    validation: { ok: true, validation: { rows: 20 } },
  }, { start: 1, end: 40 }), { completedStart: 1, completedEnd: 10, rowCount: 20 });
  assert.throws(() => validateProgressSnapshot({
    status: "STALLED",
    progress: { completedStart: 1, completedEnd: 3, rowCount: 115 },
    artifacts: {},
    validation: {},
  }, { start: 1, end: 40 }), /validated artifact is missing/u);
  assert.throws(() => validateProgressSnapshot({
    status: "DONE",
    progress: { completedStart: 1, completedEnd: 40, rowCount: 20 },
    artifacts: { csv: "part.csv" },
    validation: {},
  }, { start: 1, end: 40 }), /validator confirmation is missing/u);
  assert.throws(() => validateProgressSnapshot({
    status: "STALLED",
    progress: { completedStart: 2, completedEnd: 10, rowCount: 20 },
    artifacts: { csv: "part.csv" },
    validation: { ok: true, validation: { rows: 20 } },
  }, { start: 1, end: 40 }), /completed range does not start/u);
  assert.throws(() => validateProgressSnapshot({
    status: "DONE",
    progress: { completedStart: 1, completedEnd: 39, rowCount: 20 },
    artifacts: { csv: "part.csv" },
    validation: { ok: true, validation: { rows: 20 } },
  }, { start: 1, end: 40 }), /completed range does not reach/u);
});

test("revalidates recorded final artifacts before reusing DONE state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-final-"));
  const csv = path.join(directory, "final.csv");
  await writeFile(csv, "final rows", "utf8");
  const records = await verifyArtifactSet({
    artifacts: { csv },
    exportModes: ["csv"],
    metadata: { final: true },
  });

  await verifyRecordedArtifacts(records, "final");
  await writeFile(csv, "changed rows", "utf8");
  await assert.rejects(verifyRecordedArtifacts(records, "final"), /artifact changed after verification/u);
  await assert.rejects(verifyRecordedArtifacts([], "final"), /final has no verified artifact records/u);
});

test("hashes every required artifact before it can advance progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-artifacts-"));
  const csv = path.join(directory, "part.csv");
  const content = "verified rows";
  await writeFile(csv, content, "utf8");
  const expectedArtifacts = {
    csv: {
      size_bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
  const records = await verifyArtifactSet({
    artifacts: { csv },
    exportModes: ["csv"],
    expectedArtifacts,
    metadata: { sourceId: "run-a", start: 1, completedEnd: 4 },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "csv");
  assert.equal(records[0].sizeBytes, 13);
  assert.equal(records[0].sha256, expectedArtifacts.csv.sha256);
  await assert.rejects(
    verifyArtifactSet({ artifacts: {}, exportModes: ["csv"], expectedArtifacts, metadata: {} }),
    /required csv artifact is missing/u,
  );
  await assert.rejects(
    verifyArtifactSet({
      artifacts: { csv },
      exportModes: ["csv"],
      expectedArtifacts: { csv: { size_bytes: 13, sha256: "0".repeat(64) } },
      metadata: {},
    }),
    /does not match validator SHA-256/u,
  );
  await assert.rejects(
    verifyArtifactSet({ artifacts: { csv }, exportModes: ["csv"], expectedArtifacts: {}, metadata: {} }),
    /validator metadata for csv is missing/u,
  );
});
