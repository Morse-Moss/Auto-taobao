import { normalizeDiagnosticSnapshot } from "./diagnostics.mjs";
import { readFile, writeFile } from "node:fs/promises";

import { PROJECT_PORTS } from "../../../runtime/browser-ports.mjs";

// 竞品链在**甲（买家浏览器，装着小旺神）**上；端口只从登记表取
// （原先默认写的是别的项目的共享代理，那里没装小旺神、还登着商家号）。
const DEFAULT_PROXY = `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`;

function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

export function buildSegmentPlan({ start, end, size = 8 }) {
  const first = integer(start, "start");
  const last = integer(end, "end");
  const width = integer(size, "size");
  if (last < first) throw new Error("end must not be less than start");
  const plan = [];
  for (let cursor = first; cursor <= last; cursor += width) {
    const segmentEnd = Math.min(cursor + width - 1, last);
    plan.push({ id: `${cursor}-${segmentEnd}`, start: cursor, end: segmentEnd });
  }
  return plan;
}

export function nextPendingSegment(plan, checkpoint = {}) {
  if (!Array.isArray(plan)) throw new Error("plan must be an array");
  const states = checkpoint.segments && typeof checkpoint.segments === "object" ? checkpoint.segments : {};
  return plan.find((segment) => states[segment.id]?.status !== "DONE") || null;
}

export function parseSegmentOptions(argv, env = process.env) {
  const options = {
    keyword: "",
    pages: { start: 1, end: 40 },
    segmentSize: 8,
    frequency: { min: 30, max: 45 },
    stallSeconds: 300,
    channel: "all",
    sort: "sales",
    price: "0-unlimited",
    exportModes: ["csv", "xlsx-images"],
    outputDir: "",
    checkpoint: "",
    proxy: env.XWS_PROXY || DEFAULT_PROXY,
    allowTrial: false,
  };
  const valueOptions = new Set(["keyword", "pages", "segment-size", "frequency", "channel", "sort", "price", "export", "output-dir", "checkpoint", "proxy", "stall-seconds"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-trial") { options.allowTrial = true; continue; }
    if (!token.startsWith("--")) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    if (!valueOptions.has(key)) throw new Error(`unknown option: --${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    if (key === "keyword") options.keyword = value.trim();
    else if (key === "pages") {
      const match = value.match(/^(\d+)-(\d+)$/u);
      if (!match || Number(match[2]) < Number(match[1])) throw new Error("pages must use START-END");
      options.pages = { start: Number(match[1]), end: Number(match[2]) };
    } else if (key === "segment-size") options.segmentSize = integer(value, "segment-size");
    else if (key === "frequency") {
      const match = value.match(/^(\d+)-(\d+)$/u);
      if (!match || Number(match[2]) < Number(match[1])) throw new Error("frequency must use MIN-MAX");
      options.frequency = { min: Number(match[1]), max: Number(match[2]) };
    } else if (key === "export") options.exportModes = value.split(",").map((item) => item.trim()).filter(Boolean);
    else if (key === "output-dir") options.outputDir = value;
    else if (key === "checkpoint") options.checkpoint = value;
    else if (key === "proxy") options.proxy = value.replace(/\/$/u, "");
    else if (key === "stall-seconds") {
      options.stallSeconds = integer(value, "stall-seconds");
      if (options.stallSeconds < 60) throw new Error("stall-seconds must be at least 60");
    }
    else options[key.replaceAll("-", "")] = value;
  }
  if (!options.keyword) throw new Error("--keyword is required");
  if (!options.checkpoint) options.checkpoint = `xws-${options.keyword}-checkpoint.json`;
  return options;
}

export async function readCheckpoint(file, defaults) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, ...defaults, segments: {} };
  }
}

export async function writeCheckpoint(file, checkpoint) {
  await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export function summarizeSegmentResult({ segment, status, rows = 0, artifacts = {}, diagnostics = {} }) {
  if (!segment?.id) throw new Error("segment is required");
  const normalized = normalizeDiagnosticSnapshot(diagnostics);
  const lastRequest = normalized.requests.at(-1) || null;
  const lastMessage = normalized.messages.at(-1) || null;
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    status: String(status || "FAILED"),
    rows: Number.isFinite(rows) ? rows : 0,
    artifacts: { ...artifacts },
    diagnostics: {
      requestCount: normalized.requests.length,
      ...(lastRequest ? { lastRequest: { ...lastRequest, url: safeUrl(lastRequest.url) } } : {}),
      messageCount: normalized.messages.length,
      ...(lastMessage ? { lastMessage } : {}),
    },
  };
}
