import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdaptiveResumeArgs,
  shouldResumeAdaptiveRun,
  superviseAdaptiveRun,
  inspectBrowserAttempt,
  parseSupervisorOptions,
  superviseAdaptiveRunOnce,
} from "../scripts/supervise-adaptive-export.mjs";

const identity = {
  keyword: "浴缸",
  pagesStart: 1,
  pagesEnd: 40,
  channel: "all",
  sort: "sales",
  price: { min: 0, max: null },
  frequency: { min: 30, max: 45 },
  exportModes: ["csv", "xlsx-images"],
  outputDir: "C:/Users/Administrator/Downloads",
  allowTrial: false,
  stallSeconds: 300,
};

function run(status, checkpoint = {}) {
  return {
    id: "run-1",
    identity,
    status,
    checkpoint: {
      strategy: "adaptive",
      status,
      pages: { start: 1, end: 40 },
      parts: {},
      attempts: { "1-40": 1 },
      ...checkpoint,
    },
  };
}

test("parses a fresh supervised adaptive collection contract", () => {
  assert.deepEqual(parseSupervisorOptions([
    "--new",
    "--keyword", "浴缸",
    "--pages", "1-40",
    "--frequency", "30-45",
    "--channel", "all",
    "--sort", "sales",
    "--price", "0-unlimited",
    "--export", "csv,xlsx-images",
    "--stall-seconds", "300",
    "--output-dir", "C:/Users/Administrator/Downloads",
    "--checkpoint", "C:/state/bathtub.json",
    "--proxy", "http://127.0.0.1:3456",
    "--watch",
  ]), {
    create: true,
    runId: "",
    checkpoint: "C:/state/bathtub.json",
    proxy: "http://127.0.0.1:3456",
    watch: true,
    pollSeconds: 5,
    runnerArgs: [
      "--keyword", "浴缸",
      "--pages", "1-40",
      "--frequency", "30-45",
      "--channel", "all",
      "--sort", "sales",
      "--price", "0-unlimited",
      "--export", "csv,xlsx-images",
      "--stall-seconds", "300",
      "--output-dir", "C:/Users/Administrator/Downloads",
    ],
  });
});

test("does not allow a fresh supervised run and a PostgreSQL run ID together", () => {
  assert.throws(
    () => parseSupervisorOptions(["--new", "--run-id", "run-1"]),
    /--new cannot be combined with --run-id/u,
  );
});

test("stops a fresh supervisor when the browser exposes a login or risk control", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/targets")) {
      return new Response(JSON.stringify([{ type: "page", targetId: "target-1", url: "https://s.taobao.com/search?q=%E6%B5%B4%E7%BC%B8" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ value: {
      visibleText: "小旺神登录\n登录/验证后 手动关闭窗口 即可使用",
      activeAttempt: "",
    } }), { status: 200 });
  };
  try {
    const result = await inspectBrowserAttempt({ proxy: "http://127.0.0.1:3456", identity });
    assert.equal(result.action, "HUMAN_REQUIRED");
    assert.equal(result.reason, "LOGIN_REQUIRED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not create a fresh run while a prior browser attempt exists", async () => {
  let created = false;
  let launched = false;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    create: true,
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    runnerArgs: ["--keyword", "浴缸"],
    state: {
      createAdaptiveRun: async () => { created = true; },
      inspectBrowserAttempt: async () => ({
        action: "WAITING_FOR_BROWSER",
        targetId: "prior-target",
        activeAttempt: "prior-attempt",
      }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => { launched = true; },
  });
  assert.equal(result.action, "STOPPED");
  assert.equal(result.status, "HUMAN_REQUIRED");
  assert.equal(created, false);
  assert.equal(launched, false);
});

test("creates a fresh authoritative run before launching its first child", async () => {
  const calls = [];
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    create: true,
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    runnerArgs: ["--keyword", "浴缸"],
    state: {
      createAdaptiveRun: async (_pool, identity, checkpoint) => {
        calls.push({ identity, checkpoint });
        return { id: "new-run", version: 0, status: "RUNNING", checkpoint };
      },
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      getAdaptiveRun: async () => ({
        id: "new-run",
        version: 0,
        status: "RUNNING",
        identity,
        checkpoint: {
          strategy: "adaptive",
          status: "RUNNING",
          pages: { start: 1, end: 40 },
          completedEnd: 0,
          parts: {},
          attempts: {},
        },
      }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async (args) => {
      calls.push({ args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.action, "SPAWNED");
  assert.equal(result.runId, "new-run");
  assert.deepEqual(calls.map((call) => Object.keys(call)[0]), ["identity", "args"]);
  assert.deepEqual(calls[0].checkpoint.attempts, {});
  assert.ok(calls[1].args.includes("--resume"));
});

test("rebuilds the immutable adaptive contract for a PostgreSQL resume", () => {
  assert.deepEqual(buildAdaptiveResumeArgs(run("RUNNING"), {
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
  }), [
    "--keyword", "浴缸",
    "--pages", "1-40",
    "--frequency", "30-45",
    "--channel", "all",
    "--sort", "sales",
    "--price", "0-unlimited",
    "--export", "csv,xlsx-images",
    "--stall-seconds", "300",
    "--proxy", "http://127.0.0.1:3456",
    "--output-dir", "C:/Users/Administrator/Downloads",
    "--checkpoint", "C:/state/run-1.json",
    "--resume",
    "--run-id", "run-1",
  ]);
});

test("only marks interrupted or explicitly recoverable runs for automatic resume", () => {
  assert.equal(shouldResumeAdaptiveRun(run("RUNNING")), true);
  assert.equal(shouldResumeAdaptiveRun(run("DONE")), false);
  assert.equal(shouldResumeAdaptiveRun(run("HUMAN_REQUIRED")), false);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED")), false);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED", {
    parts: {
      "1-40": {
        status: "FAILED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "Xiaowangshen radio did not settle: _sale",
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED", {
    parts: {
      "1-40": {
        status: "FAILED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "Could not select Xiaowangshen radio: radio label missing",
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED", {
    parts: {
      "1-40": {
        status: "FAILED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "Timed out waiting for Xiaowangshen filters to settle",
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED", {
    completedEnd: 20,
    attempts: { "1-40": 1, "14-40": 1, "21-40": 1 },
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 13,
        artifacts: { csv: "part-1.csv" },
        validation: { ok: true, validation: { rows: 572 }, artifacts: { csv: { sha256: "hash-1", size_bytes: 10 } } },
        artifactRecords: [{ kind: "csv", path: "part-1.csv", sha256: "hash-1", sizeBytes: 10 }],
      },
      "14-40": {
        status: "STALLED",
        start: 14,
        end: 40,
        completedEnd: 20,
        artifacts: { csv: "part-2.csv" },
        validation: { ok: true, validation: { rows: 297 }, artifacts: { csv: { sha256: "hash-2", size_bytes: 10 } } },
        artifactRecords: [{ kind: "csv", path: "part-2.csv", sha256: "hash-2", sizeBytes: 10 }],
      },
      "21-40": {
        status: "FAILED",
        start: 21,
        end: 40,
        completedEnd: 20,
        error: "Xiaowangshen configuration did not match the requested contract",
        artifacts: {},
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("FAILED", {
    parts: {
      "1-40": {
        status: "FAILED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "some other failure",
      },
    },
  })), false);
  assert.equal(shouldResumeAdaptiveRun(run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 0,
        exportFailure: { reason: "artifact_settlement_failed" },
      },
    },
  })), false);
  assert.equal(shouldResumeAdaptiveRun(run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 0,
        exportFailure: { reason: "result_ownership_unavailable" },
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 12,
        artifacts: { csv: "part.csv" },
        validation: { ok: true, validation: { rows: 10 }, artifacts: { csv: { sha256: "hash", size_bytes: 10 } } },
        artifactRecords: [{ kind: "csv", path: "part.csv", sha256: "hash", sizeBytes: 10 }],
      },
    },
  })), true);
});

test("requires evidence for the current range unless verified prior progress proves the next range", () => {
  assert.equal(shouldResumeAdaptiveRun(run("RUNNING", {
    completedEnd: 20,
    attempts: { "1-20": 1 },
  })), false);
  assert.equal(shouldResumeAdaptiveRun(run("RUNNING", {
    completedEnd: 20,
    attempts: { "1-20": 1 },
    parts: {
      "1-20": {
        status: "STALLED",
        start: 1,
        end: 20,
        completedEnd: 20,
        artifacts: { csv: "part-1-20.csv" },
        validation: {
          ok: true,
          validation: { rows: 100 },
          artifacts: { csv: { sha256: "hash", size_bytes: 10 } },
        },
        artifactRecords: [{ kind: "csv", path: "part-1-20.csv", sha256: "hash", sizeBytes: 10 }],
      },
    },
  })), true);
});

test("resumes a generic no-progress stall with current-range attempt evidence", () => {
  assert.equal(shouldResumeAdaptiveRun(run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "Xiaowangshen made no page progress before the stall threshold",
      },
    },
  })), true);
  assert.equal(shouldResumeAdaptiveRun(run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 0,
        error: "Xiaowangshen exceeded the bounded collection deadline",
      },
    },
  })), false);
});

test("inspects only a uniquely owned browser attempt with current request evidence", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/targets")) {
      return new Response(JSON.stringify([{ type: "page", targetId: "target-1", url: "https://s.taobao.com/search?q=%E6%B5%B4%E7%BC%B8" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ value: {
      range: { start: 1, end: 40 },
      activeAttempt: "attempt-1",
      trackerOwned: true,
      requestEvidence: true,
      activity: {
        lastActivityAt: new Date(Date.now() - 1_000).toISOString(),
        requestCount: 1,
        responseCount: 1,
        resultCount: 1,
      },
      progress: { keyword: "浴缸", sortLabel: "销量排序", requestedStart: 1, requestedEnd: 40, completedEnd: 10, rowCount: 100, complete: false },
      complete: false,
    } }), { status: 200 });
  };
  try {
    const result = await inspectBrowserAttempt({
      proxy: "http://127.0.0.1:3456",
      identity,
    });
    assert.equal(result.action, "WAITING_FOR_BROWSER");
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies a diagnostic browser attempt with only historical activity as stale", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  globalThis.fetch = async (url) => {
    if (url.endsWith("/targets")) {
      return new Response(JSON.stringify([{ type: "page", targetId: "target-1", url: "https://s.taobao.com/search?q=%E6%B5%B4%E7%BC%B8" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ value: {
      range: { start: 1, end: 40 },
      activeAttempt: "attempt-1",
      trackerOwned: true,
      requestEvidence: true,
      activity: {
        lastActivityAt: new Date(now - (identity.stallSeconds * 1000 + 1_000)).toISOString(),
        requestCount: 1,
        responseCount: 1,
        resultCount: 1,
      },
      progress: { keyword: "浴缸", sortLabel: "销量排序", requestedStart: 1, requestedEnd: 40, completedEnd: 10, rowCount: 100, complete: false },
      complete: false,
    } }), { status: 200 });
  };
  try {
    const result = await inspectBrowserAttempt({
      proxy: "http://127.0.0.1:3456",
      identity,
      now: () => now,
    });
    assert.equal(result.action, "STALE_BROWSER_ATTEMPT");
    assert.equal(result.activityFresh, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not launch a second runner while a browser attempt is stale", async () => {
  let launched = false;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("STALLED", {
        parts: {
          "1-40": {
            status: "STALLED",
            start: 1,
            end: 40,
            completedEnd: 0,
            error: "Xiaowangshen made no page progress before the stall threshold",
          },
        },
      }),
      inspectBrowserAttempt: async () => ({
        action: "STALE_BROWSER_ATTEMPT",
        targetId: "old-target",
        activeAttempt: "old-attempt",
        activityFresh: false,
      }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => {
      launched = true;
    },
  });
  assert.equal(result.action, "STOPPED");
  assert.equal(result.status, "HUMAN_REQUIRED");
  assert.equal(launched, false);
});

test("does not launch a second runner while the PostgreSQL adaptive lock is held", async () => {
  let launched = false;
  let runtimeReleased = false;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    state: {
      getAdaptiveRun: async () => run("RUNNING"),
      acquireRuntime: async () => ({ release: async () => { runtimeReleased = true; } }),
      acquireAdaptiveLock: async () => {
        const error = new Error("busy");
        error.code = "BUSY";
        throw error;
      },
    },
    spawnRunner: async () => { launched = true; },
  });
  assert.deepEqual(result, { action: "BUSY", runId: "run-1" });
  assert.equal(launched, false);
  assert.equal(runtimeReleased, true);
});

test("waits for an active browser attempt instead of launching a duplicate runner", async () => {
  let launched = false;
  let waits = 0;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("STALLED", {
        parts: {
          "1-40": {
            status: "STALLED",
            start: 1,
            end: 40,
            completedEnd: 0,
            error: "Xiaowangshen made no page progress before the stall threshold",
          },
        },
      }),
      inspectBrowserAttempt: async () => ({
        action: "WAITING_FOR_BROWSER",
        targetId: "old-target",
        activeAttempt: "old-attempt",
        progress: { completedEnd: 10, rowCount: 100, complete: false },
      }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => {
      launched = true;
    },
  });
  assert.equal(result.action, "WAITING_FOR_BROWSER");
  assert.equal(launched, false);
  assert.equal(waits, 0);
});

test("does not relaunch a run after its recoverable retry budget is exhausted", async () => {
  let launched = false;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("STALLED", {
        retryBudget: { maxAttempts: 3 },
        attempts: { "1-40": 3 },
        parts: {
          "1-40": {
            status: "STALLED",
            start: 1,
            end: 40,
            completedEnd: 0,
            error: "Xiaowangshen made no page progress before the stall threshold",
          },
        },
      }),
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => { launched = true; },
  });
  assert.equal(result.action, "STOPPED");
  assert.equal(result.status, "FAILED");
  assert.equal(launched, false);
});

test("launches a new attempt when browser inspection finds no active page", async () => {
  let launched = false;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("STALLED", {
        parts: {
          "1-40": {
            status: "STALLED",
            start: 1,
            end: 40,
            completedEnd: 0,
            error: "Xiaowangshen made no page progress before the stall threshold",
          },
        },
      }),
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => {
      launched = true;
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.action, "SPAWNED");
  assert.equal(launched, true);
});

test("launches live-result adoption after an active browser attempt completes", async () => {
  let args;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("STALLED", {
        parts: {
          "1-40": {
            status: "STALLED",
            start: 1,
            end: 40,
            completedEnd: 0,
            error: "Xiaowangshen made no page progress before the stall threshold",
          },
        },
      }),
      inspectBrowserAttempt: async () => ({
        action: "ADOPT_LIVE_RESULT",
        targetId: "old-target",
        activeAttempt: "old-attempt",
        progress: { completedEnd: 40, rowCount: 400, complete: true },
      }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async (receivedArgs) => {
      args = receivedArgs;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.action, "SPAWNED");
  assert.ok(args.includes("--adopt-live-result"));
});

test("keeps both ownership locks through the supervised runner lifetime", async () => {
  const calls = [];
  const releases = [];
  let childEnv;
  const result = await superviseAdaptiveRunOnce({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => run("RUNNING"),
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => releases.push("runtime") }),
      acquireAdaptiveLock: async () => ({ release: async () => releases.push("database") }),
    },
    spawnRunner: async (args, env) => {
      calls.push(args);
      childEnv = env;
      assert.deepEqual(releases, []);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.action, "SPAWNED");
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--resume"));
  assert.ok(calls[0].includes("--run-id"));
  assert.equal(childEnv.XWS_ADAPTIVE_SUPERVISOR_OWNER, "1");
  assert.deepEqual(releases, ["database", "runtime"]);
});

test("continues a fresh watch with the PostgreSQL-generated run ID", async () => {
  const fresh = run("RUNNING");
  fresh.id = "generated-run";
  fresh.checkpoint.attempts = {};
  const done = { ...fresh, status: "DONE", checkpoint: { ...fresh.checkpoint, status: "DONE" } };
  const reads = [];
  const result = await superviseAdaptiveRun({
    pool: {},
    create: true,
    runnerArgs: ["--keyword", "浴缸"],
    checkpoint: "C:/state/generated-run.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      createAdaptiveRun: async () => fresh,
      getAdaptiveRun: async (_pool, id) => {
        reads.push(id);
        return done;
      },
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.deepEqual(result, {
    action: "COMPLETED",
    runId: "generated-run",
    status: "DONE",
    code: 0,
  });
  assert.deepEqual(reads, ["generated-run"]);
});

test("rechecks PostgreSQL after a successful child exit before stopping supervision", async () => {
  const states = [run("RUNNING"), run("RUNNING"), run("DONE")];
  let reads = 0;
  let launches = 0;
  let waits = 0;
  const result = await superviseAdaptiveRun({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => states[reads++],
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => {
      launches += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async () => {
      waits += 1;
    },
  });
  assert.deepEqual(result, { action: "COMPLETED", runId: "run-1", status: "DONE", code: 0 });
  assert.equal(launches, 1);
  assert.equal(reads, 3);
  assert.equal(waits, 0);
});

test("restarts the same run after a recoverable child exit", async () => {
  const stalled = run("STALLED", {
    parts: {
      "1-40": {
        status: "STALLED",
        start: 1,
        end: 40,
        completedEnd: 0,
        exportFailure: { reason: "result_ownership_unavailable" },
      },
    },
  });
  const states = [run("RUNNING"), run("RUNNING"), stalled, stalled, stalled, run("DONE")];
  let reads = 0;
  let launches = 0;
  const codes = [3, 0];
  let waits = 0;
  const result = await superviseAdaptiveRun({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    proxy: "http://127.0.0.1:3456",
    state: {
      getAdaptiveRun: async () => states[reads++],
      inspectBrowserAttempt: async () => ({ action: "NONE" }),
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => ({ code: codes[launches++], stdout: "", stderr: "" }),
    sleep: async () => {
      waits += 1;
    },
  });
  assert.deepEqual(result, { action: "COMPLETED", runId: "run-1", status: "DONE", code: 0 });
  assert.equal(launches, 2);
  assert.equal(waits, 1);
  assert.equal(reads, 6);
});

test("stops supervision when the child records a human-required terminal state", async () => {
  const states = [run("RUNNING"), run("RUNNING"), run("HUMAN_REQUIRED")];
  let reads = 0;
  let launches = 0;
  let waits = 0;
  const result = await superviseAdaptiveRun({
    pool: {},
    runId: "run-1",
    checkpoint: "C:/state/run-1.json",
    state: {
      getAdaptiveRun: async () => states[reads++],
      acquireRuntime: async () => ({ release: async () => {} }),
      acquireAdaptiveLock: async () => ({ release: async () => {} }),
    },
    spawnRunner: async () => {
      launches += 1;
      return { code: 2, stdout: "", stderr: "" };
    },
    sleep: async () => {
      waits += 1;
    },
  });
  assert.deepEqual(result, { action: "STOPPED", runId: "run-1", status: "HUMAN_REQUIRED", code: 2 });
  assert.equal(launches, 1);
  assert.equal(waits, 0);
  assert.equal(reads, 3);
});
