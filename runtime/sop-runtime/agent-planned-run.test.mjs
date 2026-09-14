// Agent 规划步骤边界的单测（迁移 7 主体）。
//
// 这一层要证明的不是「Agent 能挑出下一步」，而是**它挑错了也伤不到系统**：
//   - 候选集由调用方声明，Agent 不能发明能力、不能跑到集合外；
//   - 未登记的能力不能被提议（否则等于绕开副作用闸门）；
//   - 声明写外部的能力在未授权时不会被自动执行；
//   - 输入面收敛：键在白名单内、值只能是标量、路径必须真实存在且在允许根下；
//   - 提案失败/越界/复核非 ACCEPT —— 全部返回 RUN_FALLBACK / PAUSE_FOR_HUMAN，**永不抛异常**，
//     这就是「移除 Agent 后确定性流程仍可运行」在运行期的样子。
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_MANIFEST_SCHEMA_VERSION, PROPOSAL_SCHEMA_VERSION, createAgentPort } from './agent-proposal.mjs';
import { REVIEW_SCHEMA_VERSION, proposalDigest, createReviewerPort } from './agent-review.mjs';
import {
  STEP_ACTIONS, STEP_REJECTION, PLAN_CLAIMS, StepError,
  proposedStepFrom, boundCheckStep, planNextStep, recordPlanDecisions,
} from './agent-planned-run.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';
import { admitTask } from './task-admission.mjs';
import { createController } from './workflow-controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXISTING_FILE = resolvePath(HERE, 'agent-planned-run.mjs');
const MISSING_FILE = resolvePath(HERE, 'this-file-does-not-exist.mjs');
const OUTSIDE_FILE = resolvePath(HERE, '..', '..', 'package.json');

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const CONTEXT = Object.freeze({ runId: RUN_ID, executionStatus: 'RUNNING', evidenceStatus: 'VALIDATED' });
const EVIDENCE = Object.freeze([{ evidenceId: 'evidence-1' }]);

const CAPABILITY = 'xws.faq.product-collect';
const READ_ONLY_EFFECTS = Object.freeze(['browser_read', 'local_artifact']);

function plannerManifestOf(overrides = {}) {
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    kind: 'agent',
    name: 'agent.planner',
    version: '1.0.0',
    role: 'planner',
    tools: ['read_evidence', 'read_registry'],
    sideEffects: ['local_parse'],
    proposalKinds: ['PLAN'],
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
    tools: ['read_evidence', 'read_policy'],
    sideEffects: ['local_parse'],
    reviewVerdicts: ['ACCEPT', 'REJECT', 'ESCALATE'],
    deterministicFallback: 'deterministic bound checks alone decide whether a step may run',
    ...overrides,
  };
}

function planProposalOf({ capabilityId = CAPABILITY, collectInput, kind = 'PLAN', claims } = {}) {
  let finalClaims = claims;
  if (!finalClaims) {
    finalClaims = [{ key: PLAN_CLAIMS.capability, value: capabilityId, confidence: 0.9, evidenceRefs: ['evidence-1'] }];
    if (collectInput) finalClaims.push({ key: PLAN_CLAIMS.collectInput, value: collectInput, confidence: 0.8, evidenceRefs: ['evidence-1'] });
    finalClaims.push({ key: PLAN_CLAIMS.reason, value: 'cheapest verified next step', confidence: 0.7, evidenceRefs: ['evidence-1'] });
  }
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    runId: RUN_ID,
    agent: { name: 'agent.planner', version: '1.0.0' },
    kind,
    output: { claims: finalClaims },
  };
}

function reviewOf(proposal, { verdict = 'ACCEPT', reasons } = {}) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    runId: RUN_ID,
    reviewer: { name: 'agent.reviewer', version: '1.0.0' },
    proposalDigest: proposalDigest(proposal),
    verdict,
    reasons: reasons ?? [{ key: 'bound_and_evidence_ok', note: 'checked registry and evidence', evidenceRefs: ['evidence-1'] }],
  };
}

// 真端口（走 createAgentPort / createReviewerPort），也就是生产路径。
function portsOf({ plan, verdict = 'ACCEPT', plannerThrows = false, reviewerThrows = false, plannerProposalKinds = ['PLAN'] } = {}) {
  const plannerPort = createAgentPort({
    agentManifest: plannerManifestOf({ proposalKinds: plannerProposalKinds }),
    runAgent: async () => {
      if (plannerThrows) throw new Error('planner model timeout');
      return plan;
    },
  });
  const reviewerPort = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async ({ proposal }) => {
      if (reviewerThrows) throw new Error('reviewer model timeout');
      return reviewOf(proposal, { verdict });
    },
  });
  return { plannerPort, reviewerPort };
}

function registryOf(effectsByCapability = {}) {
  const table = { [CAPABILITY]: { sideEffects: READ_ONLY_EFFECTS }, ...effectsByCapability };
  return {
    require: (id) => {
      if (!table[id]) throw new Error(`capability not registered: ${id}`);
      return { manifest: { id, sideEffects: table[id].sideEffects } };
    },
  };
}

function planArgs(overrides = {}) {
  return {
    context: CONTEXT,
    evidenceRefs: EVIDENCE,
    registry: registryOf(),
    candidateCapabilities: [CAPABILITY],
    allowedRoots: [HERE],
    allowedInputKeys: ['productId', 'artifactFile'],
    baselineCollectInput: {},
    ...overrides,
  };
}

// ── 计划解析（Agent 能表达什么是封闭的）───────────────────────────────────
test('PLAN 提案解析：能力/输入/理由来自固定的三个 claim，其余一律不进步骤', () => {
  const step = proposedStepFrom(planProposalOf({ collectInput: { productId: 'p-1' } }));
  assert.equal(step.capabilityId, CAPABILITY);
  assert.deepEqual(step.collectInput, { productId: 'p-1' });
  assert.equal(step.reason, 'cheapest verified next step');
  assert.deepEqual(step.evidenceRefs, ['evidence-1']);

  // 没有输入 claim 时输入面为空对象，而不是 undefined。
  assert.deepEqual(proposedStepFrom(planProposalOf()).collectInput, {});

  // 非 PLAN 提案不能当成步骤 —— 这是「提案种类」与「执行」之间的第一道闸。
  assert.throws(() => proposedStepFrom(planProposalOf({ kind: 'CLASSIFY' })), (error) => error.code === 'PROPOSAL_KIND_NOT_PLAN');
  assert.throws(() => proposedStepFrom(null), (error) => error.code === 'STEP_CLAIM_INVALID');

  // 非 PLAN 提案不能当成步骤 —— 这是「提案种类」与「执行」之间的第一道闸。
  assert.throws(() => proposedStepFrom(planProposalOf({ kind: 'CLASSIFY' })), (error) => error.code === 'PROPOSAL_KIND_NOT_PLAN');
  assert.throws(() => proposedStepFrom(null), (error) => error.code === 'STEP_CLAIM_INVALID');

  // 缺少能力 claim：解析必须失败，而不是凭空造一个能力出来。
  assert.throws(
    () => proposedStepFrom(planProposalOf({ claims: [{ key: PLAN_CLAIMS.reason, value: 'x', evidenceRefs: ['evidence-1'] }] })),
    (error) => error.code === 'STEP_CLAIM_MISSING',
  );
  assert.throws(
    () => proposedStepFrom(planProposalOf({ claims: [{ key: PLAN_CLAIMS.capability, value: '   ', evidenceRefs: ['evidence-1'] }] })),
    (error) => error.code === 'STEP_CLAIM_INVALID',
  );
  assert.throws(
    () => proposedStepFrom(planProposalOf({ collectInput: ['not', 'an', 'object'] })),
    (error) => error.code === 'STEP_CLAIM_INVALID',
  );
});

// ── 边界检查（纯函数，逐条钉住拒绝原因）────────────────────────────────────
test('候选集必须由调用方声明；没有候选集就没有「在边界内」这回事', () => {
  const step = proposedStepFrom(planProposalOf());

  const noCandidates = boundCheckStep(step, { registry: registryOf(), candidateCapabilities: null });
  assert.equal(noCandidates.ok, false);
  assert.equal(noCandidates.code, 'BOUND_CHECK_REQUIRED');
  assert.equal(noCandidates.step, null, '被拒的步骤不得回传一个可执行对象');

  assert.equal(boundCheckStep(step, { registry: registryOf(), candidateCapabilities: [] }).code, 'BOUND_CHECK_REQUIRED');

  const outside = boundCheckStep(step, { registry: registryOf(), candidateCapabilities: ['some.other.capability'] });
  assert.equal(outside.code, 'STEP_NOT_CANDIDATE');
  assert.deepEqual(outside.details.candidateCapabilities, ['some.other.capability']);
});

test('未登记的能力不能被提议：否则等于绕开副作用闸门', () => {
  const step = proposedStepFrom(planProposalOf());
  assert.equal(boundCheckStep(step, { registry: null, candidateCapabilities: [CAPABILITY] }).code, 'BOUND_CHECK_REQUIRED');
  assert.equal(
    boundCheckStep(step, { registry: {}, candidateCapabilities: [CAPABILITY] }).code,
    'BOUND_CHECK_REQUIRED',
    '没有 require() 的注册表等于没有注册表',
  );

  const notRegistered = boundCheckStep(step, {
    registry: { require: () => { throw new Error('capability not registered'); } },
    candidateCapabilities: [CAPABILITY],
  });
  assert.equal(notRegistered.code, 'STEP_NOT_REGISTERED');
});

test('声明写外部的能力：未授权时不允许成为自动执行的步骤，授权后才放行', () => {
  const step = proposedStepFrom(planProposalOf());
  const writeRegistry = registryOf({ [CAPABILITY]: { sideEffects: ['browser_read', 'feishu_write'] } });

  const denied = boundCheckStep(step, { registry: writeRegistry, candidateCapabilities: [CAPABILITY] });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'STEP_REQUIRES_WRITE_AUTHORIZATION');
  assert.deepEqual(denied.details.declaredEffects, ['browser_read', 'feishu_write']);

  const allowed = boundCheckStep(step, { registry: writeRegistry, candidateCapabilities: [CAPABILITY], allowWrite: true });
  assert.equal(allowed.ok, true, '显式授权后放行');
  assert.equal(allowed.details.writesExternally, true);

  // 只读能力不受写闸门影响。
  const readOnly = boundCheckStep(step, { registry: registryOf(), candidateCapabilities: [CAPABILITY] });
  assert.equal(readOnly.ok, true);
  assert.equal(readOnly.details.writesExternally, false);
});

test('输入面收敛：键必须在白名单内，值只能是标量', () => {
  const forbiddenKey = boundCheckStep(proposedStepFrom(planProposalOf({ collectInput: { sneaky: 'x' } })), {
    registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['productId'],
  });
  assert.equal(forbiddenKey.code, 'STEP_INPUT_FORBIDDEN');
  assert.equal(forbiddenKey.details.key, 'sneaky');

  // baseline 与 step 合并后再判：调用方给的基线输入也不能越过白名单（不能靠基线偷渡）。
  const viaBaseline = boundCheckStep(proposedStepFrom(planProposalOf()), {
    registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['productId'], baselineCollectInput: { smuggled: 1 },
  });
  assert.equal(viaBaseline.code, 'STEP_INPUT_FORBIDDEN');
  assert.equal(viaBaseline.details.key, 'smuggled');

  for (const value of [{ nested: true }, ['a'], { a: 1 }]) {
    const nonScalar = boundCheckStep(proposedStepFrom(planProposalOf({ collectInput: { productId: value } })), {
      registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['productId'],
    });
    assert.equal(nonScalar.code, 'STEP_INPUT_FORBIDDEN', `${JSON.stringify(value)} 不是标量，应被拒`);
  }

  // 标量（含 null）通过。
  const ok = boundCheckStep(proposedStepFrom(planProposalOf({ collectInput: { productId: 'p-1' } })), {
    registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['productId'],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.step.collectInput, { productId: 'p-1' });
});

test('路径类输入必须真实存在且落在 allowedRoots 之下（Agent 不能指向仓库外的任意文件）', () => {
  const bound = (collectInput, extra = {}) => boundCheckStep(proposedStepFrom(planProposalOf({ collectInput })), {
    registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['artifactFile'], ...extra,
  });

  // 根目录下真实存在的文件 → 通过。
  const inside = bound({ artifactFile: EXISTING_FILE }, { allowedRoots: [HERE] });
  assert.equal(inside.ok, true, JSON.stringify(inside.errors ?? []));
  assert.equal(inside.step.collectInput.artifactFile, EXISTING_FILE);

  // 根目录之外（即使文件真实存在）→ 拒。
  assert.equal(bound({ artifactFile: OUTSIDE_FILE }, { allowedRoots: [HERE] }).code, 'STEP_INPUT_OUT_OF_ROOT');

  // 声称在根目录下但文件不存在 → 拒（不能指向一个不存在的证据）。
  assert.equal(bound({ artifactFile: MISSING_FILE }, { allowedRoots: [HERE] }).code, 'STEP_INPUT_UNRESOLVED');

  // 有路径类输入却没声明 allowedRoots → fail-closed，而不是「没根就等于任意根」。
  const noRoots = bound({ artifactFile: EXISTING_FILE });
  assert.equal(noRoots.code, 'STEP_INPUT_OUT_OF_ROOT');
  assert.equal(noRoots.details.key, 'artifactFile');

  // 空值不算路径输入，跳过检查。
  assert.equal(bound({ artifactFile: '' }, { allowedRoots: [HERE] }).ok, true);
  assert.equal(bound({ artifactFile: null }, { allowedRoots: [HERE] }).ok, true);

  // pathKeys 可显式指定。注意 `[]` **不表示**「不检查路径」，而是回落到按键名后缀自动识别——
  // 这是刻意的 fail-closed 方向：显式空数组不能用来关掉检查。
  const explicit = bound({ artifactFile: EXISTING_FILE }, { allowedRoots: [HERE], pathKeys: ['artifactFile'] });
  assert.equal(explicit.ok, true);
  assert.equal(bound({ artifactFile: MISSING_FILE }, { allowedRoots: [HERE], pathKeys: [] }).code, 'STEP_INPUT_UNRESOLVED');

  // 逃生门是「把要检查的路径键收窄成另一个集合」，而不是把检查整体关掉：
  // 真的有 key 叫 xxxPath 但它不是文件（例如浏览器 profile 名）时，用这种方式排除。
  const narrowed = bound(
    { artifactFile: MISSING_FILE },
    { allowedRoots: [HERE], allowedInputKeys: ['artifactFile', 'notARealPath'], pathKeys: ['notARealPath'] },
  );
  assert.equal(narrowed.ok, true, '未被列入 pathKeys 的键不做文件存在性检查');

  // 换成非路径类输入时，不触发路径检查。
  const nonPath = boundCheckStep(proposedStepFrom(planProposalOf({ collectInput: { productId: 'p-1' } })), {
    registry: registryOf(), candidateCapabilities: [CAPABILITY], allowedInputKeys: ['productId'], allowedRoots: [],
  });
  assert.equal(nonPath.ok, true, '非路径类输入不需要 allowedRoots');
});

// ── 四步流水：永不抛异常 ──────────────────────────────────────────────────
test('没有 Planner、或没有 Reviewer 时，兜底就是默认路径，不是错误路径', async () => {
  const neither = await planNextStep(planArgs());
  assert.equal(neither.action, 'RUN_FALLBACK');
  assert.equal(neither.source, 'NONE');
  assert.equal(neither.fallbackRequired, true);
  assert.equal(neither.step, null);
  assert.deepEqual(neither.decisions, [], '没有任何 Agent 产出时不得凭空写审计');
  assert.match(neither.details.reason, /no planner agent configured/);

  const plannerOnly = await planNextStep(planArgs({ plannerPort: portsOf({ plan: planProposalOf() }).plannerPort }));
  assert.equal(plannerOnly.action, 'RUN_FALLBACK');
  assert.match(plannerOnly.errors.join(','), /reviewer agent is required/);
});

test('提案阶段失败（抛错 / 非法 / 非 PLAN）一律降级兜底，并把提案留痕', async () => {
  const { plannerPort } = portsOf({ plan: planProposalOf(), plannerThrows: true });
  const { reviewerPort } = portsOf({ plan: planProposalOf() });

  const threw = await planNextStep(planArgs({ plannerPort, reviewerPort }));
  assert.equal(threw.action, 'RUN_FALLBACK');
  assert.equal(threw.source, 'PLANNER');
  assert.equal(threw.details.stage, 'PROPOSE');
  assert.equal(threw.details.code, 'AGENT_FAILED');
  assert.ok(threw.details.fallback, '必须带上确定性兜底路径');
  assert.deepEqual(threw.decisions, [], 'Agent 失败没有可留痕的提案');

  // 裸端口抛错同样被兜住：Agent 层坏掉不能把确定性 SOP 一起带走。
  const rawThrowing = await planNextStep(planArgs({
    plannerPort: { manifest: plannerManifestOf(), propose: async () => { throw new Error('raw adapter exploded'); } },
    reviewerPort, allowWrite: false,
  }));
  assert.equal(rawThrowing.action, 'RUN_FALLBACK');
  assert.equal(rawThrowing.details.code, 'AGENT_FAILED');
  assert.match(rawThrowing.errors.join(','), /raw adapter exploded/);

  // 非 PLAN 提案：解析阶段失败，但提案本身仍要留痕（「Agent 提了别的种类」是事实）。
  const notPlan = await planNextStep(planArgs({
    ...portsOf({ plan: planProposalOf({ kind: 'CLASSIFY' }), plannerProposalKinds: ['CLASSIFY', 'PLAN'] }),
  }));
  assert.equal(notPlan.action, 'RUN_FALLBACK');
  assert.equal(notPlan.details.stage, 'PARSE');
  assert.equal(notPlan.details.code, 'PROPOSAL_KIND_NOT_PLAN');
  assert.equal(notPlan.decisions.length, 1);
  assert.equal(notPlan.decisions[0].kind, 'AGENT_PROPOSAL');

  // 另一条更靠前的闸门：agent 只声明了 PLAN，却给出 CLASSIFY —— 在**提案阶段**就被拒，
  // 连解析都轮不到。两条闸门分别钉住「能力声明范围」与「步骤契约」。
  const undeclaredKind = await planNextStep(planArgs({
    ...portsOf({ plan: planProposalOf({ kind: 'CLASSIFY' }) }),
  }));
  assert.equal(undeclaredKind.action, 'RUN_FALLBACK');
  assert.equal(undeclaredKind.details.stage, 'PROPOSE');
  assert.equal(undeclaredKind.details.code, 'KIND_NOT_ALLOWED');
  assert.deepEqual(undeclaredKind.decisions, []);

  // 缺少能力 claim：解析阶段失败。
  const noClaim = await planNextStep(planArgs({
    ...portsOf({ plan: planProposalOf({ claims: [{ key: PLAN_CLAIMS.reason, value: 'x', evidenceRefs: ['evidence-1'] }] }) }),
  }));
  assert.equal(noClaim.details.code, 'STEP_CLAIM_MISSING');
});

test('边界检查失败：越界能力不执行，但「Agent 提了越界步骤」必须留痕', async () => {
  const { plannerPort, reviewerPort } = portsOf({ plan: planProposalOf({ capabilityId: 'xws.not.approved' }) });
  const outside = await planNextStep(planArgs({ plannerPort, reviewerPort }));
  assert.equal(outside.action, 'RUN_FALLBACK');
  assert.equal(outside.details.stage, 'BOUND_CHECK');
  assert.equal(outside.details.code, 'STEP_NOT_CANDIDATE');
  assert.equal(outside.decisions.length, 1, '越界提案仍进审计');
  assert.equal(outside.step, null);
  assert.equal(outside.review, null, '越界步骤不该送去复核——复核者不为运行时的越界负责');

  const { plannerPort: p2, reviewerPort: r2 } = portsOf({ plan: planProposalOf({ collectInput: { productId: 'p-1' } }) });
  const unregistered = await planNextStep(planArgs({ plannerPort: p2, reviewerPort: r2, registry: registryOf({}) , candidateCapabilities: ['unregistered.capability'] }));
  assert.equal(unregistered.details.code, 'STEP_NOT_CANDIDATE', '不在候选集内先于未登记命中');

  const writePorts = portsOf({ plan: planProposalOf() });
  const needsAuth = await planNextStep(planArgs({
    ...writePorts,
    registry: registryOf({ [CAPABILITY]: { sideEffects: ['feishu_write'] } }),
  }));
  assert.equal(needsAuth.details.code, 'STEP_REQUIRES_WRITE_AUTHORIZATION');

  const authorized = await planNextStep(planArgs({
    ...writePorts,
    registry: registryOf({ [CAPABILITY]: { sideEffects: ['feishu_write'] } }),
    allowWrite: true,
  }));
  assert.equal(authorized.action, 'RUN_PLANNED');
  assert.equal(authorized.details.writesExternally, true);
});

test('复核阶段失败：降级兜底，提案仍留痕；复核非 ACCEPT 时分别走兜底与「等人」', async () => {
  const proposal = planProposalOf();

  const reviewerThrew = await planNextStep(planArgs({ ...portsOf({ plan: proposal, reviewerThrows: true }) }));
  assert.equal(reviewerThrew.action, 'RUN_FALLBACK');
  assert.equal(reviewerThrew.source, 'REVIEWER');
  assert.equal(reviewerThrew.details.stage, 'REVIEW');
  assert.equal(reviewerThrew.details.code, 'AGENT_FAILED');
  assert.equal(reviewerThrew.decisions.length, 1, '只有提案那条留痕，没有复核结论');

  // 裸复核端口抛错同样兜住。
  const rawReviewer = await planNextStep(planArgs({
    plannerPort: portsOf({ plan: proposal }).plannerPort,
    reviewerPort: { manifest: reviewerManifestOf(), review: async () => { throw new Error('reviewer adapter exploded'); } },
  }));
  assert.equal(rawReviewer.action, 'RUN_FALLBACK');
  assert.equal(rawReviewer.details.code, 'AGENT_FAILED');
  assert.match(rawReviewer.errors.join(','), /reviewer adapter exploded/);

  const rejected = await planNextStep(planArgs({ ...portsOf({ plan: proposal, verdict: 'REJECT' }) }));
  assert.equal(rejected.action, 'RUN_FALLBACK');
  assert.equal(rejected.source, 'REVIEWER');
  assert.equal(rejected.details.verdict, 'REJECT');
  assert.equal(rejected.decisions.length, 2, '提案与复核结论都要留痕');
  assert.match(rejected.errors.join(','), /bound_and_evidence_ok/);

  const escalated = await planNextStep(planArgs({ ...portsOf({ plan: proposal, verdict: 'ESCALATE' }) }));
  assert.equal(escalated.action, 'PAUSE_FOR_HUMAN');
  assert.equal(escalated.source, 'REVIEWER');
  assert.equal(escalated.fallbackRequired, false, 'ESCALATE 不是兜底，是明确的「让人来看」');
  assert.equal(escalated.details.humanRequired, true);
  assert.equal(escalated.step, null, '被升级给人的步骤不得同时回传一个可执行对象');
  assert.equal(escalated.decisions.length, 2);
});

test('全部通过：产出 RUN_PLANNED 步骤，并带上复核结论与合并后的输入', async () => {
  // 复核者拿到的应当是**归一化后的步骤**，而不只是原始提案——
  // 否则「复核的是已通过边界的步骤」这句话在代码里不成立。
  let seenStep = null;
  const plannerPort = createAgentPort({
    agentManifest: plannerManifestOf(),
    runAgent: async () => planProposalOf({ collectInput: { productId: 'p-1' } }),
  });
  const reviewerPort = createReviewerPort({
    reviewerManifest: reviewerManifestOf(),
    runReviewer: async ({ proposal, step }) => {
      seenStep = step;
      return reviewOf(proposal);
    },
  });
  const plan = await planNextStep(planArgs({ plannerPort, reviewerPort, baselineCollectInput: { productId: 'from-baseline' } }));
  assert.equal(plan.action, 'RUN_PLANNED');
  assert.equal(plan.source, 'AGENT');
  assert.equal(plan.fallbackRequired, false);
  assert.equal(plan.humanRequired, false);
  assert.equal(plan.details.stage, 'ACCEPTED');
  assert.equal(plan.details.verdict, 'ACCEPT');
  assert.equal(plan.step.capabilityId, CAPABILITY);
  assert.deepEqual(plan.step.collectInput, { productId: 'p-1' }, '步骤输入优先于基线输入');
  assert.deepEqual(seenStep, plan.step, '复核者看到的必须就是将要执行的步骤');
  assert.equal(plan.decisions.length, 2);
  assert.deepEqual(plan.decisions.map((decision) => decision.kind), ['AGENT_PROPOSAL', 'AGENT_REVIEW']);
  assert.equal(plan.decisions[1].verdict, 'ACCEPT');
  assert.equal(plan.decisions[1].proposalDigest, proposalDigest(plan.proposal), '复核结论与被采纳的提案同源');

  // 步骤里的能力必须真的是候选集里那个，不能被 Agent 的文本替换掉。
  assert.equal(plan.step.capabilityId, CAPABILITY);
});

test('planNextStep 永不抛异常：把会抛错的一切都包住', async () => {
  const hostile = [
    { plannerPort: { manifest: {} }, reviewerPort: {} },
    { plannerPort: { propose: null }, reviewerPort: {} },
    { plannerPort: { propose: async () => null }, reviewerPort: {} },
    { plannerPort: { propose: async () => ({ ok: true, proposal: null, decision: null }) }, reviewerPort: {} },
    { plannerPort: { propose: async () => ({ ok: true, proposal: planProposalOf(), decision: null }) }, reviewerPort: null },
  ];
  for (const [index, args] of hostile.entries()) {
    const result = await planNextStep(planArgs(args));
    assert.equal(typeof result.action, 'string', `第 ${index} 种恶意输入应返回结构化结果`);
    assert.ok(STEP_ACTIONS.includes(result.action), `第 ${index} 种恶意输入的动作必须在枚举内`);
    // 收据字段恒等：任何分支都不许漏字段（调用方不需要区分 undefined 与 false）。
    for (const field of ['fallbackRequired', 'humanRequired', 'decisions', 'errors', 'step', 'proposal', 'review']) {
      assert.ok(Object.hasOwn(result, field), `第 ${index} 种恶意输入缺字段 ${field}`);
    }
  }
});

// ── 审计落点 ───────────────────────────────────────────────────────────────
test('规划结论落进权威审计：走 controller.recordDecisions，空结论不写', async () => {
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => 'attempt-x' });
  const admission = await admitTask({
    store,
    spec: {
      taskId: 'sop-planned',
      workflow: 'xws.faq',
      capability: CAPABILITY,
      identity: { tenantId: 't-1', storeId: 's-1', platform: 'taobao', accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1' },
    },
    idFactory: () => RUN_ID,
  });
  assert.equal(admission.admitted, true);

  const empty = await recordPlanDecisions({ controller, runId: RUN_ID, plan: { decisions: [] } });
  assert.deepEqual(empty, { recorded: 0, decisions: [] });
  const untouched = await controller.getContext(RUN_ID);
  assert.deepEqual(untouched.decisions, [], '空写入会让「这条 run 有审计」变成假象');

  await assert.rejects(() => recordPlanDecisions({ runId: RUN_ID, plan: { decisions: [{ kind: 'AGENT_PROPOSAL' }] } }), (error) => (
    error instanceof StepError && error.code === 'BOUND_CHECK_REQUIRED'
  ));

  const plan = await planNextStep(planArgs({
    ...portsOf({ plan: planProposalOf({ collectInput: { productId: 'p-1' } }) }),
    baselineCollectInput: {},
  }));
  assert.equal(plan.action, 'RUN_PLANNED');
  const recorded = await recordPlanDecisions({ controller, runId: RUN_ID, plan });
  assert.equal(recorded.recorded, 2);
  assert.equal(recorded.contextVersion, untouched.contextVersion + 1);

  const after = await controller.getContext(RUN_ID);
  assert.equal(after.decisions.length, 2);
  assert.deepEqual(after.decisions.map((decision) => decision.kind), ['AGENT_PROPOSAL', 'AGENT_REVIEW']);
  // 审计写入不得顺带改动任何状态轴 —— Agent 产物只进 decisions。
  for (const axis of ['executionStatus', 'evidenceStatus', 'humanGateStatus', 'leaseStatus', 'publicationStatus']) {
    assert.equal(after[axis], untouched[axis], `追加审计不得改动 ${axis}`);
  }
});

test('动作与拒绝原因枚举与实现一致', () => {
  assert.deepEqual([...STEP_ACTIONS], ['RUN_PLANNED', 'RUN_FALLBACK', 'PAUSE_FOR_HUMAN']);
  assert.deepEqual([...STEP_REJECTION], [
    'BOUND_CHECK_REQUIRED', 'PROPOSAL_KIND_NOT_PLAN', 'STEP_CLAIM_MISSING', 'STEP_CLAIM_INVALID',
    'STEP_NOT_CANDIDATE', 'STEP_NOT_REGISTERED', 'STEP_REQUIRES_WRITE_AUTHORIZATION',
    'STEP_INPUT_FORBIDDEN', 'STEP_INPUT_UNRESOLVED', 'STEP_INPUT_OUT_OF_ROOT',
  ]);
  assert.deepEqual({ ...PLAN_CLAIMS }, { capability: 'next.capability', collectInput: 'next.collectInput', reason: 'next.reason' });
  assert.ok(!STEP_ACTIONS.some((action) => /EXECUTE|WRITE|PUBLISH|COMMIT/.test(action)));
});
