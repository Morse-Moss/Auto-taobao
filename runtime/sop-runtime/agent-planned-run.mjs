// Agent 规划步骤的确定性边界（实施计划「迁移顺序第 7 项」的主体）。
//
// 这一层只做一件事：把「Agent 提议什么」与「运行时允许做什么」彻底分开。
// 分工是：
//   Planner（Agent）    → 从**调用方预先批准的候选集**里挑一个下一步，附理由与证据；
//   边界检查（本模块）  → 用注册表、Policy 与文件系统事实判定这个步骤是否可执行；
//   Reviewer（Agent）   → 对**已通过边界**的步骤给 ACCEPT / REJECT / ESCALATE；
//   落点（Controller）  → 全部结论只进 decisions；要不要真的执行由编排层按 action 决定。
//
// 四条不可让渡的边界（都在本模块里硬判，不依赖 Agent 自觉）：
//   1. 候选项由调用方声明。Agent 不能发明能力，也不能跑到候选集之外——
//      BOUND_CHECK_REQUIRED 就是「调用方没声明候选集」时 fail-closed 的答案；
//   2. 写外部的能力在未获授权时**不允许**成为自动执行的步骤（STEP_REQUIRES_WRITE_AUTHORIZATION），
//      Agent 可以提议它，但运行时不会替它开闸；
//   3. 输入里的路径必须是「allowedRoots 之下且真实存在」的文件——
//      Agent 不能指向一个不存在的证据，也不能指向仓库外的任意文件；
//   4. Agent 失败、提案非法、边界拒绝、复核非 ACCEPT 四种情况**都不抛异常**，
//      而是明确返回 RUN_FALLBACK / PAUSE_FOR_HUMAN，让确定性 SOP 继续跑。
//      （这就是「移除 Agent 后确定性流程仍可运行」在代码里的样子。）
//      边界还包括「端口自己抛异常」：即便调用方绕过 createAgentPort/createReviewerPort
//      直接塞一个裸适配器进来，Agent 层坏掉也只降级为兜底，不会把 SOP 一起带走。
import { EXTERNAL_WRITE_EFFECTS } from './policy.mjs';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const STEP_ACTIONS = Object.freeze(['RUN_PLANNED', 'RUN_FALLBACK', 'PAUSE_FOR_HUMAN']);

export const STEP_REJECTION = Object.freeze([
  'BOUND_CHECK_REQUIRED', 'PROPOSAL_KIND_NOT_PLAN', 'STEP_CLAIM_MISSING', 'STEP_CLAIM_INVALID',
  'STEP_NOT_CANDIDATE', 'STEP_NOT_REGISTERED', 'STEP_REQUIRES_WRITE_AUTHORIZATION',
  'STEP_INPUT_FORBIDDEN', 'STEP_INPUT_UNRESOLVED', 'STEP_INPUT_OUT_OF_ROOT',
]);

// PLAN 提案的契约（写在这里也写在 SKILL 文档里：Agent 只被允许用这三个 claim 表达下一步）。
export const PLAN_CLAIMS = Object.freeze({
  capability: 'next.capability',
  collectInput: 'next.collectInput',
  reason: 'next.reason',
});

export class StepError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'StepError';
    this.code = code;
    this.details = details;
  }
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());
const PATH_LIKE_KEY = /(file|dir|path)$/i;

// 从 PLAN 提案里把「步骤」确定性解析出来。
// 刻意用 key 白名单（而不是把 output 整个当命令用）：Agent 能表达的东西必须是可以被穷举的。
export function proposedStepFrom(proposal) {
  if (!proposal || typeof proposal !== 'object') throw new StepError('proposal must be an object', 'STEP_CLAIM_INVALID');
  if (proposal.kind !== 'PLAN') {
    throw new StepError(`a planned step requires a PLAN proposal, got ${proposal.kind}`, 'PROPOSAL_KIND_NOT_PLAN');
  }
  const claims = Array.isArray(proposal.output?.claims) ? proposal.output.claims : [];
  const claimOf = (key) => claims.find((claim) => claim?.key === key) ?? null;

  const capabilityClaim = claimOf(PLAN_CLAIMS.capability);
  if (!capabilityClaim) {
    throw new StepError(`PLAN proposal must carry a ${PLAN_CLAIMS.capability} claim`, 'STEP_CLAIM_MISSING', { claims: claims.map((claim) => claim?.key ?? null) });
  }
  const capabilityId = asText(capabilityClaim.value);
  if (!capabilityId) {
    throw new StepError(`${PLAN_CLAIMS.capability} must be a non-empty capability id`, 'STEP_CLAIM_INVALID');
  }

  const inputClaim = claimOf(PLAN_CLAIMS.collectInput);
  let collectInput = {};
  if (inputClaim) {
    const value = inputClaim.value ?? {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new StepError(`${PLAN_CLAIMS.collectInput} must be an object of scalar values`, 'STEP_CLAIM_INVALID', { got: typeof value });
    }
    collectInput = value;
  }

  const reasonClaim = claimOf(PLAN_CLAIMS.reason);
  return {
    capabilityId,
    collectInput: { ...collectInput },
    reason: reasonClaim ? (asText(reasonClaim.value) || null) : null,
    evidenceRefs: [...(capabilityClaim.evidenceRefs ?? [])],
  };
}

// 边界检查：回答「这个步骤允许被自动执行吗」。纯函数，副作用只有文件存在性读取。
export function boundCheckStep(step, {
  registry = null,
  candidateCapabilities = null,
  allowWrite = false,
  allowedRoots = [],
  allowedInputKeys = null,
  pathKeys = null,
  baselineCollectInput = {},
} = {}) {
  const fail = (code, message, details = {}) => ({ ok: false, code, errors: [message], details, step: null });

  // 1. 候选集必须由调用方声明。没有候选集就没有「在边界内」这件事，直接 fail-closed。
  if (!Array.isArray(candidateCapabilities) || candidateCapabilities.length === 0) {
    return fail('BOUND_CHECK_REQUIRED', 'candidateCapabilities must be declared before an agent step can be admitted');
  }
  const capabilityId = asText(step?.capabilityId);
  if (!candidateCapabilities.includes(capabilityId)) {
    return fail('STEP_NOT_CANDIDATE', `planned capability ${capabilityId || '<empty>'} is not in the caller-approved candidate set`, { candidateCapabilities });
  }

  // 2. 必须已登记。agent 不能提议一个「存在但没登记」的能力来绕过副作用闸门。
  if (!registry || typeof registry.require !== 'function') {
    return fail('BOUND_CHECK_REQUIRED', 'a skill registry is required to validate a planned capability');
  }
  let entry = null;
  try {
    entry = registry.require(capabilityId);
  } catch (error) {
    return fail('STEP_NOT_REGISTERED', `planned capability ${capabilityId} is not registered`, { error: String(error?.message ?? error) });
  }
  const declaredEffects = entry?.manifest?.sideEffects ?? [];
  const writesExternally = declaredEffects.some((effect) => EXTERNAL_WRITE_EFFECTS.includes(effect));

  // 3. 写外部且在未授权模式下 → 拒绝自动执行（Agent 可以提议，运行时不开闸）。
  if (writesExternally && allowWrite !== true) {
    return fail('STEP_REQUIRES_WRITE_AUTHORIZATION', `planned capability ${capabilityId} declares external writes (${declaredEffects.join(', ')}) and this step is not authorized to write`, { declaredEffects });
  }

  // 4. 输入面收敛：键必须在允许集合内，值只能是标量。
  const merged = { ...(baselineCollectInput ?? {}), ...(step?.collectInput ?? {}) };
  const allowedKeys = Array.isArray(allowedInputKeys) ? allowedInputKeys : null;
  for (const [key, value] of Object.entries(merged)) {
    if (allowedKeys && !allowedKeys.includes(key)) {
      return fail('STEP_INPUT_FORBIDDEN', `planned step sets input key ${key}, which the caller did not allow`, { key, allowedInputKeys: allowedKeys });
    }
    if (value !== null && typeof value === 'object') {
      return fail('STEP_INPUT_FORBIDDEN', `planned step input ${key} must be a scalar, got ${Array.isArray(value) ? 'array' : 'object'}`, { key });
    }
  }

  // 5. 路径类输入必须真实存在且落在允许的根目录下。
  // pathKeys 的语义是**收窄**而不是开关：显式给了非空列表就只检查这些键；
  // 给空数组（或不给）会回落到按键名后缀（file/dir/path）自动识别。
  // 因此 `pathKeys: []` **无法**用来关掉路径检查——这是刻意的 fail-closed 方向。
  // 逃生门是「把要检查的集合换成另一个」：真有 key 叫 xxxPath 却不是文件时，
  // 把 pathKeys 指到真正的路径键上即可（键集本身仍由 allowedInputKeys 收口）。
  const keys = Array.isArray(pathKeys) && pathKeys.length
    ? pathKeys
    : Object.keys(merged).filter((key) => PATH_LIKE_KEY.test(key));
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : []).map((root) => resolve(String(root)));
  for (const key of keys) {
    const value = merged[key];
    if (value === undefined || value === null || value === '') continue;
    if (!roots.length) {
      return fail('STEP_INPUT_OUT_OF_ROOT', `input ${key} is path-like but no allowedRoots were declared`, { key });
    }
    const absolute = resolve(String(value));
    const inside = roots.some((root) => absolute === root || absolute.startsWith(`${root}\\`) || absolute.startsWith(`${root}/`));
    if (!inside) {
      return fail('STEP_INPUT_OUT_OF_ROOT', `input ${key} resolves outside the allowed roots`, { key, path: absolute, allowedRoots: roots });
    }
    if (!existsSync(absolute)) {
      return fail('STEP_INPUT_UNRESOLVED', `input ${key} points at a file that does not exist`, { key, path: absolute });
    }
  }

  return {
    ok: true,
    code: null,
    errors: [],
    details: { writesExternally, declaredEffects },
    step: { capabilityId, collectInput: merged, reason: step?.reason ?? null, evidenceRefs: [...(step?.evidenceRefs ?? [])] },
  };
}

// 空计划的默认形状：所有分支都从这里出发，收据字段因此恒等（不会被某个分支漏掉）。
// humanRequired 也在这里给默认值 false：调用方只需要读一个布尔，不需要区分
// 「这个字段没被设置」与「明确地不需要人」。
function emptyPlan(overrides = {}) {
  return {
    action: 'RUN_FALLBACK',
    source: 'NONE',
    fallbackRequired: true,
    humanRequired: false,
    step: null,
    proposal: null,
    review: null,
    decisions: [],
    errors: [],
    details: {},
    ...overrides,
  };
}

// 规划一次「下一步」。永不抛异常：Agent 与复核者的任何失败都表达为 action/errors。
export async function planNextStep({
  plannerPort = null,
  reviewerPort = null,
  context = null,
  evidenceRefs = [],
  registry = null,
  candidateCapabilities = null,
  allowWrite = false,
  allowedRoots = [],
  allowedInputKeys = null,
  pathKeys = null,
  baselineCollectInput = {},
  input = {},
} = {}) {
  const boundOptions = { registry, candidateCapabilities, allowWrite, allowedRoots, allowedInputKeys, pathKeys, baselineCollectInput };

  // 没有 Planner 时不是错误路径，而是**默认路径**：确定性兜底（Agent 是可移除件）。
  if (!plannerPort) {
    return emptyPlan({ source: 'NONE', details: { reason: 'no planner agent configured; the deterministic fallback is the default path' } });
  }
  if (!reviewerPort) {
    // 有 Planner 无 Reviewer = 无人复核，不允许自动执行提案。仍走兜底，但把原因说清楚。
    return emptyPlan({ source: 'NONE', errors: ['a reviewer agent is required before a planned step can be admitted'] });
  }

  // 步骤 1：提案。
  // 端口本身也应永不抛异常（createAgentPort 已经把 Agent 的失败收成 ok:false），
  // 但这一层不能假设调用方一定用那个端口：有人直接塞一个裸适配器进来时，
  // 「Agent 层坏掉拖垮整条确定性 SOP」是必须被挡住的。所以这里再兜一层。
  let proposed;
  try {
    proposed = await plannerPort.propose({ context, evidenceRefs, input });
  } catch (error) {
    return emptyPlan({
      source: 'PLANNER',
      errors: [String(error?.message ?? error)],
      details: { stage: 'PROPOSE', code: 'AGENT_FAILED' },
    });
  }
  if (!proposed || typeof proposed !== 'object' || proposed.ok !== true) {
    return emptyPlan({
      source: 'PLANNER',
      errors: [proposed?.error ?? (proposed?.errors ?? ['planner returned no proposal']).join('; ')],
      details: { stage: 'PROPOSE', code: proposed?.code ?? 'AGENT_FAILED', fallback: proposed?.fallback ?? null },
    });
  }

  // 步骤 2：把提案解析成步骤（Agent 能表达什么，在契约里是封闭的）。
  let step = null;
  try {
    step = proposedStepFrom(proposed.proposal);
  } catch (error) {
    return emptyPlan({
      source: 'PLANNER',
      proposal: proposed.proposal,
      decisions: [proposed.decision].filter(Boolean),
      errors: [String(error?.message ?? error)],
      details: { stage: 'PARSE', code: error?.code ?? null, ...(error?.details ?? {}) },
    });
  }

  // 步骤 3：确定性边界。提案本身仍然进 decisions——「Agent 提了一个越界的步骤」是要留痕的事实。
  const bound = boundCheckStep(step, boundOptions);
  if (!bound.ok) {
    return emptyPlan({
      source: 'PLANNER',
      proposal: proposed.proposal,
      decisions: [proposed.decision].filter(Boolean),
      errors: bound.errors,
      details: { stage: 'BOUND_CHECK', code: bound.code, ...(bound.details ?? {}) },
    });
  }

  // 步骤 4：复核**已通过边界的步骤**（而不是原始提案）：复核者不该为运行时的越界负责。
  // 因此这里把归一化后的 step 一并交给复核者——「复核的是将要真正执行的东西」，
  // 而 Agent 写下的路径类输入此刻已经解析成绝对路径并通过了存在性/根目录检查。
  // 与提案端口同理，这里也对裸端口再兜一层。
  let reviewed;
  try {
    reviewed = await reviewerPort.review({
      proposal: proposed.proposal,
      step: bound.step,
      plannerManifest: plannerPort.manifest ?? null,
      context,
      evidenceRefs,
      input,
    });
  } catch (error) {
    return emptyPlan({
      source: 'REVIEWER',
      proposal: proposed.proposal,
      decisions: [proposed.decision].filter(Boolean),
      errors: [String(error?.message ?? error)],
      details: { stage: 'REVIEW', code: 'AGENT_FAILED' },
    });
  }
  const decisions = [proposed.decision, reviewed?.decision].filter(Boolean);
  if (!reviewed || typeof reviewed !== 'object' || reviewed.ok !== true) {
    return emptyPlan({
      source: 'REVIEWER',
      proposal: proposed.proposal,
      decisions,
      errors: [reviewed.error ?? ((reviewed.errors ?? []).join('; ') || 'reviewer returned no verdict')],
      details: { stage: 'REVIEW', code: reviewed.code ?? 'AGENT_FAILED', fallback: reviewed.fallback ?? null },
    });
  }
  if (reviewed.verdict === 'ESCALATE') {
    // 明确的「让人来看」：既不走兜底也不执行提案，编排层应据此停下。
    return emptyPlan({
      action: 'PAUSE_FOR_HUMAN',
      source: 'REVIEWER',
      fallbackRequired: false,
      humanRequired: true,
      proposal: proposed.proposal,
      review: reviewed.review,
      decisions,
      details: { stage: 'REVIEW', verdict: reviewed.verdict, humanRequired: true },
    });
  }
  if (reviewed.verdict !== 'ACCEPT') {
    return emptyPlan({
      source: 'REVIEWER',
      proposal: proposed.proposal,
      review: reviewed.review,
      decisions,
      errors: (reviewed.review?.reasons ?? []).map((reason) => `${reason.key}${reason.note ? `: ${reason.note}` : ''}`),
      details: { stage: 'REVIEW', verdict: reviewed.verdict },
    });
  }

  return {
    action: 'RUN_PLANNED',
    source: 'AGENT',
    fallbackRequired: false,
    humanRequired: false,
    step: bound.step,
    proposal: proposed.proposal,
    review: reviewed.review,
    decisions,
    errors: [],
    details: {
      stage: 'ACCEPTED',
      verdict: reviewed.verdict,
      writesExternally: bound.details.writesExternally,
      declaredEffects: bound.details.declaredEffects,
    },
  };
}

// 把一次规划的结论落进权威审计（decisions），而不是留在进程内存里。
// 没有结论时不写：空写入会让「这条 run 有审计」变成假象。
export async function recordPlanDecisions({ controller, runId, plan } = {}) {
  const decisions = (plan?.decisions ?? []).filter(Boolean);
  if (decisions.length === 0) return { recorded: 0, decisions: [] };
  if (!controller || typeof controller.recordDecisions !== 'function') {
    throw new StepError('controller.recordDecisions() is required to persist agent decisions', 'BOUND_CHECK_REQUIRED', {});
  }
  const updated = await controller.recordDecisions(runId, decisions);
  return { recorded: decisions.length, decisions, contextVersion: updated?.contextVersion ?? null };
}
