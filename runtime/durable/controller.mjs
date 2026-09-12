// Durable Run Controller（S1）：真实执行、验证、幂等提交、CAS 推进、租约释放、崩溃恢复。
// 设计文档 6.4/7.3：恢复从 PG 权威状态开始；"状态改善"必须用 cursor/commit/lease 证据链证明。

import { randomUUID } from 'node:crypto';

/**
 * 执行一个授权分片。capability/validator/verify 由 Controller 注入（生产接 XWS CLI，
 * 测试注入真实子进程或桩），本模块只拥有状态机与恢复语义。
 *
 * @param opts { state, runId, from, to, attemptId?, owner?,
 *                capability({from,to,attemptId}) -> {artifactDigest, artifactRef, rows},
 *                validator(artifact) -> {ok, reasons},
 *                verifyCommit(commit) -> {consistent:boolean}  外部回读 }
 */
export async function executeShard(opts) {
  const { state, runId, from, to, capability, validator, verifyCommit } = opts;
  const attemptId = opts.attemptId ?? `attempt-${randomUUID()}`;
  const owner = opts.owner ?? `worker-${process.pid}`;

  const lease = await state.claimLease({ runId, attemptId, owner });
  if (!lease.claimed) {
    return { status: 'RESOURCE_BUSY', attemptId, holder: lease.holder, holderAttempt: lease.holderAttempt };
  }

  try {
    // 心跳：长任务期间证明 worker 存活（30 秒间隔；capability 结束后清除）
    const heartbeatTimer = setInterval(() => {
      state.heartbeat(runId, attemptId).catch(() => {});
    }, 30_000);
    heartbeatTimer.unref?.();

    let artifact;
    try {
      artifact = await capability({ from, to, attemptId });
    } finally {
      clearInterval(heartbeatTimer);
    }

    const validation = await validator(artifact);
    if (!validation.ok) {
      // EVIDENCE_INVALID：拒绝工件，不推进 cursor，不提交
      return { status: 'EVIDENCE_INVALID', attemptId, reasons: validation.reasons ?? [] };
    }

    // 幂等提交：同 key 已存在则不产生第二次业务效果
    const commit = await state.createCommit({
      runId, attemptId, from, to, artifactDigest: artifact.artifactDigest,
    });

    if (commit.status === 'READY' || commit.status === 'COMMITTING') {
      await state.markCommit(commit.commit_key, 'COMMITTING');
      // （外部写入发生在这一步；进程可在此刻死亡 → COMMITTING 残留 → 恢复时判 UNKNOWN）
      await state.markCommit(commit.commit_key, 'COMMITTED');
    }

    // 外部回读验证：不一致 → UNKNOWN，进对账，不推进 cursor
    const current = await state.getCommit(commit.commit_key);
    const readback = verifyCommit ? await verifyCommit(current) : { consistent: true };
    if (!readback.consistent) {
      await state.markCommit(commit.commit_key, 'UNKNOWN');
      return { status: 'COMMIT_UNKNOWN', attemptId, commitKey: commit.commit_key };
    }
    await state.markCommit(commit.commit_key, 'VERIFIED');

    // CAS 推进游标：expected = 提交前权威值
    const run = await state.getRun(runId);
    const advanced = await state.casCursor(runId, run.verified_cursor, to);
    if (!advanced) {
      return { status: 'CAS_FAILED', attemptId, commitKey: commit.commit_key,
        note: '游标已被其他 attempt 推进——本次提交幂等，无重复业务效果' };
    }

    const released = await state.releaseLease(runId, attemptId);
    return {
      status: 'SUCCEEDED', attemptId, commitKey: commit.commit_key,
      cursor: advanced.verified_cursor, cursorVersion: advanced.cursor_version,
      leaseReleased: released,
    };
  } catch (error) {
    return { status: 'ATTEMPT_FAILED', attemptId, error: error.message };
  }
}

/**
 * 崩溃恢复：读 PG 权威状态，找到最后已验证边界，给出合法续跑位置与待办。
 * 顺序（设计文档 7.3）：过期租约回收 → 未知提交对账 → 游标落后于已验证提交则补 CAS → 返回 resume。
 */
export async function recoverRun({ state, runId, verifyCommit = null, heartbeatStaleSeconds = 120 }) {
  const run = await state.getRun(runId);
  if (!run) return { status: 'NOT_FOUND' };

  // 1. 回收死租约：TTL 到点或心跳超时（不认领未知资源）
  const expiredLeases = await state.expireStaleLeases(runId, heartbeatStaleSeconds);

  // 2. 提交对账：COMMITTING / UNKNOWN 一律先对账
  const commits = await state.listCommits(runId);
  const needsReconcile = commits.filter((c) => c.status === 'COMMITTING' || c.status === 'UNKNOWN');
  const reconciled = [];
  for (const commit of needsReconcile) {
    const readback = verifyCommit ? await verifyCommit(commit) : { consistent: true };
    if (readback.consistent) {
      await state.markCommit(commit.commit_key, 'COMMITTED');
      await state.markCommit(commit.commit_key, 'VERIFIED');
      reconciled.push({ commitKey: commit.commit_key, outcome: 'VERIFIED' });
    } else {
      reconciled.push({ commitKey: commit.commit_key, outcome: 'STILL_UNKNOWN' });
    }
  }

  // 3. 已验证提交但游标未推进（commit-before-cursor 崩溃）→ 补 CAS
  const fresh = await state.getRun(runId);
  const verifiedCommits = (await state.listCommits(runId)).filter((c) => c.status === 'VERIFIED');
  let cursorRepaired = null;
  for (const commit of verifiedCommits) {
    const end = Number(commit.target.match(/pages:(\d+)-(\d+)/u)?.[2] ?? 0);
    if (end > fresh.verified_cursor) {
      const advanced = await state.casCursor(runId, fresh.verified_cursor, end);
      if (advanced) {
        cursorRepaired = { from: fresh.verified_cursor, to: end };
        fresh.verified_cursor = end;
      }
    }
  }

  // 4. 活跃租约仍有效 → 有 worker 在跑，不重复认领
  const { rows: activeLeases } = await state.pool.query(
    `SELECT attempt_id, lease_owner, lease_expires_at FROM durable_attempts
     WHERE run_id=$1 AND lease_state='HELD' AND lease_expires_at > now()`,
    [runId],
  );

  return {
    status: activeLeases.length ? 'RUNNING_ELSEWHERE' : 'RESUMABLE',
    runId,
    verifiedCursor: fresh.verified_cursor,
    resumeFrom: fresh.verified_cursor + 1,
    targetEnd: fresh.target_end,
    expiredLeases,
    reconciled,
    cursorRepaired,
    activeLease: activeLeases[0] ?? null,
    finalExecutionStatus: fresh.verified_cursor >= fresh.target_end ? 'SUCCEEDED' : fresh.execution_status,
  };
}
