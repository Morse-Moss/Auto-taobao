#!/usr/bin/env node
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const FAQ_OPERATOR = path.join(SCRIPT_DIR, 'run-faq-operator.mjs');
const XWS_SUPERVISOR = path.join(PROJECT_ROOT, 'skills', 'xws-export-market-analysis', 'scripts', 'supervise-adaptive-export.mjs');

const FAQ_SAFE_STAGES = new Set([
  'LOCK_TOP5',
  'BUILD_LOCAL_SNAPSHOT',
  'ANALYZE_LOCAL',
  'RUN_AI_REVIEW',
  'BUILD_LOCAL_SUMMARIES',
]);
const FAQ_HUMAN_STAGES = new Set([
  'COLLECT_EVIDENCE',
  'REVIEW_AI_HUMAN_QUEUE',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusFingerprint(status) {
  if (!status || typeof status !== 'object') return '';
  const keys = [
    'status', 'nextAction', 'manifestLocked', 'evidenceComplete',
    'localSnapshotBuilt', 'localAnalysisVerified', 'aiReviewComplete',
    'humanReviewComplete', 'localSummariesBuilt', 'summariesPublished',
    'completedProducts', 'top5Count',
  ];
  return JSON.stringify(keys.map((key) => status[key] ?? null));
}

function faqReport(status, step, extra = {}) {
  return {
    flow: 'faq',
    period: status?.period ?? null,
    status: status?.status ?? null,
    nextAction: status?.nextAction ?? null,
    top5Count: Number(status?.top5Count ?? 0),
    completedProducts: Number(status?.completedProducts ?? 0),
    rawRecords: Number(status?.rawRecords ?? 0),
    topicRecords: Number(status?.topicRecords ?? 0),
    operatorRecords: Number(status?.operatorRecords ?? 0),
    summariesPublished: status?.summariesPublished === true,
    decision: step.action,
    reason: step.reason ?? null,
    ...extra,
  };
}

export function decideFaqStep(status, { authorizePublish = false } = {}) {
  if (!status || typeof status.nextAction !== 'string') {
    return { action: 'FAIL', reason: 'FAQ status receipt is missing or unreadable' };
  }
  const nextAction = status.nextAction;
  if (nextAction === 'DONE') {
    return { action: 'DONE' };
  }
  if (FAQ_HUMAN_STAGES.has(nextAction)) {
    return {
      action: 'STOP_HUMAN',
      reason: nextAction === 'COLLECT_EVIDENCE'
        ? '浏览器采集需要按 xws-faq-operator Skill 执行，调度器不代做浏览器动作'
        : '人工核验队列未清零，队列清零前不会继续',
    };
  }
  if (nextAction === 'PUBLISH_FEISHU_SUMMARIES') {
    if (!authorizePublish) {
      return {
        action: 'STOP_AUTHORIZATION_REQUIRED',
        reason: '固定表发布需要运营明确授权；重跑时加 --authorize-publish 并提供 --master-table-id/--weekly-table-id/--operator-xlsx',
      };
    }
    return { action: 'ADVANCE' };
  }
  if (FAQ_SAFE_STAGES.has(nextAction)) {
    return { action: 'ADVANCE' };
  }
  return { action: 'FAIL', reason: `未知的 FAQ nextAction：${nextAction}` };
}

export function decideXwsStep(result) {
  if (!result || typeof result !== 'object' || typeof result.action !== 'string') {
    return { action: 'FAIL', reason: 'supervisor result is missing or unreadable' };
  }
  switch (result.action) {
    case 'COMPLETED':
      return { action: 'DONE' };
    case 'SKIPPED':
      if (result.status === 'DONE') return { action: 'DONE' };
      return { action: 'STOP_HUMAN', reason: `run 处于 ${result.status} 且当前状态不可恢复` };
    case 'STOPPED':
      if (result.retryExhausted) {
        return { action: 'STOP_RETRY_EXHAUSTED', reason: '重试预算耗尽，进入终态' };
      }
      if (result.status === 'HUMAN_REQUIRED') {
        return { action: 'STOP_HUMAN', reason: result.error || '浏览器需要人工介入' };
      }
      return { action: 'STOP_HUMAN', reason: `supervisor 停止于 ${result.status}` };
    case 'WAITING_FOR_BROWSER':
      return { action: 'WAIT_BROWSER', reason: result.reason || '等待浏览器采集进展' };
    case 'BUSY':
      return { action: 'WAIT_BUSY', reason: '同一采集合同已被占用' };
    case 'NOT_FOUND':
      return { action: 'FAIL', reason: `PostgreSQL run 不存在：${result.runId ?? ''}` };
    case 'SPAWNED':
      return { action: 'CONTINUE' };
    default:
      return { action: 'FAIL', reason: `未知的 supervisor action：${result.action}` };
  }
}

function xwsReport(result, step, extra = {}) {
  return {
    flow: 'xws',
    runId: result?.runId ?? null,
    supervisorAction: result?.action ?? null,
    status: result?.status ?? null,
    exitCode: Number.isInteger(result?.code) ? result.code : null,
    decision: step.action,
    reason: step.reason ?? null,
    ...extra,
  };
}

export function orchestratorEventStream(runtimeRoot, flow, key) {
  return path.resolve(runtimeRoot, 'orchestrator', `${flow}-${key.replace(/[^\w.-]+/gu, '_')}`, 'events.jsonl');
}

async function recordEvent(eventsPath, event) {
  await mkdir(path.dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

export async function spawnController(command, args, { cwd = PROJECT_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(text, label) {
  // Controllers may stream child output (progress lines) before their own
  // final JSON result, and --status prints pretty-printed multi-line JSON.
  // Scan every '{' from the end and return the first position whose slice
  // parses as a complete JSON value.
  const source = String(text || '');
  for (let index = source.lastIndexOf('{'); index >= 0; index = source.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // incomplete or trailing garbage after this brace; keep scanning back
    }
  }
  throw new Error(`${label} did not print a parseable JSON object`);
}

export async function orchestrateFaq({
  periodStart,
  periodEnd,
  runtimeRoot = 'runtime',
  authorizePublish = false,
  publishOptions = {},
  maxStages = 12,
  dryRun = false,
  spawn = spawnController,
  now = () => new Date().toISOString(),
}) {
  // 子进程必须收到**绝对**的 runtime root。
  // 它不只是「本调度器放 events 的地方」——FAQ 的全部收据（top5-manifest、各阶段收据、
  // operator-status.json）都以它为根。此前这里只把它用在自己的 events 流上，两次 spawn
  // 都没带 --runtime-root，于是 `--runtime-root /tmp/x` 看起来隔离了、实际子进程依旧在
  // 仓库的 runtime/ 里读写：调度器每轮轮询都会改写运营可见的 checkedAt，
  // 测试探一次真实周期就把生产收据真写一遍（2026-09-16 实录 §5）。
  // 绝对化还顺手挡掉另一类坑：相对路径会分别按「调度器的 cwd」与「子进程的 cwd」解析成两个地方。
  const runtimeRootAbs = path.resolve(runtimeRoot);
  const baseArgs = ['--period-start', periodStart, '--period-end', periodEnd, '--runtime-root', runtimeRootAbs];
  const eventsPath = orchestratorEventStream(runtimeRootAbs, 'faq', `${periodStart}_${periodEnd}`);
  let previousFingerprint = '';
  for (let stage = 1; stage <= maxStages; stage += 1) {
    // 状态探测是**只读**探测：带上 --no-persist，别让「看一眼」变成「改运营可见状态」。
    // 真正的推进仍然会写（下面的 --advance 不带这个开关），所以运营台看到的
    // checkedAt 含义是「运营侧最后一次真的检查/推进」，而不是「调度器第 N 次轮询」。
    // 每轮的决策都落在 events.jsonl 里，追溯不受影响。
    const inspected = await spawn(FAQ_OPERATOR, ['--status', ...baseArgs, '--no-persist']);
    if (inspected.code !== 0) {
      throw new Error(inspected.stderr || inspected.stdout || `FAQ status check failed with code ${inspected.code}`);
    }
    const status = parseJsonOutput(inspected.stdout, 'run-faq-operator --status');
    const step = decideFaqStep(status, { authorizePublish });
    await recordEvent(eventsPath, { stage, decision: step.action, nextAction: status.nextAction, reason: step.reason ?? null, at: now() });
    if (step.action !== 'ADVANCE') {
      return faqReport(status, step, { eventsPath, stages: stage - 1 });
    }
    const advanceArgs = ['--advance', ...baseArgs];
    if (authorizePublish && status.nextAction === 'PUBLISH_FEISHU_SUMMARIES') {
      advanceArgs.push(
        '--master-table-id', publishOptions.masterTableId,
        '--weekly-table-id', publishOptions.weeklyTableId,
        '--operator-xlsx', publishOptions.operatorXlsx,
      );
    }
    if (dryRun) {
      return faqReport(status, { action: 'DRY_RUN', reason: `将执行: ${FAQ_OPERATOR} ${advanceArgs.join(' ')}` }, { eventsPath, stages: stage - 1 });
    }
    const advanced = await spawn(FAQ_OPERATOR, advanceArgs);
    if (advanced.code !== 0) {
      const detail = advanced.stderr || advanced.stdout || `FAQ stage ${status.nextAction} failed with code ${advanced.code}`;
      await recordEvent(eventsPath, { stage, decision: 'STAGE_FAILED', reason: String(detail).slice(0, 500), at: now() });
      throw new Error(detail);
    }
    const advancedStatus = parseJsonOutput(advanced.stdout, `run-faq-operator --advance (${status.nextAction})`);
    const fingerprint = statusFingerprint(advancedStatus.status ?? advancedStatus);
    if (fingerprint && fingerprint === previousFingerprint) {
      const stuck = faqReport(status, { action: 'STOP_STUCK', reason: '连续两次推进后状态收据未变化，停止以免空转' }, { eventsPath, stages: stage });
      await recordEvent(eventsPath, { stage, decision: 'STOP_STUCK', at: now() });
      return stuck;
    }
    previousFingerprint = fingerprint;
  }
  return {
    ...faqReport(null, { action: 'STOP_BUDGET', reason: `已达单次调度阶段上限 ${maxStages}，重跑调度器继续` }),
    stages: maxStages,
    eventsPath,
  };
}

export async function orchestrateXws({
  runId,
  create = false,
  runnerArgs = [],
  checkpoint = '',
  proxy = '',
  runtimeRoot = 'runtime',
  maxCycles = 24,
  pollMs = 5000,
  waitBusy = true,
  dryRun = false,
  spawn = spawnController,
  sleep: wait = sleep,
  now = () => new Date().toISOString(),
}) {
  // 与 FAQ 流的区别：xws 的真相在 PostgreSQL（run 表）与 checkpoint 文件里，
  // `supervise-adaptive-export.mjs` 也没有 runtime-root 这个参数，所以这里的 runtimeRoot
  // **只决定 events 流写在哪**。这一点必须说清，否则又会变成「选项承诺了隔离但没隔离」。
  const eventsPath = orchestratorEventStream(path.resolve(runtimeRoot), 'xws', runId || 'new');
  let currentRunId = runId;
  let creating = create;
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const args = [];
    if (creating) args.push('--new', ...runnerArgs);
    else args.push('--run-id', currentRunId);
    if (checkpoint) args.push('--checkpoint', checkpoint);
    if (proxy) args.push('--proxy', proxy);
    if (dryRun) {
      return xwsReport({ runId: currentRunId, action: 'DRY_RUN' }, { action: 'DRY_RUN', reason: `将执行: ${XWS_SUPERVISOR} ${args.join(' ')}` }, { eventsPath, cycles: cycle - 1 });
    }
    const supervised = await spawn(XWS_SUPERVISOR, args);
    let result;
    try {
      result = parseJsonOutput(supervised.stdout, 'supervise-adaptive-export');
    } catch (stdoutError) {
      // Single-shot supervisors print their result JSON on stderr when the
      // child ended in a terminal state; try there before giving up.
      try {
        result = parseJsonOutput(supervised.stderr, 'supervise-adaptive-export (stderr)');
      } catch {
        throw new Error(`${stdoutError.message}; exit=${supervised.code}; stderr=${String(supervised.stderr).slice(0, 500)}`);
      }
    }
    if (result.runId) currentRunId = result.runId;
    creating = false;
    const step = decideXwsStep(result);
    await recordEvent(eventsPath, { cycle, decision: step.action, supervisorAction: result.action, status: result.status ?? null, reason: step.reason ?? null, at: now() });
    if (step.action === 'DONE' || step.action === 'FAIL' || step.action === 'STOP_HUMAN' || step.action === 'STOP_RETRY_EXHAUSTED') {
      return xwsReport(result, step, { eventsPath, cycles: cycle });
    }
    if (step.action === 'WAIT_BUSY' && !waitBusy) {
      return xwsReport(result, { action: 'STOP_BUSY', reason: '采集合同被占用，wait-busy 已关闭' }, { eventsPath, cycles: cycle });
    }
    await wait(step.action === 'CONTINUE' ? 0 : pollMs);
  }
  return {
    ...xwsReport({ runId: currentRunId, action: 'BUDGET' }, { action: 'STOP_BUDGET', reason: `已达单次调度循环上限 ${maxCycles}，重跑调度器继续` }),
    cycles: maxCycles,
    eventsPath,
  };
}

function parseArgs(argv) {
  const options = {
    flow: '',
    periodStart: '',
    periodEnd: '',
    runtimeRoot: 'runtime',
    authorizePublish: false,
    dryRun: false,
    maxStages: 12,
    maxCycles: 24,
    pollSeconds: 5,
    waitBusy: true,
    runId: '',
    create: false,
    checkpoint: '',
    proxy: '',
    masterTableId: '',
    weeklyTableId: '',
    operatorXlsx: '',
    runnerArgs: [],
  };
  const valued = new Set([
    '--flow', '--period-start', '--period-end', '--runtime-root', '--max-stages', '--max-cycles',
    '--poll-seconds', '--run-id', '--checkpoint', '--proxy', '--master-table-id', '--weekly-table-id', '--operator-xlsx',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--authorize-publish') options.authorizePublish = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-wait-busy') options.waitBusy = false;
    else if (arg === '--new') options.create = true;
    else if (valued.has(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else options.runnerArgs.push(arg);
  }
  if (options.help) return options;
  if (!['faq', 'xws'].includes(options.flow)) throw new Error('--flow must be faq or xws');
  if (options.flow === 'faq') {
    for (const name of ['periodStart', 'periodEnd']) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name === 'periodStart' ? 'period-start' : 'period-end'} must be YYYY-MM-DD (faq flow)`);
    }
    if (options.authorizePublish && !(options.masterTableId && options.weeklyTableId && options.operatorXlsx)) {
      throw new Error('--authorize-publish requires --master-table-id, --weekly-table-id and --operator-xlsx');
    }
  } else if (!options.create && !options.runId) {
    throw new Error('xws flow requires --run-id or --new with collection options');
  }
  options.maxStages = Math.max(1, Number(options.maxStages) || 12);
  options.maxCycles = Math.max(1, Number(options.maxCycles) || 24);
  options.pollSeconds = Math.max(1, Number(options.pollSeconds) || 5);
  return options;
}

function helpText() {
  return `Usage: node run-flow-orchestrator.mjs --flow faq|xws [options]

Deterministic stage scheduler. Reads a state receipt, advances exactly one stage,
re-reads the receipt, and repeats until a stop condition. It never performs
browser actions, never bypasses human gates, and never publishes without
explicit authorization.

FAQ flow:
  --flow faq --period-start YYYY-MM-DD --period-end YYYY-MM-DD
  [--authorize-publish --master-table-id ID --weekly-table-id ID --operator-xlsx FILE]
  [--max-stages N] [--runtime-root DIR]

XWS flow (delegates to supervise-adaptive-export.mjs):
  --flow xws (--run-id UUID | --new <collection options>)
  [--checkpoint FILE] [--proxy URL] [--max-cycles N] [--poll-seconds N] [--no-wait-busy]

Shared:
  --dry-run        Print the next command without executing it
  --runtime-root   FAQ flow: where the stage receipts live AND where the events stream
                   goes; it is forwarded (absolutely) to every child, so pointing it at a
                   temp dir really does isolate the run. XWS flow: the events stream only —
                   that flow's truth is the PostgreSQL run row plus the checkpoint file.
  --help           Show this text
`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const shared = {
    runtimeRoot: options.runtimeRoot,
    dryRun: options.dryRun,
  };
  let report;
  if (options.flow === 'faq') {
    report = await orchestrateFaq({
      ...shared,
      periodStart: options.periodStart,
      periodEnd: options.periodEnd,
      authorizePublish: options.authorizePublish,
      publishOptions: {
        masterTableId: options.masterTableId,
        weeklyTableId: options.weeklyTableId,
        operatorXlsx: options.operatorXlsx,
      },
      maxStages: options.maxStages,
    });
  } else {
    report = await orchestrateXws({
      ...shared,
      runId: options.runId,
      create: options.create,
      runnerArgs: options.runnerArgs,
      checkpoint: options.checkpoint,
      proxy: options.proxy,
      maxCycles: options.maxCycles,
      pollMs: options.pollSeconds * 1000,
      waitBusy: options.waitBusy,
    });
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
