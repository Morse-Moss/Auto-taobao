#!/usr/bin/env node

// 只读探针（不碰任何运行中的浏览器）：回答一个问题 ——
// 「把浏览器关掉、再冷启动起来」之后，链的第 0 步（体检前的那段「归位」）会不会
// 因为「每个站点要恰好一个页面」这条判据而整轮不跑？
//
// 方法：不复述逻辑，直接调链自己用的那两个纯函数（`planPageActions` + `planRequests`），
// 把「冷启动后窗口里只有 about:blank」这个状态喂进去，看它决定做什么。
//
// 为什么不在真机上关一个浏览器来试：那是中断性操作，要授权；而这个问题是**纯逻辑**问题，
// 不需要真机就能得到确定答案（真机只能验证「我读代码没读错」，代价却大得多）。
//
// 跑法（仓库根）：
//   node evidence/close-then-restart-risk-2026-09-23/repro-cold-start-pages.mjs
//
// 自定位：本文件在 <repo>/evidence/<批次>/ 下，所以 runtime/ 在 ../../runtime。
// 这一路径必须显式写死 —— 若照抄原来在 tmp/ 下的 '../runtime'，
// 「复核命令」会在文档写下它的那一刻就失效（见技能 evidence-copy-must-be-runnable）。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const load = (rel) => import(pathToFileURL(resolve(REPO_ROOT, rel)).href);

const { expectedPagesForDailyBrowser, expectedPagesForShop } =
  await load('skills/sycm-alimama-daily-report/scripts/expected-pages.mjs');
const { buildUrlByName, planPageActions, planRequests } = await load('runtime/shop-pages.mjs');
const { ROUTES } = await load('runtime/browser-ports.mjs');

const urlByName = buildUrlByName();

// 冷启动的现场：启动器把 START_URL 默认设成 about:blank（runtime/start-project-browser.mjs:49），
// 所以一个刚起来的窗口里就是这么一个页签，没有任何工作页。
const COLD = ['about:blank'];

function probe(label, expected) {
  // dry:false ⇒ 返回的是真要做的动作（`create`），不是 `would-create`。
  const actions = planPageActions({ urls: COLD, expected, urlByName, dry: false });
  // `targets: []` 是我们故意的：这里只问「会打算发什么请求」，一个请求都不发。
  const requests = planRequests({ actions, targets: [] });
  const kinds = new Map();
  for (const action of actions) kinds.set(action.action, (kinds.get(action.action) ?? 0) + 1);

  console.log(`\n=== ${label}：期望页面 ${expected.length} 个，冷启动后页签 = ${JSON.stringify(COLD)} ===`);
  for (const action of actions) {
    console.log(`  ${String(action.page).padEnd(22)} → ${action.action}`);
  }
  console.log(`  动作汇总：${[...kinds].map(([k, v]) => `${k}×${v}`).join('  ')}`);
  console.log(`  将发出的请求：${requests.length} 条`
    + `（${[...new Set(requests.map((r) => r.kind))].join('/') || '无'}）`);
  const blocked = actions.filter((a) => a.action === 'ambiguous' || a.action === 'ambiguous-drift');
  console.log(`  需要人决定的：${blocked.length} 个${blocked.length ? ` ← ${blocked.map((a) => a.page).join('、')}` : ''}`);
  console.log(`  结论：${blocked.length === 0 ? '无一项需要人 ⇒ 体检前的归位能自己把页面补出来' : '有人为卡点 ⇒ 整轮会不跑'}`);
  return blocked.length;
}

let blockedTotal = 0;
blockedTotal += probe(`五家店（一家的窗口）`, expectedPagesForShop());
blockedTotal += probe(`商家浏览器（${ROUTES.dailyReport.label}）`, expectedPagesForDailyBrowser());

console.log(`\n[总判据] 冷启动下需要人为介入的项合计 ${blockedTotal} 个`);
console.log('[边界] 本探针只回答「页面缺不缺、补页要不要人」。它**不**回答「登录态还有效吗」——'
  + '体检里现在没有这条判据（见 runtime/xws-platform-health-preflight.mjs 里 L2/L3 的说明）。');
