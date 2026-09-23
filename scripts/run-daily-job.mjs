#!/usr/bin/env node

// 定时任务的**唯一入口**：到点敲这一条，其余都在它里面。
//
// 为什么不让计划任务直接跑全链驱动：真实要做的有三件 —— ① 保证实例在（浏览器与代理；
// 本项目进程绑会话，机器重启或回收之后它们不在），② 看一眼五家店的登录态（只读，
// 2026-09-23 加），③ 跑全链。三件都塞进 `/TR` 由 shell 拼，
// 三个月后没人能说清当时到底跑的是什么。步骤口径在 runtime/daily-job-plan.mjs（纯函数、有判据）。
//
// 每一步的输出都落进同一个日志文件（计划任务里没有人看终端，日志是唯一的证据）。
// 唯一的例外是**跑前登录态体检**那一步：它的 stdout 还会被单独落成
// `<本轮证据目录>/login-preflight.json`，并由本文件把它作为 `--login-preflight` 交给链
// （2026-09-23）—— 这样链在失败时才能说出「哪个店哪个后台掉登录了」，而不是让人去开页面。
// 那份 JSON 同时回显进日志，所以「当时到底打了什么」仍然只有一处证据来源。
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
//   node scripts/run-daily-job.mjs --no-auto-login          # 跑前那一步退回**只读**体检（默认是「掉了就自己登」）
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
  const options = { notify: false, notifyPrint: false, keepGoing: false, allowMissingPeer: false, print: false, batches: null,
    // `autoLogin` **默认开**（2026-09-23 用户明确授权自动登录后翻的默认值，原话
    // 「可以自动登录把项目规则改了」）。理由不是「方便」，而是**掉登录的成因已经查清**：
    // 淘宝系的登录键（`cookie2` / `_tb_token_`）是**会话级 cookie**，浏览器进程一结束就丢，
    // 所以掉登录是**每次重启都会发生**的常态，不是偶发事故 —— 把常态交给人工，
    // 等于把「无人值守」这句话作废。`--no-auto-login` 是退回只读体检的开关。
    autoLogin: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print') options.print = true;
    else if (arg === '--notify') options.notify = true;
    else if (arg === '--notify-print') options.notifyPrint = true;
    else if (arg === '--keep-going') options.keepGoing = true;
    else if (arg === '--allow-missing-peer') options.allowMissingPeer = true;
    else if (arg === '--no-auto-login') options.autoLogin = false;
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
    else return { error: `未知参数 ${arg}（可用：--print --notify --notify-print --keep-going --allow-missing-peer --no-auto-login --date --shops --only --batches）` };
  }
  return { options };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/run-daily-job.mjs [--print] [--notify|--notify-print] [--date yesterday] [--shops a,b] [--only 阶段名] [--batches N] [--no-auto-login]');
    return 0;
  }

  // 传了 --notify-print 就不要再从环境里读默认值：两者互斥由 buildJobPlan 当场拦。
  //
  // 证据目录在这里就先算出来（`--print` 也要算）：跑前登录态结论要落进它，而链那一步的
  // `--login-preflight` 必须指向**真实路径**。这个日期只用于**记账路径** ——
  // 链那一步仍然只收到字面量（`--date yesterday`），由它在那一刻重新解析（跨零点不漂），
  // 与从前逐字相同。
  const date = resolveTargetDate(options.dateInput ?? 'yesterday');
  const jobDir = path.join(REPO_ROOT, 'evidence', `daily-job-${date}`);

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
      // 这一句是「跑前登录态结论进告警」那条链的**起点**：给了它，计划里 ② 那一步才会带
      // `--json`、③ 那一步才会带 `--login-preflight <本轮证据目录>/login-preflight.json`。
      // 漏了它的症状是静默的：告警照发，只是永远说「这一轮没有先查登录态」。
      artifactsDir: jobDir,
      // 「掉了就自己登」那一条链的**起点**（2026-09-23 加）。给了它，跑前那一步才会带 `--login`；
      // 漏了它的症状同样是静默的：那一步照跑、报告照打，只是**永远不去登**，
      // 而日志里看不出「本该去登却没登」—— 这正是这一版要修的那件事本身。
      // 默认开（用户明确授权），`--no-auto-login` 关掉它。
      autoLogin: options.autoLogin,
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
      console.log(`[定时] 分批跑：每批 ${plan.batches} 家 —— 起这一批 → 查本批登录 → 挂店铺标识页 → 跑 → `
        + '停这一批（**一律释放**：链成功、链失败、链没跑到，都放）');
      // 这两句都是 2026-09-23 真机实测后改的。
      // ① 释放口径：从前写「失败不主动释放／失败留着等人看」，但批次的 start 是
      //    scripts/start-all.mjs（起完就退）—— 宿主要在命令结束时回收整棵进程树，
      //    这批窗口活不过本轮，实测命令结束后 0.26 秒就连同启动器一起消失。
      //    于是「不释放」的真实效果只有「内存没省下来」＋「现场也没留住」。
      // ② 因此提醒的是**怎么才留得住**，而不是「它留着」：
      //    要真的留到人来看，得 `--no-release` **并且**另起 scripts/start-all-hold.mjs 托住；
      //    人不在现场时，可查的证据是证据目录里的日志（batches.log ＋ 链自己的体检原始输出）。
      console.log('[定时] 边界：窗口留不留得住取决于用什么托住 —— 要真的留到人来看，'
        + '得同时给 --no-release 与 scripts/start-all-hold.mjs（缺一不可）；'
        + '人不在现场时，可查的证据是证据目录里的日志（batches.log ＋ 链自己的体检原始输出）。');
    }
    for (const command of commands) console.log(`${command.blocking ? '*' : ' '} ${command.name}: ${command.text}\n     ${command.note}`);
    console.log('[定时] 只打印模式：没有起任何进程、也没有跑链。');
    return 0;
  }

  // `date` / `jobDir` 在计划之前就算好了（跑前登录态结论要落进 jobDir）。
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
    //
    // 例外：带 `artifactPath` 的那一步（跑前登录态体检）要把 stdout **单独接出来**。
    // 为什么不能只让它写进日志：链那一步要把**那个文件**当参数读，而 job.log 里混着全过程输出，
    // 没法当参数用。回显进日志这一步也保留 —— 「当时到底打了什么」这条证据不能因为
    // 「反正有文件了」就丢掉（文件会被后一轮覆盖）。
    const usePipe = Boolean(command.artifactPath);
    const result = spawnSync(NODE, [path.join(REPO_ROOT, command.file), ...command.args], {
      cwd: REPO_ROOT, stdio: usePipe ? ['ignore', 'pipe', logFd] : ['ignore', logFd, logFd], encoding: 'utf8',
    });
    const status = result.status ?? -1;
    if (usePipe) {
      const stdout = result.stdout ?? '';
      fs.writeFileSync(command.artifactPath, stdout, 'utf8');
      if (stdout) fs.writeSync(logFd, stdout);
      // 字节数也记：写成 0 字节时，链那侧会把它读成「本来要查、结论没读出来」——
      // 这一行是事后判断「是没写出来还是写出来了但空」的唯一依据。
      log(`--- ${command.name} 结论已落 ${path.relative(REPO_ROOT, command.artifactPath).replaceAll('\\', '/')}`
        + `（${Buffer.byteLength(stdout, 'utf8')} 字节；链那一步会读它）`);
    }
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
