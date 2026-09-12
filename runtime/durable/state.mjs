// Durable 状态层（S1，SUPERVISOR-AGENT-DESIGN.md 第 2/7 节）。
// PostgreSQL 是唯一权威：Run/Attempt/Lease/verified cursor（CAS）/CommitRecord。
// 所有恢复从这里开始，不从内存、日志或模型记忆恢复。

export class DurableState {
  constructor(pool) {
    this.pool = pool;
  }

  async createRun({ runId, identity, targetEnd }) {
    await this.pool.query(
      `INSERT INTO durable_runs (run_id, identity, target_end) VALUES ($1,$2,$3)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, JSON.stringify(identity), targetEnd],
    );
    return this.getRun(runId);
  }

  async getRun(runId) {
    const { rows } = await this.pool.query(
      'SELECT run_id, identity, execution_status, verified_cursor, cursor_version, target_end FROM durable_runs WHERE run_id=$1',
      [runId],
    );
    return rows[0] ?? null;
  }

  async setExecutionStatus(runId, status) {
    await this.pool.query(
      'UPDATE durable_runs SET execution_status=$2, updated_at=now() WHERE run_id=$1',
      [runId, status],
    );
  }

  /** 创建 Attempt 并竞争租约：同 run 只允许一个未过期的 HELD。 */
  async claimLease({ runId, attemptId, owner, ttlSeconds = 600 }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: runRows } = await client.query(
        'SELECT verified_cursor, target_end FROM durable_runs WHERE run_id=$1 FOR UPDATE',
        [runId],
      );
      if (!runRows.length) throw new Error(`run 不存在: ${runId}`);
      const active = await client.query(
        `SELECT attempt_id, lease_owner FROM durable_attempts
         WHERE run_id=$1 AND lease_state='HELD' AND lease_expires_at > now()`,
        [runId],
      );
      if (active.rows.length) {
        await client.query('ROLLBACK');
        return { claimed: false, holder: active.rows[0].lease_owner, holderAttempt: active.rows[0].attempt_id };
      }
      const { rows: noRows } = await client.query(
        'SELECT COALESCE(MAX(attempt_no),0)+1 AS next FROM durable_attempts WHERE run_id=$1',
        [runId],
      );
      await client.query(
        `INSERT INTO durable_attempts
           (attempt_id, run_id, attempt_no, lease_owner, lease_state, lease_expires_at, status, last_heartbeat_at)
         VALUES ($1,$2,$3,$4,'HELD', now() + ($5 || ' seconds')::interval, 'RUNNING', now())`,
        [attemptId, runId, noRows[0].next, owner, String(ttlSeconds)],
      );
      await client.query(
        "UPDATE durable_runs SET execution_status='RUNNING', updated_at=now() WHERE run_id=$1",
        [runId],
      );
      await client.query('COMMIT');
      return { claimed: true, from: runRows[0].verified_cursor + 1, targetEnd: runRows[0].target_end };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseLease(runId, attemptId) {
    const { rowCount } = await this.pool.query(
      `UPDATE durable_attempts SET lease_state='RELEASED', status='ENDED', ended_at=now()
       WHERE run_id=$1 AND attempt_id=$2 AND lease_state='HELD'`,
      [runId, attemptId],
    );
    return rowCount === 1;
  }

  /** 回收死租约：租约到点 OR 心跳超时（worker 进程死亡但 TTL 未到的情况）。
   *  不认领未知资源——先判死，再回收。 */
  async expireStaleLeases(runId, heartbeatStaleSeconds = 120) {
    const { rows } = await this.pool.query(
      `UPDATE durable_attempts SET lease_state='EXPIRED', status='ENDED', ended_at=now()
       WHERE run_id=$1 AND lease_state='HELD' AND (
         lease_expires_at <= now()
         OR last_heartbeat_at IS NULL
         OR last_heartbeat_at < now() - ($2 || ' seconds')::interval
       )
       RETURNING attempt_id, lease_owner`,
      [runId, String(heartbeatStaleSeconds)],
    );
    return rows;
  }

  /** worker 心跳：存活证明。恢复层用心跳陈旧度判断进程死亡。 */
  async heartbeat(runId, attemptId) {
    await this.pool.query(
      `UPDATE durable_attempts SET last_heartbeat_at=now()
       WHERE run_id=$1 AND attempt_id=$2 AND lease_state='HELD'`,
      [runId, attemptId],
    );
  }

  /** CAS 推进 verified cursor：只有当前值等于 expected 才推进。 */
  async casCursor(runId, expected, next) {
    const { rows } = await this.pool.query(
      `UPDATE durable_runs
       SET verified_cursor=$2, cursor_version=cursor_version+1, updated_at=now()
       WHERE run_id=$1 AND verified_cursor=$3
       RETURNING verified_cursor, cursor_version`,
      [runId, next, expected],
    );
    return rows.length ? rows[0] : null; // null = CAS 失败（并发推进或状态漂移）
  }

  /** CommitRecord：READY → COMMITTING → COMMITTED → VERIFIED（UNKNOWN 走对账）。 */
  async createCommit({ runId, attemptId, from, to, artifactDigest }) {
    const commitKey = `${runId}:${from}:${to}`;
    const existing = await this.pool.query(
      'SELECT commit_key, status, artifact_digest FROM supervisor_commit_records WHERE commit_key=$1',
      [commitKey],
    );
    if (existing.rows.length) return { created: false, ...existing.rows[0] }; // 幂等：单次业务效果
    await this.pool.query(
      `INSERT INTO supervisor_commit_records
         (commit_key, run_id, attempt_id, target, status, artifact_digest)
       VALUES ($1,$2,$3,$4,'READY',$5)`,
      [commitKey, runId, attemptId, `pages:${from}-${to}`, artifactDigest],
    );
    return { created: true, commit_key: commitKey, status: 'READY', artifact_digest: artifactDigest };
  }

  /** CommitRecord 状态机：READY → COMMITTING → COMMITTED → VERIFIED；
   *  COMMITTED/COMMITTING 均可进入 UNKNOWN（外部写入结果不明 → 对账）。 */
  async markCommit(commitKey, status) {
    const allowed = {
      COMMITTING: ['READY'],
      COMMITTED: ['COMMITTING'],
      VERIFIED: ['COMMITTED'],
      UNKNOWN: ['COMMITTING', 'COMMITTED'],
    };
    const from = allowed[status] ?? null;
    const { rows } = await this.pool.query(
      `UPDATE supervisor_commit_records SET status=$2,
         verified_at = CASE WHEN $2='VERIFIED' THEN now() ELSE verified_at END
       WHERE commit_key=$1 AND ($3::text[] IS NULL OR status = ANY($3))
       RETURNING commit_key, status`,
      [commitKey, status, from],
    );
    return rows[0] ?? null; // null = 状态机非法转移被拒绝
  }

  async getCommit(commitKey) {
    const { rows } = await this.pool.query(
      'SELECT commit_key, run_id, attempt_id, target, status, artifact_digest, verified_at FROM supervisor_commit_records WHERE commit_key=$1',
      [commitKey],
    );
    return rows[0] ?? null;
  }

  async listCommits(runId) {
    const { rows } = await this.pool.query(
      'SELECT commit_key, status, target, artifact_digest FROM supervisor_commit_records WHERE run_id=$1 ORDER BY created_at',
      [runId],
    );
    return rows;
  }
}
