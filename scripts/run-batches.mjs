#!/usr/bin/env node

// 分批跑日报链，**并在每批跑完之后把它自己起的那批浏览器放掉**。
//
// 为什么要它（2026-09-23 用户原话）：
//   「跑完要释放，因为后续要跑更多店铺，全部店铺都不释放，电脑性能撑不住」。
// 这个文件是能力七段式（docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md §4.1）
// 里第七段 `release` 的**第一个真实调用点** —— 在此之前那一段是空的，`stop-all.mjs` 是一条
// 独立命令、没有任何流程会调它，所以「跑完释放」这句话在代码里没有落点。
//
// 三件事分得很清（混在一起就会写出「以为释放了、其实没有」的假成功）：
//   1) **该切成几批、每批执行哪四条命令** —— runtime/batch-plan.mjs（纯函数、有离线判据）。
//   2) **该不该发起释放** —— 同一个模块的 releaseAfterBatch（2026-09-23 用户拍板：
//      **每一轮跑完都要释放**；旧口径「失败留着等人看」已作废，理由见那个函数的注释）。
//   3) **能不能真停** —— scripts/stop-all.mjs 的三类证据（CDP 自报 profile / 代理命令行 /
//      启动器 pid），foreign 与 unconfirmed 一律拒停。本文件**不替它判**。
//
// 默认**不写飞书**：不给 `--commit` 就是排练（与链本身的默认一致）。
// 默认**会释放**：**每一批跑完都释放** —— 链成功、链失败、链没跑到，都放。
// 依据是用户 2026-09-23 原话「每一轮跑完要释放浏览器资源」，以及一条实测事实：
// `start` 走 `scripts/start-all.mjs`（起完就退），宿主在命令结束时回收**整棵进程树** ⇒
// 「不释放」并不等于「窗口还在」（实测命令结束 0.26 秒后这批窗口就没了）。
// 要看现场得 `--no-release` **并且**用 `scripts/start-all-hold.mjs` 在后台托住，两件缺一不可。
//
// 每一批里有一步**跑前登录守卫**（2026-09-23 加）：排在**本批 `start` 之后**，查本批那几家，
// 结论落成 `<证据根>/login-preflight-b<N>.json`，并用 `--login-preflight` 交给本批的链 ——
// 掉登录时告警能直接点名是哪家店的哪个后台，而不是给一句「把这两页各开一个」（掉登录时那个动作无效）。
// ⚠️ 它**不是只读**：带 `--login` 时会开这几家店自己的页面、用浏览器密码库登一次。
// 参数与产物名的单一来源是 runtime/daily-job-plan.mjs 与 runtime/batch-plan.mjs，这里不另抄一份。
//
// 用法：
//   node scripts/run-batches.mjs --print                 # 只打印每一批要执行什么（不起任何进程）
//   node scripts/run-batches.mjs --batch-size 2          # 排练：每批 2 家，跑完释放（不写飞书）
//   node scripts/run-batches.mjs --commit                # 真跑：写飞书，跑完释放
//   node scripts/run-batches.mjs --commit --no-release   # 真跑但不释放（排查用）
//   node scripts/run-batches.mjs --shops 里可林淘宝,网林天猫 --batch-size 1
// 退出码：0＝每一批的链都成功且释放干净；1＝有批失败或释放没停干净；2＝用法错误
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import {
  DEFAULT_BATCH_SIZE, batchLoginArtifactName, batchRoundBlockOf, buildBatchSteps, buildLoginPreflightStep,
  buildSharedStep, describeBatch, planBatches, releaseAfterBatch, resolveBatchSize,
} from '../runtime/batch-plan.mjs';
// 跑前登录守卫那一步的**文件、参数名**都只在那里定义一次（分批这条链与定时链共用）。
// 不各写一份：漂出来的症状是静默的 —— 链那边参数没少、只是永远读不到结论。
// 产物名**不从这里取**：分批形态每批一份（`batchLoginArtifactName`），共用一个常量正是要治的那个病。
import {
  HOLD_EXIT, JOB_FILES, LOGIN_PREFLIGHT_FLAG, buildLoginPreflightArgs, renderCommand,
} from '../runtime/daily-job-plan.mjs';
// 「脚本自修没救回来、且确实需要人看现场」那几家 —— 判据的**唯一来源**在 runtime 侧的
// `unfixableShopsOf`。这里只调用、不重算：重算一次就是第二个判据，迟早与驻留那边漂开
// （而漂开的症状是静默的 —— 驻留说「要留现场」，释放那边说「没失败」，两边各自都"对"）。
import { unfixableShopsOf } from '../runtime/hold-and-resume-plan.mjs';
import { versionLineSafe } from '../runtime/version.mjs';
// 工作流登记表（spec §4/§5，2026-10-10 接入）：启动时校验「这个 workflow 登记过没有」，
// 并从登记项解析链入口（entry.batch）与模式缺省（mode.manualDefault）——
// 未登记 ⇒ 立即硬失败，**绝不回退 daily-report**（回退的表现是「跑完了但跑的是另一条流程」）。
// ⚠️ 启动硬门槛只做 getWorkflow + **本次请求的 workflow** 入口文件存在性（2026-10-10 对抗
// 审查 E 项收窄）：全量 validateCatalogEntries 不在启动时跑 —— 否则 weekly 的入口文件丢了
// 也会拦死日报（爆炸半径错位）；登记表的整体合法性由 runtime/workflow-catalog.test.mjs 守。
import { getWorkflow, resolveRunMode } from '../runtime/workflow-catalog.mjs';
// 互斥锁（P0-4，2026-10-11）：推广 07:00 轮直连本入口时**没有任何锁**（run-daily-job 的锁
// 在宿主层，直连绕过了它）⇒ 手动并发触发两条链会撞同店代理端口。本入口自己抢——与
// run-daily-job / run-product-data-job 同一把（merchant-automation：三条链共享浏览器资源，
// 互斥单位是「机器上的采集」，不是「某条流程」）。
// 重入保护：抢到锁的进程设 SYCM_WORKFLOW_LOCK_HELD；宿主（run-daily-job）拿锁后也设——
// 子进程与驻留续跑继承它 ⇒ 跳过抢锁，不会自己撞自己（父进程还持着锁，第二个必 busy）。
import { acquireWorkflowLock, WORKFLOW_LOCK_NAME } from '../runtime/workflow-lock.mjs';
// 统一运行回执（spec §6，run-receipt-v1）与运行根目录（spec §7，run-root）—— 2026-10-10 接入。
// rounds → 回执的映射抽在 runtime/batch-rounds-receipt.mjs（纯函数，2026-10-10 对抗审查 A 项）：
// 这里只负责喂 plain data（含逐店 unfixable 名单与 batches.json 的 size/sha256）与落盘。
import { buildRunReceiptFromRounds } from '../runtime/batch-rounds-receipt.mjs';
import { writeRunReceipt } from '../runtime/run-receipt-v1.mjs';
import { buildRunLayout, ensureRunLayout, resolveRunRoot, writeManifest } from '../runtime/run-root.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const options = {
    dateInput: 'yesterday', batchSize: null, shops: null, commit: false, keepGoing: false,
    allowMissingPeer: false, notify: false, notifyPrint: false, logs: null, print: false,
    autoRepair: false, autoRepairMaxRounds: null, workflow: 'daily-report',
    // `--mode`（2026-10-10 加，spec §5.1 统一入口）：dry-run|apply。解析规则在
    // runtime/workflow-catalog.mjs 的 resolveRunMode（纯函数）—— 显式 mode 赢；
    // --commit 等价 apply（兼容期，打印转换提示）；矛盾（dry-run + --commit）退 2；
    // 都没给 ⇒ 登记项的 mode.manualDefault（dry-run）。
    mode: null,
    // `--evidence-root`（2026-10-10 加，spec §5.1/§7.2）：统一回执/manifest 落的运行根目录。
    // 注意它**不改变**链自己的证据目录（evidence/batches-<日>，batches.json 仍落那里）——
    // 迁移纪律（spec §7.3）：先支持新目录并保留旧路径兼容读取，不在同一变更里搬数据。
    evidenceRoot: null,
    deferAgentActionableAlert: false,
    // `--relogin-on-wall`（2026-10-10 加）：分批形态下**必须转发**，理由与上面两个开关逐字相同
    // —— 生产跑的正是 `--batches`，不转发等于「命令行给了它、每一批的链却都没收到」。
    reloginOnWall: false,
    release: true,
    // `--release-on-failure`（2026-10-10 加）：**失败时也照旧释放**。
    //
    // 默认已经改成「失败且还有要人看现场的店 ⇒ 不释放、转驻留」。这个开关是**逃生口**：
    // 有人需要用旧口径（比如机器内存紧张、或那一轮的失败已被确认无需现场）。
    // 与 `--no-hold` 一样只在**关掉新行为**时给，默认值就是新行为。
    releaseOnFailure: false,
    // `hold` **默认开**（2026-10-06 加，与定时链 `run-daily-job.mjs` 的默认值一致）。
    //
    // 为什么这一档必须有它：生产跑的正是 `--batches`，而 2026-10-05 那一轮 8 家店一家没跑、
    // 两批都停在链的第 0 步（共用商家浏览器掉登录）。当时的分批形态**没有任何一步会挂住等人**
    // —— 只剩「发一条告警、窗口全收走」，人看到消息时现场已经没了。
    // 用户原话：既然掉登录了、又自动修复不了，就应该挂住等人过来登录。
    hold: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print') options.print = true;
    else if (arg === '--commit') options.commit = true;
    else if (arg === '--keep-going') options.keepGoing = true;
    else if (arg === '--allow-missing-peer') options.allowMissingPeer = true;
    else if (arg === '--notify') options.notify = true;
    else if (arg === '--notify-print') options.notifyPrint = true;
    else if (arg === '--no-release') options.release = false;
    else if (arg === '--release-on-failure') options.releaseOnFailure = true;
    else if (arg === '--no-hold') options.hold = false;
    else if (arg === '--auto-repair') options.autoRepair = true;
    // ⑨b（2026-09-29）：分批形态下**必须转发**，否则这个开关在「跑完释放」的生产形态里
    // 被静默丢掉 —— 与 `--auto-repair` 同一个坑（命令行给了它、每一批的链却都没生效，
    // 日志里一个字都不提示）。
    else if (arg === '--defer-agent-actionable-alert') options.deferAgentActionableAlert = true;
    // `--relogin-on-wall`（2026-10-10）：链中间撞到登录墙就地补登一次。同 `--auto-repair`
    // 的理由，这一句不写就等于「生产形态下这条修复一次也不会生效」。
    else if (arg === '--relogin-on-wall') options.reloginOnWall = true;
    else if (arg === '--auto-repair-max-rounds') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return { error: `--auto-repair-max-rounds 要一个 ≥0 的整数，收到 ${JSON.stringify(raw)}` };
      }
      options.autoRepairMaxRounds = n;
    }
    else if (arg === '--batch-size') options.batchSize = argv[++i];
    else if (arg === '--date') options.dateInput = argv[++i];
    else if (arg === '--workflow') options.workflow = argv[++i];
    else if (arg === '--mode') {
      const raw = argv[++i];
      if (raw !== 'dry-run' && raw !== 'apply') {
        return { error: `--mode 只能是 dry-run|apply，收到 ${JSON.stringify(raw)}` };
      }
      options.mode = raw;
    }
    else if (arg === '--evidence-root') options.evidenceRoot = argv[++i];
    else if (arg === '--logs') options.logs = argv[++i];
    else if (arg === '--shops') options.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      return {
        error: `未知参数 ${arg}（可用：--print --commit --mode dry-run|apply --evidence-root <目录> --no-release --release-on-failure --no-hold --batch-size N --date <日> `
          + '--shops a,b --workflow daily-report|promotion-daily --keep-going --allow-missing-peer --auto-repair --auto-repair-max-rounds N '
          + '--relogin-on-wall --defer-agent-actionable-alert --notify|--notify-print --logs <目录>）',
      };
    }
  }
  if (options.notify && options.notifyPrint) {
    // 同 daily-job-plan 的理由：两个出口同时给时 `--notify-print` 会赢，
    // 于是「我要发飞书」这层意图被静默丢掉 —— 与其指望调用方记得，不如当场拦住。
    return { error: '--notify 与 --notify-print 互斥：告警出口只能有一个' };
  }
  return { options };
}

/** 链那一段要转发的开关（在本文件里只出现一次，别处不重复判断）。 */
function chainArgsFor(options) {
  const args = [];
  if (options.commit) args.push('--commit');
  args.push(options.notify ? '--notify' : '--notify-print');
  if (options.keepGoing) args.push('--keep-going');
  if (options.allowMissingPeer) args.push('--allow-missing-peer');
  // `--auto-repair`（2026-09-29 补）：分批形态下**必须转发**，否则这个开关在
  // 「跑完释放」的生产形态里被静默丢掉 —— 症状是「命令行给了它、每一批的链却都没自修」，
  // 而日志里一个字都不会提示（`run-daily-job.mjs` 收下它、批次驱动不认它）。
  if (options.autoRepair) args.push('--auto-repair');
  // ⑨b：同 `--auto-repair` 的理由 —— 不转发就等于「给了它、每批都没生效」。
  if (options.deferAgentActionableAlert) args.push('--defer-agent-actionable-alert');
  // `--relogin-on-wall`（2026-10-10）：同理由，**不转发就等于这条修复生产形态下从不生效**。
  if (options.reloginOnWall) args.push('--relogin-on-wall');
  if (options.autoRepairMaxRounds !== null && options.autoRepairMaxRounds !== undefined) {
    args.push('--auto-repair-max-rounds', String(options.autoRepairMaxRounds));
  }
  return args;
}

/** 读一批的结论，回答「这一批的链报的是不是整轮被挡」。判据在 `batchRoundBlockOf`（纯函数）。 */
function readBatchRoundBlock(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return batchRoundBlockOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** 读一批的 summary.json（原始对象）。读不到返回 null —— 「读不到」不构成任何结论。 */
function readBatchSummary(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 这一批里「脚本自修没救回来、且确实需要人/agent 看现场」的那几家（2026-10-10 加）。
 *
 * 判据**不在这里发明**：直接调 runtime 侧的 `unfixableShopsOf` —— 它同时是
 * `hold-and-resume.mjs` 的判据来源。两处用同一个函数是**有意**的：
 *   · 释放那边说「不释放（因为 X 家要人看）」，驻留那边说「不用驻留（因为一家都不需要人）」，
 *     这两句话同时出现就是自相矛盾，而它们本可以用同一个判据避免。
 * 读不到 summary ⇒ 返回空数组 ⇒ 行为回到旧口径（照旧释放）。理由与
 * `readBatchRoundBlock` 逐字相同：「读不到」不构成「有失败」的证据，而提前不释放
 * 会留下一批没人需要看的空窗口。
 */
function batchUnfixableShops(file) {
  const summary = readBatchSummary(file);
  if (!summary) return [];
  try {
    return unfixableShopsOf(summary);
  } catch {
    return [];
  }
}

/**
 * 分批形态的驻留：整轮被挡时把现场留住、等人处理，人处理完**自动按批重跑**（2026-10-06 加）。
 *
 * 为什么落点在这里，而不是在 `runtime/daily-job-plan.mjs` 里多加一步：分批驱动是**逐批**跑的，
 * 而整轮被挡对每一批给出的是同一个结论 ⇒ 在计划那一层加一步的话，剩下的批次会先各起一遍、
 * 各停一遍、各发一条同样的告警，然后才轮到驻留 —— 那时人已经被几条重复消息淹了，
 * 内存也白花了一轮。在这里就地收手，代价最小。
 *
 * 判据不由本文件发明：`batchRoundBlockOf`（纯函数）读的是**链自己落盘**的结论；
 * 「要不要驻留」由 `scripts/hold-and-resume.mjs` 自己判 —— 那是**同一个实现**，
 * 定时链那条路（`run-daily-job.mjs`）走的也是它。两处各写一套判据，迟早漂成两边结论不同。
 *
 * 续跑带 `--resume-via-batches`：分批下店铺实例是**按批起停**的，直连链会在「实例不在」的
 * 现场上开跑（见 `buildBatchResumeArgv`）。驻留那一侧会再带上 `--no-hold` 防「驻留套驻留」。
 */
/**
 * 构造给 `hold-and-resume.mjs` 的参数（**纯函数、导出**）。
 *
 * 为什么单独抽出来并导出：2026-10-10 的缺陷 ㊴ 就是**参数名传错**（给了一个对面不认识的
 * `--notify`），而它只会在**整轮被挡**时暴露一次 —— 那是最难真机复现的一刻。抽成纯函数之后，
 * 用例可以直接拿它的输出喂给 `hold-and-resume.mjs` **自己的**参数校验器，让对面当裁判：
 * 「我传的每一个开关，对面真的认」这件事就变成一条可离线跑的判据，不用等下一次真机翻车。
 *
 * 三个出口的给法**跟链那边不一样**，别照抄：`hold-and-resume.mjs` 的 `notify` 默认就是 `true`，
 * 它只提供 `--no-notify`（关）与 `--notify-print`（只打印不投递）——**没有** `--notify` 这个参数。
 * 所以 notify 为真时**什么都不传**，退回它的默认（真投递）。
 */
export function buildBatchHoldArgv({ date, summaryPath, batchSize, shops, notify, notifyPrint, workflow = null }) {
  const args = [
    '--date', date,
    '--summary', summaryPath,
    '--resume-via-batches', '--batch-size', String(batchSize),
  ];
  // 2026-10-10 真机踩坑（缺陷 ㊴）：这里原先写的是 `notify ? '--notify' : …`，于是**只要开了告警**
  // （定时/手工默认都开），驻留就在参数校验那一行直接退 2（`未知参数 --notify`），一行状态都没打印。
  // 后果是 ㊳ 的「不释放、把窗口留给修复 agent／人」**整条落空**：判断那半边说了「不释放」，
  // 但这一轮命令随即结束、宿主回收整棵进程树 ⇒ 窗口全丢，人来了也没现场可看。
  // 也就是说 ㊳ 从 2026-10-10 `a5a52b2` 起在真机上一次都没生效过（第一次触发就撞上这个 bug）。
  // 教训与 ㊲ 同源：**判据/传参对了不算数，得看调用侧真传了什么、对面真认不认**。
  if (notifyPrint) args.push('--notify-print');
  else if (!notify) args.push('--no-notify');
  if (Array.isArray(shops) && shops.length) args.push('--shops', shops.join(','));
  // `--workflow`（P0-3，2026-10-11）：发起驻留的是哪条流程就传哪条——驻留的自动续跑回到
  // **同一条流程**（buildBatchResumeArgv）。不传 ⇒ 对面缺省 daily-report（旧行为逐字不变）。
  if (workflow && workflow !== 'daily-report') args.push('--workflow', workflow);
  return args;
}

function runBatchHold({ date, summaryPath, batchSize, shops, notify, notifyPrint, workflow, logFd, log }) {
  const holdFile = 'scripts/hold-and-resume.mjs';
  const args = buildBatchHoldArgv({ date, summaryPath, batchSize, shops, notify, notifyPrint, workflow });
  log(`--- hold-and-resume：${renderCommand({ file: holdFile, args }, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
  // stdio 直接接 logFd（**不用 pipe**）：驻留可能挂几个小时，期间它会往 stdout 写状态行 ——
  // pipe 一旦没人读、缓冲区满了就会把子进程堵死，而 `spawnSync` 要等它退出才回来 ⇒ 假死。
  const result = spawnSync(NODE, [path.join(REPO_ROOT, holdFile), ...args], {
    cwd: REPO_ROOT, stdio: ['ignore', logFd, logFd], encoding: 'utf8',
  });
  const status = result.status ?? -1;
  log(`--- hold-and-resume 退出码=${status}`);
  return status;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    // [--commit]（2026-10-10 对抗审查 F 项补回）：兼容期参数 —— 等价 --mode apply（会打转换提示）。
    console.log('node scripts/run-batches.mjs [--print] [--mode dry-run|apply] [--commit] [--evidence-root <目录>] [--no-release] [--batch-size N] '
      + '[--date yesterday] [--shops a,b] [--logs 目录]');
    return 0;
  }

  // ── 启动自检（spec §4.3/§11，2026-10-10 加；同日对抗审查 E 项收窄爆炸半径）────
  // ① workflow 必须已登记：未登记 ⇒ 立即硬失败、绝不回退 daily-report。
  // ② **本次请求的 workflow** 的链入口文件必须存在（这是马上要起进程的那个文件）。
  // 两件事都必须发生在**起任何进程之前**——错跑一条流程比立刻失败贵一个量级。
  // 刻意不做全量 validateCatalogEntries：别的 workflow（如 weekly）入口丢了不该拦死日报；
  // 登记表整体合法性由测试层（runtime/workflow-catalog.test.mjs）守。
  let entry;
  try {
    entry = getWorkflow(options.workflow);
    const chainFile = entry.entry?.batch;
    if (typeof chainFile !== 'string' || !chainFile.endsWith('.mjs')
      || !fs.existsSync(path.join(REPO_ROOT, chainFile))) {
      throw new Error(`工作流 ${options.workflow} 的链入口文件不存在或非法：${JSON.stringify(chainFile ?? null)}`
        + ' —— 先在 runtime/workflow-catalog.mjs 核对 entry.batch');
    }
  } catch (error) {
    console.error(`${error.message}`);
    return 2;
  }

  // ── 模式解析（spec §5.1，2026-10-10 加）────────────────────────────────
  // 规则的单一来源是 runtime/workflow-catalog.mjs 的 resolveRunMode（纯函数、有用例）：
  // 显式 --mode 赢；--commit ⇒ apply（兼容期，必须打一行转换提示）；
  // --mode dry-run + --commit 矛盾 ⇒ 退 2；都没给 ⇒ 登记项的 manualDefault（dry-run）。
  let modeState;
  try {
    modeState = resolveRunMode({ modeArg: options.mode, commitFlag: options.commit, entry });
  } catch (error) {
    console.error(`${error.message}`);
    return 2;
  }
  const mode = modeState.mode;
  // 兼容期转换提示：--print 与真跑都打（打印的必须是真正执行的，转换也是执行事实的一部分）。
  if (modeState.convertedFromCommit) {
    console.log('[mode] --commit 已转换为 --mode apply（兼容期）');
  }

  // ── promotion-daily 的 --notify 转发（P0-2，2026-10-11）────────────────────
  // run-promotion-sales1 已认 --notify（失败才投递飞书告警、去重、成功才记账），
  // 本层照常转发；dry-run 不转——没写数据就不该惊动人（链内同口径）。
  if (options.notify && options.workflow === 'promotion-daily' && mode !== 'apply') {
    console.log('[notify] 排练（dry-run）不转发 --notify：失败告警只在写数据的 apply 轮投递');
  }

  // ── 互斥锁（P0-4，2026-10-11）──────────────────────────────────────────────
  // 与 run-daily-job / run-product-data-job 同一把 merchant-automation：三条链共享浏览器
  // 资源，互斥单位是「机器上的采集」。三个例外不抢：
  //   ① --print / 计划形态（无副作用）；
  //   ② 宿主已持锁（SYCM_WORKFLOW_LOCK_HELD 由 run-daily-job 拿锁后设置、子进程继承）；
  //   ③ 本进程自己抢到锁后也设置它——驻留的自动续跑（spawn 的 run-batches）继承后跳过，
  //     否则续跑必撞父进程还持有的锁、busy 退 1，驻留的「人处理完自动补」整条落空。
  let workflowLock = null;
  if (!options.print) {
    if (process.env.SYCM_WORKFLOW_LOCK_HELD === WORKFLOW_LOCK_NAME) {
      log('[锁] 上层已持有 merchant-automation 运行锁（本进程是子步）⇒ 不重复抢');
    } else {
      try {
        workflowLock = acquireWorkflowLock(WORKFLOW_LOCK_NAME, `run-batches:${options.workflow}`, {
          directory: path.join(REPO_ROOT, 'runtime', '.workflow-locks'),
        });
      } catch (error) {
        log(`运行锁冲突：${error.message}；持有者=${JSON.stringify(error.lock ?? null)}`
          + `（同机另一条采集流程正在跑：日报/商品/推广共用浏览器资源，等它结束再试）`);
        return 1;
      }
      process.env.SYCM_WORKFLOW_LOCK_HELD = WORKFLOW_LOCK_NAME;
      process.once('exit', () => workflowLock.release());
      if (workflowLock.staleReclaimed) {
        log(`[锁] 回收过期锁：原持有者=${workflowLock.reclaimedFrom?.owner ?? '未知'}`
          + `、pid=${workflowLock.reclaimedFrom?.pid ?? '未知'}（该进程已不在）`);
      }
    }
  }

  // 切批这一步的所有拒绝都必须发生在**起任何进程之前**：名字拼错、家数非法时，
  // 一个浏览器都不该被起 —— 那正是「静默漏做」最贵的形态（跑完了，但有两家没被处理）。
  let plan;
  let size;
  try {
    size = resolveBatchSize(options.batchSize, { fallback: DEFAULT_BATCH_SIZE });
    plan = planBatches({ shops: options.shops, size });
  } catch (error) {
    console.error(`${error.message}`);
    return 2;
  }
  const date = resolveTargetDate(options.dateInput);

  // 证据根：**批次形态用它自己的目录**，不去挤 `evidence/multi-shop-<日>/`。
  // 理由：链把 summary.json 写在 `--logs` 根上，多个批次共用同一个根会互相覆盖 ——
  // 「后一批把前一批的明细盖掉」在事后完全看不出来（文件在、内容新、没有报错）。
  // 这里只算路径（`--print` 也要能打印出真正会执行的那一行），建目录留到真跑那一步。
  const evidenceRoot = path.resolve(REPO_ROOT, options.logs ?? path.join('evidence', `batches-${date}`));

  // 跑前登录态结论：**每一批一份**，并在**那一批的 `start` 之后**生成。
  // 为什么不再整轮一份：带 `--login` 的守卫要开那几家店自己的浏览器，整轮一份就必须排在
  // 所有 `start` 之前 —— 那时实例还没起。2026-09-23 实测（batches.log 13:29:27 那段）：
  // 五家店的代理全部 `HTTP 500 连不上浏览器调试端口`，五家全 `UNREADABLE`、退出码 3，
  // **自动登录一次机会都没有**，而表面上只看到一句「不是全在登录态」。
  const loginArtifactFor = (batch) => path.join(evidenceRoot, batchLoginArtifactName(batch.index));
  const loginStepFor = (batch) => buildLoginPreflightStep({
    file: JOB_FILES.loginPreflight,
    // `--shops` 只给**本批**：这一份结论只描述这一批，本批的链也只读它。
    // `login: true`（2026-09-23 加）：掉了就自己登一次 —— 与定时链同一个默认值、同一份理由
    // （用户明确授权自动登录；且掉登录是**会话级 cookie** 导致的常态，不是偶发）。
    // 分批这条链跑得比定时链更少人看着（排练/补跑常是无人值守），更需要它。
    args: buildLoginPreflightArgs({ shops: batch.shops, json: true, login: true }),
    artifactPath: loginArtifactFor(batch),
  });

  const batches = plan.batches.map((batch) => ({
    batch,
    steps: buildBatchSteps(batch, {
      dateInput: options.dateInput,
      // 本批的链读**本批自己**那份结论（路径逐批不同，`--logs` 也是各自一份）。
      workflow: options.workflow,
      // 链入口从登记表解析（spec P2）：entry.batch 是单一来源（batch-plan 只认注入的这份字符串）。
      chainFile: entry.entry.batch,
      // 模式 ⇒ 链参数里有没有 --commit（2026-10-10 修掉的原 L309-312：
      // promotion-daily 曾被公共层**无条件**塞 ['--commit']，不看调用方给没给 ——
      // 那正是 spec §5.1「公共入口不得对某一条业务线无条件强制 apply」要治的病）。
      // 两档统一：apply ⇒ 含 --commit；dry-run ⇒ 不含。
      // ⚠️ 链子进程（run-multi-shop-day / run-promotion-sales1）不认识 --mode，
      // 命令面只能继续用 --commit —— mode 是**本层**的概念，不下传。
      // promotion-daily（P0-2，2026-10-11）：apply 且 --notify 时转发 --notify
      // （run-promotion-sales1 已认：失败才投递飞书、去重、成功才记账）；
      // dry-run 不转——没写数据不该惊动人。
      chainArgs: options.workflow === 'promotion-daily'
        ? [...(mode === 'apply' ? ['--commit'] : []), ...(mode === 'apply' && options.notify ? ['--notify'] : [])]
        : [...chainArgsFor({ ...options, commit: mode === 'apply' }), LOGIN_PREFLIGHT_FLAG, loginArtifactFor(batch)],
      logsDir: path.relative(REPO_ROOT, path.join(evidenceRoot, `b${batch.index}`)),
      loginStep: loginStepFor(batch),
    }),
  }));
  const sharedStep = options.workflow === 'promotion-daily' ? null : buildSharedStep();

  if (options.print) {
    console.log(`[批次] 版本：${versionLineSafe()}`);
    console.log(`[批次] 目标日：${options.dateInput} → ${date}；每批 ${size} 家；共 ${plan.total} 批`
      + `；模式：${mode === 'apply' ? '写飞书（--commit）' : '排练（不写飞书）'}`
      + `；跑完${options.release ? '释放' : '不释放（--no-release）'}`);
    if (sharedStep) {
      console.log(`[批次] ${sharedStep.name}: ${renderCommand(sharedStep, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
      console.log(`        ${sharedStep.note}`);
    } else console.log('[批次] promotion-daily：不启动日报共享商家浏览器，推广 Base 由推广导入器直接写入');
    // 驻留这件事必须出现在 `--print` 里：它是「人要不要守着」的决定性信息，
    // 而 `--print` 是人确认「将要执行什么」的唯一凭据（缺了它，人以为跑完就完事）。
    console.log(`[批次] 整轮被挡怎么办：${options.hold
      ? '**留住现场等人**（跑到哪一批被挡就停在哪一批，剩余批次不再跑；人处理完自动按批重跑一遍）'
      : '不驻留（--no-hold）：发完告警就结束，窗口随本轮命令一起回收'}`);
    for (const { batch, steps } of batches) {
      console.log(`[批次] ${describeBatch(batch, plan.total)}`);
      for (const step of steps) {
        console.log(`   ${step.blocking ? '*' : ' '} ${step.name}: ${renderCommand(step, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
        console.log(`        ${step.note}`);
        // 登录守卫那一步的产物路径不在命令行里（它是 stdout 落的文件），单独打出来 ——
        // `--print` 是人确认「将要执行什么」的唯一凭据，hiding 一个真实产物路径就是那句假话的同类。
        if (step.artifactPath) {
          console.log(`        结论落：${path.relative(REPO_ROOT, step.artifactPath).replaceAll('\\', '/')}`);
        }
      }
    }
    console.log('[批次] 只打印模式：没有起任何进程、没有跑链、没有停任何东西。');
    return 0;
  }
  // 证据根已经在上面算好（`--print` 用的是同一个值）。
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const logPath = path.join(evidenceRoot, 'batches.log');
  const logFd = fs.openSync(logPath, 'a');
  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    fs.writeSync(logFd, text);
    process.stdout.write(text);
  };

  log(`版本：${versionLineSafe()}`);
  log(`=== 分批跑开始：目标日 ${options.dateInput} → ${date}；每批 ${size} 家；共 ${plan.total} 批`
    + `；模式 ${mode === 'apply' ? 'commit（会写飞书）' : 'rehearse（不写飞书）'} ===`);
  log(`本批证据根：${path.relative(REPO_ROOT, evidenceRoot).replaceAll('\\', '/')}`);

  const rounds = [];
  let hardFail = 0;
  // 整轮被挡的那一批（`{ batch, summaryPath, cause }`）。非空 ⇒ 剩下的批次不跑了，转驻留。
  let blocked = null;

  // 整轮一次：共享实例（商家浏览器）。它不在任何一批里，也**永远不会被释放** ——
  // 推送段与回读段跑在它上面，停掉它等于把这一轮的产物链路掐断。
  if (sharedStep) {
    log(`--- ${sharedStep.name}：${renderCommand(sharedStep, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
    const result = spawnSync(NODE, [path.join(REPO_ROOT, sharedStep.file), ...sharedStep.args], {
      cwd: REPO_ROOT, stdio: ['ignore', logFd, logFd], encoding: 'utf8',
    });
    const status = result.status ?? -1;
    log(`--- ${sharedStep.name} 退出码=${status}`);
    if (status !== 0) {
      // 不阻断：链自己的体检会给出更准的原因（哪一页不齐、哪一家连不上）。
      // 但必须显眼 —— 它多半意味着这一整轮都跑不成。
      log('[批次] 注意：共享实例（商家浏览器）没起齐 —— 整轮很可能在链的体检那一步就停。');
    }
  }

  // 跑前登录守卫**不在整轮这一层跑了**（2026-09-23 改）：它现在是每一批 `start` 之后的
  // 那一步（见上面 `loginStepFor` 与 batch-plan.mjs 的注释）。整轮跑一次的前提是
  // 「它只读、不开页面」，而 `--login` 把这个前提推翻了 —— 五个实例还没起就被查，
  // 只会得到五行 `UNREADABLE`，而且**看起来像「今天有店掉登录了」**。
  for (const { batch, steps } of batches) {
    const round = { index: batch.index, shops: batch.shops, steps: {}, chainStatus: null, release: null };
    log(`--- ${describeBatch(batch, plan.total)} ---`);

    for (const step of steps) {
      // 释放那一段：**先把判决算出来**，不该释放时连 stop 都不执行 ——
      // 执行了就会在日志里留下一份「将停谁」的计划，事后翻日志的人会以为释放发生过。
      // 判决所需的输入是链的退出码 + 本批 summary 里「有没有要人看现场的失败」，
      // 两者在 stop 之前都已经有了。
      // ⚠️ 2026-10-10：`unfixableShops` 只影响**失败时**那一档；成功时 releaseAfterBatch
      // 在读它之前就已经返回「释放」⇒ 全绿路径的内存行为逐字不变（这是有意的：
      // 定时链在正常情况下不该因为这条改动多留一个窗口）。
      if (step.name === 'stop') {
        const batchSummaryPath = path.join(evidenceRoot, `b${batch.index}`, 'summary.json');
        const unfixableShops = round.chainStatus === 0 ? [] : batchUnfixableShops(batchSummaryPath);
        round.decision = options.release === false
          ? { release: false, why: '命令行给了 --no-release：整轮都不释放' }
          : releaseAfterBatch({
            chainStatus: round.chainStatus,
            unfixableShops,
            releaseOnFailure: options.releaseOnFailure === true,
          });
        if (unfixableShops.length) {
          log(`[批次] 这一批里「脚本自修没救回来」的：${unfixableShops.join('、')}`
            + ` —— ${round.decision.release ? '但仍释放' : '因此**不释放**，留给修复 agent／人'}`);
        }
        if (round.decision.release === false) {
          log(`--- stop：跳过 —— ${round.decision.why}`);
          round.steps.stop = 'skipped';
          continue;
        }
      }
      log(`--- ${step.name}：${renderCommand(step, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
      // 登录守卫那一步的 stdout 要**单独接出来落成文件**（本批的链把它当参数读），
      // 同时回显进日志 —— 「当时到底打了什么」这条证据不能只留在文件里（下一批会盖掉它）。
      const captureArtifact = step.name === 'login-preflight' && Boolean(step.artifactPath);
      const result = spawnSync(NODE, [path.join(REPO_ROOT, step.file), ...step.args], {
        cwd: REPO_ROOT,
        stdio: captureArtifact ? ['ignore', 'pipe', logFd] : ['ignore', logFd, logFd],
        encoding: 'utf8',
      });
      const status = result.status ?? -1;
      if (captureArtifact) {
        const stdout = result.stdout ?? '';
        fs.writeFileSync(step.artifactPath, stdout, 'utf8');
        if (stdout) fs.writeSync(logFd, stdout);
        log(`--- ${step.name} 结论已落 ${path.relative(REPO_ROOT, step.artifactPath).replaceAll('\\', '/')}`
          + `（${Buffer.byteLength(stdout, 'utf8')} 字节；本批的链会读它）`);
      }
      log(`--- ${step.name} 退出码=${status}`);
      round.steps[step.name] = status;

      // 守卫不是闸门（三个退出码的含义见 check-login-shops.mjs 头部），但它非 0 多半意味着
      // 「这几家掉登录了、而且自动登录也没成」—— 必须显眼，否则这一轮会带着一条假结论往下跑。
      if (step.name === 'login-preflight' && status !== 0) {
        log(`[批次] 注意：${step.name} 不是「全在登录态」（退出码 ${status}）—— 不阻断，`
          + '链的告警会点名是哪家店的哪个后台。');
      }

      if (step.name === 'chain') round.chainStatus = status;
      if (step.name === 'stop' && status !== 0) {
        // 「说停掉了、其实还活着」由 stop-all 自己回读进程表判（它非 0 就是没停干净）。
        hardFail += 1;
      }
      if (step.blocking && step.name === 'start' && status !== 0) {
        // 起不来**仍然继续跑链**：链的第 0 步体检是「今天能不能采」的权威判据，
        // 它会给出更准的原因（哪一页不齐、哪一家连不上）。在这里截断只会少一层信息。
        log('[批次] 注意：这一批没起齐 —— 仍然跑链，因为链自己的体检会给出更准的原因。');
      }
      if (!step.blocking && status !== 0 && step.name !== 'stop') {
        log(`[批次] 注意：${step.name} 没成功（退出码 ${status}）—— 不阻断（窗口标识页只影响人看不看得懂，不影响数据）。`);
      }
    }

    if (round.chainStatus !== 0) hardFail += 1;
    if (round.decision?.release === false && round.steps.stop === 'skipped') {
      // 走到这里有两档：`--no-release`（整轮不释放）与新的「本批有要人看现场的失败」。
      // 无论哪一档都要说清「不主动释放」**不等于**「窗口一定活着」—— 真正把它留住的是
      // 下面那一步转驻留（不结束这一轮）；只不释放、又马上结束命令的话，
      // 宿主照样回收进程树，而日志里那句「不释放」会让人以为现场还在。这个假绿的代价
      // 正是 2026-10-10 用户抓到的那件事（「你关了，人来了也不知道是什么问题」）。
      log(`[批次] 这一批不主动释放：${round.decision.why}；`
        + (round.decision.holdsForRepair
          ? '接着转驻留把这一轮挂住（不结束命令，窗口才真的留得住）'
          : '注意这不等于窗口还在（start-all 起完就退，宿主会回收整棵进程树）'));
    }

    rounds.push(round);
    // `释放` 这个词在**本文件里只有一个意思**：末尾那句里的「释放 N 批」。
    // 这一行原先写成 `释放=${stop 的退出码}` ⇒ 打印出「释放=0」，与末尾的「释放 1 批」并列时
    // 读起来像「一批都没释放」。2026-09-23 自己读日志时就误读过一次 —— 所以改成点名的写法。
    log(`--- ${describeBatch(batch, plan.total)} 小结：链退出码=${round.chainStatus}；`
      + `stop（释放窗口）=${round.steps.stop === 'skipped' ? '未跑' : `退出码 ${round.steps.stop}`}；`
      + `${round.decision?.why ?? ''}`);

    // 整轮被挡 ⇒ **剩下的批次跑也没用**：链的整轮级体检跑在**共用的商家浏览器**上，
    // 对每一批给出的是同一个结论（实测凭据见 `batchRoundBlockOf` 的注释：
    // b1/b2 逐字停在同一步同一句）。继续跑只会把每批的实例白起一遍白停一遍、再各发一条同样的告警。
    //
    // 只在**确实读到**「整轮被挡」时才收手：读不到结论（文件不在/读不成 JSON）时维持旧行为往下跑 ——
    // 「读不到」不构成「被挡」的证据，而提前收手会跳过本来能跑的批次。
    const batchSummary = path.join(evidenceRoot, `b${batch.index}`, 'summary.json');
    const roundBlock = round.chainStatus === 0 ? null : readBatchRoundBlock(batchSummary);
    if (roundBlock) {
      const rest = plan.total - batch.index;
      log(`[批次] 这一批的链报的是**整轮被挡**（${roundBlock.cause}`
        + `${Array.isArray(roundBlock.missingPages) && roundBlock.missingPages.length
          ? `；窗口里少了 ${roundBlock.missingPages.join('、')}` : ''}）`
        + ' —— 这不是这一批哪一家的事：链的整轮级体检跑在**共用的商家浏览器**上，'
        + (rest > 0 ? `后面 ${rest} 批会撞同一堵墙。` : '本轮是最后一批。')
        + '停在这里，剩下的批次不跑了。');
      blocked = { batch: batch.index, summaryPath: batchSummary, cause: roundBlock.cause };
      break;
    }
    if (round.chainStatus !== 0) {
      // ── 2026-10-10 加：**逐店**失败也要转驻留 ──────────────────────────────
      // 这一段原先只有一句「照常跑下一批」。缺的那一块正是用户点出来的：
      // 「为什么没有托住页面，而是全部关了？不然转人工有什么用呢？」
      // 驻留（`hold-and-resume.mjs`）建了、判据（`unfixableShopsOf`）也写对了，
      // 但它**只被整轮被挡那一档调起** ⇒ 单店失败一路走到「照旧释放」，现场被 taskkill 拆干净，
      // 人到了只剩一张告警文案。判据与动作早就存在，缺的是把这一档也接上。
      //
      // 为什么只在这一批**确实有**「脚本自修没救回来」的店时才挂住：驻留会**把整轮停在这里等人**，
      // 对一批「失败但不需要人看」的（比如同日去重、平台空态）挂住就是白挂几小时。
      // 所以闸门用的是同一个 `unfixableShopsOf`（与释放判据同源）。
      // 挂住之后剩下的批次**不跑了**：驻留结束时会把 `--shops` 那几家按批重跑，
      // 而这里若继续跑后面的批次，会与驻留的续跑撞车、也会把内存白花一轮。
      const unfixable = batchUnfixableShops(batchSummary);
      if (unfixable.length) {
        log(`[批次] 这一批里「脚本自修没救回来」的：${unfixable.join('、')}`
          + ' —— 这几家的现场要留给修复 agent／人 ⇒ 停在这里转驻留（剩下的批次不跑了）。');
        blocked = { batch: batch.index, summaryPath: batchSummary, cause: 'UNFIXABLE_SHOPS' };
        break;
      }
      // 链失败但**不是**整轮被挡（比如这一批里某一家店自己停了）⇒ 照常跑下一批，
      // 并说清为什么不收手 —— 否则日志里「失败了却继续」看起来像漏判。
      log('[批次] 这一批的链失败了，但不是整轮被挡、也没有「脚本自修没救回来」的店'
        + '（不需要人看现场）⇒ 照常跑下一批。');
    }
  }

  let holdStatus = null;
  if (blocked) {
    if (options.hold) {
      log(`[批次] 整轮被挡 ⇒ 转驻留（第 ${blocked.batch} 批的结论 ${path.relative(REPO_ROOT, blocked.summaryPath).replaceAll('\\', '/')}）：`
        + '把共用窗口留住等人处理，人处理完**自动按批重跑一遍**（挂多久由驻留那一步自己决定并打印）。'
        + '窗口留不留得住取决于这一轮进程不结束 —— 驻留就是「这一轮不结束」这件事本身。');
      holdStatus = runBatchHold({
        date, summaryPath: blocked.summaryPath, batchSize: size,
        shops: options.shops, notify: options.notify, notifyPrint: options.notifyPrint,
        workflow: options.workflow, logFd, log,
      });
      if (holdStatus === HOLD_EXIT.RESUMED_OK) {
        log('[批次] 人处理完了、自动续跑成功 ⇒ 这一轮的缺口补上了，整轮退出码记 0'
          + '（第 ' + blocked.batch + ' 批当时是失败的，已经不再代表最终结果）。');
      } else if (holdStatus === HOLD_EXIT.TIMED_OUT) {
        log('[批次] 等到截止时间也没等到人处理 ⇒ 这一轮仍缺数据（收信人应收到一条「还缺着」的提醒）。');
      } else if (holdStatus === HOLD_EXIT.RESUME_FAILED) {
        log('[批次] 人处理完了、但自动续跑仍没成功 ⇒ 不再自动重试第二次，需要技术同学看现场。');
      } else if (holdStatus === HOLD_EXIT.NO_VERDICT) {
        log('[批次] 驻留读不到结论 ⇒ 没有挂住（它不拿一个猜的结论把机器挂住）。');
      } else if (holdStatus === HOLD_EXIT.NO_HOLD) {
        log('[批次] 驻留判下来这一轮不需要人 ⇒ 没有挂住。');
      }
    } else {
      log('[批次] 整轮被挡，但给了 --no-hold ⇒ 不驻留：发完告警本轮就结束，'
        + '窗口随命令结束一起被回收（要现场得自己另起 start-all-hold.mjs 托住）。');
    }
  }

  // 最终口径：**只有**「驻留后自动续跑成功」（HOLD_EXIT.RESUMED_OK）允许把整轮翻回 0 ——
  // 与 `scripts/run-daily-job.mjs` 同一条纪律：这个数字要变绿，必须对应一件**真发生过**的事
  // （那几家真的补上了），不能只是「我们试过了」。链那一步当时的失败码仍然记在 batches.json 里。
  const recovered = holdStatus === HOLD_EXIT.RESUMED_OK;
  const index = {
    version: versionLineSafe(),
    date, dateInput: options.dateInput, mode: mode === 'apply' ? 'commit' : 'rehearse',
    batchSize: size, evidenceRoot: path.relative(REPO_ROOT, evidenceRoot).replaceAll('\\', '/'),
    release: options.release,
    // 驻留要留痕：停在第几批、结论文件在哪、驻留退出码是多少。
    // 不留的话，事后只能从 batches.log 的字缝里猜「为什么一共 2 批只跑了 1 批」。
    hold: blocked
      ? {
        holdEnabled: options.hold,
        blockedBatch: blocked.batch,
        summary: path.relative(REPO_ROOT, blocked.summaryPath).replaceAll('\\', '/'),
        cause: blocked.cause,
        exitCode: holdStatus,
        recovered,
      }
      : null,
    rounds,
  };
  fs.writeFileSync(path.join(evidenceRoot, 'batches.json'), `${JSON.stringify(index, null, 1)}\n`, 'utf8');

  // ── 统一回执（run-receipt-v1，spec §6，2026-10-10 加；同日对抗审查 A/B 项整改）──
  // 落点：与 batches.json 同一处（批次循环结束之后），blocked/驻留路径也会走到这里。
  // 映射本体抽在 runtime/batch-rounds-receipt.mjs（纯函数，判据见其文件头三条纪律：
  // 驻留终态 ⇒ FAILED / PAUSED 不可达；失败店只收逐店名单，不把整批成功店伪标成失败店；
  // apply 下 chain 步 publication=UNKNOWN —— 真实写入但未独立回读）。这里只负责
  // 喂 plain data（逐店 unfixable 名单、batches.json 的 size/sha256）与落盘。
  //
  // 两条取舍（写死在这里，报告里也如实说）：
  //   ① **compat 优先**：回执生成失败 ⇒ stderr 打醒目警告、**绝不写一份自称成功的回执**、
  //      也不改变业务退出码 —— 回执是第二格式（spec §6.1），它坏了不该把跑成的业务轮次
  //      染红、更不该把跑失败的轮次洗绿。spec §11「统一回执生成失败时不得把旧收据标成成功」
  //      由「抛错即不落盘」（writeRunReceipt 写前校验）+ 这里的 try/catch 共同保证。
  //      batches.json 在 try **之外**落盘 —— 它是第一收据，回执坏不坏都保得住。
  //   ② **release.observed 永不为 true**：本仓纪律 —— 释放只认独立两次端口回读，
  //      回执生成这一步没做回读，就不许假装观察到（observed:false + status:UNKNOWN/HELD
  //      由映射模块统一给出）。
  try {
    // batches.json 的证据工件描述（spec §7.3：文件大小、哈希，对抗审查 B 项）——
    // 对**落盘的同一份字节**算，不对「将要写的内容」算：回执里记的必须是已发生的事实。
    const batchesJsonPath = path.join(evidenceRoot, 'batches.json');
    const batchesJsonText = fs.readFileSync(batchesJsonPath, 'utf8');
    const batchesArtifact = {
      path: path.relative(REPO_ROOT, batchesJsonPath).replaceAll('\\', '/'),
      size: Buffer.byteLength(batchesJsonText, 'utf8'),
      sha256: crypto.createHash('sha256').update(batchesJsonText, 'utf8').digest('hex'),
    };
    const receipt = buildRunReceiptFromRounds({
      entry, targetDate: date, mode, batchSize: size,
      // 逐店 unfixable 名单在这里读（I/O 留在薄壳），映射模块只收 plain data；
      // 成功的批不读（链退出码 0 ⇒ 该批对失败店清单无贡献）。
      rounds: rounds.map((round) => ({
        ...round,
        unfixable: round.chainStatus === 0 ? [] : batchUnfixableShops(path.join(evidenceRoot, `b${round.index}`, 'summary.json')),
      })),
      blocked, holdEnabled: options.hold, holdStatus, hardFail,
      batchesArtifact,
    });
    const runRoot = resolveRunRoot({ cliRoot: options.evidenceRoot, envRoot: process.env.SYCM_RUN_ROOT });
    const layout = ensureRunLayout(buildRunLayout(runRoot, entry.id, date, receipt.runId));
    writeRunReceipt(layout.receiptFile, receipt);
    // manifest 记**实际证据根**（链/batches.json 落的旧路径 —— spec §7.3 迁移纪律：
    // 回执必须记录实际证据根路径与保留级别；retention 用 run-root 的默认值，成功 30/失败 180/不自动删）。
    writeManifest(layout.manifestFile, {
      workflow: entry.id, workflowVersion: entry.version, targetDate: date, runId: receipt.runId, mode,
      notes: `实际证据根（兼容期旧路径，batches.json/链产物落这里）：${
        path.relative(REPO_ROOT, evidenceRoot).replaceAll('\\', '/')}`,
    });
    log(`[run-receipt-v1] 统一回执已落 ${path.relative(REPO_ROOT, layout.receiptFile).replaceAll('\\', '/')}`
      + `；manifest ${path.relative(REPO_ROOT, layout.manifestFile).replaceAll('\\', '/')}`);
  } catch (error) {
    // 绝不写一份自称成功的回执（上面的构造抛错 ⇒ 什么都没落盘），也不改业务退出码。
    console.error(`[run-receipt-v1] 生成失败: ${error && error.message ? error.message : error}`);
  }

  log(`=== 分批跑结束：${rounds.filter((r) => r.chainStatus === 0).length}/${plan.total} 批成功；`
    + `释放 ${rounds.filter((r) => typeof r.steps.stop === 'number').length} 批；明细 ${path.join(path.relative(REPO_ROOT, evidenceRoot), 'batches.json').replaceAll('\\', '/')} ===`);
  if (blocked) {
    log(`[批次] 本轮在**第 ${blocked.batch} 批**停手（整轮被挡：${blocked.cause}）—— 只跑了 `
      + `${rounds.length}/${plan.total} 批，剩余批次**没有跑**（它们会撞同一堵墙）；`
      + `驻留退出码=${holdStatus ?? '未跑'}。`);
  }
  fs.closeSync(logFd);
  return recovered || hardFail === 0 ? 0 : 1;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
