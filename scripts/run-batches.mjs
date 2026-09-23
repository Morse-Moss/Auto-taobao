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
//   2) **该不该发起释放** —— 同一个模块的 releaseAfterBatch（用户第 5 条拍板：失败优先解决问题）。
//   3) **能不能真停** —— scripts/stop-all.mjs 的三类证据（CDP 自报 profile / 代理命令行 /
//      启动器 pid），foreign 与 unconfirmed 一律拒停。本文件**不替它判**。
//
// 默认**不写飞书**：不给 `--commit` 就是排练（与链本身的默认一致）。
// 默认**会释放**：只在链跑成的时候（见 releaseAfterBatch）；`--no-release` 可以整轮关掉。
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

import {
  DEFAULT_BATCH_SIZE, buildBatchSteps, buildSharedStep, describeBatch, planBatches, releaseAfterBatch,
  resolveBatchSize,
} from '../runtime/batch-plan.mjs';
import { renderCommand } from '../runtime/daily-job-plan.mjs';
import { versionLineSafe } from '../runtime/version.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const options = {
    dateInput: 'yesterday', batchSize: null, shops: null, commit: false, keepGoing: false,
    allowMissingPeer: false, notify: false, notifyPrint: false, logs: null, print: false,
    release: true, help: false,
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
    else if (arg === '--batch-size') options.batchSize = argv[++i];
    else if (arg === '--date') options.dateInput = argv[++i];
    else if (arg === '--logs') options.logs = argv[++i];
    else if (arg === '--shops') options.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      return {
        error: `未知参数 ${arg}（可用：--print --commit --no-release --batch-size N --date <日> `
          + '--shops a,b --keep-going --allow-missing-peer --notify|--notify-print --logs <目录>）',
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
  return args;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/run-batches.mjs [--print] [--commit] [--no-release] [--batch-size N] '
      + '[--date yesterday] [--shops a,b] [--logs 目录]');
    return 0;
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
  const chainArgs = chainArgsFor(options);

  // 证据根：**批次形态用它自己的目录**，不去挤 `evidence/multi-shop-<日>/`。
  // 理由：链把 summary.json 写在 `--logs` 根上，多个批次共用同一个根会互相覆盖 ——
  // 「后一批把前一批的明细盖掉」在事后完全看不出来（文件在、内容新、没有报错）。
  // 这里只算路径（`--print` 也要能打印出真正会执行的那一行），建目录留到真跑那一步。
  const evidenceRoot = path.resolve(REPO_ROOT, options.logs ?? path.join('evidence', `batches-${date}`));

  const batches = plan.batches.map((batch) => ({
    batch,
    steps: buildBatchSteps(batch, {
      dateInput: options.dateInput,
      chainArgs,
      logsDir: path.relative(REPO_ROOT, path.join(evidenceRoot, `b${batch.index}`)),
    }),
  }));
  const sharedStep = buildSharedStep();

  if (options.print) {
    console.log(`[批次] 版本：${versionLineSafe()}`);
    console.log(`[批次] 目标日：${options.dateInput} → ${date}；每批 ${size} 家；共 ${plan.total} 批`
      + `；模式：${options.commit ? '写飞书（--commit）' : '排练（不写飞书）'}`
      + `；跑完${options.release ? '释放' : '不释放（--no-release）'}`);
    console.log(`[批次] ${sharedStep.name}: ${renderCommand(sharedStep, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
    console.log(`        ${sharedStep.note}`);
    for (const { batch, steps } of batches) {
      console.log(`[批次] ${describeBatch(batch, plan.total)}`);
      for (const step of steps) {
        console.log(`   ${step.blocking ? '*' : ' '} ${step.name}: ${renderCommand(step, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
        console.log(`        ${step.note}`);
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
    + `；模式 ${options.commit ? 'commit（会写飞书）' : 'rehearse（不写飞书）'} ===`);
  log(`本批证据根：${path.relative(REPO_ROOT, evidenceRoot).replaceAll('\\', '/')}`);

  const rounds = [];
  let hardFail = 0;

  // 整轮一次：共享实例（商家浏览器）。它不在任何一批里，也**永远不会被释放** ——
  // 推送段与回读段跑在它上面，停掉它等于把这一轮的产物链路掐断。
  {
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

  for (const { batch, steps } of batches) {
    const round = { index: batch.index, shops: batch.shops, steps: {}, chainStatus: null, release: null };
    log(`--- ${describeBatch(batch, plan.total)} ---`);

    for (const step of steps) {
      // 释放那一段：**先把判决算出来**，不该释放时连 stop 都不执行 ——
      // 执行了就会在日志里留下一份「将停谁」的计划，事后翻日志的人会以为释放发生过。
      // 判决所需的唯一输入是链的退出码，而它在 stop 之前就已经有了。
      if (step.name === 'stop') {
        round.decision = options.release === false
          ? { release: false, why: '命令行给了 --no-release：整轮都不释放' }
          : releaseAfterBatch({ chainStatus: round.chainStatus });
        if (round.decision.release === false) {
          log(`--- stop：跳过 —— ${round.decision.why}`);
          // 判决里那条「留窗口」是有条件的，条件必须跟着判决一起出现在日志里 ——
          // 否则这一行会被读成「窗口还在，去看吧」，而它多半已经不在了（见 releaseAfterBatch 的注释）。
          if (round.decision.caveat) log(`    （留窗口的前提：${round.decision.caveat}）`);
          round.steps.stop = 'skipped';
          continue;
        }
      }
      log(`--- ${step.name}：${renderCommand(step, { nodeExe: NODE, repoRoot: REPO_ROOT })}`);
      const result = spawnSync(NODE, [path.join(REPO_ROOT, step.file), ...step.args], {
        cwd: REPO_ROOT, stdio: ['ignore', logFd, logFd], encoding: 'utf8',
      });
      const status = result.status ?? -1;
      log(`--- ${step.name} 退出码=${status}`);
      round.steps[step.name] = status;

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
      // 「不主动释放」而不是「窗口留着」：后一句在非 hold 形态下是做不到的（见 batch-plan 的 caveat）。
      log(`[批次] 这一批不主动释放：${round.decision.why}`);
    }

    rounds.push(round);
    log(`--- ${describeBatch(batch, plan.total)} 小结：链退出码=${round.chainStatus}；`
      + `释放=${round.steps.stop === 'skipped' ? '未做' : round.steps.stop}；${round.decision?.why ?? ''}`);
  }

  const index = {
    version: versionLineSafe(),
    date, dateInput: options.dateInput, mode: options.commit ? 'commit' : 'rehearse',
    batchSize: size, evidenceRoot: path.relative(REPO_ROOT, evidenceRoot).replaceAll('\\', '/'),
    release: options.release, rounds,
  };
  fs.writeFileSync(path.join(evidenceRoot, 'batches.json'), `${JSON.stringify(index, null, 1)}\n`, 'utf8');

  log(`=== 分批跑结束：${rounds.filter((r) => r.chainStatus === 0).length}/${plan.total} 批成功；`
    + `释放 ${rounds.filter((r) => typeof r.steps.stop === 'number').length} 批；明细 ${path.join(path.relative(REPO_ROOT, evidenceRoot), 'batches.json').replaceAll('\\', '/')} ===`);
  fs.closeSync(logFd);
  return hardFail === 0 ? 0 : 1;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
