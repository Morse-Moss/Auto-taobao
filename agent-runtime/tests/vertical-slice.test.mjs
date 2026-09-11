import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalVerticalSlice } from '../local-vertical-slice.mjs';

test('runs a recoverable skill task with guarded commit and lease release', async () => {
  const result = await runLocalVerticalSlice({ crashAfterCheckpoint: true });

  assert.equal(result.status, 'DONE');
  assert.equal(result.completedEnd, 1);
  assert.equal(result.commitCount, 1);
  assert.equal(result.leaseReleased, true);
  assert.deepEqual(result.events, [
    'SKILL_LOADED',
    'RUN_CREATED',
    'OBSERVED',
    'DECIDED',
    'ACTED',
    'VERIFIED',
    'CHECKPOINTED',
    'WORKER_RESTARTED',
    'COMMITTED',
    'LEASE_RELEASED',
  ]);
});

test('does not commit an invalid artifact', async () => {
  await assert.rejects(
    () => runLocalVerticalSlice({ artifactRows: [] }),
    /artifact validation failed/,
  );
});
