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
  ROUND_RECEIPT_FIELDS,
  SCHEDULER_OUTCOMES_WITHIN_ROUND,
  createMemoryRoundState,
  escalationReasonFor,
  exitCodeForRound,
  localDayKey,
  parseRoundArgs,
  runRound,
} from './round-runner.mjs';

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
