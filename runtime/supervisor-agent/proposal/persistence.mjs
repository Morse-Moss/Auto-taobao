// Proposal/Intent 持久化（S2/S3，设计文档 8.2-4）。
// 两个后端：
//   postgres —— 权威（需先执行 db/migrations/001-supervisor-tables.sql，DDL 属关键变更须授权）
//   file     —— 审计投影（明确标注 non-authoritative，不承担恢复责任）
// 当前默认 file 投影；迁移执行后切 postgres。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ProposalStore {
  constructor({ backend = 'file', pgPool = null, dir = null } = {}) {
    if (backend === 'postgres' && !pgPool) {
      throw new Error('postgres 后端需要 pgPool（且先执行 001-supervisor-tables.sql）');
    }
    this.backend = backend;
    this.pgPool = pgPool;
    this.dir = dir;
  }

  async saveProposal(proposal, audit = {}) {
    if (this.backend === 'postgres') {
      await this.pgPool.query(
        `INSERT INTO supervisor_proposals
           (proposal_key, run_id, step_id, attempt_id, task_type, schema_version,
            prompt_version, model, model_version, risk_class, requested_action,
            parameters, evidence_refs, reason, confidence, expires_at, status, rejection_reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (proposal_key) DO NOTHING`,
        [
          proposal.proposalKey, proposal.runId, proposal.stepId, proposal.attemptId,
          proposal.taskType, proposal.schemaVersion, proposal.promptVersion,
          proposal.model, proposal.modelVersion, proposal.riskClass,
          proposal.requestedAction, JSON.stringify(proposal.parameters ?? {}),
          JSON.stringify(proposal.evidenceRefs ?? []), proposal.reason,
          proposal.confidence, proposal.expiresAt, audit.status ?? 'PROPOSED',
          JSON.stringify(audit.rejectionReasons ?? []),
        ],
      );
      return { backend: 'postgres' };
    }
    // 文件投影：仅审计
    if (this.dir) {
      mkdirSync(dirname(this.dir), { recursive: true });
      appendFileSync(this.dir, `${JSON.stringify({ at: new Date().toISOString(), proposal, audit })}\n`, 'utf8');
    }
    return { backend: 'file-projection (non-authoritative)' };
  }

  async saveIntent(intent) {
    if (this.backend === 'postgres') {
      await this.pgPool.query(
        `INSERT INTO supervisor_action_intents
           (intent_key, proposal_id, run_id, attempt_id, action, parameters,
            policy_decision, idempotency_key, expires_at)
         VALUES ($1,(SELECT id FROM supervisor_proposals WHERE proposal_key=$2),$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (intent_key) DO NOTHING`,
        [
          intent.intentId, intent.proposalId, intent.runId, intent.attemptId,
          intent.action, JSON.stringify(intent.parameters ?? {}),
          intent.policyDecision, intent.idempotencyKey, intent.expiresAt,
        ],
      );
      return { backend: 'postgres' };
    }
    if (this.dir) {
      appendFileSync(this.dir, `${JSON.stringify({ kind: 'intent', at: new Date().toISOString(), intent })}\n`, 'utf8');
    }
    return { backend: 'file-projection (non-authoritative)' };
  }
}
