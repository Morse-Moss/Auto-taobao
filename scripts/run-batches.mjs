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

import {
  DEFAULT_BATCH_SIZE, batchLoginArtifactName, buildBatchSteps, buildLoginPreflightStep, buildSharedStep,
  describeBatch, planBatches, releaseAfterBatch, resolveBatchSize,
} from '../runtime/batch-plan.mjs';
// 跑前登录守卫那一步的**文件、参数名**都只在那里定义一次（分批这条链与定时链共用）。
// 不各写一份：漂出来的症状是静默的 —— 链那边参数没少、只是永远读不到结论。
// 产物名**不从这里取**：分批形态每批一份（`batchLoginArtifactName`），共用一个常量正是要治的那个病。
import {
  JOB_FILES, LOGIN_PREFLIGHT_FLAG, buildLoginPreflightArgs, renderCommand,
} from '../runtime/daily-job-plan.mjs';
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
      chainArgs: [...chainArgsFor(options), LOGIN_PREFLIGHT_FLAG, loginArtifactFor(batch)],
      logsDir: path.relative(REPO_ROOT, path.join(evidenceRoot, `b${batch.index}`)),
      loginStep: loginStepFor(batch),
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
      // 判决所需的唯一输入是链的退出码，而它在 stop 之前就已经有了。
      if (step.name === 'stop') {
        round.decision = options.release === false
          ? { release: false, why: '命令行给了 --no-release：整轮都不释放' }
          : releaseAfterBatch({ chainStatus: round.chainStatus });
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
      // 只有 `--no-release` 才走得到这里。说清是「不主动释放」，**不是**「窗口留着」——
      // 后一句在非 hold 形态下是做不到的（见 batch-plan.mjs 的 releaseAfterBatch）。
      log(`[批次] 这一批不主动释放：${round.decision.why}；`
        + '注意这不等于窗口还在（start-all 起完就退，宿主会回收整棵进程树）');
    }

    rounds.push(round);
    // `释放` 这个词在**本文件里只有一个意思**：末尾那句里的「释放 N 批」。
    // 这一行原先写成 `释放=${stop 的退出码}` ⇒ 打印出「释放=0」，与末尾的「释放 1 批」并列时
    // 读起来像「一批都没释放」。2026-09-23 自己读日志时就误读过一次 —— 所以改成点名的写法。
    log(`--- ${describeBatch(batch, plan.total)} 小结：链退出码=${round.chainStatus}；`
      + `stop（释放窗口）=${round.steps.stop === 'skipped' ? '未跑' : `退出码 ${round.steps.stop}`}；`
      + `${round.decision?.why ?? ''}`);
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
