#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildSegmentPlan,
  nextPendingSegment,
  parseSegmentOptions,
  readCheckpoint,
  summarizeSegmentResult,
  writeCheckpoint,
} from "./segments.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, "export-market-analysis.mjs");
function helpText() {
  return `Usage: node run-segmented-export.mjs [options]

Runs Xiaowangshen in deterministic page segments and resumes from a checkpoint.

Options:
  --keyword TEXT          Required keyword
  --pages START-END       Page range (default: 1-40)
  --segment-size N        Pages per segment (default: 8)
  --frequency MIN-MAX     Seconds between page requests (default: 30-45)
  --stall-seconds N       No-progress threshold per segment (default: 300)
  --channel all|taobao|tmall
  --sort relevance|sales|credit|price-low|price-high
  --price MIN-unlimited|MIN-MAX
  --export csv,xlsx,xlsx-images (default: csv,xlsx-images)
  --output-dir DIR        Actual Edge download directory
  --checkpoint FILE       Checkpoint JSON (default: xws-KEYWORD-checkpoint.json)
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

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(helpText());
    return 0;
  }
  const options = parseSegmentOptions(process.argv.slice(2));
  const plan = buildSegmentPlan({ ...options.pages, size: options.segmentSize });
  const checkpointPath = path.resolve(options.checkpoint);
  const checkpointDir = path.dirname(checkpointPath);
  const checkpoint = await readCheckpoint(checkpointPath, {
    keyword: options.keyword,
    pages: options.pages,
    segmentSize: options.segmentSize,
    frequency: options.frequency,
  });
  if (checkpoint.keyword && checkpoint.keyword !== options.keyword) throw new Error("checkpoint keyword does not match");
  checkpoint.keyword = options.keyword;
  checkpoint.pages = options.pages;
  checkpoint.segmentSize = options.segmentSize;
  checkpoint.frequency = options.frequency;
  checkpoint.segments ||= {};
  const stateRoot = path.join(checkpointDir, `${path.basename(checkpointPath, path.extname(checkpointPath))}-runs`);
  await mkdir(stateRoot, { recursive: true });

  let segment = nextPendingSegment(plan, checkpoint);
  while (segment) {
    const segmentRuntime = path.join(stateRoot, segment.id);
    checkpoint.segments[segment.id] = {
      ...(checkpoint.segments[segment.id] || {}),
      id: segment.id,
      start: segment.start,
      end: segment.end,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    await writeCheckpoint(checkpointPath, checkpoint);
    const args = [
      "--keyword", options.keyword,
      "--pages", `${segment.start}-${segment.end}`,
      "--frequency", `${options.frequency.min}-${options.frequency.max}`,
      "--channel", options.channel,
      "--sort", options.sort,
      "--price", options.price,
      "--export", options.exportModes.join(","),
      "--proxy", options.proxy,
      "--stall-seconds", String(options.stallSeconds),
    ];
    if (options.outputDir) args.push("--output-dir", options.outputDir);
    if (options.allowTrial) args.push("--allow-trial");
    const result = await runChild(args, { ...process.env, XWS_RUNTIME_DIR: segmentRuntime });
    const errorEvent = lastJsonLine(result.stderr) || lastJsonLine(result.stdout);
    const manifests = await findFiles(segmentRuntime, "manifest.json");
    const manifestPath = manifests.at(-1);
    if (result.code === 0 && manifestPath) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const artifacts = {};
      for (const [kind, artifact] of Object.entries(manifest.artifacts || {})) {
        if (!artifact?.path) continue;
        const target = path.join(stateRoot, "parts", segment.id, path.basename(artifact.path));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(artifact.path, target);
        artifacts[kind] = target;
      }
      checkpoint.segments[segment.id] = summarizeSegmentResult({
        segment,
        status: "DONE",
        rows: manifest.progress?.rowCount || 0,
        artifacts,
        diagnostics: manifest.diagnostics,
      });
      checkpoint.segments[segment.id].completedAt = new Date().toISOString();
      await writeCheckpoint(checkpointPath, checkpoint);
      console.log(JSON.stringify({ event: "SEGMENT_DONE", segment: segment.id, rows: manifest.progress?.rowCount || 0 }));
      segment = nextPendingSegment(plan, checkpoint);
      continue;
    }
    const status = result.code === 2 ? "HUMAN_REQUIRED" : result.code === 3 ? "STALLED" : "FAILED";
    checkpoint.segments[segment.id] = {
      ...summarizeSegmentResult({ segment, status, rows: 0, diagnostics: errorEvent.details?.diagnostics || {} }),
      error: String(errorEvent.error || result.stderr || "segment failed").trim().slice(-1000),
      details: errorEvent.details || {},
      failedAt: new Date().toISOString(),
    };
    await writeCheckpoint(checkpointPath, checkpoint);
    console.error(JSON.stringify({ status, segment: segment.id, checkpoint: checkpointPath }));
    return result.code || 1;
  }
  checkpoint.status = "DONE";
  checkpoint.completedAt = new Date().toISOString();
  await writeCheckpoint(checkpointPath, checkpoint);
  console.log(JSON.stringify({ event: "SEGMENTED_DONE", checkpoint: checkpointPath, segments: plan.length }));
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(JSON.stringify({ status: "FAILED", error: error.message }));
  process.exitCode = 1;
}
