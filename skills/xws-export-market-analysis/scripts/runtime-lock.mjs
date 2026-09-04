import crypto from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function normalizeStartTime(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function inspectWindowsProcess(pid) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$p = Get-Process -Id $args[0] -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 2 }; $p.StartTime.ToUniversalTime().ToString('o')",
    String(pid),
  ], { encoding: "utf8", windowsHide: true });
  if (result.status === 2) return { state: "dead", startedAt: null };
  if (result.status !== 0) return { state: "unknown", startedAt: null };
  const startedAt = normalizeStartTime(result.stdout.trim());
  return startedAt ? { state: "alive", startedAt } : { state: "unknown", startedAt: null };
}

function inspectUnixProcess(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return { state: "dead", startedAt: null };
  const startedAt = normalizeStartTime(result.stdout.trim());
  return startedAt ? { state: "alive", startedAt } : { state: "unknown", startedAt: null };
}

export function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "dead", startedAt: null };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { state: "dead", startedAt: null };
    if (error?.code !== "EPERM") return { state: "unknown", startedAt: null };
  }
  return process.platform === "win32" ? inspectWindowsProcess(pid) : inspectUnixProcess(pid);
}

export function isStaleLock(record, processInfo) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (processInfo?.state === "dead") return true;
  if (processInfo?.state !== "alive") return false;
  const recorded = normalizeStartTime(record.processStartedAt);
  const actual = normalizeStartTime(processInfo.startedAt);
  return Boolean(recorded && actual && recorded !== actual);
}

function makeLockRecord(clock, inspector) {
  const processInfo = inspector(process.pid);
  return {
    pid: process.pid,
    startedAt: new Date(clock()).toISOString(),
    processStartedAt: processInfo.startedAt,
    token: crypto.randomUUID(),
  };
}

function busyError() {
  const error = new Error("another Xiaowangshen market-analysis run is already active");
  error.code = "BUSY";
  return error;
}

function corruptLockError(lockPath) {
  const error = new Error(`market-analysis lock is corrupt and requires manual recovery: ${lockPath}`);
  error.code = "CORRUPT_LOCK";
  error.lockPath = lockPath;
  return error;
}

async function acquireTransitionLock(lockPath, {
  fsApi,
  clock,
  inspector,
} = {}) {
  const transitionPath = `${lockPath}.transition`;
  const record = makeLockRecord(clock, inspector);
  try {
    const handle = await fsApi.open(transitionPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
    } catch (writeError) {
      try { await handle.close(); } catch {}
      try { await fsApi.unlink(transitionPath); } catch {}
      throw writeError;
    }
    await handle.close();
    return {
      release: async () => {
        let current;
        try {
          current = JSON.parse(await fsApi.readFile(transitionPath, "utf8"));
        } catch {
          return false;
        }
        if (current?.token !== record.token) return false;
        await fsApi.unlink(transitionPath);
        return true;
      },
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try {
      existing = JSON.parse(await fsApi.readFile(transitionPath, "utf8"));
    } catch {
      throw busyError();
    }
    if (!isStaleLock(existing, inspector(existing.pid))) throw busyError();
    const quarantine = `${transitionPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsApi.rename(transitionPath, quarantine);
    } catch (renameError) {
      if (renameError?.code === "ENOENT") return acquireTransitionLock(lockPath, { fsApi, clock, inspector });
      throw renameError;
    }
    try {
      const current = JSON.parse(await fsApi.readFile(quarantine, "utf8"));
      if (!isStaleLock(current, inspector(current.pid))) throw busyError();
      await fsApi.unlink(quarantine);
    } catch (reclaimError) {
      if (reclaimError?.code === "BUSY") {
        try {
          const handle = await fsApi.open(transitionPath, "wx");
          try { await handle.writeFile(JSON.stringify(existing), "utf8"); } finally { await handle.close(); }
        } catch (restoreError) {
          if (restoreError?.code !== "EEXIST") throw restoreError;
        }
      }
      throw reclaimError;
    }
    return acquireTransitionLock(lockPath, { fsApi, clock, inspector });
  }
}

async function writeLock(lockPath, record, fsApi) {
  const handle = await fsApi.open(lockPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
  } catch (writeError) {
    try { await handle.close(); } catch {}
    try { await fsApi.unlink(lockPath); } catch {}
    throw writeError;
  }
  await handle.close();
}

export async function acquireRuntimeLock(lockPath, {
  fsApi = { open, readFile, rename, unlink },
  clock = () => Date.now(),
  inspector = inspectProcess,
  maxAttempts = 3,
} = {}) {
  const record = makeLockRecord(clock, inspector);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let transition;
    try {
      transition = await acquireTransitionLock(lockPath, { fsApi, clock, inspector });
    } catch (error) {
      if (error?.code === "BUSY") throw error;
      throw error;
    }

    try {
      try {
        await writeLock(lockPath, record, fsApi);
        return { record, release: () => releaseRuntimeLock(lockPath, record, { fsApi, clock, inspector }) };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      let existing;
      try {
        existing = JSON.parse(await fsApi.readFile(lockPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw corruptLockError(lockPath);
      }
      if (!isStaleLock(existing, inspector(existing.pid))) throw busyError();
      await fsApi.unlink(lockPath);
      await writeLock(lockPath, record, fsApi);
      return { record, release: () => releaseRuntimeLock(lockPath, record, { fsApi, clock, inspector }) };
    } finally {
      await transition.release();
    }
  }
  throw busyError();
}

export async function releaseRuntimeLock(lockPath, record, {
  fsApi = { open, readFile, rename, unlink },
  clock = () => Date.now(),
  inspector = inspectProcess,
} = {}) {
  let transition;
  try {
    transition = await acquireTransitionLock(lockPath, { fsApi, clock, inspector });
  } catch (error) {
    if (error?.code === "BUSY") return false;
    throw error;
  }

  const quarantine = `${lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    try {
      await fsApi.rename(lockPath, quarantine);
    } catch {
      return false;
    }

    let current;
    try {
      current = JSON.parse(await fsApi.readFile(quarantine, "utf8"));
    } catch {
      return false;
    }

    if (current?.token !== record?.token) {
      try {
        const handle = await fsApi.open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(current), "utf8");
        } finally {
          await handle.close();
        }
        await fsApi.unlink(quarantine);
      } catch {}
      return false;
    }

    try {
      await fsApi.readFile(lockPath, "utf8");
      await fsApi.unlink(quarantine);
      return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }

    await fsApi.unlink(quarantine);
    return true;
  } finally {
    await transition.release();
  }
}

export function defaultLockPath(runtimeRoot = path.join(os.tmpdir(), "xws-runs")) {
  return path.join(runtimeRoot, ".market-analysis.lock");
}
