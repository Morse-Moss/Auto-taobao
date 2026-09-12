// Proposal Runtime 验收测试（S2，设计文档第 10 节验收矩阵的 Agent 行）。
// 核心命题：模型可以被拔掉，业务仍然安全；模型接入后不增加任何未经验证的写权限。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Of, buildEvidenceBundle, scaffoldProposal, validateProposalSchema } from './schema.mjs';
import { validateProposal } from './validator.mjs';
import { createToolBroker, FORBIDDEN_BY_DESIGN } from './tool-broker.mjs';
import { callModel, AdapterUnavailable } from './provider-adapter.mjs';
import { runProposalSession } from './agent-session.mjs';
import { createActionIntent, executeIntent } from './action-intent.mjs';
import { CAPABILITY_REGISTRY, validateParamsFor } from './capability-registry.mjs';

const CONTROLLER = { runId: '3e1af88a-c2b2-4129-9284-50141b33c19d', stepId: 'collect', attemptId: 'attempt-1' };
const RECEIPT = { runId: CONTROLLER.runId, status: 'STALLED', completedEnd: 15 };

function makeBundle() {
  return buildEvidenceBundle({
    runId: CONTROLLER.runId,
    attemptId: CONTROLLER.attemptId,
    receipt: RECEIPT,
    eventsTail: [{ event: 'PROGRESS', completedPage: 15 }],
    diagnostics: { requestPending: true },
    experience: { hint: 'stall-900' },
  });
}

function makeValidProposal(bundle, overrides = {}) {
  const proposal = scaffoldProposal({
    bundle,
    controller: CONTROLLER,
    taskType: 'xws.failure_triage',
    promptVersion: 'supervisor-triage-prompt-v1',
    model: 'test/model',
    modelVersion: 'v1',
  });
  Object.assign(proposal, {
    requestedAction: 'RETRY_EXPORT_PROFILE_V2',
    parameters: { profile: 'download-120-stall-900' },
    reason: '导出下载等待过短',
    confidence: 0.8,
    riskClass: 'LOW',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  });
  return proposal;
}

test('证据摘要：同内容不同键序得到相同 digest', () => {
  assert.equal(sha256Of({ a: 1, b: 2 }), sha256Of({ b: 2, a: 1 }));
  assert.notEqual(sha256Of({ a: 1 }), sha256Of({ a: 2 }));
});

test('Validator：合法 proposal → VALIDATED', () => {
  const bundle = makeBundle();
  const result = validateProposal(makeValidProposal(bundle), bundle, { failureClass: 'STALL_PAGE_REQUEST' });
  assert.equal(result.status, 'VALIDATED');
});

test('Validator：证据引用越权（其他 run 的证据）→ REJECTED', () => {
  const bundle = makeBundle();
  const proposal = makeValidProposal(bundle);
  proposal.evidenceRefs = [{ evidenceId: 'receipt-other-run', kind: 'postgres_receipt', digest: 'sha256:abc', scope: 'same-run-attempt' }];
  const result = validateProposal(proposal, bundle, { failureClass: 'STALL_PAGE_REQUEST' });
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.reasons.some((r) => r.includes('越权或不存在')));
});

test('Validator：digest 被篡改 → REJECTED', () => {
  const bundle = makeBundle();
  const proposal = makeValidProposal(bundle);
  proposal.evidenceRefs[0].digest = 'sha256:deadbeef';
  const result = validateProposal(proposal, bundle, { failureClass: 'STALL_PAGE_REQUEST' });
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.reasons.some((r) => r.includes('digest 不匹配')));
});

test('Validator：未注册 action（delete_database）→ REJECTED', () => {
  const bundle = makeBundle();
  const proposal = makeValidProposal(bundle, { requestedAction: 'delete_database', parameters: {} });
  const result = validateProposal(proposal, bundle, { failureClass: 'STALL_PAGE_REQUEST' });
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.reasons.some((r) => r.includes('未注册')));
});

test('Validator：任意路径/未知参数字段 → REJECTED', () => {
  const result = validateParamsFor('RETRY_EXPORT_PROFILE_V2', { profile: 'download-120-stall-900', cmd: 'rm -rf /' });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('未知参数字段')));
  const result2 = validateParamsFor('RETRY_EXPORT_PROFILE_V2', { profile: 'arbitrary-shell-command' });
  assert.equal(result2.ok, false, '枚举外的 profile 必须拒绝');
});

test('Validator：过期 proposal → REJECTED；风险标注不实 → REJECTED', () => {
  const bundle = makeBundle();
  const expired = makeValidProposal(bundle, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(validateProposal(expired, bundle, { failureClass: 'STALL_PAGE_REQUEST' }).status, 'REJECTED');

  const badRisk = makeValidProposal(bundle, { requestedAction: 'OPEN_HUMAN_LOGIN_GATE', parameters: { gate: 'xws_login' }, riskClass: 'LOW' });
  assert.equal(validateProposal(badRisk, bundle, { failureClass: 'LOGIN_REQUIRED' }).status, 'REJECTED');
});

test('Tool Broker：作用域锁定、调用预算、大小上限、敏感字段脱敏', () => {
  const broker = createToolBroker(
    { runSummary: { runId: CONTROLLER.runId, cookie: 'SECRET' }, events: Array.from({ length: 80 }, (_, i) => ({ i })) },
    { runId: CONTROLLER.runId, attemptId: CONTROLLER.attemptId },
    { maxCalls: 3, maxResponseChars: 500 },
  );
  assert.ok(!broker.listTools().tools.some((t) => FORBIDDEN_BY_DESIGN.includes(t)), '危险工具不在可用列表');
  assert.throws(() => broker.getRunSummary({ runId: 'other-run-id' }), /SCOPE_VIOLATION/, '跨 run 访问必须拒绝');
  const summary = broker.getRunSummary();
  assert.equal(summary.cookie, '[masked]');
  const events = broker.getRecentEvents({ limit: 80 });
  assert.ok(events.length <= 50, '事件硬上限 50');
  assert.throws(() => broker.getDiagnosticSummary({ attemptId: 'other-attempt' }), /SCOPE_VIOLATION/);
  for (let i = 0; i < 5; i += 1) {
    try { broker.getRunSummary(); } catch { /* 预算耗尽即抛 */ }
  }
  assert.throws(() => broker.getRunSummary(), /TOOL_BUDGET_EXHAUSTED/);
});

test('Provider Adapter：未配置 → AdapterUnavailable；正常返回 → 元数据齐全', async () => {
  await assert.rejects(() => callModel({ system: 's', user: 'u' }, { endpoint: '', apiKey: '', model: '' }), AdapterUnavailable);
  const result = await callModel({ system: 's', user: 'u' }, {
    endpoint: 'https://llm.example/v1/chat/completions',
    apiKey: 'k',
    model: 'm-1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) }),
  });
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.model, 'm-1');
  assert.equal(result.endpointName, 'llm.example');
});

test('会话：模型提议"读 Cookie/删文件/选账号"类越权动作 → REJECTED 且有审计', async () => {
  const bundle = makeBundle();
  const adversarial = JSON.stringify({
    requestedAction: 'readCookie',
    parameters: { target: 'taobao.com' },
    reason: '想看看登录态',
    confidence: 0.9,
    riskClass: 'LOW',
  });
  const result = await runProposalSession({
    controller: CONTROLLER,
    failureClass: 'STALL_PAGE_REQUEST',
    evidence: { receipt: RECEIPT, eventsTail: [{ event: 'PROGRESS', completedPage: 15 }] },
    provider: {
      endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'k', model: 'm-1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: adversarial } }] }) }),
    },
  });
  assert.equal(result.status, 'REJECTED');
  assert.ok(result.audit.rejectionReasons.length > 0);
  assert.ok(result.audit.providerCalled, '真实调用了 provider（有证据）');
  assert.ok(result.audit.evidenceDigests.receipt.startsWith('sha256:'));
});

test('会话：合法提案 → VALIDATED 且证据 digest 全部绑定', async () => {
  const lawful = (runId) => JSON.stringify({
    requestedAction: 'RETRY_EXPORT_PROFILE_V2',
    parameters: { profile: 'download-120-stall-900' },
    reason: '导出等待过短，按档位重试',
    confidence: 0.8,
    riskClass: 'LOW',
  });
  const result = await runProposalSession({
    controller: CONTROLLER,
    failureClass: 'STALL_PAGE_REQUEST',
    evidence: { receipt: RECEIPT, eventsTail: [{ event: 'PROGRESS', completedPage: 15 }] },
    provider: {
      endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'k', model: 'm-1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: lawful() } }] }) }),
    },
  });
  assert.equal(result.status, 'VALIDATED');
  assert.equal(result.proposal.requestedAction, 'RETRY_EXPORT_PROFILE_V2');
  assert.ok(result.proposal.evidenceRefs.length >= 2);
});

test('会话：模型被拔掉 → NEEDS_HUMAN，确定性路径不受影响', async () => {
  const result = await runProposalSession({
    controller: CONTROLLER,
    failureClass: 'STALL_PAGE_REQUEST',
    evidence: { receipt: RECEIPT, eventsTail: [] },
    provider: { endpoint: '', apiKey: '', model: '' },
  });
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.fallback, 'model-unavailable');
  assert.equal(result.audit.providerCalled, false);
  // 确定性 triage 独立可用（模型移除后系统仍可运行）
  const { ruleTriage } = await import('../diagnose.mjs');
  const triage = ruleTriage({ error: 'Timed out waiting for .csv download', status: 'HUMAN_REQUIRED', events: [] });
  assert.equal(triage.failureClass, 'EXPORT_DOWNLOAD_TIMEOUT');
});

test('会话：低置信度 → NEEDS_HUMAN（人工闸门）', async () => {
  const lowConf = JSON.stringify({
    requestedAction: 'RETRY_EXPORT_PROFILE_V2',
    parameters: { profile: 'download-120-stall-300' },
    reason: 'r', confidence: 0.3, riskClass: 'LOW',
  });
  const result = await runProposalSession({
    controller: CONTROLLER,
    failureClass: 'STALL_PAGE_REQUEST',
    evidence: { receipt: RECEIPT, eventsTail: [] },
    provider: {
      endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'k', model: 'm-1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: lowConf } }] }) }),
    },
  });
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.audit.note, 'confidence < 0.5 → 人工闸门');
});

test('ActionIntent：VALIDATED proposal → APPROVED 意图（幂等键稳定）+ 预算/冷却', () => {
  const bundle = makeBundle();
  const proposal = makeValidProposal(bundle);
  const { status, intent } = createActionIntent(proposal, { recentIntentsForRun: () => [] });
  assert.equal(status, 'APPROVED');
  assert.equal(intent.idempotencyKey, `${CONTROLLER.runId}:attempt-1:RETRY_EXPORT_PROFILE_V2:download-120-stall-900`);

  // 预算：同类动作第二次 → DENIED（单 run 上限 1）
  const second = createActionIntent(proposal, {
    recentIntentsForRun: () => [{ action: 'RETRY_EXPORT_PROFILE_V2', createdAt: intent.createdAt }],
  });
  assert.equal(second.status, 'DENIED');
});

test('ActionIntent：HUMAN_REQUIRED 类动作不自动执行；能力未接线时 executeIntent 抛错', async () => {
  const bundle = makeBundle();
  const proposal = makeValidProposal(bundle, { requestedAction: 'OPEN_HUMAN_LOGIN_GATE', parameters: { gate: 'xws_login' }, riskClass: 'HUMAN_REQUIRED' });
  const { status, intent } = createActionIntent(proposal, { recentIntentsForRun: () => [] });
  assert.equal(status, 'HUMAN_REQUIRED');
  await assert.rejects(() => executeIntent(intent, {}), /policyDecision|能力未注册/);
});
