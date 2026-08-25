#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  applyAdaptiveRun,
  nextAdaptiveRange,
  parseAdaptiveOptions,
  readAdaptiveCheckpoint,
  writeAdaptiveCheckpoint,
} from "./adaptive.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, "export-market-analysis.mjs");
const MERGER = path.join(SCRIPT_DIR, "merge-market-analysis.mjs");

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
  --checkpoint FILE       Adaptive checkpoint JSON
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

function lastJsonLine(text) {
  for (const line of String(text || "").trim().split(/\r?\n/u).reverse()) {
    try { return JSON.parse(line); } catch { /* event output is mixed with diagnostics */ }
  }
  return {};
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

function childStatus(code, event) {
  if (code === 0 && event?.status === "DONE") return "DONE";
  if (code === 2 || event?.status === "HUMAN_REQUIRED") return "HUMAN_REQUIRED";
  if (code === 3 || event?.status === "STALLED") return "STALLED";
  return "FAILED";
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

async function mergeCompletedParts(checkpoint, stateRoot, options) {
  const parts = Object.values(checkpoint.parts || {})
    .filter((part) => ["DONE", "STALLED"].includes(part.status) && part.artifacts?.csv)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!parts.length) throw new Error("no validated CSV parts are available for final merge");
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
  return { ...merged, parts: parts.map((part) => part.id) };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(helpText());
    return 0;
  }
  const options = parseAdaptiveOptions(process.argv.slice(2));
  if (!options.exportModes.includes("csv")) throw new Error("adaptive export requires CSV for checkpoint and merge recovery");
  const checkpointPath = path.resolve(options.checkpoint);
  const checkpointDir = path.dirname(checkpointPath);
  const checkpoint = await readAdaptiveCheckpoint(checkpointPath, {
    keyword: options.keyword,
    pages: options.pages,
    frequency: options.frequency,
  });
  if (checkpoint.keyword && checkpoint.keyword !== options.keyword) throw new Error("checkpoint keyword does not match");
  if (checkpoint.pages && (checkpoint.pages.start !== options.pages.start || checkpoint.pages.end !== options.pages.end)) {
    throw new Error("checkpoint page range does not match");
  }
  checkpoint.keyword = options.keyword;
  checkpoint.pages = options.pages;
  checkpoint.frequency = options.frequency;
  checkpoint.options = {
    channel: options.channel,
    sort: options.sort,
    price: options.price,
    exportModes: options.exportModes,
    stallSeconds: options.stallSeconds,
  };
  checkpoint.parts ||= {};
  const stateRoot = path.join(checkpointDir, `${path.basename(checkpointPath, path.extname(checkpointPath))}-runs`);
  await mkdir(stateRoot, { recursive: true });

  while (true) {
    const range = nextAdaptiveRange(checkpoint);
    await writeAdaptiveCheckpoint(checkpointPath, checkpoint);
    if (!range) {
      if (checkpoint.status === "DONE" && !checkpoint.final) {
        checkpoint.final = await mergeCompletedParts(checkpoint, stateRoot, options);
        await writeAdaptiveCheckpoint(checkpointPath, checkpoint);
        console.log(JSON.stringify({ event: "ADAPTIVE_DONE", checkpoint: checkpointPath, final: checkpoint.final }));
        return 0;
      }
      const status = checkpoint.status || "STALLED";
      console.error(JSON.stringify({ status, checkpoint: checkpointPath, completedEnd: checkpoint.completedEnd }));
      return childExitCode(status);
    }

    const attemptRoot = path.join(stateRoot, `attempt-${Date.now()}-${range.start}-${range.end}`);
    await mkdir(attemptRoot, { recursive: true });
    console.log(JSON.stringify({ event: "ADAPTIVE_RUN_STARTED", start: range.start, end: range.end }));
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
    const result = await runChild(args, { ...process.env, XWS_RUNTIME_DIR: attemptRoot });
    const event = lastJsonLine(result.stderr) || lastJsonLine(result.stdout);
    const located = await readLatestManifest(attemptRoot);
    const manifest = located.manifest;
    const progress = manifest?.progress || event.details?.progress || {};
    const status = childStatus(result.code, { ...event, status: manifest?.status || event.status });
    const artifacts = manifest?.artifacts ? await copyManifestArtifacts(manifest, path.join(stateRoot, "parts", `${range.start}-${range.end}`)) : {};
    const hasPartialRows = status === "STALLED" && Number(progress.completedEnd) >= range.start && Boolean(artifacts.csv);
    const safeProgress = hasPartialRows || status === "DONE" ? progress : { ...progress, completedEnd: range.start - 1 };
    applyAdaptiveRun(checkpoint, {
      start: range.start,
      end: range.end,
      status,
      progress: safeProgress,
      artifacts,
      manifest: located.path,
      diagnostics: manifest?.diagnostics || event.details?.diagnostics,
      error: event.error || (status === "FAILED" ? result.stderr : ""),
      at: new Date().toISOString(),
    });
    await writeAdaptiveCheckpoint(checkpointPath, checkpoint);

    if (status === "STALLED" && !hasPartialRows) {
      console.error(JSON.stringify({ status, error: "stalled run has no validated partial CSV; refusing to advance the resume cursor", checkpoint: checkpointPath }));
      return 3;
    }
    if (status === "HUMAN_REQUIRED" || status === "FAILED") {
      console.error(JSON.stringify({ status, checkpoint: checkpointPath, completedEnd: checkpoint.completedEnd }));
      return childExitCode(status);
    }
    if (status === "STALLED") {
      console.log(JSON.stringify({ event: "ADAPTIVE_RESUME", completedEnd: checkpoint.completedEnd, nextStart: checkpoint.completedEnd + 1 }));
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(JSON.stringify({ status: "FAILED", error: error.message }));
  process.exitCode = 1;
}
