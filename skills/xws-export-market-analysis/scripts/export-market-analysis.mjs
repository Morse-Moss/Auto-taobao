#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_HEADERS,
  assertProxyBrowserHealth,
  classifyCollection,
  collectionActivitySignature,
  collectionDeadlineMs,
  collectionResultSnapshot,
  collectionStallReason,
  createCollectionAttemptTracker,
  detectRiskMarkers,
  isSuccessfulCollectionResponse,
  parseOptions,
  parseProgressText,
  resolveOwnedExportProgress,
  selectExportResultDialog,
  selectObservedCollectionResult,
  selectPendingRequest,
  validateDataset,
} from "./flow.mjs";
import { classifyDiagnosticState, normalizeDiagnosticSnapshot } from "./diagnostics.mjs";
import { buildSearchInputExpression } from "./search-input.mjs";
import { acquireMarketAnalysisLock, marketAnalysisLockPath } from "./runtime-lock.mjs";

export { marketAnalysisLockPath };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "Downloads");
const TAOBAO_HOME = "https://www.taobao.com/";
const SEARCH_ORIGIN = "https://s.taobao.com";
const EXPORT_SETTLEMENT_MS = 60 * 60 * 1_000;
// Stall-triggered partial export must be given enough time for the plugin to
// generate and settle the CSV; a 30s window reliably timed out, which voided
// every partial part and forced full restarts from page 1.
const PARTIAL_EXPORT_SETTLEMENT_MS = 5 * 60 * 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function helpText() {
  return `Usage: node export-market-analysis.mjs [options]

Starts from a logged-in Taobao home tab and runs Xiaowangshen market analysis.

Options:
  --keyword TEXT          Required search keyword, for example 浴缸
  --from-taobao-home     Open/use Taobao home before searching (default)
  --channel all|taobao|tmall
  --sort relevance|sales|credit|price-low|price-high (default: sales)
  --pages START-END       Search page range (default: 1-40)
  --price MIN-MAX         Price range, or MIN-unlimited (default: 0-unlimited)
  --frequency MIN-MAX     Plugin frequency in seconds, minimum 10 (default: 10-15)
  --export csv,xlsx,xlsx-images (default: csv,xlsx-images)
  --output-dir DIR        Download directory (default: ~/Downloads)
  --allow-trial           Permit the visible Xiaowangshen free-trial action
  --export-partial-on-stall  Save the currently collected rows when collection stalls
  --prepare-only          Configure the task and stop before starting collection
  --poll-seconds N        Progress polling interval, minimum 2 (default: 8)
  --stall-seconds N       No-progress threshold, minimum 60 (default: 120)
  --proxy URL             Shared web-access Proxy (default: http://127.0.0.1:3456)
  --self-test             Run network-free checks
  --help                  Show this help
`;
}

function humanRequired(reason, details = {}) {
  const error = new Error(reason);
  error.code = "HUMAN_REQUIRED";
  error.details = details;
  return error;
}

function stalled(reason, details = {}) {
  const error = new Error(reason);
  error.code = "STALLED";
  error.details = details;
  return error;
}

function adoptionRejected(reason, details = {}) {
  const error = new Error(reason);
  error.code = "ADOPTION_REJECTED";
  error.details = details;
  return error;
}

async function request(proxy, endpoint, options = {}) {
  const response = await fetch(`${proxy}${endpoint}`, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Proxy returned invalid JSON for ${endpoint}`);
  }
  if (!response.ok || data?.error) {
    const detail = String(data?.error || text || "").replace(/[\r\n]+/gu, " ").slice(0, 300);
    throw new Error(`Proxy ${endpoint} failed${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

async function listTargets(proxy) {
  const data = await request(proxy, "/targets");
  return Array.isArray(data) ? data : (Array.isArray(data?.value) ? data.value : []);
}

async function evaluate(proxy, target, expression) {
  const data = await request(proxy, `/eval?target=${encodeURIComponent(target)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: expression,
  });
  return data?.value;
}

async function clickAt(proxy, target, selector) {
  await request(proxy, `/bringToFront?target=${encodeURIComponent(target)}`);
  return request(proxy, `/clickAt?target=${encodeURIComponent(target)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: selector,
  });
}

async function clickDom(proxy, target, selector) {
  return request(proxy, `/click?target=${encodeURIComponent(target)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: selector,
  });
}

// Export controls sit behind the plugin's loading mask while a page fetch is
// hung, so CDP coordinate clicks (clickAt) hit the mask and silently do
// nothing. Synthetic element-targeted events bypass hit-testing; verified to
// trigger the plugin's export even mid-collection.
async function clickExportControl(proxy, target, selector) {
  await request(proxy, `/bringToFront?target=${encodeURIComponent(target)}`);
  return evaluate(proxy, target, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'export control missing' };
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, options));
    }
    return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60) };
  })()`);
}

async function screenshot(proxy, target, file) {
  return request(proxy, `/screenshot?target=${encodeURIComponent(target)}&file=${encodeURIComponent(file)}`);
}

function isPage(target) {
  return target?.type === "page" && Boolean(target.targetId);
}

function isHome(target) {
  if (!isPage(target)) return false;
  try {
    const url = new URL(target.url);
    return url.origin === "https://www.taobao.com";
  } catch {
    return false;
  }
}

function isSearch(target, keyword) {
  if (!isPage(target)) return false;
  try {
    const url = new URL(target.url);
    return url.origin === SEARCH_ORIGIN && url.pathname === "/search" && url.searchParams.get("q") === keyword;
  } catch {
    return false;
  }
}

async function waitForTarget(proxy, predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(proxy);
    const found = targets.filter(predicate).at(-1);
    if (found) return found;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForReadyTarget(proxy, predicate, timeoutMs, description, { onCandidate } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = (await listTargets(proxy)).filter(predicate);
    for (const target of targets) {
      onCandidate?.(target);
      try {
        if (await evaluate(proxy, target.targetId, "document.readyState") === "complete") return target;
      } catch {
        // The target can be replaced while its navigation is still settling.
      }
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const ownedTargets = new Map();

function rememberOwnedTarget(runMarker, targetId) {
  if (!targetId) return;
  if (!ownedTargets.has(runMarker)) ownedTargets.set(runMarker, new Set());
  ownedTargets.get(runMarker).add(targetId);
}

export async function cleanupOwnedTargets(proxy, runMarker, targetIds = ownedTargets.get(runMarker) || []) {
  const closed = [];
  const failed = [];
  try {
    for (const targetId of new Set(targetIds)) {
      try {
        await request(proxy, `/close?target=${encodeURIComponent(targetId)}`);
        closed.push(targetId);
      } catch (error) {
        failed.push({ targetId, error: String(error?.message ?? error) });
      }
    }
  } finally {
    ownedTargets.delete(runMarker);
  }
  return { closed, failed };
}

async function labelTarget(proxy, targetId, runMarker) {
  rememberOwnedTarget(runMarker, targetId);
  try {
    await request(proxy, `/label?target=${encodeURIComponent(targetId)}&label=${encodeURIComponent(runMarker)}`);
  } catch (error) {
    if (!String(error?.message ?? error).includes('未知端点')) throw error;
  }
}

async function discoverLabeledTarget(proxy, predicate, runMarker, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const targets = await listTargets(proxy);
    const owned = ownedTargets.get(runMarker) || new Set();
    const target = targets.find((candidate) => predicate(candidate)
      && (candidate.automationLabel === runMarker || owned.has(candidate.targetId)));
    if (target) return target;
    await sleep(250);
  }
  throw new Error(`No labeled ${description} tab is available`);
}

async function discoverHome(proxy, runMarker) {
  return discoverLabeledTarget(proxy, isHome, runMarker, "Taobao home");
}

async function discoverSearch(proxy, keyword, runMarker) {
  return discoverLabeledTarget(proxy, (target) => isSearch(target, keyword), runMarker, `Taobao search for ${keyword}`);
}

async function discoverUniqueSearchForAdoption(proxy, keyword) {
  const matches = (await listTargets(proxy)).filter((target) => isSearch(target, keyword));
  if (matches.length !== 1) {
    throw adoptionRejected(
      matches.length ? "live-result adoption found ambiguous search targets" : "live-result adoption found no search target",
      { targetCount: matches.length },
    );
  }
  return matches[0];
}

async function discoverExportSearch(proxy, keyword, runMarker, adoptLiveResult) {
  return adoptLiveResult
    ? discoverUniqueSearchForAdoption(proxy, keyword)
    : discoverSearch(proxy, keyword, runMarker);
}

async function visibleText(proxy, target) {
  return String(await evaluate(proxy, target, "document.body?.innerText || \"\""));
}

function ensureNoRisk(text, stage) {
  const markers = detectRiskMarkers(text);
  if (markers.length) throw humanRequired(`${stage} encountered a platform control`, { markers });
}

async function openTaobaoHome(proxy, runMarker, log) {
  const before = new Set((await listTargets(proxy)).map((target) => target.targetId));
  let created;
  try {
    created = await request(proxy, `/new?url=${encodeURIComponent(TAOBAO_HOME)}&label=${encodeURIComponent(runMarker)}`);
  } catch (error) {
    try {
      const candidates = (await listTargets(proxy)).filter((candidate) => isHome(candidate) && !before.has(candidate.targetId));
      if (candidates.length === 1) rememberOwnedTarget(runMarker, candidates[0].targetId);
    } catch {
      // Preserve the original /new failure when target enumeration also fails.
    }
    throw error;
  }
  rememberOwnedTarget(runMarker, created?.targetId || created?.value?.targetId);
  // Cold-started browsers and slow networks regularly exceed 30s on first load.
  const freshHome = await waitForReadyTarget(
    proxy,
    (candidate) => isHome(candidate) && !before.has(candidate.targetId),
    75_000,
    "a new Taobao home tab to finish loading",
    { onCandidate: (candidate) => rememberOwnedTarget(runMarker, candidate.targetId) },
  );
  await labelTarget(proxy, freshHome.targetId, runMarker);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const fresh = await discoverHome(proxy, runMarker);
    const text = await visibleText(proxy, fresh.targetId);
    ensureNoRisk(text, "Taobao home");
    if (text.includes("亲，请登录")) throw humanRequired("Taobao is not in a logged-in state", { stage: "home" });
    if (text.includes("我的淘宝")) {
      log("HOME_READY", { origin: "https://www.taobao.com/" });
      return;
    }
    await sleep(500);
  }
  throw humanRequired("Taobao login state could not be confirmed", { stage: "home" });
}

async function searchKeyword(proxy, keyword, runMarker, log) {
  const home = await discoverHome(proxy, runMarker);
  const value = JSON.stringify(keyword);
  const setKeyword = (targetId) => evaluate(proxy, targetId, buildSearchInputExpression(keyword));
  const setResult = await setKeyword(home.targetId);
  if (!setResult?.ok) throw new Error("Could not set the Taobao search keyword");

  const existingSearchTargets = new Set((await listTargets(proxy)).filter((target) => isSearch(target, keyword)).map((target) => target.targetId));
  let freshHome = await discoverHome(proxy, runMarker);
  const currentValueMatches = await evaluate(proxy, freshHome.targetId, `document.querySelector('#q')?.value === ${value}`);
  if (currentValueMatches !== true) {
    const retryResult = await setKeyword(freshHome.targetId);
    if (!retryResult?.ok) throw new Error("Could not restore the Taobao search keyword after page hydration");
    const restoredValueMatches = await evaluate(proxy, freshHome.targetId, `document.querySelector('#q')?.value === ${value}`);
    if (restoredValueMatches !== true) throw new Error("Taobao search keyword did not remain set after page hydration");
    freshHome = await discoverHome(proxy, runMarker);
  }
  // Taobao re-renders the search form after the controlled input update. Give
  // the submit button one render turn to settle before submitting. DOM submit
  // avoids stale autocomplete suggestions stealing a coordinate click.
  await sleep(1000);
  freshHome = await discoverHome(proxy, runMarker);
  const finalSet = await setKeyword(freshHome.targetId);
  if (!finalSet?.ok) throw new Error("Could not set the Taobao search keyword immediately before submit");
  const finalValueMatches = await evaluate(proxy, freshHome.targetId, `document.querySelector('#q')?.value === ${value}`);
  if (finalValueMatches !== true) throw new Error("Taobao search keyword changed before submit");
  let search;
  try {
    await clickDom(proxy, freshHome.targetId, "#J_TSearchForm button[type=submit]");
    search = await waitForReadyTarget(
      proxy,
      (candidate) => isSearch(candidate, keyword) && !existingSearchTargets.has(candidate.targetId),
      5_000,
      "new Taobao search results to finish loading",
      { onCandidate: (candidate) => rememberOwnedTarget(runMarker, candidate.targetId) },
    );
  } catch (error) {
    // A background tab or site handler can reject the DOM click. Use one
    // bounded coordinate fallback, then keep the same fresh-target checks.
    const fallbackHome = await discoverHome(proxy, runMarker);
    await clickAt(proxy, fallbackHome.targetId, "#J_TSearchForm button[type=submit]");
    try {
      search = await waitForReadyTarget(
      proxy,
      (candidate) => isSearch(candidate, keyword) && !existingSearchTargets.has(candidate.targetId),
      5_000,
      "new Taobao search results to finish loading",
      { onCandidate: (candidate) => rememberOwnedTarget(runMarker, candidate.targetId) },
    );
    } catch {
      // If Taobao's autocomplete handler wins both bounded clicks, navigate
      // the fresh, labeled home tab to the canonical search URL once.
      const currentHome = await discoverHome(proxy, runMarker);
      const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}&search_type=item&tab=all`;
      await request(proxy, `/navigate?target=${encodeURIComponent(currentHome.targetId)}&url=${encodeURIComponent(searchUrl)}`);
      search = await waitForReadyTarget(
        proxy,
        (candidate) => isSearch(candidate, keyword)
          && (candidate.automationLabel === runMarker || ownedTargets.get(runMarker)?.has(candidate.targetId)),
        30_000,
        "canonical Taobao search results to finish loading",
        { onCandidate: (candidate) => rememberOwnedTarget(runMarker, candidate.targetId) },
      );
    }
  }
  await labelTarget(proxy, search.targetId, runMarker);
  const freshSearch = await discoverSearch(proxy, keyword, runMarker);
  ensureNoRisk(await visibleText(proxy, freshSearch.targetId), "Taobao search");
  log("SEARCH_READY", { keyword, targetUrl: "https://s.taobao.com/search" });
}

async function inspectPlugin(proxy, target) {
  return evaluate(proxy, target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')].filter(visible);
    const wrapperText = wrappers.map((element) => element.innerText || '').join('\\n');
    return {
      pluginReady: Boolean(document.querySelector('.xws-market-analysis-btn')),
      permission: wrappers.some((element) => /购买\\/试用.*市场分析/u.test(element.innerText || '')),
      config: wrappers.find((element) => (element.innerText || '').includes('搜索频率'))?.innerText || '',
      result: wrappers.find((element) => (element.innerText || '').includes('商品数量'))?.innerText?.slice(0, 5000) || '',
      visibleText: wrapperText.slice(0, 6000),
    };
  })()`);
}

function isXiaowangshenLoginTarget(target) {
  if (!isPage(target)) return false;
  try {
    const url = new URL(target.url);
    return url.origin === "https://xiaowangshen.com" && /login/u.test(url.pathname);
  } catch {
    return false;
  }
}

async function ensurePluginSession(proxy, stage) {
  const targets = await listTargets(proxy);
  const loginTarget = targets.find(isXiaowangshenLoginTarget);
  if (!loginTarget) return;
  let text = "";
  try { text = await visibleText(proxy, loginTarget.targetId); } catch { /* target may close while redirecting */ }
  // Xiaowangshen keeps the /user/base-login path after a successful QR/account
  // login. The authenticated account page exposes the account and a logout
  // action, so URL alone is not sufficient to classify it as a login wall.
  if (/退出/u.test(text) && /(普通用户|专业版|账号安全)/u.test(text)) return;
  throw humanRequired(`${stage} requires Xiaowangshen login`, {
    stage,
    targetId: loginTarget.targetId,
    url: loginTarget.url,
    markers: ["XIAOWANGSHEN_LOGIN"],
    visibleText: text.slice(0, 500),
  });
}

async function waitForPlugin(proxy, keyword, runMarker, log) {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    let phase = "discover";
    try {
      const target = await discoverSearch(proxy, keyword, runMarker);
      phase = "visibleText";
      const text = await visibleText(proxy, target.targetId);
      ensureNoRisk(text, "Taobao search");
      phase = "inspectPlugin";
      const state = await inspectPlugin(proxy, target.targetId);
      if (state.pluginReady) {
        log("PLUGIN_READY", { keyword });
        return;
      }
    } catch (error) {
      if (error.code === "HUMAN_REQUIRED") throw error;
      lastError = error.message;
      log("PLUGIN_PROBE_ERROR", { phase, error: lastError.slice(0, 300) });
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for the Xiaowangshen toolbar${lastError ? `: ${lastError}` : ""}`);
}

async function clickVisibleText(proxy, keyword, runMarker, text, selector, attribute, log) {
  const target = await discoverSearch(proxy, keyword, runMarker);
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = elements.find((candidate) => visible(candidate) && (candidate.innerText || '').trim().includes(${JSON.stringify(text)}));
    if (!element) return { ok: false };
    element.setAttribute(${JSON.stringify(attribute)}, '1');
    return { ok: true };
  })()`;
  const marked = await evaluate(proxy, target.targetId, expression);
  if (!marked?.ok) throw new Error(`Could not find visible ${text}`);
  const fresh = await discoverSearch(proxy, keyword, runMarker);
  await clickAt(proxy, fresh.targetId, `[${attribute}="1"]`);
  log("CLICK", { action: text });
}

async function openMarketAnalysis(proxy, keyword, runMarker, log) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const target = await discoverSearch(proxy, keyword, runMarker);
    await clickAt(proxy, target.targetId, ".xws-market-analysis-btn");
    const deadline = Date.now() + (attempt === 1 ? 2_000 : 15_000);
    let domFallbackUsed = false;
    while (Date.now() < deadline) {
      await ensurePluginSession(proxy, "market analysis");
      const state = await inspectDialogs(proxy, keyword, runMarker);
      ensureNoRisk(state.visibleText, "Xiaowangshen dialog");
      if (state.permission || state.config) {
        log("MARKET_ANALYSIS_OPEN", { attempt });
        return;
      }
      if (!domFallbackUsed) {
        try {
          const fresh = await discoverSearch(proxy, keyword, runMarker);
          await clickDom(proxy, fresh.targetId, ".xws-market-analysis-btn");
          domFallbackUsed = true;
          log("MARKET_ANALYSIS_DOM_FALLBACK", { attempt, bounded: true });
        } catch {
          // Keep the normal bounded retry when the proxy has no DOM-click hook.
        }
      }
      await sleep(250);
    }
    if (attempt === 1) log("MARKET_ANALYSIS_RETRY", { reason: "dialog did not open" });
  }
  throw new Error("Xiaowangshen analysis dialog did not become ready");
}

async function inspectDialogs(proxy, keyword, runMarker) {
  const target = await discoverSearch(proxy, keyword, runMarker);
  return inspectPlugin(proxy, target.targetId);
}

async function handlePermission(proxy, keyword, runMarker, allowTrial, log) {
  const deadline = Date.now() + 15_000;
  let state;
  while (Date.now() < deadline) {
    state = await inspectDialogs(proxy, keyword, runMarker);
    ensureNoRisk(state.visibleText, "Xiaowangshen dialog");
    if (state.permission || state.config) break;
    await sleep(500);
  }
  if (!state?.permission && !state?.config) throw new Error("Xiaowangshen analysis dialog did not become ready");
  if (!state.permission) return;
  if (!allowTrial) throw humanRequired("Xiaowangshen trial permission requires explicit --allow-trial", { stage: "permission" });
  await clickVisibleText(proxy, keyword, runMarker, "免费试用", "button", "data-xws-trial", log);
  const trialDeadline = Date.now() + 15_000;
  let domFallbackUsed = false;
  while (Date.now() < trialDeadline) {
    const next = await inspectDialogs(proxy, keyword, runMarker);
    ensureNoRisk(next.visibleText, "Xiaowangshen trial dialog");
    if (!next.permission && next.config) {
      log("TRIAL_READY", { authorized: true });
      return;
    }
    if (next.permission && !domFallbackUsed) {
      const fresh = await discoverSearch(proxy, keyword, runMarker);
      await clickDom(proxy, fresh.targetId, '[data-xws-trial="1"]');
      log("TRIAL_DOM_FALLBACK", { bounded: true });
      domFallbackUsed = true;
    }
    await sleep(500);
  }
  throw new Error("Trial dialog did not close after the authorized action");
}

export function sortValue(sort) {
  return {
    relevance: "_coefp",
    sales: "_sale",
    credit: "_ratesum",
    "price-low": "bid",
    "price-high": "_bid",
  }[sort];
}

function sortLabel(sort) {
  return {
    relevance: "综合排序",
    sales: "销量排序",
    credit: "信用排序",
    "price-low": "价格从低到高排序",
    "price-high": "价格从高到低排序",
  }[sort];
}

function channelValue(channel) {
  return { all: "all", taobao: "pc_taobao", tmall: "mall" }[channel];
}

export function configurationContractDiff(expected, actual) {
  const differences = {};
  const record = (name, expectedValue, actualValue) => {
    if (actualValue !== expectedValue) differences[name] = { expected: expectedValue, actual: actualValue };
  };
  record("dialog", true, actual?.ok === true);
  record("keyword", expected.keyword, actual?.keyword);
  record("channel", expected.channel, actual?.channel);
  record("sort", expected.sort, actual?.sort);
  record("startButton", expected.hasStart, actual?.hasStart);
  const names = ["pageStart", "pageEnd", "priceMin", "priceMax", "frequencyMin", "frequencyMax"];
  names.forEach((name, index) => {
    if (name === "priceMax" && expected.spinners[index] === "" && actual?.priceMaxUnlimited === true) return;
    record(name, expected.spinners[index], actual?.spinners?.[index]);
  });
  return differences;
}

async function configureAnalysis(proxy, options, runMarker, log) {
  const target = await discoverSearch(proxy, options.keyword, runMarker);
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => visible(element) && (element.innerText || '').includes('搜索频率'));
    if (!dialog) return { ok: false, reason: 'config dialog missing' };
    const textInputs = [...dialog.querySelectorAll('input.el-input__inner:not([role=spinbutton]):not([readonly])')];
    const keywordInput = textInputs[0];
    if (!keywordInput) return { ok: false, reason: 'keyword input missing' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(keywordInput, ${JSON.stringify(options.keyword)});
    keywordInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(options.keyword)} }));
    keywordInput.dispatchEvent(new Event('change', { bubbles: true }));
    const spinners = [...dialog.querySelectorAll('input[role=spinbutton]')];
    // Xiaowangshen validates start <= end on every input event. Set the end
    // page first so a later segment (for example 9-16) is not clamped back to
    // page 1 while the previous segment's end value is still present.
    const values = [${options.pages.end}, ${options.pages.start}, ${options.price.min}, ${options.price.max === null ? "''" : JSON.stringify(options.price.max)}, ${options.frequency.min}, ${options.frequency.max}];
    const spinnerOrder = [1, 0, 2, 3, 4, 5];
    values.forEach((value, position) => {
      const input = spinners[spinnerOrder[position]];
      if (!input) return;
      setter.call(input, String(value));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    return { ok: true };
  })()`;
  const setup = await evaluate(proxy, target.targetId, expression);
  if (!setup?.ok) throw new Error(`Could not configure Xiaowangshen: ${setup?.reason || "unknown"}`);
  // Page bounds are validated asynchronously by the plugin. Re-assert them
  // in separate DOM turns so a segment start greater than the previous end is
  // not overwritten by the component's delayed re-render.
  if (options.pages.start > 1) {
    let fresh = await discoverSearch(proxy, options.keyword, runMarker);
    await evaluate(proxy, fresh.targetId, `(() => {
      const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => {
        const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
          && (element.innerText || '').includes('搜索频率');
      });
      const input = dialog?.querySelectorAll('input[role=spinbutton]')[1];
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(String(options.pages.end))});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(String(options.pages.end))} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);
    await sleep(350);
    fresh = await discoverSearch(proxy, options.keyword, runMarker);
    await evaluate(proxy, fresh.targetId, `(() => {
      const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => {
        const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
          && (element.innerText || '').includes('搜索频率');
      });
      const input = dialog?.querySelectorAll('input[role=spinbutton]')[0];
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(String(options.pages.start))});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(String(options.pages.start))} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);
    await sleep(350);
  }
  const loadingExpression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => visible(element) && (element.innerText || '').includes('搜索频率'));
    if (!dialog) return { ok: false, ready: false, reason: 'config dialog missing' };
    const loadingMasks = [...dialog.querySelectorAll('.el-loading-mask')];
    const active = loadingMasks.some((mask) => {
      if (mask.classList.contains('el-loading-fade-leave') || mask.classList.contains('el-loading-fade-leave-active')) return false;
      const style = getComputedStyle(mask);
      const rect = mask.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && rect.width > 0 && rect.height > 0;
    });
    return { ok: true, ready: !active, loadingMasks: loadingMasks.length };
  })()`;
  const waitForDialogSettle = async () => {
    const deadline = Date.now() + 30_000;
    let stableAt = 0;
    while (Date.now() < deadline) {
      const current = await discoverSearch(proxy, options.keyword, runMarker);
      const state = await evaluate(proxy, current.targetId, loadingExpression);
      if (state?.ready) {
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 300) return;
      } else {
        stableAt = 0;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for Xiaowangshen filters to settle');
  };
  const clickRadio = async (value) => {
    const deadline = Date.now() + 3_000;
    let lastReason = value;
    while (Date.now() < deadline) {
      const current = await discoverSearch(proxy, options.keyword, runMarker);
      const clicked = await evaluate(proxy, current.targetId, `(() => {
        const visible = (element) => {
          if (!element) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => visible(element) && (element.innerText || '').includes('搜索频率'));
        if (!dialog) return { ok: false, reason: 'config dialog missing' };
        const input = dialog.querySelector('input[type=radio][value="' + ${JSON.stringify(value)} + '"]');
        const label = input?.closest('label');
        if (!label) return { ok: false, reason: 'radio label missing' };
        label.click();
        return { ok: true };
      })()`);
      if (clicked?.ok) break;
      lastReason = clicked?.reason || value;
      await sleep(100);
    }
    if (Date.now() >= deadline) throw new Error(`Could not select Xiaowangshen radio: ${lastReason}`);
    const settleDeadline = Date.now() + 3_000;
    while (Date.now() < settleDeadline) {
      const fresh = await discoverSearch(proxy, options.keyword, runMarker);
      const selected = await evaluate(proxy, fresh.targetId, `(() => {
        const input = [...document.querySelectorAll('.el-dialog__wrapper input[type=radio]')]
          .find((candidate) => candidate.value === ${JSON.stringify(value)});
        return Boolean(input?.checked);
      })()`);
      if (selected) return;
      await sleep(100);
    }
    throw new Error(`Xiaowangshen radio did not settle: ${value}`);
  };
  await waitForDialogSettle();
  await clickRadio(channelValue(options.channel));
  await waitForDialogSettle();
  await clickRadio(sortValue(options.sort));

  const verificationExpression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialog = [...document.querySelectorAll('.el-dialog__wrapper')].find((element) => visible(element) && (element.innerText || '').includes('搜索频率'));
    if (!dialog) return { ok: false, reason: 'config dialog missing' };
    const keywordInput = [...dialog.querySelectorAll('input.el-input__inner:not([role=spinbutton]):not([readonly])')][0];
    const spinners = [...dialog.querySelectorAll('input[role=spinbutton]')];
    const start = [...dialog.querySelectorAll('button')].find((button) => (button.innerText || '').trim() === '开始分析');
    if (start) start.setAttribute('data-xws-start', '1');
    const priceMaxInput = spinners[3];
    return {
      ok: true,
      keyword: keywordInput?.value || '',
      channel: dialog.querySelector('input[type=radio][value="' + ${JSON.stringify(channelValue(options.channel))} + '"]')?.checked || false,
      sort: dialog.querySelector('input[type=radio][value="' + ${JSON.stringify(sortValue(options.sort))} + '"]')?.checked || false,
      spinners: spinners.map((input) => input.value),
      priceMaxUnlimited: Boolean(priceMaxInput
        && priceMaxInput.placeholder === '不限'
        && priceMaxInput.getAttribute('max') === 'Infinity'
        && (priceMaxInput.value === '' || priceMaxInput.value === '0')),
      hasStart: Boolean(start),
    };
  })()`;
  const expectedSpinners = [
    String(options.pages.start), String(options.pages.end), String(options.price.min), options.price.max === null ? "" : String(options.price.max),
    String(options.frequency.min), String(options.frequency.max),
  ];
  const matches = (snapshot) => {
    if (!snapshot?.ok || !Array.isArray(snapshot.spinners)) return false;
    const spinnersMatch = expectedSpinners.every((value, index) => (
      options.price.max === null && index === 3
        ? snapshot.spinners[index] === value || snapshot.priceMaxUnlimited === true
        : snapshot.spinners[index] === value
    ));
    return snapshot.keyword === options.keyword && snapshot.channel && snapshot.sort && snapshot.hasStart && spinnersMatch;
  };
  const deadline = Date.now() + 3_000;
  let snapshot;
  let stableAt = 0;
  while (Date.now() < deadline) {
    const current = await discoverSearch(proxy, options.keyword, runMarker);
    snapshot = await evaluate(proxy, current.targetId, verificationExpression);
    if (matches(snapshot)) {
      if (!stableAt) stableAt = Date.now();
      if (Date.now() - stableAt >= 1_000) break;
    } else {
      stableAt = 0;
    }
    await sleep(100);
  }
  if (!matches(snapshot) || !stableAt || Date.now() - stableAt < 1_000) {
    const expected = {
      keyword: options.keyword,
      channel: true,
      sort: true,
      spinners: expectedSpinners,
      hasStart: true,
    };
    const differences = configurationContractDiff(expected, snapshot);
    throw new Error(`Xiaowangshen configuration did not match the requested contract: ${JSON.stringify(differences)}`);
  }
  log("CONFIGURED", { keyword: options.keyword, channel: options.channel, sort: options.sort, pages: options.pages, frequency: options.frequency });
}

async function startAnalysis(proxy, keyword, runMarker, log, { resultWaitMs = 60_000 } = {}) {
  const attemptMarker = randomUUID();
  const initialTarget = await discoverSearch(proxy, keyword, runMarker);
  const trackingInstalled = await evaluate(proxy, initialTarget.targetId, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const start = document.querySelector('button[data-xws-start="1"]');
    const source = start?.closest('.el-dialog__wrapper');
    const diagnostics = window.__xwsCollectionDiag;
    if (!source || !visible(source) || diagnostics?.version !== 6) return false;
    for (const element of document.querySelectorAll('[data-xws-result-attempt]')) {
      element.removeAttribute('data-xws-result-attempt');
    }
    window.__xwsResultAttemptObserver?.disconnect();
    window.__xwsResultStartClickCleanup?.();
    const wrapperFor = (node) => node?.nodeType === Node.ELEMENT_NODE
      ? (node.matches?.('.el-dialog__wrapper') ? node : node.closest?.('.el-dialog__wrapper'))
      : node?.parentElement?.closest?.('.el-dialog__wrapper');
    const mark = (node) => {
      const wrapper = wrapperFor(node);
      if (!wrapper) return;
      const owned = diagnostics.isOwnedAttempt?.(${JSON.stringify(attemptMarker)}) === true;
      if (!owned || !(wrapper.innerText || '').includes('商品数量')) return;
      wrapper.setAttribute('data-xws-result-attempt', ${JSON.stringify(attemptMarker)});
    };
    const recordWrapper = (wrapper) => {
      if (!wrapper) return;
      diagnostics.recordResultMutation?.(${JSON.stringify(attemptMarker)}, wrapper);
      mark(wrapper);
    };
    const startButton = (target) => target?.closest?.('button[data-xws-start="1"]');
    const recordStartClick = (event) => {
      const button = startButton(event.target);
      if (!button || !source.contains(button)) return;
      diagnostics.recordStartClick?.(${JSON.stringify(attemptMarker)}, source);
    };
    const recordEndClick = (event) => {
      const button = startButton(event.target);
      if (button && source.contains(button)) {
        diagnostics.endStartClick?.(${JSON.stringify(attemptMarker)});
      }
    };
    window.addEventListener('click', recordStartClick, true);
    window.addEventListener('click', recordEndClick);
    window.__xwsResultStartClickCleanup = () => {
      window.removeEventListener('click', recordStartClick, true);
      window.removeEventListener('click', recordEndClick);
    };
    const observationRoot = document.body;
    window.__xwsResultAttemptObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const wrappers = [wrapperFor(mutation.target), ...[...(mutation.addedNodes || [])].map(wrapperFor)].filter(Boolean);
        for (const wrapper of new Set(wrappers)) recordWrapper(wrapper);
      }
    });
    window.__xwsResultAttemptObserver.observe(observationRoot, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.__xwsMarkResultAttempt = () => {
      const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')];
      for (const wrapper of wrappers) recordWrapper(wrapper);
      return wrappers.some((wrapper) => wrapper.getAttribute('data-xws-result-attempt') === ${JSON.stringify(attemptMarker)});
    };
    return true;
  })()`);
  if (!trackingInstalled) throw new Error("Could not bind collection attempt to its source dialog");

  const waitForStartup = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = await discoverSearch(proxy, keyword, runMarker);
      const state = await evaluate(proxy, target.targetId, `(() => {
        const diagnostics = window.__xwsCollectionDiag;
        return {
          started: Boolean(
            diagnostics
            && typeof diagnostics.isStarted === 'function'
            && diagnostics.isStarted(${JSON.stringify(attemptMarker)}),
          ),
          failed: Boolean(
            diagnostics
            && typeof diagnostics.isFailed === 'function'
            && diagnostics.isFailed(${JSON.stringify(attemptMarker)}),
          ),
        };
      })()`);
      if (state?.failed) throw new Error("Xiaowangshen collection request failed");
      if (state?.started) return true;
      await sleep(250);
    }
    return false;
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const target = await discoverSearch(proxy, keyword, runMarker);
    const armed = await evaluate(proxy, target.targetId, `(() => {
      const diagnostics = window.__xwsCollectionDiag;
      const source = document.querySelector('button[data-xws-start="1"]')
        ?.closest('.el-dialog__wrapper');
      if (!source || diagnostics?.version !== 6 || typeof diagnostics.armAttempt !== 'function') return false;
      diagnostics.armAttempt(${JSON.stringify(attemptMarker)}, source);
      return true;
    })()`);
    if (!armed) throw new Error("Collection attempt diagnostics are unavailable");
    if (attempt === 1) {
      await clickAt(proxy, target.targetId, "button[data-xws-start=\"1\"]");
    } else {
      await clickDom(proxy, target.targetId, "button[data-xws-start=\"1\"]");
      log("COLLECTION_START_DOM_FALLBACK", { attempt, bounded: true });
    }
    const initialWaitMs = Math.min(resultWaitMs, 10_000);
    let started = await waitForStartup(initialWaitMs);
    if (!started && attempt === 1) {
      const clickObserved = await evaluate(proxy, target.targetId, `(() => {
        const diagnostics = window.__xwsCollectionDiag;
        return Boolean(
          diagnostics
          && typeof diagnostics.isClickObserved === 'function'
          && diagnostics.isClickObserved(${JSON.stringify(attemptMarker)}),
        );
      })()`);
      if (clickObserved) {
        started = await waitForStartup(Math.max(0, resultWaitMs - initialWaitMs));
        if (!started) {
          log("COLLECTION_START_RETRY", {
            reason: "start click produced no collection request",
          });
          continue;
        }
      } else {
        log("COLLECTION_START_RETRY", { reason: "start click was not observed" });
        continue;
      }
    }
    if (started) {
      log("COLLECTION_STARTED", { attempt });
      return attemptMarker;
    }
  }
  throw new Error("Xiaowangshen collection did not start");
}

async function installCollectionDiagnostics(proxy, keyword, runMarker, pages, log) {
  const target = await discoverSearch(proxy, keyword, runMarker);
  const installed = await evaluate(proxy, target.targetId, `(() => {
    const range = ${JSON.stringify(pages)};
    if (window.__xwsCollectionDiag?.version === 6
      && window.__xwsCollectionDiag?.range?.start === range.start
      && window.__xwsCollectionDiag?.range?.end === range.end) {
      return { ok: true, reused: true };
    }
    const collectionResultSnapshot = ${collectionResultSnapshot.toString()};
    const selectPendingRequest = ${selectPendingRequest.toString()};
    const isSuccessfulCollectionResponse = ${isSuccessfulCollectionResponse.toString()};
    const createCollectionAttemptTracker = ${createCollectionAttemptTracker.toString()};
    const attemptTracker = createCollectionAttemptTracker(range);
    const resultNodeIds = new WeakMap();
    let nextResultNodeId = 1;
    const resultNodeId = (node) => {
      if (!node || (typeof node !== 'object' && typeof node !== 'function')) return '';
      let id = resultNodeIds.get(node);
      if (!id) {
        id = 'result-' + nextResultNodeId++;
        resultNodeIds.set(node, id);
      }
      return id;
    };
    const resultWrappers = () => [...document.querySelectorAll('.el-dialog__wrapper')];
    const state = { installed: true, installedAt: new Date().toISOString(), requests: [], messages: [], byFlag: Object.create(null), activeAttempt: '' };
    const resultSummary = (result) => {
      if (!result || typeof result !== 'object') return {};
      const resultKeys = Object.keys(result).slice(0, 40);
      let itemCount;
      for (const key of ['items', 'list', 'data', 'result']) {
        const value = result[key];
        if (Array.isArray(value)) { itemCount = value.length; break; }
        if (value && typeof value === 'object' && Array.isArray(value.items)) { itemCount = value.items.length; break; }
      }
      return { resultKeys, ...(Number.isInteger(itemCount) ? { itemCount } : {}) };
    };
    const originalPageRequest = window.xwsPageRequest?.__xwsDiagOriginal || window.xwsPageRequest;
    if (typeof originalPageRequest === 'function') {
      const wrappedPageRequest = function(option, flag, bool = false) {
        const params = option?.params && typeof option.params === 'object' ? option.params : {};
        const pageValue = Number(params.page ?? params.pageNum ?? params.currentPage);
        const record = {
          apiKey: String(option?.apiKey || ''),
          ...(Number.isInteger(pageValue) && pageValue > 0 ? { page: pageValue } : {}),
          flag: String(flag || ''),
          url: String(option?.url || '[mtop]'),
          method: String(option?.method || 'GET'),
          status: null,
          pending: true,
          startedAt: performance.now(),
        };
        state.requests.push(record);
        if (state.requests.length > 200) state.requests.shift();
        if (record.flag) {
          const queue = state.byFlag[record.flag] || [];
          queue.push(record);
          state.byFlag[record.flag] = queue;
        }
        if (attemptTracker.recordRequest(state.activeAttempt, record)) {
          record.attemptMarker = state.activeAttempt;
        }
        return originalPageRequest.call(this, option, flag, bool);
      };
      wrappedPageRequest.__xwsDiagWrapped = true;
      wrappedPageRequest.__xwsDiagVersion = 6;
      wrappedPageRequest.__xwsDiagOriginal = originalPageRequest;
      window.xwsPageRequest = wrappedPageRequest;
    }
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function(method, url, ...rest) {
      this.__xwsDiagMeta = { method, url };
      return originalOpen.call(this, method, url, ...rest);
    };
    proto.send = function(...args) {
      const meta = this.__xwsDiagMeta || { method: "GET", url: "[unknown]" };
      const record = { method: String(meta.method || "GET"), url: String(meta.url || "[unknown]"), status: null, pending: true, startedAt: performance.now() };
      state.requests.push(record);
      if (state.requests.length > 200) state.requests.shift();
      const finish = (error = "") => {
        if (!record.pending) return;
        record.pending = false;
        record.status = Number.isFinite(this.status) ? this.status : null;
        record.elapsedMs = Math.round(performance.now() - record.startedAt);
        if (error) record.error = String(error).slice(0, 300);
      };
      this.addEventListener("load", () => finish(), { once: true });
      this.addEventListener("error", () => finish("XHR_ERROR"), { once: true });
      this.addEventListener("timeout", () => finish("XHR_TIMEOUT"), { once: true });
      this.addEventListener("abort", () => finish("XHR_ABORT"), { once: true });
      return originalSend.apply(this, args);
    };
    window.addEventListener("message", (event) => {
      const type = event?.data?.type;
      if (typeof type !== "string" || !/_FINISH$/u.test(type)) return;
      const result = event.data.result;
      const error = result && typeof result === "object" ? result.error : "";
      const summary = resultSummary(result);
      const flag = type.replace(/_FINISH$/u, '');
      const request = selectPendingRequest(state.byFlag[flag]);
      if (request) {
        request.pending = false;
        request.status = Number.isFinite(result?.retCode) ? Number(result.retCode) : 200;
        request.elapsedMs = Math.round(performance.now() - request.startedAt);
        Object.assign(request, summary);
        if (error) request.error = String(error).slice(0, 300);
        if (request.attemptMarker) {
          attemptTracker.recordResponse(
            request.attemptMarker,
            {
              flag,
              retCode: result?.retCode,
              ret: result?.ret,
              status: result?.status,
              ...(error ? { error } : {}),
            },
          );
        }
      }
      state.messages.push({ type, ...summary, ...(error ? { error: String(error).slice(0, 300) } : {}) });
      if (state.messages.length > 200) state.messages.shift();
    });
    window.__xwsCollectionDiag = {
      installed: true,
      version: 6,
      range,
      armAttempt: (marker, source) => {
        state.activeAttempt = marker;
        const wrappers = resultWrappers();
        attemptTracker.arm(
          marker,
          collectionResultSnapshot(source?.innerText || ''),
          wrappers.map((wrapper) => collectionResultSnapshot(wrapper.innerText || '')),
          wrappers.map(resultNodeId),
        );
      },
      recordStartClick: (marker, source) => {
        if (state.activeAttempt !== marker) return;
        const wrappers = resultWrappers();
        attemptTracker.arm(
          marker,
          collectionResultSnapshot(source?.innerText || ''),
          wrappers.map((wrapper) => collectionResultSnapshot(wrapper.innerText || '')),
          wrappers.map(resultNodeId),
        );
        if (attemptTracker.isClickObserved?.(marker)) {
          attemptTracker.retryClick?.(marker);
        } else {
          attemptTracker.beginClick(marker);
        }
      },
      endStartClick: (marker) => {
        attemptTracker.endClick(marker);
      },
      recordResultMutation: (marker, source) => {
        attemptTracker.recordResult(
          marker,
          collectionResultSnapshot(source?.innerText || ''),
          resultNodeId(source),
        );
      },
      isClickObserved: (marker) => attemptTracker.isClickObserved(marker),
      isFailed: (marker) => attemptTracker.isFailed(marker),
      isStarted: (marker) => attemptTracker.isStarted(marker),
      isOwnedAttempt: (marker) => attemptTracker.isOwned(marker),
      snapshot: () => ({
        capturedAt: new Date().toISOString(),
        activeAttempt: state.activeAttempt,
        visibility: document.visibilityState,
        readyState: document.readyState,
        requests: state.requests,
        messages: state.messages,
        activity: attemptTracker.activity(state.activeAttempt),
      }),
    };
    return { ok: true, reused: false };
  })()`);
  if (!installed?.ok) {
    log("DIAGNOSTICS_UNAVAILABLE", { reason: "page did not return an install acknowledgement" });
    return;
  }
  log("DIAGNOSTICS_INSTALLED", { reused: Boolean(installed.reused) });
}

async function readCollectionSnapshot(proxy, options, runMarker, attemptMarker) {
  const target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
  const state = await evaluate(proxy, target.targetId, `(() => {
    const parseProgressText = ${parseProgressText.toString()};
    const selectObservedCollectionResult = ${selectObservedCollectionResult.toString()};
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    window.__xwsMarkResultAttempt?.();
    const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')].filter(visible);
    const entries = wrappers.map((element) => ({
      text: element.innerText || '',
      attemptMarker: element.getAttribute('data-xws-result-attempt') || '',
    }));
    let observed = null;
    try {
      observed = selectObservedCollectionResult(entries, {
        keyword: ${JSON.stringify(options.keyword)},
        sortLabel: ${JSON.stringify(sortLabel(options.sort))},
        requestedStart: ${Number(options.pages.start)},
        requestedEnd: ${Number(options.pages.end)},
      });
    } catch (error) {
      observed = { ambiguous: true, error: String(error?.message || error) };
    }
    const collectionDiagnostics = window.__xwsCollectionDiag;
    const trackerOwned = collectionDiagnostics?.isOwnedAttempt?.(${JSON.stringify(attemptMarker)}) === true;
    if (trackerOwned && observed && !observed.ambiguous) {
      wrappers[observed.index]?.setAttribute('data-xws-result-attempt', ${JSON.stringify(attemptMarker)});
      entries[observed.index].attemptMarker = ${JSON.stringify(attemptMarker)};
    }
    const ownedIndex = entries.findIndex((entry) => entry.attemptMarker === ${JSON.stringify(attemptMarker)});
    const owned = ownedIndex >= 0 ? entries[ownedIndex] : null;
    const text = observed?.text || '';
    const observedProgress = observed?.progress || parseProgressText(text);
    const visibleText = wrappers.map((element) => element.innerText || '').join('\\n');
    collectionDiagnostics?.recordProgressActivity?.(${JSON.stringify(attemptMarker)}, observedProgress);
    const diagnostics = collectionDiagnostics?.snapshot?.() || {
      capturedAt: new Date().toISOString(),
      visibility: document.visibilityState,
      readyState: document.readyState,
      requests: [],
      messages: [],
    };
    return {
      text: text.slice(0, 6000),
      observedProgress,
      observedAmbiguous: observed?.ambiguous === true,
      ownedText: owned?.text?.slice(0, 6000) || '',
      trackerOwned,
      owned: ownedIndex >= 0 && trackerOwned,
      visibleText: visibleText.slice(0, 6000),
      title: document.title,
      diagnostics,
      attemptFailed: collectionDiagnostics?.isFailed?.(${JSON.stringify(attemptMarker)}) === true,
    };
  })()`);
  return { ...state, diagnostics: normalizeDiagnosticSnapshot(state.diagnostics), targetId: target.targetId };
}

async function readLiveCollectionSnapshot(proxy, options, targetId) {
  const state = await evaluate(proxy, targetId, `(() => {
    const parseProgressText = ${parseProgressText.toString()};
    const selectObservedCollectionResult = ${selectObservedCollectionResult.toString()};
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const collectionDiagnostics = window.__xwsCollectionDiag;
    const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')].filter(visible);
    const entries = wrappers.map((element) => ({
      text: element.innerText || '',
      attemptMarker: element.getAttribute('data-xws-result-attempt') || '',
    }));
    let observed = null;
    try {
      observed = selectObservedCollectionResult(entries, {
        keyword: ${JSON.stringify(options.keyword)},
        sortLabel: ${JSON.stringify(sortLabel(options.sort))},
        requestedStart: ${Number(options.pages.start)},
        requestedEnd: ${Number(options.pages.end)},
      });
    } catch (error) {
      observed = { ambiguous: true, error: String(error?.message || error) };
    }
    const diagnostics = collectionDiagnostics?.snapshot?.() || {};
    const activeAttempt = String(diagnostics.activeAttempt || '');
    const requestEvidence = (diagnostics.requests || []).some((request) => (
      request.apiKey === 'request'
      && /^XWS_PAGE_REQUEST_[0-9]+$/u.test(String(request.flag || ''))
      && request.pending !== true
      && Number.isInteger(request.status)
      && request.status >= 200
      && request.status < 300
      && (!Number.isInteger(request.page) || request.page === ${Number(options.pages.start)})
    ));
    return {
      text: observed?.text || '',
      progress: observed?.progress || parseProgressText(observed?.text || ''),
      ambiguous: observed?.ambiguous === true,
      activeAttempt,
      trackerOwned: Boolean(activeAttempt && collectionDiagnostics?.isOwnedAttempt?.(activeAttempt) === true),
      requestEvidence,
      collectionRange: collectionDiagnostics?.range || null,
      visibleText: wrappers.map((element) => element.innerText || '').join('\\n'),
      title: document.title,
      diagnostics,
    };
  })()`);
  return { ...state, diagnostics: normalizeDiagnosticSnapshot(state.diagnostics), targetId };
}

async function bindOwnedResultMarker(proxy, targetId, options, progress, attemptMarker) {
  const bound = await evaluate(proxy, targetId, `(() => {
    const parseProgressText = ${parseProgressText.toString()};
    const selectObservedCollectionResult = ${selectObservedCollectionResult.toString()};
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
    };
    const collectionDiagnostics = window.__xwsCollectionDiag;
    if (!collectionDiagnostics?.isOwnedAttempt?.(${JSON.stringify(attemptMarker)})) return { ok: false, reason: 'attempt ownership is unavailable' };
    const entries = [...document.querySelectorAll('.el-dialog__wrapper')]
      .filter(visible)
      .map((element, index) => ({
        index,
        element,
        text: element.innerText || '',
        attemptMarker: element.getAttribute('data-xws-result-attempt') || '',
      }));
    let observed;
    try {
      observed = selectObservedCollectionResult(entries, {
        keyword: ${JSON.stringify(options.keyword)},
        sortLabel: ${JSON.stringify(sortLabel(options.sort))},
        requestedStart: ${Number(options.pages.start)},
        requestedEnd: ${Number(options.pages.end)},
      });
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
    if (!observed || !observed.progress.complete || observed.progress.completedEnd !== ${Number(progress.completedEnd)}) {
      return { ok: false, reason: 'live result changed before export' };
    }
    const wrapper = entries[observed.index]?.element;
    if (!wrapper) return { ok: false, reason: 'live result dialog disappeared before export' };
    for (const element of document.querySelectorAll('[data-xws-result-attempt]')) element.removeAttribute('data-xws-result-attempt');
    wrapper.setAttribute('data-xws-result-attempt', ${JSON.stringify(attemptMarker)});
    return { ok: true };
  })()`);
  if (!bound?.ok) throw adoptionRejected(bound?.reason || 'could not bind the owned live result');
}

async function refreshOwnedExportSnapshot(proxy, options, runMarker, attemptMarker) {
  const snapshot = await readCollectionSnapshot(proxy, options, runMarker, attemptMarker);
  ensureNoRisk(snapshot.visibleText, "Xiaowangshen export");
  try {
    const progress = resolveOwnedExportProgress(snapshot, {
      keyword: options.keyword,
      sortLabel: sortLabel(options.sort),
      requestedStart: options.pages.start,
      requestedEnd: options.pages.end,
    });
    return { ...snapshot, progress };
  } catch (error) {
    if (error?.code === "OWNED_RESULT_UNAVAILABLE") {
      error.exportFailureReason = "result_ownership_unavailable";
    }
    throw error;
  }
}

export function buildPartialStallManifest({
  runId,
  options,
  refreshedProgress,
  stallDetails = {},
  partial,
  runDir,
}) {
  return {
    status: "STALLED",
    partial: true,
    runId,
    options,
    progress: refreshedProgress,
    diagnosticKind: stallDetails.diagnosticKind || "UNKNOWN",
    stallEvidence: {
      screenshot: stallDetails.screenshot || "",
      diagnostics: stallDetails.diagnostics || "",
    },
    artifacts: partial.files,
    validation: partial.validation,
    warnings: partial.warnings,
    ...(partial.mediaPending ? { mediaPending: [...partial.mediaPending] } : {}),
    ...(partial.exportFailure ? { exportFailure: { ...partial.exportFailure } } : {}),
    runDir,
  };
}

async function monitorCollection(proxy, options, runMarker, attemptMarker, runDir, log) {
  let lastSignature = "";
  let lastDiagnosticSignature = "";
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const pageCount = options.pages.end - options.pages.start + 1;
  const deadlineMs = collectionDeadlineMs({ pageCount, frequencyMaxSeconds: options.frequency.max });
  while (true) {
    const snapshot = await readCollectionSnapshot(proxy, options, runMarker, attemptMarker);
    ensureNoRisk(snapshot.visibleText, "Xiaowangshen collection");
    const progress = snapshot.observedProgress || parseProgressText(snapshot.text);
    const observedStatus = classifyCollection({ text: snapshot.text });
    const status = observedStatus === "COMPLETE" && !snapshot.trackerOwned ? "COLLECTING" : observedStatus;
    const diagnostics = normalizeDiagnosticSnapshot(snapshot.diagnostics);
    const diagnosticKind = classifyDiagnosticState(diagnostics);
    if (diagnosticKind === "BACKGROUND_TAB") {
      try {
        await request(proxy, `/bringToFront?target=${encodeURIComponent(snapshot.targetId)}`);
        log("FOREGROUND_RECOVERY", { target: snapshot.targetId });
      } catch {
        // Shared proxies without the optional foreground hook remain readable.
      }
    }
    const signature = collectionActivitySignature(progress, diagnostics);
    const diagnosticSignature = `${diagnosticKind}:${diagnostics.visibility}:${diagnostics.requests.length}:${diagnostics.requests.at(-1)?.status ?? ""}:${diagnostics.messages.length}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
      log("PROGRESS", {
        status,
        completedPage: progress.completedEnd,
        requestedPage: progress.requestedEnd,
        rows: progress.rowCount,
        ...(Number.isInteger(progress.nextPage) ? { nextPage: progress.nextPage, waitSeconds: progress.waitSeconds } : {}),
      });
    }
    if (diagnosticSignature !== lastDiagnosticSignature) {
      lastDiagnosticSignature = diagnosticSignature;
      log("DIAGNOSTIC", {
        kind: diagnosticKind,
        visibility: diagnostics.visibility,
        requestCount: diagnostics.requests.length,
        lastRequest: diagnostics.requests.at(-1) || null,
        messageCount: diagnostics.messages.length,
        lastMessage: diagnostics.messages.at(-1) || null,
      });
    }
    if (snapshot.attemptFailed) {
      throw new Error("Xiaowangshen collection request failed");
    }
    if (status === "COMPLETE") return { progress, snapshot, diagnostics, diagnosticKind };
    const now = Date.now();
    const stallReason = collectionStallReason({
      idleMs: now - lastProgressAt,
      elapsedMs: now - startedAt,
      stallMs: options.stallMs,
      deadlineMs,
      diagnosticKind: status === "COLLECTING" ? diagnosticKind : "NO_REQUEST_SIGNAL",
      activePage: progress.activePage,
    });
    if (stallReason) {
      const shot = path.join(runDir, "stall.png");
      const diagnosticPath = path.join(runDir, "diagnostics.json");
      await screenshot(proxy, snapshot.targetId, shot).catch(() => {});
      await writeFile(diagnosticPath, JSON.stringify({
        capturedAt: new Date().toISOString(),
        stallReason,
        diagnosticKind,
        progress,
        diagnostics,
      }, ensureJsonReplacer, 2), "utf8");
      throw stalled(
        stallReason === "deadline"
          ? "Xiaowangshen exceeded the bounded collection deadline"
          : "Xiaowangshen made no page progress before the stall threshold",
        {
          progress,
          stallReason,
          diagnosticKind,
          screenshot: shot,
          diagnostics: diagnosticPath,
        },
      );
    }
    await sleep(options.pollMs);
  }
}

async function listFiles(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(directory, entry.name);
    const metadata = await stat(full);
    files.push({ name: entry.name, path: full, size: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  return files;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, ensureJsonReplacer, 2), "utf8");
  try {
    await rename(temporary, file);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
    await unlink(file);
    await rename(temporary, file);
  }
}

export async function openExportIntent({ runDir, runId, options, directory, kind, baseline, progress, reason }) {
  const requestedAt = new Date();
  const intent = {
    version: 1,
    intentId: randomUUID(),
    status: "OPEN",
    kind,
    childRunId: runId,
    parentRunId: String(process.env.XWS_ADAPTIVE_RUN_ID || ""),
    range: {
      start: Number(process.env.XWS_ADAPTIVE_RANGE_START || options.pages.start),
      end: Number(process.env.XWS_ADAPTIVE_RANGE_END || options.pages.end),
    },
    keyword: options.keyword,
    options: {
      channel: options.channel,
      sort: options.sort,
      price: options.price,
      frequency: options.frequency,
      stallSeconds: Number(options.stallSeconds ?? options.stallMs / 1000),
      allowTrial: options.allowTrial,
      exportModes: options.exportModes,
    },
    outputDir: path.resolve(directory),
    reason,
    requestedAt: requestedAt.toISOString(),
    deadlineAt: new Date(requestedAt.getTime() + (reason === "partial_on_stall"
      ? PARTIAL_EXPORT_SETTLEMENT_MS
      : EXPORT_SETTLEMENT_MS)).toISOString(),
    baseline,
    expectedProgress: progress || null,
  };
  const intentPath = path.join(runDir, `export-intent-${kind}.json`);
  await writeJsonAtomic(intentPath, intent);
  return { intent, intentPath };
}

export async function closeExportIntent(intentPath, intent, status, details = {}) {
  const closed = { ...intent, status, ...details, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(intentPath, closed);
  return closed;
}

async function recordExportCandidateRejected(intentPath, intent, details) {
  const at = new Date().toISOString();
  const rejection = { ...details, at };
  const previous = intent.settlementEvidence || {};
  const updated = {
    ...intent,
    rejections: [...(intent.rejections || []), rejection],
    settlementEvidence: {
      version: 1,
      ...previous,
      status: intent.status,
      rejections: [...(previous.rejections || []), rejection],
      events: [
        ...(previous.events || []),
        { type: "CANDIDATE_REJECTED", ...rejection },
      ],
      updatedAt: at,
    },
    updatedAt: at,
  };
  await writeJsonAtomic(intentPath, updated);
  return updated;
}

function fileIdentity(file) {
  return `${file.name}:${Number(file.size)}:${Number(file.mtimeMs)}`;
}

async function waitForDownload(directory, baseline, extension, startedAt, deadlineAt, log, acceptCandidate, onCandidateRejected) {
  const deadline = Date.parse(deadlineAt);
  const rejected = new Set();
  let lastNotice = 0;
  while (Date.now() < deadline) {
    const files = await listFiles(directory);
    const candidates = files
      .filter((file) => file.mtimeMs >= startedAt
        && !baseline.has(fileIdentity(file))
        && !rejected.has(fileIdentity(file))
        && file.name.toLowerCase().endsWith(extension))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const candidate of candidates) {
      if (candidate.size < 1) continue;
      await sleep(5_000);
      const stable = await stat(candidate.path);
      if (stable.size !== candidate.size) continue;
      try {
        await acceptCandidate({ ...candidate, size: stable.size });
        return { ...candidate, size: stable.size };
      } catch (error) {
        rejected.add(fileIdentity(candidate));
        const details = { extension, path: candidate.path, error: error.message };
        log("EXPORT_CANDIDATE_REJECTED", details);
        await onCandidateRejected?.(details);
      }
    }
    if (Date.now() - lastNotice >= 30_000) {
      log("WAITING_FOR_DOWNLOAD", { extension, deadlineAt });
      lastNotice = Date.now();
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${extension} download`);
}

async function markResultDialogControl(proxy, targetId, options, progress, attemptMarker, { attribute, controlSelector, controlText = "" }) {
  const dialogEntries = await evaluate(proxy, targetId, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('.el-dialog__wrapper')]
      .filter((element) => visible(element) && (element.innerText || '').includes('商品数量'))
      .map((element) => ({
        text: element.innerText || '',
        attemptMarker: element.getAttribute('data-xws-result-attempt') || '',
      }));
  })()`);
  const index = selectExportResultDialog(dialogEntries, {
    ...progress,
    keyword: options.keyword,
    attemptMarker,
  });
  const selectedText = dialogEntries[index].text;
  const marker = randomUUID();
  const marked = await evaluate(proxy, targetId, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialogs = [...document.querySelectorAll('.el-dialog__wrapper')]
      .filter((element) => visible(element)
        && element.getAttribute('data-xws-result-attempt') === ${JSON.stringify(attemptMarker)}
        && (element.innerText || '') === ${JSON.stringify(selectedText)});
    if (dialogs.length !== 1) return { ok: false, reason: 'result dialog changed', count: dialogs.length };
    for (const element of document.querySelectorAll('[${attribute}]')) element.removeAttribute('${attribute}');
    const controls = [...dialogs[0].querySelectorAll(${JSON.stringify(controlSelector)})]
      .filter((element) => visible(element) && (!${JSON.stringify(controlText)} || (element.innerText || '').includes(${JSON.stringify(controlText)})));
    if (controls.length !== 1) return { ok: false, reason: 'export control is ambiguous', count: controls.length };
    controls[0].setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(marker)});
    return { ok: true };
  })()`);
  if (!marked?.ok) throw new Error(`${marked?.reason || "export control is missing"}: received ${marked?.count ?? 0}`);
  return `[${attribute}=${JSON.stringify(marker)}]`;
}

async function exportCsv(proxy, options, runMarker, attemptMarker, runDir, directory, log, progress, reason = "final") {
  const baseline = await listFiles(directory);
  const before = new Set(baseline.map(fileIdentity));
  let { intent, intentPath } = await openExportIntent({ runDir, runId: runMarker, options, directory, kind: "csv", baseline, progress, reason });
  try {
    const target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
    const selector = await markResultDialogControl(proxy, target.targetId, options, progress, attemptMarker, {
      attribute: "data-xws-export-csv",
      controlSelector: "button",
      controlText: "导出csv表格",
    });
    const fresh = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
    if (fresh.targetId !== target.targetId) throw new Error("export target identity changed before CSV activation");
    await clickExportControl(proxy, fresh.targetId, selector);
  } catch (error) {
    intent = await closeExportIntent(intentPath, intent, "REJECTED", {
      reason: "export_action_failed",
      lastError: error.message,
    });
    error.exportFailureReason = "export_action_failed";
    throw error;
  }
  log("EXPORT_STARTED", { format: "csv", reason, intent: intentPath, deadlineAt: intent.deadlineAt });
  try {
    const file = await waitForDownload(
      directory,
      before,
      ".csv",
      Date.parse(intent.requestedAt) - 2_000,
      intent.deadlineAt,
      log,
      async (candidate) => {
        const validation = runPythonValidation(options, candidate, null, false);
        if (progress && validation.validation.rows !== progress.rowCount) {
          throw new Error(`export row count ${validation.validation.rows} does not match live row count ${progress.rowCount}`);
        }
      },
      async (details) => {
        intent = await recordExportCandidateRejected(intentPath, intent, details);
      },
    );
    intent = await closeExportIntent(intentPath, intent, "OBSERVED", { candidate: file });
    return { ...file, intentPath, intent };
  } catch (error) {
    if (reason === "partial_on_stall") {
      intent = await closeExportIntent(intentPath, intent, "EXPIRED", {
        reason: "partial_settlement_deadline_exceeded",
        lastError: error.message,
      });
    } else {
      await closeExportIntent(intentPath, intent, "OPEN", { lastError: error.message });
    }
    throw error;
  }
}

async function exportXlsx(proxy, options, runMarker, attemptMarker, runDir, directory, withImages, log, progress, csv, reason = "final") {
  const baseline = await listFiles(directory);
  const before = new Set(baseline.map(fileIdentity));
  let { intent, intentPath } = await openExportIntent({ runDir, runId: runMarker, options, directory, kind: "xlsx", baseline, progress, reason });
  try {
    let target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
    const targetId = target.targetId;
    const caretSelector = await markResultDialogControl(proxy, targetId, options, progress, attemptMarker, {
      attribute: "data-xws-export-caret",
      controlSelector: ".el-button-group .el-dropdown__caret-button",
    });
    target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
    if (target.targetId !== targetId) throw new Error("export target identity changed before XLSX menu activation");
    const itemText = withImages ? "导出xlsx表格（带图片）" : "导出xlsx表格";
    const menuBaseline = randomUUID();
    const menuBinding = await evaluate(proxy, targetId, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const caret = document.querySelector(${JSON.stringify(caretSelector)});
      if (!caret) return { ok: false, menuIds: [] };
      const menuIds = [
        caret.getAttribute('aria-controls'),
        caret.getAttribute('aria-owns'),
      ].filter(Boolean).flatMap((value) => value.trim().split(/\s+/u));
      let hadVisibleItem = false;
      for (const element of document.querySelectorAll('.el-dropdown-menu__item')) {
        const isVisible = visible(element);
        const isTarget = (element.innerText || '').trim() === ${JSON.stringify(itemText)};
        const menu = element.closest('.el-dropdown-menu');
        const owned = menuIds.length === 0 || Boolean(menu?.id && menuIds.includes(menu.id));
        if (isVisible && isTarget && owned) hadVisibleItem = true;
        element.setAttribute('data-xws-export-menu-baseline', ${JSON.stringify(menuBaseline)});
        element.setAttribute('data-xws-export-menu-was-visible', isVisible ? '1' : '0');
      }
      return { ok: true, menuIds: [...new Set(menuIds)], hadVisibleItem };
    })()`);
    if (!menuBinding?.ok) throw new Error("XLSX caret disappeared before menu activation");
    if (menuBinding.hadVisibleItem) {
      await clickExportControl(proxy, targetId, caretSelector);
      const closeDeadline = Date.now() + 2_000;
      let menuClosed = false;
      while (Date.now() < closeDeadline) {
        target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
        if (target.targetId !== targetId) throw new Error("export target identity changed while closing the existing XLSX menu");
        menuClosed = await evaluate(proxy, targetId, `(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const menuIds = ${JSON.stringify(menuBinding.menuIds || [])};
          const items = [...document.querySelectorAll('[data-xws-export-menu-baseline=${JSON.stringify(menuBaseline)}][data-xws-export-menu-was-visible="1"]')]
            .filter((element) => {
              const menu = element.closest('.el-dropdown-menu');
              const owned = menuIds.length === 0 || Boolean(menu?.id && menuIds.includes(menu.id));
              return owned && (element.innerText || '').trim() === ${JSON.stringify(itemText)};
            });
          return items.length > 0 && items.every((element) => !visible(element));
        })()`);
        if (menuClosed) break;
        await sleep(100);
      }
      if (!menuClosed) throw new Error("existing XLSX menu did not close before activation");
      await evaluate(proxy, targetId, `(() => {
        for (const element of document.querySelectorAll('[data-xws-export-menu-baseline=${JSON.stringify(menuBaseline)}]')) {
          element.setAttribute('data-xws-export-menu-was-visible', '0');
        }
        return true;
      })()`);
    }
    await clickExportControl(proxy, targetId, caretSelector);
    const marker = randomUUID();
    const menuDeadline = Date.now() + 5_000;
    let menuReady = false;
    while (Date.now() < menuDeadline) {
      target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
      if (target.targetId !== targetId) throw new Error("export target identity changed while opening XLSX menu");
      menuReady = await evaluate(proxy, targetId, `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        for (const element of document.querySelectorAll('[data-xws-export-xlsx]')) element.removeAttribute('data-xws-export-xlsx');
        const wanted = ${JSON.stringify(itemText)};
        const normalizeMenuText = (value) => String(value || '').replace(/\s+/gu, '').replace(/（/gu, '(').replace(/）/gu, ')');
        const caret = document.querySelector(${JSON.stringify(caretSelector)});
        const currentMenuIds = [
          caret?.getAttribute('aria-controls'),
          caret?.getAttribute('aria-owns'),
        ].filter(Boolean).flatMap((value) => value.trim().split(/\s+/u));
        const items = [...document.querySelectorAll('.el-dropdown-menu__item')].filter((candidate) => {
          const menu = candidate.closest('.el-dropdown-menu');
          const existedBefore = candidate.getAttribute('data-xws-export-menu-baseline') === ${JSON.stringify(menuBaseline)};
          const becameVisible = existedBefore
            && candidate.getAttribute('data-xws-export-menu-was-visible') === '0';
          const appearedForClick = !existedBefore || becameVisible;
          const belongsToCaret = currentMenuIds.length > 0
            ? Boolean(menu?.id && currentMenuIds.includes(menu.id))
            : appearedForClick;
          return visible(candidate)
            && appearedForClick
            && belongsToCaret
            && normalizeMenuText(candidate.innerText) === normalizeMenuText(wanted);
        });
        if (items.length < 1) return false;
        items[0].setAttribute('data-xws-export-xlsx', ${JSON.stringify(marker)});
        return true;
      })()`);
      if (menuReady) break;
      await sleep(100);
    }
    if (!menuReady) throw new Error(`XLSX menu item is missing or ambiguous: ${itemText}`);
    target = await discoverExportSearch(proxy, options.keyword, runMarker, options.adoptLiveResult);
    if (target.targetId !== targetId) throw new Error("export target identity changed before XLSX activation");
    await clickExportControl(proxy, targetId, `[data-xws-export-xlsx=${JSON.stringify(marker)}]`);
  } catch (error) {
    intent = await closeExportIntent(intentPath, intent, "REJECTED", {
      reason: "export_action_failed",
      lastError: error.message,
    });
    error.exportFailureReason = "export_action_failed";
    throw error;
  }
  log("EXPORT_STARTED", { format: withImages ? "xlsx-images" : "xlsx", reason, intent: intentPath, deadlineAt: intent.deadlineAt });
  try {
    const file = await waitForDownload(
      directory,
      before,
      ".xlsx",
      Date.parse(intent.requestedAt) - 2_000,
      intent.deadlineAt,
      log,
      async (candidate) => {
        const validation = runPythonValidation(options, csv, candidate, withImages);
        if (progress && validation.validation.rows !== progress.rowCount) {
          throw new Error(`export row count ${validation.validation.rows} does not match live row count ${progress.rowCount}`);
        }
      },
      async (details) => {
        intent = await recordExportCandidateRejected(intentPath, intent, details);
      },
    );
    intent = await closeExportIntent(intentPath, intent, "OBSERVED", { candidate: file });
    return { ...file, intentPath, intent };
  } catch (error) {
    if (reason === "partial_on_stall") {
      intent = await closeExportIntent(intentPath, intent, "EXPIRED", {
        reason: "partial_settlement_deadline_exceeded",
        lastError: error.message,
      });
    } else {
      await closeExportIntent(intentPath, intent, "OPEN", { lastError: error.message });
    }
    throw error;
  }
}

function runPythonValidation(options, csv, xlsx, requireImages) {
  const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const prefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];
  const args = [...prefix, path.join(SCRIPT_DIR, "validate-output.py"), "--csv", csv.path];
  if (xlsx) args.push("--xlsx", xlsx.path);
  if (requireImages) args.push("--require-images");
  const result = spawnSync(python, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw new Error(`output validator failed to run: ${result.error.message}`);
  const output = String(result.stdout || "").trim();
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`output validator returned invalid JSON: ${String(result.stderr || output).slice(0, 500)}`);
  }
  if (result.status !== 0 || !parsed.ok) throw new Error(parsed.error || "output validation failed");
  return parsed;
}

async function exportArtifacts(proxy, options, runMarker, attemptMarker, runDir, outputDir, log, progress = null, reason = "final") {
  const files = {};
  if (options.exportModes.includes("csv")) files.csv = await exportCsv(proxy, options, runMarker, attemptMarker, runDir, outputDir, log, progress, reason);
  let exportFailure;
  if (options.exportModes.includes("xlsx-images")) {
    try {
      files.xlsx = await exportXlsx(proxy, options, runMarker, attemptMarker, runDir, outputDir, true, log, progress, files.csv, reason);
    } catch (error) {
      if (reason !== "partial_on_stall") throw error;
      exportFailure = {
        reason: error.exportFailureReason || "export_action_failed",
        error: error.message,
      };
    }
  } else if (options.exportModes.includes("xlsx")) {
    try {
      files.xlsx = await exportXlsx(proxy, options, runMarker, attemptMarker, runDir, outputDir, false, log, progress, files.csv, reason);
    } catch (error) {
      if (reason !== "partial_on_stall") throw error;
      exportFailure = {
        reason: error.exportFailureReason || "export_action_failed",
        error: error.message,
      };
    }
  }
  const validation = runPythonValidation(
    options,
    files.csv,
    files.xlsx,
    Boolean(files.xlsx) && options.exportModes.includes("xlsx-images"),
  );
  if (progress && validation.validation.rows !== progress.rowCount) {
    throw new Error(`export row count ${validation.validation.rows} does not match live row count ${progress.rowCount}`);
  }
  for (const file of Object.values(files)) {
    await closeExportIntent(file.intentPath, file.intent, "ACCEPTED", {
      candidate: { name: file.name, path: file.path, size: file.size, mtimeMs: file.mtimeMs },
      validation,
      acceptedAt: new Date().toISOString(),
    });
    delete file.intentPath;
    delete file.intent;
  }
  const warnings = [];
  if (files.xlsx?.name.includes("价格从高到低") && options.sort === "sales") warnings.push("plugin filename says price-high while live sort is sales");
  return {
    files,
    validation,
    warnings,
    ...(exportFailure ? { exportFailure, mediaPending: ["xlsx"] } : {}),
  };
}

async function adoptLiveResult(options, runId, runDir, outputDir, log) {
  const target = await discoverUniqueSearchForAdoption(options.proxy, options.keyword);
  const text = await visibleText(options.proxy, target.targetId);
  ensureNoRisk(text, "Xiaowangshen live-result adoption");
  const snapshot = await readLiveCollectionSnapshot(options.proxy, options, target.targetId);
  if (snapshot.ambiguous) throw adoptionRejected("live-result adoption result is ambiguous");
  if (snapshot.collectionRange?.start !== options.pages.start || snapshot.collectionRange?.end !== options.pages.end) {
    throw adoptionRejected("live-result adoption diagnostics range does not match requested range", { range: snapshot.collectionRange });
  }
  if (!snapshot.activeAttempt || !snapshot.trackerOwned || !snapshot.requestEvidence) {
    throw adoptionRejected("live-result adoption lacks successful collection ownership evidence", {
      activeAttempt: Boolean(snapshot.activeAttempt),
      trackerOwned: snapshot.trackerOwned,
      requestEvidence: snapshot.requestEvidence,
    });
  }
  if (snapshot.progress.keyword !== options.keyword
    || snapshot.progress.sortLabel !== sortLabel(options.sort)
    || snapshot.progress.requestedStart !== options.pages.start
    || snapshot.progress.requestedEnd !== options.pages.end
    || snapshot.progress.completedEnd !== options.pages.end
    || snapshot.progress.rowCount < 1) {
    throw adoptionRejected("live-result adoption progress does not match requested contract", { progress: snapshot.progress });
  }
  await bindOwnedResultMarker(options.proxy, target.targetId, options, snapshot.progress, snapshot.activeAttempt);
  const exported = await exportArtifacts(options.proxy, options, runId, snapshot.activeAttempt, runDir, outputDir, log, snapshot.progress, "adopt_live_result");
  const manifest = {
    status: "DONE",
    adopted: true,
    runId,
    sourceId: snapshot.activeAttempt,
    options,
    progress: snapshot.progress,
    diagnostics: snapshot.diagnostics,
    artifacts: exported.files,
    validation: exported.validation,
    warnings: exported.warnings,
    runDir,
  };
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, ensureJsonReplacer, 2), "utf8");
  await log("LIVE_RESULT_ADOPTED", {
    runId,
    rows: snapshot.progress.rowCount,
    runDir,
    ...(exported.validation.artifacts?.csv?.sha256 ? { artifactDigest: exported.validation.artifacts.csv.sha256 } : {}),
  });
  return manifest;
}

async function runUnlocked(options) {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${options.keyword.replace(/[^\w\u4e00-\u9fff]+/gu, "-")}`;
  const runtimeRoot = process.env.XWS_RUNTIME_DIR || path.join(PROJECT_ROOT, "runtime", "xws-runs");
  const runDir = path.join(runtimeRoot, runId);
  await mkdir(runDir, { recursive: true });
  const events = path.join(runDir, "events.jsonl");
  // EVIDENCE-CONTRACT.md: every event carries runId/attemptId/seq. runId is the
  // durable adaptive run id (env) when running under the adaptive supervisor;
  // attemptId is this export invocation (the attempt that owns this events file).
  const adaptiveRunId = String(process.env.XWS_ADAPTIVE_RUN_ID || "");
  let eventSeq = 0;
  const log = (event, details = {}) => {
    eventSeq += 1;
    const record = {
      at: new Date().toISOString(),
      event,
      runId: adaptiveRunId || runId,
      attemptId: runId,
      seq: eventSeq,
      ...details,
    };
    console.log(JSON.stringify(record, ensureJsonReplacer));
    appendFileSync(events, `${JSON.stringify(record, ensureJsonReplacer)}\n`, { encoding: "utf8" });
  };

  await log("START", { keyword: options.keyword, pages: options.pages, frequency: options.frequency });
  try {
    const proxyHealth = await request(options.proxy, "/health");
    assertProxyBrowserHealth(proxyHealth, process.env.XWS_BROWSER_ID || "edge");
  await log("PROXY_READY", { browser: proxyHealth.browser.id });
  if (options.adoptLiveResult) {
    return adoptLiveResult(options, runId, runDir, outputDir, log);
  }
  await request(options.proxy, "/targets");
  await openTaobaoHome(options.proxy, runId, log);
  await searchKeyword(options.proxy, options.keyword, runId, log);
  await waitForPlugin(options.proxy, options.keyword, runId, log);
  await openMarketAnalysis(options.proxy, options.keyword, runId, log);
  await handlePermission(options.proxy, options.keyword, runId, options.allowTrial, log);
  await configureAnalysis(options.proxy, options, runId, log);

  if (options.prepareOnly) {
    const manifest = { status: "READY_FOR_RECORDING", runId, options, runDir };
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, ensureJsonReplacer, 2), "utf8");
    await log("READY_FOR_RECORDING", { runDir });
    return manifest;
  }

  const target = await discoverSearch(options.proxy, options.keyword, runId);
  const marked = await evaluate(options.proxy, target.targetId, `(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.innerText || '').trim() === '开始分析');
    if (!button) return false;
    button.setAttribute('data-xws-start', '1');
    return true;
  })()`);
  if (!marked) throw new Error("Xiaowangshen start button is missing after configuration");
  await installCollectionDiagnostics(options.proxy, options.keyword, runId, options.pages, log);
  const attemptMarker = await startAnalysis(options.proxy, options.keyword, runId, log);
  let completed;
  try {
    completed = await monitorCollection(options.proxy, options, runId, attemptMarker, runDir, log);
  } catch (error) {
    if (error.code === "STALLED" && options.exportPartialOnStall) {
      try {
        const refreshed = await refreshOwnedExportSnapshot(options.proxy, options, runId, attemptMarker);
        const partial = await exportArtifacts(
          options.proxy,
          options,
          runId,
          attemptMarker,
          runDir,
          outputDir,
          log,
          refreshed.progress,
          "partial_on_stall",
        );
        const partialManifest = buildPartialStallManifest({
          runId,
          options,
          refreshedProgress: refreshed.progress,
          stallDetails: error.details,
          partial,
          runDir,
        });
        const manifestPath = path.join(runDir, "manifest.json");
        await writeFile(manifestPath, JSON.stringify(partialManifest, ensureJsonReplacer, 2), "utf8");
        await log("PARTIAL_EXPORTED", {
          rows: partial.validation.validation.rows,
          runDir,
          manifest: manifestPath,
          ...(partial.validation.artifacts?.csv?.sha256 ? { artifactDigest: partial.validation.artifacts.csv.sha256 } : {}),
        });
        error.details = {
          ...error.details,
          partialManifest: manifestPath,
          artifacts: partial.files,
          validation: partial.validation,
          ...(partial.mediaPending ? { mediaPending: [...partial.mediaPending] } : {}),
          ...(partial.exportFailure ? { partialExportFailure: { ...partial.exportFailure } } : {}),
        };
      } catch (partialError) {
        await log("PARTIAL_EXPORT_FAILED", { error: partialError.message, runDir });
        error.details = {
          ...error.details,
          partialExportError: partialError.message,
          partialExportFailure: {
            reason: partialError.exportFailureReason || "artifact_settlement_failed",
            error: partialError.message,
          },
        };
      }
    }
    throw error;
  }
  if (completed.progress.keyword && completed.progress.keyword !== options.keyword) {
    throw new Error(`live result keyword mismatch: expected ${options.keyword}, got ${completed.progress.keyword}`);
  }
  if (completed.progress.sortLabel && completed.progress.sortLabel !== sortLabel(options.sort)) {
    throw new Error(`live result sort mismatch: expected ${sortLabel(options.sort)}, got ${completed.progress.sortLabel}`);
  }
  if (completed.progress.requestedStart !== options.pages.start || completed.progress.requestedEnd !== options.pages.end) {
    throw new Error("live result page range does not match the requested range");
  }
  const refreshed = await refreshOwnedExportSnapshot(options.proxy, options, runId, attemptMarker);
  const exported = await exportArtifacts(options.proxy, options, runId, attemptMarker, runDir, outputDir, log, refreshed.progress);
  const { files, validation, warnings } = exported;
  if (files.xlsx?.name.includes("价格从高到低") && options.sort === "sales") warnings.push("plugin filename says price-high while live sort is sales");
  const manifest = {
    status: "DONE",
    runId,
    options,
    progress: completed.progress,
    diagnostics: completed.diagnostics,
    diagnosticKind: completed.diagnosticKind,
    artifacts: files,
    validation,
    warnings,
    runDir,
  };
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, ensureJsonReplacer, 2), "utf8");
  await log("DONE", { rows: completed.progress.rowCount, runDir, warnings });
  return manifest;
  } finally {
    const cleanup = await cleanupOwnedTargets(options.proxy, runId);
    if (cleanup.closed.length || cleanup.failed.length) {
      await log("TARGETS_CLEANED", cleanup);
    }
  }
}

export function shouldAcquireRuntimeLock(env = process.env) {
  return env.XWS_ADAPTIVE_LOCK_OWNER !== "1";
}

async function run(options) {
  if (!shouldAcquireRuntimeLock()) return runUnlocked(options);
  const lock = await acquireMarketAnalysisLock();
  try {
    return await runUnlocked(options);
  } finally {
    await lock.release();
  }
}

function ensureJsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function selfTest() {
  const options = parseOptions(["--keyword", "浴缸"]);
  const partial = parseProgressText("您搜索的页数：第 1 ~ 40 页，已成功获取：第 1 ~ 20 页\n商品数量：707");
  const complete = parseProgressText("【 浴缸 】销量排序Top1333 - 2026-08-05 15:46 - 市场数据分析\n您搜索的页数：第 1 ~ 40 页，已成功获取：第 1 ~ 40 页\n商品数量：1333");
  const rows = [REQUIRED_HEADERS, [1, "", "A", "https://item.taobao.com/item.htm?id=1", "1", "-", "c", "-", "淘宝", "自然位", "s", "w", "t", "a", "-", "-"]];
  const checks = {
    args: options.pages.end === 40 && options.frequency.max === 15,
    progress: partial.completedEnd === 20 && complete.complete,
    risk: detectRiskMarkers("验证码").includes("CAPTCHA"),
    dataset: validateDataset(rows[0], rows.slice(1)).rowCount === 1,
    deadline: collectionDeadlineMs({ pageCount: 40, frequencyMaxSeconds: 15 }) === 1_700_000,
  };
  if (Object.values(checks).some((value) => !value)) throw new Error("self-test check failed");
  return { ok: true, checks };
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return 0;
    }
    if (options.selfTest) {
      console.log(JSON.stringify(selfTest()));
      return 0;
    }
    await run(options);
    return 0;
  } catch (error) {
    const code = error.code || "FAILED";
    const payload = { status: code, error: error.message, details: error.details || {} };
    console.error(JSON.stringify(payload, ensureJsonReplacer));
    return code === "HUMAN_REQUIRED" ? 2
      : code === "STALLED" ? 3
        : code === "ADOPTION_REJECTED" ? 4
          : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { helpText, selfTest };
