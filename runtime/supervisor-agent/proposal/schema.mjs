// Proposal 合同基础：证据摘要、证据束、提案结构（S2，SUPERVISOR-AGENT-DESIGN.md 第 5 节）。
// 不变量：runId/stepId/attemptId 由 Controller 提供，模型不能创建或替换；
//         证据引用必须带可复算的 sha256 digest；自由文本不是证据。

import { createHash } from 'node:crypto';

export const PROPOSAL_SCHEMA_VERSION = 'agent-proposal-v1';

export function sha256Of(value) {
  // 键序规范化后哈希，保证同内容不同键序得到相同 digest
  const canonical = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Controller 生成的受限证据束：每条证据带 digest，模型只能引用束内证据。 */
export function buildEvidenceBundle({ runId, attemptId, receipt, eventsTail, diagnostics, experience }) {
  const parts = {};
  if (receipt) parts.receipt = { kind: 'postgres_receipt', payload: receipt, digest: sha256Of(receipt) };
  if (eventsTail) parts.events = { kind: 'events_projection', payload: eventsTail, digest: sha256Of(eventsTail) };
  if (diagnostics) parts.diagnostics = { kind: 'diagnostic_summary', payload: diagnostics, digest: sha256Of(diagnostics) };
  if (experience) parts.experience = { kind: 'historical_experience', payload: experience, digest: sha256Of(experience) };
  return {
    runId,
    attemptId,
    createdAt: new Date().toISOString(),
    parts,
  };
}

export function evidenceRef(bundle, partName) {
  const part = bundle.parts[partName];
  if (!part) return null;
  return {
    evidenceId: `${partName}-${bundle.runId}`,
    kind: part.kind,
    digest: part.digest,
    scope: 'same-run-attempt',
  };
}

/** 按合同填充 proposal 骨架；模型只填语义字段（requestedAction/parameters/reason/confidence）。 */
export function scaffoldProposal({ bundle, controller, taskType, promptVersion, model, modelVersion }) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalKey: `${controller.runId}:${controller.attemptId ?? 'na'}:${taskType}`,
    runId: controller.runId,
    stepId: controller.stepId ?? null,
    attemptId: controller.attemptId ?? null,
    taskType,
    evidenceRefs: Object.keys(bundle.parts)
      .map((name) => evidenceRef(bundle, name))
      .filter(Boolean),
    promptVersion,
    model,
    modelVersion: modelVersion ?? null,
    confidence: null,
    riskClass: null,
    requestedAction: null,
    parameters: {},
    reason: null,
    expiresAt: null,
  };
}

const RISK_CLASSES = new Set(['LOW', 'MEDIUM', 'HIGH', 'HUMAN_REQUIRED']);

/** Schema 层校验：只查结构与字段类型，不含策略（策略在 validator.mjs）。 */
export function validateProposalSchema(proposal) {
  const reasons = [];
  if (proposal?.schemaVersion !== PROPOSAL_SCHEMA_VERSION) reasons.push(`schemaVersion 必须为 ${PROPOSAL_SCHEMA_VERSION}`);
  for (const field of ['proposalKey', 'runId', 'taskType', 'promptVersion', 'model']) {
    if (typeof proposal?.[field] !== 'string' || !proposal[field]) reasons.push(`缺少或非法字段: ${field}`);
  }
  if (!Array.isArray(proposal?.evidenceRefs)) reasons.push('evidenceRefs 必须是数组');
  else {
    for (const ref of proposal.evidenceRefs) {
      if (typeof ref?.evidenceId !== 'string' || typeof ref?.digest !== 'string' || !ref.digest.startsWith('sha256:')) {
        reasons.push('evidenceRef 缺少 evidenceId 或合法 digest');
        break;
      }
    }
  }
  if (proposal?.riskClass !== null && !RISK_CLASSES.has(proposal?.riskClass)) reasons.push('riskClass 非法');
  if (proposal?.confidence !== null && (typeof proposal?.confidence !== 'number' || proposal.confidence < 0 || proposal.confidence > 1)) {
    reasons.push('confidence 必须在 [0,1]');
  }
  if (typeof proposal?.reason !== 'string' || !proposal.reason) reasons.push('缺少 reason');
  if (typeof proposal?.expiresAt !== 'string' || Number.isNaN(Date.parse(proposal.expiresAt))) reasons.push('expiresAt 非法');
  return { ok: reasons.length === 0, reasons };
}
