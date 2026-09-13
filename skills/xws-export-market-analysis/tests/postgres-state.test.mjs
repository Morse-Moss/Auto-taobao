import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireAdaptiveLock,
  buildStaleRunningReaperPlan,
  commitAdaptivePart,
  createAdaptiveRun,
  createStatePool,
  ensureStateSchema,
  getAdaptiveRun,
  reapStaleRunningRuns,
  STATE_SCHEMA,
  updateAdaptiveCheckpoint,
  updateAdaptiveProgress,
} from "../scripts/postgres-state.mjs";

const databaseUrl = process.env.XWS_TEST_DATABASE_URL;
const integration = { skip: !databaseUrl };

async function withPool(callback) {
  if (!databaseUrl) return callback(null);
  const pool = await createStatePool(databaseUrl);
  try {
    await ensureStateSchema(pool);
    return await callback(pool);
  } finally {
    await pool.end();
  }
}

test("schema allows recurring fresh runs with the same identity", async () => {
  assert.doesNotMatch(STATE_SCHEMA, /identity_hash text NOT NULL UNIQUE/u);
  const calls = [];
  await ensureStateSchema({ query: async (sql) => { calls.push(sql); } });
  assert.ok(calls.some((sql) => /DROP CONSTRAINT IF EXISTS xws_adaptive_runs_identity_hash_key/u.test(sql)));
});

test("checkpoint updates reject stale PostgreSQL versions", async () => {
  const calls = [];
  const pool = {
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(
    updateAdaptiveCheckpoint(pool, "run-id", { completedEnd: 4, status: "RUNNING" }, 7),
    (error) => error.code === "ADAPTIVE_VERSION_CONFLICT",
  );
  assert.match(calls[0].sql, /version = \$5/u);
  assert.deepEqual(calls[0].parameters, ["run-id", 4, "RUNNING", JSON.stringify({ completedEnd: 4, status: "RUNNING" }), 7]);
});

test("part commits reject stale PostgreSQL versions before changing state", async () => {
  const queries = [];
  const client = {
    query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (String(sql).includes("SELECT version")) return { rowCount: 1, rows: [{ version: 4 }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  await assert.rejects(
    commitAdaptivePart(pool, "run-id", {
      partId: "1-4",
      startPage: 1,
      endPage: 4,
      completedEnd: 4,
      status: "DONE",
      metadata: {},
      checkpoint: { completedEnd: 4, status: "DONE" },
      expectedVersion: 3,
    }),
    (error) => error.code === "ADAPTIVE_VERSION_CONFLICT",
  );
  assert.deepEqual(queries.map(({ sql }) => String(sql).trim().split(/\s+/u).slice(0, 3).join(" ")), [
    "BEGIN",
    "SELECT version FROM",
    "ROLLBACK",
  ]);
});

test("fresh adaptive runs may repeat an immutable collection contract", integration, async () => {
  await withPool(async (pool) => {
    const identity = {
      keyword: `pg-test-${Date.now()}`,
      pagesStart: 1,
      pagesEnd: 2,
      channel: "all",
      sort: "sales",
      price: "0-unlimited",
      frequency: "10-15",
      exportModes: ["csv"],
      outputDir: "C:/test-output",
      allowTrial: false,
      stallSeconds: 300,
    };
    const first = await createAdaptiveRun(pool, identity);
    const second = await createAdaptiveRun(pool, identity);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(first.identity, second.identity);
  });
});

test("only one PostgreSQL session acquires the same adaptive lock", integration, async () => {
  await withPool(async (pool) => {
    const identity = { keyword: `lock-test-${Date.now()}`, pagesStart: 1, pagesEnd: 1 };
    const first = await acquireAdaptiveLock(pool, identity);
    const secondPool = await createStatePool(databaseUrl);
    try {
      await assert.rejects(
        () => acquireAdaptiveLock(secondPool, identity),
        (error) => error.code === "BUSY",
      );
    } finally {
      await first.release();
      const second = await acquireAdaptiveLock(secondPool, identity);
      await second.release();
      await secondPool.end();
    }
  });
});

test("adaptive lock retains a dedicated PostgreSQL client", integration, async () => {
  await withPool(async (pool) => {
    const identity = { keyword: `ownership-test-${Date.now()}`, pagesStart: 1, pagesEnd: 1 };
    const owner = await acquireAdaptiveLock(pool, identity);
    try {
      assert.ok(owner.client);
      const contender = await pool.connect();
      try {
        const result = await contender.query(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [owner.key.toString()],
        );
        assert.equal(result.rows[0].acquired, false);
      } finally {
        contender.release();
      }
    } finally {
      await owner.release();
    }
  });
});

test("progress updates cannot move completedEnd backward", integration, async () => {
  await withPool(async (pool) => {
    const identity = { keyword: `progress-test-${Date.now()}`, pagesStart: 1, pagesEnd: 10 };
    const run = await createAdaptiveRun(pool, identity);
    await updateAdaptiveProgress(pool, run.id, { completedEnd: 7 });
    await updateAdaptiveProgress(pool, run.id, { completedEnd: 4 });
    assert.equal((await getAdaptiveRun(pool, run.id)).completedEnd, 7);
  });
});

test("a terminated PostgreSQL session releases its advisory lock", integration, async () => {
  await withPool(async () => {
    const identity = { keyword: `crash-test-${Date.now()}`, pagesStart: 1, pagesEnd: 1 };
    const ownerPool = await createStatePool(databaseUrl);
    const contenderPool = await createStatePool(databaseUrl);
    try {
      const owner = await acquireAdaptiveLock(ownerPool, identity);
      owner.client.release(true);
      const contender = await acquireAdaptiveLock(contenderPool, identity);
      await contender.release();
    } finally {
      await ownerPool.end();
      await contenderPool.end();
    }
  });
});

test("resume rejects a different collection contract", integration, async () => {
  await withPool(async (pool) => {
    const identity = { keyword: `resume-test-${Date.now()}`, pagesStart: 1, pagesEnd: 3, channel: "all", sort: "sales" };
    const run = await createAdaptiveRun(pool, identity);
    await assert.rejects(
      () => getAdaptiveRun(pool, run.id, { ...identity, sort: "price" }),
      (error) => error.code === "ADAPTIVE_CONTRACT_MISMATCH",
    );
  });
});

test("identity hashing treats object key order as semantically irrelevant", integration, async () => {
  await withPool(async (pool) => {
    const first = await createAdaptiveRun(pool, { keyword: `canonical-test-${Date.now()}`, pagesStart: 1, pagesEnd: 1, options: { sort: "sales", channel: "all" } });
    const second = await createAdaptiveRun(pool, { options: { channel: "all", sort: "sales" }, pagesEnd: 1, pagesStart: 1, keyword: first.identity.keyword });
    assert.equal(first.identity.keyword, second.identity.keyword);
  });
});

test("replays a part commit through idempotent part and artifact upserts", async () => {
  const queries = [];
  let version = 0;
  const client = {
    query: async (sql, parameters) => {
      const text = String(sql).trim();
      queries.push({ text, parameters });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (text.includes("SELECT version FROM")) return { rowCount: 1, rows: [{ version }] };
      if (text.includes("UPDATE xws_adaptive_runs")) {
        version += 1;
        return { rowCount: 1, rows: [{ id: "run-id", version, completed_end: 4, status: "DONE", identity: {}, checkpoint: {} }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const input = {
    partId: "1-4",
    startPage: 1,
    endPage: 4,
    completedEnd: 4,
    status: "DONE",
    metadata: { rows: 12 },
    artifacts: [{ kind: "csv", path: "C:/artifacts/part-1-4.csv", sha256: "abc", sizeBytes: 900 }],
    checkpoint: { completedEnd: 4, status: "DONE" },
    expectedVersion: 0,
  };
  await commitAdaptivePart(pool, "run-id", input);
  await commitAdaptivePart(pool, "run-id", { ...input, expectedVersion: 1 });
  assert.equal(queries.filter(({ text }) => text.includes("INSERT INTO xws_adaptive_parts")).length, 2);
  assert.ok(queries.every(({ text }) => !text.includes("INSERT INTO xws_adaptive_parts") || text.includes("ON CONFLICT (run_id, part_id) DO UPDATE")));
  assert.equal(queries.filter(({ text }) => text.includes("INSERT INTO xws_adaptive_manifests")).length, 2);
  assert.ok(queries.every(({ text }) => !text.includes("INSERT INTO xws_adaptive_manifests") || text.includes("ON CONFLICT (run_id, artifact_kind, path) DO UPDATE")));
});

test("commits a verified part and checkpoint projection atomically", integration, async () => {
  await withPool(async (pool) => {
    const identity = { keyword: `part-test-${Date.now()}`, pagesStart: 1, pagesEnd: 4 };
    const run = await createAdaptiveRun(pool, identity);
    const committed = await commitAdaptivePart(pool, run.id, {
      partId: "1-4",
      startPage: 1,
      endPage: 4,
      completedEnd: 4,
      status: "DONE",
      metadata: { rows: 12, sourceAt: "2026-09-04T00:00:00.000Z" },
      artifacts: [{
        kind: "csv",
        path: "C:/artifacts/part-1-4.csv",
        sha256: "abc123",
        sizeBytes: 900,
        metadata: { valid: true },
      }],
      checkpoint: { completedEnd: 4, status: "DONE" },
      expectedVersion: run.version,
    });
    assert.equal(committed.completedEnd, 4);
    const saved = await getAdaptiveRun(pool, run.id);
    assert.equal(saved.completedEnd, 4);
    assert.deepEqual(saved.checkpoint, { completedEnd: 4, status: "DONE" });
    const parts = await pool.query("SELECT * FROM xws_adaptive_parts WHERE run_id = $1", [run.id]);
    assert.equal(parts.rowCount, 1);
    const manifests = await pool.query("SELECT * FROM xws_adaptive_manifests WHERE run_id = $1", [run.id]);
    assert.equal(manifests.rowCount, 1);
  });
});

test("stale-running reaper plan separates orphans by updated_at threshold", () => {
  const now = new Date("2026-09-13T01:00:00.000Z");
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", updated_at: new Date("2026-09-12T00:00:00.000Z") },
    { id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-09-13T00:30:00.000Z" },
    { id: "33333333-3333-4333-8333-333333333333", updated_at: new Date("2026-09-12T01:00:00.000Z") },
  ];
  const plan = buildStaleRunningReaperPlan(rows, now, 24);
  assert.deepEqual(plan, {
    staleIds: ["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"],
    freshCount: 1,
  });
  assert.deepEqual(buildStaleRunningReaperPlan([], now, 24), { staleIds: [], freshCount: 0 });
  assert.throws(() => buildStaleRunningReaperPlan([{ id: "x", updated_at: "not-a-date" }], now), /valid updated_at/u);
  assert.throws(() => buildStaleRunningReaperPlan("rows", now), /must be an array/u);
});

test("reaper only flips RUNNING rows past the age threshold and leaves fresh ones", async () => {
  const calls = [];
  const staleId = "44444444-4444-4444-8444-444444444444";
  const pool = {
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (sql.startsWith("SELECT id, updated_at")) {
        return {
          rows: [
            { id: staleId, updated_at: new Date("2026-09-11T00:00:00.000Z") },
            { id: "55555555-5555-4555-8555-555555555555", updated_at: new Date("2026-09-13T00:59:00.000Z") },
          ],
        };
      }
      return { rows: [{ id: staleId }], rowCount: 1 };
    },
  };
  const result = await reapStaleRunningRuns(pool, { now: new Date("2026-09-13T01:00:00.000Z") });
  assert.deepEqual(result, { reapedIds: [staleId], freshCount: 1 });
  const updateCall = calls.find((call) => call.sql.startsWith("UPDATE xws_adaptive_runs"));
  assert.match(updateCall.sql, /status = 'FAILED'/u);
  assert.match(updateCall.sql, /AND status = 'RUNNING'/u);
  assert.deepEqual(updateCall.parameters[0], [staleId]);
});

test("reaper is a no-op when every RUNNING run is fresh", async () => {
  const calls = [];
  const pool = {
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return { rows: [{ id: "66666666-6666-4666-8666-666666666666", updated_at: new Date("2026-09-13T01:00:00.000Z") }] };
    },
  };
  const result = await reapStaleRunningRuns(pool, { now: new Date("2026-09-13T01:00:00.000Z") });
  assert.deepEqual(result, { reapedIds: [], freshCount: 1 });
  assert.equal(calls.length, 1);
});

test("createAdaptiveRun reaps stale RUNNING runs before inserting", async () => {
  const calls = [];
  const pool = {
    query: async (sql, parameters) => {
      calls.push(sql);
      if (sql.startsWith("SELECT id, updated_at")) return { rows: [] };
      return { rows: [{ id: "77777777-7777-4777-8777-777777777777", lock_key: 1, identity: {}, identity_hash: "h", pages_start: 1, pages_end: 2, completed_end: 0, status: "RUNNING", version: 0, created_at: new Date(), updated_at: new Date(), checkpoint: {} }] };
    },
  };
  await createAdaptiveRun(pool, { pagesStart: 1, pagesEnd: 2 }, {});
  assert.equal(calls[0].startsWith("SELECT id, updated_at FROM xws_adaptive_runs"), true);
  assert.ok(calls.some((sql) => sql.startsWith("INSERT INTO xws_adaptive_runs")));
});
