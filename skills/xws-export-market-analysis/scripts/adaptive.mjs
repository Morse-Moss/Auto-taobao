import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";

import { parseOptions } from "./flow.mjs";

function pageNumber(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function rangeId(start, end) {
  return `${start}-${end}`;
}

function normalizedPages(pages) {
  const start = pageNumber(pages?.start, "pages.start");
  const end = pageNumber(pages?.end, "pages.end");
  if (end < start) throw new Error("pages.end must not be less than pages.start");
  return { start, end };
}

function normalizedFrequency(frequency) {
  const min = Number(frequency?.min);
  const max = Number(frequency?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error("invalid frequency range");
  }
  return { min, max };
}

function normalizedOptions(options = {}) {
  return {
    channel: options.channel,
    sort: options.sort,
    price: {
      min: Number(options.price?.min),
      max: options.price?.max === null ? null : Number(options.price?.max),
    },
    exportModes: [...(options.exportModes || [])].sort(),
    outputDir: String(options.outputDir || ""),
    allowTrial: Boolean(options.allowTrial),
    stallSeconds: Number(options.stallSeconds),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function lastJsonLine(text) {
  for (const line of String(text || "").trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* event output is mixed with diagnostics */ }
  }
  return null;
}

function safeCompletedEnd(progress, start) {
  const value = Number(progress?.completedEnd);
  if (!Number.isInteger(value)) return start - 1;
  return Math.max(start - 1, value);
}

function orderedParts(checkpoint) {
  return Object.values(checkpoint.parts || {})
    .filter((part) => part && Number.isInteger(part.start) && Number.isInteger(part.end))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function canAdvance(part) {
  return part.status === "DONE" || part.status === "STALLED";
}

function contiguousCompletedEnd(checkpoint) {
  const pages = normalizedPages(checkpoint.pages);
  let cursor = pages.start;
  for (const part of orderedParts(checkpoint)) {
    if (!canAdvance(part) || part.end < cursor || part.start > cursor) continue;
    if (part.completedEnd < cursor) break;
    cursor = Math.min(part.end, part.completedEnd) + 1;
    if (cursor > pages.end) return pages.end;
  }
  return cursor - 1;
}

export function createAdaptiveCheckpoint({ keyword, pages = { start: 1, end: 40 }, frequency = { min: 30, max: 45 } }) {
  if (!String(keyword || "").trim()) throw new Error("keyword is required");
  const normalized = normalizedPages(pages);
  return {
    version: 1,
    strategy: "adaptive",
    keyword: String(keyword).trim(),
    pages: normalized,
    frequency: { min: Number(frequency.min), max: Number(frequency.max) },
    status: "RUNNING",
    completedEnd: normalized.start - 1,
    parts: {},
  };
}

export function nextAdaptiveRange(checkpoint) {
  if (!checkpoint || checkpoint.strategy !== "adaptive") throw new Error("adaptive checkpoint is required");
  const pages = normalizedPages(checkpoint.pages);
  const completedEnd = contiguousCompletedEnd(checkpoint);
  checkpoint.completedEnd = completedEnd;
  if (completedEnd >= pages.end) {
    checkpoint.status = "DONE";
    return null;
  }
  if (checkpoint.status === "HUMAN_REQUIRED" || checkpoint.status === "FAILED") return null;

  const start = completedEnd + 1;
  const blocking = orderedParts(checkpoint).find((part) => part.start === start
    && (!canAdvance(part) || (part.status === "STALLED" && part.completedEnd < part.start)));
  if (blocking) return null;
  return { start, end: pages.end };
}

export function applyAdaptiveRun(checkpoint, result) {
  if (!checkpoint || checkpoint.strategy !== "adaptive") throw new Error("adaptive checkpoint is required");
  const start = pageNumber(result?.start, "result.start");
  const end = pageNumber(result?.end, "result.end");
  if (end < start) throw new Error("result.end must not be less than result.start");
  const progress = result.progress || {};
  const completedEnd = Math.min(end, safeCompletedEnd(progress, start));
  checkpoint.parts ||= {};
  checkpoint.parts[rangeId(start, end)] = {
    id: rangeId(start, end),
    start,
    end,
    status: String(result.status || "FAILED"),
    completedStart: Number(progress.completedStart) || 0,
    completedEnd,
    rows: Number(progress.rowCount) || 0,
    ...(result.artifacts ? { artifacts: { ...result.artifacts } } : {}),
    ...(result.artifactRecords ? { artifactRecords: structuredClone(result.artifactRecords) } : {}),
    ...(result.manifest ? { manifest: result.manifest } : {}),
    ...(result.validation ? { validation: structuredClone(result.validation) } : {}),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...(result.sourceId ? { sourceId: result.sourceId } : {}),
    ...(result.sourceAt ? { sourceAt: result.sourceAt } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
    ...(result.at ? { at: result.at } : {}),
  };
  checkpoint.completedEnd = contiguousCompletedEnd(checkpoint);
  if (checkpoint.completedEnd >= checkpoint.pages.end) checkpoint.status = "DONE";
  else if (result.status === "HUMAN_REQUIRED" || result.status === "FAILED") checkpoint.status = result.status;
  else checkpoint.status = result.status === "DONE" ? "RUNNING" : String(result.status || "STALLED");
  checkpoint.nextStart = checkpoint.completedEnd + 1;
  return checkpoint;
}

export function checkpointOptions(options) {
  return normalizedOptions(options);
}

export function validateAdaptiveCheckpoint(checkpoint, expected) {
  if (!checkpoint || checkpoint.strategy !== "adaptive") throw new Error("checkpoint is not adaptive");
  if (checkpoint.version !== 1) throw new Error("unsupported adaptive checkpoint version");
  if (checkpoint.keyword !== expected.keyword) throw new Error("checkpoint keyword does not match");
  if (!sameJson(normalizedPages(checkpoint.pages), normalizedPages(expected.pages))) {
    throw new Error("checkpoint page range does not match");
  }
  if (!sameJson(normalizedFrequency(checkpoint.frequency), normalizedFrequency(expected.frequency))) {
    throw new Error("checkpoint frequency range does not match");
  }
  if (!sameJson(normalizedOptions(checkpoint.options), normalizedOptions(expected.options))) {
    throw new Error("checkpoint collection options do not match");
  }
  return checkpoint;
}

export async function readAdaptiveCheckpoint(file, defaults, { requireExisting = false } = {}) {
  try {
    const checkpoint = JSON.parse(await readFile(file, "utf8"));
    if (checkpoint.strategy !== "adaptive") throw new Error("checkpoint is not adaptive");
    return checkpoint;
  } catch (error) {
    if (error?.code !== "ENOENT" || requireExisting) throw error;
    return createAdaptiveCheckpoint(defaults);
  }
}

export function resumeAdaptiveCheckpoint(checkpoint, expected) {
  validateAdaptiveCheckpoint(checkpoint, expected);
  const blocked = ["HUMAN_REQUIRED", "FAILED"].includes(checkpoint.status)
    || orderedParts(checkpoint).some((part) => part.status === "STALLED" && part.completedEnd < part.start);
  if (blocked) {
    checkpoint.status = "RUNNING";
    delete checkpoint.error;
    for (const [id, part] of Object.entries(checkpoint.parts || {})) {
      if (part?.status === "HUMAN_REQUIRED" && part.completedEnd >= part.start) part.status = "STALLED";
      else if (["HUMAN_REQUIRED", "FAILED", "STALLED"].includes(part?.status) && part.completedEnd < part.start) {
        delete checkpoint.parts[id];
      }
    }
    checkpoint.completedEnd = contiguousCompletedEnd(checkpoint);
    checkpoint.nextStart = checkpoint.completedEnd + 1;
  }
  return checkpoint;
}

export async function loadAdaptiveCheckpoint(file, { resume = false, expected } = {}) {
  if (resume) {
    if (!file) throw new Error("--resume requires --checkpoint");
    return resumeAdaptiveCheckpoint(
      await readAdaptiveCheckpoint(file, {}, { requireExisting: true }),
      expected,
    );
  }
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return createAdaptiveCheckpoint(expected);
    throw error;
  }
  throw new Error(`checkpoint already exists; use a new path or --resume: ${file}`);
}

export async function writeAdaptiveCheckpoint(file, checkpoint, fsApi = { writeFile, rename }) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fsApi.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fsApi.rename(temporary, file);
}

export function parseAdaptiveOptions(argv, env = process.env) {
  const input = [...argv];
  let checkpoint = "";
  let runId = "";
  let resume = false;
  const forwarded = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (token === "--checkpoint") {
      const value = input[++index];
      if (!value || value.startsWith("--")) throw new Error("missing value for --checkpoint");
      checkpoint = value;
      continue;
    }
    if (token === "--run-id") {
      const value = input[++index];
      if (!value || value.startsWith("--")) throw new Error("missing value for --run-id");
      runId = value;
      continue;
    }
    if (token === "--resume") {
      resume = true;
      continue;
    }
    forwarded.push(token);
  }
  if (!forwarded.includes("--frequency")) forwarded.push("--frequency", "30-45");
  if (!forwarded.includes("--stall-seconds")) forwarded.push("--stall-seconds", "300");
  const base = parseOptions(forwarded, env);
  return {
    ...base,
    stallSeconds: base.stallMs / 1000,
    exportPartialOnStall: true,
    checkpoint: checkpoint || `xws-${base.keyword}-adaptive-checkpoint.json`,
    checkpointExplicit: Boolean(checkpoint),
    runId,
    resume,
  };
}

export { contiguousCompletedEnd };
