// run-liveness 单元测试：回收决策的两个判据必须分开成立，且都不许「看起来像」就放行。
//
// 这些用例刻意把两个判据**交叉**断言（同样是「租约过期」，publication=NOT_REQUESTED 可回收、
// publication=UNKNOWN 不可回收），因为把它们合成一个判据正是缺口 B 的成因。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessRunLiveness,
  assessReclaimSafety,
  reclaimGuidance,
  RECLAIM_CANDIDATE_PUBLICATION,
} from './run-liveness.mjs';
import { COMMIT_STATUS, COMMIT_HANDED_OFF, COMMIT_NOT_HANDED_OFF } from './side-effect-ledger.mjs';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function attempt({ status = 'RUNNING', expiresInMs = -60_000 } = {}) {
  return { attemptId: 'a-1', status, leaseState: expiresInMs === null ? 'RELEASED' : 'HELD', leaseExpiresAt: expiresInMs === null ? null : iso(expiresInMs) };
}

function run({ executionStatus = 'RUNNING', publicationStatus = 'NOT_REQUESTED', updatedAgoMs = 0 } = {}) {
  return {
    runId: 'r-1',
    executionStatus,
    context: { executionStatus, publicationStatus, updatedAt: iso(-updatedAgoMs) },
    updatedAt: iso(-updatedAgoMs),
  };
}

test('持有效租约的运行是活的——无论它看起来等了多久', () => {
  const verdict = assessRunLiveness({
    run: run({ updatedAgoMs: 6 * 60 * 60 * 1000 }),
    attempts: [attempt({ expiresInMs: 60_000 })],
    nowMs: NOW,
  });
  assert.equal(verdict.active, true);
  assert.equal(verdict.reclaimable, false);
  assert.equal(verdict.reason, 'LEASE_HELD');
});

test('租约已过期的运行可证已死', () => {
  const verdict = assessRunLiveness({ run: run(), attempts: [attempt({ expiresInMs: -1 })], nowMs: NOW });
  assert.equal(verdict.reclaimable, true);
  assert.equal(verdict.reason, 'LEASE_EXPIRED');
  assert.equal(verdict.openAttempts, 1);
  assert.equal(verdict.liveAttempts, 0);
});

test('租约宽限期能吸收时钟抖动，但过了宽限期就必须判死', () => {
  const attempts = [attempt({ expiresInMs: -1 })];
  assert.equal(assessRunLiveness({ run: run(), attempts, nowMs: NOW, leaseGraceMs: 5_000 }).reason, 'LEASE_HELD');
  assert.equal(assessRunLiveness({ run: run(), attempts, nowMs: NOW, leaseGraceMs: 0 }).reason, 'LEASE_EXPIRED');
});

test('RUNNING 却一个开放 attempt 都没有：崩在状态写回与开 attempt 之间', () => {
  const verdict = assessRunLiveness({ run: run(), attempts: [], nowMs: NOW });
  assert.equal(verdict.reclaimable, true);
  assert.equal(verdict.reason, 'RUNNING_WITHOUT_ATTEMPT');
});

test('PAUSED（等人工）与 RETRY_WAIT（等退避）都是合法等待，绝不回收', () => {
  for (const executionStatus of ['PAUSED', 'RETRY_WAIT', 'QUEUED']) {
    const verdict = assessRunLiveness({
      run: run({ executionStatus, updatedAgoMs: 72 * 60 * 60 * 1000 }),
      attempts: [],
      nowMs: NOW,
      // 就算给了阈值也不该动 PAUSED/RETRY_WAIT：只有 QUEUED 才可能被判成「入队后没人管」。
      abandonedAfterMs: 1000,
    });
    if (executionStatus === 'QUEUED') {
      assert.equal(verdict.reclaimable, true);
      assert.equal(verdict.reason, 'ABANDONED_QUEUE');
    } else {
      assert.equal(verdict.reclaimable, false, `${executionStatus} 不该被回收`);
      assert.equal(verdict.reason, 'WAITING');
    }
  }
});

test('不给阈值时 QUEUED 一律不回收：多久算遗弃必须由调用方显式说出', () => {
  const verdict = assessRunLiveness({ run: run({ executionStatus: 'QUEUED', updatedAgoMs: 30 * 24 * 60 * 60 * 1000 }), attempts: [], nowMs: NOW });
  assert.equal(verdict.reclaimable, false);
  assert.equal(verdict.reason, 'WAITING');
});

test('终态运行既不 active 也不 reclaimable', () => {
  for (const executionStatus of ['SUCCEEDED', 'FAILED']) {
    const verdict = assessRunLiveness({ run: run({ executionStatus }), attempts: [], nowMs: NOW });
    assert.equal(verdict.active, false);
    assert.equal(verdict.reclaimable, false);
    assert.equal(verdict.reason, 'TERMINAL');
  }
});

test('NOT_REQUESTED 从未可能调用 handler：连提交记录都不需要就判安全', () => {
  const safety = assessReclaimSafety({ run: run({ publicationStatus: 'NOT_REQUESTED' }), commits: null });
  assert.equal(safety.safe, true);
  assert.equal(safety.reason, 'NO_PUBLICATION_REQUESTED');
});

test('READY 而拿不到提交记录：fail-closed 判不安全（猜错就是重复外部写入）', () => {
  const safety = assessReclaimSafety({ run: run({ publicationStatus: 'READY' }), commits: null });
  assert.equal(safety.safe, false);
  assert.equal(safety.reason, 'COMMIT_STATE_UNKNOWN');
});

test('READY + 提交记录停在 READY/FAILED：handler 从未被交付，可安全回收', () => {
  for (const status of COMMIT_NOT_HANDED_OFF) {
    const safety = assessReclaimSafety({
      run: run({ publicationStatus: 'READY' }),
      commits: [{ commitKey: 'ck-1', status }],
    });
    assert.equal(safety.safe, true, `${status} 应该被当成「未交付 handler」`);
    assert.equal(safety.reason, 'COMMIT_NEVER_HANDED_OFF');
  }
});

test('READY + 提交记录停在 COMMITTING：进程死在 handler 执行中，回收就是重复写入', () => {
  const safety = assessReclaimSafety({
    run: run({ publicationStatus: 'READY' }),
    commits: [{ commitKey: 'ck-1', status: 'COMMITTING' }],
  });
  assert.equal(safety.safe, false);
  assert.equal(safety.reason, 'COMMIT_NOT_TERMINAL');
  assert.deepEqual(safety.blocking, [{ commitKey: 'ck-1', status: 'COMMITTING' }]);
});

test('同一份「租约过期」的死运行，发布轴状态不同则结论相反', () => {
  const deadAttempts = [attempt({ expiresInMs: -1 })];
  const stale = assessRunLiveness({ run: run(), attempts: deadAttempts, nowMs: NOW });
  assert.equal(stale.reclaimable, true);

  const safe = assessReclaimSafety({ run: run({ publicationStatus: 'NOT_REQUESTED' }), commits: [] });
  const unsafe = assessReclaimSafety({ run: run({ publicationStatus: 'UNKNOWN' }), commits: [] });
  assert.equal(safe.safe, true);
  assert.equal(unsafe.safe, false);
  assert.equal(unsafe.reason, 'PUBLICATION_IN_FLIGHT');
});

test('COMMITTED / UNKNOWN / VERIFIED 一律不可回收，只有对账这一条路', () => {
  for (const publicationStatus of ['COMMITTED', 'UNKNOWN', 'VERIFIED']) {
    const safety = assessReclaimSafety({ run: run({ publicationStatus }), commits: [] });
    assert.equal(safety.safe, false, `${publicationStatus} 不该被回收`);
    assert.equal(safety.reason, 'PUBLICATION_IN_FLIGHT');
    const guidance = reclaimGuidance({
      liveness: assessRunLiveness({ run: run(), attempts: [attempt({ expiresInMs: -1 })], nowMs: NOW }),
      safety,
    });
    assert.match(guidance, /reconcilePublication/);
  }
});

test('回收候选发布态只有 NOT_REQUESTED 与 READY（供报错信息引用）', () => {
  assert.deepEqual([...RECLAIM_CANDIDATE_PUBLICATION], ['NOT_REQUESTED', 'READY']);
});

test('guidance 把「活的」与「安全的」说成两件事，不混成一句', () => {
  const live = reclaimGuidance({ liveness: { active: true, reclaimable: false, reason: 'LEASE_HELD' }, safety: { safe: true } });
  assert.match(live, /do not reclaim/);
  const stale = reclaimGuidance({ liveness: { active: true, reclaimable: true, reason: 'LEASE_EXPIRED' }, safety: { safe: true } });
  assert.match(stale, /safe to reclaim/);
  const blocked = reclaimGuidance({ liveness: { active: true, reclaimable: true, reason: 'LEASE_EXPIRED' }, safety: { safe: false, reason: 'PUBLICATION_IN_FLIGHT' } });
  assert.match(blocked, /not safe to reclaim/);
});

test('「未交付 handler」的判据是从账本唯一清单推导出的补集，不是第二份手抄', () => {
  const derived = COMMIT_STATUS.filter((status) => !COMMIT_HANDED_OFF.includes(status));
  assert.deepEqual([...COMMIT_NOT_HANDED_OFF].sort(), derived.sort());
  assert.equal(COMMIT_HANDED_OFF.length + COMMIT_NOT_HANDED_OFF.length, COMMIT_STATUS.length);
  assert.ok(COMMIT_HANDED_OFF.includes('COMMITTING'), 'COMMITTING 必须算「可能已交付」：进程死在 handler 执行中');
  assert.ok(!COMMIT_NOT_HANDED_OFF.includes('COMMITTING'));
});
