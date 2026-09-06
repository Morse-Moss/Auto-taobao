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

function startFakeProxy({ full = false, outputPath = "", staleTargets = false, searchReloads = false, homeReloads = false, homeHydrates = false, labelSettles = false, pluginInitialError = false, searchInputResets = false, marketAnalysisClickMissesOnce = false, startClickMissesOnce = false, startRequiresDomClick = false, startClickWithoutRequestOnce = false, collectionFailsAfterStartup = false, delayedCollectionRequest = false, delayedCollectionResult = false, resultMutationPrecedesRequest = false, backgroundRequestBetweenArmAndClick = false, historicalResultRemountsAfterStart = false, historicalResultRemountsInSourceAfterStart = false, historicalResultPersistsInSourceAfterRequest = false, xlsxMenuMountsLate = false, staleXlsxMenuVisible = false, staleXlsxMenuVisibleOwned = false, staleXlsxMenuHidden = false, staleXlsxMenuHiddenWithoutAria = false, xlsxMenuAriaIdChanges = false, csvExportMissing = false, exportActivationFails = false, sortRadioNeedsLabel = false, sortRequiresClickAt = false, sortRequiresSettledDomClick = false, radioMarkerNeedsVisible = false, unlimitedPriceAsZero = false, browserId = "edge", proxyConnected = true } = {}) {
  let homeCreated = false;
  let searchCreated = false;
  let started = false;
  let healthCalls = 0;
  let targetsCalls = 0;
  let newCalls = 0;
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
  let startDomClicks = 0;
  let startClickObserved = false;
  let xlsxMenuProbes = 0;
  let xlsxCaretClicks = 0;
  let currentAttemptMarker = "";
  let resultAttemptMarked = false;
  let resultAttemptChecks = 0;
  let startupChecks = 0;
  let requestStartedAfterClick = false;
  let resultAttemptBoundToSource = false;
  let resultAttemptBoundToRequest = false;
  let resultAttemptBoundToRealClick = false;
  let resultAttemptBoundToResultGeneration = false;
  let hiddenXlsxMenuBaselined = false;
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
    if (url.pathname === "/health") {
      healthCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", connected: proxyConnected, browser: { id: browserId } }));
      return;
    }
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
      newCalls += 1;
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
    if (url.pathname === "/bringToFront") {
      if (exportActivationFails && started) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "target activation failed" }));
        return;
      }
      send({ targetId: url.searchParams.get("target"), activated: true });
      return;
    }
    if (url.pathname === "/clickAt") {
      if (url.searchParams.get("target") === "home" && body.includes("J_TSearchForm")
        && (!searchInputResets || searchInputSets >= 2)) searchCreated = true;
      if (body.includes(".xws-market-analysis-btn")) marketAnalysisClicks += 1;
      if (body.includes("data-xws-config-sort")) trustedSortClicked = true;
      if (body.includes("data-xws-start")) {
        startClicks += 1;
        started = !startRequiresDomClick && (!startClickMissesOnce || startClicks >= 2);
        startClickObserved = started;
        if (started && !historicalResultRemountsInSourceAfterStart) {
          if (
            !backgroundRequestBetweenArmAndClick
            && !delayedCollectionRequest
            && !(startClickWithoutRequestOnce && startClicks === 1)
          ) requestStartedAfterClick = true;
          if (!resultMutationPrecedesRequest) {
            resultAttemptMarked = backgroundRequestBetweenArmAndClick
              ? !resultAttemptBoundToRealClick
              : historicalResultPersistsInSourceAfterRequest
                ? !resultAttemptBoundToResultGeneration
                : true;
          }
        }
      }
      if (body.includes("data-xws-export-caret")) xlsxCaretClicks += 1;
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
    if (url.pathname === "/click") {
      if (body.includes("data-xws-start")) {
        startDomClicks += 1;
        started = true;
        startClickObserved = true;
        if (!historicalResultRemountsInSourceAfterStart) {
          if (!backgroundRequestBetweenArmAndClick && !delayedCollectionRequest) requestStartedAfterClick = true;
          if (!resultMutationPrecedesRequest) {
            resultAttemptMarked = backgroundRequestBetweenArmAndClick
              ? !resultAttemptBoundToRealClick
              : historicalResultPersistsInSourceAfterRequest
                ? !resultAttemptBoundToResultGeneration
                : true;
          }
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
      } else if (body.includes("__xwsResultAttemptObserver.observe")) {
        currentAttemptMarker = body.match(/setAttribute\('data-xws-result-attempt',\s*"([^"]+)"\)/u)?.[1] || "";
        resultAttemptBoundToSource = body.includes("resultNodeId") || body.includes("source.parentElement");
        resultAttemptBoundToRequest = body.includes("isOwnedAttempt");
        resultAttemptBoundToRealClick = body.includes("isOwnedAttempt");
        resultAttemptBoundToResultGeneration = body.includes("isOwnedAttempt");
        resultAttemptMarked = false;
        send(Boolean(currentAttemptMarker));
      } else if (body.includes("diagnostics.armAttempt")) {
        requestStartedAfterClick = false;
        resultAttemptMarked = false;
        send(true);
      } else if (body.includes("diagnostics.isClickObserved")) {
        send(startClickObserved);
      } else if (body.includes("diagnostics.isStarted")) {
        startupChecks += 1;
        if (delayedCollectionRequest && started && startupChecks >= 42) requestStartedAfterClick = true;
        send(body.includes("started: Boolean")
          ? { started: started && requestStartedAfterClick, failed: false }
          : started && requestStartedAfterClick);
      } else if (body.includes("const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')].filter(visible)")) {
        resultAttemptChecks += 1;
        resultAttemptMarked = Boolean(
          started
          && currentAttemptMarker
          && requestStartedAfterClick
          && (!delayedCollectionResult || resultAttemptChecks >= 12)
          && (!backgroundRequestBetweenArmAndClick || !resultAttemptBoundToRealClick)
          && (!historicalResultRemountsAfterStart || !resultAttemptBoundToSource)
          && (!historicalResultRemountsInSourceAfterStart || !resultAttemptBoundToRequest)
          && (!historicalResultPersistsInSourceAfterRequest || !resultAttemptBoundToResultGeneration)
          && (!resultMutationPrecedesRequest || resultAttemptBoundToResultGeneration)
        );
        send({
          text: resultAttemptMarked ? "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\\n商品数量：2" : "",
          visibleText: resultAttemptMarked ? "商品数量：2" : "市场分析",
          title: "浴缸_淘宝搜索",
          diagnostics: {
            visibility: "visible",
            readyState: "complete",
            requests: started && requestStartedAfterClick ? [{ apiKey: "request", flag: "XWS_PAGE_REQUEST_1", status: 200, pending: false }] : [],
            messages: [],
          },
          ...(body.includes("attemptFailed:")
            ? { attemptFailed: collectionFailsAfterStartup }
            : {}),
        });
      } else if (body.includes("__xwsMarkResultAttempt")) {
        resultAttemptChecks += 1;
        resultAttemptMarked = Boolean(
          started
          && currentAttemptMarker
          && requestStartedAfterClick
          && (!delayedCollectionResult || resultAttemptChecks >= 12)
          && (!backgroundRequestBetweenArmAndClick || !resultAttemptBoundToRealClick)
          && (!historicalResultRemountsAfterStart || !resultAttemptBoundToSource)
          && (!historicalResultRemountsInSourceAfterStart || !resultAttemptBoundToRequest)
          && (!historicalResultPersistsInSourceAfterRequest || !resultAttemptBoundToResultGeneration)
          && (!resultMutationPrecedesRequest || resultAttemptBoundToResultGeneration)
        );
        send(resultAttemptMarked);
      } else if (body.includes("element.getAttribute('data-xws-result-attempt') ===")
        && body.includes("return { ready: true")) {
        send(started && resultAttemptMarked
          ? { ready: true, text: "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2" }
          : { ready: false, count: 0 });
      } else if (body.includes("loadingMasks")) {
        if (sortRequiresSettledDomClick) radioReady = true;
        send({ ok: true, ready: true });
      } else if (sortRequiresSettledDomClick && body.includes("label.click()")) {
        settledSortClicked = radioReady;
        send({ ok: settledSortClicked });
      } else if (body.includes("return [...document.querySelectorAll('.el-dialog__wrapper')]")) {
        send([
          {
            text: "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2",
            attemptMarker: "historical-attempt",
          },
          {
            text: "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2",
            attemptMarker: currentAttemptMarker,
          },
        ]);
      } else if (body.includes("data-xws-export-csv") && csvExportMissing) {
        send({ ok: false, reason: "export control is missing", count: 0 });
      } else if (body.includes("result dialog changed") && body.includes("export control is ambiguous")) {
        send({ ok: true });
      } else if (body.includes("element.setAttribute('data-xws-export-menu-baseline'")) {
        hiddenXlsxMenuBaselined = !(staleXlsxMenuHidden || staleXlsxMenuHiddenWithoutAria)
          || !body.includes("if (visible(element))");
        send({
          ok: true,
          menuIds: staleXlsxMenuHidden || staleXlsxMenuVisibleOwned || xlsxMenuAriaIdChanges ? ["current-menu"] : [],
          hadVisibleOwnedItem: staleXlsxMenuVisibleOwned,
          hadVisibleItem: staleXlsxMenuVisible || staleXlsxMenuVisibleOwned,
        });
      } else if (body.includes("data-xws-export-menu-was-visible")
        && body.includes("items.length > 0")
        && body.includes("items.every")) {
        send(!staleXlsxMenuVisibleOwned || xlsxCaretClicks >= 1);
      } else if (body.includes("data-xws-export-xlsx")) {
        xlsxMenuProbes += 1;
        if (staleXlsxMenuVisibleOwned && body.includes("currentMenuIds")) {
          send(xlsxCaretClicks >= 2);
        } else if (xlsxMenuAriaIdChanges) {
          send(body.includes("currentMenuIds") && body.includes("getAttribute('aria-controls')"));
        } else if ((staleXlsxMenuVisible && !body.includes("data-xws-export-menu-baseline"))
          || (staleXlsxMenuHidden && body.includes("currentMenuIds"))) {
          send(true);
        } else if (staleXlsxMenuHiddenWithoutAria) {
          send(hiddenXlsxMenuBaselined
            && body.includes("becameVisible")
            && body.includes(": appearedForClick"));
        } else if (staleXlsxMenuHidden && !hiddenXlsxMenuBaselined) {
          send(true);
        } else {
          send(!xlsxMenuMountsLate || xlsxMenuProbes >= 2);
        }
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
        send({ text: resultAttemptMarked ? "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2" : "", title: "浴缸_淘宝搜索" });
      } else if (full && startClickMissesOnce && startClicks === 1 && body.includes("title: document.title")) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "start result dialog did not open" }));
      } else if (full && started && body.includes("商品数量")) {
        send({ text: resultAttemptMarked ? "【 浴缸 】销量排序Top2 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 1 页，已成功获取：第 1 ~ 1 页\n商品数量：2" : "", title: "浴缸_淘宝搜索" });
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
      getHealthCalls: () => healthCalls,
      getTargetsCalls: () => targetsCalls,
      getNewCalls: () => newCalls,
      getMarketAnalysisClicks: () => marketAnalysisClicks,
      getStartClicks: () => startClicks,
      getStartDomClicks: () => startDomClicks,
      getXlsxMenuProbes: () => xlsxMenuProbes,
      getXlsxCaretClicks: () => xlsxCaretClicks,
    }));
  });
}

test("rejects a non-Edge Proxy before target discovery or browser actions", async () => {
  const proxy = await startFakeProxy({ browserId: "browser-service" });
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
    assert.equal(result.code, 1);
    assert.match(result.stderr, /browser mismatch.*edge.*browser-service/iu);
    assert.equal(proxy.getHealthCalls(), 1);
    assert.equal(proxy.getTargetsCalls(), 0);
    assert.equal(proxy.getNewCalls(), 0);
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("rejects a disconnected Edge Proxy before target discovery", async () => {
  const proxy = await startFakeProxy({ proxyConnected: false });
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
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not connected to edge/iu);
    assert.equal(proxy.getHealthCalls(), 1);
    assert.equal(proxy.getTargetsCalls(), 0);
    assert.equal(proxy.getNewCalls(), 0);
  } finally {
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

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
    const intent = JSON.parse(await readFile(path.join(runtime, runDirs[0], "export-intent-csv.json"), "utf8"));
    assert.equal(intent.status, "ACCEPTED");
    assert.equal(intent.expectedProgress.rowCount, 2);
    assert.equal(intent.outputDir, path.resolve(output));
    assert.equal(proxy.getStartClicks(), 1);
    assert.equal(proxy.getStartDomClicks(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("rejects an export intent when the export target cannot be activated", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({ full: true, outputPath: path.join(output, "result.csv"), exportActivationFails: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime, XWS_ADAPTIVE_LOCK_OWNER: "1" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /target activation failed/u);
    const runDirs = await (await import("node:fs/promises")).readdir(runtime);
    const intent = JSON.parse(await readFile(path.join(runtime, runDirs[0], "export-intent-csv.json"), "utf8"));
    assert.equal(intent.status, "REJECTED");
    assert.equal(intent.reason, "export_action_failed");
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("rejects an export intent when the export action never starts", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({ full: true, outputPath: path.join(output, "result.csv"), csvExportMissing: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    const runDirs = await (await import("node:fs/promises")).readdir(runtime);
    const intent = JSON.parse(await readFile(path.join(runtime, runDirs[0], "export-intent-csv.json"), "utf8"));
    assert.equal(intent.status, "REJECTED");
    assert.equal(intent.reason, "export_action_failed");
    assert.equal(intent.options.frequency.min, 10);
    assert.equal(intent.options.stallSeconds, 120);
    assert.equal(intent.options.allowTrial, false);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow falls back to a DOM click when coordinate clicks do not start collection", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({ full: true, outputPath: path.join(output, "result.csv"), startRequiresDomClick: true });
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
    assert.match(result.stdout, /COLLECTION_START_DOM_FALLBACK/u);
    assert.equal(proxy.getStartClicks(), 1);
    assert.equal(proxy.getStartDomClicks(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow reconciles result ownership when the result mutates before its request starts", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    resultMutationPrecedesRequest: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow rejects a background request between arm and the real start click", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    backgroundRequestBetweenArmAndClick: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /collection did not start/iu);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow rejects historical source content after a current request without a new result generation", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    historicalResultPersistsInSourceAfterRequest: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--stall-seconds", "60",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /no page progress/iu);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow does not click again while the first start click is awaiting its request", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    delayedCollectionRequest: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getStartClicks(), 1);
    assert.equal(proxy.getStartDomClicks(), 0);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow retries once after an observed click produces no collection request", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    startClickWithoutRequestOnce: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getStartClicks(), 1);
    assert.equal(proxy.getStartDomClicks(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow rejects a current collection failure that arrives after startup", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    collectionFailsAfterStartup: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /collection request failed/iu);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow keeps waiting after startup evidence before a delayed result dialog appears", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    delayedCollectionResult: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getStartClicks(), 1);
    assert.equal(proxy.getStartDomClicks(), 0);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow rejects a remounted historical result dialog", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    historicalResultRemountsAfterStart: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--stall-seconds", "60",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /no page progress/iu);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow rejects historical result content remounted inside the source dialog", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    historicalResultRemountsInSourceAfterStart: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /collection did not start/iu);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow closes a stale visible XLSX menu without ARIA ownership before reopening it", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    xlsxMenuMountsLate: true,
    staleXlsxMenuVisible: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv,xlsx-images",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getXlsxCaretClicks(), 2);
    assert.equal(proxy.getXlsxMenuProbes(), 2);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow waits when the current caret ARIA id points to an already visible old menu", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    xlsxMenuMountsLate: true,
    staleXlsxMenuVisibleOwned: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv,xlsx-images",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getXlsxCaretClicks(), 2);
    assert.equal(proxy.getXlsxMenuProbes(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow accepts a newly mounted XLSX menu after the caret ARIA id changes", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    xlsxMenuAriaIdChanges: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv,xlsx-images",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getXlsxCaretClicks(), 1);
    assert.equal(proxy.getXlsxMenuProbes(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow accepts a hidden XLSX menu owned by the current caret", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    xlsxMenuMountsLate: true,
    staleXlsxMenuHidden: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv,xlsx-images",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getXlsxMenuProbes(), 1);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    await new Promise((resolve) => proxy.server.close(resolve));
  }
});

test("full flow accepts one XLSX menu that transitions from hidden to visible without ARIA", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "xws-download-"));
  const runtime = await mkdtemp(path.join(os.tmpdir(), "xws-runtime-"));
  const proxy = await startFakeProxy({
    full: true,
    outputPath: path.join(output, "result.csv"),
    staleXlsxMenuHiddenWithoutAria: true,
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--keyword", "浴缸",
        "--pages", "1-1",
        "--frequency", "10-10",
        "--export", "csv,xlsx-images",
        "--output-dir", output,
        "--proxy", `http://127.0.0.1:${proxy.port}`,
      ], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(proxy.getXlsxCaretClicks(), 1);
    assert.equal(proxy.getXlsxMenuProbes(), 1);
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
    assert.match(result.stdout, /"event":"EXPORT_STARTED","format":"csv","reason":"final"/u);
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
