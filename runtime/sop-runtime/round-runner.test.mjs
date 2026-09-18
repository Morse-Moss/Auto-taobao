// 一轮运行生命周期 + 通知判据表的单测。
//
// 这一步的验收要求是「静默判据表**双向**覆盖」，所以本文件刻意把两个相反的方向都钉住：
//   - 该响要响：登录失效、体检不过、写入结果未知…必须真的发出通知（且带「下一步做什么」）。
//   - 该静默要静默：空队列、未到点、已完成、自愈成功…**一次通知都不许发**。
// 只测一个方向会出现「故障被静默吞掉」，而且它在离线用例里完全看不出来。
//
// 编排层与调度器之间只以**收据**为界：这里用合成的调度收据（调度器自己的行为由
// capability-scheduler.test.mjs 负责），这样本轮判定的每一条分支都能被单独构造出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FAILURE_CLASS } from './context-schema.mjs';
import { renderAlertText, redactSensitive } from '../notify-feishu-core.mjs';
import {
  DIAGNOSE_FAILURE_CLASSES,
  NOTIFY_REASON_KEYS,
  NO_AUTO_RETRY_REASONS,
  RECOVERY_PROVING_REASONS,
  ROUND_NOTIFY_RULES,
  SILENT_REASON_KEYS,
  buildResolvedAlert,
  buildRoundAlert,
  decideNotification,
  missingPolicyKeys,
  requiredPolicyKeys,
  resolveNotifyRule,
  roundAlertId,
} from './round-notify-policy.mjs';
import {
  AUTO_RETRY_REASONS,
  PLAN_REPORT_FIELDS,
  ROUND_RECEIPT_FIELDS,
  SCHEDULER_OUTCOMES_WITHIN_ROUND,
  buildPlanReport,
  createMemoryRoundState,
  deriveBrowserForCapability,
  escalationReasonFor,
  exitCodeForRound,
  healthCheckFromEntry,
  localDayKey,
  parseRoundArgs,
  runRound,
} from './round-runner.mjs';
import { planSchedule, ROUND_SCHEDULE_VERSION } from './round-schedule.mjs';

const NOW_ISO = '2026-09-15T09:00:00+08:00';
const at = (iso) => () => new Date(iso).valueOf();
const BUSINESS_KEY = 'fake-store/2026-09-14~2026-09-20';
const SOURCE = Object.freeze({ targetLabel: '专用部署机', capability: 'fake.cap' });

const scheduleRan = (overrides = {}) => async () => ({
  contractVersion: 'capability-scheduler-v1',
  capabilityId: 'fake.cap',
  outcome: 'RAN',
  scheduled: true,
  ok: true,
  humanRequired: false,
  failureClass: null,
  queueState: 'READY',
  queueCode: null,
  candidateCount: 2,
  reasons: [],
  probe: { state: 'READY', probed: true },
  run: { ok: true },
  ...overrides,
});

const scheduleFixed = (receipt) => async () => receipt;

function recordingNotify({ status = 'SENT', channel = 'app', error = null } = {}) {
  const calls = [];
  const port = async ({ alert, decision, businessKey, outcome }) => {
    calls.push({ alert, decision, businessKey, outcome });
    return { status, channel, error };
  };
  port.calls = calls;
  return port;
}

// 「发出去过几次」= 投递端口的调用次数。SILENT / DEDUPED / NOT_CONFIGURED 都**不是**一次发送，
// 用收据里的状态字段计数会把三种不同的事混成一件。
const sends = (notify) => notify.calls.length;

const runOnce = (options = {}) => runRound({
  businessKey: BUSINESS_KEY,
  capabilityId: 'fake.cap',
  source: SOURCE,
  state: createMemoryRoundState(),
  now: at(NOW_ISO),
  ...options,
});

const hasAllFields = (receipt) => ROUND_RECEIPT_FIELDS.filter((key) => !Object.hasOwn(receipt, key));

// ── 判据表：完整性与两个方向 ────────────────────────────────────────────────

test('every failure class and diagnose class is explicitly decided in the notify policy', () => {
  const missing = missingPolicyKeys(requiredPolicyKeys());
  assert.deepEqual(missing, [], `undecided reason(s): ${missing.join(', ')}`);
  // 词表对齐：判定表里以字面量抄了一份诊断层分类，这里与真实词表比一次。
  assert.equal(DIAGNOSE_FAILURE_CLASSES.length, 7);
  assert.deepEqual([...FAILURE_CLASS].sort(), [...FAILURE_CLASS].sort());
});

test('notify and silent reasons partition the table (no reason is silently undecided)', () => {
  const all = ROUND_NOTIFY_RULES.map((rule) => rule.key);
  const union = [...NOTIFY_REASON_KEYS, ...SILENT_REASON_KEYS];
  assert.equal(union.length, all.length);
  assert.deepEqual([...union].sort(), [...all].sort());
  assert.equal(new Set(union).size, union.length);
  for (const key of all) assert.equal(typeof resolveNotifyRule(key)?.plan, 'string', key);
});

test('every notifying rule carries a human-readable next step and a title', () => {
  for (const rule of ROUND_NOTIFY_RULES.filter((item) => item.plan === 'NOTIFY')) {
    assert.equal(typeof rule.title, 'string', rule.key);
    assert.ok(rule.title.length > 0, `${rule.key} needs a title`);
    assert.equal(typeof rule.nextAction, 'string', rule.key);
    // 只报错误码的告警是给运维看的，不是给运营看的（§4 第 2 条）。
    assert.ok(rule.nextAction.length > 10, `${rule.key} needs a real next action`);
    assert.ok(['HIGH', 'INFO'].includes(rule.severity ?? 'HIGH'), rule.key);
  }
  for (const rule of ROUND_NOTIFY_RULES.filter((item) => item.plan === 'SILENT')) {
    assert.equal(typeof rule.note, 'string', `${rule.key} must say why staying quiet is correct`);
  }
});

test('only rules that can prove recovery are allowed to clear an open alert', () => {
  for (const key of RECOVERY_PROVING_REASONS) {
    assert.ok(SILENT_REASON_KEYS.includes(key), `${key} proves recovery but is not silent`);
  }
  // 空队列与「没到点」都**不能**证明故障恢复：它们既没碰浏览器也没跑流程。
  assert.ok(!RECOVERY_PROVING_REASONS.includes('EMPTY_QUEUE'));
  assert.ok(!RECOVERY_PROVING_REASONS.includes('NOT_DUE'));
  assert.ok(!RECOVERY_PROVING_REASONS.includes('ALREADY_DONE'));
  assert.ok(RECOVERY_PROVING_REASONS.includes('SUCCESS'));
});

test('an unregistered reason notifies instead of going quiet (fail-closed)', () => {
  const decision = decideNotification({ reason: 'SOME_NEW_FAILURE_MODE' });
  assert.equal(decision.action, 'SEND');
  assert.equal(decision.unmapped, true);
  assert.equal(decision.plan, 'NOTIFY');
});

test('the same reason does not notify twice, a different one supersedes it', () => {
  const open = { reason: 'HUMAN_REQUIRED', alertId: 'round-x-1', title: '平台登录已失效' };
  assert.equal(decideNotification({ reason: 'HUMAN_REQUIRED', openAlert: open }).action, 'DEDUPED');
  const superseding = decideNotification({ reason: 'POLICY_DENIED', openAlert: open });
  assert.equal(superseding.action, 'SEND');
  assert.equal(superseding.previousKey, 'HUMAN_REQUIRED');
});

test('an empty queue must not clear a login alert (and says why)', () => {
  const open = { reason: 'HUMAN_REQUIRED', alertId: 'round-x-2', title: '平台登录已失效' };
  const quiet = decideNotification({ reason: 'EMPTY_QUEUE', openAlert: open });
  assert.equal(quiet.action, 'NONE');
  assert.match(quiet.keptOpenBecause, /不能证明/);
  const recovered = decideNotification({ reason: 'SUCCESS', openAlert: open });
  assert.equal(recovered.action, 'RESOLVE');
});

test('the round alert id survives credential redaction', () => {
  const alertId = roundAlertId({ businessKey: BUSINESS_KEY, now: new Date(NOW_ISO).valueOf() });
  assert.ok(alertId.length > 10);
  assert.equal(redactSensitive(alertId), alertId);
  assert.match(alertId, /^round-/);
  assert.ok(!/\s/.test(alertId));
});

test('a notifying alert renders as a human-readable message with a next step', () => {
  const alert = buildRoundAlert({
    reason: 'HUMAN_REQUIRED',
    businessKey: BUSINESS_KEY,
    now: new Date(NOW_ISO).valueOf(),
    source: SOURCE,
    detail: '小旺神登录态已失效',
  });
  const text = renderAlertText(alert);
  assert.match(text, /^【需要处理】/);
  assert.match(text, /平台登录已失效/);
  assert.match(text, /原因：小旺神登录态已失效/);
  assert.match(text, /下一步：/);
  assert.match(text, /时间：2026-09-15 09:00/); // 本机时区，不是 ISO 的 01:00Z
  assert.match(text, new RegExp(alert.alertId));
});

test('a resolved alert talks about the previous alert, not about success', () => {
  const alert = buildResolvedAlert({
    openAlert: { alertId: 'round-x-3', title: '平台登录已失效' },
    now: new Date(NOW_ISO).valueOf(),
  });
  const text = renderAlertText(alert);
  assert.match(text, /^【提示】/);
  assert.match(text, /已恢复：平台登录已失效/);
  assert.match(text, /round-x-3/);
});

// ── 编排：该静默的时候安静 ──────────────────────────────────────────────────

test('an empty queue ends the round quietly and never touches the notify port', async () => {
  const notify = recordingNotify();
  const state = createMemoryRoundState();
  const receipt = await runOnce({
    notify,
    state,
    schedule: scheduleFixed({
      outcome: 'SKIPPED_EMPTY_QUEUE', scheduled: false, ok: true, humanRequired: false,
      failureClass: null, queueState: 'EMPTY', candidateCount: 0, reasons: ['the queue is empty'],
    }),
  });
  assert.equal(receipt.outcome, 'SKIPPED_EMPTY_QUEUE');
  assert.equal(receipt.notification.status, 'SILENT');
  assert.equal(sends(notify), 0);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.humanRequired, false);
  assert.deepEqual(hasAllFields(receipt), []);
});

test('a round that is not due does not even probe the queue', async () => {
  let probed = 0;
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    due: async () => ({ due: false, source: 'BUSINESS_WINDOW' }),
    schedule: async () => { probed += 1; return { outcome: 'RAN' }; },
  });
  assert.equal(receipt.outcome, 'SKIPPED_NOT_DUE');
  assert.equal(probed, 0);
  assert.equal(sends(notify), 0);
  assert.equal(receipt.due.evaluated, true);
});

test('a business key that already completed today is skipped, quietly', async () => {
  const state = createMemoryRoundState();
  const notify = recordingNotify();
  const first = await runOnce({ state, notify, schedule: scheduleRan() });
  assert.equal(first.outcome, 'COMPLETED');
  assert.equal(sends(notify), 0);
  assert.equal(first.state.completed, true);

  const second = await runOnce({ state, notify, schedule: scheduleRan() });
  assert.equal(second.outcome, 'SKIPPED_ALREADY_DONE');
  assert.equal(second.state.completed, true);
  assert.equal(sends(notify), 0);
});

test('a successful round quietly clears a previously open alert', async () => {
  const state = createMemoryRoundState({
    openAlert: { reason: 'HUMAN_REQUIRED', alertId: 'round-old-1', title: '平台登录已失效', at: NOW_ISO },
  });
  const notify = recordingNotify();
  const receipt = await runOnce({ state, notify, schedule: scheduleRan() });
  assert.equal(receipt.outcome, 'COMPLETED');
  assert.equal(receipt.notification.action, 'RESOLVE');
  assert.equal(sends(notify), 1);
  assert.match(notify.calls[0].alert.title, /^已恢复：/);
  assert.equal(state.peek().openAlert, null);
});

test('a self-healed failure is quiet but recorded as auto-healed', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    schedule: scheduleRan({
      ok: false, failureClass: 'TRANSIENT_EXTERNAL', reasons: ['socket hang up'],
      run: { ok: false, failureClass: 'TRANSIENT_EXTERNAL' },
    }),
    heal: async () => ({ healed: true, reason: 'restart_flow_with_params', attempts: [{ type: 'restart_flow_with_params' }] }),
  });
  assert.equal(receipt.outcome, 'COMPLETED_WITH_HEAL');
  assert.deepEqual(receipt.reasons, ['AUTO_HEALED']);
  assert.equal(sends(notify), 0);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.state.completed, true);
});

// ── 编排：该响的时候响 ──────────────────────────────────────────────────────

test('a health block stops the round before it wastes a collection, and notifies', async () => {
  let probed = 0;
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    healthCheck: async () => ({
      ok: false,
      findings: [{ layer: 'IDENTITY', code: 'ACCOUNT_MISMATCH', state: 'ACCOUNT_MISMATCH', reason: 'HUMAN_REQUIRED', detail: '浏览器里登的是商家账号', blocking: true }],
    }),
    schedule: async () => { probed += 1; return { outcome: 'RAN' }; },
  });
  assert.equal(receipt.outcome, 'BLOCKED_BY_HEALTH');
  assert.equal(probed, 0);
  assert.equal(sends(notify), 1);
  assert.equal(notify.calls[0].decision.key, 'HUMAN_REQUIRED');
  assert.equal(notify.calls[0].alert.reason, '浏览器里登的是商家账号');
  assert.equal(receipt.humanRequired, true);
  assert.equal(exitCodeForRound(receipt), 3);
});

test('a health finding that names no known reason still notifies (fail-closed)', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    healthCheck: async () => ({ ok: false, findings: [{ layer: 'SESSION', code: 'AUTH_EXPIRING', blocking: true }] }),
    schedule: scheduleRan(),
  });
  assert.equal(receipt.outcome, 'BLOCKED_BY_HEALTH');
  assert.equal(notify.calls[0].decision.key, 'HEALTH_BLOCKED');
  assert.equal(notify.calls[0].alert.reason, 'AUTH_EXPIRING');
});

test('a broken health check proceeds but never claims the round was checked', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    healthCheck: async () => { throw new Error('proxy is not reachable'); },
    schedule: scheduleRan(),
  });
  assert.equal(receipt.outcome, 'COMPLETED');
  // 关键：不允许写成 OK。空值不是零，同族。
  assert.equal(receipt.health.status, 'UNKNOWN');
  assert.equal(receipt.health.ok, null);
  assert.match(receipt.health.error, /proxy is not reachable/);
});

test('an unwired health check is reported as not implemented, not as healthy', async () => {
  const receipt = await runOnce({ schedule: scheduleRan() });
  assert.equal(receipt.health.status, 'NOT_IMPLEMENTED');
  assert.equal(receipt.health.ok, null);
  assert.equal(receipt.health.findings.length, 0);
});

test('a human-required failure notifies once with a next step', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    schedule: scheduleRan({
      ok: false, failureClass: 'HUMAN_REQUIRED', reasons: ['requires Xiaowangshen login'],
      run: { ok: false, failureClass: 'HUMAN_REQUIRED' },
    }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.deepEqual(receipt.reasons, ['HUMAN_REQUIRED']);
  assert.equal(sends(notify), 1);
  assert.equal(receipt.humanRequired, true);
  assert.equal(exitCodeForRound(receipt), 3);
  assert.match(notify.calls[0].alert.action, /登录/);
  assert.equal(receipt.heal.attempted, false);
  assert.equal(receipt.heal.reason, 'NO_HEALER_CONFIGURED');
});

test('an unhandled transient failure is escalated, never silently swallowed', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    schedule: scheduleRan({
      ok: false, failureClass: 'TRANSIENT_EXTERNAL', reasons: ['socket hang up'],
      run: { ok: false, failureClass: 'TRANSIENT_EXTERNAL' },
    }),
  });
  // TRANSIENT_EXTERNAL 本身是静默类（它的正常收尾是「自愈处理掉了」），
  // 未处理时必须以升级理由收尾，否则一次真实失败就没了声音。
  assert.notDeepEqual(receipt.reasons, ['TRANSIENT_EXTERNAL']);
  assert.deepEqual(receipt.reasons, ['ESCALATED_HUMAN']);
  assert.equal(sends(notify), 1);
  assert.equal(escalationReasonFor('TRANSIENT_EXTERNAL'), 'ESCALATED_HUMAN');
  assert.equal(escalationReasonFor('HUMAN_REQUIRED'), 'HUMAN_REQUIRED');
  assert.equal(escalationReasonFor(null), 'ESCALATED_HUMAN');
});

test('an exhausted heal budget reports the attempt count in the next step', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    maxAttemptsPerDay: 1,
    schedule: scheduleRan({ ok: false, failureClass: 'HUMAN_REQUIRED', run: { ok: false, failureClass: 'HUMAN_REQUIRED' } }),
    heal: async () => ({ healed: false, reason: 'BUDGET_EXHAUSTED', budgetExhausted: true }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.deepEqual(receipt.reasons, ['BUDGET_EXHAUSTED']);
  assert.equal(receipt.state.closed, true);
  assert.match(notify.calls[0].alert.action, /已自动尝试 1 次/);
});

test('repeating the same failure notifies once and is deduped afterwards', async () => {
  const state = createMemoryRoundState();
  const notify = recordingNotify();
  const failing = scheduleRan({ ok: false, failureClass: 'HUMAN_REQUIRED', run: { ok: false, failureClass: 'HUMAN_REQUIRED' } });
  const first = await runOnce({ state, notify, schedule: failing });
  const second = await runOnce({ state, notify, schedule: failing, now: at('2026-09-15T09:15:00+08:00') });
  assert.deepEqual(first.reasons, ['HUMAN_REQUIRED']);
  assert.equal(sends(notify), 1);
  assert.equal(second.notification.status, 'DEDUPED');
  assert.equal(second.notification.previousAlertId, first.notification.alertId);
  assert.equal(sends(notify), 1);
});

test('a non-retryable failure closes the day instead of retrying every 15 minutes', async () => {
  const state = createMemoryRoundState();
  const notify = recordingNotify();
  const receipt = await runOnce({
    state,
    notify,
    schedule: scheduleRan({ ok: false, failureClass: 'POLICY_DENIED', run: { ok: false, failureClass: 'POLICY_DENIED' } }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.equal(receipt.state.closed, true);
  assert.equal(receipt.state.closedReason, 'NO_AUTO_RETRY:POLICY_DENIED');
  assert.ok(NO_AUTO_RETRY_REASONS.includes('POLICY_DENIED'));
  assert.ok(AUTO_RETRY_REASONS.includes('HUMAN_REQUIRED'));

  const later = await runOnce({ state, notify, schedule: scheduleRan(), now: at('2026-09-15T09:15:00+08:00') });
  assert.equal(later.outcome, 'SKIPPED_ALREADY_DONE');
  assert.equal(later.due.source, 'DAY_CLOSED');
  assert.equal(sends(notify), 1);
});

test('a retryable failure keeps retrying until the daily attempt cap', async () => {
  const state = createMemoryRoundState();
  const notify = recordingNotify();
  const failing = scheduleRan({ ok: false, failureClass: 'HUMAN_REQUIRED', run: { ok: false, failureClass: 'HUMAN_REQUIRED' } });
  const first = await runOnce({ state, notify, schedule: failing });
  const second = await runOnce({ state, notify, schedule: failing, now: at('2026-09-15T09:15:00+08:00') });
  const third = await runOnce({ state, notify, schedule: failing, now: at('2026-09-15T09:30:00+08:00') });
  assert.equal(first.state.attemptsToday, 1);
  assert.equal(second.state.attemptsToday, 2);
  assert.equal(third.state.attemptsToday, 3);
  assert.equal(third.state.closed, true);
  assert.equal(third.state.closedReason, 'ATTEMPTS_EXHAUSTED');
  assert.equal(sends(notify), 1); // 三次失败只有一条告警
});

test('a round that starts a run but fails keeps the business key open', async () => {
  const state = createMemoryRoundState();
  const receipt = await runOnce({
    state,
    schedule: scheduleRan({ ok: false, failureClass: 'HUMAN_REQUIRED', run: { ok: false, failureClass: 'HUMAN_REQUIRED' } }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.deepEqual(state.peek().completed, {});
  assert.equal(receipt.state.completed, false);
});

// ── 编排：收据与异常路径 ────────────────────────────────────────────────────

test('an unrecognized scheduler receipt is an orchestration defect, not a silent success', async () => {
  const notify = recordingNotify();
  for (const bad of [{ outcome: 'PROBED_ONLY' }, { outcome: undefined }, { nothing: true }]) {
    const receipt = await runOnce({ notify, schedule: scheduleFixed(bad) });
    assert.equal(receipt.outcome, 'ERROR', JSON.stringify(bad));
    assert.deepEqual(receipt.reasons, ['ROUND_ERROR']);
    assert.equal(receipt.ok, false);
    assert.equal(exitCodeForRound(receipt), 4);
  }
  assert.equal(sends(notify), 3);
  assert.ok(SCHEDULER_OUTCOMES_WITHIN_ROUND.length === 4);
});

test('a scheduler port that throws becomes ROUND_ERROR, not a crash', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({ notify, schedule: async () => { throw new Error('registry is broken'); } });
  assert.equal(receipt.outcome, 'ERROR');
  assert.match(receipt.finishedAt, /^\d{4}-/);
  assert.equal(sends(notify), 1);
  assert.equal(notify.calls[0].decision.key, 'ROUND_ERROR');
});

test('a failed delivery is recorded but does not change the round outcome', async () => {
  const notify = recordingNotify({ status: 'FAILED', error: 'command failed with exit 1' });
  const state = createMemoryRoundState();
  const receipt = await runOnce({
    state,
    notify,
    schedule: scheduleRan({ ok: false, failureClass: 'HUMAN_REQUIRED', run: { ok: false, failureClass: 'HUMAN_REQUIRED' } }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.equal(receipt.notification.status, 'FAILED');
  assert.match(receipt.notification.error, /exit 1/);
  // 没送出去就不能记「已经通知过」——否则下一次会被去重掉，人永远收不到。
  assert.equal(state.peek().openAlert, null);
});

test('a notify port that throws does not break the round either', async () => {
  const state = createMemoryRoundState();
  const receipt = await runOnce({
    state,
    notify: async () => { throw new Error('fetch exploded'); },
    schedule: scheduleRan({ ok: false, failureClass: 'BUG', run: { ok: false, failureClass: 'BUG' } }),
  });
  assert.equal(receipt.outcome, 'FAILED');
  assert.equal(receipt.notification.status, 'FAILED');
  assert.match(receipt.notification.error, /fetch exploded/);
  assert.equal(state.peek().openAlert, null);
});

test('a missing notify port is recorded as not configured, never as silent', async () => {
  const receipt = await runOnce({
    notify: null,
    schedule: scheduleRan({ ok: false, failureClass: 'BUG', run: { ok: false, failureClass: 'BUG' } }),
  });
  assert.equal(receipt.notification.status, 'NOT_CONFIGURED');
  assert.equal(receipt.notification.key, 'BUG');
});

test('every outcome carries the full receipt field set', async () => {
  const cases = [
    { schedule: scheduleRan() },
    { due: async () => false, schedule: scheduleRan() },
    { schedule: scheduleFixed({ outcome: 'SKIPPED_EMPTY_QUEUE', ok: true, scheduled: false }) },
    { schedule: scheduleFixed({ outcome: 'PAUSED_FOR_HUMAN', ok: true, scheduled: false, humanRequired: true, failureClass: 'HUMAN_REQUIRED', probe: { state: 'WAITING_HUMAN', probed: true, reason: '2 rows awaiting settlement' } }) },
    { healthCheck: async () => ({ ok: false, findings: [{ layer: 'ENVIRONMENT', reason: 'HEALTH_BLOCKED', blocking: true }] }), schedule: scheduleRan() },
    { schedule: scheduleRan({ ok: false, failureClass: 'BUG', run: { ok: false, failureClass: 'BUG' } }) },
    { schedule: async () => { throw new Error('boom'); } },
  ];
  const outcomes = [];
  for (const item of cases) {
    const receipt = await runOnce({ notify: recordingNotify(), ...item });
    assert.deepEqual(hasAllFields(receipt), [], receipt.outcome);
    assert.equal(typeof receipt.ok, 'boolean', receipt.outcome);
    assert.equal(typeof receipt.humanRequired, 'boolean', receipt.outcome);
    assert.equal(typeof receipt.notification.status, 'string', receipt.outcome);
    assert.ok(Array.isArray(receipt.steps) && receipt.steps.length > 0, receipt.outcome);
    outcomes.push(receipt.outcome);
  }
  assert.deepEqual(outcomes, [
    'COMPLETED', 'SKIPPED_NOT_DUE', 'SKIPPED_EMPTY_QUEUE', 'PAUSED_FOR_HUMAN',
    'BLOCKED_BY_HEALTH', 'FAILED', 'ERROR',
  ]);
});

test('a paused queue notifies because a human has to settle it', async () => {
  const notify = recordingNotify();
  const receipt = await runOnce({
    notify,
    schedule: scheduleFixed({
      outcome: 'PAUSED_FOR_HUMAN', ok: true, scheduled: false, humanRequired: true,
      failureClass: 'HUMAN_REQUIRED', queueState: 'WAITING_HUMAN',
      probe: { state: 'WAITING_HUMAN', probed: true, reason: '2 populated row(s) are still awaiting settlement' },
    }),
  });
  assert.equal(receipt.outcome, 'PAUSED_FOR_HUMAN');
  assert.deepEqual(receipt.reasons, ['WAITING_HUMAN']);
  assert.equal(sends(notify), 1);
  assert.match(notify.calls[0].alert.reason, /awaiting settlement/);
  assert.equal(exitCodeForRound(receipt), 3);
});

test('the day key is local, not UTC', () => {
  // 本机 2026-09-15 00:30（+08:00）= UTC 2026-09-14 16:30。用 UTC 会把这一轮记到前一天。
  assert.equal(localDayKey(new Date('2026-09-15T00:30:00+08:00').valueOf()), '2026-09-15');
  assert.equal(localDayKey(new Date('2026-09-15T23:30:00+08:00').valueOf()), '2026-09-15');
});

test('the round CLI parser handles its own boolean flag', () => {
  const args = parseRoundArgs([
    '--capability', 'xws.sku.collection',
    '--identity', '{"tenantId":"t1"}',
    '--business-key', BUSINESS_KEY,
    '--force',
  ]);
  assert.equal(args.force, true);
  assert.equal(args.capability, 'xws.sku.collection');
  assert.equal(args.businessKey, BUSINESS_KEY);
  // 布尔开关不能漏给下游解析器（它要求任何 --x 都跟一个值）。
  assert.throws(() => parseRoundArgs(['--capability', 'x', '--force', '--identity', '{}', '--business-key', 'k', '--nope']));
});

test('计划报告全量给出字段，尤其是「上一次触发过去多久」', () => {
  // 到期口径是「只算触发日当天」，所以「漏了」在计划里必须看得见——这是选那个口径的前提。
  // 少一个字段不会报错，只会让「漏跑可见」变成一句空话，所以这里按**全量字段**钉住。
  const entry = {
    name: 'weekly-competitor',
    enabled: true,
    capability: 'sycm.feishu.weekly',
    when: { kind: 'weekly', weekday: 'MO', at: '09:00' },
    period: { kind: 'PREVIOUS_WEEK_SUN_SAT' },
    identity: {
      tenantId: 'sycm', storeId: 'bathtub-industry', platform: 'sycm',
      accountId: 'operator', browserProfileId: 'local', contractVersion: 'sycm-weekly-v1',
    },
  };
  const schedule = { version: ROUND_SCHEDULE_VERSION, rounds: [entry] };
  const now = new Date('2026-09-15T12:00:00+08:00').valueOf();
  const report = buildPlanReport({ scheduleFile: 'runtime/round-schedule.json', now, plan: planSchedule(schedule, now) });

  assert.equal(report.ok, true);
  assert.equal(report.scheduleFile, 'runtime/round-schedule.json');
  assert.equal(report.now, new Date(now).toISOString());
  assert.equal(report.rounds.length, 1);
  const row = report.rounds[0];
  assert.deepEqual(Object.keys(row).sort(), [...PLAN_REPORT_FIELDS].sort());
  for (const field of PLAN_REPORT_FIELDS) {
    assert.ok(Object.hasOwn(row, field), `plan row must carry ${field}`);
  }
  // 周二 12:00 看周一 09:00 那次：不到期，但必须看得见它已经过去 27 小时。
  assert.equal(row.due, false);
  assert.equal(row.isLastTriggerToday, false);
  assert.equal(row.hoursSinceTriggerAt, 27);
  assert.equal(row.triggerAt, new Date('2026-09-14T09:00:00+08:00').toISOString());
  assert.equal(row.nextTriggerAt, new Date('2026-09-21T09:00:00+08:00').toISOString());
  // 计划里**不许**出现「跑没跑过」的结论字段：那是运行账本的事，排期层没资格说。
  assert.equal(Object.hasOwn(row, 'ran'), false);
  assert.equal(Object.hasOwn(row, 'missed'), false);
});

// ── 体检接线（实施计划第 4 步）───────────────────────────────────────────────
//
// 这一组守三件事，都是「错了不会报错、只会让体检停止工作或开始撒谎」的那一类：
//   1. 不写 healthCheck ⇒ 与接线前**逐字相同**（不体检，收据里 NOT_IMPLEMENTED）；
//   2. 体检自己写的「哪几层没检查过」必须进收据（否则 L0/L2/L3 的缺席会被读成通过）；
//   3. 声明的浏览器与路线矛盾 ⇒ **启动时**报错（否则体检会在另一台浏览器上跑出漂亮的绿灯，
//      而这一轮要用的那台根本没被看过 —— 假绿灯比红灯危害大）。

// 假注册表：只回答 skillDir。技能名一律用**真实登记表里的名字**（`xws-sku-collection` 在竞品链上），
// 这样这一段读的是登记表的真实内容，而不是我另编的一张小表。
const fakeRegistry = (skillDir) => ({ entryFor: () => ({ skillDir }) });
const SKU_SKILL = 'D:\\Retire\\sycm-automation\\skills\\xws-sku-collection';

test('体检默认关闭：不写 healthCheck 就与接线前逐字相同', async () => {
  assert.equal(healthCheckFromEntry({ capability: 'fake.cap' }, { registry: fakeRegistry(SKU_SKILL) }), null);
  assert.equal(healthCheckFromEntry({ capability: 'fake.cap', healthCheck: false }, {}), null);
  // JSON 里写不出 undefined，显式 null 是常见写法，必须与「不写」同义。
  assert.equal(healthCheckFromEntry({ capability: 'fake.cap', healthCheck: null }, {}), null);

  const receipt = await runOnce({ schedule: scheduleRan() });
  assert.equal(receipt.health.status, 'NOT_IMPLEMENTED');
  assert.equal(receipt.health.ok, null);
  assert.equal(receipt.health.layers, null);
});

test('写了 healthCheck: true ⇒ 按能力推导出浏览器，不用运维手填', () => {
  const derived = deriveBrowserForCapability({ capabilityId: 'xws.sku.collection', registry: fakeRegistry(SKU_SKILL) });
  assert.equal(derived.browser, 'competitor');
  assert.equal(derived.route, 'competitor');
  assert.equal(typeof healthCheckFromEntry({ capability: 'xws.sku.collection', healthCheck: true }, { registry: fakeRegistry(SKU_SKILL) }), 'function');
});

test('能力未注册又没写浏览器 ⇒ 报错停跑，不猜一个默认浏览器', () => {
  assert.throws(
    () => healthCheckFromEntry({ capability: 'sycm.daily-report', healthCheck: true }, { registry: fakeRegistry('') }),
    (error) => error.code === 'HEALTH_BROWSER_UNDETERMINED',
  );
});

test('声明的浏览器与能力所属路线矛盾 ⇒ 报错（这条闸门堵的就是假绿灯）', () => {
  assert.throws(
    () => healthCheckFromEntry({ capability: 'xws.sku.collection', healthCheck: { browser: 'dailyReport' } }, { registry: fakeRegistry(SKU_SKILL) }),
    (error) => error.code === 'HEALTH_BROWSER_MISMATCH',
  );
});

test('浏览器键根本不存在 ⇒ 与「矛盾」分开报（打错字不该被说成路线冲突，排查方向会偏）', () => {
  assert.throws(
    () => healthCheckFromEntry({ capability: 'xws.sku.collection', healthCheck: { browser: 'nope' } }, { registry: fakeRegistry(SKU_SKILL) }),
    (error) => error.code === 'HEALTH_BROWSER_UNKNOWN',
  );
});

test('能力走的路线不开浏览器 ⇒ 报错要说清是「没有浏览器可查」', () => {
  const derived = deriveBrowserForCapability({
    capabilityId: 'xws.feishu.import',
    registry: fakeRegistry('D:\\Retire\\sycm-automation\\skills\\xws-to-feishu-base'),
  });
  assert.equal(derived.browser, null);
  assert.match(derived.reason, /do not open a browser/u);
});

test('开了 pages 却判不出是哪条路线 ⇒ 报错（不许随便挑一条路线的页面来数）', () => {
  // 真实例子：日报链的能力此刻还没注册进清单，所以它开 pages 会被拒 —— 这是对的，
  // 它逼着我们先把能力登记进 manifest（那里才是「这条链要什么前置条件」的权威之处）。
  assert.throws(
    () => healthCheckFromEntry(
      { capability: 'sycm.daily-report', healthCheck: { browser: 'dailyReport', pages: true } },
      { registry: fakeRegistry('') },
    ),
    (error) => error.code === 'HEALTH_PAGES_UNDETERMINED',
  );
});

test('排期条目里写的 healthCheck 会一路走到收据（含体检自己的 note 与逐层状态）', async () => {
  const receipt = await runOnce({
    healthCheck: async () => ({
      ok: true,
      findings: [],
      layers: { IDENTITY: 'NOT_IMPLEMENTED', ENVIRONMENT: 'CHECKED' },
      note: '已跑 ENVIRONMENT；未实现的层：IDENTITY/SESSION/END_TO_END（这几层没有检查过，不表示通过）',
    }),
    schedule: scheduleRan(),
  });
  assert.equal(receipt.health.status, 'OK');
  // 这一步在接线前会红：`normalizeHealthResult` 曾把 note 丢掉（写死 note: null），
  // 于是「没做过的检查」在收据里只剩一个 OK —— 正是实施计划第 4 步禁止的假绿。
  // 先断言「note 没丢」，再说它写了什么：只留后面那条 match，丢了 note 时的报错是
  // 「match 收到 null」，看不出是谁的错。
  assert.equal(typeof receipt.health.note, 'string', '体检自己写的 note 被丢掉了');
  assert.match(receipt.health.note, /未实现的层/u);
  assert.equal(receipt.health.layers.IDENTITY, 'NOT_IMPLEMENTED');
  // 运营/运维看的是步骤那一行，note 必须出现在那里，而不是只藏在 JSON 深处。
  const step = receipt.steps.find((item) => item.step === 'HEALTH');
  assert.match(step.detail, /未实现的层/u);
});

test('buildRound 要把体检端口转交给 runRound（源码级检查，补行为用例够不到的那一环）', () => {
  // 为什么这里看源码：`buildRound` 是 `main()` 里的闭包，离线用例构造不出来。
  // 而它写错的后果是**静默**的 —— 比如把 `opts.healthCheck` 打成别的键，
  // 体检就永远不跑，收据里落成 NOT_IMPLEMENTED，和「这条排期没开体检」长得一模一样。
  // 源码级检查弱于行为检查（一次合法重构就可能要跟着改），但它比「没人看这一行」强，
  // 所以只钉住一件事：这个键被转交。格式允许变（不匹配空白），匹配的是语义不是排版。
  const source = readFileSync(new URL('./round-runner.mjs', import.meta.url), 'utf8');
  assert.match(source, /healthCheck:\s*opts\.healthCheck/u);
  // 反向断言：不许再退回硬写 null（那等于接线只接了半条 —— 配置开了也不生效）。
  assert.doesNotMatch(source, /healthCheck:\s*null,\s*\n\s*heal:/u);
});
