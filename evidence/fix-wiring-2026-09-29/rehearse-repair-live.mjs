#!/usr/bin/env node
/**
 * ⑨ 真机排练（会动页面，但只对 --proxy 指定的那一个实例做事）。
 *
 * 目的：证明修复回环的**接线**真的通到 `applyRepairAction`——
 * 「候选对象 → 动作名 → 真执行一步 → 按名字摘掉 → 重试那一步」。
 * 修复前它是死的（`const action = list[0]` 把对象当名字传 ⇒ 四路 `===` 全落空、零动作执行），
 * 且 `remaining.splice` 用字符串 indexOf 找对象 ⇒ 摘错元素。
 *
 * 前置（本脚本自己不起实例）：
 *   node scripts/start-all-hold.mjs --only 里可林淘宝   # 后台托住
 *   node runtime/shop-pages.mjs --open                   # 开里可林期望页
 *
 * 边界：只走 RESET_PAGES（非 mutating，只归位页签、不写数据、不碰飞书、不登录）。
 *
 * 用法（从任意 CWD）：
 *   node evidence/fix-wiring-2026-09-29/rehearse-repair-live.mjs \
 *     --proxy http://127.0.0.1:19041 --shop 里可林淘宝
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仓库根按「文件自身位置」算 —— evidence 目录被整份复制后仍可跑（见本项目 evidence 纪律）。
const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { autoRepairAndRetry, actionNameOf } = await imp(
  'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs'
);
const { planRepair } = await imp(
  'skills/sycm-alimama-daily-report/scripts/repair-actions.mjs'
);
const { applyRepairAction } = await imp(
  'skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs'
);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const proxy = arg('--proxy', 'http://127.0.0.1:19041');
const shopKey = arg('--shop', '里可林淘宝');
const proxyJson = async (url) => (await fetch(url)).json();

const logDir = path.join(REPO, 'tmp/rehearse-repair-live-out');
const stageHits = [];

// 现场失败：成因 SHOP_BLOCKED ⇒ 候选 [RESET_PAGES, RELOAD_PAGE]（对象数组＝生产形态）
const plan = planRepair({ cause: 'SHOP_BLOCKED', stage: 'shop-report', state: null });
console.log('[1] planRepair 候选：', JSON.stringify(plan.candidates.map((c) => c.action)));
console.log('    actionNameOf(候选[0]) =', actionNameOf(plan.candidates[0]));

const executed = [];
const exec = async ({ shopKey: sk, stage, action, log }) => {
  executed.push(action);
  console.log(`[exec] 真执行：stage=${stage} action=${action}`);
  const out = await applyRepairAction(
    { shop: sk, proxy, stage, action, logDir },
    { readTargets: (base) => proxyJson(`${base}/targets`), log: (m) => console.log('      ' + m) },
  );
  return out;
};

// 重试「失败那一步」：排练桩返回 0，以走完「修好→重试→救回」整条路。
const runStage = async (stage) => {
  stageHits.push(stage);
  console.log(`[retry] 重试阶段 ${stage} ⇒ status 0（排练桩）`);
  return { status: 0 };
};

const trace = await autoRepairAndRetry({
  shopKey,
  logDir,
  req: {
    shopKey,
    stage: 'shop-report',
    cause: 'SHOP_BLOCKED',
    retryStage: 'shop-report',
    candidates: plan.candidates.map((c) => ({ ...c })),
  },
  maxRounds: 3,
  runStage,
  exec,
  log: (m) => console.log('[log] ' + m),
});

console.log('\n[结论]');
console.log('  执行过的动作      :', JSON.stringify(executed));
console.log('  重试过的阶段      :', JSON.stringify(stageHits));
console.log('  rescued           :', trace.rescued);
console.log('  gaveUp            :', trace.gaveUp);
console.log('  rounds            :', JSON.stringify(trace.rounds));
console.log('  零动作执行？      :', executed.length === 0 ? '是（＝修复前的死法）' : '否');
