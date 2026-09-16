// 导出给运营台用（2026-09-16）：进度块要按这 8 个阶段渲染，但**不许在页面里重抄一份**——
// 阶段名的第二份拷贝就是第二份真相（本文档 §5.2「顺序不变量不许在页面重算」）。
// 页面的职责只是把这里给的 [字段, 阶段名] 与 operator-status.json 的布尔值并排显示。
export const ORDERED_STAGES = [
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

// 给运营台渲染用：把同一套判据摊平成「逐个阶段长什么样」。
// 为什么必须放在这里而不是页面里：空发布豁免（rawRecords === 0 且汇总已构建 ⇒ 发布视为完成）
// 这条规则只能有一份实现。页面自己实现一份，就会在「0 记录周期」上把最后一步画成未完成 ——
// 一个已经 DONE 的周期在界面上显示成「还有一步没做」，运营会去点一个不该点的键（假红）。
export function describeFaqStages(input = {}) {
  const vacuous = input.rawRecords === 0 && input.localSummariesBuilt === true;
  const { nextAction } = determineFaqOperatorState(input);
  return ORDERED_STAGES.map(([field, name]) => {
    const skipped = field === 'summariesPublished' && input[field] !== true && vacuous;
    const done = input[field] === true || skipped;
    return {
      field,
      name,
      complete: done,
      skipped,
      reason: skipped ? '本周 0 条源记录：汇总已完成，发布是空操作' : null,
      current: !done && name === nextAction,
    };
  });
}
