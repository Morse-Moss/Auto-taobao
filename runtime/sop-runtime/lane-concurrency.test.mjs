// 阶段 6 配套单测：lane 并发约束（同账号/profile/写目标不双写）
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createContext } from './context-schema.mjs';
import { capabilityLane, laneLimit, DEFAULT_LANE_LIMIT } from './policy.mjs';

const IDENTITY = Object.freeze({
  tenantId: 't1', storeId: 's1', platform: 'xws',
  accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0',
});

async function makeRun(store, { runId, capability = 'cap.a', lane = null, identity = IDENTITY }) {
  await store.createRun({
    runId,
    identity,
    context: createContext({
      taskId: `task-${runId}`, runId, workflow: 'wf-under-test', capability,
      identity, stage: 'INIT', verifiedCursor: { start: 1, end: 0, version: 0 },
    }),
    targetEnd: 10,
    lane: lane ?? capabilityLane(identity, capability),
  });
}

function makeController(store) {
  let n = 0;
  return createController({ store, workerId: 'w-test', idFactory: () => `att-${++n}` });
}

test('lane 上限默认 1；写操作恒为 1；只有只读才允许通过 limits 放宽', () => {
  assert.equal(DEFAULT_LANE_LIMIT, 1);
  assert.equal(laneLimit({ lane: 'a/b/xws/c/d/cap.x' }), 1);
  assert.equal(laneLimit({ lane: 'a/b/xws/c/d/cap.x', limits: { 'other/lane': 3 } }), 1, '没有该 lane 的放宽项时保持 1');
  const lane = 'a/b/xws/c/d/cap.read';
  assert.equal(laneLimit({ lane, limits: { [lane]: 3 } }), 3, '只读能力可用容量证据显式放宽');
  assert.equal(laneLimit({ lane, write: true, limits: { [lane]: 3 } }), 1, '写操作必须串行，忽略放宽配置');
  assert.equal(laneLimit({ lane, limits: { default: 2 } }), 2, 'default 兜底生效');
});

test('同一 lane 已有其它活跃运行时，开新 attempt 被拒并归类 RESOURCE_BUSY', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  await makeRun(store, { runId: '11111111-1111-4111-8111-111111111111' });
  await makeRun(store, { runId: '22222222-2222-4222-8222-222222222222' });

  await controller.beginAttempt('11111111-1111-4111-8111-111111111111', { stage: 'COLLECT' });
  await assert.rejects(
    () => controller.beginAttempt('22222222-2222-4222-8222-222222222222', { stage: 'COLLECT' }),
    (error) => error.code === 'LANE_SATURATED'
      && error.details.failureClass === 'RESOURCE_BUSY'
      && error.details.activeInLane === 2
      && error.details.limit === 1,
  );
});

test('运行自己占用 lane 不算冲突（同一 run 可以连续开 attempt）', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  const runId = '11111111-1111-4111-8111-111111111111';
  await makeRun(store, { runId });

  const first = await controller.beginAttempt(runId, { stage: 'COLLECT', stepId: 's1' });
  assert.equal(first.leaseStatus, 'HELD');
  const second = await controller.beginAttempt(runId, { stage: 'COLLECT', stepId: 's2' });
  assert.equal(second.attemptId, 'att-2', '排除自身后不应被自己挡住');
  assert.equal((await store.listAttempts(runId)).length, 2);
});

test('不同 capability 属于不同 lane，互不阻塞', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  await makeRun(store, { runId: '11111111-1111-4111-8111-111111111111', capability: 'cap.a' });
  await makeRun(store, { runId: '22222222-2222-4222-8222-222222222222', capability: 'cap.b' });

  await controller.beginAttempt('11111111-1111-4111-8111-111111111111', { stage: 'COLLECT' });
  const other = await controller.beginAttempt('22222222-2222-4222-8222-222222222222', { stage: 'COLLECT' });
  assert.equal(other.executionStatus, 'RUNNING');
});

test('不同账号/profile 属于不同 lane，互不阻塞', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  const other = { ...IDENTITY, accountId: 'a2', browserProfileId: 'p2' };
  await makeRun(store, { runId: '11111111-1111-4111-8111-111111111111' });
  await makeRun(store, { runId: '22222222-2222-4222-8222-222222222222', identity: other });

  await controller.beginAttempt('11111111-1111-4111-8111-111111111111', { stage: 'COLLECT' });
  const second = await controller.beginAttempt('22222222-2222-4222-8222-222222222222', { stage: 'COLLECT' });
  assert.equal(second.executionStatus, 'RUNNING');
});

test('只读能力显式放宽后允许并行，但写操作即便放宽仍被拒', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';
  await makeRun(store, { runId: runA, capability: 'cap.read' });
  await makeRun(store, { runId: runB, capability: 'cap.read' });
  const lane = capabilityLane(IDENTITY, 'cap.read');

  await controller.beginAttempt(runA, { stage: 'COLLECT', laneLimits: { [lane]: 2 } });
  const parallel = await controller.beginAttempt(runB, { stage: 'COLLECT', laneLimits: { [lane]: 2 } });
  assert.equal(parallel.executionStatus, 'RUNNING', '只读放宽后允许第二个并行');

  await assert.rejects(
    () => controller.beginAttempt(runB, { stage: 'PUBLISH', write: true, laneLimits: { [lane]: 2 } }),
    (error) => error.code === 'LANE_SATURATED' && error.details.limit === 1,
    '写操作必须串行',
  );
});

test('已终止的 run 不再占用 lane', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';
  await makeRun(store, { runId: runA });
  await makeRun(store, { runId: runB });

  await controller.beginAttempt(runA, { stage: 'COLLECT' });
  const lid = capabilityLane(IDENTITY, 'cap.a');
  assert.equal(await store.countActiveInLane(lid, { excludeRunId: runB }), 1);

  await controller.cancel(runA);
  assert.equal(await store.countActiveInLane(lid, { excludeRunId: runB }), 0, 'FAILED 是终态，不再计入活跃');
  const allowed = await controller.beginAttempt(runB, { stage: 'COLLECT' });
  assert.equal(allowed.executionStatus, 'RUNNING');
});

// 回归：执行槽占用的判据是「RUNNING + lease HELD」，不是 run 状态集合。
// 用 run 状态判定会让「跑完一次 attempt、正在等提交」的 run（completeAttempt 之后仍是 RUNNING）
// 和「失败等人工」的 run（PAUSED）把 lane 永久占死——同 lane 的后续事项再也开不了 attempt。
// 在真实的 FAQ 商品级 fan-out 上，这就是「一个商品失败 → 其余商品全部排不进去」的整批停摆。
test('等提交（RUNNING+RELEASED）与等人工（PAUSED）的 run 不占执行槽，同 lane 可继续开 attempt', async () => {
  const store = createMemoryStore();
  const controller = makeController(store);
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';

  await makeRun(store, { runId: runA });
  await makeRun(store, { runId: runB });

  // A 跑完一次 attempt：lease 被释放，但 executionStatus 仍是 RUNNING（等 COMMIT）。
  const first = await controller.beginAttempt(runA, { stage: 'COLLECT' });
  await controller.completeAttempt(runA, { attemptId: first.attemptId, nextAction: 'COMMIT' });
  const contextA = await controller.getContext(runA);
  assert.equal(contextA.executionStatus, 'RUNNING', 'completeAttempt 不改变执行轴');
  assert.equal(contextA.leaseStatus, 'RELEASED');

  const allowed = await controller.beginAttempt(runB, { stage: 'COLLECT' });
  assert.equal(allowed.executionStatus, 'RUNNING');
  // B 真正持有 lane 时，A 仍然进不来——放宽的只是"等待态"，不是"正在执行"。
  await assert.rejects(
    () => controller.beginAttempt(runA, { stage: 'COLLECT' }),
    (error) => error.code === 'LANE_SATURATED',
    '有一次 attempt 正在飞行中时，lane 依然互斥',
  );
  await controller.completeAttempt(runB, { attemptId: allowed.attemptId, nextAction: 'COMMIT' });

  // 证据被拒（EVIDENCE_INVALID → REJECT_EVIDENCE）：lease 释放、执行轴仍是 RUNNING。
  const second = await controller.beginAttempt(runA, { stage: 'COLLECT' });
  const rejected = await controller.failAttempt(runA, { attemptId: second.attemptId, failureClass: 'EVIDENCE_INVALID', detail: 'bad evidence' });
  assert.equal(rejected.evidenceStatus, 'REJECTED');
  assert.equal(rejected.leaseStatus, 'RELEASED');
  assert.equal(rejected.executionStatus, 'RUNNING');

  // 需要人工的失败（HUMAN_REQUIRED → WAIT_HUMAN）：执行轴落 PAUSED。
  const third = await controller.beginAttempt(runA, { stage: 'COLLECT' });
  const paused = await controller.failAttempt(runA, { attemptId: third.attemptId, failureClass: 'HUMAN_REQUIRED', detail: 'needs a human' });
  assert.equal(paused.executionStatus, 'PAUSED', 'HUMAN_REQUIRED 走 WAIT_HUMAN，落 PAUSED');
  assert.equal(paused.leaseStatus, 'RELEASED');

  // 这两种「等待态」都不占执行槽：同 lane 的其它事项必须能继续开 attempt。
  const runC = '33333333-3333-4333-8333-333333333333';
  await makeRun(store, { runId: runC });
  const fourth = await controller.beginAttempt(runC, { stage: 'COLLECT' });
  assert.equal(fourth.executionStatus, 'RUNNING', '被拒/等人工的 run 不能拦住同 lane 的其它事项');
});
