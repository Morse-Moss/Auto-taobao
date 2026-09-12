// Agent Runtime 会话（S2 核心）：一次受限提案会话的完整生命周期。
// 流程（设计文档 4.6）：接收 Controller 上下文 → 只读工具看证据 → 真实调用模型
//   → 填充 proposal → 独立 Validator → 持久化 → 只返回 VALIDATED / REJECTED / NEEDS_HUMAN。
// 会话永远不直接调用浏览器、飞书、PostgreSQL 写接口、凭据或 shell。

import { buildEvidenceBundle, scaffoldProposal, validateProposalSchema } from './schema.mjs';
import { validateProposal } from './validator.mjs';
import { createToolBroker, FORBIDDEN_BY_DESIGN } from './tool-broker.mjs';
import { callModel, AdapterUnavailable } from './provider-adapter.mjs';
import { FAILURE_CLASSES } from '../diagnose.mjs';

const PROMPT_VERSION = 'supervisor-triage-prompt-v1';

const SYSTEM_PROMPT = `你是电商采集系统的故障分诊员。你只能基于给定证据判断，不能编造证据。
只输出 JSON 对象，字段：
{
  "requestedAction": "ESCALATE_HUMAN|RETRY_EXPORT_PROFILE_V2|OPEN_HUMAN_LOGIN_GATE|RESUME_FROM_VERIFIED_CURSOR|RECONCILE_UNKNOWN_COMMIT",
  "parameters": {},
  "reason": "结构化简短理由",
  "confidence": 0.0,
  "riskClass": "LOW|MEDIUM|HIGH|HUMAN_REQUIRED"
}
约束：requestedAction 与 parameters 必须来自系统提供的白名单与档位；不确定或涉及登录/风控/写入时用 ESCALATE_HUMAN。`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param input {
 *   controller: { runId, stepId, attemptId },
 *   failureClass: 确定性诊断类别（可为 null → 语义分诊）,
 *   evidence: { receipt, eventsTail, diagnostics, experience },
 *   provider?: 透传 provider-adapter 的 options（测试注入 fetchImpl；生产走环境变量）
 *   persist?: (proposal, audit) => void  持久化钩子（PG 或文件投影）
 *   now?: Date
 * }
 * @returns { status: 'VALIDATED'|'REJECTED'|'NEEDS_HUMAN', proposal, audit }
 */
export async function runProposalSession(input) {
  const now = input.now ?? new Date();
  const bundle = buildEvidenceBundle({
    runId: input.controller.runId,
    attemptId: input.controller.attemptId,
    receipt: input.evidence.receipt ?? null,
    eventsTail: (input.evidence.eventsTail ?? []).slice(-20),
    diagnostics: input.evidence.diagnostics ?? null,
    experience: input.evidence.experience ?? null,
  });
  const tools = createToolBroker(
    {
      runSummary: { runId: input.controller.runId, status: input.evidence.receipt?.status ?? null },
      events: input.evidence.eventsTail ?? [],
      diagnostics: input.evidence.diagnostics ?? null,
      experience: input.evidence.experience ?? null,
    },
    { runId: input.controller.runId, attemptId: input.controller.attemptId },
  );

  const audit = {
    toolsOffered: tools.listTools().tools,
    toolsForbidden: FORBIDDEN_BY_DESIGN,
    providerCalled: false,
    providerError: null,
    evidenceDigests: Object.fromEntries(
      Object.entries(bundle.parts).map(([name, part]) => [name, part.digest]),
    ),
    promptVersion: PROMPT_VERSION,
    schemaVersion: 'agent-proposal-v1',
  };

  let proposal;
  try {
    const userPayload = {
      failureClass: input.failureClass,
      evidence: tools.getRunSummary(),
      recentEvents: tools.getRecentEvents({ limit: 20 }),
      diagnostics: input.evidence.diagnostics ?? null,
      historicalExperience: input.evidence.experience ?? null,
      allowedActions: ['ESCALATE_HUMAN', 'RETRY_EXPORT_PROFILE_V2', 'OPEN_HUMAN_LOGIN_GATE', 'RESUME_FROM_VERIFIED_CURSOR', 'RECONCILE_UNKNOWN_COMMIT'],
    };
    const result = await callModel(
      { system: SYSTEM_PROMPT, user: JSON.stringify(userPayload) },
      input.provider ?? {},
    );
    audit.providerCalled = true;
    audit.model = result.model;
    audit.modelVersion = result.modelVersion;
    audit.endpointName = result.endpointName;

    const semantics = extractJson(result.text);
    if (!semantics) {
      audit.rejectionReasons = ['模型输出不是可解析 JSON'];
      return finish({ status: 'REJECTED', proposal: null, audit }, input);
    }

    proposal = scaffoldProposal({
      bundle,
      controller: input.controller,
      taskType: 'xws.failure_triage',
      promptVersion: PROMPT_VERSION,
      model: result.model,
      modelVersion: result.modelVersion,
    });
    proposal.requestedAction = semantics.requestedAction ?? null;
    proposal.parameters = semantics.parameters ?? {};
    proposal.reason = semantics.reason ?? '';
    proposal.confidence = typeof semantics.confidence === 'number' ? semantics.confidence : null;
    proposal.riskClass = semantics.riskClass ?? null;
    proposal.expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  } catch (error) {
    if (error instanceof AdapterUnavailable) {
      audit.providerError = error.message;
      // 模型不可用：确定性路径不受影响，升级人工（设计文档 S2 完成条件）
      return finish({ status: 'NEEDS_HUMAN', proposal: null, audit, fallback: 'model-unavailable' }, input);
    }
    throw error;
  }

  // Schema 预检 + 独立 Validator（证据 digest/越权/注册表/参数/风险/过期）
  const schemaResult = validateProposalSchema(proposal);
  const validatorResult = validateProposal(proposal, bundle, {
    failureClass: input.failureClass,
    now,
  });
  const reasons = [...schemaResult.reasons, ...validatorResult.reasons];
  const status = validatorResult.status === 'VALIDATED' && schemaResult.ok ? 'VALIDATED' : 'REJECTED';
  audit.rejectionReasons = reasons;

  // 低置信度 → 人工
  let finalStatus = status;
  if (status === 'VALIDATED' && typeof proposal.confidence === 'number' && proposal.confidence < 0.5) {
    finalStatus = 'NEEDS_HUMAN';
    audit.note = 'confidence < 0.5 → 人工闸门';
  }

  return finish({ status: finalStatus, proposal, audit }, input);
}

function finish(result, input) {
  if (typeof input.persist === 'function') {
    try {
      input.persist(result.proposal, result.audit);
    } catch {
      // 持久化失败不改变验证结论，但记录
      result.audit.persistFailed = true;
    }
  }
  return result;
}

export { FAILURE_CLASSES };
