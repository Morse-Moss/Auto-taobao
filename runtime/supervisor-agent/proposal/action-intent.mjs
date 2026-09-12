// ActionIntent（S3 骨架，设计文档 6.3）：已验证 proposal → Workflow 输入。
// Policy 检查风险/预算/冷却/身份；幂等键稳定；Agent 永远不直接执行业务动作。

import { randomUUID } from 'node:crypto';
import { CAPABILITY_REGISTRY } from './capability-registry.mjs';

/**
 * 由已验证 proposal 创建 ActionIntent。
 * @returns { status: 'APPROVED'|'HUMAN_REQUIRED'|'DENIED', intent, reasons }
 */
export function createActionIntent(validatedProposal, { now = new Date(), policy = {}, recentIntentsForRun: recentDirect = undefined } = {}) {
  const reasons = [];
  if (!validatedProposal) return { status: 'DENIED', intent: null, reasons: ['proposal 为空'] };

  const spec = CAPABILITY_REGISTRY[validatedProposal.requestedAction];
  if (!spec) return { status: 'DENIED', intent: null, reasons: [`未注册 action: ${validatedProposal.requestedAction}`] };

  // 风险策略：人工闸门类动作不自动执行，只创建 HUMAN_REQUIRED 意图等待 Approval
  const policyDecision = spec.riskClass === 'HUMAN_REQUIRED' ? 'HUMAN_REQUIRED' : 'APPROVED';

  // 预算/冷却：按 run 统计同类 intent（recentIntentsForRun 可直接传或放 policy 内）
  const recentIntentsForRun = recentDirect ?? policy.recentIntentsForRun;
  const perRun = recentIntentsForRun?.(validatedProposal.runId) ?? [];
  const sameAction = perRun.filter((i) => i.action === validatedProposal.requestedAction);
  if (sameAction.length >= spec.maxPerRun) {
    return { status: 'DENIED', intent: null, reasons: [`动作 ${validatedProposal.requestedAction} 达到单 run 上限 ${spec.maxPerRun}`] };
  }
  if (sameAction.length > 0) {
    const last = sameAction.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const elapsed = now.getTime() - Date.parse(last.createdAt);
    if (elapsed < spec.cooldownSeconds * 1000) {
      return { status: 'DENIED', intent: null, reasons: [`动作 ${validatedProposal.requestedAction} 冷却中（${spec.cooldownSeconds}s）`] };
    }
  }

  const profile = validatedProposal.parameters?.profile ?? validatedProposal.parameters?.gate ?? 'none';
  const intent = {
    intentId: `intent-${randomUUID()}`,
    proposalId: validatedProposal.proposalKey,
    runId: validatedProposal.runId,
    attemptId: validatedProposal.attemptId,
    action: validatedProposal.requestedAction,
    parameters: validatedProposal.parameters,
    policyDecision,
    idempotencyKey: `${validatedProposal.runId}:${validatedProposal.attemptId ?? 'na'}:${validatedProposal.requestedAction}:${profile}`,
    createdAt: now.toISOString(),
    expiresAt: validatedProposal.expiresAt,
  };
  if (reasons.length) return { status: 'DENIED', intent: null, reasons };
  return { status: policyDecision, intent, reasons };
}

/**
 * 确定性 Workflow 的动作执行入口（S3）。
 * capabilities 由 Controller 注入的预注册实现（当前为 CLI 参数档位映射）。
 * 本函数只做 intent 校验与转发，绝不实现业务逻辑。
 */
export async function executeIntent(intent, capabilities) {
  if (!intent || intent.policyDecision !== 'APPROVED') {
    throw new Error(`intent 不可执行（policyDecision=${intent?.policyDecision ?? 'null'}）`);
  }
  if (Date.parse(intent.expiresAt) <= Date.now()) {
    throw new Error('intent 已过期');
  }
  const capability = capabilities?.[intent.action];
  if (typeof capability !== 'function') {
    throw new Error(`能力未注册或未接线: ${intent.action}`);
  }
  return capability(intent.parameters, { idempotencyKey: intent.idempotencyKey });
}
