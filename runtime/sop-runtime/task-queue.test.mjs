// 阶段 6 配套单测：任务队列、限流、背压、熔断、退避、超时清扫、取消、lane 容量出队、结果合并。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createContext, advance } from './context-schema.mjs';
import { laneFor } from './policy.mjs';
import {
  createTaskQueue, createCircuitBreaker, createRateLimiter,
  mergeFanoutResults, backoffMs,
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, QUEUE_REJECTION,
} from './task-queue.mjs';

const IDENTITY = Object.freeze({
  tenantId: 't1', storeId: 's1', platform: 'xws',
  accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0',
});

const T0 = Date.parse('2026-09-14T00:00:00.000Z');

// 可控时钟：队列的顺序、退避、截止时间全部依赖时间，必须能精确推进而不是 sleep。
function makeClock(start = T0) {
  let t = start;
  return {
    nowIso: () => new Date(t).toISOString(),
    advance: (deltaMs) => { t += deltaMs; return new Date(t).toISOString(); },
    at: () => t,
  };
}

function specOf({
  taskId = 'task-1', capability = 'cap.a', identity = IDENTITY,
  target = null, write = false, priority = 0, deadlineAt = null, sideEffects = [],
} = {}) {
  return {
    taskId, workflow: 'wf-under-test', capability, identity,
    target, write, priority, deadlineAt, sideEffects, targetEnd: 10,
  };
}

function makeQueue({ store, controller, clock, rateLimiter, limits = {} } = {}) {
  return createTaskQueue({
    store,
    controller,
    nowIso: clock.nowIso,
    rateLimiter: rateLimiter ?? createRateLimiter({ capacity: 100, refillMs: 1_000, nowMs: () => clock.at() }),
    circuitBreaker: createCircuitBreaker({ nowMs: () => clock.at() }),
    limits,
  });
}

async function makeHarness({ limits = {} } = {}) {
  const store = createMemoryStore();
  const clock = makeClock();
  let n = 0;
  const controller = createController({
    store, nowIso: clock.nowIso, workerId: 'w-test', idFactory: () => `att-${++n}`,
  });
  const queue = makeQueue({ store, controller, clock, limits });
  return { store, clock, controller, queue };
}

// 直接落一条 run，绕过准入：用于构造「队列里已有历史 run」的场景（例如缺 lane 的老记录）。
async function seedRun(store, { runId, capability = 'cap.a', identity = IDENTITY, lane = null, queue = {}, executionStatus = 'QUEUED', isWrite = false }) {
  const laneValue = lane ?? laneFor({ identity, capability, target: null, write: isWrite });
  const base = createContext({
    taskId: `task-${runId}`, runId, workflow: 'wf-under-test', capability, identity,
    stage: 'ADMITTED', verifiedCursor: { start: 1, end: 0, version: 0 },
  });
  const context = advance(base, {
    executionStatus,
    lane: laneValue,
    isWrite,
    queue: { priority: 0, notBefore: null, deadlineAt: null, enqueuedAt: null, attempts: 0, ...queue },
  }, { nowIso: new Date(T0).toISOString() });
  await store.createRun({ runId, identity, context, targetEnd: 10, lane: laneValue });
  return context;
}

test('退避是指数且有上限；非法输入退回首次退避', () => {
  assert.equal(BACKOFF_BASE_MS, 1_000);
  assert.equal(BACKOFF_MAX_MS, 60_000);
  assert.equal(backoffMs(1), 1_000);
  assert.equal(backoffMs(2), 2_000);
  assert.equal(backoffMs(3), 4_000);
  assert.equal(backoffMs(7), 60_000, '第 7 次应被封顶');
  assert.equal(backoffMs(20), 60_000);
  assert.equal(backoffMs(0), 1_000, '0 视为第 1 次');
  assert.equal(backoffMs(undefined), 1_000);
  assert.equal(backoffMs('abc'), 1_000);
});

test('熔断：连续失败到阈值即打开，冷却结束后自动闭合，成功可清零', () => {
  let now = T0;
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000, nowMs: () => now });

  assert.equal(breaker.isOpen('xws'), false);
  breaker.recordFailure('xws');
  breaker.recordFailure('xws');
  assert.equal(breaker.isOpen('xws'), false, '未达阈值不打开');
  const third = breaker.recordFailure('xws');
  assert.equal(third.open, true);
  assert.equal(third.failures, 3);
  assert.equal(breaker.isOpen('xws'), true);

  now += 59_000;
  assert.equal(breaker.isOpen('xws'), true, '冷却期内保持打开');
  now += 2_000;
  assert.equal(breaker.isOpen('xws'), false, '冷却结束后闭合（但失败计数保留，再失败会立刻重开）');

  // 不同 key 互不影响
  assert.equal(breaker.isOpen('sycm'), false);
  breaker.recordSuccess('xws');
  assert.deepEqual(breaker.snapshot(), []);
  assert.equal(breaker.isOpen('xws'), false);
});

test('限流：令牌桶按容量扣减、耗尽即拒、可归还、按时间匀速回填', () => {
  let now = T0;
  const limiter = createRateLimiter({ capacity: 2, refillMs: 10_000, nowMs: () => now });

  assert.equal(limiter.peek('xws'), true);
  assert.equal(limiter.take('xws'), true);
  assert.equal(limiter.take('xws'), true);
  assert.equal(limiter.peek('xws'), false, '容量用尽');
  assert.equal(limiter.take('xws'), false);

  limiter.refund('xws');
  assert.equal(limiter.take('xws'), true, '归还后可再取');

  now += 10_000;
  assert.equal(limiter.take('xws'), true, '过一个 refill 周期回填 1 个');
  assert.equal(limiter.peek('xws'), false, '刚回填的 1 个已被取走');

  now += 10 * 10_000;
  const snap = limiter.snapshot();
  assert.equal(snap.find((entry) => entry.key === 'xws').tokens, 2, '长时间空转也不超过容量上限');

  assert.equal(limiter.take('sycm'), true, '不同 key 独立计桶');
});

test('fan-out 合并：确定性排序；同键异值记为冲突并要求人工，不静默择一', () => {
  const clean = mergeFanoutResults([
    { key: 'b', value: 2, runId: 'r2' },
    { key: 'a', value: 1, runId: 'r1' },
    { key: 'c', value: 3, runId: 'r3' },
  ]);
  assert.deepEqual(clean.merged.map((row) => row.key), ['a', 'b', 'c'], '按 key 确定性排序');
  assert.equal(clean.ok, true);
  assert.equal(clean.requiresHuman, false);

  const conflicted = mergeFanoutResults([
    { key: 'a', value: 1, runId: 'r1' },
    { key: 'a', value: 9, runId: 'r9' },
  ]);
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.requiresHuman, true, '冲突必须交人工');
  assert.equal(conflicted.conflicts.length, 1);
  assert.deepEqual(conflicted.conflicts[0].values, [1, 9]);
  assert.deepEqual(conflicted.conflicts[0].sources, ['r1', 'r9']);

  const withFailure = mergeFanoutResults([
    { key: 'a', value: 1, runId: 'r1' },
    { ok: false, runId: 'r2', error: 'timeout' },
  ]);
  assert.equal(withFailure.ok, false);
  assert.equal(withFailure.failures.length, 1);
  assert.equal(withFailure.requiresHuman, false, '失败不算冲突，但 ok 为假');

  const sameValue = mergeFanoutResults([
    { key: 'a', value: 1, runId: 'r1' },
    { key: 'a', value: 1, runId: 'r2' },
  ]);
  assert.equal(sameValue.conflicts.length, 0, '同键同值不算冲突');
  assert.equal(sameValue.ok, true);
});

test('入队：无副作用只读任务正常准入，队列元数据落到上下文', async () => {
  const { queue, store, clock } = await makeHarness();
  const result = await queue.enqueue({ spec: specOf({ taskId: 't-ok' }) });

  assert.equal(result.admitted, true);
  assert.equal(result.reason, null);
  assert.equal(result.context.executionStatus, 'QUEUED');
  assert.equal(result.context.queue.enqueuedAt, clock.nowIso());
  assert.equal(result.context.queue.priority, 0);
  assert.equal(result.context.lane, laneFor({ identity: IDENTITY, capability: 'cap.a' }));
  assert.equal(result.context.isWrite, false);
  assert.equal((await store.listActiveRuns({})).length, 1);
});

test('入队：已过截止时间直接拒收（DEADLINE_PASSED），不落 run', async () => {
  const { queue, store, clock } = await makeHarness();
  const past = new Date(clock.at() - 1_000).toISOString();
  const result = await queue.enqueue({ spec: specOf({ deadlineAt: past }) });

  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'DEADLINE_PASSED');
  assert.equal(result.failureClass, 'HUMAN_REQUIRED');
  assert.equal(result.runId, null);
  assert.equal((await store.listActiveRuns({})).length, 0, '被拒的任务不该留下 run');
});

test('入队：目标平台熔断中拒收（CIRCUIT_OPEN）', async () => {
  const { queue, store, clock } = await makeHarness();
  const breaker = queue.circuitBreaker;
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('feishu-target', clock.at());

  const result = await queue.enqueue({
    spec: specOf({ capability: 'cap.feishu', target: 'feishu-target' }),
  });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'CIRCUIT_OPEN');
  assert.equal(result.failureClass, 'CAPABILITY_DEGRADED');
  assert.equal((await store.listActiveRuns({})).length, 0);
});

test('入队：限流预算耗尽拒收（RATE_LIMITED），且准入被拒时归还令牌', async () => {
  const store = createMemoryStore();
  const clock = makeClock();
  let n = 0;
  const controller = createController({ store, nowIso: clock.nowIso, workerId: 'w-test', idFactory: () => `att-${++n}` });
  const queue = createTaskQueue({
    store, controller, nowIso: clock.nowIso,
    rateLimiter: createRateLimiter({ capacity: 1, refillMs: 60_000, nowMs: () => clock.at() }),
    circuitBreaker: createCircuitBreaker({ nowMs: () => clock.at() }),
  });

  const first = await queue.enqueue({ spec: specOf({ taskId: 't1', capability: 'cap.a' }) });
  assert.equal(first.admitted, true, '第一个用掉唯一令牌');

  const second = await queue.enqueue({ spec: specOf({ taskId: 't2', capability: 'cap.b' }) });
  assert.equal(second.admitted, false);
  assert.equal(second.reason, 'RATE_LIMITED');
  assert.equal(second.failureClass, 'RESOURCE_BUSY');

  // 归还路径：另起一个容量为 2 的队列——第一个任务用掉 1 个令牌并成功入队，
  // 第二个任务通过限流闸门后被**准入**拒绝（同一事项重复提交），令牌必须归还；
  // 否则一次「没接成的活」会永久吃掉配额（容量为 1 时根本走不到准入，故用 2）。
  const store2 = createMemoryStore();
  const clock2 = makeClock();
  let m = 0;
  const controller2 = createController({ store: store2, nowIso: clock2.nowIso, workerId: 'w-test-2', idFactory: () => `att2-${++m}` });
  const queue2 = createTaskQueue({
    store: store2, controller: controller2, nowIso: clock2.nowIso,
    rateLimiter: createRateLimiter({ capacity: 2, refillMs: 60_000, nowMs: () => clock2.at() }),
    circuitBreaker: createCircuitBreaker({ nowMs: () => clock2.at() }),
  });
  const first2 = await queue2.enqueue({ spec: specOf({ taskId: 't-a' }) });
  assert.equal(first2.admitted, true);
  assert.equal(queue2.rateLimiter.snapshot().find((e) => e.key === 'xws').tokens, 1, '扣掉 1 个');

  const denied = await queue2.enqueue({ spec: specOf({ taskId: 't-a' }) }); // 同一事项重复提交
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, 'DUPLICATE_TASK');
  assert.equal(queue2.rateLimiter.snapshot().find((e) => e.key === 'xws').tokens, 1, '准入被拒后令牌已归还');
});

test('入队：同一 lane 的多个不同任务都能入队（lane 占用是执行期约束，不是准入约束）', async () => {
  const { queue, store } = await makeHarness();
  const first = await queue.enqueue({ spec: specOf({ taskId: 't1' }) });
  assert.equal(first.admitted, true);

  // 同一账号/profile/能力下的第二件**不同**工作必须能排队；否则商品级 fan-out 无从实现。
  const second = await queue.enqueue({ spec: specOf({ taskId: 't2' }) });
  assert.equal(second.admitted, true, '不同业务的同 lane 任务是队列项，不是重复');
  assert.equal((await store.listActiveRuns({})).length, 2);
  assert.equal((await queue.depth()).byLane[0].count, 2);

  // 但真正重复的同一件事项会被去重挡下（按 idempotencyKey，不按 lane）。
  const duplicate = await queue.enqueue({ spec: specOf({ taskId: 't1' }) });
  assert.equal(duplicate.admitted, false);
  assert.equal(duplicate.reason, 'DUPLICATE_TASK');
  assert.equal(duplicate.failureClass, 'POLICY_DENIED');
  assert.equal((await store.listActiveRuns({})).length, 2, '重复任务不落 run');

  // 换 capability 即换 lane，互不影响。
  const other = await queue.enqueue({ spec: specOf({ taskId: 't3', capability: 'cap.b' }) });
  assert.equal(other.admitted, true);
});

test('入队：全局队列深度达到上限触发背压', async () => {
  const { queue } = await makeHarness({ limits: { maxQueueDepth: 1 } });
  assert.equal((await queue.enqueue({ spec: specOf({ taskId: 't1', capability: 'cap.a' }) })).admitted, true);

  const blocked = await queue.enqueue({ spec: specOf({ taskId: 't2', capability: 'cap.b' }) });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'BACKPRESSURE');
  assert.match(blocked.detail, /queue depth 1\/1/);
});

test('入队：单 lane 队列深度达到上限触发背压', async () => {
  const { queue } = await makeHarness({ limits: { maxQueueDepthPerLane: 1, maxQueueDepth: 100 } });
  assert.equal((await queue.enqueue({ spec: specOf({ taskId: 't1', capability: 'cap.a' }) })).admitted, true);
  const depth = await queue.depth();
  assert.equal(depth.total, 1);
  assert.equal(depth.byLane.length, 1);

  const second = await queue.enqueue({ spec: specOf({ taskId: 't2', capability: 'cap.a' }) });
  assert.equal(second.admitted, false);
  assert.equal(second.reason, 'BACKPRESSURE', '单 lane 深度上限先于准入命中');
  assert.match(second.detail, /lane depth 1\/1/);
  assert.equal((await queue.depth()).total, 1, '被挡下的任务不占队列深度');
});

test('入队：规格不合法归 INVALID_SPEC，重试无用', async () => {
  const { queue } = await makeHarness();
  const missingCapability = { taskId: 't1', workflow: 'wf', identity: IDENTITY };
  const result = await queue.enqueue({ spec: missingCapability });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'INVALID_SPEC');
  assert.ok(result.rejectionReasons.some((r) => r.includes('taskSpec.capability')));

  const badIdentity = await queue.enqueue({ spec: { taskId: 't2', workflow: 'wf', capability: 'cap.a', identity: { tenantId: 't1' } } });
  assert.equal(badIdentity.reason, 'INVALID_SPEC');
});

test('出队顺序：优先级降序 -> 入队时间升序 -> runId 升序，完全可复现', async () => {
  const { queue, store, clock } = await makeHarness();
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';

  await seedRun(store, { runId: A, capability: 'cap.a', queue: { priority: 0, enqueuedAt: new Date(clock.at()).toISOString() } });
  clock.advance(1_000);
  await seedRun(store, { runId: B, capability: 'cap.b', queue: { priority: 5, enqueuedAt: new Date(clock.at()).toISOString() } });
  clock.advance(1_000);
  await seedRun(store, { runId: C, capability: 'cap.c', queue: { priority: 5, enqueuedAt: new Date(clock.at()).toISOString() } });

  const first = await queue.nextCandidate();
  assert.equal(first.runId, B, '优先级高的先出，同优先级按入队时间（B 早于 C）');

  // 把 B、C 移出队列后应轮到 A
  const ctxB = await store.loadContext(B);
  await store.saveContext(B, { ...ctxB, executionStatus: 'SUCCEEDED', contextVersion: ctxB.contextVersion + 1 }, ctxB.contextVersion);
  const ctxC = await store.loadContext(C);
  await store.saveContext(C, { ...ctxC, executionStatus: 'SUCCEEDED', contextVersion: ctxC.contextVersion + 1 }, ctxC.contextVersion);

  const next = await queue.nextCandidate();
  assert.equal(next.runId, A, '只剩 A 时返回 A');
});

test('出队闸门：退避未到的任务被跳过，时钟推进后重新可出', async () => {
  const { queue, store, clock } = await makeHarness();
  const runId = '11111111-1111-4111-8111-111111111111';
  const future = new Date(clock.at() + 30_000).toISOString();
  await seedRun(store, { runId, capability: 'cap.a', queue: { notBefore: future } });

  assert.equal(await queue.nextCandidate(), null, '退避期内不出队');

  clock.advance(30_001);
  const picked = await queue.nextCandidate();
  assert.equal(picked?.runId, runId, '退避结束后重新可出队');
  assert.equal(picked.isWrite, false);
  assert.equal(picked.limit, 1);
});

test('出队闸门：已过截止时间的任务不被选中（由 sweepTimeouts 负责收敛）', async () => {
  const { queue, store, clock } = await makeHarness();
  const runId = '11111111-1111-4111-8111-111111111111';
  const past = new Date(clock.at() - 1).toISOString();
  await seedRun(store, { runId, capability: 'cap.a', queue: { deadlineAt: past } });
  assert.equal(await queue.nextCandidate(), null);
});

test('出队闸门：lane 容量用完时同 lane 的排队任务不出队，释放后可出', async () => {
  const { queue, store } = await makeHarness();
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';
  const lane = laneFor({ identity: IDENTITY, capability: 'cap.a' });
  // 同 lane 两条：A 正在跑，B 在排队（绕过准入直接落库，用于验证队列容量闸门本身）
  await seedRun(store, { runId: runA, capability: 'cap.a', lane, executionStatus: 'RUNNING' });
  await seedRun(store, { runId: runB, capability: 'cap.a', lane, executionStatus: 'QUEUED' });

  assert.equal(await queue.nextCandidate(), null, 'lane 已满，B 不能出队');

  await seedRun(store, { runId: '44444444-4444-4444-8444-444444444444', capability: 'cap.z', lane: laneFor({ identity: IDENTITY, capability: 'cap.z' }), executionStatus: 'QUEUED' });
  const other = await queue.nextCandidate();
  assert.equal(other.runId, '44444444-4444-4444-8444-444444444444', '别的 lane 不受影响');

  const ctxA = await store.loadContext(runA);
  await store.saveContext(runA, { ...ctxA, executionStatus: 'SUCCEEDED', contextVersion: ctxA.contextVersion + 1 }, ctxA.contextVersion);
  const picked = await queue.nextCandidate();
  assert.equal(picked.runId, runB, 'lane 释放后 B 可以出队');
});

test('认领：只做一次状态转移，产出 attempt 与 lease', async () => {
  const { queue } = await makeHarness();
  await queue.enqueue({ spec: specOf({ taskId: 't1' }) });

  const claimed = await queue.claim();
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.attemptId, 'att-1');
  assert.equal(claimed.limit, 1);

  assert.equal((await queue.nextCandidate()), null, '已进入 RUNNING，不再作为候选');
});

test('回队列：退避写进上下文，执行轴由 Controller 决定，不重复执行', async () => {
  const { queue, clock, store } = await makeHarness();
  const { runId } = await queue.enqueue({ spec: specOf({ taskId: 't1' }) });
  await queue.claim();

  const requeued = await queue.requeue({ runId, failureClass: 'RESOURCE_BUSY', detail: 'lane busy' });
  assert.equal(requeued.attempts, 1);
  assert.equal(requeued.executionStatus, 'QUEUED', 'RESOURCE_BUSY 映射为 REQUEUE');
  assert.equal(requeued.notBefore, new Date(clock.at() + 1_000).toISOString(), '首次退避 1s');

  const context = await store.loadContext(runId);
  assert.equal(context.queue.attempts, 1);
  assert.equal(context.queue.notBefore, requeued.notBefore);
  assert.equal(context.leaseStatus, 'RELEASED');
  assert.equal(context.blocker.class, 'RESOURCE_BUSY');
  assert.equal((await store.listAttempts(runId)).length, 1, '不重复开 attempt');
});

test('超时清扫：RUNNING 且超过截止时间的任务转为等待人工，不自动重试', async () => {
  const { queue, store, clock } = await makeHarness();
  const deadline = new Date(clock.at() + 5_000).toISOString();
  const { runId } = await queue.enqueue({ spec: specOf({ taskId: 't1', deadlineAt: deadline }) });
  // 必须先真正开始执行（RUNNING + 真实 attempt）；未开始的任务由出队闸门拦住，不属于超时。
  const claimed = await queue.claim();
  assert.equal(claimed.claimed, true);

  assert.equal((await queue.sweepTimeouts()).expired, 0, '未超时不处理');

  clock.advance(6_000);
  const swept = await queue.sweepTimeouts();
  assert.equal(swept.scanned, 1);
  assert.equal(swept.expired, 1);
  assert.equal(swept.outcomes[0].runId, runId);
  assert.equal(swept.outcomes[0].executionStatus, 'PAUSED');
  assert.equal(swept.outcomes[0].humanGateStatus, 'WAITING_HUMAN');

  const context = await store.loadContext(runId);
  assert.equal(context.blocker.class, 'HUMAN_REQUIRED');
  assert.match(context.blocker.detail, /deadline exceeded/);
  const attempts = await store.listAttempts(runId);
  assert.equal(attempts.length, 1, '不自动重试，不新开 attempt');
  assert.equal(attempts[0].failureClass, 'HUMAN_REQUIRED');
});

test('取消：进入终态，不再参与出队与活跃计数', async () => {
  const { queue, store } = await makeHarness();
  const { runId } = await queue.enqueue({ spec: specOf({ taskId: 't1' }) });

  const cancelled = await queue.cancel(runId);
  assert.equal(cancelled.executionStatus, 'FAILED');
  assert.equal(await queue.nextCandidate(), null);
  assert.equal((await store.listActiveRuns({})).length, 0);
  assert.equal((await queue.depth()).total, 0);
});

test('深度统计：按 lane 分组且顺序稳定', async () => {
  const { queue, store } = await makeHarness();
  await seedRun(store, { runId: '11111111-1111-4111-8111-111111111111', capability: 'cap.b' });
  await seedRun(store, { runId: '22222222-2222-4222-8222-222222222222', capability: 'cap.a' });
  await seedRun(store, { runId: '33333333-3333-4333-8333-333333333333', capability: 'cap.a' });

  const depth = await queue.depth();
  assert.equal(depth.total, 3);
  assert.deepEqual(depth.byLane.map((entry) => entry.count), [2, 1], 'cap.a 有 2 条');
  const lanes = depth.byLane.map((entry) => entry.lane);
  assert.deepEqual([...lanes].sort(), lanes, 'lane 列表按字典序稳定排序');
});

test('队列拒绝原因的枚举与实现一致', () => {
  assert.deepEqual([...QUEUE_REJECTION], ['BACKPRESSURE', 'DUPLICATE_TASK', 'RATE_LIMITED', 'CIRCUIT_OPEN', 'DEADLINE_PASSED', 'INVALID_SPEC']);
});
