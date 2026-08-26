import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAdvanceCommand, inspectFaqOperatorStatus } from './run-faq-operator.mjs';

async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

test('status advances one stage at a time and never treats missing evidence as imported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  await json(join(collection, 'top5-manifest.json'), { period, products: Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) })) });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.status, 'IN_PROGRESS');
  assert.equal(status.nextAction, 'COLLECT_EVIDENCE');
  assert.equal(status.top5Count, 5);
  assert.equal(status.completedProducts, 0);
});

test('verified downstream summary can recover a missing analysis receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-recovery-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  const products = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) }));
  await json(join(collection, 'top5-manifest.json'), { period, products });
  for (const product of products) {
    const directory = join(collection, product.productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'qa.csv'), '问题,回答\n', 'utf8');
    await writeFile(join(directory, 'reviews.csv'), '评论内容\n有效评论\n', 'utf8');
    await writeFile(join(directory, 'reviews-source.zip'), 'PK', 'utf8');
    await json(join(directory, 'qa-receipt.json'), { productId: product.productId, status: 'EMPTY_SOURCE_ROWS' });
    await json(join(directory, 'reviews-receipt.json'), { productId: product.productId, status: 'COMPLETED' });
  }
  await json(join(collection, 'apply-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, tableRecordCount: 5 });
  await json(join(analysis, 'topic-summary-apply-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, detailRecords: 5, topicRecords: 1, counts: { 其他: 5 } });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.analysisVerified, true);
  assert.equal(status.summaryVerified, true);
  assert.equal(status.nextAction, 'PUBLISH_OPERATOR_TABLE');
});

test('advance command is deterministic and publication replacement is explicit', () => {
  const common = { periodStart: '2026-08-23', periodEnd: '2026-08-29', baseUrl: 'https://tenant.feishu.cn/base/appToken', envFile: 'D:/secret.env' };
  assert.deepEqual(buildAdvanceCommand('ANALYZE', common), {
    script: 'runtime/run-faq-text-analysis.mjs',
    args: ['--base-url', common.baseUrl, '--env-file', common.envFile, '--period-start', common.periodStart, '--period-end', common.periodEnd, '--apply', '--confirm-app-token', 'appToken'],
  });
  assert.throws(() => buildAdvanceCommand('PUBLISH_OPERATOR_TABLE', common), /explicit replacement intent/u);
  assert.equal(buildAdvanceCommand('PUBLISH_OPERATOR_TABLE', { ...common, replaceCurrent: true }).args.includes('--replace-current'), true);
  assert.equal(buildAdvanceCommand('COLLECT_EVIDENCE', common), null);
});

test('a publication receipt from another period does not complete the current period', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-stale-publish-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  const products = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) }));
  await json(join(collection, 'top5-manifest.json'), { period, products });
  for (const product of products) {
    const directory = join(collection, product.productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'qa.csv'), '问题,回答\n', 'utf8');
    await writeFile(join(directory, 'reviews.csv'), '评论内容\n有效评论\n', 'utf8');
    await writeFile(join(directory, 'reviews-source.zip'), 'PK', 'utf8');
    await json(join(directory, 'qa-receipt.json'), { productId: product.productId, status: 'EMPTY_SOURCE_ROWS' });
    await json(join(directory, 'reviews-receipt.json'), { productId: product.productId, status: 'COMPLETED' });
  }
  await json(join(collection, 'apply-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, tableRecordCount: 5 });
  await json(join(analysis, 'topic-summary-apply-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, detailRecords: 5, topicRecords: 1 });
  await json(join(analysis, 'template-sync-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period: '2026-08-16_2026-08-22', targetRecords: 5 });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.operatorPublished, false);
  assert.equal(status.nextAction, 'PUBLISH_OPERATOR_TABLE');
});

test('an unresolved product alert blocks collection progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-alert-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  await json(join(collection, 'top5-manifest.json'), {
    period,
    products: Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) })),
  });
  await json(join(collection, '1', 'alert.json'), { code: 'LOGIN_REQUIRED', productId: '1', message: '小旺神登录失效' });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.status, 'BLOCKED');
  assert.equal(status.nextAction, 'RESOLVE_BLOCKER');
  assert.equal(status.blocker.code, 'LOGIN_REQUIRED');
});

test('corrupt evidence files do not count as a completed product', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-corrupt-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  const products = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) }));
  await json(join(collection, 'top5-manifest.json'), { period, products });
  for (const product of products) {
    const directory = join(collection, product.productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'qa.csv'), '问题,回答\n', 'utf8');
    await writeFile(join(directory, 'reviews.csv'), '评论内容\n有效评论\n', 'utf8');
    await writeFile(join(directory, 'reviews-source.zip'), product.productId === '3' ? 'broken' : 'PK\u0003\u0004', 'utf8');
    await json(join(directory, 'qa-receipt.json'), { productId: product.productId, sourceFile: 'qa.csv', status: 'EMPTY_SOURCE_ROWS' });
    await json(join(directory, 'reviews-receipt.json'), { productId: product.productId, sourceFile: 'reviews-source.zip', normalizedFile: 'reviews.csv', status: 'COMPLETED' });
  }
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.evidenceComplete, false);
  assert.equal(status.completedProducts, 4);
  assert.equal(status.nextAction, 'COLLECT_EVIDENCE');
});
