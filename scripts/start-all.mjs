#!/usr/bin/env node

// 一键把本项目声明的浏览器实例起齐（Browser Broker 的 BR-3 前半：可重复、可断言的起）。
//
// 定位：这是**定时任务的入口**，也是最常见的人工入口。它必须满足三条：
//   幂等 —— 跑一百次与跑一次的结果相同。已就位的实例一个都不碰（不起第二份、也不重启）。
//   判据自带 —— 「起好了没有」不靠它自己说，而是回头用 runtime/browser-inventory.mjs 再盘一遍
//             （同一套探测、同一套分桶）；盘完还不 ready 就把该实例的日志尾巴打出来。
//   不猜 —— 端口上若是**别人的** profile、或读不出身份，一律拒绝对它动作并把理由原样输出。
//            这两种情况下「起一个」的真实效果是把调试端点接到别人身上，而全程不报错。
//
// 与 stop-all.mjs 的默认值**刻意不同**：这里默认就动手，stop-all 默认只打印。
// 理由不是「起比停安全」，而是错误的代价落在哪一边：
//   起错了 → 多一个连不上目标的进程，看得见、能停；
//   停错了 → 别人的活进程没了（项目最高优先级纪律）。
// 所以危险侧要显式点头，安全侧不必。
//
// 用法：
//   node scripts/start-all.mjs                    # 起齐所有未就位的
//   node scripts/start-all.mjs --dry-run          # 只打印将要执行的动作
//   node scripts/start-all.mjs --only 科塔淘宝,盖文天猫
//   node scripts/start-all.mjs --timeout 90       # 每个实例等就绪的秒数（默认 45）
//   node scripts/start-all.mjs --json             # 机器可读
// 退出码：0＝目标全部就位；1＝有目标没起成或被拒；2＝用法错误
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectInstance, summarize } from '../runtime/browser-inventory.mjs';
import { buildChildEnv, buildFullPlan, launcherHintFor, matchInstances, onlyHelpText, selectActions } from '../runtime/launch-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const options = { dryRun: false, json: false, only: null, timeoutSec: 45 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--timeout') options.timeoutSec = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数 ${arg}；可用：--dry-run --json --only <键,键> --timeout <秒>` };
  }
  if (options.only && options.only.length === 0) return { error: '--only 后面要跟至少一个实例键' };
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) return { error: '--timeout 必须是正数秒' };
  return { options };
}

/** 起一个进程：detached + 日志落盘。返回 pid 与日志路径。 */
function spawnLauncher(command, { logDir, tag }) {
  const file = path.join(REPO_ROOT, command.file);
  const logPath = path.join(logDir, `${tag}-${command.role}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [file, ...command.args], {
    cwd: REPO_ROOT,
    // 环境必须清干净再给（见 launch-plan.INSTANCE_ENV_KEYS 的说明）：
    // 继承一个残留的 PROJECT_BROWSER_PORT，会让「一键起齐」把每一家店都指向同一个端口，
    // 而它表现出来是**全绿**。
    env: buildChildEnv(command),
    // detached：让启动器与代理活过本脚本（否则「起完就退」会把它们一起收走）。
    // stdio 落盘而不是 inherit：本脚本可能在计划任务里跑，没有任何人看终端；
    // 而启动器的输出（REUSE / 拒绝启动 / READY）恰恰是出问题时唯一的证据。
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return { pid: child.pid, logPath, file };
}

/** 日志尾巴：失败时把真正的理由捞出来，而不是只说一句「没起来」。 */
function tailLog(logPath, lines = 12) {
  try {
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/u).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一个实例达到 ready（判据＝browser-inventory 的同一套探测与分桶）。 */
async function waitForReady(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await inspectInstance(entry);
  while (Date.now() < deadline) {
    if (last.judgement === 'ready') return last;
    await sleep(2000);
    last = await inspectInstance(entry);
  }
  return last;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/start-all.mjs [--dry-run] [--json] [--only 键,键] [--timeout 秒]');
    return 0;
  }

  // 用 buildFullPlan() 而不是 buildDeclarationPlan()：前者在登记表条目的基础上补上
  // `launch`（每个实例那两条启动命令）与 `stopOrder`，而后者的条目上**没有** launch。
  // 2026-09-19 实测到的真事故：这里原先调 buildDeclarationPlan，于是 `item.launch` 是 undefined，
  // 一旦真有实例需要起，就崩在 `item.launch.find(...)` 上（排练模式永远看不到 —— 它只打印）。
  const plan = buildFullPlan();
  const matched = matchInstances(plan, options.only);
  const targets = matched.targets;
  if (matched.unknown.length > 0) {
    // 拼错名字不静默回落（回落的表现是「跑完了，但那家店根本没起」）。
    // 提示里给的是**可读名**，不是内部键 —— 键是我这边的叫法，不是操作者见过的名字。
    console.error(`--only 里的这些实例不在登记表：${matched.unknown.join('、')}\n${onlyHelpText(plan)}`);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const logDir = path.join(REPO_ROOT, 'runtime', 'start-stop-logs', stamp);
  if (!options.dryRun) fs.mkdirSync(logDir, { recursive: true });

  const before = [];
  for (const entry of targets) before.push(await inspectInstance(entry));

  const report = { at: new Date().toISOString(), dryRun: options.dryRun, logDir, instances: [] };

  for (const item of before) {
    const action = selectActions(item.judgement);
    const record = {
      who: item.who, key: item.key, judgementBefore: item.judgement,
      reason: action.reason, started: [], judgementAfter: null,
    };

    // 已就位、或被拒的桶：一个进程都不起。拒绝的理由要在报告里看得见，
    // 否则操作者只会看到「它没起」，然后去重启机器。
    if (action.start.length === 0 || options.dryRun) {
      if (action.start.length > 0 && options.dryRun) record.started = action.start.map((role) => ({ role, dryRun: true }));
      report.instances.push(record);
      continue;
    }

    const launched = [];
    for (const role of action.start) {
      const command = item.launch.find((c) => c.role === role);
      const started = spawnLauncher(command, { logDir, tag: item.key });
      launched.push({ role, pid: started.pid, log: path.relative(REPO_ROOT, started.logPath).replaceAll('\\', '/') });
    }
    record.started = launched;

    const settled = await waitForReady(item, options.timeoutSec * 1000);
    record.judgementAfter = settled.judgement;
    record.probe = settled.probe;
    if (settled.judgement !== 'ready') {
      // 只打「刚起的那些角色」的日志，避免把另一个角色的旧日志当成这次的原因。
      record.logTail = launched.flatMap((entry) => {
        const full = path.join(REPO_ROOT, entry.log);
        return [`--- ${item.key}/${entry.role} ---`, ...tailLog(full)];
      });
    }
    report.instances.push(record);
  }

  // 最终盘点：只对**目标集**下结论（--only 时不该拿没被处理的实例来报失败），
  // 但整体现状一并附上，免得操作者以为「只有这几家」。
  const finalAll = [];
  for (const entry of plan) finalAll.push(await inspectInstance(entry));
  const targetKeys = new Set(targets.map((e) => e.key));
  const finalTargets = finalAll.filter((item) => targetKeys.has(item.key));
  const targetAccount = summarize(finalTargets);
  report.finalAll = finalAll.map((item) => ({ who: item.who, judgement: item.judgement }));
  report.finalCounts = targetAccount.counts;
  report.allReady = targetAccount.allReady;
  report.verification = `判据＝node runtime/browser-inventory.mjs 的同一套探测（非本脚本自报）`;

  if (options.json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`[起齐] 目标 ${targets.length} 个实例（来源：runtime/browser-ports.mjs）${options.dryRun ? '—— 排练模式，不会起任何进程' : ''}`);
    for (const record of report.instances) {
      const line = `${record.who}  起前:${record.judgementBefore}  ${record.reason}`;
      if (record.started.length === 0) console.log(`  · ${line}`);
      else {
        console.log(`  · ${line}`);
        for (const started of record.started) {
          console.log(started.dryRun ? `      将起 ${started.role}` : `      已起 ${started.role} pid=${started.pid}  日志 ${started.log}`);
        }
        console.log(`      起后:${record.judgementAfter}`);
      }
      for (const line2 of record.logTail ?? []) console.log(`      ${line2}`);
    }
    if (!options.dryRun) {
      const stuck = finalTargets.filter((item) => item.judgement !== 'ready');
      console.log(`[判据] ${targetAccount.allReady ? '目标全部就位' : `还有 ${stuck.length} 个未就位：${stuck.map((i) => `${i.who}(${i.judgement})`).join('、')}`}`);
      console.log(`       复核：node runtime/browser-inventory.mjs`);
    }
  }

  return report.allReady ? 0 : 1;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
