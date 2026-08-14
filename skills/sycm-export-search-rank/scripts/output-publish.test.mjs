import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { publishValidatedOutputs } from "./output-publish.mjs";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test("publishes neither final file when workbook creation fails", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "sycm-publish-test-"));
  try {
    await assert.rejects(
      publishValidatedOutputs({
        outputDir,
        base: "failed-run",
        writeCsv: (file) => writeFile(file, "csv", "utf8"),
        writeXlsx: async () => { throw new Error("workbook failed"); },
      }),
      /workbook failed/u,
    );
    assert.equal(await exists(path.join(outputDir, "failed-run.csv")), false);
    assert.equal(await exists(path.join(outputDir, "failed-run.xlsx")), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("publishes validated workbook first and CSV as the completion marker", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "sycm-publish-test-"));
  try {
    const result = await publishValidatedOutputs({
      outputDir,
      base: "complete-run",
      writeCsv: (file) => writeFile(file, "csv", "utf8"),
      writeXlsx: (file) => writeFile(file, "xlsx", "utf8"),
    });
    assert.equal(await readFile(result.csvFile, "utf8"), "csv");
    assert.equal(await readFile(result.xlsxFile, "utf8"), "xlsx");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing output", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "sycm-publish-test-"));
  const csvFile = path.join(outputDir, "existing.csv");
  try {
    await writeFile(csvFile, "original", "utf8");
    await assert.rejects(
      publishValidatedOutputs({
        outputDir,
        base: "existing",
        writeCsv: (file) => writeFile(file, "new", "utf8"),
        writeXlsx: (file) => writeFile(file, "new", "utf8"),
      }),
      /already exists/u,
    );
    assert.equal(await readFile(csvFile, "utf8"), "original");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
