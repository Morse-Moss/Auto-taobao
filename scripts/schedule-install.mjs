#!/usr/bin/env node

// 把定时任务挂到 Windows 任务计划程序（触发层）。
//
// **默认只打印，不动手。** 要真挂必须显式 `--install`。理由与 stop-all 默认只打印同源：
// 这是一次**会在明天 11:40 自己动起来**的系统变更 —— 它会在你不在的时候写飞书。
// 打印出来的那条命令要能被人一眼读懂，所以入口只有一个：`scripts/run-daily-job.mjs`
// （它自己按 runtime/daily-job-plan.mjs 的顺序跑两步）。
//
// 触发层只负责叫醒：「今天能不能写」的判据与「出事叫谁」都在那条命令里
// （三层划分见 docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md §3）。
//
// 时刻为什么是 11:40：同一目标日的阿里妈妈 CSV 在 11:20 前后才静止（sop.md §13 有实测）。
// 设计上本条咒语该由「同目标日二次导出逐字节相同才写」的自动判据替掉 —— **那条判据还没实现**，
// 所以在那之前，触发时刻本身就是唯一的安全边界，不要往 11:20 之前放。
//
// 用法：
//   node scripts/schedule-install.mjs                 # 只打印将要注册什么（默认）
//   node scripts/schedule-install.mjs --install       # 真注册（/F 覆盖同名任务）
//   node scripts/schedule-install.mjs --query         # 只读：现在挂了没有、下次什么时候跑
//   node scripts/schedule-install.mjs --remove        # 删除该任务
//   node scripts/schedule-install.mjs --install --notify    # 出错时发飞书（默认只落日志）
//   node scripts/schedule-install.mjs --time 12:10    # 换触发时刻
// 退出码：0＝打印/查询/成功；1＝查询发现没挂；2＝用法错误或执行失败
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderJobEntryCommand } from '../runtime/daily-job-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'schtasks.exe');

// 任务名与触发时刻都是**可读的**，不写内部代号：以后在「任务计划程序」界面里
// 找它的人不该需要来问一句「sycm-…-v2 是哪个」。
const TASK_NAME = 'sycm-daily-round';
// 11:40 这个默认值来自 sop.md §13 的实测结论（不要往 11:20 之前放），在这里只出现一次。
const DEFAULT_TIME = '11:40';

function parseArgs(argv) {
  const options = { mode: 'print', notify: false, time: DEFAULT_TIME, name: TASK_NAME };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install') options.mode = 'install';
    else if (arg === '--remove') options.mode = 'remove';
    else if (arg === '--query') options.mode = 'query';
    else if (arg === '--notify') options.notify = true;
    else if (arg === '--time') options.time = String(argv[++i] ?? '');
    else if (arg === '--name') options.name = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数 ${arg}（可用：--install --remove --query --notify --time HH:MM --name 名字）` };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(options.time)) {
    return { error: `--time 需要 HH:MM（24 小时制），收到 ${JSON.stringify(options.time)}` };
  }
  // 「不要往 11:20 之前放」不是纪念性的忠告，是 upsert 前要拦一次的事实判据。
  // 判据**写在这里**而不是靠读文档：读文档的人不会读到这一行。
  if (options.mode === 'install' && options.time < '11:20') {
    return { error: `拒绝注册 ${options.time}：同一目标日的推广 CSV 在 11:20 前后才静止，`
      + '更早触发会写下一个当天不可修的低值（见 skills/sycm-alimama-daily-report/references/sop.md §13）。'
      + '要改这条前提，请先实现「同目标日二次导出逐字节相同才写」那条判据。' };
  }
  return { options };
}

/**
 * 跑 schtasks。**必须把「跑不起来」与「跑起来了但结论是否」分开报**。
 *
 * 2026-09-19 实测：本机把 `schtasks.exe` 放进了安全策略的黑名单，spawn 直接以
 * `EPERM` 失败 —— 没有任何输出、退出码为 null。若把这种情况当成「查询失败」就报「没挂」，
 * 那是一条**假阴性**：任务可能好端端挂着，而我告诉操作者「没挂」。
 * 这与项目里反复出现的那条纪律同源：**读不出来 ≠ 缺失**。
 */
function runSchtasks(args, { capture = false } = {}) {
  const result = spawnSync(SCHTASKS, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) return { status: null, out, blocked: result.error.code === 'EPERM' || /EPERM|EACCES/u.test(result.error.message) };
  return { status: result.status ?? -1, out, blocked: false };
}

function describeBlocked(entry, time) {
  console.error(`无法执行 schtasks.exe（${SCHTASKS}）—— 本机安全策略把它列进了禁止启动的程序清单。`);
  console.error('这既不是「挂了」也不是「没挂」，是**读不出来**。三条可行路径（任选一条）：');
  console.error('  1) 在「安全中心 → 命令安全 → 程序黑名单」里把 schtasks.exe 移出，再回来跑本脚本；');
  console.error('  2) 用任务计划程序界面手工挂：taskschd.msc → 创建基本任务 → 每日 → 时刻填 ' + time + ' →');
  console.error('     操作选「启动程序」，程序或脚本填下面第一段（node 的完整路径），');
  console.error('     添加参数填下面第二段（脚本路径）：');
  console.error(`       ${entry}`);
  console.error('  3) 用平台的定时任务每天到点跑同一条命令 ——');
  console.error('     无需任何系统级配置，代价是每次触发要起一次会话（消耗 token、要求客户端在运行）。');
  console.error('     2026-09-21 起本项目实际用的就是这一条。注意：**同一时刻只许有一个叫醒者** ——');
  console.error('     换宿主请先撤掉旧的那个，否则同一时刻两边各跑一次、同目标日会重复写飞书。');
  return 3;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/schedule-install.mjs [--install|--remove|--query] [--notify] [--time HH:MM] [--name 名字]');
    return 0;
  }
  if (!process.env.SystemRoot && process.platform !== 'win32') {
    console.error('这不是 Windows；任务计划程序不可用（本脚本只做 Windows 触发层）。');
    return 2;
  }

  const entryArgs = options.notify ? ['--notify'] : [];
  // /TR 的值必须是**一整条**字符串：schtasks 把 /TR 后面那一整个参数交给 CreateProcess，
  // 与 shell 的转义规则不是一回事。这里由 Node 负责拼好，不做 shell 拼接。
  const entry = renderJobEntryCommand({
    nodeExe: process.execPath, repoRoot: REPO_ROOT, jobFile: 'scripts/run-daily-job.mjs', args: entryArgs,
  });
  const createArgs = ['/Create', '/TN', options.name, '/SC', 'DAILY', '/ST', options.time, '/TR', entry, '/F'];

  if (options.mode === 'query') {
    const result = runSchtasks(['/Query', '/TN', options.name, '/V', '/FO', 'LIST'], { capture: true });
    if (result.blocked) return describeBlocked(entry, options.time);
    if (result.status !== 0) {
      // 到这里才是真的「查询跑通了、任务不存在」（schtasks 找不到任务时会自己说一句）。
      console.log(`没挂：任务「${options.name}」不存在（${result.out.split('\n')[0] || 'schtasks 没有给出原因'}）`);
      console.log(`要挂：node scripts/schedule-install.mjs --install`);
      return 1;
    }
    // 只挑能回答「什么时候跑、跑的是什么」的那几行 —— 整份 /V 输出几十行，人不看。
    for (const line of result.out.split(/\r?\n/u)) {
      if (/任务名|下次运行时间|上次运行时间|上次结果|要运行的任务|状态|TaskName|Next Run Time|Last Run Time|Task To Run/i.test(line)) {
        console.log(`  ${line.trim()}`);
      }
    }
    return 0;
  }

  if (options.mode === 'remove') {
    console.log(`将删除任务「${options.name}」`);
    const result = runSchtasks(['/Delete', '/TN', options.name, '/F']);
    if (result.blocked) return describeBlocked(entry, options.time);
    return result.status === 0 ? 0 : 2;
  }

  if (options.mode === 'print') {
    console.log('[定时注册] 只打印模式（要真挂请加 --install）。\n');
    console.log(`任务名：${options.name}    触发器：每天 ${options.time}`);
    console.log(`将执行：${entry}\n`);
    console.log('等价的 schtasks 调用（/TR 已由脚本拼好，不要手抄这一段 —— 计划任务的解析器与 shell 不是一回事）：');
    console.log(`  schtasks ${createArgs.map((a) => (/\s/u.test(a) ? `"${a}"` : a)).join(' ')}`);
    console.log('\n挂之前建议先干验证一次（只读、不写、不投递）：');
    console.log(`  node scripts/run-daily-job.mjs --print`);
    return 0;
  }

  const result = runSchtasks(createArgs);
  if (result.blocked) return describeBlocked(entry, options.time);
  if (result.status !== 0) {
    console.error('注册失败（schtasks 跑起来了但返回非 0）。若报的是 /TR 解析问题，把 --print 打出来的那条'
      + '「将执行」命令手工填进任务计划程序：程序或脚本＝node 路径，添加参数＝脚本路径与其参数。');
    return 2;
  }
  const verify = runSchtasks(['/Query', '/TN', options.name, '/V', '/FO', 'LIST'], { capture: true });
  // 回读才是判据，注册命令的退出码不是（「HTTP 200 也可能是假成功」是同一个道理）。
  console.log(verify.status === 0 ? '已注册，且回读到了。用 --query 看下次运行时间。'
    : '注册命令返回成功，但**回读没有确认** —— 请用 --query 复核，不要当它已经挂好。');
  return verify.status === 0 ? 0 : 1;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
