#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkpointOptions,
  createAdaptiveCheckpoint,
  parseAdaptiveOptions,
} from "./adaptive.mjs";
import {
  acquireAdaptiveLock,
  createAdaptiveRun,
  createStatePool,
  ensureStateSchema,
  getAdaptiveRun,
} from "./postgres-state.mjs";
import { detectRiskMarkers, parseProgressText } from "./flow.mjs";
import { buildAdaptiveIdentity } from "./run-adaptive-export.mjs";
import { acquireMarketAnalysisLock } from "./runtime-lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, "run-adaptive-export.mjs");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const RECOVERABLE_FAILURES = new Set(["export_action_failed", "result_ownership_unavailable"]);
const RECOVERABLE_FAILED_ERRORS = new Set([
  "Xiaowangshen radio did not settle: _sale",
  "Could not select Xiaowangshen radio: radio label missing",
  "Timed out waiting for Xiaowangshen filters to settle",
  "Xiaowangshen configuration did not match the requested contract",
]);
const RECOVERABLE_FAILED_ERROR_PREFIXES = [
  "Xiaowangshen configuration did not match the requested contract:",
];
const NO_PROGRESS_STALL = "Xiaowangshen made no page progress before the stall threshold";

function isRecoverableFailedError(error) {
  const message = String(error || "");
  return RECOVERABLE_FAILED_ERRORS.has(message)
    || RECOVERABLE_FAILED_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function identityOf(run) {
  if (!run?.identity || typeof run.identity !== "object") throw new Error("adaptive run identity is missing");
  return run.identity;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function formatPages(identity) {
  return `${requiredText(identity.pagesStart, "identity.pagesStart")}-${requiredText(identity.pagesEnd, "identity.pagesEnd")}`;
}

function formatFrequency(identity) {
  if (identity.frequency && typeof identity.frequency === "object") {
    return `${requiredText(identity.frequency.min, "identity.frequency.min")}-${requiredText(identity.frequency.max, "identity.frequency.max")}`;
  }
  return requiredText(identity.frequency, "identity.frequency");
}

function formatPrice(identity) {
  if (identity.price && typeof identity.price === "object") {
    return `${requiredText(identity.price.min, "identity.price.min")}-${identity.price.max === null ? "unlimited" : requiredText(identity.price.max, "identity.price.max")}`;
  }
  return requiredText(identity.price, "identity.price");
}

function checkpointRuntime(run) {
  return run?.checkpoint?.runtime && typeof run.checkpoint.runtime === "object"
    ? run.checkpoint.runtime
    : {};
}

function freshRunSpec(runnerArgs, { checkpoint, proxy, env = process.env } = {}) {
  const forwarded = [...(runnerArgs || [])];
  if (checkpoint) forwarded.push("--checkpoint", checkpoint);
  if (proxy) forwarded.push("--proxy", proxy);
  const options = parseAdaptiveOptions(forwarded, env);
  if (!options.exportModes.includes("csv")) {
    throw new Error("adaptive export requires CSV for checkpoint and merge recovery");
  }
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
  const projection = createAdaptiveCheckpoint(expected);
  projection.options = expected.options;
  return {
    identity,
    checkpoint: projection,
    checkpointPath: path.resolve(options.checkpoint),
    proxy: options.proxy,
  };
}

export function buildAdaptiveResumeArgs(run, { checkpoint, proxy, adoptLiveResult = false } = {}) {
  const identity = identityOf(run);
  if (identity.allowTrial) throw new Error("adaptive supervisor refuses trial-enabled runs");
  const runtime = checkpointRuntime(run);
  const checkpointPath = requiredText(checkpoint || runtime.checkpointPath, "checkpoint");
  const resumeProxy = proxy || runtime.proxy;
  const args = [
    "--keyword", requiredText(identity.keyword, "identity.keyword"),
    "--pages", formatPages(identity),
    "--frequency", formatFrequency(identity),
    "--channel", requiredText(identity.channel, "identity.channel"),
    "--sort", requiredText(identity.sort, "identity.sort"),
    "--price", formatPrice(identity),
    "--export", [...(identity.exportModes || [])].sort().join(","),
    "--stall-seconds", requiredText(identity.stallSeconds, "identity.stallSeconds"),
  ];
  if (resumeProxy) args.push("--proxy", String(resumeProxy));
  args.push(
    "--output-dir", requiredText(identity.outputDir, "identity.outputDir"),
    "--checkpoint", checkpointPath,
    "--resume",
    "--run-id", requiredText(run.id, "run.id"),
  );
  if (adoptLiveResult) args.push("--adopt-live-result");
  return args;
}

function partRange(part) {
  const start = Number(part?.start);
  const end = Number(part?.end);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) return null;
  return { start, end };
}

function attemptRecorded(checkpoint, range) {
  const attempt = Number(checkpoint?.attempts?.[`${range.start}-${range.end}`]);
  return Number.isInteger(attempt) && attempt >= 1;
}

function hasVerifiedArtifact(part) {
  const range = partRange(part);
  const completedEnd = Number(part?.completedEnd);
  const csv = part?.artifacts?.csv;
  const expected = part?.validation?.artifacts?.csv;
  const record = part?.artifactRecords?.find((artifact) => artifact.kind === "csv");
  return Boolean(range)
    && ["DONE", "STALLED"].includes(part?.status)
    && Number.isInteger(completedEnd)
    && completedEnd >= range.start
    && Boolean(csv)
    && part.validation?.ok === true
    && Number(part.validation?.validation?.rows) >= 1
    && Boolean(expected?.sha256)
    && Number(expected?.size_bytes) >= 1
    && record?.path === csv
    && String(record.sha256).toLowerCase() === String(expected.sha256).toLowerCase()
    && Number(record.sizeBytes) === Number(expected.size_bytes);
}

function hasVerifiedPartial(part) {
  return part?.status === "STALLED" && hasVerifiedArtifact(part);
}

function verifiedPrefix(run) {
  const pagesStart = Number(run?.identity?.pagesStart);
  const pagesEnd = Number(run?.identity?.pagesEnd);
  if (!Number.isInteger(pagesStart) || pagesStart < 1 || !Number.isInteger(pagesEnd) || pagesEnd < pagesStart) return null;
  let cursor = pagesStart;
  const parts = [];
  const ordered = Object.values(run.checkpoint?.parts || {})
    .filter((part) => partRange(part))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const part of ordered) {
    const range = partRange(part);
    if (!hasVerifiedArtifact(part) || range.end < cursor || range.start > cursor) continue;
    if (Number(part.completedEnd) < cursor) break;
    parts.push(part);
    cursor = Math.min(range.end, Number(part.completedEnd)) + 1;
    if (cursor > pagesEnd) break;
  }
  return { pages: { start: pagesStart, end: pagesEnd }, completedEnd: Math.min(pagesEnd, cursor - 1), parts };
}

function hasRunningEvidence(run) {
  const prefix = verifiedPrefix(run);
  if (!prefix) return false;
  const current = { start: prefix.completedEnd + 1, end: prefix.pages.end };
  if (current.start <= current.end && attemptRecorded(run.checkpoint, current)) return true;
  const lastVerified = prefix.parts.at(-1);
  return Boolean(lastVerified && attemptRecorded(run.checkpoint, partRange(lastVerified)));
}

function hasRecoverableStall(run) {
  const prefix = verifiedPrefix(run);
  if (!prefix) return false;
  const currentStart = prefix.completedEnd + 1;
  return Object.entries(run.checkpoint?.parts || {}).some(([id, part]) => {
    const range = partRange(part);
    if (!range) return false;
    if (hasVerifiedPartial(part)) {
      return prefix.parts.includes(part) && attemptRecorded(run.checkpoint, range);
    }
    const reason = part?.exportFailure?.reason || run.checkpoint?.exportFailure?.reason;
    const noProgressStall = part?.error === NO_PROGRESS_STALL;
    return part?.status === "STALLED"
      && range.start === currentStart
      && range.end === prefix.pages.end
      && (RECOVERABLE_FAILURES.has(reason) || noProgressStall)
      && !part?.artifacts?.csv
      && attemptRecorded(run.checkpoint, range)
      && id === `${range.start}-${range.end}`;
  });
}

function hasRecoverableFailedPart(run) {
  const prefix = verifiedPrefix(run);
  if (!prefix) return false;
  const currentStart = prefix.completedEnd + 1;
  return Object.entries(run.checkpoint?.parts || {}).some(([id, part]) => {
    const range = partRange(part);
    return part?.status === "FAILED"
      && range?.start === currentStart
      && range?.end === prefix.pages.end
      && isRecoverableFailedError(part.error)
      && !part.artifacts?.csv
      && attemptRecorded(run.checkpoint, range)
      && id === `${range.start}-${range.end}`;
  });
}

function hasRetryBudget(run) {
  const maxAttempts = Number(run?.checkpoint?.retryBudget?.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return true;
  const prefix = verifiedPrefix(run);
  if (!prefix) return false;
  const current = { start: prefix.completedEnd + 1, end: prefix.pages.end };
  const attempt = Number(run.checkpoint?.attempts?.[`${current.start}-${current.end}`]);
  return !Number.isInteger(attempt) || attempt < maxAttempts;
}

export function shouldResumeAdaptiveRun(run) {
  if (!run?.checkpoint || !hasRetryBudget(run)) return false;
  if (run.status === "RUNNING") return hasRunningEvidence(run);
  if (run.status === "STALLED") return hasRecoverableStall(run);
  if (run.status === "FAILED") return hasRecoverableFailedPart(run);
  return false;
}

function spawnAdaptiveRunner(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function proxyRequest(proxy, endpoint, options = {}) {
  const response = await fetch(`${proxy}${endpoint}`, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Proxy returned invalid JSON for ${endpoint}`);
  }
  if (!response.ok || data?.error) {
    throw new Error(`Proxy ${endpoint} failed`);
  }
  return data;
}

async function listTargets(proxy) {
  const data = await proxyRequest(proxy, "/targets");
  return Array.isArray(data) ? data : (Array.isArray(data?.value) ? data.value : []);
}

async function evaluate(proxy, targetId, expression) {
  const data = await proxyRequest(proxy, `/eval?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: expression,
  });
  return data?.value;
}

function searchTarget(target, keyword) {
  if (target?.type !== "page" || !target.targetId) return false;
  try {
    const url = new URL(target.url);
    return url.origin === "https://s.taobao.com"
      && url.pathname === "/search"
      && url.searchParams.get("q") === keyword;
  } catch {
    return false;
  }
}

export async function inspectBrowserAttempt({ proxy, identity, now = () => Date.now() }) {
  if (!proxy) return { action: "NONE" };
  const targets = (await listTargets(proxy)).filter((target) => searchTarget(target, identity.keyword));
  const candidates = [];
  for (const target of targets) {
    const snapshot = await evaluate(proxy, target.targetId, `(() => {
      const diagnostics = window.__xwsCollectionDiag;
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const wrappers = [...document.querySelectorAll(".el-dialog__wrapper")].filter(visible);
      const text = wrappers.map((element) => element.innerText || "").join("\\n");
      const progress = (${parseProgressText.toString()})(text);
      const diagnosticSnapshot = diagnostics?.snapshot?.() || {};
      const activeAttempt = String(diagnosticSnapshot.activeAttempt || "");
      const requests = Array.isArray(diagnosticSnapshot.requests) ? diagnosticSnapshot.requests : [];
      const requestEvidence = requests.some((request) => (
        request.attemptMarker === activeAttempt
        && request.apiKey === "request"
        && /^XWS_PAGE_REQUEST_[0-9]+$/u.test(String(request.flag || ""))
        && (request.pending === true
          || (Number.isInteger(request.status)
            && request.status >= 200
            && request.status < 300))
      ));
      const activity = diagnosticSnapshot.activity || null;
      return {
        range: diagnostics?.range || null,
        visibleText: text.slice(0, 500),
        activeAttempt,
        trackerOwned: Boolean(activeAttempt && diagnostics?.isOwnedAttempt?.(activeAttempt) === true),
        requestEvidence,
        activity,
        progress,
        complete: progress.complete === true,
        visibility: document.visibilityState,
      };
    })()`);
    const riskMarkers = detectRiskMarkers(snapshot?.visibleText);
    if (riskMarkers.length) {
      return {
        action: "HUMAN_REQUIRED",
        reason: riskMarkers[0],
        targetId: target.targetId,
        visibleText: snapshot.visibleText,
      };
    }
    if (!snapshot?.activeAttempt) continue;
    if (snapshot.range?.start !== Number(identity.pagesStart)
      || snapshot.range?.end !== Number(identity.pagesEnd)) continue;
    const lastActivityAt = typeof snapshot.activity?.lastActivityAt === "number"
      ? snapshot.activity.lastActivityAt
      : Date.parse(String(snapshot.activity?.lastActivityAt || ""));
    const activityFresh = Number.isFinite(lastActivityAt)
      && now() - lastActivityAt <= Number(identity.stallSeconds) * 1000;
    candidates.push({ targetId: target.targetId, ...snapshot, activityFresh });
  }
  if (candidates.length !== 1) {
    return candidates.length > 1
      ? { action: "AMBIGUOUS_BROWSER_ATTEMPT", count: candidates.length }
      : { action: "NONE" };
  }
  const candidate = candidates[0];
  if (!candidate.requestEvidence || !candidate.activityFresh) {
    return {
      action: "STALE_BROWSER_ATTEMPT",
      reason: candidate.requestEvidence ? "activity_stale" : "request_evidence_missing",
      ...candidate,
    };
  }
  if (candidate.complete && candidate.trackerOwned && candidate.progress.rowCount >= 1) {
    return { action: "ADOPT_LIVE_RESULT", ...candidate };
  }
  return { action: "WAITING_FOR_BROWSER", ...candidate };
}

function busyResult(runId) {
  return { action: "BUSY", runId };
}

export async function superviseAdaptiveRunOnce({
  pool,
  runId,
  create = false,
  runnerArgs = [],
  checkpoint,
  proxy,
  state = {},
  spawnRunner = spawnAdaptiveRunner,
  env = process.env,
}) {
  const get = state.getAdaptiveRun || getAdaptiveRun;
  const createRun = state.createAdaptiveRun || createAdaptiveRun;
  const inspect = state.inspectBrowserAttempt || inspectBrowserAttempt;
  const acquireRuntime = state.acquireRuntime || (() => acquireMarketAnalysisLock(env));
  const acquireDatabase = state.acquireAdaptiveLock || acquireAdaptiveLock;
  const id = create ? "" : requiredText(runId, "runId");
  const initial = create ? null : await get(pool, id);
  if (!create && !initial) return { action: "NOT_FOUND", runId: id };
  if (!create && !shouldResumeAdaptiveRun(initial)) {
    const maxAttempts = Number(initial.checkpoint?.retryBudget?.maxAttempts);
    const prefix = verifiedPrefix(initial);
    const range = prefix && { start: prefix.completedEnd + 1, end: prefix.pages.end };
    const attempt = range && Number(initial.checkpoint?.attempts?.[`${range.start}-${range.end}`]);
    if (Number.isInteger(maxAttempts) && maxAttempts >= 1 && attempt >= maxAttempts) {
      return { action: "STOPPED", runId: id, status: "FAILED", retryExhausted: true };
    }
    return { action: "SKIPPED", runId: id, status: initial.status };
  }

  const spec = create ? freshRunSpec(runnerArgs, { checkpoint, proxy, env }) : null;
  if (create && !spec?.identity) throw new Error("fresh supervisor spec identity is missing");
  let runtime;
  let database;
  try {
    runtime = await acquireRuntime();
    try {
      database = await acquireDatabase(pool, create ? spec.identity : identityOf(initial));
    } catch (error) {
      if (error?.code === "BUSY") return busyResult(id || null);
      throw error;
    }
    if (create) {
      const existing = await inspect({
        proxy: proxy || spec.proxy,
        identity: spec.identity,
      });
      if (existing.action !== "NONE") {
        return {
          action: "STOPPED",
          runId: null,
          status: "HUMAN_REQUIRED",
          error: existing.reason === "LOGIN_REQUIRED"
            ? "browser requires Xiaowangshen login before starting the adaptive collection"
            : "an existing browser attempt matches the new adaptive contract",
          ...(existing.reason ? { reason: existing.reason } : {}),
          ...(existing.targetId ? { targetId: existing.targetId } : {}),
          ...(existing.activeAttempt ? { activeAttempt: existing.activeAttempt } : {}),
          ...(existing.count ? { candidates: existing.count } : {}),
          ...(existing.visibleText ? { visibleText: existing.visibleText } : {}),
        };
      }
    }
    let current;
    if (create) {
      current = {
        ...await createRun(pool, spec.identity, spec.checkpoint),
        identity: spec.identity,
      };
    } else {
      current = await get(pool, id);
      if (!current) return { action: "NOT_FOUND", runId: id };
      if (!shouldResumeAdaptiveRun(current)) {
        return { action: "SKIPPED", runId: id, status: current.status };
      }
    }
    const currentId = current.id;
    const browser = create ? { action: "NONE" } : await inspect({
      proxy: proxy || checkpointRuntime(current).proxy,
      identity: identityOf(current),
    });
    if (browser.action === "WAITING_FOR_BROWSER") {
      return { ...browser, runId: currentId };
    }
    if (browser.action === "HUMAN_REQUIRED") {
      return {
        action: "STOPPED",
        runId: currentId,
        status: "HUMAN_REQUIRED",
        error: `browser requires human intervention: ${browser.reason}`,
        ...(browser.targetId ? { targetId: browser.targetId } : {}),
        ...(browser.visibleText ? { visibleText: browser.visibleText } : {}),
      };
    }
    if (browser.action === "STALE_BROWSER_ATTEMPT"
      || browser.action === "AMBIGUOUS_BROWSER_ATTEMPT") {
      return {
        action: "STOPPED",
        runId: currentId,
        status: "HUMAN_REQUIRED",
        error: browser.action === "AMBIGUOUS_BROWSER_ATTEMPT"
          ? "multiple active browser attempts match the adaptive contract"
          : `browser attempt cannot be safely resumed: ${browser.reason}`,
        ...(browser.targetId ? { targetId: browser.targetId } : {}),
        ...(browser.activeAttempt ? { activeAttempt: browser.activeAttempt } : {}),
        ...(browser.count ? { candidates: browser.count } : {}),
      };
    }
    const args = buildAdaptiveResumeArgs(current, {
      checkpoint: checkpoint || spec?.checkpointPath,
      proxy: proxy || spec?.proxy,
      adoptLiveResult: !create && browser.action === "ADOPT_LIVE_RESULT",
    });
    const child = await spawnRunner(args, {
      ...env,
      XWS_ADAPTIVE_SUPERVISOR_OWNER: "1",
      XWS_ADAPTIVE_SUPERVISOR_RUN_ID: currentId,
    });
    return { action: "SPAWNED", runId: currentId, ...child };
  } finally {
    if (database) await database.release();
    if (runtime) await runtime.release();
  }
}

export async function superviseAdaptiveRun({
  pool,
  runId,
  create = false,
  runnerArgs = [],
  checkpoint,
  proxy,
  state = {},
  spawnRunner = spawnAdaptiveRunner,
  env = process.env,
  sleep: wait = sleep,
  pollMs = 5_000,
  onResult = async () => {},
}) {
  const get = state.getAdaptiveRun || getAdaptiveRun;
  let currentRunId = runId || "";
  let creating = create;
  while (true) {
    const result = await superviseAdaptiveRunOnce({
      pool,
      runId: currentRunId,
      create: creating,
      runnerArgs,
      checkpoint,
      proxy,
      state,
      spawnRunner,
      env,
    });
    if (result.runId) {
      currentRunId = result.runId;
      creating = false;
    }
    await onResult(result);
    if (result.action === "WAITING_FOR_BROWSER") {
      await wait(Math.max(0, Number(pollMs) || 0));
      continue;
    }
    if (result.action !== "SPAWNED") return result;

    const current = await get(pool, currentRunId);
    if (!current) return { action: "NOT_FOUND", runId: currentRunId };
    if (current.status === "DONE") {
      return { action: "COMPLETED", runId: currentRunId, status: current.status, code: result.code };
    }
    if (!shouldResumeAdaptiveRun(current)) {
      return { action: "STOPPED", runId: currentRunId, status: current.status, code: result.code };
    }
    await wait(Math.max(0, Number(pollMs) || 0));
  }
}

export function parseSupervisorOptions(argv) {
  const options = {
    create: false,
    runId: "",
    checkpoint: "",
    proxy: "",
    watch: false,
    pollSeconds: 5,
    runnerArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--new") options.create = true;
    else if (token === "--run-id") options.runId = requiredText(argv[++index], "--run-id");
    else if (token === "--checkpoint") options.checkpoint = requiredText(argv[++index], "--checkpoint");
    else if (token === "--proxy") options.proxy = requiredText(argv[++index], "--proxy");
    else if (token === "--watch") options.watch = true;
    else if (token === "--poll-seconds") options.pollSeconds = Math.max(1, Number(argv[++index]));
    else if (token === "--help" || token === "-h") options.help = true;
    else options.runnerArgs.push(token);
  }
  if (!options.help && options.create && options.runId) {
    throw new Error("--new cannot be combined with --run-id");
  }
  if (!options.help && !options.create && !options.runId) {
    throw new Error("--run-id is required unless --new is supplied");
  }
  if (!options.help && options.create) {
    parseAdaptiveOptions([
      ...options.runnerArgs,
      ...(options.proxy ? ["--proxy", options.proxy] : []),
      ...(options.checkpoint ? ["--checkpoint", options.checkpoint] : []),
    ]);
  }
  return options;
}

function helpText() {
  return `Usage: node supervise-adaptive-export.mjs (--new [collection options] | --run-id UUID) [options]

Creates or resumes one PostgreSQL adaptive run under a supervised lock owner.

Options:
  --new               Create a new authoritative run before starting the first child
  --run-id UUID       Existing PostgreSQL adaptive run to supervise
  --checkpoint FILE   Local checkpoint projection; defaults to persisted run metadata
  --proxy URL         web-access Proxy URL
  --watch             Keep supervising after a child exits
  --poll-seconds N    Delay between watch attempts (default: 5)
`;
}

function supervisorExitCode(result) {
  if (result.action === "BUSY") return 3;
  if (result.action === "COMPLETED" || (result.action === "SKIPPED" && result.status === "DONE")) return 0;
  if (result.status === "HUMAN_REQUIRED") return 2;
  if (result.status === "STALLED") return 3;
  if (result.status === "ADOPTION_REJECTED") return 4;
  if (result.action === "SPAWNED" && Number(result.code) > 0) return Number(result.code);
  if (result.action === "NOT_FOUND") return 1;
  return 1;
}

async function main() {
  const options = parseSupervisorOptions(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const databaseUrl = String(process.env.XWS_DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("XWS_DATABASE_URL is required for adaptive supervision");
  const pool = createStatePool(databaseUrl);
  try {
    await ensureStateSchema(pool);
    if (!options.watch) {
      const result = await superviseAdaptiveRunOnce({
        pool,
        runId: options.runId,
        create: options.create,
        runnerArgs: options.runnerArgs,
        checkpoint: options.checkpoint,
        proxy: options.proxy,
      });
      console.log(JSON.stringify(result));
      return supervisorExitCode(result);
    }

    const result = await superviseAdaptiveRun({
      pool,
      runId: options.runId,
      create: options.create,
      runnerArgs: options.runnerArgs,
      checkpoint: options.checkpoint,
      proxy: options.proxy,
      pollMs: options.pollSeconds * 1000,
      onResult: async (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result));
    return supervisorExitCode(result);
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
