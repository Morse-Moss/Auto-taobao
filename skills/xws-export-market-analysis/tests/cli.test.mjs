import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../scripts/flow.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "scripts", "export-market-analysis.mjs");

test("CLI exposes the complete from-Taobao workflow", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--from-taobao-home/u);
  assert.match(result.stdout, /--allow-trial/u);
  assert.match(result.stdout, /--prepare-only/u);
});

test("CLI self-test is network free", () => {
  const result = spawnSync(process.execPath, [cli, "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    ok: true,
    checks: {
      args: true,
      progress: true,
      risk: true,
      dataset: true,
      deadline: true,
    },
  });
});

test("CLI rejects invalid frequency ranges before browser access", () => {
  const result = spawnSync(process.execPath, [
    cli,
    "--keyword",
    "\u6d74\u7f38",
    "--frequency",
    "15-10",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frequency range/u);
});

test("CLI accepts a conservative frequency above one minute", () => {
  const options = parseOptions(["--keyword", "浴缸", "--frequency", "90-120"]);
  assert.deepEqual(options.frequency, { min: 90, max: 120 });
});
