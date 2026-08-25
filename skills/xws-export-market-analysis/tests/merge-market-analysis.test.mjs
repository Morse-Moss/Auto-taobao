import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeCsvTables } from "../scripts/merge-market-analysis.mjs";

const headers = [
  "序号", "商品图片", "商品标题", "商品链接", "价格", "月收货人数", "类目", "同款数",
  "平台", "占位类型", "店铺名", "店铺旺旺", "店铺类型", "地址", "收藏人数", "卖点",
];

function row(rank, title, link) {
  return [rank, "", title, link, "1", "-", "浴缸", "-", "淘宝", "自然位", "店", "旺旺", "企业", "杭州", "-", "卖点"];
}

test("merges ordered partial tables by product link and rewrites contiguous ranks", () => {
  const result = mergeCsvTables([
    { name: "1-40", headers, rows: [row(1, "A", "https://item.taobao.com/item.htm?id=1"), row(2, "B", "https://item.taobao.com/item.htm?id=2")] },
    { name: "33-40", headers, rows: [row(1, "B-new", "https://item.taobao.com/item.htm?id=2"), row(2, "C", "https://item.taobao.com/item.htm?id=3")] },
  ]);
  assert.deepEqual(result.rows.map((value) => value[0]), [1, 2, 3]);
  assert.deepEqual(result.rows.map((value) => value[2]), ["A", "B", "C"]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.rows[1][3], "https://item.taobao.com/item.htm?id=2");
});

test("rejects partial tables with a different source contract", () => {
  assert.throws(() => mergeCsvTables([
    { name: "1-40", headers: ["bad"], rows: [] },
  ]), /headers do not match/u);
});

test("rebuilds an XLSX with images from the ordered merged CSV", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const validator = path.join(root, "scripts", "validate-output.py");
  const merger = path.join(root, "scripts", "merge-market-analysis.mjs");
  const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const prefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];
  const temp = await mkdtemp(path.join(os.tmpdir(), "xws-merge-test-"));
  try {
    const fixture = path.join(temp, "fixture");
    await mkdir(fixture);
    const fixtureScript = [
      "import importlib.util,sys",
      "from pathlib import Path",
      "spec=importlib.util.spec_from_file_location('validator',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.make_self_test_fixture(Path(sys.argv[2]))",
    ].join(";");
    const fixtureResult = spawnSync(python, [...prefix, "-c", fixtureScript, validator, fixture], { encoding: "utf8" });
    assert.equal(fixtureResult.status, 0, fixtureResult.stderr || fixtureResult.stdout);
    const outputCsv = path.join(temp, "merged.csv");
    const outputXlsx = path.join(temp, "merged.xlsx");
    const mergeResult = spawnSync(process.execPath, [
      merger,
      "--csv", path.join(fixture, "fixture.csv"),
      "--csv", path.join(fixture, "fixture.csv"),
      "--xlsx", path.join(fixture, "fixture.xlsx"),
      "--xlsx", path.join(fixture, "fixture.xlsx"),
      "--output-csv", outputCsv,
      "--output-xlsx", outputXlsx,
      "--require-images",
    ], { encoding: "utf8" });
    assert.equal(mergeResult.status, 0, mergeResult.stderr || mergeResult.stdout);
    const merged = JSON.parse(mergeResult.stdout.trim());
    assert.equal(merged.rows, 2);
    const validation = spawnSync(python, [...prefix, validator, "--csv", outputCsv, "--xlsx", outputXlsx, "--require-images"], { encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    assert.equal(JSON.parse(validation.stdout).validation.embedded_media, 2);
    assert.match(await readFile(outputCsv, "utf8"), /https:\/\/item\.taobao\.com\/item\.htm\?id=2/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
