// 一次性补跑：镜像 run-weekly-collection.mjs 合并步骤（含 stdio 修复），
// 用收执里已采成的十段产物重跑合并，产出交付物。
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:/Retire/sycm-automation";
const HERE = path.join(ROOT, "runtime");
const MERGER = path.join(ROOT, "skills/xws-export-market-analysis/scripts/merge-market-analysis.mjs");

const receipt = JSON.parse(readFileSync(path.join(HERE, ".weekly-collection-receipt.json"), "utf8"));
const collected = receipt.collected;
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const mergedCsv = path.join(HERE, "weekly-merged-1791994250176.csv");
const mergedXlsx = mergedCsv.replace(/\.csv$/u, ".xlsx");
const args = [];
for (const p of collected) args.push("--csv", abs(p.csv));
args.push("--output-csv", mergedCsv);
for (const p of collected) args.push("--xlsx", abs(p.xlsx));
args.push("--output-xlsx", mergedXlsx, "--require-images");

console.log("collected 段数=", collected.length);
console.log("产物存在=", collected.every((p) => existsSync(abs(p.csv)) && existsSync(abs(p.xlsx))));

// 修复点：显式 stdio，stdin 必须 'ignore'（默认 stdio 恰是宿主沙箱会掐断的那一形态）。
const merge = spawnSync(process.execPath, [MERGER, ...args], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000,
  stdio: ["ignore", "pipe", "pipe"],
});

console.log("status=", merge.status, "error=", merge.error ? merge.error.code : null);
console.log("stdout=", String(merge.stdout || "").slice(0, 600));
console.log("stderr=", String(merge.stderr || "").slice(0, 1000));
console.log("mergedCsv 生成=", existsSync(mergedCsv), " mergedXlsx 生成=", existsSync(mergedXlsx));
