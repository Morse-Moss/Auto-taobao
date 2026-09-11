import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const env = await TestWorkflowEnvironment.createLocal();
let worker;
try {
  const workflowsPath = resolve(root, 'agent-runtime', 'temporal', 'workflows.mjs');
  const activities = await import(new URL('./temporal/activities.mjs', import.meta.url));
  worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue: 'xws-local-run',
    workflowsPath,
    activities,
  });
  const workerRun = worker.run();
  const handle = await env.client.workflow.start('xwsTaskWorkflow', {
    workflowId: `xws-local-${Date.now()}`,
    taskQueue: 'xws-local-run',
    args: [{ pages: { start: 21, end: 21 }, rows: [{ productLink: 'https://example.test/item-21' }] }],
  });
  console.log(JSON.stringify({ mode: 'SIMULATION', realCollection: false, result: await handle.result() }, null, 2));
  await worker.shutdown();
  worker = undefined;
  await workerRun;
} finally {
  if (worker) await worker.shutdown();
  await env.teardown();
}
