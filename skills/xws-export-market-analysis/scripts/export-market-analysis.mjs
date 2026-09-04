#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_HEADERS,
  classifyCollection,
  collectionDeadlineMs,
  detectRiskMarkers,
  parseOptions,
  parseProgressText,
  selectTaobaoSearchTarget,
  validateDataset,
} from "./flow.mjs";
import { classifyDiagnosticState, normalizeDiagnosticSnapshot } from "./diagnostics.mjs";
import { buildSearchInputExpression } from "./search-input.mjs";
import { acquireRuntimeLock } from "./runtime-lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "Downloads");
const TAOBAO_HOME = "https://www.taobao.com/";
const SEARCH_ORIGIN = "https://s.taobao.com";

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
  // Background targets can keep document.visibilityState=hidden; Xiaowangshen
  // ignores toolbar clicks in that state. Use the proxy's optional foreground
  // hook when available, while preserving compatibility with the shared proxy.
  try {
    await request(proxy, `/bringToFront?target=${encodeURIComponent(target)}`);
  } catch {
    // Older shared proxies do not expose this endpoint.
  }
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

async function waitForReadyTarget(proxy, predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = (await listTargets(proxy)).filter(predicate);
    for (const target of targets) {
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

async function labelTarget(proxy, targetId, runMarker) {
  if (!ownedTargets.has(runMarker)) ownedTargets.set(runMarker, new Set());
  ownedTargets.get(runMarker).add(targetId);
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

async function visibleText(proxy, target) {
  return String(await evaluate(proxy, target, "document.body?.innerText || \"\""));
}

function ensureNoRisk(text, stage) {
  const markers = detectRiskMarkers(text);
  if (markers.length) throw humanRequired(`${stage} encountered a platform control`, { markers });
}

async function openTaobaoHome(proxy, runMarker, log) {
  const before = new Set((await listTargets(proxy)).map((target) => target.targetId));
  await request(proxy, `/new?url=${encodeURIComponent(TAOBAO_HOME)}&label=${encodeURIComponent(runMarker)}`);
  const freshHome = await waitForReadyTarget(proxy, (candidate) => isHome(candidate) && !before.has(candidate.targetId), 30_000, "a new Taobao home tab to finish loading");
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
    search = await waitForReadyTarget(proxy, (candidate) => isSearch(candidate, keyword) && !existingSearchTargets.has(candidate.targetId), 5_000, "new Taobao search results to finish loading");
  } catch (error) {
    // A background tab or site handler can reject the DOM click. Use one
    // bounded coordinate fallback, then keep the same fresh-target checks.
    const fallbackHome = await discoverHome(proxy, runMarker);
    await clickAt(proxy, fallbackHome.targetId, "#J_TSearchForm button[type=submit]");
    try {
      search = await waitForReadyTarget(proxy, (candidate) => isSearch(candidate, keyword) && !existingSearchTargets.has(candidate.targetId), 5_000, "new Taobao search results to finish loading");
    } catch {
      // If Taobao's autocomplete handler wins both bounded clicks, navigate
      // the fresh, labeled home tab to the canonical search URL once.
      const currentHome = await discoverHome(proxy, runMarker);
      const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}&search_type=item&tab=all`;
      await request(proxy, `/navigate?target=${encodeURIComponent(currentHome.targetId)}&url=${encodeURIComponent(searchUrl)}`);
      search = await waitForReadyTarget(proxy, (candidate) => isSearch(candidate, keyword)
        && (candidate.automationLabel === runMarker || ownedTargets.get(runMarker)?.has(candidate.targetId)), 30_000, "canonical Taobao search results to finish loading");
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

function sortValue(sort) {
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
      const style = getComputedStyle(mask);
      const rect = mask.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && rect.width > 0 && rect.height > 0;
    });
    return { ok: true, ready: !active, loadingMasks: loadingMasks.length };
  })()`;
  const waitForDialogSettle = async () => {
    const deadline = Date.now() + 10_000;
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
    if (!clicked?.ok) throw new Error(`Could not select Xiaowangshen radio: ${clicked?.reason || value}`);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
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
    throw new Error("Xiaowangshen configuration did not match the requested contract");
  }
  log("CONFIGURED", { keyword: options.keyword, channel: options.channel, sort: options.sort, pages: options.pages, frequency: options.frequency });
}

async function startAnalysis(proxy, keyword, runMarker, log) {
  const waitForResult = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let state;
    while (Date.now() < deadline) {
      state = await inspectDialogs(proxy, keyword, runMarker);
      ensureNoRisk(state.visibleText, "Xiaowangshen collection");
      if (state.result) return { ready: true, state };
      await sleep(250);
    }
    return { ready: false, state };
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const target = await discoverSearch(proxy, keyword, runMarker);
    await clickAt(proxy, target.targetId, "button[data-xws-start=\"1\"]");
    const outcome = await waitForResult(attempt === 1 ? 2_000 : 15_000);
    if (outcome.ready) {
      log("COLLECTION_STARTED", { attempt });
      return;
    }
    if (attempt === 1 && outcome.state?.config) {
      log("COLLECTION_START_RETRY", { reason: "result dialog did not open" });
      continue;
    }
    if (attempt === 1) {
      const delayed = await waitForResult(13_000);
      if (delayed.ready) {
        log("COLLECTION_STARTED", { attempt });
        return;
      }
    }
    break;
  }
  throw new Error("Xiaowangshen collection did not start");
}

async function installCollectionDiagnostics(proxy, keyword, runMarker, log) {
  const target = await discoverSearch(proxy, keyword, runMarker);
  const installed = await evaluate(proxy, target.targetId, `(() => {
    if (window.__xwsCollectionDiag?.installed) return { ok: true, reused: true };
    const state = { installed: true, installedAt: new Date().toISOString(), requests: [], messages: [], byFlag: Object.create(null) };
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
    const originalPageRequest = window.xwsPageRequest;
    if (typeof originalPageRequest === 'function' && !originalPageRequest.__xwsDiagWrapped) {
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
        if (record.flag) state.byFlag[record.flag] = record;
        return originalPageRequest.call(this, option, flag, bool);
      };
      wrappedPageRequest.__xwsDiagWrapped = true;
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
      const request = state.byFlag[flag];
      if (request) {
        request.pending = false;
        request.status = Number.isFinite(result?.retCode) ? Number(result.retCode) : 200;
        request.elapsedMs = Math.round(performance.now() - request.startedAt);
        Object.assign(request, summary);
        if (error) request.error = String(error).slice(0, 300);
      }
      state.messages.push({ type, ...summary, ...(error ? { error: String(error).slice(0, 300) } : {}) });
      if (state.messages.length > 200) state.messages.shift();
    });
    window.__xwsCollectionDiag = {
      installed: true,
      snapshot: () => ({
        capturedAt: new Date().toISOString(),
        visibility: document.visibilityState,
        readyState: document.readyState,
        requests: state.requests,
        messages: state.messages,
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

async function readCollectionSnapshot(proxy, keyword, runMarker) {
  const target = await discoverSearch(proxy, keyword, runMarker);
  const state = await evaluate(proxy, target.targetId, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const wrappers = [...document.querySelectorAll('.el-dialog__wrapper')].filter(visible);
    const result = wrappers.find((element) => (element.innerText || '').includes('商品数量'));
    const text = result?.innerText || wrappers.map((element) => element.innerText || '').join('\\n');
    const diagnostics = window.__xwsCollectionDiag?.snapshot?.() || {
      capturedAt: new Date().toISOString(),
      visibility: document.visibilityState,
      readyState: document.readyState,
      requests: [],
      messages: [],
    };
    return { text: text.slice(0, 6000), title: document.title, diagnostics };
  })()`);
  return { ...state, diagnostics: normalizeDiagnosticSnapshot(state.diagnostics), targetId: target.targetId };
}

async function monitorCollection(proxy, options, runMarker, runDir, log) {
  let lastSignature = "";
  let lastDiagnosticSignature = "";
  let lastProgressAt = Date.now();
  while (true) {
    const snapshot = await readCollectionSnapshot(proxy, options.keyword, runMarker);
    const status = classifyCollection(snapshot);
    ensureNoRisk(snapshot.text, "Xiaowangshen collection");
    const progress = parseProgressText(snapshot.text);
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
    const signature = `${progress.completedEnd}:${progress.rowCount}:${progress.complete}`;
    const diagnosticSignature = `${diagnosticKind}:${diagnostics.visibility}:${diagnostics.requests.length}:${diagnostics.requests.at(-1)?.status ?? ""}:${diagnostics.messages.length}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
      log("PROGRESS", { status, completedPage: progress.completedEnd, requestedPage: progress.requestedEnd, rows: progress.rowCount });
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
    if (status === "COMPLETE") return { progress, snapshot, diagnostics, diagnosticKind };
    if (Date.now() - lastProgressAt >= options.stallMs) {
      const shot = path.join(runDir, "stall.png");
      const diagnosticPath = path.join(runDir, "diagnostics.json");
      await screenshot(proxy, snapshot.targetId, shot).catch(() => {});
      await writeFile(diagnosticPath, JSON.stringify({
        capturedAt: new Date().toISOString(),
        diagnosticKind,
        progress,
        diagnostics,
      }, ensureJsonReplacer, 2), "utf8");
      throw stalled("Xiaowangshen made no page progress before the stall threshold", {
        progress,
        diagnosticKind,
        screenshot: shot,
        diagnostics: diagnosticPath,
      });
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

async function waitForDownload(directory, before, extension, startedAt, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    const files = await listFiles(directory);
    const candidate = files.filter((file) => file.mtimeMs >= startedAt && !before.has(file.name) && file.name.toLowerCase().endsWith(extension)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (candidate && candidate.size > 0) {
      await sleep(5_000);
      const stable = await stat(candidate.path);
      if (stable.size === candidate.size) return { ...candidate, size: stable.size };
    }
    if (Date.now() - lastNotice >= 30_000) {
      log("WAITING_FOR_DOWNLOAD", { extension });
      lastNotice = Date.now();
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${extension} download`);
}

async function exportCsv(proxy, options, runMarker, directory, log) {
  const before = new Set((await listFiles(directory)).map((file) => file.name));
  const target = await discoverSearch(proxy, options.keyword, runMarker);
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => visible(candidate) && (candidate.innerText || '').includes('导出csv表格'));
    if (!button) return false;
    button.setAttribute('data-xws-export-csv', '1');
    return true;
  })()`;
  if (!(await evaluate(proxy, target.targetId, expression))) throw new Error("CSV export button is missing");
  const fresh = await discoverSearch(proxy, options.keyword, runMarker);
  await clickAt(proxy, fresh.targetId, "button[data-xws-export-csv=\"1\"]");
  log("EXPORT_STARTED", { format: "csv" });
  return waitForDownload(directory, before, ".csv", Date.now() - 2_000, 300_000, log);
}

async function exportXlsx(proxy, options, runMarker, directory, withImages, log) {
  const before = new Set((await listFiles(directory)).map((file) => file.name));
  let target = await discoverSearch(proxy, options.keyword, runMarker);
  const caret = await evaluate(proxy, target.targetId, `(() => {
    const button = [...document.querySelectorAll('.el-button-group .el-dropdown__caret-button')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return getComputedStyle(candidate).display !== 'none' && rect.width > 0 && rect.height > 0;
    });
    if (!button) return false;
    button.setAttribute('data-xws-export-caret', '1');
    return true;
  })()`);
  if (!caret) throw new Error("XLSX export menu is missing");
  target = await discoverSearch(proxy, options.keyword, runMarker);
  await clickAt(proxy, target.targetId, ".el-button-group .el-dropdown__caret-button[data-xws-export-caret=\"1\"]");
  const itemText = withImages ? "导出xlsx表格（带图片）" : "导出xlsx表格";
  const menuDeadline = Date.now() + 5_000;
  let menuReady = false;
  while (Date.now() < menuDeadline) {
    target = await discoverSearch(proxy, options.keyword, runMarker);
    menuReady = await evaluate(proxy, target.targetId, `(() => {
      const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return getComputedStyle(candidate).display !== 'none' && rect.width > 0 && rect.height > 0
          && (candidate.innerText || '').trim() === ${JSON.stringify(itemText)};
      });
      if (!item) return false;
      item.setAttribute('data-xws-export-xlsx', '1');
      return true;
    })()`);
    if (menuReady) break;
    await sleep(100);
  }
  if (!menuReady) throw new Error(`XLSX menu item is missing: ${itemText}`);
  target = await discoverSearch(proxy, options.keyword, runMarker);
  await clickAt(proxy, target.targetId, ".el-dropdown-menu__item[data-xws-export-xlsx=\"1\"]");
  log("EXPORT_STARTED", { format: withImages ? "xlsx-images" : "xlsx" });
  return waitForDownload(directory, before, ".xlsx", Date.now() - 2_000, 1_800_000, log);
}

function runPythonValidation(options, csv, xlsx, requireImages) {
  const python = process.env.XWS_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const prefix = process.env.XWS_PYTHON || process.platform !== "win32" ? [] : ["-3"];
  const args = [...prefix, path.join(SCRIPT_DIR, "validate-output.py"), "--csv", csv.path];
  if (xlsx) args.push("--xlsx", xlsx.path);
  if (requireImages) args.push("--require-images");
  const result = spawnSync(python, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
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

async function exportArtifacts(proxy, options, runMarker, outputDir, log, progress = null) {
  const files = {};
  if (options.exportModes.includes("csv")) files.csv = await exportCsv(proxy, options, runMarker, outputDir, log);
  if (options.exportModes.includes("xlsx-images")) files.xlsx = await exportXlsx(proxy, options, runMarker, outputDir, true, log);
  else if (options.exportModes.includes("xlsx")) files.xlsx = await exportXlsx(proxy, options, runMarker, outputDir, false, log);
  const validation = runPythonValidation(options, files.csv, files.xlsx, options.exportModes.includes("xlsx-images"));
  if (progress && validation.validation.rows !== progress.rowCount) {
    throw new Error(`export row count ${validation.validation.rows} does not match live row count ${progress.rowCount}`);
  }
  const warnings = [];
  if (files.xlsx?.name.includes("价格从高到低") && options.sort === "sales") warnings.push("plugin filename says price-high while live sort is sales");
  return { files, validation, warnings };
}

async function runUnlocked(options) {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${options.keyword.replace(/[^\w\u4e00-\u9fff]+/gu, "-")}`;
  const runtimeRoot = process.env.XWS_RUNTIME_DIR || path.join(PROJECT_ROOT, "runtime", "xws-runs");
  const runDir = path.join(runtimeRoot, runId);
  await mkdir(runDir, { recursive: true });
  const events = path.join(runDir, "events.jsonl");
  const log = (event, details = {}) => {
    const record = { at: new Date().toISOString(), event, ...details };
    console.log(JSON.stringify(record, ensureJsonReplacer));
    appendFileSync(events, `${JSON.stringify(record, ensureJsonReplacer)}\n`, { encoding: "utf8" });
  };

  await log("START", { keyword: options.keyword, pages: options.pages, frequency: options.frequency });
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
  await installCollectionDiagnostics(options.proxy, options.keyword, runId, log);
  await startAnalysis(options.proxy, options.keyword, runId, log);
  let completed;
  try {
    completed = await monitorCollection(options.proxy, options, runId, runDir, log);
  } catch (error) {
    if (error.code === "STALLED" && options.exportPartialOnStall) {
      try {
        const partial = await exportArtifacts(options.proxy, options, runId, outputDir, log, error.details?.progress || null);
        const partialManifest = {
          status: "STALLED",
          partial: true,
          runId,
          options,
          progress: error.details?.progress || {},
          diagnosticKind: error.details?.diagnosticKind || "UNKNOWN",
          stallEvidence: {
            screenshot: error.details?.screenshot || "",
            diagnostics: error.details?.diagnostics || "",
          },
          artifacts: partial.files,
          validation: partial.validation,
          warnings: partial.warnings,
          runDir,
        };
        const manifestPath = path.join(runDir, "manifest.json");
        await writeFile(manifestPath, JSON.stringify(partialManifest, ensureJsonReplacer, 2), "utf8");
        await log("PARTIAL_EXPORTED", { rows: partial.validation.validation.rows, runDir, manifest: manifestPath });
        error.details = { ...error.details, partialManifest: manifestPath, artifacts: partial.files, validation: partial.validation };
      } catch (partialError) {
        await log("PARTIAL_EXPORT_FAILED", { error: partialError.message, runDir });
        error.details = { ...error.details, partialExportError: partialError.message };
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
  const exported = await exportArtifacts(options.proxy, options, runId, outputDir, log, completed.progress);
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
}

async function run(options) {
  const runtimeRoot = process.env.XWS_RUNTIME_DIR || path.join(PROJECT_ROOT, "runtime", "xws-runs");
  await mkdir(runtimeRoot, { recursive: true });
  const lockPath = path.join(runtimeRoot, ".market-analysis.lock");
  const lock = await acquireRuntimeLock(lockPath);
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
    return code === "HUMAN_REQUIRED" ? 2 : code === "STALLED" ? 3 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { helpText, selfTest };
