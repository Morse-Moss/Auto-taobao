import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireAdaptiveLock,
  commitAdaptivePart,
  createAdaptiveRun,
  createStatePool,
  ensureStateSchema,
  getAdaptiveRun,
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

test("fresh adaptive identity cannot be created twice", integration, async () => {
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
    await assert.rejects(
      () => createAdaptiveRun(pool, identity),
      (error) => error.code === "ADAPTIVE_RUN_EXISTS",
    );
    assert.equal((await getAdaptiveRun(pool, first.id)).id, first.id);
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
  await withPool(async (pool) => {
    const identity = { keyword: `crash-test-${Date.now()}`, pagesStart: 1, pagesEnd: 1 };
    const ownerPool = await createStatePool(databaseUrl);
    const contenderPool = await createStatePool(databaseUrl);
    try {
      await acquireAdaptiveLock(ownerPool, identity);
      await ownerPool.end();
      const contender = await acquireAdaptiveLock(contenderPool, identity);
      await contender.release();
    } finally {
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
    await assert.rejects(
      () => createAdaptiveRun(pool, { options: { channel: "all", sort: "sales" }, pagesEnd: 1, pagesStart: 1, keyword: first.identity.keyword }),
      (error) => error.code === "ADAPTIVE_RUN_EXISTS",
    );
  });
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
