// 证明「LLM → Agent 契约」这根线真的连上了，且失败时按契约降级。
// 全部用注入的假 spawn，不真调模型：测的是接线与契约，不是模型质量。
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAgentRemovable, createAgentPort, validateAgentManifest } from './sop-runtime/agent-proposal.mjs';
import {
  callProviderJson, createLlmAgentRunner, createTriageAgentManifest, extractJson,
  TRIAGE_FALLBACK,
} from './agent-llm-adapter.mjs';

const RUN_ID = 'run-triage-1';
const EVIDENCE = ['sha256:aaa111', { evidenceId: 'ev-2', digest: 'bbb222' }];

function fakeSpawn(payload) {
  return async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function portWith(payload) {
  const manifest = createTriageAgentManifest();
  const runner = createLlmAgentRunner({ provider: 'codex', manifest, spawnProcess: fakeSpawn(payload) });
  return { manifest, port: createAgentPort({ agentManifest: manifest, runAgent: runner }) };
}

test('manifest 合规：只读工具、无外部写、声明兜底，且满足可移除性', () => {
  const manifest = createTriageAgentManifest();
  const check = validateAgentManifest(manifest);
  assert.equal(check.ok, true, `manifest 应合规，实际错误：${check.errors.join('; ')}`);
  assert.equal(manifest.sideEffects.filter((e) => !['local_artifact', 'local_parse', 'browser_read'].includes(e)).length, 0);
  assert.equal(assertAgentRemovable({ agentManifest: manifest }).ok, true);
});

test('模型输出经端口校验后成为 decisions，且证据引用被真实映射', async () => {
  const { port } = portWith({
    claims: [{ key: 'coverage_suspect', value: 'max_monthly_receipts=48', confidence: 0.7, evidence: [1] }],
  });
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: { period: '2026-09-13' } });
  assert.equal(result.ok, true, `端口应接受提案，实际：${result.code} ${(result.errors ?? []).join('; ')}`);
  assert.equal(result.decision.kind, 'AGENT_PROPOSAL');
  assert.equal(result.decision.agent, 'sop-triage-planner@0.1.0');
  assert.equal(result.decision.claims.length, 1);
  assert.deepEqual(result.decision.claims[0].evidenceRefs, ['sha256:aaa111']);
  assert.equal(result.decision.claims[0].confidence, 0.7);
});

test('第二个证据位（对象形 evidenceId）也能按序号引用', async () => {
  const { port } = portWith({
    claims: [{ key: 'identity_mismatch', value: 'buyer_account', confidence: 0.9, evidence: [2] }],
  });
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: {} });
  assert.equal(result.ok, true, `端口应接受提案，实际：${result.code}`);
  assert.deepEqual(result.decision.claims[0].evidenceRefs, [{ evidenceId: 'ev-2', digest: 'bbb222' }]);
});

test('越界证据序号不得被兜底成「全量证据」，应触发 CLAIM_WITHOUT_EVIDENCE', async () => {
  const { port } = portWith({
    claims: [{ key: 'coverage_suspect', value: 'x', evidence: [99] }],
  });
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLAIM_WITHOUT_EVIDENCE');
  assert.equal(result.fallbackRequired, true);
  assert.equal(result.fallback, TRIAGE_FALLBACK);
  assert.equal(result.decision, null);
});

test('模型进程失败：降级为兜底，不把异常抛给编排层', async () => {
  const manifest = createTriageAgentManifest();
  const runner = createLlmAgentRunner({
    provider: 'codex',
    manifest,
    spawnProcess: async () => { throw new Error('provider codex exited 1: not authenticated'); },
  });
  const port = createAgentPort({ agentManifest: manifest, runAgent: runner });
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_FAILED');
  assert.equal(result.fallbackRequired, true);
  assert.equal(result.fallback, TRIAGE_FALLBACK);
  assert.match(String(result.error), /not authenticated/);
});

test('模型输出不是 JSON：同样降级，不抛异常', async () => {
  const { port } = portWith('I think the coverage looks low, but I cannot be sure.');
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_FAILED');
  assert.equal(result.fallbackRequired, true);
});

test('提案夹带状态轴字段会被状态轴泄漏判定拦住', async () => {
  const { port } = portWith({
    claims: [{ key: 'coverage_suspect', value: 'x', evidence: [1], status: 'SUCCEEDED' }],
  });
  const result = await port.propose({ context: { runId: RUN_ID }, evidenceRefs: EVIDENCE, input: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(result.fallbackRequired, true);
});

test('extractJson 能吃下三种包裹：裸 JSON、围栏、cc 的 result 字段', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('说明\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(extractJson(JSON.stringify({ result: '```json\n{"a":3}\n```' })), { a: 3 });
  assert.throws(() => extractJson(''), /empty output/u);
});

test('未知 provider 直接报错（配置错误不该被静默吞掉）', async () => {
  await assert.rejects(() => callProviderJson({ provider: 'nope', prompt: 'x' }), /Unsupported provider/u);
});
