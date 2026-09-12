#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  assertAllowedSycmUrl,
  ensureSevenDayPeriod,
  enterSearchRankFromHome,
  PERIOD_SELECTED_CLASS_PATTERN,
  parseReportingWindow,
  rediscoverSycmTarget,
  resolveSycmTarget,
  waitForPageSize,
  waitForVisibleOption,
  waitForSycmPath,
} from "./full-flow.mjs";
import { publishValidatedOutputs } from "./output-publish.mjs";
import { verifyExportPair } from "./source-period-proof.mjs";

const PROXY_DEFAULT = "http://127.0.0.1:3456";
const REQUIRED_HEADERS = ["排名", "搜索词", "搜索人气", "点击率", "支付转化率"];
const TOP_RANK_ASSETS = new Map([
  ["O1CN01DXTKWC1J3gIsNwyQH_", 1],
  ["O1CN01X0pxSi1yCHzgsRk47_", 2],
  ["O1CN018xH1Ts1DRbIDMkvZ2_", 3],
]);
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    proxy: process.env.SYCM_PROXY || PROXY_DEFAULT,
    target: "",
    period: "7d",
    date: "latest",
    cateId: "50002411",
    category: "普通浴缸",
    outputDir: path.join(homedir(), "Downloads"),
    prefix: "",
    delayMs: 1200,
    maxPages: 20,
    fromHome: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (token === "--from-home") {
      args.fromHome = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    i += 1;
    if (key === "proxy") args.proxy = value.replace(/\/$/u, "");
    else if (key === "target") args.target = value;
    else if (key === "period") args.period = value;
    else if (key === "date") args.date = value;
    else if (key === "cate-id") args.cateId = value;
    else if (key === "category") args.category = value;
    else if (key === "output-dir") args.outputDir = path.resolve(value);
    else if (key === "prefix") args.prefix = value;
    else if (key === "delay-ms") args.delayMs = Number(value);
    else if (key === "max-pages") args.maxPages = Number(value);
    else throw new Error(`Unknown argument: --${key}`);
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 800) throw new Error("--delay-ms must be at least 800");
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1) throw new Error("--max-pages must be a positive integer");
  if (args.period !== "7d") throw new Error("--period currently supports only 7d");
  return args;
}

function printHelp() {
  console.log(`Usage: node export-search-rank.mjs [options]

Options:
  --period 7d               Require the 7-day reporting period (default: 7d)
  --date latest|YYYY-MM-DD  Select the end date of the 7-day reporting window (default: latest)
  --cate-id ID              Expected page category id (default: 50002411)
  --category TEXT           Expected visible category label (default: 普通浴缸)
  --output-dir DIR          Output directory (default: ~/Downloads)
  --prefix NAME             Output filename prefix
  --delay-ms N              Fixed wait between UI actions, minimum 800 (default: 1200)
  --max-pages N             Pagination safety limit (default: 20)
  --from-home               Navigate visibly from the SYCM home page before export
  --target ID               Optional one-run target override; never persisted
  --proxy URL               CDP proxy URL (default: http://127.0.0.1:3456)
  --self-test               Run rank validation without a browser or network
  --help                    Show this help
`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(proxy, endpoint, options = {}) {
  const response = await fetch(`${proxy}${endpoint}`, options);
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 500);
    throw new Error(`CDP proxy ${endpoint} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    const data = JSON.parse(text);
    if (data?.error) throw new Error("CDP proxy returned an error");
    return data;
  } catch (error) {
    if (error.message === "CDP proxy returned an error") throw error;
    throw new Error("CDP proxy returned invalid JSON");
  }
}

async function freshTarget(proxy, expectedTarget) {
  const target = await rediscoverSycmTarget({
    expectedTarget,
    listTargets: () => request(proxy, "/targets"),
  });
  return target.targetId;
}

async function evaluate(proxy, target, expression) {
  const currentTarget = await freshTarget(proxy, target);
  const data = await request(proxy, `/eval?target=${encodeURIComponent(currentTarget)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: expression,
  });
  if (!("value" in data)) throw new Error("CDP eval returned no value");
  if (typeof data.value !== "string") return data.value;
  try {
    return JSON.parse(data.value);
  } catch {
    return data.value;
  }
}

async function click(proxy, target, selector) {
  const currentTarget = await freshTarget(proxy, target);
  return request(proxy, `/click?target=${encodeURIComponent(currentTarget)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: selector,
  });
}

async function navigate(proxy, target, value) {
  const url = assertAllowedSycmUrl(value);
  const currentTarget = await freshTarget(proxy, target);
  return request(proxy, `/navigate?target=${encodeURIComponent(currentTarget)}&url=${encodeURIComponent(url.href)}`);
}

async function createTab(proxy, value) {
  const url = assertAllowedSycmUrl(value);
  return request(proxy, `/new?url=${encodeURIComponent(url.href)}`);
}

function humanRequired(reason, details = {}) {
  const error = new Error(reason);
  error.code = "HUMAN_REQUIRED";
  error.details = details;
  return error;
}

function utcDay(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function safeName(value) {
  return String(value).replace(/[^\w\u4e00-\u9fff.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "sycm-search-ranking";
}

async function inspectPage(proxy, target) {
  return evaluate(proxy, target, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const required = ${JSON.stringify(REQUIRED_HEADERS)};
    const tables = Array.from(document.querySelectorAll('table'));
    const dataTable = tables.find((table) => {
      const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.innerText.trim());
      return required.every((name) => heads.includes(name)) && !table.classList.contains('ant-table-fixed');
    });
    const dateNode = document.querySelector('.oui-date-picker-current-date');
    const category = document.querySelector('.common-picker-header');
    const commDate = document.querySelector('[comm-date]')?.getAttribute('comm-date') || '';
    let updateDay = '';
    try { updateDay = JSON.parse(commDate).updateDay || ''; } catch {}
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .ant-modal, .oui-dialog'))
      .filter(visible)
      .map((el) => el.innerText.trim().slice(0, 500))
      .filter(Boolean);
    const body = (document.body?.innerText || '').slice(0, 5000);
    const pageSize = document.querySelector('.oui-page-size-select .ant-select-selection-selected-value')?.innerText.trim() || '';
    const active = document.querySelector('.ant-pagination-item-active')?.getAttribute('title') || '';
    const next = document.querySelector('.ant-pagination-next');
    const prev = document.querySelector('.ant-pagination-prev');
    const arrows = Array.from(document.querySelectorAll('.item-date .oui-date-picker-particle-button button.arrow'))
      .map((button) => ({ disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' }));
    const periodLabels = new Set(['7天', '30天', '日']);
    const periodNodes = Array.from(document.querySelectorAll('.item-date button, .item-date [role="tab"], .item-date [role="radio"], .item-date label, .item-date li, .item-date a, .item-date span, .item-date div'))
      .filter(visible)
      .filter((el) => periodLabels.has(el.innerText.trim()))
      .filter((el) => !Array.from(el.children).some((child) => visible(child) && child.innerText.trim() === el.innerText.trim()));
    const periodOptions = Array.from(periodLabels, (label) => {
      const node = periodNodes.find((el) => el.innerText.trim() === label);
      if (!node) return null;
      const target = node.closest('button, [role="tab"], [role="radio"], label, li, a') || node;
      const candidates = [target, target.parentElement].filter(Boolean);
      const selected = candidates.some((el) =>
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-checked') === 'true' ||
        new RegExp(${JSON.stringify(PERIOD_SELECTED_CLASS_PATTERN.source)}, 'iu').test(String(el.className || ''))
      );
      return { label, selected, tagName: target.tagName, className: String(target.className || '') };
    }).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      currentDate: dateNode?.innerText.trim() || '',
      updateDay,
      categoryTitle: category?.getAttribute('title') || '',
      cateId: new URL(location.href).searchParams.get('cateId') || '',
      pageSize,
      activePage: active ? Number(active) : null,
      nextDisabled: !next || next.classList.contains('ant-pagination-disabled') || next.getAttribute('aria-disabled') === 'true',
      prevDisabled: !prev || prev.classList.contains('ant-pagination-disabled') || prev.getAttribute('aria-disabled') === 'true',
      arrows,
      periodOptions,
      rowCount: dataTable ? dataTable.querySelectorAll('tbody tr[data-row-key]').length : 0,
      firstRank: dataTable ? dataTable.querySelector('tbody tr[data-row-key]')?.cells[0]?.innerText.trim() || '' : '',
      hasDataTable: Boolean(dataTable),
      dialogs,
      loginLike: /custom\\/login|账号登录|密码登录|扫码登录|请登录/u.test(location.href + '\\n' + body),
      riskLike: dialogs.some((text) => /访问存在风险|账号风险|安全限制|异常访问|访问受限|操作过于频繁|请求过于频繁|限制访问|验证码|滑动验证|短信验证|安全验证|请稍后再试/u.test(text)),
    };
  })()`);
}

function guardSession(state) {
  if (state.loginLike || /custom\/login/u.test(state.url)) {
    throw humanRequired("当前生意参谋会话需要人工登录后再继续", { url: state.url });
  }
  if (state.riskLike) {
    throw humanRequired("检测到生意参谋登录/安全限制，请由人工处理后再继续", { dialogs: state.dialogs });
  }
}

function guardPage(state) {
  guardSession(state);
  if (!state.hasDataTable) {
    throw humanRequired("当前标签页不是可读取的搜索排行页面，请人工打开搜索排行后再继续", { url: state.url });
  }
}

async function waitFor(proxy, target, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspectPage(proxy, target);
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForPath(proxy, target, expectedPath, expected = {}) {
  return waitForSycmPath({
    expectedPath,
    cateId: expected.cateId,
    category: expected.category,
    requireDataTable: expected.requireDataTable,
    inspect: () => inspectPage(proxy, target),
    guardSession,
    sleep,
  });
}

async function waitForSelector(proxy, target, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectPage(proxy, target);
    guardSession(state);
    const ready = await evaluate(proxy, target, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })()`);
    if (ready) return true;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for selector: ${selector}`);
}

async function discoverTarget(proxy, explicitTarget, fromHome) {
  const targets = await request(proxy, "/targets");
  try {
    const selected = await resolveSycmTarget({
      targets,
      explicitTarget,
      fromHome,
      createHomeTab: () => createTab(proxy, "https://sycm.taobao.com/portal/home.htm"),
      listTargets: () => request(proxy, "/targets"),
    });
    return selected.targetId;
  } catch (error) {
    if (explicitTarget) throw error;
    throw humanRequired(error.message, { targetCount: Array.isArray(targets) ? targets.length : 0 });
  }
}

async function clickReportingPeriod(proxy, target, label) {
  const selector = await evaluate(proxy, target, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const expected = ${JSON.stringify(label)};
    const labels = Array.from(document.querySelectorAll('.item-date button, .item-date [role="tab"], .item-date [role="radio"], .item-date label, .item-date li, .item-date a, .item-date span, .item-date div'))
      .filter(visible)
      .filter((el) => el.innerText.trim() === expected)
      .filter((el) => !Array.from(el.children).some((child) => visible(child) && child.innerText.trim() === expected));
    const node = labels[0];
    const clickable = node?.closest('button, [role="tab"], [role="radio"], label, li, a') || node;
    if (!clickable) return '';
    document.querySelectorAll('[data-codex-sycm-period]').forEach((el) => el.removeAttribute('data-codex-sycm-period'));
    clickable.setAttribute('data-codex-sycm-period', 'target');
    return '[data-codex-sycm-period="target"]';
  })()`);
  if (!selector) throw new Error(`Could not prepare reporting period option: ${label}`);
  await click(proxy, target, selector);
}

async function selectDate(proxy, target, desired, delayMs) {
  let state = await inspectPage(proxy, target);
  guardPage(state);
  const current = parseReportingWindow(state.currentDate)?.endDate || "";
  if (!current) throw new Error("Could not read the current page date");
  const targetDate = desired === "latest" ? (state.updateDay || current) : desired;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(targetDate)) throw new Error(`Invalid --date: ${targetDate}`);
  const difference = Math.round((utcDay(targetDate) - utcDay(current)) / DAY_MS);
  if (!Number.isFinite(difference)) throw new Error("Could not calculate date difference");
  if (Math.abs(difference) > 31) {
    throw humanRequired("目标日期距离当前页面日期超过 31 天，请人工确认日期范围", { current, targetDate });
  }
  const direction = difference < 0 ? -1 : 1;
  const selectorIndex = direction < 0 ? 4 : 5;
  for (let i = 0; i < Math.abs(difference); i += 1) {
    state = await inspectPage(proxy, target);
    guardPage(state);
    if (state.arrows?.[direction < 0 ? 0 : 1]?.disabled) {
      throw humanRequired("页面日期控件不允许继续移动到目标日期", {
        current: parseReportingWindow(state.currentDate)?.endDate || "",
        targetDate,
      });
    }
    const before = parseReportingWindow(state.currentDate)?.endDate || "";
    await click(proxy, target, `.item-date .oui-date-picker-particle-button button.arrow:nth-of-type(${selectorIndex})`);
    state = await waitFor(proxy, target, (next) => parseReportingWindow(next.currentDate)?.endDate !== before, 15000, "date control");
    guardPage(state);
    await sleep(delayMs);
  }
  state = await inspectPage(proxy, target);
  guardPage(state);
  if (parseReportingWindow(state.currentDate)?.endDate !== targetDate) {
    throw new Error(`Date selection did not settle on ${targetDate}`);
  }
  return { state, date: targetDate };
}

async function ensurePageSize(proxy, target, delayMs) {
  let state = await inspectPage(proxy, target);
  guardPage(state);
  if (state.pageSize === "50") return state;
  await click(proxy, target, ".oui-page-size-select .ant-select-selection");
  await waitForVisibleOption({
    readOption: () => evaluate(proxy, target, `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const options = Array.from(document.querySelectorAll('[role="option"], .ant-select-dropdown-menu-item, .ant-select-dropdown li'));
      const option = options.find((el) => visible(el) && el.innerText.trim() === '50');
      if (!option) {
        const selection = document.querySelector('.oui-page-size-select .ant-select-selection');
        if (selection?.getAttribute('aria-expanded') !== 'true') selection?.click();
        return false;
      }
      option.click();
      return true;
    })()`),
    sleep,
  });
  state = await waitForPageSize({
    inspect: () => inspectPage(proxy, target),
    sleep,
  });
  guardPage(state);
  await sleep(delayMs);
  return state;
}

async function goFirstPage(proxy, target, delayMs) {
  for (let i = 0; i < 25; i += 1) {
    const state = await inspectPage(proxy, target);
    guardPage(state);
    if (state.activePage === 1) return state;
    if (state.activePage === null) throw new Error("Could not read active pagination page");
    const first = await evaluate(proxy, target, `Boolean(document.querySelector('.ant-pagination-item[title="1"]'))`);
    if (first) await click(proxy, target, '.ant-pagination-item[title="1"]');
    else if (!state.prevDisabled) await click(proxy, target, '.ant-pagination-prev:not(.ant-pagination-disabled)');
    else throw new Error("Pagination is not on page 1 and previous is disabled");
    await waitFor(proxy, target, (next) => next.activePage !== state.activePage, 10000, "first pagination page");
    await sleep(delayMs);
  }
  throw new Error("Could not return to pagination page 1");
}

async function extractPage(proxy, target) {
  return evaluate(proxy, target, `(() => {
    const required = ${JSON.stringify(REQUIRED_HEADERS)};
    const table = Array.from(document.querySelectorAll('table')).find((candidate) => {
      const heads = Array.from(candidate.querySelectorAll('thead th')).map((th) => th.innerText.trim());
      return required.every((name) => heads.includes(name)) && !candidate.classList.contains('ant-table-fixed');
    });
    if (!table) throw new Error('Search ranking data table not found');
    const metric = (cell) => cell.querySelector('.alife-dt-card-common-table-sortable-value')?.innerText.trim() || cell.innerText.trim();
    const rows = Array.from(table.querySelectorAll('tbody tr[data-row-key]')).map((row) => {
      const cells = Array.from(row.children);
      return {
        rankText: cells[0]?.innerText.trim() || '',
        rankImage: cells[0]?.querySelector('img')?.getAttribute('src') || '',
        term: cells[1]?.innerText.replace(/\\s+/gu, ' ').trim() || '',
        searchPopularity: metric(cells[2]),
        clickRate: metric(cells[3]),
        payConversionRate: metric(cells[4]),
      };
    });
    const active = document.querySelector('.ant-pagination-item-active')?.getAttribute('title') || '';
    const next = document.querySelector('.ant-pagination-next');
    return {
      page: active ? Number(active) : null,
      pageSize: document.querySelector('.oui-page-size-select .ant-select-selection-selected-value')?.innerText.trim() || '',
      nextDisabled: !next || next.classList.contains('ant-pagination-disabled') || next.getAttribute('aria-disabled') === 'true',
      rows,
    };
  })()`);
}

function resolveRank(row) {
  const numeric = Number.parseInt(row.rankText, 10);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  for (const [fragment, rank] of TOP_RANK_ASSETS) {
    if (row.rankImage.includes(fragment)) return rank;
  }
  throw new Error("Unknown top-three rank icon; refusing to infer rank");
}

function validateRows(rows, pageSizes) {
  if (!rows.length) throw new Error("No search-ranking rows were extracted");
  const normalized = rows.map((row) => ({
    rank: resolveRank(row),
    term: row.term,
    searchPopularity: row.searchPopularity,
    clickRate: row.clickRate,
    payConversionRate: row.payConversionRate,
  }));
  const ranks = normalized.map((row) => row.rank);
  const uniqueRanks = new Set(ranks);
  if (uniqueRanks.size !== ranks.length) throw new Error("Duplicate ranks detected");
  const sorted = [...ranks].sort((a, b) => a - b);
  const expected = Array.from({ length: sorted.length }, (_, index) => index + 1);
  if (sorted.some((value, index) => value !== expected[index])) {
    throw new Error(`Ranks are not contiguous 1..N (missing or extra rank near ${sorted.find((value, index) => value !== expected[index])})`);
  }
  const terms = normalized.map((row) => row.term);
  if (terms.some((term) => !term) || new Set(terms).size !== terms.length) throw new Error("Search terms are blank or duplicated");
  for (const row of normalized) {
    if (!row.searchPopularity || !row.clickRate || !row.payConversionRate) throw new Error(`Blank metric for rank ${row.rank}`);
  }
  if (pageSizes.some((size, index) => index < pageSizes.length - 1 && size !== 50)) {
    throw new Error(`A non-final page did not contain 50 rows: ${pageSizes.join("/")}`);
  }
  if (pageSizes.some((size) => size < 1 || size > 50)) throw new Error(`Invalid page sizes: ${pageSizes.join("/")}`);
  normalized.sort((a, b) => a.rank - b.rank);
  return {
    rows: normalized,
    validation: {
      rowCount: normalized.length,
      rankRange: `1-${normalized.length}`,
      uniqueRanks: true,
      contiguousRanks: true,
      uniqueTerms: true,
      nonEmptyMetrics: true,
      pageSizes,
    },
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function writeCsv(rows, file) {
  const header = ["排名", "搜索词", "搜索人气", "点击率", "支付转化率"];
  const lines = [header, ...rows.map((row) => [row.rank, row.term, row.searchPopularity, row.clickRate, row.payConversionRate])]
    .map((line) => line.map(csvCell).join(","));
  return writeFile(file, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function findPython() {
  const candidates = [];
  if (process.env.SYCM_PYTHON) candidates.push({ command: process.env.SYCM_PYTHON, args: [] });
  candidates.push({ command: path.join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"), args: [] });
  candidates.push({ command: "python3", args: [] }, { command: "python", args: [] }, { command: "py", args: ["-3"] });
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "-c", "import openpyxl"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  throw new Error("No Python runtime with openpyxl was found; CSV was written but XLSX cannot be created");
}

async function writeXlsx(metadata, rows, file) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "sycm-export-"));
  const jsonFile = path.join(tempDir, "payload.json");
  const scriptFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "write-workbook.py");
  await writeFile(jsonFile, JSON.stringify({ metadata, rows }, null, 2), "utf8");
  try {
    const python = findPython();
    const result = spawnSync(python.command, [...python.args, scriptFile, jsonFile, file], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Workbook writer exited with status ${result.status}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function selfTest() {
  const sample = [
    { rankText: "", rankImage: "O1CN01DXTKWC1J3gIsNwyQH_", term: "a", searchPopularity: "1", clickRate: "2%", payConversionRate: "-" },
    { rankText: "3", rankImage: "", term: "c", searchPopularity: "3", clickRate: "4%", payConversionRate: "5%" },
    { rankText: "2", rankImage: "", term: "b", searchPopularity: "2", clickRate: "3%", payConversionRate: "4%" },
  ];
  const result = validateRows(sample, [3]);
  console.log(JSON.stringify({ ok: true, ...result.validation }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.selfTest) return selfTest();
  const proxy = args.proxy;
  const target = await discoverTarget(proxy, args.target, args.fromHome);
  if (args.fromHome) {
    await enterSearchRankFromHome({
      cateId: args.cateId,
      category: args.category,
      navigate: (url) => navigate(proxy, target, url),
      waitForSelector: (selector) => waitForSelector(proxy, target, selector),
      click: (selector) => click(proxy, target, selector),
      waitForPath: (expectedPath, expected) => waitForPath(proxy, target, expectedPath, expected),
      guardSession,
    });
  }
  let state = await inspectPage(proxy, target);
  guardPage(state);
  if (!/\/mc\/free\/search_rank/u.test(state.url)) {
    throw humanRequired("标签页已登录但不在搜索排行页面，请人工通过市场 > 搜索排行打开目标页", { url: state.url });
  }
  if (args.cateId && state.cateId !== args.cateId) {
    throw humanRequired("当前页面类目与预期不一致，请人工用页面类目选择器切换后再继续", { actualCateId: state.cateId, expectedCateId: args.cateId, categoryTitle: state.categoryTitle });
  }
  if (args.category && !state.categoryTitle.includes(args.category)) {
    throw humanRequired("当前页面可见类目与预期不一致，请人工用页面类目选择器切换后再继续", { actualCategory: state.categoryTitle, expectedCategory: args.category });
  }
  await ensureSevenDayPeriod({
    inspect: () => inspectPage(proxy, target),
    clickPeriod: (label) => clickReportingPeriod(proxy, target, label),
    guardPage,
    sleep,
  });
  const dateResult = await selectDate(proxy, target, args.date, args.delayMs);
  const reporting = await ensureSevenDayPeriod({
    inspect: () => inspectPage(proxy, target),
    clickPeriod: (label) => clickReportingPeriod(proxy, target, label),
    guardPage,
    sleep,
  });
  state = await ensurePageSize(proxy, target, args.delayMs);
  state = await goFirstPage(proxy, target, args.delayMs);
  const pagePayloads = [];
  for (let pageIndex = 0; pageIndex < args.maxPages; pageIndex += 1) {
    state = await inspectPage(proxy, target);
    guardPage(state);
    const payload = await extractPage(proxy, target);
    if (!payload.rows.length) throw new Error(`Page ${payload.page ?? pageIndex + 1} has no rows`);
    pagePayloads.push(payload);
    console.error(`SYCM page ${payload.page ?? pageIndex + 1}: ${payload.rows.length} rows`);
    if (payload.nextDisabled) break;
    const beforePage = payload.page;
    const beforeFirstRank = payload.rows[0]?.rankText || "";
    await click(proxy, target, '.ant-pagination-next:not(.ant-pagination-disabled)');
    // The active page number updates before the table body refreshes; waiting
    // only for the page number races the DOM update and re-reads the old page
    // (duplicate ranks). Require the first row's rank to change as well.
    await waitFor(proxy, target, (next) => next.activePage !== beforePage
      && next.rowCount > 0
      && (next.firstRank || "") !== beforeFirstRank, 15000, "next pagination page");
    await sleep(args.delayMs);
  }
  if (pagePayloads.length === args.maxPages && !pagePayloads.at(-1).nextDisabled) {
    throw new Error(`Reached --max-pages=${args.maxPages} before the last page`);
  }
  const pageSizes = pagePayloads.map((page) => page.rows.length);
  const rawRows = pagePayloads.flatMap((page) => page.rows);
  const checked = validateRows(rawRows, pageSizes);
  await goFirstPage(proxy, target, args.delayMs);
  state = await inspectPage(proxy, target);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14);
  const base = safeName(args.prefix || `shengyicanmou-search-ranking-${dateResult.date}-${stamp}`);
  const metadata = {
    source: "生意参谋搜索排行",
    sourceUrl: state.url,
    date: dateResult.date,
    period: reporting.period,
    startDate: reporting.startDate,
    endDate: reporting.endDate,
    dayCount: reporting.dayCount,
    dateRange: reporting.dateRange,
    category: state.categoryTitle,
    cateId: state.cateId,
    exportedAt: new Date().toISOString(),
    pages: pagePayloads.length,
    ...checked.validation,
  };
  const { csvFile, xlsxFile, validation: proof } = await publishValidatedOutputs({
    outputDir: args.outputDir,
    base,
    writeCsv: (file) => writeCsv(checked.rows, file),
    writeXlsx: (file) => writeXlsx(metadata, checked.rows, file),
    verifyOutputs: (csv, xlsx) => verifyExportPair({ csv, xlsx, expectedEndDate: reporting.endDate }),
  });
  console.log(JSON.stringify({ ok: true, metadata, csv: csvFile, xlsx: xlsxFile, proof }, null, 2));
}

main().catch((error) => {
  const payload = { ok: false, code: error.code || "ERROR", message: error.message };
  if (error.details) payload.details = error.details;
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = error.code === "HUMAN_REQUIRED" ? 2 : 1;
});
