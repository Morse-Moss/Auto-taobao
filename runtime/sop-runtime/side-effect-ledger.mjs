// Side Effect Ledger：复用 supervisor_commit_records，不新建同义提交表。
// 生命周期 READY -> COMMITTING -> COMMITTED -> VERIFIED / UNKNOWN；UNKNOWN 只能对账，禁止盲目重试。
import { createHash } from 'node:crypto';

export const COMMIT_STATUS = Object.freeze(['READY', 'COMMITTING', 'COMMITTED', 'VERIFIED', 'UNKNOWN', 'FAILED']);

export function buildCommitKey({ runId, target, businessKey }) {
  if (!businessKey) throw new Error('businessKey is required for idempotent commit');
  return createHash('sha256').update(`${runId}:${target}:${businessKey}`).digest('hex').slice(0, 32);
}

// 不同 store 实现的列名风格不同（内存 camelCase / PG snake_case），统一取值。
function keyOf(record) {
  return record?.commitKey ?? record?.commit_key ?? null;
}

export function createSideEffectLedger({ store, nowIso = () => new Date().toISOString() } = {}) {
  if (!store) throw new Error('store is required');

  return {
    // 登记副作用意图；同一 commitKey 重复调用返回既有记录（幂等）
    async prepare({ runId, attemptId = null, target, businessKey, artifactDigest = null, payload = null }) {
      const commitKey = buildCommitKey({ runId, target, businessKey });
      const existing = await store.loadCommit(commitKey);
      if (existing) return { commitKey, record: existing, reused: true };
      const record = await store.upsertCommit({
        commitKey, runId, attemptId, target, status: 'READY', artifactDigest, businessKey,
      });
      return { commitKey, record: { ...record, businessKey }, reused: false, payload };
    },

    // 执行提交：handler 必须自身幂等；结果未知一律 UNKNOWN，不得当成失败重试
    async commit({ commitKey, handler, businessKey }) {
      const record = await store.loadCommit(commitKey);
      if (!record) throw new Error(`commit not prepared: ${commitKey}`);
      if (record.status === 'COMMITTED' || record.status === 'VERIFIED') {
        return { status: record.status, record, skipped: true };
      }
      if (record.status === 'UNKNOWN') {
        return { status: 'UNKNOWN', record, skipped: true, requiresReconcile: true };
      }
      await store.updateCommit(commitKey, { status: 'COMMITTING' });
      try {
        const effect = await handler({ businessKey, commitKey });
        const status = effect?.unknown ? 'UNKNOWN' : 'COMMITTED';
        const updated = await store.updateCommit(commitKey, { status });
        return { status, record: updated, effect: effect ?? null, requiresReconcile: status === 'UNKNOWN' };
      } catch (error) {
        // 区分确定性拒绝与结果未知：handler 抛 unknown 标记时进 UNKNOWN，否则 FAILED
        const status = error?.unknown ? 'UNKNOWN' : 'FAILED';
        const updated = await store.updateCommit(commitKey, {
          status,
          error: String(error?.message ?? error),
          failureClass: error?.failureClass ?? null,
        });
        return {
          status,
          record: updated,
          error: String(error?.message ?? error),
          failureClass: error?.failureClass ?? null,
          requiresReconcile: status === 'UNKNOWN',
        };
      }
    },

    // 回读验收：必须由外部系统真实回读，不能凭本地成功推断
    async verify({ commitKey, readBack, expected = {}, businessKey = null }) {
      const record = await store.loadCommit(commitKey);
      if (!record) throw new Error(`commit not found: ${commitKey}`);
      if (record.status === 'VERIFIED') return { status: 'VERIFIED', record, skipped: true };
      let receipt = null;
      try {
        receipt = await readBack({ businessKey: businessKey ?? record.businessKey ?? null, commitKey, target: record.target });
      } catch (error) {
        await store.updateCommit(commitKey, { status: 'UNKNOWN' });
        return { status: 'UNKNOWN', record, error: String(error?.message ?? error), requiresReconcile: true };
      }
      const ok = receipt && receipt.verifiedAt
        && (expected.rows === undefined || Number(receipt.rows) === Number(expected.rows))
        && (expected.digest === undefined || receipt.digest === expected.digest);
      const status = ok ? 'VERIFIED' : 'UNKNOWN';
      const updated = await store.updateCommit(commitKey, { status, verifiedAt: ok ? nowIso() : null });
      return { status, record: updated, receipt, requiresReconcile: !ok };
    },

    // UNKNOWN 对账：只回读判定，永不直接重写
    async reconcileUnknown({ readBack, expected = {} } = {}) {
      const unknowns = await store.listUnknownCommits();
      const outcomes = [];
      for (const record of unknowns) {
        if (!readBack) {
          outcomes.push({ commitKey: record.commit_key, status: 'UNKNOWN', action: 'REQUIRES_HUMAN' });
          continue;
        }
        const result = await this.verify({ commitKey: keyOf(record), readBack, expected });
        outcomes.push({
          commitKey: keyOf(record),
          status: result.status,
          action: result.status === 'VERIFIED' ? 'RESOLVED' : 'REQUIRES_HUMAN',
        });
      }
      return { scanned: unknowns.length, outcomes };
    },
  };
}
