#!/usr/bin/env node
/**
 * ⑨b 告警闸门四态复跑（纯逻辑，零副作用，不需要浏览器）。
 *
 * 用**生产形状**的 record（`repairRequest.cause` + `repairRequest.candidates`，
 * 与 `classifyShopEscalation` 消费的一致）驱动 `planAlertDeferral`，覆盖：
 *   ① 整批都「agent 能救」        ⇒ defer=true，两家都进 targets
 *   ② 有一家 NEEDS_LOGIN（只能人上）⇒ defer=false，且 humanOnly 精确点名那一家（fail-closed）
 *   ③ 默认关（enabled=false）      ⇒ 永不 defer
 *   ④ 没有失败                    ⇒ 不 defer
 *
 * 用法（从任意 CWD）：node evidence/fix-wiring-2026-09-29/rehearse-alert-deferral.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { planAlertDeferral } = await import(
  pathToFileURL(path.join(REPO, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs')).href
);

const rr = (cause, cands) => ({
  cause,
  candidates: cands.map((action) => ({ action, mutating: false, why: 'x' })),
  path: '97-repair-request.json',
  statePath: '98-failure-state.json',
});

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ① 整批 agent 能救
const s1 = {
  shops: {
    里可林淘宝: { status: 'failed', failedStage: 'promotion-fetch', repairRequest: rr('STAGE_FAILED', ['REAPPLY_DATES', 'RELOAD_PAGE']) },
    网林天猫: { status: 'failed', failedStage: 'shop-report', repairRequest: rr('PAGE_OBSTRUCTED', ['DISMISS_OVERLAYS', 'RELOAD_PAGE']) },
  },
};
const d1 = planAlertDeferral({ summary: s1, summaryPath: 'evidence/x/summary.json', enabled: true });
check('① defer', d1.defer, true);
check('① targets', d1.targets.map((t) => `${t.shop}@${t.cause}`), ['里可林淘宝@STAGE_FAILED', '网林天猫@PAGE_OBSTRUCTED']);

// ② 一家 NEEDS_LOGIN ⇒ 不许 defer
const s2 = {
  shops: {
    里可林淘宝: { status: 'failed', failedStage: 'promotion-fetch', repairRequest: rr('STAGE_FAILED', ['REAPPLY_DATES']) },
    科塔淘宝: { status: 'failed', failedStage: 'sycm-date', repairRequest: rr('NEEDS_LOGIN', []) },
  },
};
const d2 = planAlertDeferral({ summary: s2, enabled: true });
check('② defer（fail-closed）', d2.defer, false);
check('② humanOnly', d2.humanOnly, ['科塔淘宝']);

// ③ 默认关
check('③ 默认关 defer', planAlertDeferral({ summary: s1, enabled: false }).defer, false);

// ④ 无失败
check('④ 无失败 defer', planAlertDeferral({ summary: { shops: {} }, enabled: true }).defer, false);

console.log(fails === 0 ? '\n结论：四态全部符合预期' : `\n结论：${fails} 处不符`);
process.exitCode = fails === 0 ? 0 : 1;
