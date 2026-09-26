#!/usr/bin/env node
//
// 驻留 → 只读判据转正 → 只补失败店自动续跑（2026-09-26 加）。
//
// 它存在的理由，是三条同时成立的事实：
//   ① 宿主在驱动命令结束时回收**整棵进程树** ⇒ 想让窗口留到人来，唯一可靠的形态是**这一轮不结束**
//      （`runtime/batch-plan.mjs` 记着那条实测：窗口在命令结束后 0.26 秒就没了）。
//      「不释放」不等于「窗口还在」—— 所以驻留不是一个开关，而是「进程活着」这件事本身。
//   ② 人处理完（关掉弹窗 / 重新登录）之后**不会回复我们** ⇒ 必须由系统自己反复问一个**只读**判据。
//   ③ 续跑必须**只补那几家**：同一天＋同店铺有查重键，整轮重跑会把已经写好的那几家硬停，
//      把一次成功续跑变成一个新的告警。
//
// 它**不**做什么（同样重要）：
//   · 不自己关弹窗、不自己登录 —— 那是人的动作（脚本能做的「关」已经在采集脚本里试过了，
//     见 `collect-core.mjs` 的 `createOverlayDismisser`）；
//   · 不发明第二套判据 —— 广告那条用的是采集脚本**同一个** `overlayScanExpression`，
//     登录那条用的是 `login-merchant-core.mjs` 里那两个 URL 判据；
//   · 不需要人时**不驻留**（默认行为与从前逐字相同）。
//
// 退出码（口径的**唯一来源**是 `runtime/daily-job-plan.mjs` 的 `HOLD_EXIT`，
// 调用方 `scripts/run-daily-job.mjs` 也读同一份 —— 两处各写一遍数字，改一处就静默漂成
// 「续跑成功了但整轮仍然报红」或者更糟的「续跑没成功却报绿」）：
//   0＝不需要驻留（这一轮没有「只有人能解除」的失败）｜1＝续跑没成功｜2＝读不到结论（判不了，不驻留）
//   3＝等到截止时间（没等到人 ⇒ 释放窗口）｜4＝续跑成功（这一轮的缺口补上了）
//
// 为什么判据里把「读不到」和「还在等」分开放：读不到被读成「好了」是本项目最贵的一类错误
//（拿着一个还堵着的现场去写飞书），见 `runtime/hold-and-resume-plan.mjs` 的 `judgeProbes`。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_PORTS, shopBrowserKeys, shopInstance } from '../runtime/browser-ports.mjs';
import { HOLD_EXIT } from '../runtime/daily-job-plan.mjs';
import { pagesMatching } from '../runtime/target-url-match.mjs';
import {
  DEFAULT_HOLD_UNTIL, STATUS_EVERY_MS, buildResumeArgv, closeOutNotice, deadlineReached,
  holdDecision, holdStatusLine, judgeProbes, minutesOfDay, parseClock, pollSecondsFor,
  resumeFloorFor, resumeResultNotice, resumeStageListFrom,
} from '../runtime/hold-and-resume-plan.mjs';
import { overlayScanExpression } from '../skills/sycm-alimama-daily-report/scripts/collect-core.mjs';
import { siteAdapter } from '../skills/sycm-alimama-daily-report/scripts/date-picker.mjs';
import {
  HUMAN_REQUIRED_CAUSES, STAGE_NAMES, dispatchRoundAlert, expectedPagesForDailyBrowser,
  resolveAlertDispatch, shopFailureCause,
} from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
import { isLoginWallUrl } from '../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs';

// 两个站点片段从**唯一权威**取（date-picker 的 `SITES` 适配器；`expected-pages.mjs` 用的也是它）。
// 不在这里写字面量：抄一份就是等着它与落位/体检的判据漂开，而漂开的症状是
// 「探针盯着一页、体检盯着另一页」—— 两边都报绿，却谁也没看住真正的那一页。
const SYCM_FRAGMENT = siteAdapter('sycm').urlFragment;
const ALIMAMA_FRAGMENT = siteAdapter('alimama').urlFragment;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const NODE = process.execPath;
const CHAIN = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');
const STOP_ALL = path.join(REPO_ROOT, 'scripts/stop-all.mjs');
const log = (...parts) => console.log(...parts);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function parseArgs(argv) {
  const args = { date: null, summary: null, shops: null, until: DEFAULT_HOLD_UNTIL, pollSeconds: null,
    once: false, resume: true, release: true, notify: true, notifyPrint: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') args.date = argv[++i];
    else if (key === '--summary') args.summary = argv[++i];
    else if (key === '--shops') args.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--until') args.until = argv[++i];
    else if (key === '--poll-seconds') args.pollSeconds = Number(argv[++i]);
    else if (key === '--once') args.once = true;
    else if (key === '--no-resume') args.resume = false;
    else if (key === '--no-release') args.release = false;
    else if (key === '--no-notify') args.notify = false;
    else if (key === '--notify-print') { args.notifyPrint = true; }
    else return { error: `未知参数 ${key}（可用：--date --summary --shops --until --poll-seconds --once --no-resume --no-release --no-notify --notify-print）` };
  }
  if (!args.date) return { error: '必须给 --date（驻留的是哪一天的日报）' };
  const clock = parseClock(args.until);
  if (!clock.ok) return { error: clock.error };
  args.untilMinutes = clock.minutes;
  if (args.pollSeconds !== null && !(Number.isInteger(args.pollSeconds) && args.pollSeconds > 0)) {
    return { error: `--poll-seconds 要一个正整数（收到 ${args.pollSeconds}）` };
  }
  args.summary = args.summary ?? path.join(REPO_ROOT, 'evidence', `multi-shop-${args.date}`, 'summary.json');
  return args;
}

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 120)}`);
  return text;
}

async function listPages(proxyPort) {
  const raw = JSON.parse(await proxyJson(`http://127.0.0.1:${proxyPort}/targets`));
  const list = Array.isArray(raw) ? raw : (raw?.targets ?? []);
  return list.filter((target) => target && target.type === 'page');
}

// 页签归属判据**只许有一个来源**：`runtime/target-url-match.mjs`（看 URL 结构，不看片段包含）。
// 不许退回 `.includes(urlFragment)` —— 登录跳转页把目标地址放在 `_target=` 里，
// 整串 includes 会把它误认成工作页，那是本项目发生过两次的整轮停摆（见那个模块的文件头）。
const pageMatching = (pages, fragment) => pagesMatching(pages, fragment)[0] ?? null;

// 广告那条的判据：**这一页上还有没有盖住整页的层**。
// 用的就是采集脚本同一个表达式 —— 判据只有一个来源，「人关掉了没有」与「脚本当时能不能点」
// 才不会变成两件不同的事。
async function probeOverlay(subject, proxyPort) {
  try {
    const pages = await listPages(proxyPort);
    const page = pageMatching(pages, ALIMAMA_FRAGMENT);
    if (!page) return { subject, state: 'unknown', why: '阿里妈妈页不在窗口里，读不到' };
    const payload = JSON.parse(await proxyJson(
      `http://127.0.0.1:${proxyPort}/eval?target=${encodeURIComponent(page.targetId)}`,
      { method: 'POST', body: overlayScanExpression() },
    ));
    let scan = payload?.value;
    try { scan = JSON.parse(scan); } catch { /* 已经是对象就算了 */ }
    if (!scan || typeof scan !== 'object') return { subject, state: 'unknown', why: '读不到页面状态' };
    if (scan.blocked === true) {
      const layer = scan.layer ?? {};
      return { subject, state: 'waiting', why: `还有一层盖住整页的弹窗（${layer.tag ?? '?'}${layer.id ? `#${layer.id}` : ''}）` };
    }
    return { subject, state: 'ready', why: '页面上已经没有盖住整页的弹窗' };
  } catch (error) {
    return { subject, state: 'unknown', why: `读不到（${String(error?.message ?? error).slice(0, 60)}）` };
  }
}

// 登录那条的判据：**页签还停在登录墙上没有**。
// 只读、不打字、不点任何东西 —— 它只回答「人登回来没有」。
// 判据与登录链路同源（`login-merchant-core.mjs` 的 `isLoginWallUrl`），不在这里另写一份。
async function probeLogin(subject, proxyPort, siteFragment = SYCM_FRAGMENT) {
  try {
    const pages = await listPages(proxyPort);
    const page = pageMatching(pages, siteFragment);
    if (!page) return { subject, state: 'unknown', why: `${siteFragment} 页不在窗口里，读不到` };
    if (isLoginWallUrl(page.url)) return { subject, state: 'waiting', why: '这个页面还停在登录页上' };
    return { subject, state: 'ready', why: '这个页面已经不在登录页上了' };
  } catch (error) {
    return { subject, state: 'unknown', why: `读不到（${String(error?.message ?? error).slice(0, 60)}）` };
  }
}

// 整轮被挡时的判据：共享商家浏览器那一台上，**链的整轮级体检要的那几页**在不在、有没有停在登录墙上。
// 为什么必须一页一页对着 `expectedPagesForDailyBrowser()` 判（而不是只看生意参谋一页）：
// 2026-09-25 那次「五家一步都没跑」的现场是商家浏览器掉了登录；但整轮级体检判的是
// 「生意参谋工作页 + 飞书底单页」两页齐不齐 —— 只看其中一页，会在另一页缺失时
// 判成「可以续跑了」，于是续跑再撞一次同一堵墙（多花一轮，且看起来像系统自己没用）。
async function probeMerchantBrowser() {
  const subject = '商家浏览器';
  try {
    const pages = await listPages(PROJECT_PORTS.dailyReportProxy);
    const waiting = [];
    for (const expected of expectedPagesForDailyBrowser()) {
      const page = pageMatching(pages, expected.urlFragment);
      if (!page) { waiting.push(`${expected.name}不在窗口里`); continue; }
      if (isLoginWallUrl(page.url)) waiting.push(`${expected.name}还停在登录页上`);
    }
    if (waiting.length) return { subject, state: 'waiting', why: waiting.join('；') };
    return { subject, state: 'ready', why: '这一轮要的那几页都在位、也都不在登录页上' };
  } catch (error) {
    return { subject, state: 'unknown', why: `读不到（${String(error?.message ?? error).slice(0, 60)}）` };
  }
}

function readSummary(file) {
  if (!existsSync(file)) return { error: `读不到这一轮的结论：${file}` };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { error: '结论不是一个对象' };
    return { summary: parsed };
  } catch (error) {
    return { error: `结论读不成 JSON：${String(error?.message ?? error)}` };
  }
}

/** 逐店失败 → `[{shop, cause, stage}]`（cause 由链自己的分类器给，不在这里另写一份）。 */
export function failedShopsOf(summary) {
  return Object.entries(summary?.shops ?? {})
    .filter(([, record]) => record?.status !== 'ok')
    .map(([shop, record]) => ({ shop, record, cause: shopFailureCause(record), stage: record?.failedStage ?? null }));
}

function makeDispatcher({ notify, notifyPrint }) {
  const dispatch = resolveAlertDispatch({ notify, notifyPrint, mode: 'commit' });
  return (alert) => dispatchRoundAlert({ alert, dispatch, logDir: null, log });
}

function runResume({ date, shops, stages }) {
  const argv = buildResumeArgv({ chainScript: CHAIN, date, shops, stages, notify: true });
  log(`[驻留] 续跑：${NODE} ${argv.join(' ')}`);
  // `stdio` 必须显式写成 `['ignore','pipe','pipe']`：本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」
  // 直接回 EBUSY，而带 `input:` 或缺省 stdio 都是那一形态（2026-09-24/25 两轮实测）。
  const result = spawnSync(NODE, argv, {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 3_600_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = String(result.stdout ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 240);
  log(`[驻留] 续跑退出码=${result.status}${tail ? `｜尾部：${tail}` : ''}`);
  return result.status;
}

function releaseShops(shops) {
  if (!Array.isArray(shops) || !shops.length) {
    log('[驻留] 没有点名要放的实例 ⇒ 不调用释放（整轮重跑那一档由人看现场）');
    return;
  }
  const argv = ['--yes', '--only', shops.join(',')];
  log(`[驻留] 释放：${NODE} ${path.relative(REPO_ROOT, STOP_ALL)} ${argv.join(' ')}`);
  const result = spawnSync(NODE, [STOP_ALL, ...argv], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  log(`[驻留] 释放退出码=${result.status}｜${String(result.stdout ?? '').trim().slice(0, 200)}`);
  // 已知假绿：`stop-all` 的退出码不能当成「真的放掉了」的结论（读进程表失败时会退 0）。
  // 这里只如实打出来 —— 判「放掉没有」要回读端口，而那是**人**在场时该做的事，不在驻留里做。
  log('[驻留] 提醒：释放的结论不要只看退出码，判「放掉没有」要回读端口。');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = HOLD_EXIT.NO_VERDICT;
    return;
  }
  const args = parsed;
  const { summary, error } = readSummary(args.summary);
  if (error) {
    console.error(`[驻留] ${error}`);
    console.error('[驻留] 判不了「要不要驻留」⇒ 不驻留（不拿一个猜的结论把机器挂住）');
    process.exitCode = HOLD_EXIT.NO_VERDICT;
    return;
  }

  const failed = failedShopsOf(summary);
  const roundBlocked = summary?.round?.healthCheckDaily?.ok === false;
  const shopKeys = args.shops ?? shopBrowserKeys();
  const humanCauses = [...HUMAN_REQUIRED_CAUSES];

  // 整轮被挡时先探一次商家浏览器，好把「掉登录」与「页面真缺」分开说（这是 09-25 那次报错归因错的根因）。
  const roundProbe = roundBlocked ? await probeMerchantBrowser() : null;
  const roundCause = roundBlocked
    ? (isLoginWallText(roundProbe?.why) ? 'NEEDS_LOGIN' : 'ROUND_BLOCKED')
    : null;

  const decision = holdDecision({ failed, roundBlocked, roundCause, humanCauses });
  log(`[驻留] 目标日 ${args.date}｜逐店失败 ${failed.length} 家｜整轮被挡=${roundBlocked}`);
  for (const item of failed) log(`[驻留]   ${item.shop}：${item.cause}（停在第 ${item.stage ?? '?'} 步）`);
  if (!decision.needed) {
    log('[驻留] 这一轮没有「只有人能解除」的失败 ⇒ 不驻留、不续跑（与从前逐字相同）');
    process.exitCode = HOLD_EXIT.NO_HOLD;
    return;
  }

  const subjects = decision.roundLevel ? [] : decision.subjects;
  // 续跑起点＝「失败那一步」与「人碰过页面 ⇒ 日期筛选已不可信 ⇒ 退到 alimama-date」两者取更早的
  // （理由见 `resumeFloorFor`）。整轮被挡那一档没有逐店阶段，`subjects` 为空 ⇒ 自然落成「不点名」。
  const floorStage = resumeFloorFor(decision.causes, STAGE_NAMES);
  const stages = resumeStageListFrom(
    failed.filter((item) => subjects.includes(item.shop)).map((item) => item.stage),
    STAGE_NAMES,
    { floorStage },
  );
  const pollSeconds = args.pollSeconds ?? pollSecondsFor(decision.causes);
  const now = new Date();
  log(`[驻留] 需要人：${decision.roundLevel ? '整轮（商家浏览器）' : subjects.join('、')}`);
  log(`[驻留] 截止 ${args.until}（现在 ${now.toTimeString().slice(0, 5)}）｜轮询 ${pollSeconds} 秒一次`);
  log(`[驻留] 续跑范围：${decision.resumeShops ? decision.resumeShops.join('、') : '整轮（不给 --shops）'}`
    + `｜阶段：${stages ? stages.join(',') : '不点名（整链）'}`
    + `${floorStage ? `｜起点下探到 ${floorStage}（人碰过页面，日期落位要重做）` : ''}`);

  const probeAll = async () => {
    if (decision.roundLevel) return [roundProbe ?? await probeMerchantBrowser()];
    const probes = [];
    for (const item of failed.filter((entry) => subjects.includes(entry.shop))) {
      const { proxyPort } = shopInstance(item.shop);
      probes.push(item.cause === 'PAGE_OBSTRUCTED'
        ? await probeOverlay(item.shop, proxyPort)
        : await probeLogin(item.shop, proxyPort));
    }
    return probes;
  };

  if (args.once) {
    const probes = await probeAll();
    for (const probe of probes) log(`[驻留] 探测：${probe.subject}｜${probe.state}｜${probe.why}`);
    const verdict = judgeProbes(probes);
    log(`[驻留] --once：判据${verdict.ready ? '已转正（下一次就会续跑）' : '还没转正'}`
      + `（等 ${verdict.waiting.length} 个／读不到 ${verdict.unknown.length} 个）`);
    log(`[驻留] --once：不驻留、不续跑、不释放（这一档是给人看判据用的）`);
    process.exitCode = HOLD_EXIT.NO_HOLD;
    return;
  }

  const dispatch = makeDispatcher(args);
  const startedAt = Date.now();
  let lastStatusAt = Date.now();

  for (;;) {
    const probes = await probeAll();
    const verdict = judgeProbes(probes);
    if (Date.now() - lastStatusAt >= STATUS_EVERY_MS) {
      lastStatusAt = Date.now();
      log(holdStatusLine({ at: new Date(), waitedMs: Date.now() - startedAt, until: args.until, probes }));
    }
    if (verdict.ready) {
      log(`[驻留] 判据转正 ⇒ ${args.resume ? '开始续跑' : '（--no-resume：只报告，不续跑）'}`);
      if (!args.resume) { process.exitCode = HOLD_EXIT.NO_HOLD; return; }
      const status = runResume({ date: args.date, shops: decision.resumeShops, stages });
      const ok = status === 0;
      dispatch(resumeResultNotice({
        date: args.date, shops: decision.resumeShops ?? shopKeys, ok,
        detail: ok ? null : `退出码 ${status}`, createdAt: new Date(),
      }));
      if (args.release) releaseShops(decision.resumeShops ?? []);
      process.exitCode = ok ? HOLD_EXIT.RESUMED_OK : HOLD_EXIT.RESUME_FAILED;
      return;
    }
    if (deadlineReached({ nowMinutes: minutesOfDay(new Date()), untilMinutes: args.untilMinutes })) {
      log(`[驻留] 到 ${args.until} 还没等到 ⇒ 收尾`);
      dispatch(closeOutNotice({
        date: args.date, subjects: subjects.length ? subjects : shopKeys, until: args.until, createdAt: new Date(),
      }));
      if (args.release) releaseShops(decision.resumeShops ?? []);
      process.exitCode = HOLD_EXIT.TIMED_OUT;
      return;
    }
    await delay(pollSeconds * 1000);
  }
}

// 只用来把「商家浏览器的探针结论」翻成成因：探针的 `why` 里带「登录」二字就是掉登录
// （那个文案来自 `probeMerchantBrowser`，与 `isLoginWallUrl` 是同一件事的两种说法）。
const isLoginWallText = (why) => /登录/u.test(String(why ?? ''));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
