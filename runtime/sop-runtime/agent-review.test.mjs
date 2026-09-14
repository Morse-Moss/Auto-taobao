// Reviewer 契约的单测（迁移 7 第二半）。
//
// 关注点与提案层不同：提案层守的是「格式与边界」，复核层守的是**复核这件事本身不是橡皮图章**。
// 因此这里的用例几乎全是「什么样的复核必须被拒」：
//   - 自己复核自己；
//   - 拿上一次的 ACCEPT 给这一次盖章（摘要绑定）；
//   - 无理由的通过 / 无证据的理由；
//   - 结论越出白名单、或夹带状态轴；
//   - 复核者坏掉时必须降级兜底，而不是让 SOP 卡住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MANIFEST_SCHEMA_VERSION, PROPOSAL_SCHEMA_VERSION, READ_ONLY_TOOLS, AgentContractError,
  createAgentPort,
} from './agent-proposal.mjs';
import {
  REVIEW_SCHEMA_VERSION, REVIEW_REJECTION, proposalDigest, validateReview,
  toReviewDecision, assertReviewerIndependent, createReviewerPort,
} from './agent-review.mjs';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CONTEXT = Object.freeze({ runId: RUN_ID, executionStatus: 'RUNNING', evidenceStatus: 'VALIDATED' });
const EVIDENCE = Object.freeze([{ evidenceId: 'evidence-1', digest: 'sha256:deadbeef' }]);

function plannerManifestOf(overrides = {}) {
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    kind: 'agent',
    name: 'agent.planner',
    version: '1.0.0',
    role: 'planner',
    tools: ['read_evidence', 'read_context_summary', 'read_registry'],
    sideEffects: ['local_parse'],
    proposalKinds: ['CLASSIFY', 'PLAN'],
    deterministicFallback: 'the deterministic scheduler picks the next capability from the registry order',
    ...overrides,
  };
}

function reviewerManifestOf(overrides = {}) {
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    kind: 'agent',
    name: 'agent.reviewer',
    version: '1.0.0',
    role: 'reviewer',
    tools: ['read_evidence', 'read_policy', 'read_verified_facts'],
    sideEffects: ['local_parse'],
    reviewVerdicts: ['ACCEPT', 'REJECT', 'ESCALATE'],
    deterministicFallback: 'deterministic bound checks alone decide whether a step may run',
    ...overrides,
  };
}

function proposalOf(overrides = {}) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    runId: RUN_ID,
    agent: { name: 'agent.planner', version: '1.0.0' },
    kind: 'PLAN',
    output: {
      claims: [
        { key: 'next.capability', value: 'xws.faq.product-collect', confidence: 0.9, evidenceRefs: ['evidence-1'] },
      ],
    },
    note: 'first plan',
    ...overrides,
  };
}

function reviewOf(proposal, overrides = {}) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    runId: RUN_ID,
    reviewer: { name: 'agent.reviewer', version: '1.0.0' },
    proposalDigest: proposalDigest(proposal),
    verdict: 'ACCEPT',
    reasons: [{ key: 'bound_check_passed', note: 'capability is a candidate and registered', evidenceRefs: ['evidence-1'] }],
    ...overrides,
  };
}

function check(review, { proposal = proposalOf(), ...rest } = {}) {
  return validateReview(review, {
    reviewerManifest: reviewerManifestOf(),
    plannerManifest: plannerManifestOf(),
    proposal,
    context: CONTEXT,
    evidenceRefs: EVIDENCE,
    ...rest,
  });
}

test('合法的 ACCEPT 通过复核；结论转成 decisions 且不含任何状态轴', () => {
  const proposal = proposalOf();
  const review = reviewOf(proposal);
  const result = check(review, { proposal });
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
  assert.equal(result.verdict, 'ACCEPT');

  const decision = toReviewDecision(review, { proposal });
  assert.equal(decision.kind, 'AGENT_REVIEW');
  assert.equal(decision.reviewer, 'agent.reviewer@1.0.0');
  assert.equal(decision.reviewedAgent, 'agent.planner@1.0.0');
  assert.equal(decision.proposalKind, 'PLAN');
  assert.equal(decision.proposalDigest, proposalDigest(proposal));
  assert.equal(decision.verdict, 'ACCEPT');
  assert.deepEqual(decision.reasons[0].evidenceRefs, ['evidence-1']);

  const serialized = JSON.stringify(decision);
  for (const axis of ['executionStatus', 'evidenceStatus', 'humanGateStatus', 'leaseStatus', 'publicationStatus', 'identity']) {
    assert.ok(!serialized.includes(axis), `review decision 不得包含 ${axis}`);
  }
});

test('摘要绑定：复核必须盖在**这一份**提案上，拿上一次的结论盖章会被拒', () => {
  const reviewed = proposalOf();
  const other = proposalOf({ note: 'a different plan produced earlier' });
  const review = reviewOf(other); // 摘要来自另一份提案

  const result = check(review, { proposal: reviewed });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROPOSAL_MISMATCH');
  assert.equal(result.details.expected, proposalDigest(reviewed));
  assert.equal(result.details.got, proposalDigest(other));

  assert.equal(proposalDigest(reviewed), proposalDigest(proposalOf()), '同一份提案在任何进程里必须得到同一摘要');
  assert.notEqual(proposalDigest(reviewed), proposalDigest(other));
});

test('自审禁止：复核者不能是产出提案的那个 Agent，换个版本号也不行', () => {
  const proposal = proposalOf();
  // 复核者与提案者同名（version 不同）——按 name 判定，仍然拒。
  const sameName = reviewOf(proposal, { reviewer: { name: 'agent.planner', version: '9.9.9' } });
  const result = check(sameName, { proposal, reviewerManifest: reviewerManifestOf({ name: 'agent.planner', version: '9.9.9' }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SELF_REVIEW_FORBIDDEN');
  assert.equal(result.details.planner, 'agent.planner');

  // 不给 reviewerManifest 时，也要用提案自己的 agent.name 兜住。
  const noManifest = validateReview(reviewOf(proposal, { reviewer: { name: 'agent.planner', version: '9.9.9' } }), {
    plannerManifest: plannerManifestOf(), proposal, context: CONTEXT, evidenceRefs: EVIDENCE,
  });
  assert.equal(noManifest.code, 'SELF_REVIEW_FORBIDDEN');
});

test('角色闸门：复核端口只接 reviewer，复核者的 manifest 必须真的是 reviewer', () => {
  const proposal = proposalOf();

  // 用 planner 的 manifest 走复核校验 → ROLE_INVALID（而不是先撞 name 不匹配）。
  const asPlanner = validateReview(reviewOf(proposal), {
    reviewerManifest: plannerManifestOf(), plannerManifest: plannerManifestOf(), proposal, context: CONTEXT, evidenceRefs: EVIDENCE,
  });
  assert.equal(asPlanner.code, 'ROLE_INVALID');
  assert.match(asPlanner.errors.join(','), /a review requires a reviewer/);

  // 复核者身份对不上登记的那个 agent → REVIEWER_MISMATCH。
  const wrongReviewer = check(reviewOf(proposal, { reviewer: { name: 'agent.impostor', version: '1.0.0' } }), { proposal });
  assert.equal(wrongReviewer.code, 'REVIEWER_MISMATCH');

  // 装配复核端口时角色闸门前置：把 planner 挂上去直接拒绝装配。
  assert.throws(
    () => createReviewerPort({ reviewerManifest: plannerManifestOf(), runReviewer: async () => ({}) }),
    (error) => error instanceof AgentContractError && error.code === 'ROLE_INVALID',
  );
  assert.throws(
    () => createReviewerPort({ reviewerManifest: reviewerManifestOf({ reviewVerdicts: [] }), runReviewer: async () => ({}) }),
    (error) => error instanceof AgentContractError && error.code === 'MANIFEST_INVALID',
  );
  assert.throws(() => createReviewerPort({ reviewerManifest: reviewerManifestOf() }), /runReviewer is required/);
});

test('橡皮图章与无证据否决都不允许：三种结论都必须有带证据的理由', () => {
  const proposal = proposalOf();

  for (const verdict of ['ACCEPT', 'REJECT', 'ESCALATE']) {
    const noReasons = check(reviewOf(proposal, { verdict, reasons: [] }), { proposal });
    assert.equal(noReasons.ok, false, `${verdict} 无理由必须被拒`);
    assert.equal(noReasons.code, 'REASON_WITHOUT_EVIDENCE');

    const noRefs = check(reviewOf(proposal, { verdict, reasons: [{ key: 'r1', note: 'because i said so' }] }), { proposal });
    assert.equal(noRefs.ok, false, `${verdict} 理由无证据必须被拒`);
    assert.equal(noRefs.code, 'REASON_WITHOUT_EVIDENCE');
    assert.equal(noRefs.details.reason, 'r1');

    const emptyRefs = check(reviewOf(proposal, { verdict, reasons: [{ key: 'r1', evidenceRefs: [] }] }), { proposal });
    assert.equal(emptyRefs.code, 'REASON_WITHOUT_EVIDENCE');

    const unknownRef = check(reviewOf(proposal, { verdict, reasons: [{ key: 'r1', evidenceRefs: [{ evidenceId: 'not-this-run' }] }] }), { proposal });
    assert.equal(unknownRef.code, 'EVIDENCE_REF_UNKNOWN');
    assert.deepEqual(unknownRef.details.unknown, [{ evidenceId: 'not-this-run' }]);
  }

  // 合法的 REJECT / ESCALATE 是允许的：拒绝也是一种有效结论。
  for (const verdict of ['REJECT', 'ESCALATE']) {
    assert.equal(check(reviewOf(proposal, { verdict }), { proposal }).ok, true, `${verdict} 带证据理由应通过`);
  }
});

test('结论白名单：verdict 必须在枚举内，且必须在复核者声明范围内', () => {
  const proposal = proposalOf();

  for (const verdict of ['PASS', 'APPROVE', 'OK', 'accept', '', undefined, null]) {
    const result = check(reviewOf(proposal, { verdict }), { proposal });
    assert.equal(result.ok, false, `verdict=${String(verdict)} 应被拒`);
    assert.equal(result.code, 'VERDICT_NOT_ALLOWED');
  }

  // 复核者只声明了 ACCEPT，却给出 REJECT → 同样按「未声明」拒。
  const narrow = validateReview(reviewOf(proposal, { verdict: 'REJECT' }), {
    reviewerManifest: reviewerManifestOf({ reviewVerdicts: ['ACCEPT'] }),
    plannerManifest: plannerManifestOf(), proposal, context: CONTEXT, evidenceRefs: EVIDENCE,
  });
  assert.equal(narrow.code, 'VERDICT_NOT_ALLOWED');
  assert.match(narrow.errors.join(','), /did not declare verdict REJECT/);
});

test('复核结论不得夹带状态轴或身份字段（与提案层共用同一份判定的两种落点）', () => {
  const proposal = proposalOf();

  const axis = check(reviewOf(proposal, { executionStatus: 'SUCCEEDED' }), { proposal });
  assert.equal(axis.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(axis.details.field, 'executionStatus');

  const identity = check(reviewOf(proposal, { reviewer: { name: 'agent.reviewer', version: '1.0.0', identity: { accountId: 'x' } } }), { proposal });
  assert.equal(identity.code, 'STATE_MUTATION_FORBIDDEN');

  // 把状态轴**取值**塞进像状态的键上，也要拒（否则调用方可能把理由误读成状态）。
  const leaked = check(reviewOf(proposal, { reasons: [{ key: 'r1', status: 'HELD', evidenceRefs: ['evidence-1'] }] }), { proposal });
  assert.equal(leaked.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(leaked.details.value, 'HELD');
});

test('复核的形状校验：runId 必须与运行和被复核提案同时对齐', () => {
  const proposal = proposalOf();

  const wrongRun = validateReview(reviewOf(proposal, { runId: 'other-run' }), {
    reviewerManifest: reviewerManifestOf(), plannerManifest: plannerManifestOf(), proposal, context: CONTEXT, evidenceRefs: EVIDENCE,
  });
  assert.equal(wrongRun.code, 'REVIEW_INVALID');

  const noProposal = validateReview(reviewOf(proposal), {
    reviewerManifest: reviewerManifestOf(), plannerManifest: plannerManifestOf(), context: CONTEXT, evidenceRefs: EVIDENCE,
  });
  assert.equal(noProposal.code, 'REVIEW_INVALID');
  assert.match(noProposal.errors.join(','), /must name the proposal it reviews/);

  assert.equal(check(null, { proposal }).code, 'REVIEW_INVALID');
  assert.equal(check({}, { proposal }).code, 'REVIEW_INVALID');

  const noKey = check(reviewOf(proposal, { reasons: [{ evidenceRefs: ['evidence-1'] }] }), { proposal });
  assert.equal(noKey.code, 'REVIEW_INVALID');
  assert.match(noKey.errors.join(','), /every reason needs a key/);
});

test('「复核者与提案者必须是两个 Agent」有静态检查，且把角色一起判', () => {
  assert.equal(assertReviewerIndependent({ plannerManifest: plannerManifestOf(), reviewerManifest: reviewerManifestOf() }).ok, true);

  const same = assertReviewerIndependent({
    plannerManifest: plannerManifestOf({ name: 'agent.one' }),
    reviewerManifest: reviewerManifestOf({ name: 'agent.one' }),
  });
  assert.equal(same.ok, false);
  assert.match(same.reasons.join(','), /must be different agents/);

  const swapped = assertReviewerIndependent({ plannerManifest: reviewerManifestOf(), reviewerManifest: plannerManifestOf() });
  assert.equal(swapped.ok, false);
  assert.match(swapped.reasons.join(','), /reviewer manifest role must be reviewer/);
  assert.match(swapped.reasons.join(','), /planner manifest role must be planner/);
});

test('复核端口：合法复核产出 decision；ESCALATE 表达为「需要人」，不是失败', async () => {
  const proposal = proposalOf();
  const boundStep = { capabilityId: 'xws.faq.product-collect', collectInput: { productId: 'p-1' }, reason: 'next', evidenceRefs: ['evidence-1'] };
  let seenStep;

  const port = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async ({ proposal: given, step, tools }) => {
      assert.equal(given, proposal);
      seenStep = step;
      assert.deepEqual(tools, [...READ_ONLY_TOOLS]);
      return reviewOf(proposal);
    },
  });
  const accepted = await port.review({ proposal, step: boundStep, context: CONTEXT, plannerManifest: plannerManifestOf(), evidenceRefs: EVIDENCE });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.verdict, 'ACCEPT');
  assert.equal(accepted.humanRequired, false);
  assert.equal(accepted.fallbackRequired, false);
  assert.equal(accepted.decision.kind, 'AGENT_REVIEW');
  // 复核者必须能看到**将要执行的归一化步骤**，否则「复核已通过边界的步骤」只是一句话。
  assert.deepEqual(seenStep, boundStep);

  const escalate = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async () => reviewOf(proposal, { verdict: 'ESCALATE' }),
  });
  const escalated = await escalate.review({ proposal, context: CONTEXT, plannerManifest: plannerManifestOf(), evidenceRefs: EVIDENCE });
  assert.equal(escalated.ok, true);
  assert.equal(escalated.verdict, 'ESCALATE');
  assert.equal(escalated.humanRequired, true, 'ESCALATE 的语义是「让人来看」，必须显式标出');
  assert.equal(escalated.fallbackRequired, false, 'ESCALATE 不是复核失败，不该走兜底');
  // 返回契约是全量的：humanRequired 每条路径都存在，调用方不必区分 undefined 与 false。
  for (const outcome of [accepted, escalated]) {
    assert.ok(Object.hasOwn(outcome, 'humanRequired'), 'humanRequired 必须总是在场');
    assert.equal(typeof outcome.humanRequired, 'boolean');
  }
});

test('复核者坏掉时降级到确定性兜底，绝不把异常抛给编排层', async () => {
  const proposal = proposalOf();

  const throwing = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async () => { throw new Error('reviewer model timeout'); },
  });
  const failed = await throwing.review({ proposal, context: CONTEXT, plannerManifest: plannerManifestOf(), evidenceRefs: EVIDENCE });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AGENT_FAILED');
  assert.equal(failed.fallbackRequired, true);
  assert.equal(failed.humanRequired, false);
  assert.ok(failed.fallback, '必须给出确定性兜底路径');
  assert.equal(failed.decision, null);

  const illegal = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async () => reviewOf(proposal, { verdict: 'PASS' }),
  });
  const rejected = await illegal.review({ proposal, context: CONTEXT, plannerManifest: plannerManifestOf(), evidenceRefs: EVIDENCE });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'VERDICT_NOT_ALLOWED');
  assert.equal(rejected.fallbackRequired, true);
  assert.equal(rejected.decision, null);

  // 失败路径也必须给出 humanRequired:false（而不是省略该字段）。
  for (const outcome of [failed, rejected]) {
    assert.ok(Object.hasOwn(outcome, 'humanRequired'), '失败路径也要显式给出 humanRequired');
    assert.equal(outcome.humanRequired, false, '降级兜底不等于需要人');
  }
});

test('角色分离：planner 端口拒接 reviewer 的 manifest，反之亦然', () => {
  assert.throws(
    () => createAgentPort({ agentManifest: reviewerManifestOf(), runAgent: async () => ({}) }),
    (error) => error instanceof AgentContractError && error.code === 'ROLE_INVALID',
  );
  // 不带 role 的既有 manifest 仍然按 planner 处理（保证迁移期向后兼容）。
  const legacy = { ...plannerManifestOf() };
  delete legacy.role;
  assert.doesNotThrow(() => createAgentPort({ agentManifest: legacy, runAgent: async () => ({}) }));
});

test('拒绝原因枚举与实现一致', () => {
  assert.deepEqual([...REVIEW_REJECTION], [
    'REVIEW_INVALID', 'ROLE_INVALID', 'REVIEWER_MISMATCH', 'SELF_REVIEW_FORBIDDEN',
    'VERDICT_NOT_ALLOWED', 'REASON_WITHOUT_EVIDENCE', 'EVIDENCE_REF_UNKNOWN',
    'STATE_MUTATION_FORBIDDEN', 'PROPOSAL_MISMATCH', 'AGENT_FAILED',
  ]);
  // 复核层与提案层共用同一套状态轴禁止字段：这里用「提案层的实现」做交叉验证，
  // 避免两处各写一份后静默分叉。
  const leaked = check(reviewOf(proposalOf(), { verifiedCursor: { end: 9 } }), {});
  assert.equal(leaked.code, 'STATE_MUTATION_FORBIDDEN');
  assert.equal(leaked.details.field, 'verifiedCursor');
});
