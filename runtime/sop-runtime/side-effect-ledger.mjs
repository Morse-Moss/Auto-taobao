// Side Effect Ledger：复用 supervisor_commit_records，不新建同义提交表。
// 生命周期 READY -> COMMITTING -> COMMITTED -> VERIFIED / UNKNOWN；UNKNOWN 只能对账，禁止盲目重试。
import { createHash } from 'node:crypto';
import { classifyExternalFailure } from './policy.mjs';

export const COMMIT_STATUS = Object.freeze(['READY', 'COMMITTING', 'COMMITTED', 'VERIFIED', 'UNKNOWN', 'FAILED']);

// 「可能已经把效果写到外部系统过」的提交记录状态。
// 为什么要单独一个常量：两个地方要问这个问题，而且答案必须一致——
//   1) 回收安全判定（run-liveness.assessReclaimSafety）：可能写过 → 不许回收（换个 commitKey 就是重复写）；
//   2) 对账收敛的 ABSENT 闸门（controller.reconcilePublication）：可能写过 → 不许声明「没发生」。
// 刻意**不含** READY（登记了意图、从未交付 handler）与 FAILED（handler 确定性拒绝）。
// COMMITTING 必须在内：进程死在 handler 执行中时记录停在这里，而那正是「可能已经写进去了」。
export const COMMIT_HANDED_OFF = Object.freeze(['COMMITTING', 'COMMITTED', 'UNKNOWN', 'VERIFIED']);

// 从上面那份唯一清单**推导**出补集，而不是再抄一份 ['READY','FAILED']。
export const COMMIT_NOT_HANDED_OFF = Object.freeze(
  COMMIT_STATUS.filter((status) => !COMMIT_HANDED_OFF.includes(status)),
);

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
        // 区分确定性拒绝与结果未知：handler 抛 unknown 标记时进 UNKNOWN，否则 FAILED。
        // FAILED 时给出失败分类（结构化状态码优先），供执行轴决定重试还是终止。
        const status = error?.unknown ? 'UNKNOWN' : 'FAILED';
        const failureClass = error?.failureClass ?? (status === 'FAILED' ? classifyExternalFailure(error) : 'COMMIT_UNKNOWN');
        const updated = await store.updateCommit(commitKey, {
          status,
          error: String(error?.message ?? error),
          failureClass,
        });
        return {
          status,
          record: updated,
          error: String(error?.message ?? error),
          failureClass,
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
      // null 与 undefined 同样表示「未声明该预期值」；把 null 当 0 会把正常回读判成不符。
      const expectRows = expected.rows !== undefined && expected.rows !== null;
      const expectDigest = expected.digest !== undefined && expected.digest !== null;
      const ok = receipt && receipt.verifiedAt
        && (!expectRows || Number(receipt.rows) === Number(expected.rows))
        && (!expectDigest || receipt.digest === expected.digest);
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
          // 必须走 keyOf：端口契约是 camelCase，直接读 record.commit_key 会得到 undefined，
          // 让「需要人工对账」的收据丢掉唯一的定位键（内存 store 上实测踩到）。
          outcomes.push({ commitKey: keyOf(record), status: 'UNKNOWN', action: 'REQUIRES_HUMAN' });
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
