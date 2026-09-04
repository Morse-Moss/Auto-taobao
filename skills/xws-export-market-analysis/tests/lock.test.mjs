import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRuntimeLock, isStaleLock, releaseRuntimeLock } from "../scripts/runtime-lock.mjs";

async function tempLock() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xws-lock-test-"));
  return { directory, lockPath: path.join(directory, ".market-analysis.lock") };
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true });
}

test("active lock remains busy when process start time matches", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    const owner = await acquireRuntimeLock(lockPath, {
      inspector: () => ({ state: "alive", startedAt: "2026-08-23T09:47:24.553Z" }),
      clock: () => Date.parse("2026-09-03T00:00:00Z"),
    });
    await assert.rejects(
      acquireRuntimeLock(lockPath, {
        inspector: () => ({ state: "alive", startedAt: "2026-08-23T09:47:24.553Z" }),
      }),
      (error) => error.code === "BUSY",
    );
    await owner.release();
  } finally {
    await cleanup(directory);
  }
});

test("dead process lock is reclaimed", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 99999, startedAt: "2026-08-23T09:47:24.553Z", token: "old" }));
    const owner = await acquireRuntimeLock(lockPath, {
      inspector: () => ({ state: "dead", startedAt: null }),
      clock: () => Date.parse("2026-09-03T00:00:00Z"),
    });
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(record.token, owner.record.token);
    await owner.release();
  } finally {
    await cleanup(directory);
  }
});

test("PID reuse with a different start time is stale", () => {
  assert.equal(
    isStaleLock(
      { pid: 123, processStartedAt: "2026-08-23T09:47:24.553Z" },
      { state: "alive", startedAt: "2026-09-03T00:00:00Z" },
    ),
    true,
  );
});

test("unknown process state remains busy", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 123, startedAt: "2026-08-23T09:47:24.553Z", token: "old" }));
    await assert.rejects(
      acquireRuntimeLock(lockPath, { inspector: () => ({ state: "unknown", startedAt: null }) }),
      (error) => error.code === "BUSY",
    );
  } finally {
    await cleanup(directory);
  }
});

test("legacy lock without process start time remains busy when PID is alive", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 123, startedAt: "2026-08-23T09:47:24.553Z" }));
    await assert.rejects(
      acquireRuntimeLock(lockPath, { inspector: () => ({ state: "alive", startedAt: "2026-08-23T09:47:24.553Z" }) }),
      (error) => error.code === "BUSY",
    );
  } finally {
    await cleanup(directory);
  }
});

test("release cannot remove another owner's lock", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    const owner = await acquireRuntimeLock(lockPath, { inspector: () => ({ state: "alive", startedAt: "2026-09-03T00:00:00Z" }) });
    await writeFile(lockPath, JSON.stringify({ pid: 456, processStartedAt: "2026-09-03T00:00:00Z", token: "new-owner" }));
    assert.equal(await releaseRuntimeLock(lockPath, owner.record), false);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "new-owner");
  } finally {
    await cleanup(directory);
  }
});

test("empty or truncated lock reports a recoverable corrupt-lock error", async () => {
  for (const contents of ["", '{"pid":123']) {
    const { directory, lockPath } = await tempLock();
    try {
      await writeFile(lockPath, contents);
      await assert.rejects(
        acquireRuntimeLock(lockPath),
        (error) => error.code === "CORRUPT_LOCK" && error.lockPath === lockPath,
      );
    } finally {
      await cleanup(directory);
    }
  }
});

test("abandoned transition state cannot permanently block acquisition", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    await writeFile(
      `${lockPath}.transition`,
      JSON.stringify({ pid: 99999, token: "abandoned" }),
    );
    const owner = await acquireRuntimeLock(lockPath, {
      inspector: (pid) => pid === 99999
        ? { state: "dead", startedAt: null }
        : { state: "alive", startedAt: "2026-09-03T00:00:00Z" },
    });
    assert.equal(
      JSON.parse(await readFile(lockPath, "utf8")).token,
      owner.record.token,
    );
    await owner.release();
  } finally {
    await cleanup(directory);
  }
});

test("concurrent stale-lock reclaim gives ownership to only one contender", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 99999, processStartedAt: null, token: "stale" }));
    const inspector = (pid) => pid === 99999
      ? { state: "dead", startedAt: null }
      : { state: "alive", startedAt: "2026-09-03T00:00:00Z" };
    const attempts = await Promise.allSettled([
      acquireRuntimeLock(lockPath, { inspector, maxAttempts: 5 }),
      acquireRuntimeLock(lockPath, { inspector, maxAttempts: 5 }),
    ]);
    const owners = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    const busy = attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason?.code === "BUSY");
    assert.equal(owners.length, 1);
    assert.equal(busy.length, 1);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, owners[0].record.token);
    await owners[0].release();
  } finally {
    await cleanup(directory);
  }
});

test("release does not delete a replacement installed after ownership verification", async () => {
  const { directory, lockPath } = await tempLock();
  try {
    const owner = await acquireRuntimeLock(lockPath, { inspector: () => ({ state: "alive", startedAt: "2026-09-03T00:00:00Z" }) });
    const replacement = { pid: 456, processStartedAt: "2026-09-03T00:00:00Z", token: "new-owner" };
    let swapped = false;
    const fsApi = {
      readFile,
      rename: async (source, destination) => {
        await rename(source, destination);
        await writeFile(source, JSON.stringify(replacement));
        swapped = true;
      },
      unlink,
      open,
    };
    assert.equal(await releaseRuntimeLock(lockPath, owner.record, { fsApi }), false);
    assert.equal(swapped, true);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, replacement.token);
  } finally {
    await cleanup(directory);
  }
});
