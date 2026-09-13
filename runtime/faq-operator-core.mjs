const ORDERED_STAGES = [
  ['manifestLocked', 'LOCK_TOP5'],
  ['evidenceComplete', 'COLLECT_EVIDENCE'],
  ['localSnapshotBuilt', 'BUILD_LOCAL_SNAPSHOT'],
  ['localAnalysisVerified', 'ANALYZE_LOCAL'],
  ['aiReviewComplete', 'RUN_AI_REVIEW'],
  ['humanReviewComplete', 'REVIEW_AI_HUMAN_QUEUE'],
  ['localSummariesBuilt', 'BUILD_LOCAL_SUMMARIES'],
  ['summariesPublished', 'PUBLISH_FEISHU_SUMMARIES'],
];

export function determineFaqOperatorState(input = {}) {
  if (input.blocker) return { status: 'BLOCKED', nextAction: 'RESOLVE_BLOCKER', blocker: input.blocker };
  // 0 记录周期（本周无合格竞品）没有可发布内容：明细替换发布强制要求 ≥1 条源记录，
  // 汇总构建完成后发布是空操作，视为发布已完成，直接判定 DONE。
  const publishVacuous = input.rawRecords === 0 && input.localSummariesBuilt === true;
  const complete = (field) => input[field] === true || (field === 'summariesPublished' && publishVacuous);
  let missingSeen = false;
  for (const [field] of ORDERED_STAGES) {
    if (complete(field) && missingSeen) throw new Error(`invalid FAQ operator state: ${field} completed before a prerequisite`);
    if (!complete(field)) missingSeen = true;
  }
  const next = ORDERED_STAGES.find(([field]) => !complete(field));
  return next
    ? { status: 'IN_PROGRESS', nextAction: next[1] }
    : { status: 'DONE', nextAction: 'DONE' };
}
