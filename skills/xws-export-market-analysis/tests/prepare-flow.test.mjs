import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "scripts", "export-market-analysis.mjs");
const validator = path.join(root, "scripts", "validate-output.py");
const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonPrefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];

function startFakeProxy({ full = false, outputPath = "", staleTargets = false, searchReloads = false, homeReloads = false, homeHydrates = false, labelSettles = false, pluginInitialError = false, searchInputResets = false, marketAnalysisClickMissesOnce = false, startClickMissesOnce = false, xlsxMenuMountsLate = false, sortRadioNeedsLabel = false, sortRequiresClickAt = false, sortRequiresSettledDomClick = false, radioMarkerNeedsVisible = false, unlimitedPriceAsZero = false } = {}) {
  let homeCreated = false;
  let searchCreated = false;
  let started = false;
  let targetsCalls = 0;
  let searchReady = !searchReloads;
  let searchReadyChecks = 0;
  let homeReady = !homeReloads;
  let homeReadyChecks = 0;
  let homeTextReads = 0;
  let searchLabelTargetReads = 0;
  let pluginProbeErrors = 0;
  let searchInputSets = 0;
  let marketAnalysisClicks = 0;
  let startClicks = 0;
  let xlsxMenuProbes = 0;
  let trustedSortClicked = false;
  let radioReady = false;
  let settledSortClicked = false;
  const targetLabels = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await new Promise((resolve) => {
      let text = "";
      request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => resolve(text));
    });
    const send = (value) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value }));
    };
    const sendTargets = (value) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/targets") {
      targetsCalls += 1;
      const targets = homeCreated ? [{ type: "page", targetId: "home", url: "https://www.taobao.com/", automationLabel: targetLabels.get("home") }] : [];
      const searchUrl = labelSettles && targetLabels.has("search") && searchLabelTargetReads++ === 0
        ? "https://s.taobao.com/loading"
        : "https://s.taobao.com/search?q=%E6%B5%B4%E7%BC%B8";
      if (searchCreated) targets.push({
        type: "page",
        targetId: "search",
        url: searchUrl,
        automationLabel: targetLabels.get("search"),
      });
      if (staleTargets) {
        targets.push(
          { type: "page", targetId: "stale-home", url: "https://www.taobao.com/" },
          { type: "page", targetId: "stale-search", url: "https://s.taobao.com/search?q=%E6%B5%B4%E7%BC%B8" },
        );
      }
      sendTargets(targets);
      return;
    }
    if (url.pathname === "/new") {
      homeCreated = true;
      if (url.searchParams.get("label")) targetLabels.set("home", url.searchParams.get("label"));
      send({ targetId: "home" });
      return;
    }
    if (url.pathname === "/label") {
      targetLabels.set(url.searchParams.get("target"), url.searchParams.get("label"));
      send({ labeled: true });
      return;
    }
    if (url.pathname === "/clickAt") {
      if (url.searchParams.get("target") === "home" && body.includes("J_TSearchForm")
        && (!searchInputResets || searchInputSets >= 2)) searchCreated = true;
      if (body.includes(".xws-market-analysis-btn")) marketAnalysisClicks += 1;
      if (body.includes("data-xws-config-sort")) trustedSortClicked = true;
      if (body.includes("data-xws-start")) {
        startClicks += 1;
        started = !startClickMissesOnce || startClicks >= 2;
      }
      if (full && body.includes("data-xws-export-csv")) {
        const csv = [
          "序号,商品图片,商品标题,商品链接,价格,月收货人数,类目,同款数,平台,占位类型,店铺名,店铺旺旺,店铺类型,地址,收藏人数,卖点",
          "1,,A,https://item.taobao.com/item.htm?id=1,100,10,c,0,淘宝,自然位,s,w,t,a,-,-",
          "2,,B,https://item.taobao.com/item.htm?id=2,200,100+,c,-,天猫,广告位,s,w,t,a,-,-",
        ].join("\n");
        await writeFile(outputPath, csv, "utf8");
      }
      if (full && body.includes("data-xws-export-xlsx")) {
        const fixtureScript = [
          "import importlib.util,sys",
          "from pathlib import Path",
          "spec=importlib.util.spec_from_file_location('validator',sys.argv[1])",
          "module=importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "module.make_self_test_fixture(Path(sys.argv[2]))",
        ].join(";");
        const fixture = spawnSync(python, [...pythonPrefix, "-c", fixtureScript, validator, path.dirname(outputPath)], { encoding: "utf8" });
        if (fixture.status !== 0) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: fixture.stderr || fixture.stdout }));
          return;
        }
      }
      send({ clicked: true });
      return;
    }
    if (url.pathname === "/eval") {
      const target = url.searchParams.get("target");
      if (target === "home" && body.trim() === "document.readyState") {
        homeReadyChecks += 1;
        if (homeReadyChecks >= 2) homeReady = true;
        send(homeReady ? "complete" : "loading");
      } else if (target === "search" && body.trim() === "document.readyState") {
        searchReadyChecks += 1;
        if (searchReadyChecks >= 2) searchReady = true;
        send(searchReady ? "complete" : "loading");
      } else if (target.startsWith("stale-")) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "stale target must not receive workflow actions" }));
      } else if (target === "home" && body.includes("setter.call(input")) {
        searchInputSets += 1;
        send({ ok: true });
      } else if (target === "home" && body.includes("document.querySelector('#q')?.value")) {
        send(!searchInputResets || searchInputSets >= 2);
      } else if (target === "home" && body.includes("document.body?.innerText")) {
        homeTextReads += 1;
        send(homeHydrates && homeTextReads === 1 ? "淘宝" : "我的淘宝");
      } else if (target === "home") {
        send({ ok: true });
      } else if (body.includes("pluginReady:") && pluginInitialError && pluginProbeErrors++ === 0) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "Uncaught" }));
      } else if (body.includes("pluginReady:")) {
        try {
          new vm.Script(body);
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error.message }));
          return;
        }
        const dialogReady = !marketAnalysisClickMissesOnce || marketAnalysisClicks >= 2;
        send({ pluginReady: true, permission: false, config: dialogReady ? "搜索频率" : "", result: started ? "商品数量" : "", visibleText: "市场分析" });
      } else if (body.includes("loadingMasks")) {
        if (sortRequiresSettledDomClick) radioReady = true;
        send({ ok: true, ready: true });
      } else if (sortRequiresSettledDomClick && body.includes("label.click()")) {
        settledSortClicked = radioReady;
        send({ ok: settledSortClicked });
      } else if (body.includes("data-xws-export-xlsx")) {
        xlsxMenuProbes += 1;
        send(!xlsxMenuMountsLate || xlsxMenuProbes >= 2);
      } else if (body.includes("label.setAttribute") && radioMarkerNeedsVisible && !body.includes("getComputedStyle")) {
        send({ ok: false, reason: "stale dialog selected" });
      } else if (body.includes("config dialog missing")) {
        send({
          ok: true,
          keyword: "浴缸",
          channel: true,
          sort: sortRequiresSettledDomClick ? settledSortClicked : (sortRequiresClickAt ? trustedSortClicked : (!sortRadioNeedsLabel || body.includes("closest('label')"))),
          spinners: full ? ["1", "1", "0", "", "10", "10"] : ["1", "40", "0", unlimitedPriceAsZero ? "0" : "", "10", "15"],
          priceMaxUnlimited: unlimitedPriceAsZero,
          hasStart: true,
        });
      } else if (full && started && body.includes("title: document.title")) {
        send({ text: "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2", title: "浴缸_淘宝搜索" });
      } else if (full && startClickMissesOnce && startClicks === 1 && body.includes("title: document.title")) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "start result dialog did not open" }));
      } else if (full && started && body.includes("商品数量")) {
        send({ text: "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2", title: "浴缸_淘宝搜索" });
      } else {
        send("淘宝搜索");
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      getTargetsCalls: () => targetsCalls,
      getMarketAnalysisClicks: () => marketAnalysisClicks,
      getStartClicks: () => startClicks,
      getXlsxMenuProbes: () => xlsxMenuProbes,
    }));
  });
}

test("prepare-only retries market analysis once when the first click opens no dialog", async () => {
  const proxy = await startFakeProxy({ marketAnalysisClickMissesOnce: true });
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword",
        "浴缸",
        "--prepare-only",
        "--proxy",
        `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime }, encoding: "utf8" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /READY_FOR_RECORDING/u);
    assert.equal(proxy.getMarketAnalysisClicks(), 2);
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("prepare-only runs from Taobao home without touching a live browser", async () => {
  const proxy = await startFakeProxy({ staleTargets: true, searchReloads: true, homeReloads: true, homeHydrates: true, labelSettles: true, pluginInitialError: true, searchInputResets: true, sortRadioNeedsLabel: true, sortRequiresSettledDomClick: true, unlimitedPriceAsZero: true });
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword",
        "浴缸",
        "--prepare-only",
        "--proxy",
        `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime }, encoding: "utf8" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /READY_FOR_RECORDING/u);
    assert.ok(proxy.getTargetsCalls() >= 8);
    const runDirs = await (await import("node:fs/promises")).readdir(runtime);
    assert.equal(runDirs.length, 1);
    const manifest = JSON.parse(await readFile(path.join(runtime, runDirs[0], "manifest.json"), "utf8"));
    assert.equal(manifest.status, "READY_FOR_RECORDING");
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow retries a missed start click and validates the downloaded CSV", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({ full: true, outputPath: path.join(output, "result.csv"), startClickMissesOnce: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword",
        "浴缸",
        "--pages",
        "1-1",
        "--frequency",
        "10-10",
        "--export",
        "csv",
        "--output-dir",
        output,
        "--proxy",
        `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"event":"DONE"/u);
    const runDirs = await (await import("node:fs/promises")).readdir(runtime);
    const manifest = JSON.parse(await readFile(path.join(runtime, runDirs[0], "manifest.json"), "utf8"));
    assert.equal(manifest.status, "DONE");
    assert.equal(manifest.progress.rowCount, 2);
    assert.equal(manifest.validation.validation.rows, 2);
    assert.equal(proxy.getStartClicks(), 2);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow waits for a delayed XLSX export menu", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({ full: true, outputPath: path.join(output, "result.csv"), xlsxMenuMountsLate: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword",
        "浴缸",
        "--pages",
        "1-1",
        "--frequency",
        "10-10",
        "--export",
        "csv,xlsx-images",
        "--output-dir",
        output,
        "--proxy",
        `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"event":"DONE"/u);
    assert.equal(proxy.getXlsxMenuProbes(), 2);
    const runDirs = await (await import("node:fs/promises")).readdir(runtime);
    const manifest = JSON.parse(await readFile(path.join(runtime, runDirs[0], "manifest.json"), "utf8"));
    assert.equal(manifest.validation.validation.embedded_media, 2);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});
