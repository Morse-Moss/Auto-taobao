// 运行存活与回收判定（纯函数，无 IO、无时钟副作用）。
//
// 为什么单独一个模块：两个地方要问同一件事，而且必须给出**同一个**答案——
//   1) 准入：拿到一个重复的 active 运行时，它到底是不是死了？（可以把幂等键放出来吗）
//   2) 回收：真的去终结一条运行之前，判定必须再次成立（不能信任调用方的口述）。
// 判定被复制成两份就一定会漂移，所以住在这里，只有一份。
//
// 这里回答的是**两个不同的问题**，不能合成一个：
//   a) liveness —— 这条运行是不是死了？判据是**租约**，不是运行状态。
//      运行状态（RUNNING/RETRY_WAIT/PAUSED）描述「它在等什么」，不描述「有没有人在跑它」。
//      把 PAUSED 当死运行回收，等于把一条正在等人工审批的运行悄悄杀掉。
//   b) reclaim safety —— 就算它死了，现在回收安不安全？判据是**外部写入有没有在飞行中**。
//      回收会释放幂等键，让一个 runId 不同的新运行接手；而提交键是 runId:target:businessKey，
//      所以新运行会拿到**新的 commitKey**，也就是会对外部系统再写一次。
//      因此「外部效果可能已经发生」的运行绝不能回收，只能对账（见 controller.reconcilePublication）。
// 只有 a) 与 b) 同时成立，才允许回收。这不是保守，是这两件事的判据本来就不同。
//
// 2026-09-14 两次真实演练各被一个崩溃遗留的 run 挡住（缺口 B），当时只能 recover+cancel 手动释放。
import { LANE_ACTIVE_STATUSES } from './store-port.mjs';
import { COMMIT_NOT_HANDED_OFF } from './side-effect-ledger.mjs';

// 可进入回收流程的发布轴状态（**单看它不够**，READY 还必须再过提交记录这一关）。
//  - NOT_REQUESTED：连 markPublicationReady 都没走到，handler 不可能被调用过。
//  - READY：markPublicationReady 已写、ledger.commit 未必已交付 handler —— 必须查提交记录。
export const RECLAIM_CANDIDATE_PUBLICATION = Object.freeze(['NOT_REQUESTED', 'READY']);

// 「handler 已被明确终结、外部效果确定没发生」的提交记录状态，**从账本的唯一清单推导**：
// 账本说「可能交付过」的是 COMMIT_HANDED_OFF，这里的判据就是它的补集（READY / FAILED）。
// 不在本模块重新抄一份 ['READY','FAILED'] —— 那正是这次修复要消灭的第二份真相。
// 刻意不 re-export：barrel（index.mjs）里两条 `export *` 导出同名会变成歧义导出，
// 需要它的地方直接从 side-effect-ledger.mjs 取。

function ageOf(run, nowMs) {
  const stamp = run?.updatedAt ?? run?.context?.updatedAt ?? run?.createdAt ?? null;
  if (!stamp) return null;
  const ms = new Date(stamp).getTime();
  return Number.isFinite(ms) ? Math.max(0, nowMs - ms) : null;
}

// 答：这条运行是不是死了。
// run 可以是 store.listActiveRuns 返回的行（带 context），也可以只带 executionStatus。
export function assessRunLiveness({
  run,
  attempts = [],
  nowMs = Date.now(),
  leaseGraceMs = 0,
  abandonedAfterMs = null,
} = {}) {
  const executionStatus = run?.context?.executionStatus ?? run?.executionStatus ?? null;
  if (!LANE_ACTIVE_STATUSES.includes(executionStatus)) {
    return {
      executionStatus, active: false, reclaimable: false, reason: 'TERMINAL',
      openAttempts: 0, liveAttempts: 0, ageMs: ageOf(run, nowMs),
    };
  }
  const open = attempts.filter((attempt) => attempt?.status === 'RUNNING');
  const live = open.filter((attempt) => {
    if (!attempt?.leaseExpiresAt) return false;
    const expiresAt = new Date(attempt.leaseExpiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt + leaseGraceMs >= nowMs;
  });
  const base = {
    executionStatus, active: true, openAttempts: open.length, liveAttempts: live.length,
    ageMs: ageOf(run, nowMs),
  };

  // 有人正持着有效租约 —— 它是活的，无论它看起来等了多久。
  if (live.length) return { ...base, reclaimable: false, reason: 'LEASE_HELD' };
  // 有开放 attempt 却一个都没持有有效租约 ⇒ 持有者进程已经没了（崩溃/被 kill）。
  if (open.length) return { ...base, reclaimable: true, reason: 'LEASE_EXPIRED' };
  // 一个开放 attempt 都没有、状态却是 RUNNING：只能在「写回 RUNNING」与「开 attempt」之间崩掉。
  if (executionStatus === 'RUNNING') return { ...base, reclaimable: true, reason: 'RUNNING_WITHOUT_ATTEMPT' };
  // 没有任何 attempt 的 QUEUED：可能只是刚入队还没人领走。只有超过 abandonedAfterMs 才算没人管了。
  // 不给 abandonedAfterMs（默认 null）时**不回收**：宁可让调用方显式说出「多久算遗弃」。
  // 这个分支**只认 QUEUED**：RETRY_WAIT 在等退避、PAUSED 在等人工，两者都可能是合法长等待，
  // 用一个时间阈值去猜它们「等太久了」正是要避免的误杀。
  if (executionStatus === 'QUEUED' && abandonedAfterMs !== null && base.ageMs !== null && base.ageMs >= abandonedAfterMs) {
    return { ...base, reclaimable: true, reason: 'ABANDONED_QUEUE' };
  }
  // RETRY_WAIT（等退避）/ PAUSED（等人工）/ 刚入队的 QUEUED 都是**合法等待**，不是死了。
  return { ...base, reclaimable: false, reason: 'WAITING' };
}

// 答：现在回收它安不安全（会不会造成重复外部写入）。
// commits 传 null 表示「拿不到提交记录」——此时 READY 一律判不安全（fail-closed）：
// 猜错的代价是一次真实的重复写入，比多要一次人工对账贵得多。
export function assessReclaimSafety({ run, commits = null } = {}) {
  const publicationStatus = run?.context?.publicationStatus ?? run?.publicationStatus ?? 'NOT_REQUESTED';

  if (publicationStatus === 'NOT_REQUESTED') {
    return { safe: true, publicationStatus, reason: 'NO_PUBLICATION_REQUESTED', blocking: [] };
  }

  if (publicationStatus === 'READY') {
    if (!commits) {
      return { safe: false, publicationStatus, reason: 'COMMIT_STATE_UNKNOWN', blocking: [] };
    }
    const blocking = commits.filter((record) => !COMMIT_NOT_HANDED_OFF.includes(record?.status));
    if (blocking.length) {
      return {
        safe: false, publicationStatus, reason: 'COMMIT_NOT_TERMINAL',
        blocking: blocking.map((record) => ({ commitKey: record?.commitKey ?? record?.commit_key ?? null, status: record?.status ?? null })),
      };
    }
    return { safe: true, publicationStatus, reason: 'COMMIT_NEVER_HANDED_OFF', blocking: [] };
  }

  // COMMITTED / UNKNOWN / VERIFIED：效果已发生或未知。回收 = 换个 commitKey 再写一次。
  return { safe: false, publicationStatus, reason: 'PUBLICATION_IN_FLIGHT', blocking: [] };
}

// 给调用方的一句话「下一步该做什么」。判定本身已经给出 reason，这里只做表达。
export function reclaimGuidance({ liveness, safety } = {}) {
  if (!liveness?.active) return 'run is already terminal; nothing to reclaim';
  if (!liveness.reclaimable) {
    return `run is alive or legitimately waiting (${liveness.reason}); do not reclaim`;
  }
  if (safety?.safe) return 'safe to reclaim: stale run whose external write was provably never handed off';
  return `not safe to reclaim (${safety?.reason}): reconcile the commit instead — controller.reconcilePublication(runId) after ledger.reconcileUnknown with a real read-back`;
}
