const ORDERED_STAGES = [
  ['manifestLocked', 'LOCK_TOP5'],
  ['evidenceComplete', 'COLLECT_EVIDENCE'],
  ['rawImported', 'IMPORT_RAW'],
  ['analysisVerified', 'ANALYZE'],
  ['summaryVerified', 'SUMMARIZE'],
  ['operatorPublished', 'PUBLISH_OPERATOR_TABLE'],
];

export function determineFaqOperatorState(input = {}) {
  if (input.blocker) return { status: 'BLOCKED', nextAction: 'RESOLVE_BLOCKER', blocker: input.blocker };
  let missingSeen = false;
  for (const [field] of ORDERED_STAGES) {
    const complete = input[field] === true;
    if (complete && missingSeen) throw new Error(`invalid FAQ operator state: ${field} completed before a prerequisite`);
    if (!complete) missingSeen = true;
  }
  const next = ORDERED_STAGES.find(([field]) => input[field] !== true);
  return next
    ? { status: 'IN_PROGRESS', nextAction: next[1] }
    : { status: 'DONE', nextAction: 'DONE' };
}
