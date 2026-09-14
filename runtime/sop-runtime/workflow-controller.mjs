// Workflow Controller：Run/Step/Attempt 状态唯一拥有者（Spec 5.1 / 6.3）
// 只允许确定性状态转移；外部副作用必须走 Worker + Validator + Commit/Reconcile。
import { advance, setBlocker, clearBlocker, validateContext, isTerminal, CONTEXT_STATE_AXIS_FIELDS } from './context-schema.mjs';
import { EXTERNAL_WRITE_EFFECTS, actionForFailure, laneFor, laneLimit, occupiesLane } from './policy.mjs';
import { CasConflictError } from './store-port.mjs';
import { assessRunLiveness, assessReclaimSafety, reclaimGuidance, RECLAIM_CANDIDATE_PUBLICATION } from './run-liveness.mjs';
import { COMMIT_HANDED_OFF } from './side-effect-ledger.mjs';
import { RECONCILABLE_PUBLICATION } from './publication.mjs';

export class ControllerError extends Error {
  constructor(message, { code = 'CONTROLLER_ERROR', details = {} } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ControllerError';
    this.code = code;
    this.details = details;
  }
}

export function createController({
  store,
  nowIso = () => new Date().toISOString(),
  leaseTtlMs = 5 * 60 * 1000,
  idFactory = () => `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  workerId = `worker-${process.pid}`,
} = {}) {
  if (!store) throw new ControllerError('store is required', { code: 'STORE_REQUIRED' });

  async function read(runId) {
    const context = await store.loadContext(runId);
    if (!context) throw new ControllerError(`run not found: ${runId}`, { code: 'RUN_NOT_FOUND' });
    return context;
  }

  async function write(context, expectedVersion) {
    const check = validateContext(context);
    if (!check.ok) {
      throw new ControllerError(`invalid context: ${check.errors.join('; ')}`, { code: 'INVALID_CONTEXT', details: check.errors });
    }
    try {
      return await store.saveContext(context.runId, context, expectedVersion);
    } catch (error) {
      if (error instanceof CasConflictError || error?.code === 'CAS_CONFLICT') {
        throw new ControllerError(`context changed concurrently for run ${context.runId}`, {
          code: 'CAS_CONFLICT',
          details: error.details,
        });
      }
      throw error;
    }
  }

  async function transition(runId, patch) {
    const context = await read(runId);
    if (isTerminal(context)) {
      throw new ControllerError(`run ${runId} is terminal (${context.executionStatus}); refusing transition`, { code: 'TERMINAL_RUN' });
    }
    const next = advance(context, patch, { nowIso: nowIso() });
    return write(next, context.contextVersion);
  }

  // 存活 + 回收安全性的**唯一**评估入口（只读）。
  // 判定本身在 run-liveness.mjs（纯函数，准入与回收共用同一份）；
  // 这里只负责把 store 里的三样东西取出来喂给它：上下文、attempt 租约、该 run 的提交记录。
  // 提交记录取不到（旧 store 没有该端口方法）时传 null，让安全判定走 fail-closed（READY 视为不安全）。
  async function assessRunState(runId, { leaseGraceMs = 0, abandonedAfterMs = null, nowMs = Date.now() } = {}) {
    const context = await read(runId);
    const attempts = await store.listAttempts(runId);
    const commits = typeof store.listCommitsByRun === 'function' ? await store.listCommitsByRun(runId) : null;
    const run = {
      runId,
      executionStatus: context.executionStatus,
      publicationStatus: context.publicationStatus,
      context,
      updatedAt: context.updatedAt ?? null,
    };
    const liveness = assessRunLiveness({ run, attempts, nowMs, leaseGraceMs, abandonedAfterMs });
    const safety = assessReclaimSafety({ run, commits });
    return { runId, run, attempts, commits, liveness, safety, guidance: reclaimGuidance({ liveness, safety }) };
  }

  // 终结一条 stale 运行并释放它的幂等键。
  // 刻意做成关闭包函数（而不是对象方法）：「批量 reaper」要复用它，
  // 走 `this.x()` 会在调用方解构方法时静默失效（`this` 变 undefined）。
  // 两道闸门都必须过，缺一不可：
  //   1) 可证已死（租约判据）—— 否则抛 RUN_NOT_STALE，绝不去动一条可能正在跑的运行；
  //   2) 外部写入未在飞行（提交记录判据）—— 否则抛 PUBLICATION_UNRESOLVED，
  //      并提示唯一正确的下一步是对账，而不是回收（回收会换一个新的 commitKey 再写一次）。
  async function reclaimStaleRun(runId, {
    operator = 'unknown', note = '', reason = null,
    leaseGraceMs = 0, abandonedAfterMs = null, nowMs = Date.now(),
  } = {}) {
    const state = await assessRunState(runId, { leaseGraceMs, abandonedAfterMs, nowMs });

    if (!state.liveness.reclaimable) {
      throw new ControllerError(`run ${runId} is not stale (${state.liveness.reason})`, {
        code: 'RUN_NOT_STALE',
        details: {
          reason: state.liveness.reason,
          openAttempts: state.liveness.openAttempts,
          liveAttempts: state.liveness.liveAttempts,
          guidance: state.guidance,
        },
      });
    }
    if (!state.safety.safe) {
      throw new ControllerError(
        `run ${runId} cannot be reclaimed: ${state.safety.reason} (publicationStatus=${state.safety.publicationStatus})`,
        {
          code: 'PUBLICATION_UNRESOLVED',
          details: {
            ...state.safety,
            reclaimablePublication: [...RECLAIM_CANDIDATE_PUBLICATION],
            guidance: state.guidance,
          },
        },
      );
    }

    const failureReason = reason ?? state.liveness.reason;
    const reclaimedAttempts = [];
    for (const attempt of state.attempts.filter((row) => row.status === 'RUNNING')) {
      await store.updateAttempt(attempt.attemptId, {
        status: 'FAILED',
        leaseState: 'EXPIRED',
        endedAt: nowIso(),
        failureClass: 'TRANSIENT_EXTERNAL',
        result: { detail: `stale run reclaimed (${failureReason})` },
      });
      reclaimedAttempts.push(attempt.attemptId);
    }

    const patched = advance(state.run.context, {
      executionStatus: 'FAILED',
      nextAction: 'TERMINAL',
      leaseStatus: 'RELEASED',
      decisions: [...(state.run.context.decisions ?? []), {
        kind: 'RECLAIM', status: 'RECLAIMED', operator, note, at: nowIso(),
        reason: failureReason, publicationStatus: state.run.context.publicationStatus,
        reclaimedAttempts,
      }],
    }, { nowIso: nowIso() });
    const withBlocker = setBlocker(
      patched, 'TRANSIENT_EXTERNAL',
      `${failureReason}: stale run reclaimed, idempotency key released`,
      { nowIso: nowIso() },
    );
    const saved = await write(withBlocker, state.run.context.contextVersion);
    return {
      runId,
      reclaimed: true,
      reason: failureReason,
      reclaimedAttempts,
      idempotencyKey: saved.idempotencyKey ?? null,
      publicationStatus: saved.publicationStatus,
      executionStatus: saved.executionStatus,
      context: saved,
    };
  }

  return {
    async getContext(runId) {
      return read(runId);
    },

    // 开始一次确定性尝试：先过 lane 并发闸门，再申请 lease、登记 attempt
    // 注意：选项名是 write，这里必须改名绑定，否则会遮蔽下面用于 CAS 落库的 write() 函数。
    async beginAttempt(runId, { stage = 'RUN', stepId = null, laneLimits = null, write: isWrite = false } = {}) {
      const context = await read(runId);
      if (isTerminal(context)) throw new ControllerError(`run ${runId} is terminal`, { code: 'TERMINAL_RUN' });
      if (context.humanGateStatus === 'WAITING_HUMAN') {
        throw new ControllerError(`run ${runId} is waiting for human approval`, { code: 'HUMAN_GATE_OPEN' });
      }
      // lane 闸门：同一 lane 里「正在飞行中」的 attempt 数达到上限就拒绝开新 attempt。
      // 这是「同一账号/profile/写目标不发生双写」在执行层的落点；默认上限 1，写操作恒为 1。
      // lane 优先取上下文里的权威值（准入时写入），缺失时才按规则重算，避免两边算不一致。
      //
      // 占用判据是 occupiesLane()（RUNNING + lease HELD），**不是** run 状态集合：
      // 等提交的 RUNNING、等人工的 PAUSED、等退避的 RETRY_WAIT 都不占执行槽。
      // 用 run 状态判定会让「采集完成等提交」和「失败等人工」把 lane 占死，
      // 同一 lane 的后续事项永远进不来（商品级 fan-out 会整批卡死）。
      const lane = context.lane
        ?? laneFor({ identity: context.identity ?? {}, capability: context.capability, target: context.target ?? null, write: isWrite });
      const limit = laneLimit({ lane, write: isWrite, limits: laneLimits });
      const laneRuns = await store.listActiveRuns({ lane });
      const activeOthers = laneRuns.filter((run) => run.runId !== runId && occupiesLane(run.context ?? {})).length;
      if (activeOthers >= limit) {
        throw new ControllerError(`lane saturated: ${lane}`, {
          code: 'LANE_SATURATED',
          details: { lane, limit, activeInLane: activeOthers + 1, failureClass: 'RESOURCE_BUSY' },
        });
      }
      const attempts = await store.listAttempts(runId);
      const attemptNo = attempts.length + 1;
      const attemptId = idFactory();
      const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

      await store.createAttempt({
        attemptId,
        runId,
        attemptNo,
        leaseOwner: workerId,
        leaseState: 'HELD',
        leaseExpiresAt,
        stage,
        stepId,
      });

      const next = advance(context, {
        stage,
        stepId,
        attemptId,
        executionStatus: 'RUNNING',
        leaseStatus: 'HELD',
        nextAction: 'EXECUTE',
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    async heartbeat(attemptId) {
      return store.heartbeat(attemptId);
    },

    // Worker 成功：由调用方先提供 validator 结果，controller 只登记证据状态
    async completeAttempt(runId, { attemptId, artifactRefs = [], evidenceRefs = [], nextAction = 'COMMIT' } = {}) {
      const context = await read(runId);
      await store.updateAttempt(attemptId, { status: 'SUCCEEDED', endedAt: new Date().toISOString(), result: { artifactRefs, evidenceRefs } });
      const next = advance(context, {
        evidenceStatus: 'CANDIDATE',
        leaseStatus: 'RELEASED',
        artifacts: [...(context.artifacts ?? []), ...artifactRefs],
        evidenceRefs: [...(context.evidenceRefs ?? []), ...evidenceRefs],
        nextAction,
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    // 证据通过 Validator：CANDIDATE -> VALIDATED
    async markEvidenceValidated(runId, { evidenceRefs = [], nextAction = 'PREPARE_COMMIT' } = {}) {
      const context = await read(runId);
      if (context.evidenceStatus !== 'CANDIDATE') {
        throw new ControllerError(`evidenceStatus must be CANDIDATE, got ${context.evidenceStatus}`, { code: 'EVIDENCE_STATE' });
      }
      const next = advance(context, {
        evidenceStatus: 'VALIDATED',
        evidenceRefs: [...(context.evidenceRefs ?? []), ...evidenceRefs],
        nextAction,
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    // ── 发布轴：外部写入的提交与回读验收（Spec 6.3 / ADR-004）───────────────
    // 取值固定为 NOT_REQUESTED/READY/COMMITTED/VERIFIED/UNKNOWN（005 的 CHECK 约束），
    // 因此确定性拒绝不新增状态：效果确定未发生时应回到「未提交」，而不是伪装成 UNKNOWN。
    // 只有 VERIFIED 或 NOT_REQUESTED 才允许推进游标（见 advanceCursor）。

    // 只声明「即将提交」，不代表任何外部效果已经发生。
    async markPublicationReady(runId, { commitKey = null } = {}) {
      const context = await read(runId);
      if (context.publicationStatus !== 'NOT_REQUESTED' && context.publicationStatus !== 'READY') {
        throw new ControllerError(`publication must be NOT_REQUESTED or READY to prepare, got ${context.publicationStatus}`, { code: 'PUBLICATION_STATE' });
      }
      const next = advance(context, {
        publicationStatus: 'READY',
        nextAction: 'COMMIT',
        decisions: [...(context.decisions ?? []), { kind: 'PUBLICATION', status: 'READY', commitKey, at: nowIso() }],
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    // 提交已发出（幂等键已登记）；此时仍不能假设效果生效。
    async markPublicationCommitted(runId, { commitKey = null } = {}) {
      const context = await read(runId);
      if (context.publicationStatus !== 'READY' && context.publicationStatus !== 'COMMITTED') {
        throw new ControllerError(`publication must be READY or COMMITTED to settle as committed, got ${context.publicationStatus}`, { code: 'PUBLICATION_STATE' });
      }
      const next = advance(context, {
        publicationStatus: 'COMMITTED',
        nextAction: 'READBACK',
        decisions: [...(context.decisions ?? []), { kind: 'PUBLICATION', status: 'COMMITTED', commitKey, at: nowIso() }],
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    // 结算发布：verdict 只能是 VERIFIED / UNKNOWN / REJECTED（由回读收据 + manifest 发布期验证器判定）。
    // 三个分支各自校验前置状态，非法转移直接抛错，不做「尽力而为」的隐式纠正。
    async settlePublication(runId, { verdict, commitKey = null, receipt = null, failureClass = 'BUG', detail = '' } = {}) {
      const context = await read(runId);
      const current = context.publicationStatus;

      if (verdict === 'VERIFIED') {
        if (current !== 'COMMITTED') {
          throw new ControllerError(`publication must be COMMITTED before VERIFIED, got ${current}`, { code: 'PUBLICATION_STATE' });
        }
        const next = advance(context, {
          publicationStatus: 'VERIFIED',
          nextAction: 'ADVANCE_CURSOR',
          decisions: [...(context.decisions ?? []), {
            kind: 'PUBLICATION', status: 'VERIFIED', commitKey, at: nowIso(),
            receiptRows: receipt?.rows ?? null, receiptDigest: receipt?.digest ?? null, detail: String(detail ?? ''),
          }],
        }, { nowIso: nowIso() });
        return write(next, context.contextVersion);
      }

      if (verdict === 'UNKNOWN') {
        if (current !== 'READY' && current !== 'COMMITTED' && current !== 'UNKNOWN') {
          throw new ControllerError(`publication cannot become UNKNOWN from ${current}`, { code: 'PUBLICATION_STATE' });
        }
        const bumped = advance(context, {
          publicationStatus: 'UNKNOWN',
          nextAction: 'RECONCILE_COMMIT',
          decisions: [...(context.decisions ?? []), { kind: 'PUBLICATION', status: 'UNKNOWN', commitKey, at: nowIso(), detail: String(detail ?? '') }],
        }, { nowIso: nowIso() });
        return write(setBlocker(bumped, 'COMMIT_UNKNOWN', detail || 'publication unverified, reconcile required', { nowIso: nowIso() }), context.contextVersion);
      }

      if (verdict === 'REJECTED') {
        if (current !== 'READY' && current !== 'COMMITTED') {
          throw new ControllerError(`publication cannot be rejected from ${current}`, { code: 'PUBLICATION_STATE' });
        }
        // 效果确定未发生：publicationStatus 保持 READY（未提交即未发布），
        // 执行轴按策略映射重试/回队列/人工/终止，与 failAttempt 保持同一套映射。
        const used = context.retryUsed?.transientExternal ?? 0;
        const budget = context.retryBudget?.transientExternal ?? 3;
        const { action, reason } = actionForFailure(failureClass, { retryUsed: used, retryBudget: budget });
        const patch = {
          leaseStatus: 'RELEASED',
          decisions: [...(context.decisions ?? []), { kind: 'PUBLICATION', status: 'REJECTED', commitKey, at: nowIso(), detail: String(detail ?? '') }],
        };
        if (action === 'RETRY') {
          Object.assign(patch, {
            executionStatus: 'RETRY_WAIT',
            retryUsed: { ...(context.retryUsed ?? {}), transientExternal: used + 1 },
            nextAction: 'RETRY',
          });
        } else if (action === 'REQUEUE') {
          Object.assign(patch, { executionStatus: 'QUEUED', nextAction: 'REQUEUE' });
        } else if (action === 'WAIT_HUMAN') {
          Object.assign(patch, { executionStatus: 'PAUSED', humanGateStatus: 'WAITING_HUMAN', nextAction: 'WAIT_HUMAN' });
        } else {
          Object.assign(patch, { executionStatus: 'FAILED', nextAction: 'TERMINAL' });
        }
        const bumped = advance(context, patch, { nowIso: nowIso() });
        return write(setBlocker(bumped, failureClass, `${reason}: ${detail}`, { nowIso: nowIso() }), context.contextVersion);
      }

      throw new ControllerError(`unknown publication verdict: ${verdict}`, { code: 'PUBLICATION_VERDICT', details: { allowed: ['VERIFIED', 'UNKNOWN', 'REJECTED'] } });
    },

    // ── 对账收敛：运行侧的「外部写入已发生、但运行没能收敛」出口（缺口 A）──────
    // 旧行为（2026-09-14 实测）：`settlePublication(VERIFIED)` 只收 `COMMITTED`，
    // 而 `reconcileUnknown` 只回写**提交记录**、从不回写**运行**，于是
    // 「外部写入真的成功了、回读却没拿到凭据」的运行在发布轴上没有任何出口——
    // 即使提交记录已经对账成 VERIFIED，运行仍停在 UNKNOWN，游标永远推不动、幂等键永远不释放。
    // 这里补上那半截。两个前置状态（见 publication.RECONCILABLE_PUBLICATION）与两个出口：
    //   VERIFIED —— 必须带真实回读收据（verifiedAt），**且**该运行的所有提交记录都已 VERIFIED。
    //               后半条是硬闸门：账本与运行是两个权威，顺序只能是「先对账账本、再收敛运行」，
    //               否则运行会声称 VERIFIED 而账本还停在 COMMITTING/UNKNOWN —— 那就是两处真相打架。
    //               没有收据同样拒绝：否则 UNKNOWN 就成了「免回读」的后门。
    //   ABSENT   —— 操作者具名确认「外部效果确实没发生」。发布轴回到 READY（未提交即未发布），
    //               本次运行终结以释放幂等键，让重试能开一条新运行。
    //               闸门是「没有任何提交记录处于可能交付过的状态」（COMMIT_HANDED_OFF）——
    //               记录停在 COMMITTING/COMMITTED 时，人也不能声明它没发生。
    async reconcilePublication(runId, { verdict = 'VERIFIED', commitKey = null, receipt = null, operator = null, note = '', detail = '' } = {}) {
      const context = await read(runId);
      if (!RECONCILABLE_PUBLICATION.includes(context.publicationStatus)) {
        throw new ControllerError(
          `reconcile applies to ${RECONCILABLE_PUBLICATION.join('/')} publication, got ${context.publicationStatus}`,
          { code: 'PUBLICATION_STATE', details: { publicationStatus: context.publicationStatus, reconcilable: [...RECONCILABLE_PUBLICATION] } },
        );
      }

      // 账本是「外部效果到底发生没有」的权威，所以收敛运行前必须能读到它。
      // 读不到就 fail-closed，不允许在缺证据的情况下收敛（旧 store 缺该端口即走这条）。
      const commits = typeof store.listCommitsByRun === 'function' ? await store.listCommitsByRun(runId) : null;
      if (commits === null) {
        throw new ControllerError(
          `reconcile needs the commit records of run ${runId}; store does not implement listCommitsByRun`,
          { code: 'COMMIT_RECORDS_UNAVAILABLE' },
        );
      }
      const shape = (records) => records.map((record) => ({ commitKey: record?.commitKey ?? record?.commit_key ?? null, status: record?.status ?? null }));

      if (verdict === 'VERIFIED') {
        if (!receipt || !receipt.verifiedAt) {
          throw new ControllerError('reconcile to VERIFIED requires an external read-back receipt carrying verifiedAt', {
            code: 'RECEIPT_REQUIRED',
            details: { field: 'receipt.verifiedAt' },
          });
        }
        const unconverged = commits.filter((record) => record?.status !== 'VERIFIED');
        if (unconverged.length || commits.length === 0) {
          throw new ControllerError(
            'reconcile to VERIFIED requires this run to have commit records, all already VERIFIED (ledger first, then run)',
            {
              code: 'COMMIT_NOT_CONVERGED',
              details: {
                records: shape(commits),
                hint: 'ledger.verify({ commitKey, readBack }) / ledger.reconcileUnknown({ readBack }) first, then reconcile the run',
              },
            },
          );
        }
        const next = advance(context, {
          publicationStatus: 'VERIFIED',
          nextAction: 'ADVANCE_CURSOR',
          decisions: [...(context.decisions ?? []), {
            kind: 'PUBLICATION', status: 'VERIFIED', via: 'RECONCILE', commitKey, at: nowIso(),
            receiptRows: receipt.rows ?? null, receiptDigest: receipt.digest ?? null, detail: String(detail ?? ''),
            commitRecords: shape(commits),
          }],
        }, { nowIso: nowIso() });
        return write(clearBlocker(next, { nowIso: nowIso() }), context.contextVersion);
      }

      if (verdict === 'ABSENT') {
        if (!operator) {
          throw new ControllerError('reconcile to ABSENT requires a named operator: the attestation is the evidence', {
            code: 'OPERATOR_REQUIRED',
            details: { field: 'operator' },
          });
        }
        const handedOff = commits.filter((record) => COMMIT_HANDED_OFF.includes(record?.status));
        if (handedOff.length) {
          throw new ControllerError(
            'reconcile to ABSENT is refused: a commit record shows the effect may have been written',
            { code: 'COMMIT_HANDED_OFF', details: { records: shape(handedOff), hint: 'read back the external system; if the write happened, converge to VERIFIED instead' } },
          );
        }
        const patched = advance(context, {
          publicationStatus: 'READY',
          executionStatus: 'FAILED',
          nextAction: 'TERMINAL',
          leaseStatus: 'RELEASED',
          decisions: [...(context.decisions ?? []), {
            kind: 'PUBLICATION', status: 'ABSENT', via: 'RECONCILE', commitKey, operator, at: nowIso(),
            note: String(note ?? ''), detail: String(detail ?? ''), commitRecords: shape(commits),
          }],
        }, { nowIso: nowIso() });
        const withBlocker = setBlocker(
          patched, 'TRANSIENT_EXTERNAL',
          `${note || 'external effect confirmed absent by operator'}: run terminated so a fresh attempt can retry`,
          { nowIso: nowIso() },
        );
        return write(withBlocker, context.contextVersion);
      }

      throw new ControllerError(`unknown reconcile verdict: ${verdict}`, {
        code: 'PUBLICATION_VERDICT',
        details: { allowed: ['VERIFIED', 'ABSENT'] },
      });
    },

    // ── 存活判定与 stale 回收（缺口 B）───────────────────────────────────────
    // 一条 active 运行占住它的 idempotencyKey。进程崩溃后旧行为是永久占位：
    // 没有 stale 回收、也没有出口，只能人工 recover + cancel（两次真实演练各被挡一次）。
    // 两个确定性入口，都是「先判定、再动手」，判定与准入共用 run-liveness.mjs 的同一份逻辑：
    //   assessRun     —— 只读，回答「死了吗 / 回收安全吗 / 下一步该做什么」。
    //   reclaimStale  —— 只终结**可证已死 且 外部写入未在飞行**的运行，从而释放幂等键。
    // 两者都只读写权威 store，不碰任何外部系统。

    // 只读评估。给运维与调用方一个不用猜的答案（也用于回收前的二次确认）。
    async assessRun(runId, options = {}) {
      const state = await assessRunState(runId, options);
      return {
        runId: state.runId,
        executionStatus: state.liveness.executionStatus,
        publicationStatus: state.safety.publicationStatus,
        active: state.liveness.active,
        reclaimable: state.liveness.reclaimable,
        reason: state.liveness.reason,
        openAttempts: state.liveness.openAttempts,
        liveAttempts: state.liveness.liveAttempts,
        safety: state.safety,
        guidance: state.guidance,
      };
    },

    // 终结一条 stale 运行并释放它的幂等键（实现在上面的 reclaimStaleRun）。
    // 两道闸门：可证已死（租约判据 / RUN_NOT_STALE）+ 外部写入未在飞行（提交记录判据 / PUBLICATION_UNRESOLVED）。
    reclaimStale: reclaimStaleRun,

    // 批量 reaper：扫一条 lane（或全部）的 active 运行，各自独立判定与回收。
    // 单条失败**不中断**扫描——reaper 的语义是「能收的收掉，不能收的原样留给人工」，
    // 所以被拒的运行以 skipped + code 返回，而不是把整批炸掉。
    async reclaimStaleRuns({ lane = null, ...options } = {}) {
      const runs = await store.listActiveRuns({ lane });
      const reclaimed = [];
      const skipped = [];
      for (const row of runs) {
        try {
          const result = await reclaimStaleRun(row.runId, options);
          reclaimed.push({ runId: result.runId, reason: result.reason, reclaimedAttempts: result.reclaimedAttempts });
        } catch (error) {
          skipped.push({
            runId: row.runId,
            code: error?.code ?? 'RECLAIM_ERROR',
            reason: error?.message ?? String(error),
            guidance: error?.details?.guidance ?? null,
          });
        }
      }
      return { scanned: runs.length, reclaimed, skipped };
    },

    // 失败：按失败分类决定重试/回队列/人工/终止
    async failAttempt(runId, { attemptId, failureClass, detail = '' } = {}) {
      const context = await read(runId);
      await store.updateAttempt(attemptId, {
        status: 'FAILED',
        endedAt: new Date().toISOString(),
        failureClass,
        result: { detail },
      });

      const used = context.retryUsed?.transientExternal ?? 0;
      const budget = context.retryBudget?.transientExternal ?? 3;
      const { action, reason } = actionForFailure(failureClass, { retryUsed: used, retryBudget: budget });

      const patch = { leaseStatus: 'RELEASED' };
      if (action === 'RETRY') {
        Object.assign(patch, {
          executionStatus: 'RETRY_WAIT',
          retryUsed: { ...(context.retryUsed ?? {}), transientExternal: used + 1 },
          nextAction: 'RETRY',
        });
      } else if (action === 'REQUEUE') {
        Object.assign(patch, { executionStatus: 'QUEUED', nextAction: 'REQUEUE' });
      } else if (action === 'WAIT_HUMAN') {
        Object.assign(patch, { executionStatus: 'PAUSED', humanGateStatus: 'WAITING_HUMAN', nextAction: 'WAIT_HUMAN' });
      } else if (action === 'REJECT_EVIDENCE') {
        Object.assign(patch, { evidenceStatus: 'REJECTED', nextAction: 'RECOLLECT' });
      } else if (action === 'RECONCILE') {
        Object.assign(patch, { publicationStatus: 'UNKNOWN', nextAction: 'RECONCILE_COMMIT' });
      } else {
        Object.assign(patch, { executionStatus: 'FAILED', nextAction: 'TERMINAL' });
      }

      const withBlocker = setBlocker(advance(context, patch, { nowIso: nowIso() }), failureClass, `${reason}: ${detail}`, { nowIso: nowIso() });
      return write(withBlocker, context.contextVersion);
    },

    async approve(runId, { operator = 'unknown', note = '' } = {}) {
      const context = await read(runId);
      if (context.humanGateStatus !== 'WAITING_HUMAN') {
        throw new ControllerError(`run ${runId} is not waiting for approval`, { code: 'HUMAN_GATE_NOT_OPEN' });
      }
      const next = advance(context, {
        humanGateStatus: 'APPROVED',
        executionStatus: 'QUEUED',
        nextAction: 'START',
        decisions: [...(context.decisions ?? []), { kind: 'APPROVAL', operator, note, at: nowIso() }],
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    async deny(runId, { operator = 'unknown', note = '' } = {}) {
      const context = await read(runId);
      const next = advance(context, {
        humanGateStatus: 'DENIED',
        executionStatus: 'FAILED',
        nextAction: 'TERMINAL',
        decisions: [...(context.decisions ?? []), { kind: 'DENIAL', operator, note, at: nowIso() }],
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    async pause(runId, { reason = 'manual' } = {}) {
      return transition(runId, { executionStatus: 'PAUSED', nextAction: 'PAUSED', blocker: { class: 'HUMAN_REQUIRED', detail: reason, at: nowIso() } });
    },

    async cancel(runId) {
      return transition(runId, { executionStatus: 'FAILED', nextAction: 'TERMINAL', blocker: { class: 'POLICY_DENIED', detail: 'cancelled', at: nowIso() } });
    },

    // 审计记录的**唯一**落点（Agent 提案、复核结论等只允许走这里）。
    // 刻意不接受任意 patch：签名里根本没有可写状态轴的位置，
    // 因此「Agent 改运行状态」不是靠纪律约束，而是在接口上不可能发生。
    // 另外，记录自身也不得夹带状态轴字段——decisions 是审计，不是状态的第二入口。
    async recordDecisions(runId, records = []) {
      const list = Array.isArray(records) ? records.filter((record) => record !== null && record !== undefined) : [];
      if (list.length === 0) {
        throw new ControllerError('recordDecisions requires at least one decision record', { code: 'DECISION_REQUIRED' });
      }
      for (const record of list) {
        if (typeof record !== 'object' || Array.isArray(record)) {
          throw new ControllerError('every decision record must be an object', { code: 'DECISION_INVALID' });
        }
        if (typeof record.kind !== 'string' || !record.kind) {
          throw new ControllerError('every decision record needs a string kind', { code: 'DECISION_INVALID' });
        }
        const leaked = CONTEXT_STATE_AXIS_FIELDS.filter((field) => field in record);
        if (leaked.length) {
          throw new ControllerError(`decision record must not carry state-axis fields: ${leaked.join(', ')}`, {
            code: 'DECISION_STATE_MUTATION_FORBIDDEN',
            details: { leaked },
          });
        }
      }
      const context = await read(runId);
      if (isTerminal(context)) {
        throw new ControllerError(`run ${runId} is terminal (${context.executionStatus}); refusing decision append`, { code: 'TERMINAL_RUN' });
      }
      const next = advance(context, { decisions: [...(context.decisions ?? []), ...list] }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    // 游标推进：必须与已验证且已提交的边界一致，CAS 保护
    async advanceCursor(runId, { end, commitRefs = [] }) {
      const context = await read(runId);
      if (context.evidenceStatus !== 'VALIDATED') {
        throw new ControllerError('cursor can only advance on VALIDATED evidence', { code: 'EVIDENCE_NOT_VALIDATED' });
      }
      // 「这次运行声明过外部写入」时，NOT_REQUESTED 不再是合法前置。
      // 准入期已经把 manifest 声明的副作用记进上下文（sideEffects），因此在**不依赖 manifest**的前提下
      // 也能回答这个问题：声明要写外部的运行，游标只能在发布被验收（VERIFIED）之后推进。
      // 只读能力不受影响（它们的 sideEffects 里没有写外部那一类），dry-run 采集路径也不受影响
      // （它根本不调 advanceCursor，而是走 succeed()）。
      const declaredWrites = (context.sideEffects ?? []).filter((effect) => EXTERNAL_WRITE_EFFECTS.includes(effect));
      if (declaredWrites.length && context.publicationStatus === 'NOT_REQUESTED') {
        throw new ControllerError(
          `cursor cannot advance on a run that declared external writes (${declaredWrites.join(', ')}) while publication is NOT_REQUESTED`,
          { code: 'PUBLICATION_NOT_REQUESTED', details: { declaredWrites, publicationStatus: context.publicationStatus } },
        );
      }
      if (context.publicationStatus !== 'VERIFIED' && context.publicationStatus !== 'NOT_REQUESTED') {
        throw new ControllerError(`publication must be VERIFIED or NOT_REQUESTED before cursor advance, got ${context.publicationStatus}`, { code: 'PUBLICATION_NOT_SETTLED' });
      }
      const current = context.verifiedCursor ?? { start: 1, end: 0, version: 0 };
      if (Number(end) <= Number(current.end)) {
        throw new ControllerError(`cursor must move forward: current ${current.end}, got ${end}`, { code: 'CURSOR_REGRESSION' });
      }
      const next = advance(context, {
        verifiedCursor: { ...current, end: Number(end), version: Number(current.version) + 1 },
        sideEffectRefs: [...(context.sideEffectRefs ?? []), ...commitRefs],
        nextAction: context.targetEnd && Number(end) >= Number(context.targetEnd) ? 'COMPLETE' : 'NEXT_STEP',
      }, { nowIso: nowIso() });
      return write(next, context.contextVersion);
    },

    async succeed(runId) {
      return transition(runId, { executionStatus: 'SUCCEEDED', nextAction: 'TERMINAL', leaseStatus: 'RELEASED' });
    },

    // 恢复：只从权威 store 读取，不依赖本地文件或模型记忆
    async recover(runId, { leaseGraceMs = 0 } = {}) {
      const context = await read(runId);
      const attempts = await store.listAttempts(runId);
      const open = attempts.filter((a) => a.status === 'RUNNING');
      const nowMs = Date.now();
      const reclaimable = open.filter((a) => {
        if (!a.leaseExpiresAt) return false;
        return new Date(a.leaseExpiresAt).getTime() + leaseGraceMs < nowMs;
      });
      for (const attempt of reclaimable) {
        await store.updateAttempt(attempt.attemptId, { status: 'FAILED', leaseState: 'EXPIRED', endedAt: new Date().toISOString(), failureClass: 'TRANSIENT_EXTERNAL', result: { detail: 'lease expired, reclaimed by recovery' } });
      }
      return {
        runId,
        executionStatus: context.executionStatus,
        nextAction: context.nextAction,
        verifiedCursor: context.verifiedCursor ?? null,
        reclaimedAttempts: reclaimable.map((a) => a.attemptId),
        openAttempts: open.filter((a) => !reclaimable.includes(a)).map((a) => a.attemptId),
      };
    },
  };
}
