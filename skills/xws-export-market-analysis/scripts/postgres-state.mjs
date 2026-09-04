import crypto from "node:crypto";

import pg from "pg";

const { Pool } = pg;

export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS xws_adaptive_runs (
  id uuid PRIMARY KEY,
  lock_key bigint NOT NULL,
  identity jsonb NOT NULL,
  identity_hash text NOT NULL UNIQUE,
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
  };
}

export function createStatePool(connectionString) {
  return new Pool({ connectionString, max: 4 });
}

export async function ensureStateSchema(pool) {
  await pool.query(STATE_SCHEMA);
  await pool.query("ALTER TABLE xws_adaptive_runs ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb");
}

export async function createAdaptiveRun(pool, identity) {
  const hash = identityHash(identity);
  const key = lockKey(identity);
  try {
    const result = await pool.query(
      `INSERT INTO xws_adaptive_runs
        (id, lock_key, identity, identity_hash, pages_start, pages_end, completed_end)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $5 - 1)
       RETURNING *`,
      [crypto.randomUUID(), key.toString(), JSON.stringify(identity), hash, identity.pagesStart ?? 1, identity.pagesEnd ?? identity.pagesStart ?? 1,]
    );
    return mapRun(result.rows[0]);
  } catch (error) {
    if (error?.code === "23505") {
      const duplicate = new Error(`adaptive run identity already exists: ${hash}`);
      duplicate.code = "ADAPTIVE_RUN_EXISTS";
      throw duplicate;
    }
    throw error;
  }
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

export async function commitAdaptivePart(pool, runId, {
  partId,
  startPage,
  endPage,
  completedEnd,
  status,
  metadata,
  artifacts = [],
  checkpoint,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
        WHERE id = $1
        RETURNING *`,
      [runId, completedEnd, status, JSON.stringify(checkpoint ?? {})],
    );
    if (!result.rowCount) throw new Error(`adaptive run not found: ${runId}`);
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
