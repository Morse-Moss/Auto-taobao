// Agent 接入契约（Spec：Agent 只出提案，不改状态；移除 Agent 后确定性流程仍可运行）。
//
// 三条硬约束，任何一条不成立就不允许 Agent 参与：
//   1. Agent 只能声明**只读工具**，不得声明任何外部写副作用；
//   2. Agent 只能产出 proposal（分类/摘要/解析/计划/建议），**不得触碰五条状态轴与身份字段**；
//   3. 每条断言必须带证据引用；无证据的断言一律拒绝——「模型说的」不是证据。
//
// 与 Controller 的分工：Controller 是唯一状态拥有者。Agent 的产物经本模块校验后，
// 只被转成 `decisions`（审计记录）交给 Controller 追加，**不产生任何状态转移**。
// 因此「把 Agent 拿掉」只是少了一条 decisions，确定性流程照跑。
import { CONTEXT_STATE_AXIS_FIELDS, EVIDENCE_STATUS, EXECUTION_STATUS, HUMAN_GATE_STATUS, LEASE_STATUS, PUBLICATION_STATUS } from './context-schema.mjs';
import { RISK_CLASS } from './policy.mjs';

export const AGENT_MANIFEST_SCHEMA_VERSION = 'agent-capability-v1';
export const PROPOSAL_SCHEMA_VERSION = 'agent-proposal-v1';

// Agent 的角色。两个角色都不是「执行者」：
//  - planner：出提案（本文件）；
//  - reviewer：对提案做对抗性复核（agent-review.mjs）。
// 角色分开的硬理由：同一条链上的复核不能由产出提案的那个 Agent 自己做。
export const AGENT_ROLES = Object.freeze(['planner', 'reviewer']);

// 复核结论（reviewer 的取值域）。刻意与状态轴无关：它是不是状态轴由 Controller 决定，
// Agent 只能给出「我认为可以 / 不可以 / 需要人看」三种意见。
export const REVIEW_VERDICTS = Object.freeze(['ACCEPT', 'REJECT', 'ESCALATE']);

// 允许的提案种类：全部是「读 + 生成文本/标签」性质，没有一种是「执行」。
export const PROPOSAL_KINDS = Object.freeze(['CLASSIFY', 'PARSE', 'SUMMARIZE', 'PLAN', 'RECOMMEND']);

// Agent 可用的工具白名单。只读是设计约束，不是配置项——
// 需要写外部的能力必须走 Worker/Publisher，不允许以「工具」名义绕过副作用闸门。
export const READ_ONLY_TOOLS = Object.freeze([
  'read_context_summary',
  'read_evidence',
  'read_registry',
  'read_policy',
  'read_verified_facts',
]);

// 禁止出现在提案里的字段：命中即拒。这些是状态轴的键名与身份字段名。
// 用「字段名黑名单」而不是「值比对」，是为了在 Agent 试图写入时就拦住，
// 而不是等它写完之后再判断值合不合法（那时候副作用可能已经发生）。
// 状态轴字段名来自 context-schema 的唯一清单（原先这里是第二份手抄枚举）；
// 后半部分是 Agent 层额外要守的（身份、闸门、风险等级不在状态轴里，但同样不许 Agent 碰）。
export const FORBIDDEN_PROPOSAL_FIELDS = Object.freeze([
  ...CONTEXT_STATE_AXIS_FIELDS,
  'identity', 'sideEffectRefs', 'humanGate', 'riskClass',
]);

export const AGENT_REJECTION = Object.freeze([
  'MANIFEST_INVALID', 'WRITE_EFFECT_FORBIDDEN', 'TOOL_NOT_READ_ONLY', 'PROPOSAL_INVALID',
  'STATE_MUTATION_FORBIDDEN', 'CLAIM_WITHOUT_EVIDENCE', 'EVIDENCE_REF_UNKNOWN',
  'KIND_NOT_ALLOWED', 'FALLBACK_MISSING', 'AGENT_FAILED', 'ROLE_INVALID',
]);

export class AgentContractError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'AgentContractError';
    this.code = code;
    this.details = details;
  }
}

const STATE_AXIS_VALUES = [...EXECUTION_STATUS, ...EVIDENCE_STATUS, ...HUMAN_GATE_STATUS, ...LEASE_STATUS, ...PUBLICATION_STATUS];

// ── 1. Agent manifest 校验（注册期）────────────────────────────────────────
export function validateAgentManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest must be an object'], code: 'MANIFEST_INVALID' };
  }
  if (manifest.schemaVersion !== AGENT_MANIFEST_SCHEMA_VERSION) errors.push(`schemaVersion must be ${AGENT_MANIFEST_SCHEMA_VERSION}`);
  if (manifest.kind !== 'agent') errors.push('kind must be "agent"');
  if (!manifest.name || !manifest.version) errors.push('name and version are required');

  // role 缺省是 planner（既有 manifest 不带这个字段，行为必须保持不变）。
  const role = manifest.role ?? 'planner';
  if (!AGENT_ROLES.includes(role)) errors.push(`role must be one of ${AGENT_ROLES.join('/')}, got ${JSON.stringify(manifest.role)}`);

  const tools = manifest.tools ?? [];
  if (!Array.isArray(tools) || tools.length === 0) errors.push('tools must be a non-empty array (an agent with no tools cannot read evidence)');
  const badTools = tools.filter((tool) => !READ_ONLY_TOOLS.includes(tool));
  if (badTools.length) errors.push(`tools must come from the read-only allowlist; forbidden: ${badTools.join(', ')}`);

  // 外部写副作用与 Agent 互斥：Agent 不得成为写外部的通道。
  const writeEffects = (manifest.sideEffects ?? []).filter((effect) => effect !== 'local_artifact' && effect !== 'local_parse' && effect !== 'browser_read');
  if (writeEffects.length) errors.push(`agent must not declare write side effects: ${writeEffects.join(', ')}`);

  // 角色决定「它必须声明什么能力」：
  //  - planner 要声明它能出哪些种类的提案；
  //  - reviewer 要声明它能给哪些复核结论（且必须给得出至少一种，否则这个 reviewer 无法表达意见）。
  // 两者都不允许声明「执行」性质的东西，因为它们连工具面都是只读的。
  if (role === 'planner' && !manifest.proposalKinds?.length) errors.push('proposalKinds must be declared');
  if (manifest.proposalKinds !== undefined) {
    const badKinds = (manifest.proposalKinds ?? []).filter((kind) => !PROPOSAL_KINDS.includes(kind));
    if (badKinds.length) errors.push(`proposalKinds must come from ${PROPOSAL_KINDS.join('/')}; unknown: ${badKinds.join(', ')}`);
  }
  if (role === 'reviewer') {
    if (!manifest.reviewVerdicts?.length) errors.push('reviewVerdicts must be declared for a reviewer');
    const badVerdicts = (manifest.reviewVerdicts ?? []).filter((verdict) => !REVIEW_VERDICTS.includes(verdict));
    if (badVerdicts.length) errors.push(`reviewVerdicts must come from ${REVIEW_VERDICTS.join('/')}; unknown: ${badVerdicts.join(', ')}`);
  }

  // 「Agent 移除后确定性流程仍可运行」不是口号，必须显式声明兜底路径。
  if (!manifest.deterministicFallback) errors.push('deterministicFallback is required (the acceptance criterion: the deterministic path must run with the agent removed)');

  return { ok: errors.length === 0, errors, code: errors.length ? 'MANIFEST_INVALID' : null, role };
}

export function assertAgentManifest(manifest) {
  const check = validateAgentManifest(manifest);
  if (!check.ok) throw new AgentContractError(check.errors.join('; '), check.code ?? 'MANIFEST_INVALID', { errors: check.errors });
  return manifest;
}

// ── 2. 提案校验（运行期）──────────────────────────────────────────────────
// 导出（而不是私有）：复核层（agent-review.mjs）必须用**同一份**禁止字段与状态轴泄漏判定，
// 否则「提案不许夹带状态轴」与「复核结论不许夹带状态轴」会变成两套口径。
export function findForbiddenField(node, path = '') {
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_PROPOSAL_FIELDS.includes(key)) return `${path}${key}`;
    const nested = findForbiddenField(value, `${path}${key}.`);
    if (nested) return nested;
  }
  return null;
}

// 刻意只检查键名为 status/state/axis/phase/nextAction 的位置，而不是全文子串匹配：
// 状态轴取值里有 READY / UNKNOWN / NONE / HELD 这类通用词，全文匹配会把正常文本一起误杀，
// 而误杀会让 Agent 层看起来「总是坏的」，最终被绕过——比挡住少数情况更危险。
const STATE_LIKE_KEYS = /^(status|state|axis|phase|nextAction)$/i;

export function findStateAxisLeak(node, path = '') {
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (STATE_LIKE_KEYS.test(key) && typeof value === 'string' && STATE_AXIS_VALUES.includes(value)) {
      return { field: `${path}${key}`, value };
    }
    const nested = findStateAxisLeak(value, `${path}${key}.`);
    if (nested) return nested;
  }
  return null;
}

// evidenceRefs 允许的形状：'sha256:...'、artifactId、或 { evidenceId, digest }。
export function evidenceKeysOf(evidenceRefs = []) {
  const keys = new Set();
  for (const ref of evidenceRefs) {
    if (!ref) continue;
    if (typeof ref === 'string') { keys.add(ref); continue; }
    if (ref.evidenceId) keys.add(String(ref.evidenceId));
    if (ref.digest) keys.add(String(ref.digest));
    if (ref.sha256) keys.add(`sha256:${String(ref.sha256).replace(/^sha256:/u, '')}`);
    if (ref.artifactId) keys.add(String(ref.artifactId));
  }
  return keys;
}

export function validateProposal(proposal, { agentManifest = null, context = null, evidenceRefs = [] } = {}) {
  const errors = [];
  const reject = (code, message, details = {}) => ({ ok: false, code, errors: [...errors, message], details });

  if (!proposal || typeof proposal !== 'object') return reject('PROPOSAL_INVALID', 'proposal must be an object');
  if (proposal.schemaVersion !== PROPOSAL_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PROPOSAL_SCHEMA_VERSION}`);
  if (!proposal.runId) errors.push('runId is required');
  if (context && proposal.runId && String(proposal.runId) !== String(context.runId)) {
    return reject('PROPOSAL_INVALID', 'proposal.runId must match the run it was produced for', { expected: context.runId, got: proposal.runId });
  }
  if (!proposal.agent?.name || !proposal.agent?.version) errors.push('agent.name and agent.version are required');
  if (agentManifest && (proposal.agent?.name !== agentManifest.name || proposal.agent?.version !== agentManifest.version)) {
    return reject('PROPOSAL_INVALID', 'proposal.agent does not match the registered agent', { expected: agentManifest.name, got: proposal.agent?.name });
  }
  if (!PROPOSAL_KINDS.includes(proposal.kind)) return reject('KIND_NOT_ALLOWED', `kind must be one of ${PROPOSAL_KINDS.join('/')}, got ${proposal.kind}`);
  if (agentManifest?.proposalKinds && !agentManifest.proposalKinds.includes(proposal.kind)) {
    return reject('KIND_NOT_ALLOWED', `agent ${agentManifest.name} did not declare proposal kind ${proposal.kind}`);
  }

  // 最重要的一条：Agent 不得写状态轴或身份。
  const forbidden = findForbiddenField(proposal);
  if (forbidden) return reject('STATE_MUTATION_FORBIDDEN', `proposal must not contain state/identity field: ${forbidden}`, { field: forbidden });

  // 状态轴取值出现在「像状态的键」上也拒绝（例如 output.status = 'SUCCEEDED'）。
  const leak = findStateAxisLeak(proposal.output ?? {});
  if (leak) return reject('STATE_MUTATION_FORBIDDEN', `proposal output must not carry state-axis values (${leak.field} = ${leak.value})`, leak);

  const claims = proposal.output?.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    return reject('PROPOSAL_INVALID', 'output.claims must be a non-empty array');
  }
  const known = evidenceKeysOf(evidenceRefs);
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || !claim.key) return reject('PROPOSAL_INVALID', 'every claim needs a key');
    if (claim.confidence !== undefined && (!Number.isFinite(Number(claim.confidence)) || Number(claim.confidence) < 0 || Number(claim.confidence) > 1)) {
      return reject('PROPOSAL_INVALID', `claim ${claim.key} confidence must be within [0,1]`, { claim: claim.key });
    }
    const refs = claim.evidenceRefs ?? [];
    if (!Array.isArray(refs) || refs.length === 0) {
      return reject('CLAIM_WITHOUT_EVIDENCE', `claim ${claim.key} has no evidence reference`, { claim: claim.key });
    }
    if (known.size) {
      const unknown = refs.filter((ref) => {
        const candidates = evidenceKeysOf([ref]);
        return ![...candidates].some((candidate) => known.has(candidate));
      });
      if (unknown.length) {
        return reject('EVIDENCE_REF_UNKNOWN', `claim ${claim.key} references evidence that is not in this run`, { claim: claim.key, unknown });
      }
    }
  }

  if (errors.length) return reject('PROPOSAL_INVALID', errors.join('; '));
  return { ok: true, code: null, errors: [], details: {} };
}

// 提案 → decisions 记录（唯一被允许的落点）。
// 刻意不返回任何可写进五条状态轴的字段，也不返回 identity。
export function toDecision(proposal) {
  return {
    kind: 'AGENT_PROPOSAL',
    agent: `${proposal.agent.name}@${proposal.agent.version}`,
    proposalKind: proposal.kind,
    runId: proposal.runId,
    claims: (proposal.output?.claims ?? []).map((claim) => ({
      key: claim.key,
      value: claim.value ?? null,
      confidence: claim.confidence ?? null,
      evidenceRefs: [...(claim.evidenceRefs ?? [])],
    })),
    note: proposal.note ?? null,
    at: proposal.at ?? null,
  };
}

// ── 3. Agent 端口 ─────────────────────────────────────────────────────────
// 唯一允许调用 Agent 的入口。它负责：装 manifest 闸门、只传只读工具、
// 校验提案、把失败降级为「走确定性兜底」而不是抛给调用方。
export function createAgentPort({ agentManifest, runAgent } = {}) {
  assertAgentManifest(agentManifest);
  // 角色闸门：提案端口只接 planner。把 reviewer 的 manifest 挂到这里（或反过来）会
  // 让「谁在提案、谁在复核」这条分离静默失效，因此在这个唯一入口上直接拒绝。
  if ((agentManifest.role ?? 'planner') !== 'planner') {
    throw new AgentContractError(
      `agent ${agentManifest.name} declares role ${agentManifest.role}; the proposal port requires a planner`,
      'ROLE_INVALID',
      { role: agentManifest.role },
    );
  }
  if (typeof runAgent !== 'function') throw new AgentContractError('runAgent is required', 'MANIFEST_INVALID');

  return {
    manifest: agentManifest,
    tools: [...READ_ONLY_TOOLS],

    // 只读工具面：这里没有写工具，也不接受调用方追加。
    async readTools() {
      return [...READ_ONLY_TOOLS];
    },

    async propose({ context, evidenceRefs = [], input = {} } = {}) {
      let proposal;
      try {
        proposal = await runAgent({ context, evidenceRefs: [...evidenceRefs], input, tools: [...READ_ONLY_TOOLS] });
      } catch (error) {
        // Agent 失败不得影响确定性流程：明确降级，而不是把异常抛给编排层。
        return {
          ok: false, code: 'AGENT_FAILED', fallbackRequired: true, fallback: agentManifest.deterministicFallback,
          error: String(error?.message ?? error), decision: null,
        };
      }
      const check = validateProposal(proposal, { agentManifest, context, evidenceRefs });
      if (!check.ok) {
        return {
          ok: false, code: check.code, fallbackRequired: true, fallback: agentManifest.deterministicFallback,
          errors: check.errors, details: check.details, decision: null,
        };
      }
      return { ok: true, code: null, fallbackRequired: false, fallback: null, decision: toDecision(proposal), proposal };
    },
  };
}

// 「移除 Agent 后确定性流程仍可运行」的静态证明：
// 只要 manifest 声明了 deterministicFallback，且 Agent 的产物只进 decisions，
// 拿掉 Agent 就只是少了一条 decisions。
export function assertAgentRemovable({ agentManifest, coreModules = [] } = {}) {
  assertAgentManifest(agentManifest);
  const reasons = [];
  if (!agentManifest.deterministicFallback) reasons.push('deterministicFallback not declared');
  // 核心模块不得 import Agent 模块：反向依赖会让「拿掉 Agent」变成编译期失败。
  for (const module of coreModules) {
    const source = String(module?.source ?? '');
    if (/agent-(proposal|port|runner)/.test(source)) reasons.push(`${module?.path ?? '<unnamed>'} imports the agent layer`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function isKnownRiskClass(value) {
  return RISK_CLASS.includes(value);
}
