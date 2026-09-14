// Reviewer 契约（实施计划「迁移顺序第 7 项」的第二半）：对提案做对抗性复核。
//
// 为什么需要第二个 Agent：提案契约（agent-proposal.mjs）保证的是「格式与边界」——
// Agent 不写状态轴、断言必须带证据、工具只读。但一条**格式完全合法**的提案仍然可能是错的：
// 选错了能力、把已经过期的证据当当前事实、漏掉一个前置条件、或者只是过度自信。
// Reviewer 的职责就是在**确定性边界检查之后**再看一遍，并且只出三种意见：
// ACCEPT / REJECT / ESCALATE（ESCALATE = 这件事得人来看）。
//
// 四条硬约束（任何一条不成立就不允许复核生效）：
//   1. **自审禁止**：复核者不能是产出提案的那个 Agent（按 name 判定）；
//   2. **绑定具体提案**：复核必须携带被复核提案的摘要（proposalDigest），
//      拿上一次的 ACCEPT 来给这一次盖章会在摘要上失败；
//   3. **有结论必须有理由**：三种结论都要求至少一条理由，且每条理由必须带证据引用——
//      「无理由的通过」和「无理由的否决」一样不可用（前者是橡皮图章，后者无法追溯）；
//   4. **结论不是状态**：verdict 只是意见，落点仍然是 decisions（Controller 的唯一审计入口），
//      复核层与提案层一样碰不到任何状态轴。
//
// 复核者自身坏掉（抛错、输出非法）时的正确行为是**降级到确定性兜底**，而不是让 SOP 卡住：
// 与「Agent 移除后确定性流程仍可运行」是同一条不变量。
import { createHash } from 'node:crypto';

import {
  AgentContractError,
  READ_ONLY_TOOLS,
  REVIEW_VERDICTS,
  assertAgentManifest,
  evidenceKeysOf,
  findForbiddenField,
  findStateAxisLeak,
  validateAgentManifest,
} from './agent-proposal.mjs';
import { stableStringify } from './skill-manifest.mjs';

export const REVIEW_SCHEMA_VERSION = 'agent-review-v1';

export const REVIEW_REJECTION = Object.freeze([
  'REVIEW_INVALID', 'ROLE_INVALID', 'REVIEWER_MISMATCH', 'SELF_REVIEW_FORBIDDEN',
  'VERDICT_NOT_ALLOWED', 'REASON_WITHOUT_EVIDENCE', 'EVIDENCE_REF_UNKNOWN',
  'STATE_MUTATION_FORBIDDEN', 'PROPOSAL_MISMATCH', 'AGENT_FAILED',
]);

// 被复核提案的摘要：键排序序列化 + sha256，因此同一份提案在任何进程里都得到同一个摘要。
export function proposalDigest(proposal) {
  return `sha256:${createHash('sha256').update(stableStringify(proposal)).digest('hex')}`;
}

// ── 复核校验（运行期）──────────────────────────────────────────────────────
export function validateReview(review, {
  reviewerManifest = null,
  proposal = null,
  plannerManifest = null,
  context = null,
  evidenceRefs = [],
} = {}) {
  const errors = [];
  const reject = (code, message, details = {}) => ({ ok: false, code, verdict: null, errors: [...errors, message], details });

  if (!review || typeof review !== 'object') return reject('REVIEW_INVALID', 'review must be an object');
  if (review.schemaVersion !== REVIEW_SCHEMA_VERSION) errors.push(`schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  if (!review.runId) errors.push('runId is required');
  if (context && review.runId && String(review.runId) !== String(context.runId)) {
    return reject('REVIEW_INVALID', 'review.runId must match the run it was produced for', { expected: context.runId, got: review.runId });
  }
  if (!review.reviewer?.name || !review.reviewer?.version) errors.push('reviewer.name and reviewer.version are required');

  // 复核必须有被复核的对象，且必须绑定到**这一份**提案。
  if (!proposal) return reject('REVIEW_INVALID', 'a review must name the proposal it reviews');
  if (String(review.runId ?? '') !== String(proposal.runId ?? '')) {
    return reject('REVIEW_INVALID', 'review.runId must equal the reviewed proposal runId', { proposal: proposal.runId, review: review.runId });
  }
  const digest = proposalDigest(proposal);
  if (review.proposalDigest !== digest) {
    return reject('PROPOSAL_MISMATCH', 'review.proposalDigest does not match the reviewed proposal', { expected: digest, got: review.proposalDigest ?? null });
  }

  if (reviewerManifest) {
    if ((reviewerManifest.role ?? 'planner') !== 'reviewer') {
      return reject('ROLE_INVALID', `agent ${reviewerManifest.name} declares role ${reviewerManifest.role}; a review requires a reviewer`);
    }
    if (review.reviewer?.name !== reviewerManifest.name || review.reviewer?.version !== reviewerManifest.version) {
      return reject('REVIEWER_MISMATCH', 'review.reviewer does not match the registered reviewer agent', {
        expected: `${reviewerManifest.name}@${reviewerManifest.version}`,
        got: `${review.reviewer?.name ?? '?'}@${review.reviewer?.version ?? '?'}`,
      });
    }
  }

  // 自审禁止：同一 name 即视为同一 Agent（version 不同也不行——换个版本号就能自审等于没禁）。
  const plannerName = plannerManifest?.name ?? proposal?.agent?.name ?? null;
  if (plannerName && review.reviewer?.name === plannerName) {
    return reject('SELF_REVIEW_FORBIDDEN', `reviewer ${plannerName} must differ from the agent that produced the proposal`, { planner: plannerName });
  }

  if (!REVIEW_VERDICTS.includes(review.verdict)) {
    return reject('VERDICT_NOT_ALLOWED', `verdict must be one of ${REVIEW_VERDICTS.join('/')}, got ${review.verdict}`);
  }
  if (reviewerManifest?.reviewVerdicts && !reviewerManifest.reviewVerdicts.includes(review.verdict)) {
    return reject('VERDICT_NOT_ALLOWED', `reviewer ${reviewerManifest.name} did not declare verdict ${review.verdict}`);
  }

  // 复核层与提案层共用同一份「禁止字段 / 状态轴泄漏」判定，避免两套口径。
  const forbidden = findForbiddenField(review);
  if (forbidden) return reject('STATE_MUTATION_FORBIDDEN', `review must not contain state/identity field: ${forbidden}`, { field: forbidden });
  const leak = findStateAxisLeak(review.reasons ?? []);
  if (leak) return reject('STATE_MUTATION_FORBIDDEN', `review reasons must not carry state-axis values (${leak.field} = ${leak.value})`, leak);

  // 有结论就必须有理由与证据——ACCEPT 也不例外（橡皮图章式通过是最危险的一种复核产物）。
  const reasons = review.reasons;
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return reject('REASON_WITHOUT_EVIDENCE', `verdict ${review.verdict} must be justified by at least one reason with evidence`);
  }
  const known = evidenceKeysOf(evidenceRefs);
  for (const reason of reasons) {
    if (!reason || typeof reason !== 'object' || !reason.key) return reject('REVIEW_INVALID', 'every reason needs a key');
    const refs = reason.evidenceRefs ?? [];
    if (!Array.isArray(refs) || refs.length === 0) {
      return reject('REASON_WITHOUT_EVIDENCE', `reason ${reason.key} has no evidence reference`, { reason: reason.key });
    }
    if (known.size) {
      const unknown = refs.filter((ref) => {
        const candidates = evidenceKeysOf([ref]);
        return ![...candidates].some((candidate) => known.has(candidate));
      });
      if (unknown.length) {
        return reject('EVIDENCE_REF_UNKNOWN', `reason ${reason.key} references evidence that is not in this run`, { reason: reason.key, unknown });
      }
    }
  }

  if (errors.length) return reject('REVIEW_INVALID', errors.join('; '));
  return { ok: true, code: null, verdict: review.verdict, errors: [], details: {} };
}

// 复核 → decisions 记录。与 toDecision 一样，刻意不返回任何状态轴字段。
export function toReviewDecision(review, { proposal, digest = null } = {}) {
  return {
    kind: 'AGENT_REVIEW',
    reviewer: `${review.reviewer.name}@${review.reviewer.version}`,
    reviewedAgent: proposal ? `${proposal.agent?.name ?? '?'}@${proposal.agent?.version ?? '?'}` : null,
    proposalKind: proposal?.kind ?? null,
    proposalDigest: digest ?? review.proposalDigest,
    verdict: review.verdict,
    reasons: (review.reasons ?? []).map((reason) => ({
      key: reason.key,
      note: reason.note ?? null,
      evidenceRefs: [...(reason.evidenceRefs ?? [])],
    })),
    at: review.at ?? null,
  };
}

// 「复核者与提案者必须是两个 Agent」的静态检查，带上角色校验：
// 同一个人兼任会同时破坏 role 与独立性，因此两条一起判。
export function assertReviewerIndependent({ plannerManifest, reviewerManifest } = {}) {
  const reasons = [];
  if ((plannerManifest?.role ?? 'planner') !== 'planner') reasons.push(`planner manifest role must be planner, got ${plannerManifest?.role ?? 'planner'}`);
  if (reviewerManifest?.role !== 'reviewer') reasons.push(`reviewer manifest role must be reviewer, got ${reviewerManifest?.role ?? '<missing>'}`);
  if (plannerManifest?.name && reviewerManifest?.name && plannerManifest.name === reviewerManifest.name) {
    reasons.push(`planner and reviewer must be different agents (both named ${plannerManifest.name})`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ── 复核端口 ───────────────────────────────────────────────────────────────
export function createReviewerPort({ reviewerManifest, runReviewer } = {}) {
  const manifestCheck = validateAgentManifest(reviewerManifest);
  if (!manifestCheck.ok) {
    throw new AgentContractError(manifestCheck.errors.join('; '), 'MANIFEST_INVALID', { errors: manifestCheck.errors });
  }
  assertAgentManifest(reviewerManifest);
  if ((reviewerManifest.role ?? 'planner') !== 'reviewer') {
    throw new AgentContractError(
      `agent ${reviewerManifest.name} declares role ${reviewerManifest.role ?? 'planner'}; the review port requires a reviewer`,
      'ROLE_INVALID',
      { role: reviewerManifest.role ?? null },
    );
  }
  if (typeof runReviewer !== 'function') throw new AgentContractError('runReviewer is required', 'MANIFEST_INVALID');

  return {
    manifest: reviewerManifest,
    tools: [...READ_ONLY_TOOLS],

    async review({ proposal, step = null, context = null, plannerManifest = null, evidenceRefs = [], input = {} } = {}) {
      // 返回契约是**全量**的：humanRequired / fallbackRequired / decision 在每条路径上都存在。
      // 失败路径显式给 humanRequired:false（而不是省略），否则调用方拿到 undefined，
      // 「undefined 恰好是假」会掩盖「这个字段到底有没有被设计出来」这件事。
      // step 是**已通过确定性边界**的归一化步骤（路径类输入已解析并校验过）。
      // 复核者拿到它而不是只拿原始提案，否则「复核已通过边界的步骤」这句话在代码里不成立。
      let review;
      try {
        review = await runReviewer({
          proposal,
          step,
          context,
          plannerManifest,
          evidenceRefs: [...evidenceRefs],
          input,
          tools: [...READ_ONLY_TOOLS],
        });
      } catch (error) {
        // 复核者坏了不等于提案是错的：降级到确定性兜底，让编排层继续能跑。
        return {
          ok: false, code: 'AGENT_FAILED', verdict: null, humanRequired: false, fallbackRequired: true,
          fallback: reviewerManifest.deterministicFallback, error: String(error?.message ?? error), decision: null,
        };
      }
      const check = validateReview(review, { reviewerManifest, proposal, plannerManifest, context, evidenceRefs });
      if (!check.ok) {
        return {
          ok: false, code: check.code, verdict: null, humanRequired: false, fallbackRequired: true,
          fallback: reviewerManifest.deterministicFallback, errors: check.errors, details: check.details, decision: null,
        };
      }
      return {
        ok: true,
        code: null,
        verdict: review.verdict,
        // ESCALATE 的语义是「不要自动继续」：由编排层决定停下来等人工，而不是当成一次失败的复核。
        humanRequired: review.verdict === 'ESCALATE',
        fallbackRequired: false,
        fallback: null,
        decision: toReviewDecision(review, { proposal, digest: review.proposalDigest }),
        review,
      };
    },
  };
}
