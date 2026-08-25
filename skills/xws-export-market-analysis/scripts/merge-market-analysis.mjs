#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateDataset } from "./flow.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseCsv(text) {
  const source = String(text || "");
  if (!source) return [];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function stringifyCsv(table) {
  return table.map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}

export function mergeCsvTables(tables) {
  if (!Array.isArray(tables) || !tables.length) throw new Error("at least one CSV table is required");
  const first = tables[0];
  if (!Array.isArray(first?.headers)) throw new Error("CSV headers are required");
  const headers = first.headers.map((value) => String(value ?? ""));
  const seen = new Set();
  const rows = [];
  let duplicatesRemoved = 0;
  for (const table of tables) {
    if (!Array.isArray(table?.headers) || table.headers.map((value) => String(value ?? "")).join("\u0000") !== headers.join("\u0000")) {
      throw new Error("CSV headers do not match");
    }
    validateDataset(headers, table.rows);
    for (const sourceRow of table.rows) {
      const row = sourceRow.map((value) => value ?? "");
      const link = String(row[3] || "").trim();
      if (seen.has(link)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(link);
      row[0] = rows.length + 1;
      rows.push(row);
    }
  }
  validateDataset(headers, rows);
  return { headers, rows, rowCount: rows.length, duplicatesRemoved };
}

async function readCsvTable(file) {
  const text = await readFile(file, "utf8");
  const table = parseCsv(text.replace(/^\uFEFF/u, ""));
  if (!table.length) throw new Error(`CSV is empty: ${file}`);
  return { name: path.basename(file), headers: table[0], rows: table.slice(1), path: path.resolve(file) };
}

function parseArgs(argv) {
  const options = { csv: [], xlsx: [], outputCsv: "", outputXlsx: "", requireImages: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--require-images") {
      options.requireImages = true;
      continue;
    }
    if (!["--csv", "--xlsx", "--output-csv", "--output-xlsx"].includes(token)) {
      throw new Error(`unknown option: ${token}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    if (token === "--csv") options.csv.push(value);
    else if (token === "--xlsx") options.xlsx.push(value);
    else if (token === "--output-csv") options.outputCsv = value;
    else options.outputXlsx = value;
  }
  if (options.help) return options;
  if (!options.csv.length) throw new Error("at least one --csv is required");
  if (!options.outputCsv) throw new Error("--output-csv is required");
  if (options.xlsx.length && options.xlsx.length !== options.csv.length) {
    throw new Error("the number of --xlsx files must match the number of --csv files");
  }
  if (options.requireImages && !options.xlsx.length) throw new Error("--require-images requires --xlsx inputs");
  if (options.xlsx.length && !options.outputXlsx) throw new Error("--output-xlsx is required with --xlsx inputs");
  return options;
}

function pythonCommand() {
  const executable = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
  return { executable, prefix: process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"] };
}

function runPythonMerge(options) {
  const { executable, prefix } = pythonCommand();
  const args = [...prefix, path.join(SCRIPT_DIR, "merge-market-analysis.py"), "--csv", options.outputCsv, "--output-xlsx", options.outputXlsx];
  for (const file of options.xlsx) args.push("--source-xlsx", file);
  if (options.requireImages) args.push("--require-images");
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const output = String(result.stdout || "").trim();
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error(`xlsx merger returned invalid JSON: ${String(result.stderr || output).slice(0, 500)}`); }
  if (result.status !== 0 || !parsed.ok) throw new Error(parsed.error || "xlsx merge failed");
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node merge-market-analysis.mjs --csv PART.csv [--csv PART.csv ...] --output-csv merged.csv [--xlsx PART.xlsx ... --output-xlsx merged.xlsx --require-images]");
    return;
  }
  const tables = [];
  for (const file of options.csv) tables.push(await readCsvTable(file));
  const merged = mergeCsvTables(tables);
  await writeFile(options.outputCsv, stringifyCsv([merged.headers, ...merged.rows]), "utf8");
  let xlsx = null;
  if (options.xlsx.length) xlsx = runPythonMerge(options);
  console.log(JSON.stringify({ ok: true, csv: path.resolve(options.outputCsv), xlsx, rows: merged.rowCount, duplicatesRemoved: merged.duplicatesRemoved }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
