// Agent 接入契约的单测。
// 重点不是「Agent 能不能跑」，而是「Agent 不能做什么」：不能拿写工具、不能改状态轴、
// 不能提无证据的断言、拿掉它之后确定性流程仍然完好。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MANIFEST_SCHEMA_VERSION, PROPOSAL_SCHEMA_VERSION, PROPOSAL_KINDS, READ_ONLY_TOOLS,
  AGENT_REJECTION, AgentContractError,
  validateAgentManifest, assertAgentManifest, validateProposal, toDecision,
  createAgentPort, assertAgentRemovable,
} from './agent-proposal.mjs';

const CONTEXT = Object.freeze({
  runId: '11111111-1111-4111-8111-111111111111',
  identity: { tenantId: 't1', storeId: 's1', platform: 'xws', accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0' },
  executionStatus: 'RUNNING',
  evidenceStatus: 'VALIDATED',
});

function agentManifestOf(overrides = {}) {
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    name: 'agent.reviewer',
    version: '1.0.0',
    kind: 'agent',
    description: 'synthetic reviewer agent',
    tools: ['read_evidence', 'read_context_summary'],
    sideEffects: ['local_parse'],
    proposalKinds: ['CLASSIFY', 'SUMMARIZE', 'PLAN'],
    deterministicFallback: 'rule-based classifier in skills/xws-export-market-analysis',
    ...overrides,
  };
}

function proposalOf(overrides = {}) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    runId: CONTEXT.runId,
    agent: { name: 'agent.reviewer', version: '1.0.0' },
    kind: 'CLASSIFY',
    output: {
      claims: [
        { key: 'product_class', value: 'A', confidence: 0.8, evidenceRefs: [{ evidenceId: 'xws-import-parse' }] },
      ],
    },
    ...overrides,
  };
}

const EVIDENCE = [{ evidenceId: 'xws-import-parse', digest: 'sha256:abc' }];

test('Agent manifest：必须声明只读工具、不得有写副作用、必须声明兜底路径', () => {
  assert.equal(validateAgentManifest(agentManifestOf()).ok, true);

  assert.match(validateAgentManifest(null).errors.join(','), /must be an object/);
  assert.match(validateAgentManifest(agentManifestOf({ kind: 'capability' })).errors.join(','), /kind must be "agent"/);
  assert.match(validateAgentManifest(agentManifestOf({ tools: [] })).errors.join(','), /non-empty array/);
  assert.match(
    validateAgentManifest(agentManifestOf({ tools: ['read_evidence', 'feishu_write_records'] })).errors.join(','),
    /forbidden: feishu_write_records/,
  );
  assert.match(
    validateAgentManifest(agentManifestOf({ sideEffects: ['feishu_write'] })).errors.join(','),
    /must not declare write side effects/,
  );
  assert.match(
    validateAgentManifest(agentManifestOf({ proposalKinds: ['EXECUTE'] })).errors.join(','),
    /unknown: EXECUTE/,
  );
  assert.match(
    validateAgentManifest(agentManifestOf({ deterministicFallback: null })).errors.join(','),
    /deterministicFallback is required/,
  );

  assert.throws(() => assertAgentManifest(agentManifestOf({ kind: 'capability' })), (error) => (
    error instanceof AgentContractError && error.code === 'MANIFEST_INVALID'
  ));
  assert.deepEqual([...READ_ONLY_TOOLS].filter((tool) => /write|delete|update/i.test(tool)), [], '白名单里不得混进写工具');
});

test('提案校验：合法的、带证据引用的提案通过，并只转成 decisions', () => {
  const check = validateProposal(proposalOf(), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(check.ok, true, JSON.stringify(check.errors ?? []));

  const decision = toDecision(proposalOf());
  assert.equal(decision.kind, 'AGENT_PROPOSAL');
  assert.equal(decision.agent, 'agent.reviewer@1.0.0');
  assert.equal(decision.claims[0].key, 'product_class');
  assert.deepEqual(decision.claims[0].evidenceRefs, [{ evidenceId: 'xws-import-parse' }]);
  // decisions 里绝不能出现任何状态轴或身份字段——这是「Agent 不改状态」的落点。
  const serialized = JSON.stringify(decision);
  for (const axis of ['executionStatus', 'evidenceStatus', 'humanGateStatus', 'leaseStatus', 'publicationStatus', 'identity']) {
    assert.ok(!serialized.includes(axis), `decision 不得包含 ${axis}`);
  }
});

test('提案不得写状态轴或身份字段（含嵌套位置）', () => {
  const cases = [
    { patch: { executionStatus: 'SUCCEEDED' }, field: 'executionStatus' },
    { patch: { identity: { accountId: 'attacker' } }, field: 'identity' },
    { patch: { verifiedCursor: { end: 999 } }, field: 'verifiedCursor' },
    { patch: { output: { claims: [{ key: 'k', value: 1, evidenceRefs: ['x'], blocked: { nextAction: 'TERMINATE' } }] } }, field: 'output.claims.0.blocked.nextAction' },
  ];
  for (const { patch, field } of cases) {
    const check = validateProposal(proposalOf(patch), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
    assert.equal(check.ok, false, `应拒绝 ${field}`);
    assert.equal(check.code, 'STATE_MUTATION_FORBIDDEN');
    assert.equal(check.details.field, field);
  }
});

test('把状态轴取值塞进 status/state 这类键也被拒（防止调用方误读提案当成状态）', () => {
  const check = validateProposal(
    proposalOf({ output: { status: 'SUCCEEDED', claims: [{ key: 'k', value: 1, evidenceRefs: ['xws-import-parse'] }] } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(check.details.value, 'SUCCEEDED');
});

test('通用词不会被误杀：正文里出现 READY / UNKNOWN 不影响校验', () => {
  const check = validateProposal(
    proposalOf({
      output: {
        claims: [
          { key: 'note', value: 'target table was READY and the runner state is UNKNOWN to the agent', confidence: 0.5, evidenceRefs: ['xws-import-parse'] },
        ],
      },
    }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(check.ok, true, '正文里的通用状态词不应导致误杀');
});

test('无证据的断言一律拒绝——「模型说的」不是证据', () => {
  const noRefs = validateProposal(
    proposalOf({ output: { claims: [{ key: 'product_class', value: 'A' }] } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(noRefs.ok, false);
  assert.equal(noRefs.code, 'CLAIM_WITHOUT_EVIDENCE');

  const emptyRefs = validateProposal(
    proposalOf({ output: { claims: [{ key: 'product_class', value: 'A', evidenceRefs: [] }] } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(emptyRefs.code, 'CLAIM_WITHOUT_EVIDENCE');
});

test('引用本轮之外的证据即拒绝（不允许拿历史或凭空的引用冒充证据）', () => {
  const check = validateProposal(
    proposalOf({ output: { claims: [{ key: 'k', value: 1, evidenceRefs: [{ evidenceId: 'other-run-artifact' }] }] } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'EVIDENCE_REF_UNKNOWN');
});

test('提案的其余形状校验：runId 必须对上、kind 必须在声明范围内、置信度必须在 [0,1]', () => {
  const wrongRun = validateProposal(proposalOf({ runId: 'other-run' }), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(wrongRun.code, 'PROPOSAL_INVALID');

  // RECOMMEND 是合法种类，但该 agent 没有声明它 → 必须在「能力声明范围」上被拒。
  const undeclaredKind = validateProposal(proposalOf({ kind: 'RECOMMEND' }), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(undeclaredKind.code, 'KIND_NOT_ALLOWED');

  // PLAN 已在 manifest 里声明 → 应通过（证明上一条拒的是「未声明」而不是「种类本身不合法」）。
  const declaredKind = validateProposal(proposalOf({ kind: 'PLAN' }), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(declaredKind.ok, true, JSON.stringify(declaredKind.errors ?? []));

  const unknownKind = validateProposal(proposalOf({ kind: 'EXECUTE' }), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(unknownKind.code, 'KIND_NOT_ALLOWED');

  const badConfidence = validateProposal(
    proposalOf({ output: { claims: [{ key: 'k', value: 1, confidence: 1.4, evidenceRefs: ['xws-import-parse'] }] } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(badConfidence.code, 'PROPOSAL_INVALID');

  const noClaims = validateProposal(proposalOf({ output: {} }), { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(noClaims.code, 'PROPOSAL_INVALID');

  const wrongAgent = validateProposal(
    proposalOf({ agent: { name: 'agent.other', version: '1.0.0' } }),
    { agentManifest: agentManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE },
  );
  assert.equal(wrongAgent.code, 'PROPOSAL_INVALID');
});

test('Agent 端口：合法提案产出 decision，工具面只读且不可被调用方追加', async () => {
  const port = createAgentPort({
    agentManifest: agentManifestOf(),
    runAgent: async ({ tools }) => {
      assert.deepEqual(tools, [...READ_ONLY_TOOLS]);
      return proposalOf();
    },
  });
  assert.deepEqual(port.tools, [...READ_ONLY_TOOLS]);
  const result = await port.propose({ context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackRequired, false);
  assert.equal(result.decision.kind, 'AGENT_PROPOSAL');
});

test('Agent 抛错或给出非法提案时明确降级为确定性兜底，绝不把异常抛给编排层', async () => {
  const throwing = createAgentPort({ agentManifest: agentManifestOf(), runAgent: async () => { throw new Error('model timeout'); } });
  const failed = await throwing.propose({ context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AGENT_FAILED');
  assert.equal(failed.fallbackRequired, true);
  assert.ok(failed.fallback);
  assert.equal(failed.decision, null);

  const bad = createAgentPort({ agentManifest: agentManifestOf(), runAgent: async () => proposalOf({ executionStatus: 'SUCCEEDED' }) });
  const rejected = await bad.propose({ context: CONTEXT, evidenceRefs: EVIDENCE });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(rejected.fallbackRequired, true);
  assert.equal(rejected.decision, null);
});

test('装配 Agent 端口时先过 manifest 闸门：非法 manifest 直接拒绝装配', () => {
  assert.throws(
    () => createAgentPort({ agentManifest: agentManifestOf({ tools: ['write_anything'] }), runAgent: async () => ({}) }),
    (error) => error instanceof AgentContractError,
  );
  assert.throws(() => createAgentPort({ agentManifest: agentManifestOf() }), /runAgent is required/);
});

test('「移除 Agent 后确定性流程仍可运行」有静态检查：兜底声明 + 核心模块不得反向依赖 Agent', () => {
  assert.equal(assertAgentRemovable({ agentManifest: agentManifestOf() }).ok, true);

  const reverse = assertAgentRemovable({
    agentManifest: agentManifestOf(),
    coreModules: [{ path: 'runtime/sop-runtime/workflow-controller.mjs', source: "import x from './agent-proposal.mjs';" }],
  });
  assert.equal(reverse.ok, false);
  assert.match(reverse.reasons.join(','), /workflow-controller\.mjs imports the agent layer/);

  const clean = assertAgentRemovable({
    agentManifest: agentManifestOf(),
    coreModules: [{ path: 'runtime/sop-runtime/workflow-controller.mjs', source: "import x from './context-schema.mjs';" }],
  });
  assert.equal(clean.ok, true);
});

test('拒绝原因枚举与实现一致；提案种类全部是「读 + 生成」性质，不含执行类', () => {
  assert.deepEqual([...AGENT_REJECTION], [
    'MANIFEST_INVALID', 'WRITE_EFFECT_FORBIDDEN', 'TOOL_NOT_READ_ONLY', 'PROPOSAL_INVALID',
    'STATE_MUTATION_FORBIDDEN', 'CLAIM_WITHOUT_EVIDENCE', 'EVIDENCE_REF_UNKNOWN',
    'KIND_NOT_ALLOWED', 'FALLBACK_MISSING', 'AGENT_FAILED',
  ]);
  // 提案种类只允许「生成判断」，不允许出现要求 Agent 去执行外部动作的种类。
  // 注意 SUMMARY 不是合法种类（合法的是 SUMMARIZE），这里顺带把这个约定钉住。
  assert.deepEqual([...PROPOSAL_KINDS], ['CLASSIFY', 'PARSE', 'SUMMARIZE', 'PLAN', 'RECOMMEND']);
  assert.ok(!PROPOSAL_KINDS.includes('SUMMARY'));
  assert.ok(!PROPOSAL_KINDS.some((kind) => /EXECUTE|WRITE|PUBLISH|COMMIT/.test(kind)));
});
