// 独立 Proposal Validator（S2，设计文档 4.6 / 5.2 / 10）。
// 与 Agent 和采集 Worker 完全独立：schema + 证据 digest + 能力注册 + 参数范围
// + 风险/类别匹配 + 过期。任何一项不合法 → 整体 REJECTED，不部分采纳。
// 同一输入（evidence digest + prompt version + model version + payload）重放结果一致。

import { validateProposalSchema, PROPOSAL_SCHEMA_VERSION } from './schema.mjs';
import { isRegisteredAction, validateParamsFor, CAPABILITY_REGISTRY } from './capability-registry.mjs';

const MAX_PROPOSAL_TTL_MS = 30 * 60 * 1000; // proposal 最长有效期 30 分钟

/**
 * 校验 proposal。
 * @param proposal 模型输出填充后的提案
 * @param bundle   Controller 生成的证据束（digest 权威来源）
 * @param context  { failureClass } 当前确定性诊断的故障类别
 */
export function validateProposal(proposal, bundle, { failureClass = null, now = new Date() } = {}) {
  const reasons = [];

  const schemaResult = validateProposalSchema(proposal);
  if (!schemaResult.ok) reasons.push(...schemaResult.reasons);

  // 身份不变量：runId/attemptId 必须来自 Controller 上下文
  if (bundle && proposal) {
    if (proposal.runId !== bundle.runId) reasons.push('runId 与 Controller 上下文不一致');
    if ((bundle.attemptId ?? null) !== (proposal.attemptId ?? null)) reasons.push('attemptId 与 Controller 上下文不一致');
  }

  // 证据引用：必须在束内且 digest 逐字匹配
  if (bundle && Array.isArray(proposal?.evidenceRefs)) {
    const bundleRefs = new Map(
      Object.entries(bundle.parts).map(([name, part]) => [`${name}-${bundle.runId}`, part]),
    );
    for (const ref of proposal.evidenceRefs) {
      const authoritative = bundleRefs.get(ref.evidenceId);
      if (!authoritative) {
        reasons.push(`证据引用越权或不存在: ${ref.evidenceId}`);
        continue;
      }
      if (authoritative.digest !== ref.digest) reasons.push(`证据 digest 不匹配: ${ref.evidenceId}`);
    }
    if (proposal.evidenceRefs.length === 0) reasons.push('proposal 未引用任何证据');
  }

  // 能力注册 + 参数
  if (!isRegisteredAction(proposal?.requestedAction)) {
    reasons.push(`requestedAction 未注册: ${String(proposal?.requestedAction)}`);
  } else {
    const paramsResult = validateParamsFor(proposal.requestedAction, proposal?.parameters);
    if (!paramsResult.ok) reasons.push(...paramsResult.reasons);

    // 类别匹配：动作必须适用于当前故障类别
    const spec = CAPABILITY_REGISTRY[proposal.requestedAction];
    if (spec.appliesTo && failureClass && !spec.appliesTo.includes(failureClass)) {
      reasons.push(`action ${proposal.requestedAction} 不适用于故障类别 ${failureClass}`);
    }
  }

  // 过期：必须在未来，且不超过最大 TTL
  if (typeof proposal?.expiresAt === 'string') {
    const expiry = Date.parse(proposal.expiresAt);
    if (!Number.isNaN(expiry)) {
      if (expiry <= now.getTime()) reasons.push('proposal 已过期');
      if (expiry - now.getTime() > MAX_PROPOSAL_TTL_MS) reasons.push('proposal 有效期超过上限');
    }
  }

  // 风险类别一致性：HUMAN_REQUIRED 类动作的 proposal 风险必须如实标注
  if (proposal?.requestedAction && isRegisteredAction(proposal.requestedAction)) {
    const spec = CAPABILITY_REGISTRY[proposal.requestedAction];
    if (spec.riskClass === 'HUMAN_REQUIRED' && proposal.riskClass !== 'HUMAN_REQUIRED') {
      reasons.push('风险标注不实：该动作属人工闸门类');
    }
  }

  // schema 版本单一
  if (proposal?.schemaVersion && proposal.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    reasons.push('schemaVersion 不受支持');
  }

  return { status: reasons.length === 0 ? 'VALIDATED' : 'REJECTED', reasons };
}
