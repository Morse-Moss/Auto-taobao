#!/usr/bin/env node

// 停掉本项目声明的浏览器实例（Browser Broker 的 BR-3 后半：可解释、可拒绝的释放）。
//
// **默认只打印，不动手。** 要真停必须显式 `--yes`。这不是谨慎过头：
// 这台机器上同时跑着别的项目（见 browser-ports.FOREIGN_PORTS），杀错是不可撤销的；
// 而项目最高优先级纪律就是「不经明确点头，绝不动任何存活进程」。
// 起脚本（start-all）默认就动手，是因为错误的代价落在另一边 —— 多一个连不上的进程看得见、能停。
//
// 每个被停的进程都必须带着**证据**，而且证据来自进程自己：
//   浏览器：CDP 端口回报的 profile 与本实例登记一致（classifyPortUsage === 'ours'）；
//   代理  ：端口上的进程命令行里认得出对应的启动脚本（店铺还要认得出店名）。
// 证据不到位的角色**拒停**并把原因打出来，而不是「尽力而为」。
//
// 停止顺序与起相反：先断代理、后动浏览器 —— 让「浏览器永远比代理活得久」这句话在两侧都成立。
//
// 用法：
//   node scripts/stop-all.mjs                        # 只打印要停谁、为什么、执行哪条命令
//   node scripts/stop-all.mjs --yes                  # 真的停
//   node scripts/stop-all.mjs --yes --only 科塔淘宝
//   node scripts/stop-all.mjs --json
// 退出码：0＝打印模式（或全部按计划停完）；1＝有拒停项或停不掉；2＝用法错误
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildDeclarationPlan, findAncestorByPid, inspectInstance, parseListenTable,
  parseProcessTable, readProcessTable,
} from '../runtime/browser-inventory.mjs';
import { launcherHintFor, matchInstances, onlyHelpText, planInstanceStop, taskkillArgs } from '../runtime/launch-plan.mjs';
import { classifyPortUsage, inspectPort } from '../runtime/browser-ports.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** taskkill 的绝对路径。用它而不是裸命令名：本脚本可能在计划任务里跑，那里的 PATH 未必一样。 */
const TASKKILL = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');

function parseArgs(argv) {
  const options = { yes: false, json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--only') options.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `未知参数 ${arg}；可用：--yes --json --only <键,键>` };
  }
  if (options.only && options.only.length === 0) return { error: '--only 后面要跟至少一个实例键' };
  return { options };
}

function listenTableNow() {
  try {
    return parseListenTable(execFileSync('netstat', ['-ano', '-p', 'tcp'], { maxBuffer: 32 * 1024 * 1024 }).toString('latin1'));
  } catch {
    // 读不到监听表 ⇒ 后面每个 pid 都是 null ⇒ 全部落进「找不到进程」而不是「可以停」。
    return new Map();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { options } = parsed;
  if (options.help) {
    console.log('node scripts/stop-all.mjs [--yes] [--json] [--only 键,键]   （不带 --yes 时只打印）');
    return 0;
  }
  if (options.yes && !fs.existsSync(TASKKILL)) {
    // 打印一份「我停不了」的计划比打印一份「将停」的计划诚实。
    console.error(`找不到 ${TASKKILL} —— 无法执行停止；本脚本只能继续以只打印模式运行。`);
    options.yes = false;
  }
  if (!options.yes) console.log('（只打印模式：不会停任何进程。要真停请加 --yes）');
  const plan = buildDeclarationPlan();
  const matched = matchInstances(plan, options.only);
  const targets = matched.targets;
  if (matched.unknown.length > 0) {
    console.error(`--only 里的这些实例不在登记表：${matched.unknown.join('、')}\n${onlyHelpText(plan)}`);
    return 2;
  }

  const listen = listenTableNow();
  const { rows: processRows, error: processError } = await readProcessTable();
  const report = {
    at: new Date().toISOString(), executed: options.yes,
    processTableError: processError, instances: [],
  };

  for (const entry of targets) {
    const hint = launcherHintFor(entry);
    const browserPid = listen.get(entry.browserPort) ?? null;
    const proxyPid = listen.get(entry.proxyPort) ?? null;

    // 浏览器身份：端口上有东西时，让**浏览器自己**说它是谁的 profile。
    let browserVerdict = null;
    if (browserPid) {
      const inspection = await inspectPort(entry.browserPort, { timeoutMs: 1200 });
      browserVerdict = classifyPortUsage(inspection, { expectedProfile: entry.profile }).verdict;
    }
    // 启动器 node：浏览器主进程的父进程（不监听端口，只能这样认）。
    const launcher = browserPid ? findAncestorByPid(processRows, browserPid, { name: 'node.exe' }) : null;

    // 代理身份：端口上的进程命令行里认得出启动脚本（店铺还要认得出店名）。
    let proxyIdentity = null;
    if (proxyPid) {
      const row = processRows.find((r) => r.pid === proxyPid);
      const script = hint.proxyScript.split('/').at(-1);
      const matchesScript = Boolean(row) && row.cmd.includes(script);
      proxyIdentity = {
        script, matchesScript,
        // 店铺代理的命令行是 `node …/start-shop-proxy.mjs 科塔淘宝` —— 店名就在参数里。
        // 非店铺实例没有这个参数，`matchesKey` 记 null 表示「这条不适用」，不是「没认出来」。
        matchesKey: entry.kind === 'shop' ? Boolean(row) && row.cmd.includes(entry.key) : null,
      };
    }

    const decision = planInstanceStop(entry, {
      browserPid, browserVerdict, launcherPid: launcher?.pid ?? null, proxyPid, proxyIdentity,
    });

    const record = {
      who: entry.who, key: entry.key,
      targets: decision.targets.map((t) => ({ ...t, command: `taskkill ${taskkillArgs(t.pid).join(' ')}` })),
      refusals: decision.refusals,
      executed: [],
    };

    if (options.yes) {
      for (const target of decision.targets) {
        try {
          execFileSync(TASKKILL, taskkillArgs(target.pid), { stdio: 'pipe' });
          record.executed.push({ pid: target.pid, role: target.role, ok: true });
        } catch (error) {
          // taskkill 在「进程已经没了」时也返回非 0 —— 那不算失败。看得见的证据是**回读**。
          record.executed.push({ pid: target.pid, role: target.role, ok: false, error: String(error.stderr ?? error.message).trim().split('\n')[0] });
        }
      }
      if (decision.targets.length > 0) {
        await sleep(1500);
        // 判据是回读，不是 taskkill 的退出码（HTTP 200 / exit 0 都可能是假成功，这里同理）。
        const after = await inspectInstance(entry);
        record.judgementAfter = after.judgement;
        // 「还活着吗」必须拿**杀之后新读的**进程表来判。
        // 用循环外那份 processRows 快照是错的：它是杀之前读的，于是这里会把每个 pid 都报成「仍在」，
        // 而结论行同时写着「盘点到 missing」——一句自相矛盾的假判据（2026-09-19 实测到）。
        // 与 HTTP 200 同理：回读要回读到**当下**。
        const { rows: afterRows, error: afterError } = await readProcessTable();
        record.processTableErrorAfter = afterError;
        record.stillAlive = afterError
          ? null // 读不出来 ≠ 还在跑。null 表示「这一项没证据」，不参与判决。
          : decision.targets.filter((t) => afterRows.some((r) => r.pid === t.pid)).map((t) => t.pid);
      }
    }
    report.instances.push(record);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`[停] 目标 ${targets.length} 个实例${options.yes ? '' : '（只打印）'}`);
    if (processError) console.log(`  [警告] 读进程表失败（${processError}）⇒ 找不到父子关系，只能直接停浏览器主进程`);
    for (const record of report.instances) {
      console.log(`  · ${record.who}`);
      for (const target of record.targets) console.log(`      将停 ${target.role} pid=${target.pid}  ← ${target.evidence}\n         ${target.command}`);
      for (const refusal of record.refusals) console.log(`      拒停 ${refusal.role} pid=${refusal.pid}  ← ${refusal.why}`);
      if (record.targets.length === 0 && record.refusals.length === 0) console.log('      没有在跑，无需处理');
      for (const done of record.executed) console.log(`      ${done.ok ? '已停' : '未停'} ${done.role} pid=${done.pid}${done.ok ? '' : `  ${done.error}`}`);
      if (record.judgementAfter) {
        const alive = record.stillAlive === null
          ? '（进程表读不出来 ⇒ 这一项没有证据，不下结论）'
          : (record.stillAlive.length > 0 ? `（这些 pid 仍在进程表里：${record.stillAlive.join(', ')}）` : '');
        console.log(`      停后盘点到:${record.judgementAfter}${alive}`);
      }
    }
    const refusals = report.instances.reduce((sum, i) => sum + i.refusals.length, 0);
    if (refusals > 0) console.log(`  [判据] 有 ${refusals} 项拒停 —— 它们需要人看一眼，不是脚本能决定的`);
    // 「说停掉了、其实还活着」也要非 0 退出：否则调用方会把一次没停干净当成成功。
    const survived = report.instances.reduce((sum, i) => sum + (i.stillAlive?.length ?? 0), 0);
    if (survived > 0) console.log(`  [判据] 有 ${survived} 个 pid 停后仍在进程表里 —— 停没停干净，别当成功`);
  }

  const hardFail = report.instances.reduce(
    (sum, i) => sum + i.refusals.length + (i.stillAlive?.length ?? 0),
    0,
  );
  return hardFail > 0 ? 1 : 0;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
