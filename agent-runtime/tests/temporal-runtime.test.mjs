import assert from 'node:assert/strict';
import test from 'node:test';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('runs the guarded XWS task through a durable Temporal workflow', async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  let worker;
  try {
    const workflowsPath = resolve(root, 'temporal', 'workflows.mjs');
    const activities = await import(new URL('../temporal/activities.mjs', import.meta.url));
    worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: 'xws-local-test',
      workflowsPath,
      activities,
    });
    const workerRun = worker.run();
    const handle = await env.client.workflow.start('xwsTaskWorkflow', {
      workflowId: 'xws-local-test-run',
      taskQueue: 'xws-local-test',
      args: [{ pages: { start: 21, end: 21 }, rows: [{ productLink: 'https://example.test/item-21' }] }],
    });
    const result = await handle.result();
    await worker.shutdown();
    worker = undefined;
    await workerRun;
    assert.equal(result.status, 'DONE');
    assert.equal(result.completedEnd, 21);
    assert.equal(result.commitCount, 1);
    assert.equal(result.leaseReleased, true);
  } finally {
    if (worker) await worker.shutdown();
    await env.teardown();
  }
});
