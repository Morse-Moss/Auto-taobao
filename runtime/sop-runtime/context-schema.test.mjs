import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_SCHEMA_VERSION, createContext, validateContext, advance, setBlocker, summarize, isTerminal,
} from './context-schema.mjs';
import { classifyRisk, evaluatePolicy, actionForFailure, laneKey, capabilityLane } from './policy.mjs';

const identity = {
  tenantId: 't-1', storeId: 's-1', platform: 'taobao',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'v1',
};

test('createContext 产出合法 sop-context-v1', () => {
  const ctx = createContext({ taskId: 'sop-xws', runId: 'r-1', workflow: 'xws.market-analysis', capability: 'xws.market-analysis.collect', identity });
  assert.equal(ctx.schemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(ctx.executionStatus, 'QUEUED');
  assert.equal(ctx.evidenceStatus, 'NONE');
  assert.deepEqual(validateContext(ctx), { ok: true, errors: [] });
});

test('缺身份字段与非法状态被拒绝', () => {
  const ctx = createContext({ taskId: 't', runId: 'r', workflow: 'w', capability: 'c', identity: { tenantId: 't-1' } });
  const result = validateContext(ctx);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('identity.storeId')));
  const bad = { ...createContext({ taskId: 't', runId: 'r', workflow: 'w', capability: 'c', identity }), executionStatus: 'DONE' };
  assert.ok(validateContext(bad).errors.some((e) => e.includes('executionStatus')));
});

test('advance 递增版本且不原地修改', () => {
  const ctx = createContext({ taskId: 't', runId: 'r', workflow: 'w', capability: 'c', identity });
  const next = advance(ctx, { stage: 'COLLECT' }, { nowIso: '2026-09-14T00:00:00.000Z' });
  assert.equal(next.contextVersion, ctx.contextVersion + 1);
  assert.equal(ctx.stage, 'INIT');
  assert.equal(next.updatedAt, '2026-09-14T00:00:00.000Z');
});

test('setBlocker 只接受已定义失败分类', () => {
  const ctx = createContext({ taskId: 't', runId: 'r', workflow: 'w', capability: 'c', identity });
  const blocked = setBlocker(ctx, 'HUMAN_REQUIRED', 'login required');
  assert.equal(validateContext(blocked).ok, true);
  assert.equal(blocked.blocker.class, 'HUMAN_REQUIRED');
  const bogus = setBlocker(ctx, 'NOT_A_CLASS', 'x');
  assert.equal(validateContext(bogus).ok, false);
});

test('summarize 只暴露恢复关键字段且不含原文', () => {
  const ctx = advance(createContext({ taskId: 't', runId: 'r', workflow: 'w', capability: 'c', identity }), { artifacts: [{ id: 1 }] });
  const sum = summarize(ctx);
  assert.equal(sum.artifactCount, 1);
  assert.equal(sum.artifacts, undefined);
  assert.equal(isTerminal(ctx), false);
  assert.equal(isTerminal(advance(ctx, { executionStatus: 'SUCCEEDED' })), true);
});

test('风险分级：本地低、飞书高、登录人工、未登记副作用高风险', () => {
  assert.equal(classifyRisk({ sideEffects: ['local_artifact'] }), 'LOW');
  assert.equal(classifyRisk({ sideEffects: ['feishu_write'] }), 'HIGH');
  assert.equal(classifyRisk({ sideEffects: ['account_login'] }), 'HUMAN_REQUIRED');
  assert.equal(classifyRisk({ sideEffects: ['something_new'] }), 'HIGH');
});

test('lane 与并发上限：策略只给 lane 与上限，占用判定不在准入期做', () => {
  assert.equal(laneKey(identity), 't-1/s-1/taobao/a-1/p-1');
  assert.equal(capabilityLane(identity, 'cap'), 't-1/s-1/taobao/a-1/p-1/cap');
  // 准入回答「能否进队列」：同一 lane 已有占用不影响准入结论（否则商品级 fan-out 无法入队）。
  // lane 上限随结论一起返回，由 Controller.beginAttempt 在执行期执行它。
  const occupied = evaluatePolicy({ identity, capability: 'cap', sideEffects: [], activeInLane: 1 });
  assert.equal(occupied.decision, 'ALLOW');
  assert.equal(occupied.lane, 't-1/s-1/taobao/a-1/p-1/cap');
  assert.equal(occupied.laneLimit, 1);
  assert.match(occupied.reasons.join(' '), /enforced at attempt time/);
  const ok = evaluatePolicy({ identity, capability: 'cap', sideEffects: ['local_artifact'], activeInLane: 0 });
  assert.equal(ok.decision, 'ALLOW');
  assert.equal(ok.laneLimit, 1);
});

test('未注册能力被拒绝', () => {
  const denied = evaluatePolicy({ identity, capability: 'nope', registeredCapabilities: ['cap'] });
  assert.equal(denied.decision, 'DENY');
  assert.ok(denied.reasons[0].includes('not registered'));
});

test('失败分类映射：预算内重试、耗尽终止、UNKNOWN 只走对账', () => {
  assert.equal(actionForFailure('TRANSIENT_EXTERNAL', { retryUsed: 0, retryBudget: 3 }).action, 'RETRY');
  assert.equal(actionForFailure('TRANSIENT_EXTERNAL', { retryUsed: 3, retryBudget: 3 }).action, 'FAIL');
  assert.equal(actionForFailure('COMMIT_UNKNOWN').action, 'RECONCILE');
  assert.equal(actionForFailure('EVIDENCE_INVALID').action, 'REJECT_EVIDENCE');
  assert.equal(actionForFailure('HUMAN_REQUIRED').action, 'WAIT_HUMAN');
  assert.equal(actionForFailure('MYSTERY').action, 'ESCALATE_HUMAN');
});
