import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const validator = path.join(root, "scripts", "validate-output.py");
const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonPrefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];

test("output validator self-test covers CSV, XLSX, links, and embedded images", () => {
  const result = spawnSync(python, [...pythonPrefix, validator, "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.validation.rows, 2);
  assert.equal(output.validation.embedded_media, 2);
  assert.equal(output.validation.non_image_field_differences, 0);
});

test("numeric normalization does not collapse different integer values", () => {
  const script = [
    "import importlib.util",
    `p=r'''${validator}'''`,
    "s=importlib.util.spec_from_file_location('validator',p)",
    "m=importlib.util.module_from_spec(s)",
    "s.loader.exec_module(m)",
    "assert m.normalize('10') != m.normalize('1')",
  ].join(";");
  const result = spawnSync(python, [...pythonPrefix, "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("output validator accepts the observed payment-count header variant", () => {
  const script = [
    "import importlib.util",
    `p=r'''${validator}'''`,
    "s=importlib.util.spec_from_file_location('validator',p)",
    "m=importlib.util.module_from_spec(s)",
    "s.loader.exec_module(m)",
    "h=list(m.HEADERS)",
    "h[5]='\\u4ed8\\u6b3e\\u4eba\\u6570'",
    "r=[None]*16",
    "r[0]=1",
    "r[3]='https://item.taobao.com/item.htm?id=1'",
    "assert m.validate_rows(h,[r])['rows']==1",
  ].join(";");
  const result = spawnSync(python, [...pythonPrefix, "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
