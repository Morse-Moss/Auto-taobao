// FAQ 商品级 fan-out 驱动器的行为测试（实施计划迁移顺序第 2 项）。
//
// 这些测试关心的是**隔离语义**，不是"跑通了"：
//   - 一个商品的证据坏了，其余商品必须照常结算（失败隔离）；
//   - 坏掉的那个必须出现在人工队列里并带可执行原因（不被静默吞掉）；
//   - 父级 complete 与 publishable 必须分开：跑完 ≠ 成功；
//   - 子项 businessKey 必须带父批次，跨周重跑不能把上期当成已提交。
// 用的是真实 registry + 真实 loader + 真实 adapter，只有 store 在内存里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildRegistryFromDisk } from './build-skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { buildHumanQueue, readBatchManifest, runFaqFanout, FAQ_PRODUCT_CAPABILITY, writeBatchReceipt } from './run-faq-fanout.mjs';

const PERIOD_START = '2026-08-30';
const PERIOD_END = '2026-09-05';
const PERIOD = `${PERIOD_START}_${PERIOD_END}`;

const IDENTITY = {
  tenantId: 'sycm', storeId: 'bathtub', platform: 'xws',
  accountId: 'buyer-1', browserProfileId: 'edge-isolated', contractVersion: 'sop-context-v1',
};

const QA_CSV = '问题,回答\n安装方便吗,"可以,自己装"\n会滑吗,不会\n';
const REVIEWS_CSV = '评论,日期\n很好用,2026-09-01\n很满意,2026-09-02\n';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function writeProductEvidence(directory, { productId, breakHash = false } = {}) {
  await mkdir(directory, { recursive: true });
  const qaBytes = Buffer.from(QA_CSV, 'utf8');
  const reviewBytes = Buffer.from(REVIEWS_CSV, 'utf8');
  const zipBytes = Buffer.concat([Buffer.from('PK', 'ascii'), Buffer.alloc(16, 1)]);
  await writeFile(join(directory, 'qa.csv'), qaBytes);
  await writeFile(join(directory, 'reviews.csv'), reviewBytes);
  await writeFile(join(directory, 'reviews-source.zip'), zipBytes);
  await writeFile(join(directory, 'qa-receipt.json'), JSON.stringify({
    productId, sourceFile: 'qa.csv', status: 'COMPLETED',
    sha256: breakHash ? 'f'.repeat(64) : sha256(qaBytes),
  }));
  await writeFile(join(directory, 'reviews-receipt.json'), JSON.stringify({
    productId, sourceFile: 'reviews-source.zip', normalizedFile: 'reviews.csv',
    sha256: sha256(zipBytes), normalizedSha256: sha256(reviewBytes), status: 'COMPLETED',
    scope: { content: '全部', date: '全部', sku: '未指定', impression: '未筛选', analysis: '未调用' },
  }));
}

// 造一个只含「锁定清单 + 各商品证据」的临时 runtimeRoot。
async function makeRuntime({ products = ['7001', '7002', '7003'], outcome = 'PARTIAL_CANDIDATES', broken = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faq-fanout-'));
  const collectionDir = resolve(root, 'question-library-collection', PERIOD);
  await mkdir(collectionDir, { recursive: true });
  await writeFile(resolve(collectionDir, 'top5-manifest.json'), JSON.stringify({
    period: PERIOD,
    outcome,
    generatedAt: '2026-09-06T00:00:00.000Z',
    products: products.map((productId, index) => ({
      productId,
      productTitle: `竞品浴缸 ${index + 1}`,
      classification: 'A',
      rank: index + 1,
      monthlyReceived: 100 + index,
    })),
  }));
  for (const productId of products) {
    await writeProductEvidence(resolve(collectionDir, productId), { productId, breakHash: broken.includes(productId) });
  }
  return { root, collectionDir };
}

async function harness(runtimeRoot) {
  const { registry, result } = await buildRegistryFromDisk();
  assert.equal(result.ok, true, `registry must be valid: ${JSON.stringify(result.errors ?? [])}`);
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: (() => { let n = 0; return () => `run-${++n}`; })() });
  return {
    registry,
    loader: createLoader({ registry }),
    store,
    controller,
    evidenceStore: createEvidenceStore({ root: resolve(runtimeRoot, 'evidence') }),
  };
}

test('全部商品证据完好时整批 publishable', async () => {
  const { root } = await makeRuntime();
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    assert.equal(receipt.total, 3);
    assert.equal(receipt.dispatched, 3);
    assert.equal(receipt.collected, 3);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.publishable, true);
    assert.equal(receipt.requiresHuman, false);
    assert.deepEqual(receipt.humanQueue, []);
    assert.equal(receipt.merged.length, 3);
    for (const outcome of receipt.outcomes) {
      assert.equal(outcome.value.evidenceStatus, 'VALIDATED');
      assert.match(outcome.businessKey, new RegExp(`^faq-fanout-${PERIOD}:${FAQ_PRODUCT_CAPABILITY.replace(/\./gu, '\\.')}:`, 'u'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('单个商品证据损坏时其余商品照常结算（失败隔离）', async () => {
  const { root } = await makeRuntime({ products: ['7001', '7002', '7003'], broken: ['7002'] });
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    // 整批跑完了（complete），但不可发布（publishable=false）——两者必须分开。
    assert.equal(receipt.complete, true);
    assert.equal(receipt.publishable, false);
    assert.equal(receipt.collected, 2);
    // 隔离：坏掉的那个不影响另外两个的结论。
    const ok = receipt.outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.itemKey).sort();
    assert.deepEqual(ok, ['7001', '7003']);
    for (const outcome of receipt.outcomes.filter((o) => o.ok)) {
      assert.equal(outcome.value.evidenceStatus, 'VALIDATED');
    }
    // 人工队列必须点名到具体商品与具体原因，而不是一句「整批失败」。
    assert.equal(receipt.humanQueue.length, 1);
    assert.equal(receipt.humanQueue[0].productId, '7002');
    assert.equal(receipt.humanQueue[0].reason, 'EVIDENCE_INVALID');
    assert.equal(receipt.humanQueue[0].failureClass, 'EVIDENCE_INVALID');
    assert.equal(receipt.humanQueue[0].retryable, false);
    assert.equal(receipt.merged.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('证据缺失的商品进人工队列但不阻塞其他商品', async () => {
  const { root, collectionDir } = await makeRuntime({ products: ['7001', '7002'] });
  const deps = await harness(root);
  try {
    // 把 7002 的评论原文删掉：模拟「本周这个商品没采到」。
    await rm(join(collectionDir, '7002', 'reviews-source.zip'), { force: true });
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    assert.equal(receipt.collected, 1);
    assert.equal(receipt.humanQueue.length, 1);
    assert.equal(receipt.humanQueue[0].reason, 'EVIDENCE_INVALID');
    assert.match(String(receipt.humanQueue[0].detail), /EVIDENCE_MISSING|missing evidence/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('空批次不是失败，也不等于采集完成', async () => {
  const { root } = await makeRuntime({ products: [], outcome: 'NO_QUALIFIED_CANDIDATES' });
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    assert.equal(receipt.empty, true);
    assert.equal(receipt.emptyReason, 'NO_QUALIFIED_CANDIDATES');
    assert.equal(receipt.complete, false);
    assert.equal(receipt.requiresHuman, false);
    assert.equal(receipt.total, 0);
    assert.match(receipt.note, /周期级完成判定/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未锁定的清单直接拒绝（不能拿未锁定清单当范围依据）', async () => {
  const { root } = await makeRuntime({ products: ['7001'], outcome: '' });
  await assert.rejects(
    () => readBatchManifest({ collectionDir: resolve(root, 'question-library-collection', PERIOD), period: PERIOD }),
    (error) => error.code === 'MANIFEST_NOT_LOCKED',
  );
  await rm(root, { recursive: true, force: true });
});

test('清单缺失直接拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-fanout-'));
  await assert.rejects(
    () => readBatchManifest({ collectionDir: resolve(root, 'question-library-collection', PERIOD), period: PERIOD }),
    (error) => error.code === 'MANIFEST_MISSING',
  );
  await rm(root, { recursive: true, force: true });
});

test('指定了清单里不存在的商品时拒绝（不允许凭空造子项）', async () => {
  const { root } = await makeRuntime({ products: ['7001', '7002'] });
  const deps = await harness(root);
  try {
    await assert.rejects(
      () => runFaqFanout({
        runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        identity: IDENTITY, productIds: ['7001', '9999'], ...deps,
      }),
      (error) => error.code === 'PRODUCT_NOT_IN_BATCH' && error.details.unknown.includes('9999'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('可以只重跑指定商品（定向重试）', async () => {
  const { root } = await makeRuntime({ products: ['7001', '7002', '7003'] });
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, productIds: ['7002'], ...deps,
    });
    assert.equal(receipt.total, 1);
    assert.deepEqual(receipt.outcomes.map((outcome) => outcome.itemKey), ['7002']);
    assert.equal(receipt.publishable, true);
    // 清单统计仍如实报告全部商品数，避免「只跑了一个」被读成「只有这一个」。
    assert.deepEqual(receipt.manifestSummary, {
      products: 3, selected: 1, outcome: 'PARTIAL_CANDIDATES', top5GeneratedAt: '2026-09-06T00:00:00.000Z',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('子项标识带父批次且同批内唯一（跨周重跑不会认成已提交）', async () => {
  const { root } = await makeRuntime({ products: ['7001', '7002'] });
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    const keys = receipt.outcomes.map((outcome) => outcome.businessKey);
    assert.equal(new Set(keys).size, keys.length, 'business keys must be unique inside one batch');
    for (const key of keys) assert.match(key, new RegExp(`^faq-fanout-${PERIOD}:`, 'u'));
    // 换一周：父批次变了，键也必须变，否则跨周会被当成同一件事。
    assert.notEqual(
      keys[0].replace(PERIOD, '2026-09-06_2026-09-12'),
      keys[0],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同批次内同一商品只产出一条 run（不会重复消费）', async () => {
  const { root } = await makeRuntime({ products: ['7001', '7001'] });
  const deps = await harness(root);
  try {
    // 清单里出现重复商品是数据问题，必须在派发前就被挡住，而不是写两次。
    await assert.rejects(
      () => runFaqFanout({
        runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        identity: IDENTITY, ...deps,
      }),
      (error) => error.code === 'DUPLICATE_ITEM_KEY',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('人类队列的构建规则：派发被拒/缺失/冲突各有独立原因', () => {
  const specs = [{ itemKey: '1', businessKey: 'p:c:1' }, { itemKey: '2', businessKey: 'p:c:2' }, { itemKey: '3', businessKey: 'p:c:3' }];
  const outcomes = [
    { itemKey: '1', ok: false, reason: 'DISPATCH_REJECTED', failureClass: 'RESOURCE_BUSY', error: 'lane depth 20/20', retryable: true, runId: null },
    { itemKey: '2', ok: true, value: { productId: '2' }, runId: 'r2' },
  ];
  const collected = { missingItems: ['3'], conflicts: [{ key: '2', values: [{ a: 1 }, { a: 2 }], sources: ['r2', 'rX'] }] };
  const queue = buildHumanQueue({ specs, outcomes, collected });
  const byReason = Object.fromEntries(queue.map((item) => [item.reason, item]));
  assert.equal(queue.length, 3);
  assert.equal(byReason.DISPATCH_REJECTED.retryable, true);
  assert.equal(byReason.UNSETTLED.productId, '3');
  assert.equal(byReason.UNSETTLED.businessKey, 'p:c:3');
  assert.match(byReason.CONFLICT.detail, /two different evidence results/iu);
});

test('批次回执与人工队列都会落盘到周期目录', async () => {
  const { root } = await makeRuntime({ products: ['7001'], broken: ['7001'] });
  const deps = await harness(root);
  try {
    const receipt = await runFaqFanout({
      runtimeRoot: root, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      identity: IDENTITY, ...deps,
    });
    const paths = await writeBatchReceipt({ runtimeRoot: root, period: PERIOD, receipt });
    assert.equal(existsSync(paths.receiptPath), true);
    assert.equal(existsSync(paths.queuePath), true);
    const saved = JSON.parse(readFileSync(paths.receiptPath, 'utf8'));
    assert.equal(saved.period, PERIOD);
    assert.equal(saved.publishable, false);
    const queue = JSON.parse(readFileSync(paths.queuePath, 'utf8'));
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].productId, '7001');
    assert.equal(queue.items[0].reason, 'EVIDENCE_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
