#!/usr/bin/env node

/**
 * 「执行一个命名修复动作」—— agent 修复回环里的**执行侧**（2026-09-29）。
 *
 * 它要解决的问题（用户原话）：**「这个重试必须要让 agent 根据失败原因去修复，再重试」**。
 * 拆成两半：
 *   · **判断**（这一处该怎么修）→ agent 读现场（`98-failure-state.json`）+ 候选菜单
 *     （`repair-actions.mjs` 的 `planRepair`）后，挑一个动作名；
 *   · **执行**（这个动作具体怎么做）→ 本脚本。
 * 本脚本**不做任何判断**：给它一个动作名，它在真实页面上执行那一个动作，
 * 回读结果，落证据，然后退出。要不要再重试、值不值得换下一个动作 —— 那是 agent 的事。
 *
 * 为什么要单独一个 CLI 而不是并进驱动：agent 在**两轮命令之间**做判断，
 * 所以「执行一个修复动作」这件事必须是一个**能独立调用**的东西。并进驱动的话，
 * agent 就没有插话的位置了。
 *
 * 用法：
 *   node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs \
 *     --shop 里可林淘宝 --proxy http://127.0.0.1:19041 \
 *     --stage promotion-fetch --cause PAGE_OBSTRUCTED --action DISMISS_OVERLAYS \
 *     --log-dir evidence/.../里可林淘宝
 *
 *   # 只看会怎么做，一个字节都不写页面（量出来给人/agent 看）
 *   ... --action RELOAD_PAGE --dry-run
 *
 * 四个动作（`repair-actions.mjs` 的闭集）：
 *   DISMISS_OVERLAYS  关掉盖住整页的弹窗（复用 collect-core 的 createOverlayDismisser）
 *   RESET_PAGES       按期望清单把页签归位（复用 runtime/page-normalize.mjs）
 *   RELOAD_PAGE       对目标页发一次**真重载**（navigate 到同 URL 是空操作，本项目实测过）
 *   REAPPLY_DATES     重跑落位（把日期重新落到页面上；复用 date-picker 的落位能力）
 *
 * 三条纪律（与感知层、分诊表、修复表同一个立场）：
 *   1) **永不抛**：本脚本自己 try 住一切，永远返回一个结论对象（退出码 0/1/3）。
 *      修复失败是「学到一个动作没用」，不是「又崩了一次」—— 绝不能盖掉原来那个失败。
 *   2) **回读判定，不自证**：每个动作执行后都要**独立回读**一个判据（可见层数、页签数、
 *      就绪状态），拿回读结果判定 `applied`。写「我点了所以应该好了」正是本项目反复吃过的亏。
 *   3) **认不出目标页就什么都不做**：`--proxy` 是唯一的实例选择器，`--shop` 只写名字；
 *      两者对不上时停手（同 `login-merchant.mjs` 的纪律）。找不到该修哪一页时如实报
 *      `TARGET_PAGE_MISSING`，**不猜一页去动**。
 *
 * ⚠️ 本脚本**会改到运行中的浏览器**（关弹窗、重载、归位）。它是写路径，所以：
 *   · `--dry-run` 一个写请求都不发（只读、量出来）；
 *   · 它只对 `--proxy` 指的那一个浏览器、`--stage` 提示的那一页做事，不碰别处。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

import { PROJECT_PORTS, shopInstance, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
import { normalizePages } from '../../../runtime/page-normalize.mjs';
import {
  createOverlayDismisser, createPageReloader, overlayScanExpression,
} from './collect-core.mjs';
import { expectedPagesForShop } from './expected-pages.mjs';
import { PAGE_MUTATING_ACTIONS, REPAIR_ACTIONS, planRepair } from './repair-actions.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 退出码口径（与链上一致）：0=动作做成了且回读确认；1=动作做了但没成/不该做；3=读不到、没有结论。 */
export const REPAIR_EXIT_CODES = Object.freeze({ APPLIED: 0, NOT_APPLIED: 1, INCONCLUSIVE: 3 });

// ---------------------------------------------------------------------------
// IO：与 collect-promotion-report.mjs 同一套代理调用（只留这个脚本用得到的几个）
// ---------------------------------------------------------------------------
async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

async function evalOn(args, targetId, expression) {
  const payload = JSON.parse(await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression }));
  try { return JSON.parse(payload?.value); } catch { return payload?.value; }
}

async function bringToFront(args, targetId) {
  await proxyJson(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
}

async function clickPoint(args, targetId, point) {
  return proxyJson(`${args.proxy}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }) });
}

async function pressKey(args, targetId, key) {
  return proxyJson(`${args.proxy}/key?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ key }) });
}

const dismissOverlays = createOverlayDismisser({
  evalOn: (args, targetId, expression) => evalOn(args, targetId, expression),
  clickPoint: (args, targetId, point) => clickPoint(args, targetId, point),
  pressEscape: (args, targetId) => pressKey(args, targetId, 'Escape'),
  delay,
  log: (...parts) => console.log(...parts),
});

const reloadPage = createPageReloader({
  evalOn: (args, targetId, expression) => evalOn(args, targetId, expression),
  delay,
  log: (...parts) => console.log(...parts),
});

/**
 * 只读：读该浏览器当前的页签 URL 列表。失败返回 null（＝读不到，不静默成空数组）。
 * 为什么要把「读不到」与「零页签」分开：前者是「不知道」，后者是「真的没有」，
 * 后面拿它做目标页定位，混起来会把「代理连不上」误报成「页面不在」。
 */
async function readTargetUrls(args) {
  try {
    const targets = JSON.parse(await proxyJson(`${args.proxy}/targets`));
    return { ok: true, targets };
  } catch (error) {
    return { ok: false, targets: null, error: String(error?.message ?? error) };
  }
}

/**
 * 找到这个动作要修的那一页。判据是**语义标签 + 站点主机**，不是写死的 targetId
 * （targetId 每次冷启动都会变，绝不能持久化）。
 *
 * 返回 `{ ok, targetId, url }` 或 `{ ok:false, reason }`。**认不出来就如实说**，
 * 绝不回落到「第一个页签」—— 那会对着别的店的窗口做事。
 */
export function locateStagePage({ targets = [], stageHint = null } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, reason: 'no-targets' };
  const pages = targets.filter((t) => t.type === 'page' && !String(t.url ?? '').startsWith('about:'));
  if (!pages.length) return { ok: false, reason: 'no-page-targets' };
  const byHost = {
    alimama: 'one.alimama.com',
    sycm: 'sycm.taobao.com',
  };
  const host = stageHint ? byHost[stageHint] : null;
  if (!host) {
    // 没有阶段提示时不猜：只接受「恰好一个非 about: 页」这一种情形，否则停手。
    if (pages.length === 1) return { ok: true, targetId: pages[0].targetId, url: String(pages[0].url) };
    return { ok: false, reason: `没有阶段页提示、且窗口里有 ${pages.length} 个页签 ⇒ 不猜要修哪一页` };
  }
  const matches = pages.filter((t) => String(t.url ?? '').includes(host));
  if (matches.length === 1) return { ok: true, targetId: matches[0].targetId, url: String(matches[0].url) };
  if (matches.length === 0) return { ok: false, reason: `窗口里找不到 ${host} 的页` };
  return { ok: false, reason: `窗口里有 ${matches.length} 个 ${host} 的页 ⇒ 不猜要修哪一个` };
}

/** 解析 CLI 参数。**闭集校验**：动作名不在闭集里当场抛（不静默变「什么也没做」）。 */
export function parseRepairArgs(argv) {
  const args = { shop: null, proxy: null, stage: null, cause: null, action: null,
    logDir: null, dryRun: false, settleMs: 2500, timeoutMs: 20000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${key} requires a value`);
      return value;
    };
    if (key === '--shop') args.shop = next();
    else if (key === '--proxy') args.proxy = next();
    else if (key === '--stage') args.stage = next();
    else if (key === '--cause') args.cause = next();
    else if (key === '--action') args.action = next();
    else if (key === '--log-dir') args.logDir = next();
    else if (key === '--settle-ms') args.settleMs = Number(next());
    else if (key === '--timeout-ms') args.timeoutMs = Number(next());
    else if (key === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.action) throw new Error('必须给 --action（要执行哪一个修复动作）');
  if (!REPAIR_ACTIONS.includes(args.action)) {
    throw new Error(`--action "${args.action}" 不在闭集 ${REPAIR_ACTIONS.join(' / ')} 里`
      + ' —— 拼错的动作名会静默变成「什么也没做」，所以宁可在解析期停手');
  }
  return args;
}

/**
 * `--shop` 与 `--proxy` 的**一致性核对**（同 login-merchant 的纪律）。
 *
 * 为什么必须有：`--proxy` 是唯一的实例选择器（`--shop` 只写名字）。两者对不上时脚本
 * 什么都不碰就停 —— 2026-09-22 那次「五家体检其实都打在同一个实例上」就是这么发生的。
 * 不给 `--proxy` 时回落到商家浏览器默认端口（与 collect-promotion 同一口径）。
 */
export function resolveProxy(args) {
  const fallback = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  const proxy = args.proxy ?? fallback;
  if (args.shop && shopBrowserKeys().includes(args.shop) && args.proxy) {
    const expected = `http://127.0.0.1:${shopInstance(args.shop).proxyPort}`;
    if (proxy !== expected) {
      throw new Error(`--shop ${args.shop} 与 --proxy ${proxy} 对不上（这家店自己的代理是 ${expected}）`
        + ' —— 两者对不上时脚本什么都不碰就停');
    }
  }
  return proxy;
}

// ---------------------------------------------------------------------------
// 四个动作。每个都返回 { applied:boolean, detail:string, evidence:object }
// ---------------------------------------------------------------------------

/** 关掉盖住整页的弹窗。回读判据由 createOverlayDismisser 自己给（它扫-选-点-回读）。 */
async function runDismissOverlays(args, targetId) {
  const scan = await evalOn(args, targetId, overlayScanExpression());
  if (!scan || scan.blocked !== true) {
    return { applied: false, detail: '这一页当前没有被全屏遮挡层挡住（没有要关的东西）',
      evidence: { blocked: scan?.blocked ?? null } };
  }
  const result = await dismissOverlays(args, targetId);
  return {
    applied: result?.dismissed === true,
    detail: result?.dismissed
      ? `遮挡层已关掉（${result.strategy}；试过：${(result.tried ?? []).join('；')}）`
      : `试过 ${(result?.tried ?? []).length} 种关法都没关掉`,
    evidence: { strategy: result?.strategy ?? null, tried: result?.tried ?? [],
      remainingLayers: result?.remainingLayers ?? null },
  };
}

/** 真重载目标页，并等它就绪。
 *
 * `createPageReloader` 返回的是**布尔**（`true` = 等到 readyState=complete），不是对象 ——
 * 这一点要盯住：它内部已经做了「重载 → 轮询就绪」的完整回读，本动作直接采信那个布尔即可。
 * 采信它不等于「自证」：它的判据是从页面读回来的 `readyState`，不是「我发了 reload 所以应该好了」。 */
async function runReloadPage(args, targetId) {
  const before = await evalOn(args, targetId, 'JSON.stringify({ href: location.href, readyState: document.readyState })');
  const settled = await reloadPage(args, targetId);
  const ok = settled === true;
  return {
    applied: ok,
    detail: ok ? '页面已重载并就绪' : '重载后没能确认页面就绪（超时）',
    evidence: { before, reloadSettled: settled },
  };
}

/** 按期望清单归位（复用 runtime/page-normalize.mjs）。 */
async function runResetPages(args) {
  const port = Number(new URL(args.proxy).port);
  if (!Number.isInteger(port) || port <= 0) {
    return { applied: false, detail: `从 --proxy 里读不出端口：${args.proxy}`, evidence: {} };
  }
  const result = await normalizePages({
    proxyPort: port, expected: expectedPagesForShop(), dry: args.dryRun,
  });
  return {
    applied: result?.verdict?.ok === true,
    detail: result?.verdict?.detail ?? '归位没有给出结论',
    evidence: { before: result?.before ?? null, after: result?.after ?? null,
      changed: result?.changed ?? null, actions: result?.actions ?? null },
  };
}

/**
 * 重跑落位。**刻意不在这里实现落位逻辑**：那是 `date-picker.mjs` 的知识，
 * 各写一份就是两处漂移。本动作的形态是「把这件事交给落位那一步」——
 * 它要求调用方（agent）接着重试 `alimama-date` / `sycm-date` 阶段。
 */
async function runReapplyDates(args, { stageHint = null } = {}) {
  if (!stageHint) {
    return { applied: false, detail: '没有阶段提示 ⇒ 不知道该把日期落到哪个站点，停手',
      evidence: {} };
  }
  // 落位是 date-picker 阶段的职责。这里只**如实报告**「日期需要重落」，
  // 由 agent 重试对应的落位阶段来完成 —— 而不是在这里再实现一遍落位。
  return {
    applied: false,
    detail: `日期需要重新落位（${stageHint}）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位`,
    evidence: { needsRetryStage: stageHint === 'alimama' ? 'alimama-date' : 'sycm-date' },
  };
}

/**
 * 执行一个修复动作。**永不抛**：一切异常都翻成 `{ applied:false, detail }`。
 *
 * 顺序：定代理 → 找目标页 → （写动作前）如果动作会改页面内容，先确认目标页存在 →
 * 执行 → 回读 → 落证据。找不到目标页时如实报 `TARGET_PAGE_MISSING`，不猜。
 */
export async function applyRepairAction(args, { readTargets = readTargetUrls, log = console.log } = {}) {
  const started = new Date().toISOString();
  const result = { ok: false, action: args.action, stage: args.stage ?? null, cause: args.cause ?? null,
    shop: args.shop ?? null, proxy: args.proxy, dryRun: Boolean(args.dryRun),
    applied: false, detail: null, targetId: null, targetUrl: null, startedAt: started,
    finishingAt: null, error: null };

  try {
    const plan = planRepair({ cause: args.cause, stage: args.stage, state: null });
    result.plan = plan;
    const hint = plan.stageHint;

    // 只读的哪几个动作不需要目标页（归位本身就是「去找页」）。其余要先定位。
    const needsPage = args.action !== 'RESET_PAGES';
    if (needsPage) {
      const read = await readTargets(args);
      if (!read.ok) {
        result.detail = `读不到页签（代理连不上）：${read.error}`;
        result.exitCode = REPAIR_EXIT_CODES.INCONCLUSIVE;
        return result;
      }
      const located = locateStagePage({ targets: read.targets, stageHint: hint });
      if (!located.ok) {
        result.detail = `找不到要修的那一页：${located.reason}`;
        result.exitCode = REPAIR_EXIT_CODES.INCONCLUSIVE;
        return result;
      }
      result.targetId = located.targetId;
      result.targetUrl = located.url;
      log(`[修复] 目标页 = ${located.url}`);
      if (!args.dryRun) await bringToFront(args, located.targetId);
    }

    if (args.dryRun) {
      result.detail = `排练（--dry-run）：会执行 ${args.action}`
        + `${result.targetUrl ? ` 于 ${result.targetUrl}` : ''}，一个写请求都不发`;
      result.exitCode = REPAIR_EXIT_CODES.APPLIED;
      return result;
    }

    let outcome;
    if (args.action === 'DISMISS_OVERLAYS') outcome = await runDismissOverlays(args, result.targetId);
    else if (args.action === 'RELOAD_PAGE') outcome = await runReloadPage(args, result.targetId);
    else if (args.action === 'RESET_PAGES') outcome = await runResetPages(args);
    else if (args.action === 'REAPPLY_DATES') outcome = await runReapplyDates(args, { stageHint: hint });
    else throw new Error(`没有实现的动作：${args.action}`);

    result.applied = outcome.applied === true;
    result.detail = outcome.detail;
    result.evidence = outcome.evidence ?? null;
    result.ok = result.applied;
    result.exitCode = result.applied ? REPAIR_EXIT_CODES.APPLIED : REPAIR_EXIT_CODES.NOT_APPLIED;
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error);
    result.detail = `修复动作自己出错：${result.error}`;
    result.exitCode = REPAIR_EXIT_CODES.NOT_APPLIED;
    return result;
  } finally {
    result.finishingAt = new Date().toISOString();
  }
}

/** 人读版正文（落 97-repair.txt）。 */
export function renderRepairReport(result) {
  const lines = [];
  lines.push(`修复动作：${result.action}${result.dryRun ? '（排练）' : ''}`);
  lines.push(`店：${result.shop ?? '?'}｜阶段：${result.stage ?? '?'}｜成因：${result.cause ?? '?'}`);
  lines.push(`目标页：${result.targetUrl ?? '(未定位)'}`);
  lines.push(`结论：${result.applied ? '已应用' : '未应用'}｜${result.detail ?? ''}`);
  if (result.evidence) lines.push(`证据：${JSON.stringify(result.evidence)}`);
  if (result.error) lines.push(`错误：${result.error}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseRepairArgs(process.argv.slice(2));
  args.proxy = resolveProxy(args);
  console.log(`[修复] ${args.action}｜${args.shop ?? '(未点名)'}@${args.proxy}｜阶段 ${args.stage ?? '?'}`);
  const result = await applyRepairAction(args);

  // 证据落盘（写不下去不该再抛一次 —— 结果已经算出来了）。
  if (args.logDir) {
    try {
      mkdirSync(args.logDir, { recursive: true });
      const outPath = path.join(args.logDir, '97-repair.txt');
      writeFileSync(outPath, renderRepairReport(result), 'utf8');
      writeFileSync(path.join(args.logDir, '97-repair.json'),
        `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`[修复] 证据 = ${path.relative(REPO_ROOT, outPath)}`);
    } catch (error) {
      console.error(`[修复] 证据写不下去：${error.message}`);
    }
  }

  console.log(`[修复] ${result.applied ? '✅ 已应用' : '❌ 未应用'}：${result.detail}`);
  process.exitCode = result.exitCode ?? REPAIR_EXIT_CODES.NOT_APPLIED;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
