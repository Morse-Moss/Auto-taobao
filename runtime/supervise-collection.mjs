#!/usr/bin/env node
// 采集监督环 —— 盯住一次正在进行的 XWS 自适应采集，在「状态发生变化」时投递飞书告警。
//
// 定位（别把它当 round-runner）：
//   round-runner 回答「这一轮该不该跑、跑什么、怎么收尾」；
//   本脚本只回答「这一次采集现在到哪了，异常有没有被送出去」。
//   它是单次执行的外部护栏，不拥有任何运行状态，也不做自愈。
//
// 判据（fail-closed，与 round-notify-policy 同向）：
//   RUNNING          进程活着，且末事件没超过该阶段预算、采集进度还在推进
//   SUSPECT_STALLED  进程活着，但**末事件静止超过该阶段预算**（PHASE_BUDGETS），
//                    或**采集进度签名（页/行数）超过 --progress-budget-seconds 没变**
//   COMPLETED        进程已退出、退出码 0（给了 --stdout-file 时还要求出现 ADAPTIVE_DONE）
//   FAILED           进程已退出、退出码非 0
//   UNKNOWN          事件文件读不到 / 进程已退出但没有退出码证据 —— 只许写 UNKNOWN，
//                    既不写 OK 也不写 FAILED
// 同一状态只投一次；只有状态变化才重新投递（避免告警轰炸）。
// RUNNING 默认**不投递**（首轮把 RUNNING 当基线），要开机通知就显式给 --announce-running。
//
// 用法：
//   node runtime/supervise-collection.mjs --run-dir <p> [--pid <n>] [--exit-code-file <p>]
//        [--stdout-file <p>] [--stale-seconds 420] [--progress-budget-seconds 240]
//        [--interval 15] [--since-minutes N] [--once] [--dry-run] [--announce-running] [--label "..."]
//
// 为什么需要 --exit-code-file / --stdout-file：ADAPTIVE_DONE 只由 run-adaptive-export.mjs
// 打到 stdout，**不会**写进 events.jsonl（events.jsonl 的末事件是 DONE）。所以"成功"这件事必须
// 由持久化证据来证明，不能靠 events.jsonl 的末事件名去猜。
// 给了 --stdout-file 时以它为主：它由采集器自己写进文件，**不依赖启动器还活着**；退出码文件是
// 启动器写的，启动器被回收就没影了（2026-09-15 实测）。两者矛盾时按失败处理。
// 给了 --runtime-dir + --stdout-file 时连运行目录都能自己从日志里推，不必等人告诉它。
//
// 退出码：0 = 正常收尾（COMPLETED）；1 = 异常收尾（FAILED / SUSPECT_STALLED / UNKNOWN）。
// 告警投递本身「没发出去」由 notify-feishu.mjs 保证非零退出码。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const NOTIFY_CLI = path.join(HERE, 'notify-feishu.mjs');

// 从采集器的 stdout 日志里解析 runId，推导运行目录。
// 为什么要这样：让监督环**只靠一份持久化日志**就能自己找到运行目录，不依赖启动器还活着
// （2026-09-15 教训：启动器随会话被回收，运行目录就没人告诉监督环了）。
// 日志第一行就是 {"event":"ADAPTIVE_RUN_STARTED","runId":"<uuid>"}。
export function discoverRunDir(logText, runtimeDir) {
  if (!logText || !runtimeDir) return null;
  const match = /"runId":"([0-9a-fA-F-]{36})"/u.exec(String(logText));
  if (!match) return null;
  return path.join(runtimeDir, `${match[1]}-runs`);
}

function parseArgs(argv) {
  const options = {
    pid: null,
    runDir: null,
    runtimeDir: null,
    exitCodeFile: null,
    stdoutFile: null,
    staleSeconds: 420,
    progressBudgetSeconds: 240,
    interval: 15,
    sinceMinutes: 0,
    once: false,
    dryRun: false,
    announceRunning: false,
    label: '浴缸竞品周采集',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') { options.once = true; continue; }
    if (a === '--dry-run') { options.dryRun = true; continue; }
    if (a === '--announce-running') { options.announceRunning = true; continue; }
    const next = argv[i + 1];
    if (a === '--pid') { options.pid = Number(next); i += 1; continue; }
    if (a === '--run-dir') { options.runDir = next; i += 1; continue; }
    if (a === '--runtime-dir') { options.runtimeDir = next; i += 1; continue; }
    if (a === '--exit-code-file') { options.exitCodeFile = next; i += 1; continue; }
    if (a === '--stdout-file') { options.stdoutFile = next; i += 1; continue; }
    if (a === '--stale-seconds') { options.staleSeconds = Number(next); i += 1; continue; }
    if (a === '--progress-budget-seconds') { options.progressBudgetSeconds = Number(next); i += 1; continue; }
    if (a === '--interval') { options.interval = Number(next); i += 1; continue; }
    if (a === '--since-minutes') { options.sinceMinutes = Number(next); i += 1; continue; }
    if (a === '--label') { options.label = next; i += 1; continue; }
    throw new Error(`Unknown argument: ${a}`);
  }
  // 运行目录二选一：直接给 --run-dir，或给 --runtime-dir + --stdout-file 让本脚本自己从日志里推。
  if (!options.runDir && !(options.runtimeDir && options.stdoutFile)) {
    throw new Error('--run-dir is required (or --runtime-dir together with --stdout-file)');
  }
  return options;
}

// 退出码由采集启动器在子进程 close 时写入；没写就是"不知道"，不是 0。
export function readExitCode(file) {
  if (!file || !existsSync(file)) return null;
  let raw = '';
  try { raw = readFileSync(file, 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  const code = Number(raw);
  return Number.isSafeInteger(code) ? code : null;
}

// 从采集子进程的 stdout 里取最后一条 ADAPTIVE_DONE（该标记只走 stdout，不进 events.jsonl）。
export function readTerminalMarker(file) {
  if (!file || !existsSync(file)) return null;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const matches = text.match(/\{"event":"ADAPTIVE_DONE"[^\n]*/gu);
  return matches?.length ? matches.at(-1) : null;
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// 找到最新的 events.jsonl（每次 attempt 一个子目录，结构是 <runId>-runs/attempt-*/<attemptId>/events.jsonl），
// 连同它的 mtime 与末行。sinceMs 用来把历史 run 目录排除在外——否则一个刚启动、还没写日志的
// 采集会被判成"上一次采集还在跑"。
export function readLatestEvent(runDir, sinceMs = 0) {
  if (!existsSync(runDir)) return { state: 'UNKNOWN', reason: `run dir missing: ${runDir}` };
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.name !== 'events.jsonl') continue;
      const mtimeMs = statSync(full).mtimeMs;
      if (sinceMs && mtimeMs < sinceMs) continue;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
    }
  };
  walk(runDir, 0);
  if (!newest) return { state: 'UNKNOWN', reason: `no events.jsonl under ${runDir} within the given window` };
  const lines = readFileSync(newest.file, 'utf8').split(/\r?\n/u).filter((l) => l.trim());
  if (!lines.length) return { state: 'UNKNOWN', reason: `empty events.jsonl: ${newest.file}` };
  let event = null;
  for (let i = lines.length - 1; i >= 0 && !event; i -= 1) {
    try { event = JSON.parse(lines[i]); } catch { /* 末行可能写到一半 */ }
  }
  if (!event) return { state: 'UNKNOWN', reason: `unparsable events.jsonl: ${newest.file}` };
  return { state: 'OK', file: newest.file, mtimeMs: newest.mtimeMs, lines: lines.length, event };
}

// 期望进度预算：末事件 → 允许静止的最长秒数。超过预算，**即使进程还活着**也判疑似卡死。
//
// 为什么需要它：采集器自己的边界是 --stall-seconds 300（只管"页请求不再推进"）和
// 各阶段超时；在它给出结论之前，外面没有任何人能说"这一步慢了"。监督环比它先说话，
// 才是"监管"而不是"事后收据"。各值取本机实测耗时 + 余量（实测：settle 2.3s、
// 两次配置之间约 30s、每页间隔约 31s、整段 1 页链路 84s）。
//
// 说明它管不到什么：事件密集重复的阶段（WAITING_FOR_DOWNLOAD 每 30s 一条）mtime 一直是新的，
// 光靠事件流看不出来。那类要靠文件侧证据（导出器现在会落 EXPORT_BASELINE_EMPTY）。
export const PHASE_BUDGETS = {
  START: 60,
  PROXY_READY: 60,
  HOME_READY: 180,
  SEARCH_READY: 90,
  PLUGIN_READY: 60,
  MARKET_ANALYSIS_OPEN: 45,
  CONFIGURED: 90,
  DIAGNOSTICS_INSTALLED: 90,
  COLLECTION_STARTED: 240,
  PROGRESS: 240,
  DIAGNOSTIC: 240,
  EXPORT_STARTED: 90,
  WAITING_FOR_DOWNLOAD: 300,
  DONE: 120,
  TARGETS_CLEANED: 120,
};

export function phaseBudget(eventName, fallbackSeconds) {
  const budget = PHASE_BUDGETS[String(eventName ?? '')];
  return Number.isFinite(budget) && budget > 0 ? budget : fallbackSeconds;
}

// 从 PROGRESS 事件里取一个"推进进度"的签名。采集活着但不推进时，签名不变——
// 这正是"页请求挂住"的样子，比单看文件 mtime 更贴近"活干到哪了"。
export function progressKey(event) {
  if (!event || event.event !== 'PROGRESS') return null;
  const page = Number(event.completedPage);
  const rows = Number(event.rows);
  const pageText = Number.isFinite(page) ? String(page) : '?';
  const rowText = Number.isFinite(rows) ? String(rows) : '?';
  if (pageText === '?' && rowText === '?') return null;
  return `${pageText}:${rowText}`;
}

// 纯函数：便于离线测试。
// exitCode === null 表示"没有退出码证据"。此时既不判 COMPLETED 也不判 FAILED —— 只写 UNKNOWN，
// 因为"读不到"和"失败"是两件事（历史教训：空值不是零）。
// progress 为 null 表示这次没有 PROGRESS 事件可跟（例如阶段早期），此时只用事件名预算。
// 单位约定：传进来的 silentMs / mtimeMs 一律是**毫秒**，对外展示才换算成秒。
export function classify({
  alive,
  exitCode = null,
  eventInfo,
  now,
  staleSeconds,
  progress = null,
  terminalMarker = null,
  expectTerminalMarker = false,
}) {
  if (eventInfo.state === 'UNKNOWN') return { status: 'UNKNOWN', detail: eventInfo.reason };
  const ageMs = now - eventInfo.mtimeMs;
  const event = eventInfo.event;
  const eventName = String(event?.event ?? '') || '?';
  if (alive) {
    const budgetSeconds = phaseBudget(eventName, staleSeconds);
    const silentSeconds = Math.round(ageMs / 1000);
    const progressSilentSeconds = progress && Number.isFinite(progress.silentMs)
      ? Math.round(progress.silentMs / 1000)
      : null;
    const progressBudget = progress && Number.isFinite(progress.budgetSeconds) ? progress.budgetSeconds : staleSeconds;
    if (silentSeconds > budgetSeconds) {
      return {
        status: 'SUSPECT_STALLED',
        detail: `进程还活着，但末事件 ${eventName} 已静止 ${silentSeconds}s（该阶段预算 ${budgetSeconds}s）`,
        event,
        budgetSeconds,
      };
    }
    if (progress && progress.key && progressSilentSeconds !== null && progressSilentSeconds > progressBudget) {
      return {
        status: 'SUSPECT_STALLED',
        detail: `进程还活着，但采集进度 ${progress.key} 已 ${progressSilentSeconds}s 没有推进（预算 ${progressBudget}s）`,
        event,
        budgetSeconds: progressBudget,
      };
    }
    return { status: 'RUNNING', detail: `末事件 ${eventName}`, event };
  }
  // 进程已退出。给了 --stdout-file 时，终端标记是**持久化证据**，比退出码文件更可靠：
  // 它由采集器自己写进文件，不依赖启动器还活着（2026-09-15 实测：会话回收把启动器和采集器
  // 一起带走，退出码文件根本没写成，于是只能判 UNKNOWN）。
  if (expectTerminalMarker) {
    if (terminalMarker) {
      if (exitCode !== null && exitCode !== 0) {
        return { status: 'FAILED', detail: `退出码 ${exitCode}，但 stdout 里出现了 ADAPTIVE_DONE —— 证据自相矛盾，按失败处理`, event };
      }
      return {
        status: 'COMPLETED',
        detail: `进程已退出 + ADAPTIVE_DONE${exitCode === null ? '（未记录退出码）' : ` + 退出码 ${exitCode}`}（末事件 ${eventName}）`,
        event,
      };
    }
    return {
      status: 'FAILED',
      detail: `进程已退出，但没有出现 ADAPTIVE_DONE 终端标记${exitCode === null ? '，也没有退出码证据' : `（退出码 ${exitCode}）`} —— 未正常结束，可能被杀（末事件 ${eventName}）`,
      event,
    };
  }
  if (exitCode === null) {
    return { status: 'UNKNOWN', detail: `进程已退出，但没有退出码证据（末事件 ${eventName}）—— 不假定它成功`, event };
  }
  if (exitCode !== 0) {
    return { status: 'FAILED', detail: `退出码 ${exitCode}（末事件 ${eventName}）`, event };
  }
  return { status: 'COMPLETED', detail: `退出码 0（末事件 ${eventName}）`, event };
}

function buildAlert({ status, detail, options, eventInfo }) {
  const severity = status === 'COMPLETED' || status === 'RUNNING' ? 'INFO' : 'ERROR';
  const titles = {
    RUNNING: '采集进行中',
    COMPLETED: '采集已完成',
    FAILED: '采集失败',
    SUSPECT_STALLED: '采集疑似卡死',
    UNKNOWN: '采集状态未知',
  };
  const actions = {
    COMPLETED: '无需处理，可继续后面的建表与导入步骤',
    FAILED: '查看收据与 stall.png，按失败原因处理后再重跑采集',
    SUSPECT_STALLED: '确认浏览器是否被遮挡或网络中断，必要时重跑（checkpoint 支持续采）',
    UNKNOWN: '人工确认运行目录与进程状态，不要假定它成功了',
    RUNNING: '',
  };
  return {
    severity,
    title: `${titles[status] ?? status}：${options.label}`,
    source: { targetLabel: options.label, capability: 'xws.export.market-analysis' },
    reason: detail,
    action: actions[status] ?? '',
    evidence: {
      status,
      runDir: options.runDir,
      lastEventFile: eventInfo.file ?? '',
      lastEvent: String(eventInfo.event?.event ?? ''),
      lastEventAt: String(eventInfo.event?.at ?? ''),
    },
    createdAt: new Date().toISOString(),
    alertId: `xws-collect-${status}-${Date.now()}`,
  };
}

function deliver(alert, dryRun) {
  const payload = JSON.stringify(alert);
  if (dryRun) {
    console.log('[supervise] DRY-RUN 告警:\n' + payload);
    return 0;
  }
  const result = spawnSync(process.execPath, [NOTIFY_CLI], {
    input: payload,
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const receipt = (result.stdout || '').trim();
  if (result.status !== 0) {
    console.error(`[supervise] 告警未送达（exit=${result.status}）：${receipt || result.stderr}`);
  } else {
    console.log(`[supervise] 告警已送达：${receipt.slice(0, 200)}`);
  }
  return result.status ?? 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let runDir = options.runDir || null;
  let stateFile = runDir ? path.join(runDir, '.supervision-state.json') : null;
  let lastStatus = stateFile && existsSync(stateFile)
    ? (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')).status ?? null; } catch { return null; } })()
    : null;
  // 首轮把 RUNNING 当基线：开机不是异常，默认不往飞书发消息（要发就 --announce-running）。
  if (lastStatus === null && !options.announceRunning) lastStatus = 'RUNNING';

  // 日志里出现 runId 才能定下运行目录；定下之前不播报（还没开跑不是异常）。
  const resolveRunDir = () => {
    if (runDir) return runDir;
    if (!options.runtimeDir || !options.stdoutFile) return null;
    let text = '';
    try { text = readFileSync(options.stdoutFile, 'utf8'); } catch { return null; }
    const found = discoverRunDir(text, options.runtimeDir);
    if (!found) return null;
    runDir = found;
    options.runDir = found;
    stateFile = path.join(runDir, '.supervision-state.json');
    if (existsSync(stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf8')).status ?? null;
        if (saved) lastStatus = saved;
      } catch { /* 状态文件坏了就沿用当前基线 */ }
    }
    console.log(`[supervise] 从日志里认领运行目录：${runDir}`);
    return runDir;
  };

  const report = (verdict, eventInfo) => {
    const status = verdict.status;
    const changed = status !== lastStatus;
    console.log(`[supervise] ${new Date().toISOString()} status=${status} ${changed ? '(变化)' : '(未变)'} :: ${verdict.detail}`);
    // 心跳**每一跳都写**，和「去重状态」是两个文件、两个用途，不许合并：
    //   .supervision-state.json     上一次**投递过**的状态（去重基线），只在变化时写；
    //   .supervision-heartbeat.json 监督环自己还活着、现在看到什么（存活信号），每跳都写。
    // 为什么必须分开：监管者自己死掉却没人发现，是监管体系最典型的失效方式。
    // 若把存活信号塞进去重文件，外部就只能看到"上次变化时它还在"，答不了"它现在还活着吗"。
    if (runDir) {
      try {
        writeFileSync(path.join(runDir, '.supervision-heartbeat.json'), JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          status,
          detail: verdict.detail,
          lastDelivered: lastStatus,
        }, null, 2));
      } catch { /* 心跳写不了不影响判定 */ }
    }
    if (changed) {
      const alert = buildAlert({ status, detail: verdict.detail, options, eventInfo });
      alert.evidence.exitCode = verdict.exitCode ?? null;
      alert.evidence.terminalMarker = verdict.terminalMarker ?? null;
      deliver(alert, options.dryRun);
      if (stateFile) {
        try { writeFileSync(stateFile, JSON.stringify({ status, at: new Date().toISOString(), detail: verdict.detail }, null, 2)); } catch { /* 状态文件写不了不影响判定 */ }
      }
      lastStatus = status;
    }
  };

  // 进度跟踪：PROGRESS 签名一变就重置计时，不变就一直累积。这是"进程活着但活没干"的判据。
  // 首轮把已经存在的 PROGRESS 当作起点（从此刻开始计时），避免接管时把历史静止算进来。
  let progressKeySeen = null;
  let progressChangedAt = Date.now();

  const tick = () => {
    const dir = resolveRunDir();
    if (!dir) {
      console.log(`[supervise] ${new Date().toISOString()} 还没从日志里看到 runId，等待中`);
      return 'UNKNOWN';
    }
    const alive = options.pid ? isProcessAlive(options.pid) : false;
    const sinceMs = options.sinceMinutes ? Date.now() - options.sinceMinutes * 60_000 : 0;
    const eventInfo = readLatestEvent(dir, sinceMs);
    const exitCode = readExitCode(options.exitCodeFile);
    const terminalMarker = readTerminalMarker(options.stdoutFile);
    const key = progressKey(eventInfo.event);
    if (key && key !== progressKeySeen) {
      progressKeySeen = key;
      progressChangedAt = Date.now();
    }
    const progress = progressKeySeen
      ? {
        key: progressKeySeen,
        silentMs: Date.now() - progressChangedAt,
        budgetSeconds: options.progressBudgetSeconds,
      }
      : null;
    const verdict = classify({
      alive,
      exitCode,
      eventInfo,
      now: Date.now(),
      staleSeconds: options.staleSeconds,
      progress,
      terminalMarker,
      expectTerminalMarker: Boolean(options.stdoutFile),
    });
    report({ ...verdict, exitCode, terminalMarker }, eventInfo);
    return verdict.status;
  };

  if (options.once) {
    const status = tick();
    return status === 'COMPLETED' || status === 'RUNNING' ? 0 : 1;
  }

  return await new Promise((resolve) => {
    const timer = setInterval(() => {
      const status = tick();
      if (status === 'COMPLETED' || status === 'FAILED') {
        clearInterval(timer);
        resolve(status === 'COMPLETED' ? 0 : 1);
      }
    }, options.interval * 1000);
    process.on('SIGINT', () => { clearInterval(timer); resolve(1); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error('[supervise] fatal:', error.message);
    process.exit(1);
  });
}
