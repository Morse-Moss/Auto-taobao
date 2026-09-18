// 一轮运行的生命周期（无人值守运行内核的主干，见 docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md §2）。
//
//   ① 体检 → ② 探队列 → ③ 两段式执行 → ④ 收尾判定 → ⑤ 自愈 → ⑥ 通知（唯一出口）
//
// 这个模块只做编排与判定，**不自己发消息、不自己跑采集、不自己修故障**：
// 每一步都是一个注入的端口。理由与调度器/投递层同源——编排是唯一拥有「这一轮发生了什么」的地方，
// 它必须能在没有网络、没有浏览器、没有数据库的情况下被完整测一遍（包括「该安静的时候安静」
// 和「该响的时候响」这两个相反的方向）。真实实现只在 CLI 里接线。
//
// 与既有底座的关系（不重复造）：
//   - 探队列 + 执行：复用 capability-scheduler.runScheduled（五出口收据原样带进本轮收据）。
//   - 自愈：复用 supervisor-agent 的 diagnose + actions（第 3 步接真实执行器），此处只留端口。
//   - 通知：复用 notify-feishu（三跳投递链），此处只留端口。
//   - 「这轮跑过没有」：由业务幂等键回答，不靠本地文件记忆（§3）。
//
// 两条容易做错、这里刻意写成代码的规则：
//   1. **静默是显式声明**：判定走 round-notify-policy，表里查不到的理由一律按「通知」处理。
//   2. **体检没给出结论时照常发起**（与探测同方向的 fail-open：多做一次本来会失败的运行，
//      好过少做一次本来该做的活），但收据里 health.status 必须写 UNKNOWN，**不许写 OK**。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 体检层的真实实现（`runtime/` 顶层）。**只有本文件（编排层的 CLI 装配处）import 它**：
// 编排内核 `runRound` 拿到的只是注入的函数，所以它仍然可以在没有浏览器、没有网络的机器上被完整测一遍。
import { createPlatformHealthCheck } from '../xws-platform-health-preflight.mjs';
// 「这条能力走哪个浏览器」取自登记表，不另写一份：能力自身的技能目录 -> ROUTES[].skills -> browser。
import { BROWSER_PROFILES, ROUTES } from '../browser-ports.mjs';
import { createRuntimeContext } from './runtime-bootstrap.mjs';
import { runScheduled } from './capability-scheduler.mjs';
import { parseCliArgs } from './two-stage-runner.mjs';
import {
  HEALTH_CHECK_KEYS,
  evaluateSchedule,
  findRound,
  parseScheduleJson,
  planSchedule,
  serveRounds,
} from './round-schedule.mjs';
import {
  ROUND_NOTIFY_RULES,
  NO_AUTO_RETRY_REASONS,
  decideNotification,
  buildRoundAlert,
  buildResolvedAlert,
  resolveNotifyRule,
} from './round-notify-policy.mjs';

export const ROUND_CONTRACT_VERSION = 'agent-round-v1';
export const ROUND_STATE_VERSION = 'agent-round-state-v1';

export const ROUND_STEPS = Object.freeze(['DUE', 'HEALTH', 'PROBE', 'EXECUTE', 'HEAL', 'NOTIFY']);

export const ROUND_OUTCOMES = Object.freeze([
  'SKIPPED_NOT_DUE',       // 还没到该跑的时间
  'SKIPPED_ALREADY_DONE',  // 同一业务幂等键已完成（或今天已按失败收尾）
  'SKIPPED_EMPTY_QUEUE',   // 队列确认为空：正常运营状态，不是失败
  'PAUSED_FOR_HUMAN',      // 队列里有等人工处理的行（等上游结算）
  'BLOCKED_BY_HEALTH',     // 体检未通过：直接结束本轮，不浪费一次采集
  'COMPLETED',             // 全部成功
  'COMPLETED_WITH_HEAL',   // 失败但自愈成功
  'FAILED',                // 失败且需要人（或次数用尽）
  'ERROR',                 // 编排自身出错（不是业务失败）
]);

// 收据字段清单：所有出口共用同一组键，由同一个工厂产出——不靠人工记得补齐。
export const ROUND_RECEIPT_FIELDS = Object.freeze([
  'contractVersion',
  'businessKey',
  'outcome',
  'ok',
  'humanRequired',
  'reasons',
  'startedAt',
  'finishedAt',
  'dayKey',
  'due',
  'health',
  'schedule',
  'run',
  'heal',
  'notification',
  'state',
  'steps',
]);

export const DEFAULT_MAX_ATTEMPTS_PER_DAY = 3;

// 一轮运行允许出现的调度出口。**不含 PROBED_ONLY**：只探测是排产工具的行为，不是一轮运行的行为。
export const SCHEDULER_OUTCOMES_WITHIN_ROUND = Object.freeze([
  'RAN', 'PROCEEDED_WITHOUT_PROBE', 'SKIPPED_EMPTY_QUEUE', 'PAUSED_FOR_HUMAN',
]);

// 「自动重试有没有意义」这个轴与「要不要通知」是**两件事**：
// 登录失效要通知人，但人登录完之后重试恰恰是最该做的事；而配置错、疑似缺陷、写入结果未知
// 这三类，15 分钟后再跑一遍不会有任何新结果（写入未知那一类还明确禁止静默重试）。
// 判定表里逐条声明 retryAutomatically，这里只做派生，不另立一份清单。
export const AUTO_RETRY_REASONS = Object.freeze(
  ROUND_NOTIFY_RULES.filter((rule) => rule.retryAutomatically === true).map((rule) => rule.key),
);

export class RoundError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'RoundError';
    this.code = code;
    this.details = details;
  }
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());
const messageOf = (error) => asText(error?.message ?? error) || String(error);

// 本机日期（**不是** UTC）：定时的语义是「本机时间几点」，用 UTC 会让跨零点的那几轮落到错误的日期。
export function localDayKey(value = Date.now()) {
  const at = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function emptyState() {
  return {
    version: ROUND_STATE_VERSION,
    completed: {},
    days: {},
    openAlert: null,
  };
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: ROUND_STATE_VERSION,
    completed: state.completed && typeof state.completed === 'object' ? { ...state.completed } : {},
    days: state.days && typeof state.days === 'object' ? { ...state.days } : {},
    // 空值不是零：没有告警就是 null，不许写成 {} 让人误以为「有一条空的告警」。
    openAlert: state.openAlert && typeof state.openAlert === 'object' ? { ...state.openAlert } : null,
  };
}

export function createMemoryRoundState(seed = null) {
  let current = normalizeState(seed);
  const writes = [];
  return {
    writes,
    async load() {
      return normalizeState(current);
    },
    async save(next) {
      current = normalizeState(next);
      writes.push(JSON.parse(JSON.stringify(current)));
    },
    peek() {
      return normalizeState(current);
    },
  };
}

// 文件版状态：给 CLI 用。只放很小的东西（幂等键、当日次数、还没收掉的那条告警）。
export function createFileRoundState(file) {
  const path = resolve(file);
  return {
    async load() {
      if (!existsSync(path)) return emptyState();
      try {
        return normalizeState(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        // 状态文件坏了：**不静默当成空**——那会让「今天已经跑过」的记忆消失，
        // 于是同一轮重复写一次。宁可让它带着一份坏文件继续（记录在收据里由调用方决定）。
        throw new RoundError(`round state file is not readable JSON: ${path}`, 'ROUND_STATE_INVALID', { path });
      }
    },
    async save(next) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(normalizeState(next), null, 2)}\n`, 'utf8');
    },
  };
}

function receiptOf({ businessKey, outcome, overrides = {} }) {
  const base = {
    contractVersion: ROUND_CONTRACT_VERSION,
    businessKey,
    outcome,
    ok: true,
    humanRequired: false,
    reasons: [],
    startedAt: null,
    finishedAt: null,
    dayKey: null,
    due: null,
    health: null,
    schedule: null,
    run: null,
    heal: null,
    notification: {
      status: 'NOT_ATTEMPTED',
      action: null,
      key: null,
      unmapped: false,
      alertId: null,
      previousAlertId: null,
      channel: null,
      error: null,
    },
    state: { attemptsToday: null, maxAttemptsPerDay: null, closed: false, closedReason: null, completed: false },
    steps: [],
  };
  const merged = { ...base, ...overrides };
  const missing = ROUND_RECEIPT_FIELDS.filter((key) => !Object.hasOwn(merged, key));
  if (missing.length) throw new RoundError(`round receipt is missing ${missing.join(', ')}`, 'RECEIPT_INCOMPLETE', { missing, outcome });
  return merged;
}

// 失败理由 -> 升级理由。**不能**直接把失败分类拿去当理由：
// TRANSIENT_EXTERNAL / RESOURCE_BUSY 这类是刻意静默的（「自愈处理掉了」才是它们的正常收尾），
// 一旦未处理就照原样上报，就会把一次真实失败静默吞掉。所以未处理的一律升级。
export function escalationReasonFor(failureClass) {
  const key = asText(failureClass);
  if (!key) return 'ESCALATED_HUMAN';
  const rule = resolveNotifyRule(key);
  if (rule && rule.plan === 'NOTIFY') return rule.key;
  return 'ESCALATED_HUMAN';
}

function normalizeFinding(finding) {
  const layer = asText(finding?.layer).toUpperCase() || 'UNKNOWN';
  const requestedReason = asText(finding?.reason);
  const rule = resolveNotifyRule(requestedReason);
  return {
    layer,
    code: asText(finding?.code) || null,
    state: asText(finding?.state) || null,
    // 体检发现里写的 reason 必须是判定表里的键；不是的话退回 HEALTH_BLOCKED 并把原值留在 code/state 里。
    reason: rule ? rule.key : 'HEALTH_BLOCKED',
    requestedReason: rule ? null : (requestedReason || null),
    detail: asText(finding?.detail ?? finding?.message) || null,
    blocking: finding?.blocking !== false,
  };
}

function normalizeHealthResult(raw) {
  if (raw === null || raw === undefined) {
    // 体检层还没接线（第 4 步）：**不许**写成 OK，只许写成 NOT_IMPLEMENTED。
    return {
      status: 'NOT_IMPLEMENTED',
      ok: null,
      findings: [],
      layers: null,
      note: '体检层尚未接线（实施计划第 4 步）：本轮没有做登录态/环境/会话检查。',
    };
  }
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).map(normalizeFinding);
  const blocking = findings.filter((finding) => finding.blocking);
  return {
    status: raw.ok === false ? 'FAILED' : 'OK',
    ok: raw.ok !== false,
    findings,
    blocking,
    // 体检自己写的那句话必须原样带进收据。它里面点着「哪些层**没有**检查过」（第 4 步落地时是
    // L0/L2/L3 三层）。丢掉它，收据就只剩一个「通过」，而「没做过的检查」会被读成「检查没问题」
    // ——正是 LOGIN-STATE-MANAGEMENT.md §7 禁止的假绿。调用方没给仍是 null（默认行为逐字不变）。
    note: asText(raw?.note) || null,
    // 逐层状态一并带过来：这是**结构化**的缺口，比一句话更难被忽略（页面/看板可以据此标灰）。
    layers: raw?.layers && typeof raw.layers === 'object' ? { ...raw.layers } : null,
  };
}

async function safeHealthCheck(healthCheck, args) {
  if (typeof healthCheck !== 'function') return normalizeHealthResult(null);
  try {
    return normalizeHealthResult(await healthCheck(args));
  } catch (error) {
    // 体检自己崩了 = 没拿到结论。方向与探测的 fail-open 一致：照常发起（多做一次本来会失败的
    // 运行，好过少做一次本来该做的活），但状态只能写 UNKNOWN——不许假装体检过了。
    return {
      status: 'UNKNOWN',
      ok: null,
      findings: [],
      layers: null,
      error: messageOf(error).slice(0, 300),
      note: '体检本身出错，未拿到结论；本轮照常发起，但没有做登录态检查。',
    };
  }
}

// 一轮运行。端口全部可注入；返回值就是收据（字段见 ROUND_RECEIPT_FIELDS）。
export async function runRound(options = {}) {
  const {
    businessKey,
    capabilityId = null,
    source = {},
    due = null,
    healthCheck = null,
    schedule,
    heal = null,
    notify = null,
    state,
    now = () => Date.now(),
    maxAttemptsPerDay = DEFAULT_MAX_ATTEMPTS_PER_DAY,
    force = false,
  } = options;

  if (!asText(businessKey)) throw new RoundError('businessKey is required', 'ROUND_INPUT_REQUIRED');
  if (typeof schedule !== 'function') throw new RoundError('schedule port is required', 'ROUND_INPUT_REQUIRED');
  if (!state || typeof state.load !== 'function' || typeof state.save !== 'function') {
    throw new RoundError('state port with load()/save() is required', 'ROUND_INPUT_REQUIRED');
  }

  const nowMs = Number(now());
  const startedAt = new Date(nowMs).toISOString();
  const dayKey = localDayKey(nowMs);
  const key = asText(businessKey);
  const steps = [];
  const record = (step, status, detail = null) => steps.push({ step, status, ...(detail ? { detail } : {}) });

  const current = await state.load();
  const day = current.days[dayKey] ?? { attempts: 0, closed: false, closedReason: null, lastOutcome: null, lastAt: null };
  const attemptsToday = Number.isSafeInteger(day.attempts) && day.attempts >= 0 ? day.attempts : 0;

  const finish = async ({ outcome, reason, overrides = {}, statePatch = null }) => {
    const decision = decideNotification({ reason, openAlert: current.openAlert });
    const notification = {
      status: 'NOT_ATTEMPTED',
      action: decision.action,
      key: decision.key ?? null,
      unmapped: decision.unmapped === true,
      alertId: null,
      previousAlertId: current.openAlert?.alertId ?? null,
      error: null,
    };

    let nextOpenAlert = current.openAlert ?? null;
    if (decision.action === 'NONE') {
      notification.status = 'SILENT';
    } else if (decision.action === 'DEDUPED') {
      notification.status = 'DEDUPED';
      notification.alertId = current.openAlert?.alertId ?? null;
    } else {
      const alert = decision.action === 'RESOLVE'
        ? buildResolvedAlert({ openAlert: current.openAlert, now: nowMs, source })
        : buildRoundAlert({
          reason: decision.key,
          businessKey: key,
          now: nowMs,
          source,
          detail: overrides.detail ?? null,
          nextAction: overrides.nextAction ?? null,
        });
      notification.alertId = alert.alertId;
      if (typeof notify !== 'function') {
        // 没配通知出口也要留痕：否则「没发出去」看起来与「不必要发」一模一样。
        notification.status = 'NOT_CONFIGURED';
      } else {
        try {
          const delivery = await notify({ alert, decision, businessKey: key, outcome });
          notification.status = asText(delivery?.status) || 'SENT';
          notification.channel = delivery?.channel ?? null;
          // 通知发送失败不能影响主流程，但必须如实记下来（含错误原文）。
          if (notification.status !== 'SENT') notification.error = asText(delivery?.error) || null;
        } catch (error) {
          notification.status = 'FAILED';
          notification.error = messageOf(error).slice(0, 300);
        }
      }
      // 只有真的送出去了才改「还没收掉的那条」——否则下一次会误判成已通知过而静默。
      if (notification.status === 'SENT') {
        nextOpenAlert = decision.action === 'RESOLVE'
          ? null
          : { reason: decision.key, alertId: alert.alertId, title: alert.title, at: startedAt, businessKey: key };
      }
    }

    // 状态落盘：失败时的当日记账由调用方通过 statePatch 传入（它知道该不该记账）。
    const mergedDay = { ...day, lastOutcome: outcome, lastAt: startedAt, ...(statePatch?.day ?? {}) };
    const nextState = normalizeState({
      ...current,
      completed: statePatch?.completed ? { ...current.completed, [key]: startedAt } : current.completed,
      days: { ...current.days, [dayKey]: mergedDay },
      openAlert: nextOpenAlert,
    });
    await state.save(nextState);

    // 收据里的 state 一律从**真正落盘的那一份**读回来，不接受调用方另填一份：
    // 两处各填一次，迟早会出现「收据说写了、文件里没有」。
    const receiptState = {
      attemptsToday: Number.isSafeInteger(mergedDay.attempts) ? mergedDay.attempts : null,
      maxAttemptsPerDay,
      closed: mergedDay.closed === true,
      closedReason: mergedDay.closedReason ?? null,
      completed: Boolean(nextState.completed[key]),
    };

    return receiptOf({
      businessKey: key,
      outcome,
      overrides: {
        startedAt,
        finishedAt: new Date(Number(now())).toISOString(),
        dayKey,
        reasons: decision.key ? [decision.key] : [],
        humanRequired: decision.action === 'SEND' || decision.action === 'DEDUPED' ? decision.plan === 'NOTIFY' : false,
        ok: !['FAILED', 'ERROR', 'PAUSED_FOR_HUMAN', 'BLOCKED_BY_HEALTH'].includes(outcome),
        notification,
        state: receiptState,
        steps,
        ...overrides,
      },
    });
  };

  const attemptsPatch = (increment) => ({
    attempts: attemptsToday + (increment ? 1 : 0),
    ...(increment && attemptsToday + 1 >= maxAttemptsPerDay
      ? { closed: true, closedReason: 'ATTEMPTS_EXHAUSTED' }
      : {}),
  });

  // ── ① 是否该跑 ────────────────────────────────────────────────────────────
  if (!force && current.completed[key]) {
    record('DUE', 'SKIP', `already completed at ${current.completed[key]}`);
    return finish({
      outcome: 'SKIPPED_ALREADY_DONE',
      reason: 'ALREADY_DONE',
      overrides: {
        due: { evaluated: true, due: false, source: 'COMPLETED_KEY' },
      },
    });
  }
  if (!force && day.closed === true) {
    record('DUE', 'SKIP', `today already closed: ${day.closedReason ?? 'unknown'}`);
    return finish({
      outcome: 'SKIPPED_ALREADY_DONE',
      reason: 'ALREADY_DONE',
      overrides: {
        due: { evaluated: true, due: false, source: 'DAY_CLOSED' },
      },
    });
  }
  let dueResult = { evaluated: false, due: true, source: 'EXTERNAL_TIMER' };
  if (typeof due === 'function') {
    const raw = await due({ businessKey: key, now: nowMs, capabilityId });
    if (raw === false) dueResult = { evaluated: true, due: false, source: 'DUE_PORT' };
    else if (raw && typeof raw === 'object') dueResult = { evaluated: true, due: raw.due !== false, source: asText(raw.source) || 'DUE_PORT' };
    else dueResult = { evaluated: true, due: true, source: 'DUE_PORT' };
  }
  record('DUE', dueResult.due ? 'PASS' : 'SKIP', dueResult.evaluated ? `due=${dueResult.due} (${dueResult.source})` : 'no due port; the external timer owns the cadence');
  if (!dueResult.due) {
    return finish({
      outcome: 'SKIPPED_NOT_DUE',
      reason: 'NOT_DUE',
      overrides: {
        due: dueResult,
      },
    });
  }

  // ── ② 体检（放在最前面：省下一次注定失败的采集，也让通知更具体）────────────
  const health = await safeHealthCheck(healthCheck, { businessKey: key, now: nowMs, dayKey });
  record('HEALTH', health.status === 'OK' ? 'PASS' : (health.status === 'FAILED' ? 'FAIL' : 'UNKNOWN'), health.note ?? `${health.findings.length} findings`);
  if (health.status === 'FAILED') {
    const first = health.blocking[0] ?? null;
    return finish({
      outcome: 'BLOCKED_BY_HEALTH',
      reason: first?.reason ?? 'HEALTH_BLOCKED',
      overrides: {
        due: dueResult,
        health,
        detail: first?.detail ?? first?.code ?? null,
      },
    });
  }

  // ── ③ 探队列 + 执行（复用调度器的五出口）──────────────────────────────────
  let scheduleReceipt = null;
  try {
    scheduleReceipt = await schedule({ businessKey: key, capabilityId, health, due: dueResult });
  } catch (error) {
    record('PROBE', 'ERROR', messageOf(error).slice(0, 200));
    return finish({
      outcome: 'ERROR',
      reason: 'ROUND_ERROR',
      overrides: {
        due: dueResult,
        health,
        detail: messageOf(error).slice(0, 300),
      },
    });
  }
  record('PROBE', 'PASS', `scheduler outcome=${scheduleReceipt?.outcome ?? 'unknown'}`);
  record('EXECUTE', scheduleReceipt?.ok === false ? 'FAIL' : 'PASS', scheduleReceipt?.failureClass ?? 'ok');

  // 调度收据的出口必须落在白名单里：收据字段认得出来才说明「这一轮到底跑了没有」。
  // 一条认不出来的收据如果被当成「没失败」，就会变成一次**静默的成功**——本轮什么都没做，
  // 收据却说 COMPLETED。所以认不出来一律当编排缺陷（fail-closed）。
  if (!SCHEDULER_OUTCOMES_WITHIN_ROUND.includes(scheduleReceipt?.outcome)) {
    record('EXECUTE', 'ERROR', `unrecognized scheduler outcome: ${JSON.stringify(scheduleReceipt?.outcome ?? null)}`);
    return finish({
      outcome: 'ERROR',
      reason: 'ROUND_ERROR',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
        detail: `scheduler returned an unrecognized outcome: ${JSON.stringify(scheduleReceipt?.outcome ?? null)}`,
      },
    });
  }

  if (scheduleReceipt?.outcome === 'SKIPPED_EMPTY_QUEUE') {
    return finish({
      outcome: 'SKIPPED_EMPTY_QUEUE',
      reason: 'EMPTY_QUEUE',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
      },
    });
  }
  if (scheduleReceipt?.outcome === 'PAUSED_FOR_HUMAN') {
    return finish({
      outcome: 'PAUSED_FOR_HUMAN',
      reason: 'WAITING_HUMAN',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
        detail: scheduleReceipt?.probe?.reason ?? null,
      },
    });
  }
  if (scheduleReceipt?.outcome === 'PROBED_ONLY') {
    // 一轮运行**不**做「只探测」：那是排产工具的行为。真出现说明接线错了，当编排缺陷处理。
    record('EXECUTE', 'ERROR', 'PROBED_ONLY is not a valid outcome for a round');
    return finish({
      outcome: 'ERROR',
      reason: 'ROUND_ERROR',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
        detail: 'scheduler returned PROBED_ONLY inside a round',
      },
    });
  }

  const launched = scheduleReceipt?.outcome === 'RAN' || scheduleReceipt?.outcome === 'PROCEEDED_WITHOUT_PROBE';
  const attemptsAfter = attemptsToday + (launched ? 1 : 0);
  const runFailed = scheduleReceipt?.ok === false;
  const failureClass = asText(scheduleReceipt?.failureClass) || (runFailed ? 'UNKNOWN' : null);

  // ── ④ 成功：收尾 ─────────────────────────────────────────────────────────
  if (!runFailed) {
    record('HEAL', 'SKIP', 'no failure');
    return finish({
      outcome: 'COMPLETED',
      reason: 'SUCCESS',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
        run: scheduleReceipt?.run ?? null,
        heal: { attempted: false, healed: false, reason: 'NO_FAILURE', attempts: [] },
      },
      statePatch: { completed: true, day: attemptsPatch(launched) },
    });
  }

  // ── ⑤ 自愈 ───────────────────────────────────────────────────────────────
  let healResult = { attempted: false, healed: false, reason: 'NO_HEALER_CONFIGURED', attempts: [] };
  if (typeof heal === 'function') {
    try {
      const raw = await heal({
        failureClass,
        businessKey: key,
        schedule: scheduleReceipt,
        run: scheduleReceipt?.run ?? null,
        attempt: attemptsAfter,
        dayKey,
      });
      healResult = {
        attempted: true,
        healed: raw?.healed === true,
        reason: asText(raw?.reason) || (raw?.healed === true ? 'HEALED' : 'NOT_HEALED'),
        budgetExhausted: raw?.budgetExhausted === true,
        escalatedReason: asText(raw?.escalatedReason) || null,
        attempts: Array.isArray(raw?.attempts) ? raw.attempts : [],
        detail: asText(raw?.detail) || null,
      };
    } catch (error) {
      healResult = {
        attempted: true, healed: false, reason: 'HEAL_ERROR', attempts: [], detail: messageOf(error).slice(0, 300),
      };
    }
  }
  record('HEAL', healResult.healed ? 'PASS' : 'FAIL', `${healResult.reason}${healResult.detail ? ` · ${healResult.detail}` : ''}`);

  if (healResult.healed) {
    return finish({
      outcome: 'COMPLETED_WITH_HEAL',
      reason: 'AUTO_HEALED',
      overrides: {
        due: dueResult,
        health,
        schedule: scheduleReceipt,
        run: scheduleReceipt?.run ?? null,
        heal: healResult,
        detail: `自愈：${healResult.reason}`,
      },
      statePatch: { completed: true, day: attemptsPatch(launched) },
    });
  }

  // 未治愈 → 升级人工。理由的取法见 escalationReasonFor 上方注释（防止把失败静默吞掉）。
  const reason = healResult.escalatedReason && resolveNotifyRule(healResult.escalatedReason)
    ? healResult.escalatedReason
    : (healResult.budgetExhausted ? 'BUDGET_EXHAUSTED' : escalationReasonFor(failureClass));

  // 当日是否收工：不可自动重试的类别立刻收（15 分钟后再跑一遍不会有新结果），
  // 其余跑到次数上限为止——上限触发时把「今天已自动尝试 N 次」写进下一步，避免运营等一个不会来的重试。
  const nonRetryable = NO_AUTO_RETRY_REASONS.includes(failureClass);
  const closeNow = nonRetryable || attemptsAfter >= maxAttemptsPerDay;
  const closedReason = nonRetryable ? `NO_AUTO_RETRY:${failureClass}` : (attemptsAfter >= maxAttemptsPerDay ? 'ATTEMPTS_EXHAUSTED' : null);
  const nextAction = closedReason
    ? `今天已自动尝试 ${attemptsAfter} 次${nonRetryable ? `（${failureClass} 不会自动重试）` : ''}：按上面的原因处理完后，请手动触发一次（或在控制台点「继续」）；明天会照常自动跑。`
    : (healResult.detail ? `自愈未成功（${healResult.detail}）；系统会在下一个 15 分钟节点自动再试一次。` : null);

  return finish({
    outcome: 'FAILED',
    reason,
    overrides: {
      due: dueResult,
      health,
      schedule: scheduleReceipt,
      run: scheduleReceipt?.run ?? null,
      heal: healResult,
      detail: healResult.detail ?? scheduleReceipt?.reasons?.[0] ?? null,
      nextAction,
    },
    statePatch: {
      completed: false,
      day: { ...attemptsPatch(launched), closed: closeNow || day.closed === true, closedReason: closedReason ?? day.closedReason ?? null },
    },
  });
}

export function exitCodeForRound(receipt) {
  if (receipt.outcome === 'ERROR') return 4;
  if (receipt.humanRequired === true) return 3;
  return receipt.ok === true ? 0 : 2;
}

const BOOLEAN_FLAGS = Object.freeze({
  '--force': 'force',
  '--serve': 'serve',
  '--show-plan': 'showPlan',
  '--help': 'help',
  '-h': 'help',
});

// 解析参数。两种模式：
//  1. **手动模式**（现状）：调用方把 capability / identity / business-key 全带上，跑一轮。
//  2. **排期模式**：给了 `--schedule-file`，这些就从排期文件里读——因此**不能**再走
//     `parseCliArgs`（它对 run profile 强制要求 capability/identity/business-key 三件套），
//     否则「排期里已经写好的东西」会被逼着在命令行再抄一遍，抄漏一个就是启动即炸。
export function parseRoundArgs(argv = []) {
  const flags = { force: false, serve: false, showPlan: false, help: false };
  const rest = [];
  for (const token of argv) {
    const mapped = BOOLEAN_FLAGS[token];
    if (mapped) { flags[mapped] = true; continue; }
    rest.push(token);
  }
  if (rest.includes('--schedule-file')) {
    const values = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      values[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      index += 1;
    }
    return { ...flags, ...values, scheduleMode: true };
  }
  const args = parseCliArgs(rest, { profile: 'run' });
  return { ...args, ...flags };
}

// 通知出口：进程内直接走投递层（不 spawn 子进程）。零参数配置——收件人写在飞书 env 文件里，
// 与既有 notifyOperator 的约定一致（那套约定是「命令不带参数，配置从 env 文件来」）。
async function createFeishuNotify({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFile = readFileSync,
} = {}) {
  const [{ activeProfileName, envFilePath, parseEnvFile }, { createTokenProvider, deliverAlert }, { resolveNotifyConfig }] = await Promise.all([
    import('../feishu-targets.mjs'),
    import('../notify-feishu-core.mjs'),
    import('../notify-feishu.mjs'),
  ]);
  const file = envFilePath(activeProfileName(env));
  const values = parseEnvFile(readFile(file, 'utf8'));
  const appId = asText(values.FEISHU_APP_ID);
  const appSecret = asText(values.FEISHU_APP_SECRET);
  const config = resolveNotifyConfig({ options: {}, values, env });
  if (!appId || !appSecret || (!config.recipient && !config.fallbackRecipient && !config.webhook)) {
    return async () => ({ status: 'NOT_CONFIGURED', error: `no recipient/webhook configured in ${file}` });
  }
  return async ({ alert }) => {
    const receipt = await deliverAlert({
      alert,
      fetchImpl,
      tokenProvider: config.recipient || config.fallbackRecipient
        ? createTokenProvider({ fetchImpl, appId, appSecret })
        : null,
      recipient: config.recipient,
      recipientType: config.recipientType,
      fallbackRecipient: config.fallbackRecipient,
      fallbackRecipientType: config.fallbackRecipientType,
      webhookUrl: config.webhook,
    });
    return { status: receipt.status, channel: receipt.channel, receipt };
  };
}

// 用法：
//   ── 手动模式（跑一轮，参数全在命令行上）──
//   node runtime/sop-runtime/round-runner.mjs --capability <id> --identity <json> \
//     --business-key <key> [--collect-input <json>] [--target <url>] \
//     [--period-start D --period-end D] [--work-dir <p>] [--database-url <pg>] \
//     [--commit --env-file <p> --operator <name>] [--force]
//   ── 排期模式（「什么时候跑、周期多少」写在配置文件里，见 runtime/round-schedule.json）──
//   node runtime/sop-runtime/round-runner.mjs --schedule-file <p> --show-plan
//   node runtime/sop-runtime/round-runner.mjs --schedule-file <p> --round <name> [--force]
//   node runtime/sop-runtime/round-runner.mjs --schedule-file <p> --serve [--interval-seconds 60]
// 退出码：0 完成/无需动作；2 运行失败；3 需要人工；4 调用方或编排缺陷。
const USAGE = [
  'usage: round-runner.mjs --capability <id> --identity <json> --business-key <key>',
  '         [--collect-input <json>] [--target <url>] [--expected-rows N]',
  '         [--period-start D --period-end D] [--work-dir <p>] [--database-url <pg>]',
  '         [--commit --env-file <p> --operator <name>] [--force]',
  '   or: round-runner.mjs --schedule-file <p> --show-plan',
  '   or: round-runner.mjs --schedule-file <p> --round <name> [--force]',
  '   or: round-runner.mjs --schedule-file <p> --serve [--interval-seconds 60]',
  '',
].join('\n');

function readScheduleFile(file) {
  const path = resolve(file);
  const { schedule, ok, errors } = parseScheduleJson(readFileSync(path, 'utf8'));
  return { path, schedule, ok, errors };
}

// ── 体检层接线（实施计划第 4 步）─────────────────────────────────────────────
//
// 接线的形状由三条既有事实决定，不是新设计：
//   1. 默认关闭。`runtime/round-schedule.json` 出厂 `enabled:false`，条目里也没有 `healthCheck` 键；
//      「没写」必须与今天**逐字相同**地等于「不体检」，否则接线本身就改变了默认行为。
//   2. 「这条能力走哪个浏览器」不新写一份。`registry.entryFor(capability).skillDir` 给出技能目录名，
//      `ROUTES[].skills` 指出它属于哪条路线，路线的 `browser` 就是答案 —— 全链复用既有的
//      单一来源（`runtime/browser-ports.mjs`）。
//   3. 查不出来时**不许猜**。查不出（能力没注册 / 技能不在任何路线里 / 落在多个浏览器上）
//      就让配置显式写 `{ "browser": "..." }`；写不出来就报错停跑。猜一个默认值正是坑 35
//      （默认值即目标）：它会安静地给**别的**浏览器发绿灯，而这一轮的页面根本不在那台上。
//
// `{ "browser": "..." }` 与推导结果**不一致时直接报错**：这一条专门用来堵「体检通过、但这轮
// 连的其实是另一个浏览器」这种假绿。没写 browser 时用推导值；推导不出来又没写就报错。
export function deriveBrowserForCapability({ capabilityId, registry = null } = {}) {
  const none = (reason) => ({ browser: null, route: null, source: null, reason });
  const name = asText(capabilityId);
  if (!name) return none('no capability');
  if (!registry || typeof registry.entryFor !== 'function') return none('registry unavailable');
  let entry = null;
  try {
    entry = registry.entryFor(name);
  } catch {
    return none(`capability not registered: ${name}`);
  }
  const skillDir = asText(entry?.skillDir);
  if (!skillDir) return none(`no skill dir for ${name}`);
  // 技能目录名（末段），不是整条路径：ROUTES 里登记的就是这个名字。
  const skill = basename(skillDir.replaceAll('\\', '/'));
  // 只认**有浏览器**的路线：`competitorImport` 这类 `browser: null` 的路线（纯接口，不开浏览器）
  // 不该参与判断 —— 把它算进来会让同一个技能看起来落在两台浏览器上。
  const owners = Object.entries(ROUTES)
    .filter(([, route]) => asText(route?.browser) && (route.skills ?? []).includes(skill))
    .map(([routeName, route]) => ({ routeName, browser: route.browser }));
  const browsers = [...new Set(owners.map((item) => item.browser))];
  if (browsers.length === 0) {
    // 区分两种「没有浏览器」：这条能力**本来就不开浏览器**（走接口），还是它的技能压根没登记。
    // 这两种情况运维要做的事完全不同（前者不用体检，后者要改登记表），不能共用一句话。
    const onAnyRoute = Object.values(ROUTES).some((route) => (route.skills ?? []).includes(skill));
    return none(onAnyRoute
      ? `capability "${name}" runs over routes that do not open a browser (no browser to check)`
      : `skill "${skill}" is not registered on any route`);
  }
  if (browsers.length > 1) {
    return none(`skill "${skill}" is on several browsers (${browsers.join(', ')})`);
  }
  // 同一个浏览器上挂多条路线时，浏览器是确定的，但「要哪几页」不确定 ⇒ route 留 null，
  // 于是 `pages: true` 会被拒绝（见 healthCheckFromEntry），而不是随便挑一条路线的页面。
  const route = owners.length === 1 ? owners[0].routeName : null;
  return { browser: browsers[0], route, source: `ROUTES(/${skill})`, reason: null };
}

// 排期条目 -> 体检端口（`null` = 不体检）。
//
// 只认这几种写法，别的都报错（配置写坏一律停跑，不静默回退）：
//   "healthCheck": false / 不写 / null   -> null（与今天逐字相同：不体检，收据落成 NOT_IMPLEMENTED）
//   "healthCheck": true                  -> 按能力推导浏览器；推不出来就报错
//   "healthCheck": { "pages": true }     -> 同上，并且数**这条能力所属路线**的页面是否恰好各一个
//   "healthCheck": { "browser": "dailyReport", "pages": true }
//                                        -> 显式指定浏览器；与推导结果不一致就报错
//
// 页面计数**默认不开**：`pages` 只认 `true` 才开。理由见 `expectedPagesForRoute` 的注释 ——
// 「页面恰好一个」是日报链的口径，对竞品链（一个竞品一个商品页）是错的判据，
// 所以它必须是这条排期显式说出来的意图，而不是一个所有链都默认套用的规则。
// 键名清单定义在 round-schedule（校验要在那里跑），这里只引用，不另写一份。
export function healthCheckFromEntry(entry, { registry = null } = {}) {
  const spec = entry?.healthCheck;
  if (spec === undefined || spec === null || spec === false) return null;
  if (spec !== true && (typeof spec !== 'object' || Array.isArray(spec))) {
    throw new RoundError(
      `healthCheck must be true/false or an object with ${HEALTH_CHECK_KEYS.join('/')}; got ${JSON.stringify(spec)}`,
      'ROUND_INPUT_REQUIRED',
    );
  }

  const explicit = typeof spec === 'object' && spec.browser !== undefined ? asText(spec.browser) : '';
  const derived = deriveBrowserForCapability({ capabilityId: entry?.capability, registry });

  // 先认「这个键存不存在」，再谈「与路线矛不矛盾」：两者要说的话不一样。
  // 合并成一句会让「打错字」看起来像「这条链真的该用另一台浏览器」，排查方向就偏了。
  const knownBrowsers = Object.keys(BROWSER_PROFILES);
  if (explicit && !knownBrowsers.includes(explicit)) {
    throw new RoundError(
      `healthCheck.browser "${explicit}" is not a registered browser (expected one of ${knownBrowsers.join(' | ')})`,
      'HEALTH_BROWSER_UNKNOWN',
    );
  }

  if (explicit && derived.browser && explicit !== derived.browser) {
    // **这条就是假绿闸门**：写错浏览器时体检会在别的浏览器上跑出一个漂亮的绿灯，
    // 而这一轮要用的那个浏览器根本没被看过。报错优于放行。
    throw new RoundError(
      `healthCheck.browser "${explicit}" contradicts the capability's route (${derived.source} → "${derived.browser}")`,
      'HEALTH_BROWSER_MISMATCH',
      { declared: explicit, derived: derived.browser, source: derived.source },
    );
  }

  const browserKey = explicit || derived.browser;
  if (!browserKey) {
    throw new RoundError(
      `cannot tell which browser capability "${asText(entry?.capability)}" uses: ${derived.reason}. `
        + `Either write it explicitly as "healthCheck": { "browser": "<${knownBrowsers.join('|')}>" }, `
        + 'or drop healthCheck from this round — 不体检如实写成 NOT_IMPLEMENTED，好过假装检查过。',
      'HEALTH_BROWSER_UNDETERMINED',
    );
  }

  // 「数页面」是**显式开启**的（默认不数）：页面「恰好一个」不是通用口径 ——
  // 竞品链要同时开很多商品详情页，对它按「恰好一个」判会把正常状态判成停线。
  const wantsPages = typeof spec === 'object' && spec.pages === true;
  if (wantsPages && !derived.route) {
    throw new RoundError(
      `healthCheck.pages was requested but this round's route cannot be determined `
        + `(${derived.reason ?? `skill is on several routes of ${browserKey}`}) — so "which pages" is unknown`,
      'HEALTH_PAGES_UNDETERMINED',
    );
  }

  // 浏览器键写错（不在登记表里）会在**创建时**抛：不能等到体检跑起来才炸 ——
  // 那时 round-runner 会把它当成「体检自己崩了」（状态 UNKNOWN，照常发起），
  // 于是一个配置笔误变成「体检长期没在工作」。
  return createPlatformHealthCheck({
    browserKey,
    ...(wantsPages ? { routeKey: derived.route } : {}),
  });
}

// 排期条目 -> 一次运行的选项。命令行参数可以盖掉条目里的值（人工临时跑用），但**不反过来**：
// 配置文件是运营日常改的地方，命令行是临时干预，临时的不该被持久的那份悄悄覆盖。
function optionsFromEntry(entry, args = {}, decision = null, { registry = null } = {}) {
  const collectInput = { ...(entry.collectInput ?? {}) };
  if (args.collectInput) Object.assign(collectInput, JSON.parse(args.collectInput));
  const envFile = args.envFile ?? entry.envFile ?? null;
  if (envFile) collectInput.envFile = resolve(envFile);
  const period = decision?.period
    ? { startDate: decision.period.startDate, endDate: decision.period.endDate }
    : (entry.periodStart && entry.periodEnd ? { startDate: entry.periodStart, endDate: entry.periodEnd } : null);
  return {
    capabilityId: entry.capability,
    identity: args.identity ? JSON.parse(args.identity) : entry.identity,
    target: args.target ?? entry.target ?? null,
    expectedRows: entry.expectedRows === undefined ? null : Number(entry.expectedRows),
    businessKey: args.businessKey ?? decision?.businessKey ?? entry.businessKey ?? null,
    commit: entry.commit === true,
    operator: args.operator ?? entry.operator ?? null,
    collectInput,
    collectStepId: entry.collectStepId ?? null,
    period,
    publishInput: entry.publishInput ?? {},
    // 体检按条目开启（默认关闭）。**在这里建**是为了让浏览器键写错在「本轮开跑之前」就报出来。
    healthCheck: healthCheckFromEntry(entry, { registry }),
    source: {
      targetLabel: entry.source?.targetLabel ?? null,
      shopName: entry.source?.shopName ?? null,
      period: period ? `${period.startDate}~${period.endDate}` : null,
      capability: entry.capability,
    },
  };
}

// --show-plan 的输出形状。抽成纯函数只为一件事：**让「字段有没有少」可测**。
// 少一个 `hoursSinceTriggerAt`，「漏跑在计划里看得见」这句话就不成立了，而这种缺失不会报错。
export const PLAN_REPORT_FIELDS = Object.freeze([
  'name', 'capability', 'when', 'enabled', 'due',
  'triggerAt', 'isLastTriggerToday', 'hoursSinceTriggerAt',
  'windowKey', 'businessKey', 'nextTriggerAt',
]);

export function buildPlanReport({ scheduleFile, now, plan }) {
  return {
    scheduleFile,
    ok: true,
    now: new Date(now).toISOString(),
    rounds: plan.rows.map((row) => ({
      name: row.name,
      capability: row.capability,
      when: row.label,
      enabled: row.enabled,
      due: row.due,
      // 「上次触发是什么时候、过去多久」必须摆出来：到期口径是「只算触发日当天」，
      // 所以周一没开机就真的不会自动补跑。不显示这两个字段的话，「漏了」在计划里看不出来，
      // 而「漏跑可见」正是选这个口径的前提条件。
      triggerAt: row.triggerAt,
      isLastTriggerToday: row.isLastTriggerToday,
      hoursSinceTriggerAt: row.hoursSinceTriggerAt,
      windowKey: row.windowKey,
      businessKey: row.businessKey,
      nextTriggerAt: row.nextTriggerAt,
    })),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRoundArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // --show-plan 只读配置、不碰数据库：运营问「下次什么时候跑」不该需要数据库在线。
  if (args.showPlan) {
    if (!args.scheduleFile) throw new Error('--show-plan requires --schedule-file');
    const { path, schedule, ok, errors } = readScheduleFile(args.scheduleFile);
    if (!ok) {
      process.stdout.write(`${JSON.stringify({ scheduleFile: path, ok: false, errors }, null, 2)}\n`);
      return 4;
    }
    const plan = planSchedule(schedule, Date.now());
    process.stdout.write(`${JSON.stringify(buildPlanReport({ scheduleFile: path, now: Date.now(), plan }), null, 2)}\n`);
    return 0;
  }

  const context = await createRuntimeContext({
    databaseUrl: args.databaseUrl ?? null,
    workDir: args.workDir ?? null,
    workDirPrefix: 'round',
  });
  const { registry, loader, store, controller, ledger, evidenceStore, workDir } = context;

  const stateFile = resolve(workDir, 'round-state.json');
  const roundState = createFileRoundState(stateFile);
  // 通知端口建一次就复用：它内部持有 token 缓存（常驻循环下每秒新建一个 provider 会让 2 小时过期
  // 这条防线失效——每次都是新缓存，永远撞不上「用旧 token 发」的窗口，也就永远测不出缓存逻辑）。
  const notify = await createFeishuNotify();

  // 一次运行的装配：manual 与 schedule 两条路径共用，避免「两条路各接一半」。
  const buildRound = (opts, { dueDecision = null, force = false } = {}) => ({
    businessKey: opts.businessKey,
    capabilityId: opts.capabilityId,
    source: opts.source,
    // 排期模式已经判过「该不该跑」，这里把结论原样交给编排层；它自己那份
    // 「同一幂等键跑过没有 / 今天是否收工」仍然独立生效（两道闸门，不互相代替）。
    due: dueDecision ? async () => ({ due: dueDecision.due, source: 'SCHEDULE' }) : null,
    schedule: (roundArgs) => runScheduled({
      registry, loader, store, controller, ledger, evidenceStore,
      capabilityId: opts.capabilityId,
      identity: opts.identity,
      target: opts.target,
      expectedRows: opts.expectedRows,
      businessKey: roundArgs.businessKey,
      commit: opts.commit,
      operator: opts.operator,
      collectInput: opts.collectInput,
      collectStepId: opts.collectStepId,
      period: opts.period,
      publishInput: opts.publishInput,
      workDir,
      probeOnly: false,
      forceRun: force,
    }),
    // 体检层由排期条目显式开启（实施计划第 4 步）；自愈执行器是第 3 步。
    // 没开启时**如实写 null**（收据里落成 NOT_IMPLEMENTED），不假装它在工作；
    // 也不会因为「今天接线了」就顺手打开——默认关闭是这条接线的验收条件之一。
    healthCheck: opts.healthCheck ?? null,
    heal: null,
    notify,
    state: roundState,
    force,
  });

  try {
    if (args.serve) {
      if (!args.scheduleFile) throw new Error('--serve requires --schedule-file');
      const { path, schedule, ok, errors } = readScheduleFile(args.scheduleFile);
      if (!ok) {
        // 配置不合法就**不开跑**：坏配置最坏的形态不是报错，而是「看起来在跑」。
        process.stdout.write(`${JSON.stringify({ scheduleFile: path, ok: false, errors }, null, 2)}\n`);
        return 4;
      }
      const intervalSeconds = Number(args.intervalSeconds ?? 60);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) throw new Error('--interval-seconds must be a number >= 5');
      const maxTicks = args.maxTicks === undefined ? Number.POSITIVE_INFINITY : Number(args.maxTicks);
      process.stdout.write(`serving ${schedule.rounds.length} round(s) from ${path}; every ${intervalSeconds}s\n`);
      const { ticks, tickLog } = await serveRounds({
        schedule,
        intervalMs: intervalSeconds * 1000,
        maxTicks,
        runRoundOnce: async (entry, decision) => {
          const receipt = await runRound(buildRound(optionsFromEntry(entry, args, decision, { registry }), { dueDecision: decision }));
          process.stdout.write(`[round] ${entry.name} → ${receipt.outcome} (key ${receipt.businessKey}, notify ${receipt.notification.status})\n`);
          return receipt;
        },
        onTick: async ({ at, results }) => {
          const due = results.filter((item) => item.decision.due).length;
          const quiet = results.length - due;
          process.stdout.write(`[tick] ${new Date(at).toISOString()} due=${due} waiting=${quiet} state=${stateFile}\n`);
        },
      });
      process.stdout.write(`${JSON.stringify({
        ticks,
        lastTick: tickLog.length ? { at: tickLog[tickLog.length - 1].at, rounds: tickLog[tickLog.length - 1].results.map((item) => ({ name: item.name, due: item.decision.due, outcome: item.receipt?.outcome ?? null })) } : null,
      }, null, 2)}\n`);
      return 0;
    }

    if (args.scheduleMode) {
      const { path, schedule, ok, errors } = readScheduleFile(args.scheduleFile);
      if (!ok) {
        process.stdout.write(`${JSON.stringify({ scheduleFile: path, ok: false, errors }, null, 2)}\n`);
        return 4;
      }
      const targets = args.round ? [findRound(schedule, args.round)].filter(Boolean) : schedule.rounds;
      if (args.round && targets.length === 0) throw new Error(`no round named ${args.round} in ${path}`);
      const receipts = [];
      for (const entry of targets) {
        const decision = evaluateSchedule(entry, Number(Date.now()));
        if (!decision.due && args.force !== true) {
          receipts.push({ name: decision.name, skipped: true, reason: decision.reason, nextTriggerAt: decision.nextTriggerAt, businessKey: decision.businessKey });
          continue;
        }
        const receipt = await runRound(buildRound(optionsFromEntry(entry, args, decision, { registry }), { dueDecision: decision, force: args.force === true }));
        receipts.push({ name: decision.name, skipped: false, receipt });
      }
      process.stdout.write(`${JSON.stringify({ scheduleFile: path, rounds: receipts }, null, 2)}\n`);
      const worst = receipts.reduce((code, item) => Math.max(code, item.skipped ? 0 : exitCodeForRound(item.receipt)), 0);
      return worst;
    }

    const opts = optionsFromEntry(
      {
        capability: args.capability,
        identity: args.identity ? JSON.parse(args.identity) : null,
        target: args.target ?? null,
        commit: args.commit === true,
        operator: args.operator ?? null,
        collectInput: {},
        source: { targetLabel: args.targetLabel ?? null, shopName: args.shopName ?? null },
        periodStart: args.periodStart ?? null,
        periodEnd: args.periodEnd ?? null,
      },
      args,
      args.periodStart && args.periodEnd ? { period: { startDate: args.periodStart, endDate: args.periodEnd, label: `${args.periodStart}~${args.periodEnd}` }, businessKey: args.businessKey } : { businessKey: args.businessKey },
      // 手工单跑没有排期条目，也就没有「要不要体检」的声明 ⇒ 不体检（收据里落成 NOT_IMPLEMENTED）。
      // 要临时确认环境，用体检自己的入口：node runtime/xws-platform-health-preflight.mjs --json
      { registry },
    );
    opts.businessKey = args.businessKey;
    opts.capabilityId = args.capability;
    const receipt = await runRound(buildRound(opts, { force: args.force === true }));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return exitCodeForRound(receipt);
  } finally {
    if (store?.close) await store.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(error?.code ? 4 : 1);
    });
}
