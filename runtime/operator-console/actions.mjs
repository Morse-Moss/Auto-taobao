// 运营台动作层（2026-09-16 二期）。
//
// 一期服务端只收 GET。二期加了动作，所以这里必须把「什么能被点」写得比页面更严格：
// 页面只是触发器，判据一律在服务端 —— 前端能改，服务端不能被骗。
//
// 四条硬约束：
//   1) **动作白名单**：名字必须在 CONSOLE_ACTIONS 里，命令由服务端从固定表拼出来。
//      请求里的参数只允许是周期（受正则约束），永远不拼 shell、永远不用 shell:true。
//   2) **能不能推 = 调度器说了算**：复用 run-flow-orchestrator 的 decideFaqStep，
//      不在控制台里抄第二份「哪些阶段安全」的名单（第二份名单就是第二份真相）。
//      后果：浏览器采集、人工核验、飞书发布一律拒；发布只能走命令行显式授权。
//   3) **一次一个**：动作会改收据，两个并发推进会互相抢同一个目录，所以全局串行。
//   4) **每个动作留流水**：写 <runtimeRoot>/operator-console/actions.jsonl。
//      动作有副作用却没有收据，是这个项目最不能接受的一种失败。

import { appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideFaqStep } from '../run-flow-orchestrator.mjs';

const FAQ_OPERATOR = 'runtime/run-faq-operator.mjs';
const ORCHESTRATOR = 'runtime/run-flow-orchestrator.mjs';

// **代码根与数据根是两件事，必须分开**：
//   - 代码根 = 这个模块自己所在的仓库（脚本路径、cwd 都用它）。要跑的一定是「这套代码」，
//     不该被调用方注入；验收脚本为了隔离会把数据根换成临时目录，换掉代码根就找不到脚本了。
//   - 数据根 = runtimeRoot，可注入（只有它是隔离旋钮）。
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 输出上限：阶段脚本会打进度日志，不设上限就是给自己埋一个 OOM（同类坑 28）。
const OUTPUT_CAP = 256 * 1024;

// 超时不杀子进程。理由：阶段推进是「跑到一半会写收据」的，中途 kill 比晚一点更糟；
// 超时只意味着「我不再等它的输出」，不是「它没在做事」——所以报文必须这么说清。
export const CONSOLE_ACTIONS = Object.freeze({
  'preview-faq': {
    label: '预览这次会做什么',
    needsPeriod: true,
    mutating: false,
    timeoutMs: 120_000,
    describe: (params) => `只读干跑：${ORCHESTRATOR} --flow faq --dry-run --period-start ${params.periodStart} --period-end ${params.periodEnd} --runtime-root <本控制台的 runtimeRoot>`,
  },
  'refresh-faq-status': {
    label: '重新检查（重跑状态检查）',
    needsPeriod: true,
    mutating: true,
    timeoutMs: 180_000,
    describe: (params) => `重跑状态检查并落收据：${FAQ_OPERATOR} --status --period-start ${params.periodStart} --period-end ${params.periodEnd} --runtime-root <本控制台的 runtimeRoot>`,
  },
  'advance-faq': {
    label: '推进一个阶段',
    needsPeriod: true,
    mutating: true,
    requiresConfirm: true,
    timeoutMs: 600_000,
    describe: (params) => `推进一格：${FAQ_OPERATOR} --advance --period-start ${params.periodStart} --period-end ${params.periodEnd} --runtime-root <本控制台的 runtimeRoot>`,
  },
});

export function periodArgsOf(params = {}) {
  const periodStart = String(params.periodStart ?? '');
  const periodEnd = String(params.periodEnd ?? '');
  const ok = /^\d{4}-\d{2}-\d{2}$/u.test(periodStart) && /^\d{4}-\d{2}-\d{2}$/u.test(periodEnd);
  return { ok, periodStart, periodEnd };
}

export function auditLogPath(runtimeRoot) {
  return join(runtimeRoot, 'operator-console', 'actions.jsonl');
}

function clip(text) {
  const source = String(text ?? '');
  return source.length > OUTPUT_CAP
    ? `${source.slice(0, OUTPUT_CAP)}\n...[截断，原长 ${source.length} 字节]`
    : source;
}

// 运行子进程并带回执。不 kill（见文件头说明），只停止等待。
export function runChild(script, args, { cwd = CODE_ROOT, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!settled) {
        settled = true;
        // detached 让子进程不随父进程退出被杀；它已经开工，就该让它把这一格做完。
        child.unref();
        resolve({ code: null, stdout: clip(stdout), stderr: clip(stderr), timedOut: true, durationMs: Date.now() - startedAt });
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < OUTPUT_CAP) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < OUTPUT_CAP) stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout: clip(stdout), stderr: clip(`${stderr}\n${error.message}`), timedOut, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout: clip(stdout), stderr: clip(stderr), timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

function parseLastJson(text) {
  const source = String(text ?? '');
  for (let index = source.lastIndexOf('{'); index >= 0; index = source.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // 继续往前找
    }
  }
  return null;
}

let busy = null;

export function currentAction() {
  return busy;
}

export async function appendAudit(runtimeRoot, entry) {
  const target = auditLogPath(runtimeRoot);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return target;
}

// 为什么 advance 要先探一次：判据必须来自真实收据，而不是请求里说的「我现在在第几步」。
// 探针带 --no-persist —— 见 run-faq-operator 的注释：只读探测不许改运营可见状态。
async function inspectBeforeAdvance(period, { runtimeRoot }) {
  const result = await runChild(
    FAQ_OPERATOR,
    ['--status', '--period-start', period.periodStart, '--period-end', period.periodEnd, '--runtime-root', runtimeRoot, '--no-persist'],
    { timeoutMs: 120_000 },
  );
  const status = parseLastJson(result.stdout);
  if (!status) {
    return { ok: false, result, status: null };
  }
  return { ok: true, result, status };
}

export async function planAdvance(period, context) {
  const inspected = await inspectBeforeAdvance(period, context);
  if (!inspected.ok) {
    return {
      statusCode: 502,
      payload: {
        error: 'STATUS_PROBE_FAILED',
        message: '推进前必须先读一次真实状态；这次读不出来，所以不推进（拿不到结论就不放行）。',
        exitCode: inspected.result.code,
        stderr: inspected.result.stderr.slice(-2000),
      },
    };
  }
  const step = decideFaqStep(inspected.status, { authorizePublish: false });
  const base = {
    action: 'advance-faq',
    period: `${period.periodStart}_${period.periodEnd}`,
    nextAction: inspected.status.nextAction ?? null,
    status: inspected.status.status ?? null,
    decision: step.action,
  };
  if (step.action !== 'ADVANCE') {
    const refusal = {
      DONE: { code: 'ALREADY_DONE', message: '这个周期已经完成，没有可推进的阶段。' },
      STOP_HUMAN: { code: 'HUMAN_STAGE', message: `这一步需要人来：${step.reason}` },
      STOP_AUTHORIZATION_REQUIRED: {
        code: 'EXTERNAL_WRITE_NEEDS_AUTHORIZATION',
        message: '这一步会写飞书。运营台不带发布授权，也不代发；请在命令行用 --authorize-publish 显式授权后再发。',
      },
      FAIL: { code: 'UNSUPPORTED_STAGE', message: `调度器判不出这一步该怎么走：${step.reason}` },
    }[step.action] ?? { code: 'NOT_ADVANCEABLE', message: `调度器给出的决定是 ${step.action}。` };
    return { statusCode: 409, payload: { ...base, error: refusal.code, message: refusal.message, reason: step.reason ?? null } };
  }
  return { statusCode: 200, payload: { ...base, plan: true } };
}

export async function runAction({ name, params = {}, runtimeRoot }) {
  const spec = CONSOLE_ACTIONS[name];
  if (!spec) {
    return {
      statusCode: 404,
      payload: { error: 'UNKNOWN_ACTION', message: `没有这个动作：${name}`, available: Object.keys(CONSOLE_ACTIONS) },
    };
  }
  const period = periodArgsOf(params);
  if (spec.needsPeriod && !period.ok) {
    return {
      statusCode: 400,
      payload: { error: 'BAD_PERIOD', message: '周期参数必须是两个 YYYY-MM-DD（periodStart / periodEnd）。', received: { periodStart: params.periodStart ?? null, periodEnd: params.periodEnd ?? null } },
    };
  }
  if (busy) {
    return {
      statusCode: 409,
      payload: { error: 'ACTION_BUSY', message: `已经有一个动作在跑：${busy.name}（开始于 ${busy.startedAt}）。动作会改收据，不能并发。`, running: busy },
    };
  }

  // 需要确认的动作：先只判断「能不能推」并把将要执行的命令原文交回去，不执行任何东西。
  if (spec.requiresConfirm && params.confirm !== true) {
    const planned = await planAdvance(period, { runtimeRoot });
    if (planned.statusCode !== 200) return planned;
    return {
      statusCode: 400,
      payload: {
        error: 'CONFIRM_REQUIRED',
        message: '这个动作会真的推进一格，需要显式确认。下面是把要执行的东西原文给你看。',
        ...planned.payload,
        willRun: spec.describe(period),
      },
    };
  }

  busy = { name, startedAt: new Date().toISOString() };
  const startedAt = Date.now();
  let payload;
  let statusCode;
  let result;
  try {
    if (name === 'advance-faq') {
      // 确认之后**再判一次**：从「给出预览」到「人来点确认」之间收据可能已经变了。
      const planned = await planAdvance(period, { runtimeRoot });
      if (planned.statusCode !== 200) return planned;
      result = await runChild(
        FAQ_OPERATOR,
        ['--advance', '--period-start', period.periodStart, '--period-end', period.periodEnd, '--runtime-root', runtimeRoot],
        { timeoutMs: spec.timeoutMs },
      );
      const advanced = parseLastJson(result.stdout);
      statusCode = result.timedOut || result.code !== 0 ? 502 : 200;
      payload = {
        action: name,
        period: `${period.periodStart}_${period.periodEnd}`,
        advancedStage: advanced?.advancedStage ?? advanced?.status?.nextAction ?? null,
        nextAction: advanced?.status?.nextAction ?? null,
        status: advanced?.status?.status ?? null,
        exitCode: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stderr: result.stderr.slice(-2000),
      };
    } else if (name === 'refresh-faq-status') {
      result = await runChild(
        FAQ_OPERATOR,
        ['--status', '--period-start', period.periodStart, '--period-end', period.periodEnd, '--runtime-root', runtimeRoot],
        { timeoutMs: spec.timeoutMs },
      );
      const status = parseLastJson(result.stdout);
      statusCode = result.timedOut || result.code !== 0 ? 502 : 200;
      payload = {
        action: name,
        period: `${period.periodStart}_${period.periodEnd}`,
        status: status?.status ?? null,
        nextAction: status?.nextAction ?? null,
        checkedAt: status?.checkedAt ?? new Date().toISOString(),
        exitCode: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stderr: result.stderr.slice(-2000),
      };
    } else {
      result = await runChild(
        ORCHESTRATOR,
        ['--flow', 'faq', '--period-start', period.periodStart, '--period-end', period.periodEnd, '--dry-run', '--runtime-root', runtimeRoot],
        { timeoutMs: spec.timeoutMs },
      );
      const report = parseLastJson(result.stdout);
      statusCode = result.timedOut || result.code !== 0 ? 502 : 200;
      payload = {
        action: name,
        period: `${period.periodStart}_${period.periodEnd}`,
        decision: report?.decision ?? null,
        reason: report?.reason ?? null,
        nextAction: report?.nextAction ?? null,
        stages: report?.stages ?? null,
        exitCode: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        willRun: spec.describe(period),
        stderr: result.stderr.slice(-2000),
      };
    }
  } finally {
    busy = null;
  }

  const entry = {
    at: new Date().toISOString(),
    action: name,
    mutating: spec.mutating,
    params: { periodStart: period.periodStart, periodEnd: period.periodEnd, confirm: params.confirm === true },
    runtimeRoot,
    statusCode,
    durationMs: Date.now() - startedAt,
    outcome: payload?.nextAction ?? payload?.decision ?? null,
    exitCode: payload?.exitCode ?? null,
  };
  try {
    const auditPath = await appendAudit(runtimeRoot, entry);
    payload.auditPath = auditPath;
  } catch (error) {
    // 收据写不下去要说出来，但不能把已经发生的事回报成失败 —— 动作**已经执行了**。
    payload.auditError = String(error?.message ?? error);
    payload.message = `${payload.message ?? ''} 注意：动作已执行，但审计流水写失败（${payload.auditError}）。`.trim();
  }
  return { statusCode, payload };
}
