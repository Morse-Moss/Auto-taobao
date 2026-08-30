import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from './faq-local-summary.mjs';
import { buildAdvanceCommand, inspectFaqOperatorStatus } from './run-faq-operator.mjs';

async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

const labels = FAQ_LABEL_CATALOG.map(({ label }) => label);
const summaryReceipt = (period) => ({
  mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION,
  summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION,
  painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION,
  operatorContentVersion: FAQ_OPERATOR_CONTENT_VERSION,
  source: { operatorXlsx: { path: 'operator.xlsx', sha256: 'a'.repeat(64) } },
  weekly: { path: 'weekly-summary.json', rows: 21, labels }, cumulative: { path: 'cumulative-summary.json', rows: 21, labels },
});

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
  await json(join(collection, 'raw-snapshot-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, snapshot: { format: 'jsonl' } });
  await json(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 5 });
  await json(join(analysis, 'aggregate-receipt.json'), summaryReceipt(period));
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.localAnalysisVerified, true);
  assert.equal(status.localSummariesBuilt, true);
  assert.equal(status.nextAction, 'PUBLISH_FEISHU_SUMMARIES');
});

test('advance command targets append-only detail enrichment', () => {
  const common = { periodStart: '2026-08-23', periodEnd: '2026-08-29', baseUrl: 'https://tenant.feishu.cn/base/appToken', envFile: 'D:/secret.env', runtimeRoot: 'D:/runtime', operatorXlsx: 'D:/operator.xlsx' };
  assert.deepEqual(buildAdvanceCommand('ANALYZE_LOCAL', common), {
    script: 'runtime/run-faq-text-analysis.mjs',
    args: ['--runtime-root', common.runtimeRoot, '--period-start', common.periodStart, '--period-end', common.periodEnd],
  });
  assert.throws(() => buildAdvanceCommand('PUBLISH_FEISHU_SUMMARIES', common), /master-table-id and --weekly-table-id/u);
  const publish = buildAdvanceCommand('PUBLISH_FEISHU_SUMMARIES', { ...common, masterTableId: 'tbl-master', weeklyTableId: 'tbl-weekly' });
  assert.equal(publish.script, 'runtime/publish-faq-detail-enrichment.mjs');
  assert.equal(publish.args.includes('--master-table-id'), true);
  assert.equal(publish.args.includes('--weekly-table-id'), true);
  assert.equal(publish.args.includes('--replace-current'), false);
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
  await json(join(collection, 'raw-snapshot-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, snapshot: { format: 'jsonl' } });
  await json(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 5 });
  await json(join(analysis, 'aggregate-receipt.json'), summaryReceipt(period));
  await json(join(analysis, 'publish-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period: '2026-08-16_2026-08-22', schemaVersion: 'faq-feishu-summary-v1.0.0', rows: { master: 21, weekly: 21 }, master: { name: '问题主库' }, weekly: { name: `问题库_${period}` }, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION, summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION, painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION, source: { weeklyHash: 'weekly', cumulativeHash: 'cumulative' }, feishuWrites: 1 });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.summariesPublished, false);
  assert.equal(status.nextAction, 'PUBLISH_FEISHU_SUMMARIES');
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
