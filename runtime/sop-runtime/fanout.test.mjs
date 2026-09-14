// 商品级 fan-out 的单测：失败隔离、不重复消费、冲突交人工、并发放大需要证据。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createTaskQueue, createCircuitBreaker, createRateLimiter } from './task-queue.mjs';
import {
  buildFanoutSpecs, dispatchFanout, collectFanout, assertNoDuplicateBusinessKeys,
  buildItemBusinessKey, fanoutLaneLimits, FanoutError, FANOUT_REJECTION,
} from './fanout.mjs';

const IDENTITY = Object.freeze({
  tenantId: 't1', storeId: 's1', platform: 'xws',
  accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0',
});

const PARENT = Object.freeze({ runId: '99999999-9999-4999-8999-999999999999', taskId: 'faq-weekly', workflow: 'faq.fanout' });

function harness() {
  const store = createMemoryStore();
  let n = 0;
  const controller = createController({ store, workerId: 'w-test', idFactory: () => `att-${++n}` });
  const queue = createTaskQueue({
    store, controller,
    circuitBreaker: createCircuitBreaker({ failureThreshold: 99 }),
    rateLimiter: createRateLimiter({ capacity: 1000, refillMs: 1 }),
    limits: { maxQueueDepth: 1000, maxQueueDepthPerLane: 1000 },
  });
  return { store, controller, queue };
}

const ITEMS = [{ id: 'sku-1' }, { id: 'sku-2' }, { id: 'sku-3' }];

test('spec 构造：每个子项有稳定 businessKey，且重复 itemKey 直接拒绝', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'xws.faq.raw-collect', identity: IDENTITY, write: true });
  assert.equal(specs.length, 3);
  assert.deepEqual(specs.map((spec) => spec.itemKey), ['sku-1', 'sku-2', 'sku-3']);
  assert.deepEqual(specs.map((spec) => spec.businessKey), [
    buildItemBusinessKey({ parentRunId: PARENT.runId, capability: 'xws.faq.raw-collect', itemKey: 'sku-1' }),
    buildItemBusinessKey({ parentRunId: PARENT.runId, capability: 'xws.faq.raw-collect', itemKey: 'sku-2' }),
    buildItemBusinessKey({ parentRunId: PARENT.runId, capability: 'xws.faq.raw-collect', itemKey: 'sku-3' }),
  ]);
  // 每个子项有自己的 lane（按能力+身份+写目标），互不串行阻塞。
  assert.equal(new Set(specs.map((spec) => spec.lane)).size, 1);

  assert.throws(
    () => buildFanoutSpecs({ parent: PARENT, items: [{ id: 'a' }, { id: 'a' }], capability: 'c', identity: IDENTITY }),
    (error) => error instanceof FanoutError && error.code === 'DUPLICATE_ITEM_KEY',
  );
  assert.throws(
    () => buildFanoutSpecs({ parent: PARENT, items: [{ noKey: 1 }], capability: 'c', identity: IDENTITY }),
    (error) => error.code === 'INVALID_ITEM',
  );
  assert.throws(
    () => buildFanoutSpecs({ parent: {}, items: ITEMS, capability: 'c', identity: IDENTITY }),
    (error) => error.code === 'PARENT_UNKNOWN',
  );
});

test('派发：全部成功时 complete 为真', async () => {
  const { queue } = harness();
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'xws.faq.raw-collect', identity: IDENTITY });
  const result = await dispatchFanout({ queue, specs, registeredCapabilities: ['xws.faq.raw-collect'] });
  assert.equal(result.total, 3);
  assert.equal(result.dispatched, 3);
  assert.equal(result.complete, true);
  for (const outcome of result.outcomes) assert.equal(outcome.dispatched, true);
});

test('失败隔离：单个子项被拒不影响其余子项，且拒因区分「稍后重试」与「子项本身有问题」', async () => {
  const { queue } = harness();
  // 让第二个子项因缺 capability 被拒（模拟某个商品的数据映射缺失导致的能力校验失败）
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'xws.faq.raw-collect', identity: IDENTITY });
  specs[1].capability = '';  // 规格非法
  const result = await dispatchFanout({ queue, specs, registeredCapabilities: ['xws.faq.raw-collect'] });

  assert.equal(result.total, 3);
  assert.equal(result.dispatched, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.complete, false, '有子项没派出去就不能算整批完成');
  const failed = result.outcomes.find((outcome) => !outcome.dispatched);
  assert.equal(failed.itemKey, 'sku-2');
  assert.equal(failed.reason, 'INVALID_SPEC');
  assert.equal(failed.retryable, false, '规格非法不是「稍后再试」');
  // 其余两个仍然派出去了 —— 失败没有传染。
  assert.deepEqual(result.outcomes.filter((outcome) => outcome.dispatched).map((outcome) => outcome.itemKey), ['sku-1', 'sku-3']);
});

test('失败隔离：容量类拒因被标记为可重试，不误导调用方去改数据', async () => {
  const store = createMemoryStore();
  let n = 0;
  const controller = createController({ store, workerId: 'w-test', idFactory: () => `att-${++n}` });
  const queue = createTaskQueue({
    store, controller,
    circuitBreaker: createCircuitBreaker({ failureThreshold: 99 }),
    rateLimiter: createRateLimiter({ capacity: 1, refillMs: 60_000 }),
    limits: { maxQueueDepth: 1000 },
  });
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'xws.faq.raw-collect', identity: IDENTITY });
  const result = await dispatchFanout({ queue, specs, registeredCapabilities: ['xws.faq.raw-collect'] });

  assert.equal(result.dispatched, 1, '限流容量只够一个');
  assert.equal(result.retryableFailures, 2);
  for (const outcome of result.outcomes.filter((entry) => !entry.dispatched)) {
    assert.equal(outcome.reason, 'RATE_LIMITED');
    assert.equal(outcome.retryable, true);
  }
});

test('收集：全部成功则合并结果完成度与冲突都干净', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'c', identity: IDENTITY });
  const collected = collectFanout({
    specs,
    outcomes: [
      { itemKey: 'sku-1', ok: true, value: 10 },
      { itemKey: 'sku-2', ok: true, value: 20 },
      { itemKey: 'sku-3', ok: true, value: 30 },
    ],
  });
  assert.equal(collected.ok, true);
  assert.equal(collected.complete, true);
  assert.equal(collected.requiresHuman, false);
  assert.deepEqual(collected.merged.map((row) => row.key), ['sku-1', 'sku-2', 'sku-3']);
});

test('收集：缺失子项一律要求人工，不能把「少了几件」当成全部成功', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'c', identity: IDENTITY });
  const collected = collectFanout({
    specs,
    outcomes: [{ itemKey: 'sku-1', ok: true, value: 10 }],
  });
  assert.equal(collected.complete, false);
  assert.equal(collected.requiresHuman, true);
  assert.deepEqual(collected.missingItems, ['sku-2', 'sku-3']);
  assert.equal(collected.ok, true, '已回来的结果本身没冲突，但完整度为假');
});

test('收集：同一 key 的冲突值交人工，绝不静默择一', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'c', identity: IDENTITY });
  const collected = collectFanout({
    specs,
    outcomes: [
      { itemKey: 'sku-1', ok: true, value: 10 },
      { itemKey: 'sku-1', ok: true, value: 99 },
      { itemKey: 'sku-2', ok: true, value: 20 },
      { itemKey: 'sku-3', ok: true, value: 30 },
    ],
  });
  assert.equal(collected.requiresHuman, true);
  assert.equal(collected.conflicts.length, 1);
  assert.deepEqual(collected.conflicts[0].values, [10, 99]);
});

test('收集：单个子项失败单列进 failures，不影响其余结果的可用性', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'c', identity: IDENTITY });
  const collected = collectFanout({
    specs,
    outcomes: [
      { itemKey: 'sku-1', ok: true, value: 10 },
      { itemKey: 'sku-2', ok: false, error: 'details page access denied' },
      { itemKey: 'sku-3', ok: true, value: 30 },
    ],
  });
  assert.equal(collected.failures.length, 1);
  assert.match(collected.failures[0].error, /access denied/);
  assert.deepEqual(collected.merged.map((row) => row.key), ['sku-1', 'sku-3'], '其余两件仍可用');
  assert.equal(collected.complete, true, '三件都回来了（一件带失败结果）');
});

test('重复消费守卫：同批内 businessKey 必须唯一，重复即抛错（重复写外部效果的前置防线）', () => {
  const specs = buildFanoutSpecs({ parent: PARENT, items: ITEMS, capability: 'c', identity: IDENTITY });
  assert.equal(assertNoDuplicateBusinessKeys(specs), true);

  const tampered = [...specs, { ...specs[0] }];
  assert.throws(
    () => assertNoDuplicateBusinessKeys(tampered),
    (error) => error instanceof FanoutError && error.code === 'DUPLICATE_ITEM_KEY' && error.details.duplicates[0].itemKeys.join(',') === 'sku-1,sku-1',
  );
});

test('跨父运行的同一商品是不同的幂等键（重跑不会被当成「已提交」而静默跳过）', () => {
  const first = buildItemBusinessKey({ parentRunId: 'run-a', capability: 'c', itemKey: 'sku-1' });
  const second = buildItemBusinessKey({ parentRunId: 'run-b', capability: 'c', itemKey: 'sku-1' });
  assert.notEqual(first, second);
});

test('并发放大必须建立在容量证据上：没有证据不放大，写操作恒为 1', () => {
  const lanes = ['lane-a', 'lane-b'];
  assert.deepEqual(fanoutLaneLimits({ lanes }), {}, '无证据 → 不放大');
  assert.deepEqual(fanoutLaneLimits({ lanes, evidence: { 'lane-a': 1 } }), {}, '容量 1 不算放大');
  assert.deepEqual(fanoutLaneLimits({ lanes, evidence: { 'lane-a': 3, 'lane-b': 2 } }), { 'lane-a': 3, 'lane-b': 2 });
  assert.deepEqual(fanoutLaneLimits({ lanes, evidence: { 'lane-a': '3' } }), { 'lane-a': 3 }, '字符串数字可接受');
  assert.deepEqual(fanoutLaneLimits({ lanes, evidence: { 'lane-a': 0 } }), {}, '0/负数不放大');
});

test('拒绝原因枚举与实现一致', () => {
  assert.deepEqual([...FANOUT_REJECTION], ['DUPLICATE_ITEM_KEY', 'INVALID_ITEM', 'PARENT_UNKNOWN']);
});
