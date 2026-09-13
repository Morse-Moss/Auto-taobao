// Workflow Controller：Run/Step/Attempt 状态唯一拥有者（Spec 5.1 / 6.3）
// 只允许确定性状态转移；外部副作用必须走 Worker + Validator + Commit/Reconcile。
import { advance, setBlocker, validateContext, isTerminal } from './context-schema.mjs';
import { actionForFailure } from './policy.mjs';
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

    // 开始一次确定性尝试：申请 lease，登记 attempt
    async beginAttempt(runId, { stage = 'RUN', stepId = null } = {}) {
      const context = await read(runId);
      if (isTerminal(context)) throw new ControllerError(`run ${runId} is terminal`, { code: 'TERMINAL_RUN' });
      if (context.humanGateStatus === 'WAITING_HUMAN') {
        throw new ControllerError(`run ${runId} is waiting for human approval`, { code: 'HUMAN_GATE_OPEN' });
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
