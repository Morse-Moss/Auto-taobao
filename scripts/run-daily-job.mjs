#!/usr/bin/env node

// 定时任务的**唯一入口**：到点敲这一条，其余都在它里面。
//
// 为什么不让计划任务直接跑全链驱动：真实要做的有两件 —— ① 保证实例在（浏览器与代理；
// 本项目进程绑会话，机器重启或回收之后它们不在），② 跑全链。两件都塞进 `/TR` 由 shell 拼，
// 三个月后没人能说清当时到底跑的是什么。步骤口径在 runtime/daily-job-plan.mjs（纯函数、有判据）。
//
// 每一步的输出都落进同一个日志文件（计划任务里没有人看终端，日志是唯一的证据）。
// 退出码＝全链那一步的退出码；`start-all` 的结论只记录、不改变退出码 ——
// 因为「今天能不能写」的权威判据在链的第 0 步体检里，它给出的告警比这里准确。
//
// 用法：
//   node scripts/run-daily-job.mjs                          # 真跑（会写飞书）
//   node scripts/run-daily-job.mjs --print                  # 只打印将执行的两条命令，什么都不做
//   node scripts/run-daily-job.mjs --notify                 # 出错时发飞书（默认只把文案落日志）
//   node scripts/run-daily-job.mjs --shops 科塔淘宝         # 只跑一家（排查用）
// 退出码：0＝全链成功；非 0＝全链失败（与驱动的退出码一致）；2＝用法错误
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildJobPlan, renderCommand } from '../runtime/daily-job-plan.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const options = { notify: false, notifyPrint: false, keepGoing: false, allowMissingPeer: false, print: false };
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
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数 ${arg}（可用：--print --notify --notify-print --keep-going --allow-missing-peer --date --shops --only）` };
  }
  return { options };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/run-daily-job.mjs [--print] [--notify|--notify-print] [--date yesterday] [--shops a,b] [--only 阶段名]');
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
    console.log(`[定时] 目标日字面量：${plan.dateInput}（由驱动按 Asia/Shanghai 解析，这里不自己算）`);
    console.log(`[定时] 实际会解析成：${resolveTargetDate(plan.dateInput)}`
      + '  ← 只用来给你看一眼；真跑时由驱动在那一刻重新解析（跨零点不漂）');
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

  log(`=== 定时任务开始（目标日字面量 ${plan.dateInput} → ${date}）===`);
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
