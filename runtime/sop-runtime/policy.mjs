// Policy：风险分级、审批要求、并发 lane 与幂等规则（确定性，不调用模型）
import { FAILURE_CLASS } from './context-schema.mjs';

export const RISK_CLASS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'HUMAN_REQUIRED']);
export const POLICY_DECISION = Object.freeze(['ALLOW', 'ALLOW_WITH_APPROVAL', 'DENY']);

// 副作用风险权重：写外部系统的动作默认需要人工或至少回读验收。
// 导出为副作用类的唯一事实来源：Skill manifest 的 sideEffects 必须取自这里的 key。
export const SIDE_EFFECT_RISK = Object.freeze({
  local_artifact: 'LOW',
  local_parse: 'LOW',
  browser_read: 'LOW',
  postgres_write: 'MEDIUM',
  feishu_write: 'HIGH',
  external_publish: 'HIGH',
  paid_provider_call: 'HIGH',
  account_login: 'HUMAN_REQUIRED',
  captcha_or_risk_control: 'HUMAN_REQUIRED',
});

const HUMAN_ONLY_EFFECTS = new Set(['account_login', 'captcha_or_risk_control']);

export function laneKey(identity) {
  return [
    identity.tenantId ?? 'unknown-tenant',
    identity.storeId ?? 'unknown-store',
    identity.platform ?? 'unknown-platform',
    identity.accountId ?? 'unknown-account',
    identity.browserProfileId ?? 'unknown-profile',
  ].join('/');
}

export function capabilityLane(identity, capability) {
  return `${laneKey(identity)}/${capability ?? 'unknown-capability'}`;
}

// 写操作的 lane 额外带上「写目标」：同一个外部写入目标（例如同一张飞书表）
// 无论由哪个能力、哪次运行发起，都必须串行，避免对同一目标双写。
// 计划里的 resource_lease 用这个持久化 lane 键实现（不用新的租约表、不用进程内租约），
// 代价是租约粒度等于「写目标」而不是任意资源名——需要更细粒度时再单独设计。
export function writeLane(identity, capability, target) {
  const base = capabilityLane(identity, capability);
  return target ? `${base}@${target}` : base;
}

// 统一入口：调用方不需要自己判断该用哪种 lane。
export function laneFor({ identity, capability, target = null, write = false }) {
  return write ? writeLane(identity, capability, target) : capabilityLane(identity, capability);
}

export function classifyRisk({ sideEffects = [], target = null } = {}) {
  if (sideEffects.some((effect) => HUMAN_ONLY_EFFECTS.has(effect))) return 'HUMAN_REQUIRED';
  let risk = 'LOW';
  for (const effect of sideEffects) {
    const level = SIDE_EFFECT_RISK[effect];
    if (level === 'HIGH') return 'HIGH';
    if (level === 'MEDIUM') risk = 'MEDIUM';
  }
  // 未登记的副作用视为高风险，避免能力偷偷扩大写范围。
  const unknown = sideEffects.filter((effect) => !(effect in SIDE_EFFECT_RISK));
  if (unknown.length) return 'HIGH';
  if (target && /external|feishu|publish/i.test(String(target))) risk = risk === 'LOW' ? 'MEDIUM' : risk;
  return risk;
}

export function requiresApproval(riskClass) {
  return riskClass === 'HIGH' || riskClass === 'HUMAN_REQUIRED';
}

// 并发上限：lane 的默认并发是 1——同一 tenant/store/platform/account/browserProfile/capability
// 组合下不并行，这是保证「同一账号/profile/写目标不发生双写」的安全默认值。
// 只有「只读、且已用资源容量证据证明可以并行」的能力才允许通过 limits 显式放宽；
// 只要带写副作用，无论 limits 怎么写都恒为 1（写目标永远串行）。
export const DEFAULT_LANE_LIMIT = 1;

export function laneLimit({ lane, write = false, limits = null } = {}) {
  if (write) return 1;
  if (limits) {
    const exact = limits[lane];
    if (Number.isFinite(exact) && exact >= 1) return Math.floor(exact);
    if (Number.isFinite(limits.default) && limits.default >= 1) return Math.floor(limits.default);
  }
  return DEFAULT_LANE_LIMIT;
}

export function evaluatePolicy({
  identity = {},
  capability = null,
  sideEffects = [],
  target = null,
  write = false,
  activeInLane = 0,
  registeredCapabilities = null,
} = {}) {
  const reasons = [];
  if (registeredCapabilities && capability && !registeredCapabilities.includes(capability)) {
    return { decision: 'DENY', riskClass: classifyRisk({ sideEffects, target }), reasons: [`capability not registered: ${capability}`] };
  }
  const riskClass = classifyRisk({ sideEffects, target });
  const lane = capabilityLane(identity, capability);
  const limit = laneLimit({ lane, write });
  // lane 占用**不在这里**判定，这是对早先「准入即占位」的一次修正。
  // 准入回答的是「这件事项能不能进入队列」；队列按定义必须能容纳同一 lane 的多个事项，
  // 否则商品级 fan-out（同一账号下的多件商品）根本无法入队——把「并发约束」错用成了「重复约束」。
  // 同一 lane 同时只能有一个在执行，由 Controller.beginAttempt 用 LANE_EXECUTING_STATUSES 把关。
  // 真正的重复由 admitTask 用 idempotencyKey 挡（按业务范围去重，比按 lane 去重精确：
  // 同一账号下的两件不同商品不是重复，同一件事项被提交两次才是）。
  if (riskClass === 'HUMAN_REQUIRED') {
    reasons.push('effect requires human gate');
    return { decision: 'ALLOW_WITH_APPROVAL', riskClass, reasons, humanGate: true, lane, laneLimit: limit };
  }
  if (requiresApproval(riskClass)) {
    reasons.push(`risk ${riskClass} requires approval`);
    return { decision: 'ALLOW_WITH_APPROVAL', riskClass, reasons, humanGate: true, lane, laneLimit: limit };
  }
  reasons.push(`risk ${riskClass}, lane ${lane} (limit ${limit} enforced at attempt time${activeInLane ? `, currently ${activeInLane} occupying` : ''})`);
  return { decision: 'ALLOW', riskClass, reasons, humanGate: false, lane, laneLimit: limit };
}

// 外部调用失败的确定性归类：优先看结构化状态码，再看消息里的状态码，最后才归 BUG。
// 提交账本用它区分「确定未发生、可修正后重试」与「结果未知、只能对账」，
// 因此不能一律归 BUG——BUG 会触发 STOP_AND_ALERT，把一次可修复的目标配置错误升级成停线。
export function classifyExternalFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isFinite(status) && status >= 400) {
    if (status === 408 || status === 429 || status >= 500) return 'TRANSIENT_EXTERNAL';
    return 'POLICY_DENIED';
  }
  const message = String(error?.message ?? error);
  const code = /\b([45]\d{2})\b/.exec(message);
  if (code) return Number(code[1]) >= 500 ? 'TRANSIENT_EXTERNAL' : 'POLICY_DENIED';
  if (/timeout|ECONN|ETIMEDOUT|socket hang up|network/i.test(message)) return 'TRANSIENT_EXTERNAL';
  if (/busy|lock|lease/i.test(message)) return 'RESOURCE_BUSY';
  if (/forbidden|unauthori[sz]ed|permission|not exist|nonexist|invalid/i.test(message)) return 'POLICY_DENIED';
  return 'BUG';
}

// 失败分类到下一步动作的确定性映射（Spec 第 10 节）
export function actionForFailure(failureClass, { retryUsed = 0, retryBudget = 3 } = {}) {
  if (!FAILURE_CLASS.includes(failureClass)) return { action: 'ESCALATE_HUMAN', reason: `unknown failure class: ${failureClass}` };
  switch (failureClass) {
    case 'TRANSIENT_EXTERNAL':
      return retryUsed < retryBudget
        ? { action: 'RETRY', reason: `transient, retry ${retryUsed + 1}/${retryBudget}` }
        : { action: 'FAIL', reason: 'retry budget exhausted' };
    case 'RESOURCE_BUSY':
      return { action: 'REQUEUE', reason: 'resource busy, back to queue without duplicate execution' };
    case 'HUMAN_REQUIRED':
      return { action: 'WAIT_HUMAN', reason: 'human intervention required' };
    case 'EVIDENCE_INVALID':
      return { action: 'REJECT_EVIDENCE', reason: 'evidence invalid, never retry the same bad evidence' };
    case 'POLICY_DENIED':
      return { action: 'FAIL', reason: 'policy denied' };
    case 'COMMIT_UNKNOWN':
      return { action: 'RECONCILE', reason: 'commit result unknown, reconcile before any retry' };
    case 'CAPABILITY_DEGRADED':
      return { action: 'DEGRADE_CAPABILITY', reason: 'capability degraded, stop this version' };
    case 'BUG':
      return { action: 'STOP_AND_ALERT', reason: 'bug suspected, stop automation' };
    default:
      return { action: 'ESCALATE_HUMAN', reason: 'unmapped failure class' };
  }
}
