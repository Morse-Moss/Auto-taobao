// Workflow Controller：Run/Step/Attempt 状态唯一拥有者（Spec 5.1 / 6.3）
// 只允许确定性状态转移；外部副作用必须走 Worker + Validator + Commit/Reconcile。
import { advance, setBlocker, validateContext, isTerminal } from './context-schema.mjs';
import { actionForFailure, laneFor, laneLimit, occupiesLane } from './policy.mjs';
import { CasConflictError } from './store-port.mjs';

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

    // 游标推进：必须与已验证且已提交的边界一致，CAS 保护
    async advanceCursor(runId, { end, commitRefs = [] }) {
      const context = await read(runId);
      if (context.evidenceStatus !== 'VALIDATED') {
        throw new ControllerError('cursor can only advance on VALIDATED evidence', { code: 'EVIDENCE_NOT_VALIDATED' });
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
