import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowError, createWorkflowReceipt } from './workflow-receipt.mjs';

test('classifies platform gates and retryable download failures', () => {
  assert.equal(classifyWorkflowError(new Error('登录失败，需要验证码')).class, 'HUMAN_REQUIRED');
  assert.equal(classifyWorkflowError(new Error('下载超时')).class, 'TRANSIENT_EXTERNAL');
  assert.equal(classifyWorkflowError(Object.assign(new Error('workflow lock busy'), { code: 'WORKFLOW_LOCK_BUSY' })).reason, 'WORKFLOW_LOCK_BUSY');
});

test('receipt rejects unknown statuses and keeps stage contract', () => {
  const receipt = createWorkflowReceipt({ workflow: 'weekly', runId: 'r1', date: '2026-09-27', stages: [{ name: 'keyword', status: 'COMPLETED' }] });
  assert.equal(receipt.status, 'RUNNING');
  assert.throws(() => createWorkflowReceipt({ workflow: 'weekly', runId: 'r1', date: '2026-09-27', status: 'DONE' }), /unknown workflow status/);
});
