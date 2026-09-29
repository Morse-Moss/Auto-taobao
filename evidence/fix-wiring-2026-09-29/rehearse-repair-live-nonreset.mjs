#!/usr/bin/env node
/**
 * ⑨ 真机排练（第二版）：证明**非 RESET_PAGES 的动作**也能真执行。
 *
 * 背景（2026-09-29 真机排练查出的新断点）：`run-multi-shop-day.mjs` 的 `execRepair`
 * 曾把 `readTargets` 注入成 `captureFailureState` 的契约（`(base) => proxyJson(\`${base}/targets\`)`，
 * base 是字符串），而 `applyRepairAction` 调的是 `readTargets(args)`（args 是对象）
 * 并读回 `{ok,targets,error}`。两种同名契约抄错不报错 ⇒ 每个非 `RESET_PAGES` 的动作
 * 都报「读不到页签（代理连不上）」、退 3。
 *
 * 本脚本用**与生产同一形态**的注入驱动 `RELOAD_PAGE`（第二个候选），若修好则它能定位到页
 * 并真的执行；若还是旧注入，则会退 3 说「读不到页签」。
 *
 * 前置：node scripts/start-all-hold.mjs --only 里可林淘宝 && node runtime/shop-pages.mjs --open
 * 用法：node evidence/fix-wiring-2026-09-29/rehearse-repair-live-nonreset.mjs --proxy http://127.0.0.1:19041
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { applyRepairAction } = await imp('skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const proxy = arg('--proxy', 'http://127.0.0.1:19041');
const shopKey = arg('--shop', '里可林淘宝');
const logDir = path.join(REPO, 'tmp/rehearse-repair-live-out');
const proxyJson = async (url) => (await fetch(url)).json();

// 与生产 execRepair **同形态**的注入（修好后的那份）。
const readTargets = async (a) => {
  try {
    return { ok: true, targets: await proxyJson(`${a.proxy}/targets`), error: null };
  } catch (error) {
    return { ok: false, targets: null, error: String(error?.message ?? error) };
  }
};

for (const action of ['RELOAD_PAGE', 'DISMISS_OVERLAYS']) {
  const out = await applyRepairAction(
    { shop: shopKey, proxy, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED', action, logDir, dryRun: true },
    { readTargets, log: (m) => console.log('     ' + m) },
  );
  console.log(`[${action}] targetUrl=${out.targetUrl ?? '(未定位)'} | exitCode=${out.exitCode} | detail=${out.detail}`);
  console.log(`        ⇒ ${out.targetUrl ? '✅ 已定位到页（契约对）' : '❌ 读不到页签（契约还是错的）'}`);
}
