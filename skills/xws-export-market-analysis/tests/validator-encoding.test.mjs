// 2026-10-13：钉住「两个 python 校验器在非 UTF-8 默认编码的机器上也能跑」。
//
// 背景：GitHub 的 windows runner 是英文区域，Python 的 stdout 默认是 cp1252，
// 而 validate-output.py / merge-market-analysis.py 都用
// `print(json.dumps(..., ensure_ascii=False))` 输出含中文的 JSON —— 在 cp1252 上会抛
// `UnicodeEncodeError: 'charmap' codec can't encode characters ...`。
// 在 CLI 里，这次校验失败被当成「候选不合格」⇒ `EXPORT_CANDIDATE_REJECTED` ⇒ 一直轮询到
// `EXPORT_SETTLEMENT_MS`（60 分钟）才报 "Timed out waiting for .csv download"，
// 于是每个这样的用例烧掉一小时、整条 CI 作业在 180 分钟超时被 cancel（run 38373698780 等）。
// 修复＝在两个脚本头部把 stdout/stderr 显式 reconfigure 成 UTF-8（调用方一律按 UTF-8 读）。
//
// 这条用例就是那个修复的判据：把子进程的输出编码**强制**成 cp1252（它编码不了中文），
// 脚本仍必须吐出可解析、且中文没有被降级的 JSON。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonPrefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];
// 复刻 runner：让子进程的 stdout/stderr 落在 cp1252 上。
const NON_UTF8_ENV = { ...process.env, PYTHONIOENCODING: "cp1252" };

function runPython(script, args) {
  const result = spawnSync(python, [...pythonPrefix, path.join(scriptDir, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: NON_UTF8_ENV,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

test("validate-output.py 在 cp1252 环境下仍输出可解析的 UTF-8 JSON（中文表头不被降级）", () => {
  const { status, stdout, stderr } = runPython("validate-output.py", ["--self-test"]);
  assert.equal(status, 0, stderr);
  assert.equal(stderr.includes("charmap"), false, stderr);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, true);
  // 中文必须原样出现（用 ensure_ascii=False 打的），而不是 \uXXXX 转义或乱码。
  assert.ok(parsed.validation.headers.includes("商品标题"), stdout.slice(0, 300));
});

test("merge-market-analysis.py 在 cp1252 环境下、错误信息含中文路径时仍输出可解析 JSON", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "xws-merge-encoding-"));
  try {
    // 故意给一个**不存在**且**名字含中文**的 CSV：异常信息里会带上这个中文路径，
    // 正是「非中文区域机器上被 charmap 卡住」的那条路径。
    const missingCsv = path.join(temp, "不存在的输入.csv");
    const { status, stdout, stderr } = runPython("merge-market-analysis.py", [
      "--csv", missingCsv,
      "--output-xlsx", path.join(temp, "输出.xlsx"),
    ]);
    assert.equal(stderr.includes("charmap"), false, stderr);
    assert.equal(status, 1, stderr);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.includes("不存在的输入.csv"), stdout.slice(0, 300));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
