#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  applyAdaptiveRun,
  checkpointOptions,
  createAdaptiveCheckpoint,
  lastJsonLine,
  nextAdaptiveRange,
  parseAdaptiveOptions,
  resumeAdaptiveCheckpoint,
  writeAdaptiveCheckpoint,
} from "./adaptive.mjs";
import {
  acquireAdaptiveLock,
  commitAdaptivePart,
  createAdaptiveRun,
  createStatePool,
  ensureStateSchema,
  getAdaptiveRun,
  updateAdaptiveCheckpoint,
} from "./postgres-state.mjs";
import { acquireMarketAnalysisLock } from "./runtime-lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, "export-market-analysis.mjs");
const MERGER = path.join(SCRIPT_DIR, "merge-market-analysis.mjs");
const VALIDATOR = path.join(SCRIPT_DIR, "validate-output.py");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireDatabaseUrl(env = process.env) {
  const value = String(env.XWS_DATABASE_URL || "").trim();
  if (!value) throw new Error("XWS_DATABASE_URL is required for adaptive runs");
  return value;
}

export function buildAdaptiveIdentity(options) {
  return {
    keyword: options.keyword,
    pagesStart: options.pages.start,
    pagesEnd: options.pages.end,
    channel: options.channel,
    sort: options.sort,
    price: { ...options.price },
    frequency: { ...options.frequency },
    exportModes: [...options.exportModes].sort(),
    outputDir: path.resolve(options.outputDir || path.join(os.homedir(), "Downloads")),
    allowTrial: Boolean(options.allowTrial),
    stallSeconds: Number(options.stallSeconds),
  };
}

export function chooseAttemptSnapshot(located, event) {
  if (located?.manifest) {
    const manifest = located.manifest;
    return {
      source: "manifest",
      sourceId: manifest.runId || "",
      manifestPath: located.path || "",
      status: manifest.status,
      progress: manifest.progress || {},
      diagnostics: manifest.diagnostics || manifest.stallEvidence || {},
      artifacts: manifest.artifacts || {},
      validation: manifest.validation || {},
      ...(manifest.error ? { error: manifest.error } : {}),
      ...(manifest.sourceAt || located.sourceAt ? { sourceAt: manifest.sourceAt || located.sourceAt } : {}),
    };
  }
  const details = event?.details || {};
  return {
    source: "event",
    sourceId: event?.runId || details.runId || "",
    manifestPath: "",
    status: event?.status,
    progress: details.progress || {},
    diagnostics: details.diagnostics || {},
    artifacts: details.artifacts || {},
    validation: details.validation || {},
    ...(event?.error ? { error: event.error } : {}),
    ...(event?.at || details.sourceAt ? { sourceAt: event?.at || details.sourceAt } : {}),
  };
}

export function validateProgressSnapshot(snapshot, range) {
  const progress = snapshot?.progress || {};
  const validation = snapshot?.validation;
  if (!snapshot?.artifacts?.csv) throw new Error("validated artifact is missing");
  if (validation?.ok !== true || !Number.isInteger(Number(validation?.validation?.rows))) {
    throw new Error("validator confirmation is missing");
  }
  const completedStart = Number(progress.completedStart);
  const completedEnd = Number(progress.completedEnd);
  const rowCount = Number(progress.rowCount);
  if (completedStart !== range.start) throw new Error("completed range does not start at the requested page");
  if (!Number.isInteger(completedEnd) || completedEnd < range.start || completedEnd > range.end) {
    throw new Error("completed range is outside the requested pages");
  }
  if (snapshot.status === "DONE" && completedEnd !== range.end) {
    throw new Error("completed range does not reach the requested end page");
  }
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount !== Number(validation.validation.rows)) {
    throw new Error("validated row count does not match progress");
  }
  return { completedStart, completedEnd, rowCount };
}

export function snapshotMetadata(parts) {
  const sourceIds = [...new Set(parts.map((part) => part?.sourceId).filter(Boolean))];
  const sourceTimes = [...new Set(parts.map((part) => part?.sourceAt || part?.at).filter(Boolean))];
  return {
    snapshot: sourceIds.length > 1 || sourceTimes.length > 1 ? "mixed_snapshot" : "single_snapshot",
    sourceIds,
    sourceTimes,
  };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyArtifactSet({ artifacts, exportModes, expectedArtifacts, metadata }) {
  const required = ["csv"];
  if (exportModes.includes("xlsx") || exportModes.includes("xlsx-images")) required.push("xlsx");
  const records = [];
  for (const kind of required) {
    const value = artifacts?.[kind];
    const file = typeof value === "string" ? value : value?.path;
    if (!file) throw new Error(`required ${kind} artifact is missing`);
    const details = await stat(file);
    if (!details.isFile() || details.size < 1) throw new Error(`required ${kind} artifact is empty`);
    const sha256 = await sha256File(file);
    if (expectedArtifacts) {
      const expected = expectedArtifacts[kind];
      if (!expected?.sha256 || !Number.isInteger(Number(expected?.size_bytes))) {
        throw new Error(`validator metadata for ${kind} is missing`);
      }
      if (details.size !== Number(expected.size_bytes)) {
        throw new Error(`${kind} artifact size does not match validator metadata`);
      }
      if (sha256.toLowerCase() !== String(expected.sha256).toLowerCase()) {
        throw new Error(`${kind} artifact does not match validator SHA-256`);
      }
    }
    records.push({
      kind,
      path: path.resolve(file),
      sha256,
      sizeBytes: details.size,
      metadata: { ...metadata },
    });
  }
  return records;
}

export async function openAuthoritativeRun({ pool, options, identity, expected, state = {} }) {
  const create = state.createAdaptiveRun || createAdaptiveRun;
  const get = state.getAdaptiveRun || getAdaptiveRun;
  const update = state.updateAdaptiveCheckpoint || updateAdaptiveCheckpoint;
  if (options.resume) {
    if (!options.runId) throw new Error("--resume requires --run-id");
    const run = await get(pool, options.runId, identity);
    if (!run) throw new Error(`adaptive run not found: ${options.runId}`);
    if (!run.checkpoint || run.checkpoint.strategy !== "adaptive") {
      throw new Error(`adaptive run has no checkpoint projection: ${options.runId}`);
    }
    const checkpoint = resumeAdaptiveCheckpoint(structuredClone(run.checkpoint), expected);
    checkpoint.runId = run.id;
    const updated = await update(pool, run.id, checkpoint, run.version);
    return { ...run, ...updated, checkpoint };
  }
  if (options.runId) throw new Error("--run-id is only valid with --resume");
  const checkpoint = createAdaptiveCheckpoint(expected);
  checkpoint.options = expected.options;
  const run = await create(pool, identity, checkpoint);
  checkpoint.runId = run.id;
  return { ...run, checkpoint };
}

export async function commitCheckpointMutation({ checkpoint, mutate, commit }) {
  const draft = structuredClone(checkpoint);
  await mutate(draft);
  await commit(draft);
  for (const key of Object.keys(checkpoint)) delete checkpoint[key];
  Object.assign(checkpoint, draft);
  return checkpoint;
}

export async function withAdaptiveOwnership({ acquireRuntime, acquireDatabase, work }) {
  const runtime = await acquireRuntime();
  let database;
  try {
    database = await acquireDatabase();
    return await work({ runtime, database });
  } finally {
    try {
      if (database) await database.release();
    } finally {
      await runtime.release();
    }
  }
}

function helpText() {
  return `Usage: node run-adaptive-export.mjs [options]

Runs Xiaowangshen once across the requested range and resumes only after a verified stall.

Options:
  --keyword TEXT          Required keyword
  --pages START-END       Page range (default: 1-40)
  --frequency MIN-MAX     Seconds between page requests (default: 30-45)
  --stall-seconds N       No-progress threshold (default: 300); no total runtime limit
  --channel all|taobao|tmall
  --sort relevance|sales|credit|price-low|price-high
  --price MIN-unlimited|MIN-MAX
  --export csv,xlsx,xlsx-images (default: csv,xlsx-images)
  --output-dir DIR        Actual Edge download directory
  --checkpoint FILE       Local PostgreSQL checkpoint projection
  --run-id UUID           Existing PostgreSQL adaptive run ID (required with --resume)
  --resume                Resume only from the explicitly named PostgreSQL run
  --proxy URL             web-access Proxy
  --allow-trial           Permit the visible Xiaowangshen free-trial action
`;
}

async function findFiles(root, name) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name === name) found.push(full);
    }
  }
  await visit(root);
  return found;
}

function runChild(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readLatestManifest(root) {
  const paths = await findFiles(root, "manifest.json");
  if (!paths.length) return { path: "", manifest: null };
  const manifestPath = paths.at(-1);
  return { path: manifestPath, manifest: JSON.parse(await readFile(manifestPath, "utf8")) };
}

async function copyManifestArtifacts(manifest, destination) {
  const artifacts = {};
  for (const [kind, artifact] of Object.entries(manifest?.artifacts || {})) {
    if (!artifact?.path) continue;
    const target = path.join(destination, path.basename(artifact.path));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(artifact.path, target);
    artifacts[kind] = target;
  }
  return artifacts;
}

async function listArtifactFiles(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    const details = await stat(file);
    files.push({ name: entry.name, path: file, size: details.size, mtimeMs: details.mtimeMs });
  }
  return files;
}

async function writeJsonAtomic(file, value, fsApi = { writeFile, rename, unlink }) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fsApi.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fsApi.rename(temporary, file);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
    await fsApi.unlink(file);
    await fsApi.rename(temporary, file);
  }
}

function runOutputValidation(csv, xlsx, requireImages) {
  const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const prefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];
  const args = [...prefix, VALIDATOR, "--csv", csv.path];
  if (xlsx) args.push("--xlsx", xlsx.path);
  if (requireImages) args.push("--require-images");
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      let result;
      try { result = JSON.parse(stdout.trim()); } catch { return reject(new Error(`output validator returned invalid JSON: ${String(stderr || stdout).slice(0, 500)}`)); }
      if (code !== 0 || result?.ok !== true) return reject(new Error(result?.error || "output validation failed"));
      resolve(result);
    });
  });
}

function baselineIdentity(file) {
  return `${file.name}:${Number(file.size)}:${Number(file.mtimeMs)}`;
}

function sameExportModes(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function intentKindMatchesExpected(kind, exportModes) {
  return kind === "csv"
    ? exportModes.includes("csv")
    : kind === "xlsx"
      && (exportModes.includes("xlsx") || exportModes.includes("xlsx-images"));
}

function intentMatchesExpected(intent, expected) {
  if (intent.parentRunId !== expected.runId
    || Number(intent.range?.start) !== expected.range.start
    || Number(intent.range?.end) !== expected.range.end
    || !sameExportModes(intent.options?.exportModes, expected.exportModes)
    || !intentKindMatchesExpected(intent.kind, expected.exportModes)) {
    return false;
  }
  if (expected.keyword && intent.keyword !== expected.keyword) return false;
  if (expected.outputDir && path.resolve(String(intent.outputDir || "")) !== path.resolve(expected.outputDir)) return false;
  const expectedOptions = expected.collectionOptions || {};
  for (const [key, value] of Object.entries(expectedOptions)) {
    if (JSON.stringify(intent.options?.[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function intentEvidenceIdentity(intent) {
  return {
    intentId: intent.intentId || "",
    kind: intent.kind,
    childRunId: intent.childRunId || "",
    parentRunId: intent.parentRunId || "",
    range: intent.range || {},
    outputDir: intent.outputDir || "",
  };
}

function errorText(error) {
  return String(error?.message || error).replace(/[\r\n]+/gu, " ").slice(0, 500);
}

async function describeCandidate(candidate, hashFile) {
  const evidence = {
    name: candidate.name,
    path: candidate.path,
    size: Number(candidate.size),
    mtimeMs: Number(candidate.mtimeMs),
    sha256: null,
  };
  try {
    evidence.sha256 = await hashFile(candidate.path);
  } catch (error) {
    evidence.hashError = errorText(error);
  }
  return evidence;
}

function appendSettlementEvent(intent, event, { status = intent.status, reason } = {}) {
  const previous = intent.settlementEvidence || {};
  const at = event.at || new Date().toISOString();
  const updated = {
    ...intent,
    status,
    ...(reason ? { reason } : {}),
    updatedAt: at,
    settlementEvidence: {
      version: 1,
      ...intentEvidenceIdentity(intent),
      requestedAt: intent.requestedAt || "",
      deadlineAt: intent.deadlineAt || "",
      ...previous,
      status,
      ...(reason ? { reason } : {}),
      rejections: [...(intent.rejections || previous.rejections || [])],
      events: [...(previous.events || []), event],
      updatedAt: at,
    },
  };
  return updated;
}

async function persistSettlementEvent(intentPath, intent, event, options = {}, fsApi) {
  const updated = appendSettlementEvent(intent, event, options);
  await writeJsonAtomic(intentPath, updated, fsApi);
  return updated;
}

async function recordIdentityMismatch(intentPath, intent, expected, now, fsApi) {
  const expectedIdentity = {
    runId: expected.runId,
    range: expected.range,
    exportModes: expected.exportModes,
    ...(expected.keyword ? { keyword: expected.keyword } : {}),
    ...(expected.outputDir ? { outputDir: path.resolve(expected.outputDir) } : {}),
  };
  const previous = intent.settlementEvidence?.events || [];
  const alreadyRecorded = previous.some((event) => event.type === "IDENTITY_IGNORED"
    && JSON.stringify(event.expected) === JSON.stringify(expectedIdentity));
  if (alreadyRecorded) return intent;
  return persistSettlementEvent(
    intentPath,
    intent,
    {
      type: "IDENTITY_IGNORED",
      reason: "identity_mismatch",
      expected: expectedIdentity,
      actual: intentEvidenceIdentity(intent),
      at: new Date(now()).toISOString(),
    },
    {},
    fsApi,
  );
}

async function describeRecordedArtifact(artifact, hashFile) {
  const evidence = { ...(artifact || {}) };
  if (!artifact?.path) return evidence;
  try {
    const details = await stat(artifact.path);
    evidence.size = details.size;
    evidence.mtimeMs = details.mtimeMs;
    evidence.sha256 = await hashFile(artifact.path);
  } catch (error) {
    evidence.integrityError = errorText(error);
  }
  return evidence;
}

async function rejectIntentGroup(group, {
  reason,
  eventType = "ARTIFACT_REJECTED",
  details = {},
} = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const fsApi = {
    writeFile: dependencies.writeFile || writeFile,
    rename: dependencies.rename || rename,
    unlink: dependencies.unlink || unlink,
  };
  const hashFile = dependencies.sha256File || sha256File;
  const artifacts = {};
  for (const record of group) {
    artifacts[record.intent.kind] = await describeRecordedArtifact(
      record.intent.artifacts?.[record.intent.kind],
      hashFile,
    );
  }
  const at = new Date(now()).toISOString();
  for (const record of group) {
    record.intent = await persistSettlementEvent(
      record.intentPath,
      record.intent,
      {
        type: eventType,
        reason,
        artifacts,
        ...details,
        at,
      },
      { status: "REJECTED", reason },
      fsApi,
    );
  }
  return group;
}

function rejectionPath(entry) {
  return entry.path || entry.candidate?.path;
}

export async function settleExportIntent(intentPath, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const wait = dependencies.sleep || sleep;
  const listFiles = dependencies.listFiles || listArtifactFiles;
  const statFile = dependencies.statFile || stat;
  const hashFile = dependencies.sha256File || sha256File;
  const fsApi = {
    writeFile: dependencies.writeFile || writeFile,
    rename: dependencies.rename || rename,
    unlink: dependencies.unlink || unlink,
  };
  const pollMs = dependencies.pollMs || 1_000;
  const stablePolls = dependencies.stablePolls || 2;
  let intent = JSON.parse(await readFile(intentPath, "utf8"));
  if (["ACCEPTED", "REJECTED", "EXPIRED"].includes(intent.status)) return intent;

  const at = () => new Date(now()).toISOString();
  const expire = (reason, details = {}) => persistSettlementEvent(
    intentPath,
    intent,
    { type: "SETTLEMENT_EXPIRED", reason, ...details, at: at() },
    { status: "EXPIRED", reason },
    fsApi,
  );

  const deadlineMs = Date.parse(intent.deadlineAt);
  if (!Number.isFinite(deadlineMs) || now() >= deadlineMs) {
    return expire("settlement_deadline_exceeded");
  }
  if (!["csv", "xlsx"].includes(intent.kind)
    || !Number.isInteger(Number(intent.expectedProgress?.rowCount))) {
    return expire("unsupported_or_missing_expected_progress");
  }
  if (intent.kind === "xlsx" && typeof dependencies.validate !== "function") {
    return expire("xlsx_validator_required");
  }

  const validate = dependencies.validate || ((csv) => runOutputValidation(csv, null, false));
  const baseline = new Set((intent.baseline || []).map(baselineIdentity));
  const rejectedPaths = new Set((intent.rejections || []).map(rejectionPath).filter(Boolean));
  const stability = new Map();
  let rejections = [...(intent.rejections || [])];
  while (now() < deadlineMs) {
    const extension = `.${intent.kind}`;
    const candidates = (await listFiles(intent.outputDir))
      .filter((file) => file.name.toLowerCase().endsWith(extension))
      .filter((file) => Number(file.mtimeMs) >= Date.parse(intent.requestedAt) - 2_000)
      .filter((file) => !baseline.has(baselineIdentity(file)))
      .filter((file) => !rejectedPaths.has(file.path));
    if (candidates.length > 1) {
      const candidateEvidence = await Promise.all(
        candidates.map((candidate) => describeCandidate(candidate, hashFile)),
      );
      return expire("ambiguous_candidates", { candidates: candidateEvidence });
    }
    const candidate = candidates[0];
    if (candidate?.size > 0) {
      const previous = stability.get(candidate.path);
      const stableCount = previous?.size === candidate.size ? previous.count + 1 : 1;
      stability.set(candidate.path, { size: candidate.size, count: stableCount });
      if (stableCount >= stablePolls) {
        const details = await statFile(candidate.path);
        if (details.isFile() && details.size === candidate.size) {
          const candidateEvidence = await describeCandidate(candidate, hashFile);
          let validation;
          let rejection;
          try {
            if (candidateEvidence.hashError) {
              throw new Error(`artifact hash failed: ${candidateEvidence.hashError}`);
            }
            validation = await validate(candidate);
            const actualRows = Number(validation?.validation?.rows);
            const expectedRows = Number(intent.expectedProgress.rowCount);
            if (actualRows !== expectedRows) {
              rejection = {
                candidate: candidateEvidence,
                reason: "row_count_mismatch",
                expectedRows,
                actualRows,
                validation,
                at: at(),
              };
            }
          } catch (error) {
            rejection = {
              candidate: candidateEvidence,
              reason: candidateEvidence.hashError ? "hash_failed" : "validation_failed",
              error: errorText(error),
              ...(validation ? { validation } : {}),
              at: at(),
            };
          }
          if (rejection) {
            rejections = [...rejections, rejection];
            rejectedPaths.add(candidate.path);
            intent = await persistSettlementEvent(
              intentPath,
              { ...intent, rejections },
              { type: "CANDIDATE_REJECTED", ...rejection },
              {},
              fsApi,
            );
          } else {
            const acceptedAt = at();
            return persistSettlementEvent(
              intentPath,
              {
                ...intent,
                status: "ACCEPTED",
                acceptedAt,
                artifacts: {
                  [intent.kind]: {
                    ...candidate,
                    size: details.size,
                    sha256: candidateEvidence.sha256,
                  },
                },
                validation,
                rejections,
              },
              {
                type: "CANDIDATE_ACCEPTED",
                candidate: candidateEvidence,
                validation,
                at: acceptedAt,
              },
              { status: "ACCEPTED" },
              fsApi,
            );
          }
        }
      }
    }
    await wait(pollMs);
  }
  return expire("settlement_deadline_exceeded", { rejections });
}

export async function recoverAttemptSettlement(attemptRoot, expected, dependencies = {}) {
  const intentPaths = await findFiles(attemptRoot, "export-intent-csv.json");
  intentPaths.push(...await findFiles(attemptRoot, "export-intent-xlsx.json"));
  if (!intentPaths.length) return null;

  const fsApi = {
    writeFile: dependencies.writeFile || writeFile,
    rename: dependencies.rename || rename,
    unlink: dependencies.unlink || unlink,
  };
  const records = [];
  const acceptedCsvByChild = new Map();
  intentPaths.sort((left, right) => Number(left.includes("xlsx")) - Number(right.includes("xlsx")));
  for (const intentPath of intentPaths) {
    let intent = JSON.parse(await readFile(intentPath, "utf8"));
    if (!intentMatchesExpected(intent, expected)) {
      await recordIdentityMismatch(intentPath, intent, expected, dependencies.now || Date.now, fsApi);
      continue;
    }
    if (intent.status === "OPEN" || intent.status === "OBSERVED") {
      const validate = intent.kind === "xlsx"
        ? async (candidate) => {
          const csv = acceptedCsvByChild.get(intent.childRunId);
          if (!csv) throw new Error("accepted CSV is required before settling XLSX");
          return runOutputValidation(
            csv.artifacts.csv,
            candidate,
            intent.options?.exportModes?.includes("xlsx-images") === true,
          );
        }
        : dependencies.validate;
      intent = await settleExportIntent(intentPath, { ...dependencies, ...(validate ? { validate } : {}) });
    }
    if (intent.status === "ACCEPTED") {
      const record = { intentPath, intent };
      records.push(record);
      if (intent.kind === "csv") acceptedCsvByChild.set(intent.childRunId, intent);
    }
  }
  if (!records.length) return null;

  const byChild = new Map();
  for (const record of records) {
    const group = byChild.get(record.intent.childRunId) || [];
    group.push(record);
    byChild.set(record.intent.childRunId, group);
  }
  const needsXlsx = expected.exportModes.includes("xlsx") || expected.exportModes.includes("xlsx-images");
  const completeGroups = [...byChild.values()].filter((group) => group.some((record) => record.intent.kind === "csv")
    && (!needsXlsx || group.some((record) => record.intent.kind === "xlsx")));
  if (!completeGroups.length) return null;
  if (completeGroups.length > 1) {
    for (const group of completeGroups) {
      await rejectIntentGroup(group, {
        reason: "ambiguous_accepted_groups",
        eventType: "GROUP_REJECTED",
        details: { childRunIds: completeGroups.map((candidate) => candidate[0].intent.childRunId) },
      }, dependencies);
    }
    return null;
  }

  const group = completeGroups[0];
  const csvRecord = group.find((record) => record.intent.kind === "csv");
  const xlsxRecord = group.find((record) => record.intent.kind === "xlsx");
  const csv = csvRecord.intent;
  const xlsx = xlsxRecord?.intent;
  const rows = Number(csv.validation?.validation?.rows);
  if (!Number.isInteger(rows)
    || rows !== Number(csv.expectedProgress?.rowCount)
    || (xlsx && Number(xlsx.validation?.validation?.rows) !== rows)) {
    await rejectIntentGroup(group, {
      reason: "recorded_row_count_mismatch",
      details: {
        expectedRows: Number(csv.expectedProgress?.rowCount),
        csvRows: rows,
        xlsxRows: xlsx ? Number(xlsx.validation?.validation?.rows) : null,
      },
    }, dependencies);
    return null;
  }

  const artifacts = {
    csv: csv.artifacts.csv,
    ...(xlsx ? { xlsx: xlsx.artifacts.xlsx } : {}),
  };
  try {
    await verifyArtifactSet({
      artifacts,
      exportModes: expected.exportModes,
      expectedArtifacts: (xlsx?.validation || csv.validation).artifacts,
      metadata: { recovery: true },
    });
  } catch (error) {
    await rejectIntentGroup(group, {
      reason: "artifact_integrity_failed",
      details: { error: errorText(error) },
    }, dependencies);
    return null;
  }

  let validation;
  try {
    const validate = dependencies.validate || ((csvFile, xlsxFile) => runOutputValidation(
      csvFile,
      xlsxFile,
      expected.exportModes.includes("xlsx-images"),
    ));
    validation = await validate(artifacts.csv, artifacts.xlsx);
    if (validation?.ok !== true || Number(validation.validation?.rows) !== rows) {
      throw new Error("recovered artifacts failed validator row-count confirmation");
    }
  } catch (error) {
    await rejectIntentGroup(group, {
      reason: "revalidation_failed",
      details: { error: errorText(error) },
    }, dependencies);
    return null;
  }

  return {
    source: "settlement",
    sourceId: csv.childRunId,
    sourceAt: csv.acceptedAt || csv.requestedAt,
    manifestPath: "",
    status: "STALLED",
    progress: csv.expectedProgress,
    diagnostics: {
      settlement: group.map((record) => ({
        intentId: record.intent.intentId,
        kind: record.intent.kind,
        status: record.intent.status,
      })),
    },
    artifacts,
    validation,
  };
}

function childStatus(code, event) {
  if (code === 0 && event?.status === "DONE") return "DONE";
  if (code === 2 || event?.status === "HUMAN_REQUIRED") return "HUMAN_REQUIRED";
  if (code === 3 || event?.status === "STALLED") return "STALLED";
  return "FAILED";
}

export function canAdvanceAttempt(status, snapshot, range) {
  if (status === "DONE") return true;
  return status === "STALLED"
    && Boolean(snapshot?.artifacts?.csv)
    && snapshot?.validation?.ok === true
    && Number(snapshot?.validation?.validation?.rows) >= 1
    && Number(snapshot?.progress?.completedEnd) >= range.start;
}

function childExitCode(status) {
  return status === "HUMAN_REQUIRED" ? 2 : status === "STALLED" ? 3 : 1;
}

async function runMerger(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MERGER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function verifyRecordedArtifacts(records, owner) {
  if (!Array.isArray(records) || !records.length) {
    throw new Error(`${owner} has no verified artifact records`);
  }
  for (const artifact of records) {
    const details = await stat(artifact.path);
    if (details.size !== Number(artifact.sizeBytes) || await sha256File(artifact.path) !== artifact.sha256) {
      throw new Error(`artifact changed after verification: ${artifact.path}`);
    }
  }
}

async function verifyRecordedParts(parts) {
  for (const part of parts) await verifyRecordedArtifacts(part.artifactRecords, `part ${part.id}`);
}

async function mergeCompletedParts(checkpoint, stateRoot, options) {
  const parts = Object.values(checkpoint.parts || {})
    .filter((part) => ["DONE", "STALLED"].includes(part.status) && part.artifacts?.csv)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!parts.length) throw new Error("no validated CSV parts are available for final merge");
  await verifyRecordedParts(parts);
  let cursor = options.pages.start;
  for (const part of parts) {
    if (part.start > cursor || part.completedEnd < cursor) {
      throw new Error(`validated parts contain a page gap before ${cursor}`);
    }
    cursor = Math.max(cursor, part.completedEnd + 1);
    if (cursor > options.pages.end) break;
  }
  if (cursor <= options.pages.end) throw new Error(`validated parts stop at page ${cursor - 1}, expected ${options.pages.end}`);
  const needsXlsx = options.exportModes.includes("xlsx") || options.exportModes.includes("xlsx-images");
  if (needsXlsx && parts.some((part) => !part.artifacts?.xlsx)) {
    throw new Error("a completed part is missing its XLSX artifact");
  }
  const finalDir = path.join(stateRoot, "final");
  await mkdir(finalDir, { recursive: true });
  const safeKeyword = options.keyword.replace(/[^\w\u4e00-\u9fff]+/gu, "-");
  const outputCsv = path.join(finalDir, `${safeKeyword}-adaptive-merged.csv`);
  const outputXlsx = path.join(finalDir, `${safeKeyword}-adaptive-merged.xlsx`);
  const args = ["--output-csv", outputCsv];
  for (const part of parts) args.push("--csv", part.artifacts.csv);
  if (needsXlsx) {
    for (const part of parts) args.push("--xlsx", part.artifacts.xlsx);
    args.push("--output-xlsx", outputXlsx);
    if (options.exportModes.includes("xlsx-images")) args.push("--require-images");
  }
  const result = await runMerger(args);
  if (result.code !== 0) throw new Error(`final merge failed: ${result.stderr || result.stdout}`.trim());
  const merged = lastJsonLine(result.stdout);
  if (!merged.ok) throw new Error(merged.error || "final merge failed");
  return {
    ...merged,
    parts: parts.map((part) => part.id),
    ...snapshotMetadata(parts),
  };
}

async function persistCheckpoint(pool, run, checkpointPath) {
  const updated = await updateAdaptiveCheckpoint(pool, run.id, run.checkpoint, run.version);
  run.version = updated.version;
  await writeAdaptiveCheckpoint(checkpointPath, run.checkpoint);
}

async function executeAdaptiveRun({ pool, run, checkpointPath, stateRoot, options }) {
  const checkpoint = run.checkpoint;
  while (true) {
    const range = nextAdaptiveRange(checkpoint);
    await persistCheckpoint(pool, run, checkpointPath);
    if (!range) {
      if (checkpoint.status === "DONE" && !checkpoint.final) {
        const final = await mergeCompletedParts(checkpoint, stateRoot, options);
        const finalArtifacts = {
          csv: final.csv,
          ...(final.xlsx?.path ? { xlsx: final.xlsx.path } : {}),
        };
        const finalRecords = await verifyArtifactSet({
          artifacts: finalArtifacts,
          exportModes: options.exportModes,
          metadata: { final: true, ...snapshotMetadata(Object.values(checkpoint.parts || {})) },
        });
        await commitCheckpointMutation({
          checkpoint,
          mutate: (draft) => { draft.final = { ...final, artifactRecords: finalRecords }; },
          commit: async (draft) => {
            const updated = await commitAdaptivePart(pool, run.id, {
              partId: "final",
              startPage: options.pages.start,
              endPage: options.pages.end,
              completedEnd: draft.completedEnd,
              status: "DONE",
              metadata: final,
              artifacts: finalRecords,
              checkpoint: draft,
              expectedVersion: run.version,
            });
            run.version = updated.version;
          },
        });
        await writeAdaptiveCheckpoint(checkpointPath, checkpoint);
        console.log(JSON.stringify({ event: "ADAPTIVE_DONE", runId: run.id, checkpoint: checkpointPath, final: checkpoint.final }));
        return 0;
      }
      if (checkpoint.status === "DONE" && checkpoint.final) {
        await verifyRecordedArtifacts(checkpoint.final.artifactRecords, "final");
        console.log(JSON.stringify({ event: "ADAPTIVE_DONE", runId: run.id, checkpoint: checkpointPath, final: checkpoint.final, reused: true }));
        return 0;
      }
      const status = checkpoint.status || "STALLED";
      console.error(JSON.stringify({ status, runId: run.id, checkpoint: checkpointPath, completedEnd: checkpoint.completedEnd }));
      return childExitCode(status);
    }

    let result = { code: 3, stdout: "", stderr: "" };
    const recoveryExpected = {
      runId: run.id,
      range,
      exportModes: options.exportModes,
      keyword: options.keyword,
      outputDir: path.resolve(options.outputDir || path.join(os.homedir(), "Downloads")),
      collectionOptions: {
        channel: options.channel,
        sort: options.sort,
        price: options.price,
        frequency: options.frequency,
        stallSeconds: options.stallSeconds,
        allowTrial: options.allowTrial,
      },
    };
    let snapshot = await recoverAttemptSettlement(stateRoot, recoveryExpected);
    let status = snapshot ? "STALLED" : "";
    if (snapshot) {
      console.log(JSON.stringify({ event: "ADAPTIVE_SETTLEMENT_RECOVERED", runId: run.id, start: range.start, end: range.end, sourceId: snapshot.sourceId }));
    } else {
      const attemptRoot = path.join(stateRoot, `attempt-${Date.now()}-${range.start}-${range.end}`);
      await mkdir(attemptRoot, { recursive: true });
      console.log(JSON.stringify({ event: "ADAPTIVE_RUN_STARTED", runId: run.id, start: range.start, end: range.end }));
      const args = [
        "--keyword", options.keyword,
        "--pages", `${range.start}-${range.end}`,
        "--frequency", `${options.frequency.min}-${options.frequency.max}`,
        "--channel", options.channel,
        "--sort", options.sort,
        "--price", `${options.price.min}-${options.price.max === null ? "unlimited" : options.price.max}`,
        "--export", options.exportModes.join(","),
        "--stall-seconds", String(options.stallSeconds),
        "--proxy", options.proxy,
        "--export-partial-on-stall",
      ];
      if (options.outputDir) args.push("--output-dir", options.outputDir);
      if (options.allowTrial) args.push("--allow-trial");
      result = await runChild(args, {
        ...process.env,
        XWS_RUNTIME_DIR: attemptRoot,
        XWS_ADAPTIVE_LOCK_OWNER: "1",
        XWS_ADAPTIVE_RUN_ID: run.id,
        XWS_ADAPTIVE_RANGE_START: String(range.start),
        XWS_ADAPTIVE_RANGE_END: String(range.end),
      });
      const event = lastJsonLine(result.stderr) ?? lastJsonLine(result.stdout);
      const located = await readLatestManifest(attemptRoot);
      snapshot = chooseAttemptSnapshot(located, event);
      if (!Object.keys(snapshot.artifacts).length) {
        snapshot = await recoverAttemptSettlement(attemptRoot, recoveryExpected) || snapshot;
      }
      status = childStatus(result.code, snapshot);
    }
    const copied = Object.keys(snapshot.artifacts).length
      ? await copyManifestArtifacts({ artifacts: snapshot.artifacts }, path.join(stateRoot, "parts", `${range.start}-${range.end}`))
      : {};
    const canAdvance = canAdvanceAttempt(status, snapshot, range);
    let artifactRecords = [];
    let verifiedProgress = snapshot.progress;
    if (canAdvance) {
      verifiedProgress = validateProgressSnapshot({ ...snapshot, status }, range);
      artifactRecords = await verifyArtifactSet({
        artifacts: copied,
        exportModes: options.exportModes,
        expectedArtifacts: snapshot.validation.artifacts,
        metadata: {
          source: snapshot.source,
          sourceId: snapshot.sourceId,
          sourceAt: snapshot.sourceAt || new Date().toISOString(),
          start: range.start,
          completedEnd: verifiedProgress.completedEnd,
          validation: snapshot.validation,
        },
      });
    }
    const hasPartialRows = status === "STALLED" && canAdvance;
    const safeProgress = canAdvance ? verifiedProgress : { ...snapshot.progress, completedEnd: range.start - 1 };
    const sourceAt = snapshot.sourceAt || new Date().toISOString();
    const partId = `${range.start}-${range.end}`;
    await commitCheckpointMutation({
      checkpoint,
      mutate: (draft) => applyAdaptiveRun(draft, {
        start: range.start,
        end: range.end,
        status,
        progress: safeProgress,
        artifacts: copied,
        artifactRecords,
        manifest: snapshot.manifestPath,
        validation: snapshot.validation,
        diagnostics: snapshot.diagnostics,
        sourceId: snapshot.sourceId,
        sourceAt,
        error: snapshot.error || (status === "FAILED" ? result.stderr : ""),
        at: sourceAt,
      }),
      commit: async (draft) => {
        const updated = await commitAdaptivePart(pool, run.id, {
          partId,
          startPage: range.start,
          endPage: range.end,
          completedEnd: draft.completedEnd,
          status: draft.status,
          metadata: draft.parts[partId],
          artifacts: artifactRecords,
          checkpoint: draft,
          expectedVersion: run.version,
        });
        run.version = updated.version;
      },
    });
    await writeAdaptiveCheckpoint(checkpointPath, checkpoint);

    if (status === "STALLED" && !hasPartialRows) {
      console.error(JSON.stringify({ status, error: "stalled run has no validated partial CSV; refusing to advance the resume cursor", runId: run.id, checkpoint: checkpointPath }));
      return 3;
    }
    if (status === "HUMAN_REQUIRED" || status === "FAILED") {
      console.error(JSON.stringify({ status, runId: run.id, checkpoint: checkpointPath, completedEnd: checkpoint.completedEnd }));
      return childExitCode(status);
    }
    if (status === "STALLED") {
      console.log(JSON.stringify({ event: "ADAPTIVE_RESUME", runId: run.id, completedEnd: checkpoint.completedEnd, nextStart: checkpoint.completedEnd + 1 }));
    }
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(helpText());
    return 0;
  }
  const options = parseAdaptiveOptions(process.argv.slice(2));
  if (!options.exportModes.includes("csv")) throw new Error("adaptive export requires CSV for checkpoint and merge recovery");
  if (options.resume && !options.runId) throw new Error("--resume requires --run-id");
  const checkpointPath = path.resolve(options.checkpoint);
  const checkpointDir = path.dirname(checkpointPath);
  const identity = buildAdaptiveIdentity(options);
  const expected = {
    keyword: options.keyword,
    pages: options.pages,
    frequency: options.frequency,
    options: checkpointOptions({
      channel: options.channel,
      sort: options.sort,
      price: options.price,
      exportModes: options.exportModes,
      outputDir: identity.outputDir,
      allowTrial: options.allowTrial,
      stallSeconds: options.stallSeconds,
    }),
  };
  const pool = createStatePool(requireDatabaseUrl());
  try {
    await ensureStateSchema(pool);
    return await withAdaptiveOwnership({
      acquireRuntime: () => acquireMarketAnalysisLock(),
      acquireDatabase: () => acquireAdaptiveLock(pool, identity),
      work: async () => {
        const run = await openAuthoritativeRun({ pool, options, identity, expected });
        const stateRoot = path.join(checkpointDir, `${run.id}-runs`);
        await mkdir(stateRoot, { recursive: true });
        try {
          return await executeAdaptiveRun({ pool, run, checkpointPath, stateRoot, options });
        } catch (error) {
          if (error?.code === "ADAPTIVE_VERSION_CONFLICT") throw error;
          run.checkpoint.status = "FAILED";
          run.checkpoint.error = String(error?.message || error);
          await persistCheckpoint(pool, run, checkpointPath);
          throw error;
        }
      },
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(JSON.stringify({ status: "FAILED", error: error.message }));
    process.exitCode = 1;
  }
}
