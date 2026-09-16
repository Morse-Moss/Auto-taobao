import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { FAQ_AI_PROMPT_VERSION, FAQ_AI_REVIEW_VERSION } from './faq-ai-review.mjs';
import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from './faq-local-summary.mjs';
import { FAQ_DETAIL_ENRICHMENT_VERSION, FAQ_LEGACY_REPLACEMENT_VERSION, FAQ_PUBLISH_MODE } from './faq-detail-enrichment.mjs';
import { buildAdvanceCommand, inspectFaqOperatorStatus, parseArgs, publicationVerified } from './run-faq-operator.mjs';

const run = promisify(execFile);
const OPERATOR_SCRIPT = resolve(fileURLToPath(import.meta.url), '..', 'run-faq-operator.mjs');

async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

const zeroAiReceipt = (period) => ({
  mode: 'AI_REVIEWED', period, analysisVersion: FAQ_ANALYSIS_VERSION,
  aiReviewVersion: FAQ_AI_REVIEW_VERSION, aiPromptVersion: FAQ_AI_PROMPT_VERSION,
  taskCount: 0, resultCount: 0, autoAccepted: 0, needsHumanReview: 0, batchFailures: [],
});
const labels = FAQ_LABEL_CATALOG.map(({ label }) => label);
const summaryReceipt = (period) => ({
  mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION,
  summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION,
  painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION,
  operatorContentVersion: FAQ_OPERATOR_CONTENT_VERSION,
  source: { operatorXlsx: { path: 'operator.xlsx', sha256: 'a'.repeat(64) } },
  weekly: { path: 'weekly-summary.json', rows: 21, labels }, cumulative: { path: 'cumulative-summary.json', rows: 21, labels },
});
const aiReceipt = (period, needsHumanReview = 0) => ({
  mode: 'AI_REVIEWED', period, analysisVersion: FAQ_ANALYSIS_VERSION,
  aiReviewVersion: FAQ_AI_REVIEW_VERSION, aiPromptVersion: FAQ_AI_PROMPT_VERSION,
  taskCount: 10, resultCount: 10, autoAccepted: 10 - needsHumanReview, needsHumanReview,
  batchFailures: [],
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
  await json(join(analysis, 'ai-review', 'ai-review-receipt.json'), aiReceipt(period));
  await json(join(analysis, 'final-classification-receipt.json'), { mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: FAQ_ANALYSIS_VERSION, publishable: true, humanQueueCount: 0 });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.localAnalysisVerified, true);
  assert.equal(status.localSummariesBuilt, true);
  assert.equal(status.aiReviewComplete, true);
  assert.equal(status.humanReviewComplete, true);
  assert.equal(status.aiReviewTaskCount, 10);
  assert.equal(status.nextAction, 'PUBLISH_FEISHU_SUMMARIES');
});

test('zero-record period with built summaries reaches DONE without publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-zero-records-'));
  const period = '2026-08-30_2026-09-05';
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  await json(join(collection, 'top5-manifest.json'), { period, products: [], outcome: 'NO_QUALIFIED_CANDIDATES' });
  await json(join(collection, 'raw-snapshot-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 0, snapshot: { format: 'jsonl' } });
  await json(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 0 });
  await json(join(analysis, 'aggregate-receipt.json'), summaryReceipt(period));
  await json(join(analysis, 'ai-review', 'ai-review-receipt.json'), zeroAiReceipt(period));
  await json(join(analysis, 'final-classification-receipt.json'), { mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: FAQ_ANALYSIS_VERSION, publishable: true, humanQueueCount: 0 });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.top5Count, 0);
  assert.equal(status.rawRecords, 0);
  assert.equal(status.localSummariesBuilt, true);
  assert.equal(status.status, 'DONE');
  assert.equal(status.nextAction, 'DONE');
});

test('zero-record period without built summaries stays before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-zero-nosummary-'));
  const period = '2026-08-30_2026-09-05';
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  await json(join(collection, 'top5-manifest.json'), { period, products: [], outcome: 'NO_QUALIFIED_CANDIDATES' });
  await json(join(collection, 'raw-snapshot-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 0, snapshot: { format: 'jsonl' } });
  await json(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 0 });
  await json(join(analysis, 'ai-review', 'ai-review-receipt.json'), zeroAiReceipt(period));
  await json(join(analysis, 'final-classification-receipt.json'), { mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: FAQ_ANALYSIS_VERSION, publishable: true, humanQueueCount: 0 });
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.rawRecords, 0);
  assert.equal(status.localSummariesBuilt, false);
  assert.equal(status.status, 'IN_PROGRESS');
  assert.equal(status.nextAction, 'BUILD_LOCAL_SUMMARIES');
});

test('completed AI review with a non-empty human queue blocks publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-human-review-'));
  const period = '2026-08-23_2026-08-29';
  const collection = join(root, 'question-library-collection', period);
  const analysis = join(root, 'faq-analysis', period);
  const products = Array.from({ length: 5 }, (_, index) => ({ productId: String(index + 1) }));
  await json(join(collection, 'top5-manifest.json'), { period, products });
  for (const product of products) {
    const directory = join(collection, product.productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'qa.csv'), '问题,回答\\n', 'utf8');
    await writeFile(join(directory, 'reviews.csv'), '评论内容\\n有效评论\\n', 'utf8');
    await writeFile(join(directory, 'reviews-source.zip'), 'PK', 'utf8');
    await json(join(directory, 'qa-receipt.json'), { productId: product.productId, status: 'EMPTY_SOURCE_ROWS' });
    await json(join(directory, 'reviews-receipt.json'), { productId: product.productId, status: 'COMPLETED' });
  }
  await json(join(collection, 'raw-snapshot-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, sourceRecords: 5, snapshot: { format: 'jsonl' } });
  await json(join(analysis, 'classification-receipt.json'), { mode: 'APPLIED_AND_VERIFIED', period, analysisVersion: FAQ_ANALYSIS_VERSION, classifiedRecords: 5 });
  await json(join(analysis, 'aggregate-receipt.json'), summaryReceipt(period));
  await json(join(analysis, 'ai-review', 'ai-review-receipt.json'), aiReceipt(period, 3));
  const status = await inspectFaqOperatorStatus({ runtimeRoot: root, period });
  assert.equal(status.aiReviewComplete, true);
  assert.equal(status.humanReviewComplete, false);
  assert.equal(status.aiReviewAutoAccepted, 7);
  assert.equal(status.aiReviewNeedsHumanReview, 3);
  assert.equal(status.aiReviewProviderFailures, 0);
  assert.equal(status.nextAction, 'REVIEW_AI_HUMAN_QUEUE');
});

test('advance command emits a publish dry-run that never writes by itself', () => {
  const common = { periodStart: '2026-08-23', periodEnd: '2026-08-29', baseUrl: 'https://tenant.feishu.cn/base/appToken', envFile: 'D:/secret.env', runtimeRoot: 'D:/runtime', operatorXlsx: 'D:/operator.xlsx' };
  assert.deepEqual(buildAdvanceCommand('ANALYZE_LOCAL', common), {
    script: 'runtime/run-faq-text-analysis.mjs',
    args: ['--runtime-root', common.runtimeRoot, '--period-start', common.periodStart, '--period-end', common.periodEnd],
  });
  // 发布不再强制要求两个表 id：总表默认取 feishu-targets.mjs，周表按 `问题库_<周期>`
  // 名字发现、缺失时补建。显式传入时原样透传，由发布脚本 fail-closed 校验。
  const publish = buildAdvanceCommand('PUBLISH_FEISHU_SUMMARIES', common);
  assert.equal(publish.script, 'runtime/publish-faq-detail-enrichment.mjs');
  assert.equal(publish.args.includes('--master-table-id'), false);
  assert.equal(publish.args.includes('--weekly-table-id'), false);
  assert.equal(publish.args.includes('--phase'), true);
  assert.equal(publish.args.includes('publish'), true);
  assert.equal(publish.args.includes('--apply'), false);
  assert.equal(publish.args.includes('--confirm-app-token'), false);
  const pinned = buildAdvanceCommand('PUBLISH_FEISHU_SUMMARIES', { ...common, masterTableId: 'tbl-master', weeklyTableId: 'tbl-weekly' });
  assert.equal(pinned.args.includes('--master-table-id'), true);
  assert.equal(pinned.args.includes('--weekly-table-id'), true);
  assert.throws(() => buildAdvanceCommand('PUBLISH_FEISHU_SUMMARIES', { ...common, operatorXlsx: undefined }), /requires --operator-xlsx/u);
  assert.equal(buildAdvanceCommand('COLLECT_EVIDENCE', common), null);
});

test('publication verification accepts the append-only receipt and still rejects legacy shapes', () => {
  const period = '2026-09-13_2026-09-19';
  const appended = {
    mode: FAQ_PUBLISH_MODE, period,
    version: FAQ_DETAIL_ENRICHMENT_VERSION, analysisVersion: FAQ_ANALYSIS_VERSION,
    master: {
      tableId: 'tbl-master', name: '问题主库',
      recordsBefore: 2023, recordsAfter: 2073, appended: 50, overlap: 0, conflicts: 0,
      appendsHash: 'appends-hash', appendedRecordIds: Array.from({ length: 50 }, (_value, index) => `rec-${index}`), deletes: 0,
    },
    weekly: { tableId: 'tbl-weekly', name: `问题库_${period}`, created: true, rows: 50, rowsHash: 'weekly-hash', previousRows: 0, planning: 'CREATE_THEN_WRITE' },
    backup: { path: 'D:/runtime/faq-analysis/x/detail-append-backup.json', sha256: 'backup-hash' },
    sourceTopicHash: 'source-topic-hash', schemaHash: 'schema-hash', denominator: 26, statisticsHash: 'statistics-hash',
  };
  assert.equal(publicationVerified(appended, period), true);
  // 「总表只新增」必须被验收咬住：行数对不上、或声称删过行，都不算发布成功
  assert.equal(publicationVerified({ ...appended, master: { ...appended.master, recordsAfter: 2024 } }, period), false);
  assert.equal(publicationVerified({ ...appended, master: { ...appended.master, deletes: 1 } }, period), false);
  assert.equal(publicationVerified({ ...appended, master: { ...appended.master, appendedRecordIds: [] } }, period), false);
  assert.equal(publicationVerified({ ...appended, weekly: { ...appended.weekly, rowsHash: '' } }, period), false);
  assert.equal(publicationVerified({ ...appended, backup: {} }, period), false);

  // 版本号是按模式各自的：现役收据不许挂退役线的版本号，反之亦然。
  // 2026-08-23 那期线上 base 是按整体替换发的，它的收据必须继续被判成「已发布」。
  assert.equal(publicationVerified({ ...appended, version: FAQ_LEGACY_REPLACEMENT_VERSION }, period), false);
  assert.equal(FAQ_LEGACY_REPLACEMENT_VERSION === FAQ_DETAIL_ENRICHMENT_VERSION, false);

  // 历史整体替换收据仍可读（避免旧周期被误判成未发布），但缺少必要哈希时照样拒绝
  const legacy = {
    mode: 'REPLACEMENT_APPLIED_AND_VERIFIED', period,
    version: FAQ_LEGACY_REPLACEMENT_VERSION, analysisVersion: FAQ_ANALYSIS_VERSION,
    oldTables: { master: { tableId: 'old-master' }, weekly: { tableId: 'old-weekly' } },
    newTables: {
      master: { name: '问题主库', rows: 2703, rowsHash: 'master-hash', denominator: 1007, statisticsHash: 'statistics-hash' },
      weekly: { name: `问题库_${period}`, rows: 2688, rowsHash: 'weekly-hash', denominator: 1007, statisticsHash: 'statistics-hash' },
    },
    deletedOldTableIds: ['old-master', 'old-weekly'],
    candidateReceipt: { sha256: 'candidate-hash' },
    backup: { sha256: 'backup-hash' },
    sourceTopicHash: 'source-topic-hash', schemaHash: 'schema-hash', denominator: 1007, statisticsHash: 'statistics-hash',
  };
  assert.equal(publicationVerified(legacy, period), true);
  assert.equal(publicationVerified({ ...legacy, version: FAQ_DETAIL_ENRICHMENT_VERSION }, period), false);
  assert.equal(publicationVerified({ ...legacy, mode: 'APPLIED_AND_VERIFIED' }, period), false);
  assert.equal(publicationVerified({ ...legacy, statisticsHash: '' }, period), false);
  assert.equal(publicationVerified({ ...legacy, denominator: 2703 }, period), false);
  assert.equal(publicationVerified({ ...legacy, deletedOldTableIds: ['old-master'] }, period), false);
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
  await json(join(analysis, 'ai-review', 'ai-review-receipt.json'), aiReceipt(period));
  await json(join(analysis, 'final-classification-receipt.json'), { mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: FAQ_ANALYSIS_VERSION, publishable: true, humanQueueCount: 0 });
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

// --no-persist 是给「看一眼」的调用方用的（调度器轮询、测试）。
// 为什么必须成对拒绝 --advance：推进阶段却不落收据 = 真动了数据又不留证据。
test('--no-persist is opt-in and pairing it with --advance is refused outright', () => {
  const base = ['--period-start', '2026-08-23', '--period-end', '2026-08-29'];
  assert.equal(parseArgs(base).persist, true, '默认必须落盘：运营台靠它显示「上次检查」');
  assert.equal(parseArgs([...base, '--no-persist']).persist, false);
  assert.throws(() => parseArgs([...base, '--no-persist', '--advance']), /--no-persist cannot be combined with --advance/u);
  assert.throws(() => parseArgs([...base, '--advance', '--no-persist']), /--no-persist cannot be combined with --advance/u);
});

// --replace-current 曾经在这里被解析，但解析后没有任何下游读取：运营以为替换了，其实什么都没发生。
// 现役发布线是明细线（总表只追加、周表覆盖用 --replace-weekly），所以这个开关已从参数表删除。
// 这条断言把它钉住：再有人「顺手加回来」会立刻红。
test('--replace-current is gone: it is rejected as an unknown argument, not silently accepted', () => {
  const base = ['--period-start', '2026-08-23', '--period-end', '2026-08-29'];
  assert.throws(() => parseArgs([...base, '--replace-current']), /Unknown argument: --replace-current/u);
  assert.equal(Object.hasOwn(parseArgs(base), 'replaceCurrent'), false, '选项对象里不许再有 replaceCurrent 这个死字段');
});

test('the CLI writes operator-status.json by default and skips it under --no-persist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-operator-persist-'));
  const period = '2026-08-23_2026-08-29';
  const statusPath = join(root, 'faq-analysis', period, 'operator-status.json');
  const args = ['--status', '--period-start', '2026-08-23', '--period-end', '2026-08-29', '--runtime-root', root];
  const readOnly = await run(process.execPath, [OPERATOR_SCRIPT, ...args, '--no-persist']);
  assert.equal(JSON.parse(readOnly.stdout).nextAction, 'LOCK_TOP5', '空根目录只能判到第一阶段');
  await assert.rejects(() => stat(statusPath), /ENOENT/u, '只读探测不许落盘');

  await run(process.execPath, [OPERATOR_SCRIPT, ...args]);
  const info = await stat(statusPath);
  assert.ok(info.size > 0, '默认仍然要落盘，运营台的「上次检查」靠它');
});
