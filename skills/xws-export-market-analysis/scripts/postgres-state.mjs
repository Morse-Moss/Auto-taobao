import crypto from "node:crypto";

import pg from "pg";

const { Pool } = pg;

export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS xws_adaptive_runs (
  id uuid PRIMARY KEY,
  lock_key bigint NOT NULL,
  identity jsonb NOT NULL,
  identity_hash text NOT NULL,
  pages_start integer NOT NULL,
  pages_end integer NOT NULL,
  completed_end integer NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS xws_adaptive_parts (
  run_id uuid NOT NULL REFERENCES xws_adaptive_runs(id) ON DELETE CASCADE,
  part_id text NOT NULL,
  start_page integer NOT NULL,
  end_page integer NOT NULL,
  completed_end integer NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, part_id)
);

CREATE TABLE IF NOT EXISTS xws_adaptive_manifests (
  run_id uuid NOT NULL REFERENCES xws_adaptive_runs(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  path text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY (run_id, artifact_kind, path)
);
`;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function identityHash(identity) {
  return crypto.createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function lockKey(identity) {
  const digest = crypto.createHash("sha256").update(canonicalJson(identity)).digest();
  return digest.readBigInt64BE(0);
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    identity: row.identity,
    pagesStart: row.pages_start,
    pagesEnd: row.pages_end,
    completedEnd: row.completed_end,
    status: row.status,
    version: Number(row.version),
    checkpoint: row.checkpoint,
  };
}

export function createStatePool(connectionString) {
  return new Pool({ connectionString, max: 4 });
}

// 孤儿 run 收尾：进程被强杀（沙箱拦截、TaskStop 清进程树、崩溃）时 runner 来不及写终态，
// 行会永远停在 RUNNING。终态写入依赖进程存活，且本表没有租约心跳，因此用
// "RUNNING 且 updated_at 超过阈值"判定孤儿，在每次开新 run 前统一标记为 FAILED。
// FAILED 仍可被 shouldResumeAdaptiveRun 的恢复规则（有已验证分段时）捡起，不丢已采数据。
export const STALE_RUNNING_REAP_MAX_AGE_HOURS = 24;

export function buildStaleRunningReaperPlan(rows, now = new Date(), maxAgeHours = STALE_RUNNING_REAP_MAX_AGE_HOURS) {
  if (!Array.isArray(rows)) throw new Error("running rows must be an array");
  const cutoff = now.getTime() - maxAgeHours * 60 * 60 * 1000;
  const staleIds = [];
  let freshCount = 0;
  for (const row of rows) {
    const updatedAt = row?.updated_at instanceof Date ? row.updated_at : new Date(row?.updated_at);
    if (!(updatedAt instanceof Date) || Number.isNaN(updatedAt.getTime())) {
      throw new Error(`stale-running reaper found a RUNNING row without valid updated_at: ${row?.id ?? "<missing id>"}`);
    }
    if (updatedAt.getTime() <= cutoff) staleIds.push(row.id);
    else freshCount += 1;
  }
  return { staleIds, freshCount };
}

export async function reapStaleRunningRuns(pool, { maxAgeHours = STALE_RUNNING_REAP_MAX_AGE_HOURS, now = new Date() } = {}) {
  const running = await pool.query(
    "SELECT id, updated_at FROM xws_adaptive_runs WHERE status = 'RUNNING'",
  );
  const plan = buildStaleRunningReaperPlan(running.rows, now, maxAgeHours);
  if (!plan.staleIds.length) return { reapedIds: [], freshCount: plan.freshCount };
  const update = await pool.query(
    `UPDATE xws_adaptive_runs
        SET status = 'FAILED', version = version + 1, updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'RUNNING'
      RETURNING id`,
    [plan.staleIds],
  );
  return { reapedIds: update.rows.map((row) => row.id), freshCount: plan.freshCount };
}

export async function ensureStateSchema(pool) {
  await pool.query(STATE_SCHEMA);
  await pool.query("ALTER TABLE xws_adaptive_runs ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE xws_adaptive_runs DROP CONSTRAINT IF EXISTS xws_adaptive_runs_identity_hash_key");
}

export async function createAdaptiveRun(pool, identity, checkpoint = {}) {
  // 开新 run 前先收尸：把强杀残留的陈旧 RUNNING 标记为 FAILED，避免孤儿累积。
  await reapStaleRunningRuns(pool);
  const hash = identityHash(identity);
  const key = lockKey(identity);
  const id = crypto.randomUUID();
  const initial = { ...structuredClone(checkpoint), runId: id };
  const result = await pool.query(
    `INSERT INTO xws_adaptive_runs
      (id, lock_key, identity, identity_hash, pages_start, pages_end, completed_end, status, checkpoint)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      id,
      key.toString(),
      JSON.stringify(identity),
      hash,
      identity.pagesStart ?? 1,
      identity.pagesEnd ?? identity.pagesStart ?? 1,
      initial.completedEnd ?? (identity.pagesStart ?? 1) - 1,
      initial.status || "RUNNING",
      JSON.stringify(initial),
    ],
  );
  return mapRun(result.rows[0]);
}

export async function getAdaptiveRun(pool, id, expectedIdentity) {
  const result = await pool.query("SELECT * FROM xws_adaptive_runs WHERE id = $1", [id]);
  const run = mapRun(result.rows[0]);
  if (run && expectedIdentity && identityHash(run.identity) !== identityHash(expectedIdentity)) {
    const error = new Error(`adaptive collection contract does not match run: ${id}`);
    error.code = "ADAPTIVE_CONTRACT_MISMATCH";
    throw error;
  }
  return run;
}

export async function updateAdaptiveProgress(pool, id, { completedEnd }) {
  const result = await pool.query(
    `UPDATE xws_adaptive_runs
        SET completed_end = GREATEST(completed_end, $2), version = version + 1, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, completedEnd],
  );
  if (!result.rowCount) throw new Error(`adaptive run not found: ${id}`);
  return mapRun(result.rows[0]);
}

function versionConflict(id, expectedVersion) {
  const error = new Error(`adaptive run version conflict: ${id} expected ${expectedVersion}`);
  error.code = "ADAPTIVE_VERSION_CONFLICT";
  return error;
}

export async function updateAdaptiveCheckpoint(pool, id, checkpoint, expectedVersion) {
  if (!Number.isInteger(expectedVersion)) throw new Error("expected adaptive run version is required");
  const result = await pool.query(
    `UPDATE xws_adaptive_runs
        SET completed_end = GREATEST(completed_end, $2),
            status = $3,
            checkpoint = $4::jsonb,
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND version = $5
      RETURNING *`,
    [id, checkpoint.completedEnd, checkpoint.status, JSON.stringify(checkpoint), expectedVersion],
  );
  if (!result.rowCount) throw versionConflict(id, expectedVersion);
  return mapRun(result.rows[0]);
}

export async function commitAdaptivePart(pool, runId, {
  partId,
  startPage,
  endPage,
  completedEnd,
  status,
  metadata,
  artifacts = [],
  checkpoint,
  expectedVersion,
}) {
  if (!Number.isInteger(expectedVersion)) throw new Error("expected adaptive run version is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT version FROM xws_adaptive_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    if (!owner.rowCount || Number(owner.rows[0].version) !== expectedVersion) {
      throw versionConflict(runId, expectedVersion);
    }
    await client.query(
      `INSERT INTO xws_adaptive_parts
        (run_id, part_id, start_page, end_page, completed_end, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (run_id, part_id) DO UPDATE SET
         start_page = EXCLUDED.start_page,
         end_page = EXCLUDED.end_page,
         completed_end = EXCLUDED.completed_end,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [runId, partId, startPage, endPage, completedEnd, status, JSON.stringify(metadata ?? {})],
    );
    for (const artifact of artifacts) {
      await client.query(
        `INSERT INTO xws_adaptive_manifests
          (run_id, artifact_kind, path, sha256, size_bytes, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (run_id, artifact_kind, path) DO UPDATE SET
           sha256 = EXCLUDED.sha256,
           size_bytes = EXCLUDED.size_bytes,
           metadata = EXCLUDED.metadata`,
        [runId, artifact.kind, artifact.path, artifact.sha256, artifact.sizeBytes, JSON.stringify(artifact.metadata ?? {})],
      );
    }
    const result = await client.query(
      `UPDATE xws_adaptive_runs
          SET completed_end = GREATEST(completed_end, $2),
              status = $3,
              checkpoint = $4::jsonb,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND version = $5
        RETURNING *`,
      [runId, completedEnd, status, JSON.stringify(checkpoint ?? {}), expectedVersion],
    );
    if (!result.rowCount) throw versionConflict(runId, expectedVersion);
    await client.query("COMMIT");
    return mapRun(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function acquireAdaptiveLock(pool, identity) {
  const key = lockKey(identity);
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [key.toString()],
    );
    if (!result.rows[0].acquired) {
      const error = new Error("another Xiaowangshen adaptive run is already active");
      error.code = "BUSY";
      throw error;
    }
    let released = false;
    return {
      client,
      key,
      release: async () => {
        if (released) return false;
        released = true;
        try {
          const result = await client.query(
            "SELECT pg_advisory_unlock($1) AS released",
            [key.toString()],
          );
          return Boolean(result.rows[0]?.released);
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}
