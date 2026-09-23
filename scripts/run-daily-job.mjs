#!/usr/bin/env node

// 定时任务的**唯一入口**：到点敲这一条，其余都在它里面。
//
// 为什么不让计划任务直接跑全链驱动：真实要做的有三件 —— ① 保证实例在（浏览器与代理；
// 本项目进程绑会话，机器重启或回收之后它们不在），② 看一眼五家店的登录态（只读，
// 2026-09-23 加），③ 跑全链。三件都塞进 `/TR` 由 shell 拼，
// 三个月后没人能说清当时到底跑的是什么。步骤口径在 runtime/daily-job-plan.mjs（纯函数、有判据）。
//
// 每一步的输出都落进同一个日志文件（计划任务里没有人看终端，日志是唯一的证据）。
// 日志开头第一行是**版本**（runtime/version.mjs）—— 事后拿到一份日志，
// 第一个问题永远是「这是哪一版跑出来的」，而这个问题没有第二个地方能回答。
// 退出码＝全链那一步的退出码；`start-all` 的结论只记录、不改变退出码 ——
// 因为「今天能不能写」的权威判据在链的第 0 步体检里，它给出的告警比这里准确。
//
// 用法：
//   node scripts/run-daily-job.mjs                          # 真跑（会写飞书）
//   node scripts/run-daily-job.mjs --print                  # 只打印将执行的三步命令，什么都不做
//   node scripts/run-daily-job.mjs --notify                 # 出错时发飞书（默认只把文案落日志）
//   node scripts/run-daily-job.mjs --shops 科塔淘宝         # 只跑一家（排查用）
//   node scripts/run-daily-job.mjs --batches 2              # 分批跑：每批 2 家，跑完释放这一批
//                                                          # （**默认不启用**；不给就与从前逐字相同）
// 退出码：0＝全链成功；非 0＝全链失败（与驱动的退出码一致）；2＝用法错误
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildJobPlan, renderCommand } from '../runtime/daily-job-plan.mjs';
import { versionLineSafe } from '../runtime/version.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const options = { notify: false, notifyPrint: false, keepGoing: false, allowMissingPeer: false, print: false, batches: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print') options.print = true;
    else if (arg === '--notify') options.notify = true;
    else if (arg === '--notify-print') options.notifyPrint = true;
    else if (arg === '--keep-going') options.keepGoing = true;
    else if (arg === '--allow-missing-peer') options.allowMissingPeer = true;
    else if (arg === '--date') options.dateInput = argv[++i];
    else if (arg === '--shops') options.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--only') options.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--batches') {
      // 值在这里就校验：拼错的 `--batches 2家` 不该变成一个「跑全量」的静默回落
      // （那正好是这一版要治的形态：全店常驻、内存撑不住）。
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        return { error: `--batches 要一个 ≥1 的整数（每批几家），收到 ${JSON.stringify(raw)}` };
      }
      options.batches = value;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数 ${arg}（可用：--print --notify --notify-print --keep-going --allow-missing-peer --date --shops --only --batches）` };
  }
  return { options };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/run-daily-job.mjs [--print] [--notify|--notify-print] [--date yesterday] [--shops a,b] [--only 阶段名] [--batches N]');
    return 0;
  }

  // 传了 --notify-print 就不要再从环境里读默认值：两者互斥由 buildJobPlan 当场拦。
  let plan;
  try {
    plan = buildJobPlan({
      dateInput: options.dateInput ?? 'yesterday',
      notify: options.notify,
      notifyPrint: options.notifyPrint,
      keepGoing: options.keepGoing,
      allowMissingPeer: options.allowMissingPeer,
      shops: options.shops,
      only: options.only,
      batches: options.batches,
    });
  } catch (error) {
    // 计划本身不合法时给一句人话 + 用法错误码；把栈打给操作者没有用（他不是来读栈的）。
    console.error(`${error.message}`);
    return 2;
  }

  const commands = plan.steps.map((step) => ({
    ...step,
    text: renderCommand(step, { nodeExe: NODE, repoRoot: REPO_ROOT }),
  }));

  if (options.print) {
    console.log(`[定时] 版本：${versionLineSafe()}`);
    console.log(`[定时] 目标日字面量：${plan.dateInput}（由驱动按 Asia/Shanghai 解析，这里不自己算）`);
    console.log(`[定时] 实际会解析成：${resolveTargetDate(plan.dateInput)}`
      + '  ← 只用来给你看一眼；真跑时由驱动在那一刻重新解析（跨零点不漂）');
    if (plan.batches) {
      console.log(`[定时] 分批跑：每批 ${plan.batches} 家 —— 起这一批 → 挂店铺标识页 → 跑 → 停这一批`
        + '（跑成才停；失败不主动释放）');
      // 这句是 2026-09-23 真机实测后改的：从前这里写「失败留着等人看」，但批次的 start 是
      // scripts/start-all.mjs（起完就退）—— 宿主要在命令结束时回收整棵进程树，这批窗口活不过本轮，
      // 实测命令结束后 0.26 秒就连同启动器一起消失。「不释放」只是「我不去停它」，不等于「窗口还在」。
      console.log('[定时] 边界：窗口留不留得住取决于用什么托住 —— 要真的留到人来看，'
        + '得另起 scripts/start-all-hold.mjs；人不在现场时，可查的证据是证据目录里的日志'
        + '（batches.log ＋ 链自己的体检原始输出）。');
    }
    for (const command of commands) console.log(`${command.blocking ? '*' : ' '} ${command.name}: ${command.text}\n     ${command.note}`);
    console.log('[定时] 只打印模式：没有起任何进程、也没有跑链。');
    return 0;
  }

  const date = resolveTargetDate(plan.dateInput);
  const jobDir = path.join(REPO_ROOT, 'evidence', `daily-job-${date}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const logPath = path.join(jobDir, 'job.log');
  const logFd = fs.openSync(logPath, 'a');
  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    fs.writeSync(logFd, text);
    process.stdout.write(text);
  };

  // 用 versionLineSafe 而不是 versionLine：这里记的是账，不是判据。
  // VERSION 文件丢了是记账问题，为了它停掉一整天的采集是把小错升级成业务停摆；
  // 但它落的是 `unknown（读不到版本号文件 …）`，原因跟在同一行里，不会被当成正常输出。
  log(`版本：${versionLineSafe()}`);
  log(`=== 定时任务开始（目标日字面量 ${plan.dateInput} → ${date}）===`);
  if (plan.batches) {
    // 分批这件事必须写进日志第一屏：事后拿到一份日志，要能一眼看出
    // 「今天是一次全起还是分三批，每批几家」—— 否则内存账单与失败形态都无从解释。
    log(`[定时] 分批跑：每批 ${plan.batches} 家（跑完释放这一批；链失败则不主动释放）`);
    log('[定时] 边界：批次里的 start 是 scripts/start-all.mjs（起完就退）—— 宿主要在命令结束时回收整棵'
      + '进程树，所以这批窗口活不过本轮命令；「不主动释放」只是「我不去停它」，不等于「窗口还在」。'
      + '要留窗口给人排查，必须另起 scripts/start-all-hold.mjs 把本批实例托住。');
  }
  log(`日志：${logPath}`);

  let chainStatus = null;
  for (const command of commands) {
    log(`--- ${command.name}：${command.text}`);
    // stdio 直接继承调用者的：计划任务里 stdout 会被我们的 logFd 接住吗？不会 ——
    // 所以这里显式把子进程输出写进同一个 fd，父子两边的输出按时间顺序落在同一份证据里。
    const result = spawnSync(NODE, [path.join(REPO_ROOT, command.file), ...command.args], {
      cwd: REPO_ROOT, stdio: ['ignore', logFd, logFd], encoding: 'utf8',
    });
    const status = result.status ?? -1;
    log(`--- ${command.name} 退出码=${status}`);
    if (command.blocking) chainStatus = status;
    else if (status !== 0) {
      log(`[定时] 注意：${command.name} 没成功（退出码 ${status}）—— 不阻断下一步，`
        + '因为链的第 0 步体检是「今天能不能写」的权威判据，它会给出更准的告警。');
    }
  }

  log(`=== 定时任务结束：全链退出码=${chainStatus}；证据目录 evidence/multi-shop-${date}/ ===`);
  fs.closeSync(logFd);
  return chainStatus ?? 1;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
