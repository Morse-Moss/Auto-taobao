// PG 持久化冒烟测试：DDL 执行后验证 ProposalStore postgres 后端可用。
import { ProposalStore } from './proposal/persistence.mjs';
import { readFileSync } from 'node:fs';

const env = readFileSync('E:/小红书/.env.local', 'utf8');
const url = env.match(/XWS_DATABASE_URL=(.*)/u)[1].trim();
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: url });

const proposal = {
  proposalKey: 'smoke:test:001',
  runId: '3e1af88a-c2b2-4129-9284-50141b33c19d',
  stepId: null,
  attemptId: 'attempt-smoke',
  taskType: 'xws.failure_triage',
  schemaVersion: 'agent-proposal-v1',
  promptVersion: 'supervisor-triage-prompt-v1',
  model: 'smoke',
  modelVersion: null,
  riskClass: 'LOW',
  requestedAction: 'RETRY_EXPORT_PROFILE_V2',
  parameters: { profile: 'download-120-stall-900' },
  evidenceRefs: [],
  reason: 'persistence smoke test',
  confidence: 0.8,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
};
const intent = {
  intentId: 'intent-smoke-001',
  proposalId: 'smoke:test:001',
  runId: proposal.runId,
  attemptId: 'attempt-smoke',
  action: 'RETRY_EXPORT_PROFILE_V2',
  parameters: { profile: 'download-120-stall-900' },
  policyDecision: 'APPROVED',
  idempotencyKey: `${proposal.runId}:attempt-smoke:RETRY_EXPORT_PROFILE_V2:download-120-stall-900`,
  expiresAt: proposal.expiresAt,
};

try {
  const store = new ProposalStore({ backend: 'postgres', pgPool: pool });
  const r1 = await store.saveProposal(proposal, { status: 'VALIDATED' });
  console.log('saveProposal:', JSON.stringify(r1));
  const r2 = await store.saveIntent(intent);
  console.log('saveIntent:', JSON.stringify(r2));
  const check = await pool.query(
    'SELECT proposal_key, status, requested_action FROM supervisor_proposals WHERE proposal_key=$1',
    ['smoke:test:001'],
  );
  console.log('readback:', JSON.stringify(check.rows[0]));
  console.log('SMOKE OK');
} catch (error) {
  console.error('SMOKE ERR:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
