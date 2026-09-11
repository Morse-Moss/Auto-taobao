import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';

const { loadSkill, observePage, decideAction, executeAction, validateArtifact, commitArtifact, releaseLease } = proxyActivities({ startToCloseTimeout: '30 seconds' });

export async function xwsTaskWorkflow(input) {
  if (!Number.isInteger(input?.pages?.start) || input.pages.start < 1 || input.pages.end !== input.pages.start) {
    throw ApplicationFailure.nonRetryable('Local prototype requires exactly one page');
  }
  let result;
  let releaseReceipt;
  let lease;
  try {
    const skill = await loadSkill();
    const run = { id: `temporal-${input.pages.start}-${input.pages.end}`, skill };
    lease = { id: `${run.id}:lease` };
    const observation = await observePage(input);
    const decision = await decideAction(observation);
    const artifact = await executeAction(decision, input);
    const validation = await validateArtifact(artifact);
    const committed = await commitArtifact({ run, artifact, validation });
    result = { status: 'DONE', completedEnd: input.pages.start, commitCount: committed.commitCount };
  } finally {
    if (lease) releaseReceipt = await releaseLease(lease);
  }
  if (!releaseReceipt?.released) throw ApplicationFailure.nonRetryable('lease release was not confirmed');
  return { ...result, leaseReleased: true };
}
