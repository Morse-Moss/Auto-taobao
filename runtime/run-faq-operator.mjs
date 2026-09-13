#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FAQ_AI_PROMPT_VERSION, FAQ_AI_REVIEW_VERSION } from './faq-ai-review.mjs';
import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from './faq-local-summary.mjs';
import { FAQ_DETAIL_ENRICHMENT_VERSION } from './faq-detail-enrichment.mjs';
import { determineFaqOperatorState } from './faq-operator-core.mjs';

const DEFAULT_BASE_URL = 'https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf';
const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';

async function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

function verified(receipt, period) {
  return receipt?.mode === 'APPLIED_AND_VERIFIED' && receipt?.period === period;
}

function hasAllLabels(rows) {
  const expected = new Set(FAQ_LABEL_CATALOG.map(({ label }) => label));
  const labels = rows?.map((row) => row.分类标签);
  return Array.isArray(labels) && labels.length === expected.size && new Set(labels).size === expected.size && labels.every((label) => expected.has(label));
}

export function publicationVerified(receipt, period) {
  const oldIds = [receipt?.oldTables?.master?.tableId, receipt?.oldTables?.weekly?.tableId];
  const deletedIds = receipt?.deletedOldTableIds;
  return receipt?.mode === 'REPLACEMENT_APPLIED_AND_VERIFIED'
    && receipt.period === period
    && receipt.version === FAQ_DETAIL_ENRICHMENT_VERSION
    && receipt.analysisVersion === FAQ_ANALYSIS_VERSION
    && receipt.newTables?.master?.name === '问题主库'
    && receipt.newTables?.weekly?.name === `问题库_${period}`
    && Number.isInteger(receipt.newTables?.master?.rows)
    && receipt.newTables.master.rows >= 0
    && Number.isInteger(receipt.newTables?.weekly?.rows)
    && receipt.newTables.weekly.rows >= 0
    && Boolean(receipt.newTables.master.rowsHash)
    && Boolean(receipt.newTables.weekly.rowsHash)
    && Boolean(receipt.sourceTopicHash)
    && Boolean(receipt.schemaHash)
    && Number.isInteger(receipt.denominator)
    && receipt.denominator > 0
    && Boolean(receipt.statisticsHash)
    && receipt.newTables.master.denominator === receipt.denominator
    && receipt.newTables.weekly.denominator === receipt.denominator
    && receipt.newTables.master.statisticsHash === receipt.statisticsHash
    && receipt.newTables.weekly.statisticsHash === receipt.statisticsHash
    && Boolean(receipt.candidateReceipt?.sha256)
    && Boolean(receipt.backup?.sha256)
    && Array.isArray(deletedIds)
    && deletedIds.length === 2
    && oldIds.every((tableId) => tableId && deletedIds.includes(tableId));
}

async function inspectEvidence(collectionDir, products) {
  let completedProducts = 0;
  let blocker = null;
  for (const product of products) {
    const directory = resolve(collectionDir, String(product.productId));
    const [qa, reviews, alert] = await Promise.all([
      readJson(resolve(directory, 'qa-receipt.json')),
      readJson(resolve(directory, 'reviews-receipt.json')),
      readJson(resolve(directory, 'alert.json')),
    ]);
    const qaComplete = String(qa?.productId ?? product.productId) === String(product.productId)
      && ['COMPLETED', 'EMPTY_SOURCE_ROWS'].includes(qa?.status)
      && existsSync(resolve(directory, 'qa.csv'));
    let archiveValid = false;
    if (existsSync(resolve(directory, 'reviews-source.zip'))) {
      const archive = await readFile(resolve(directory, 'reviews-source.zip'));
      archiveValid = archive.length >= 2 && archive.subarray(0, 2).toString('ascii') === 'PK';
    }
    const reviewsComplete = String(reviews?.productId ?? product.productId) === String(product.productId)
      && reviews?.status === 'COMPLETED'
      && existsSync(resolve(directory, 'reviews.csv'))
      && archiveValid;
    const productComplete = qaComplete && reviewsComplete;
    if (productComplete) completedProducts += 1;
    const alertResolved = Boolean(alert?.resolvedAt || alert?.resolution)
      || ['RESOLVED', 'COMPLETED'].includes(String(alert?.status ?? alert?.state ?? '').toUpperCase());
    if (!productComplete && alert && !alertResolved && !blocker) {
      blocker = {
        code: alert.code ?? alert.status ?? alert.state ?? 'COLLECTION_BLOCKED',
        productId: String(alert.productId ?? product.productId),
        message: alert.message ?? alert.reason ?? '商品采集存在未解决告警',
      };
    }
  }
  // 运营口径：高质量竞品不是每周都有。0 个（本周无合格标的）或不足 5 个均视为已锁定，
  // 只按“实际清单全部采集完毕”判定，不再强求凑满 5 个。
  return { completedProducts, evidenceComplete: products.length <= 5 && completedProducts === products.length, blocker };
}

export async function inspectFaqOperatorStatus({ runtimeRoot = 'runtime', period }) {
  const collectionDir = resolve(runtimeRoot, 'question-library-collection', period);
  const analysisDir = resolve(runtimeRoot, 'faq-analysis', period);
  const manifest = await readJson(resolve(collectionDir, 'top5-manifest.json'));
  const products = Array.isArray(manifest?.products) ? manifest.products : [];
  const count = Array.isArray(products) ? products.length : -1;
  const outcome = String(manifest?.outcome ?? '').trim();
  // 允许 0 个（NO_QUALIFIED_CANDIDATES：本周无合格标的，按运营口径不采集）
  // 与不足 5 个（PARTIAL_CANDIDATES）；旧清单缺 outcome 字段时仍要求满 5 个。
  const manifestLocked = manifest?.period === period
    && count >= 0 && count <= 5
    && products.every((product) => String(product?.productId ?? '').trim())
    && (count === 5 || outcome === 'NO_QUALIFIED_CANDIDATES' || outcome === 'PARTIAL_CANDIDATES');
  const evidence = manifestLocked
    ? await inspectEvidence(collectionDir, products)
    : { completedProducts: 0, evidenceComplete: false };
  const [rawReceipt, analysisReceipt, summaryReceipt, publishReceipt] = await Promise.all([
    readJson(resolve(collectionDir, 'raw-snapshot-receipt.json')),
    readJson(resolve(analysisDir, 'classification-receipt.json')),
    readJson(resolve(analysisDir, 'aggregate-receipt.json')),
    readJson(resolve(analysisDir, 'detail-enrichment-receipt.json')),
  ]);
  const rawSnapshotBuilt = verified(rawReceipt, period) && rawReceipt.snapshot?.format === 'jsonl';
  const analysisVerified = verified(analysisReceipt, period)
    && analysisReceipt.analysisVersion === FAQ_ANALYSIS_VERSION
    && Number(analysisReceipt.classifiedRecords) >= 0;
  const aiReviewReceipt = await readJson(resolve(analysisDir, 'ai-review', 'ai-review-receipt.json'));
  const finalClassificationReceipt = await readJson(resolve(analysisDir, 'final-classification-receipt.json'));
  const aiReviewComplete = aiReviewReceipt?.period === period
    && aiReviewReceipt.analysisVersion === FAQ_ANALYSIS_VERSION
    && aiReviewReceipt.aiReviewVersion === FAQ_AI_REVIEW_VERSION
    && aiReviewReceipt.aiPromptVersion === FAQ_AI_PROMPT_VERSION
    && aiReviewReceipt.taskCount === aiReviewReceipt.resultCount
    && Number.isInteger(aiReviewReceipt.taskCount)
    && Number.isInteger(aiReviewReceipt.resultCount)
    && Number.isInteger(aiReviewReceipt.autoAccepted)
    && Number.isInteger(aiReviewReceipt.needsHumanReview)
    && aiReviewReceipt.autoAccepted + aiReviewReceipt.needsHumanReview === aiReviewReceipt.resultCount;
  const finalHumanQueueCount = Number.isInteger(finalClassificationReceipt?.humanQueueCount)
    ? finalClassificationReceipt.humanQueueCount
    : aiReviewReceipt?.needsHumanReview;
  const humanReviewComplete = aiReviewComplete
    && finalClassificationReceipt?.period === period
    && finalClassificationReceipt?.analysisVersion === FAQ_ANALYSIS_VERSION
    && finalClassificationReceipt?.mode === 'FINAL_CLASSIFICATION_READY'
    && finalClassificationReceipt?.publishable === true
    && finalHumanQueueCount === 0;
  const summaryVerified = Boolean(verified(summaryReceipt, period)
    && summaryReceipt.analysisVersion === FAQ_ANALYSIS_VERSION
    && summaryReceipt.dedupVersion === FAQ_DEDUP_VERSION
    && summaryReceipt.summaryVersion === FAQ_SUMMARY_VERSION
    && summaryReceipt.representativeSelectionVersion === FAQ_REPRESENTATIVE_SELECTION_VERSION
    && summaryReceipt.painDescriptionVersion === FAQ_PAIN_DESCRIPTION_VERSION
    && summaryReceipt.operatorContentVersion === FAQ_OPERATOR_CONTENT_VERSION
    && summaryReceipt.source?.operatorXlsx?.sha256
    && summaryReceipt.weekly?.path
    && summaryReceipt.cumulative?.path
    && summaryReceipt.weekly?.rows === 21
    && summaryReceipt.cumulative?.rows === 21
    && hasAllLabels((summaryReceipt.weekly?.labels ?? []).map((分类标签) => ({ 分类标签 })))
    && hasAllLabels((summaryReceipt.cumulative?.labels ?? []).map((分类标签) => ({ 分类标签 }))));
  const summariesPublished = publicationVerified(publishReceipt, period);
  const state = determineFaqOperatorState({
    blocker: evidence.blocker,
    manifestLocked,
    evidenceComplete: evidence.evidenceComplete,
    localSnapshotBuilt: rawSnapshotBuilt,
    localAnalysisVerified: analysisVerified,
    aiReviewComplete,
    humanReviewComplete,
    localSummariesBuilt: humanReviewComplete && summaryVerified,
    summariesPublished: humanReviewComplete && summaryVerified && summariesPublished,
    rawRecords: Number(rawReceipt?.sourceRecords ?? 0),
  });
  return {
    period,
    ...state,
    top5Count: products.length,
    completedProducts: evidence.completedProducts,
    manifestLocked,
    evidenceComplete: evidence.evidenceComplete,
    localSnapshotBuilt: rawSnapshotBuilt,
    localAnalysisVerified: analysisVerified,
    localSummariesBuilt: humanReviewComplete && summaryVerified,
    aiReviewComplete,
    humanReviewComplete,
    aiReviewTaskCount: Number(aiReviewReceipt?.taskCount ?? 0),
    aiReviewResultCount: Number(aiReviewReceipt?.resultCount ?? 0),
    aiReviewAutoAccepted: Number(aiReviewReceipt?.autoAccepted ?? 0),
    aiReviewNeedsHumanReview: finalHumanQueueCount ?? 0,
    aiReviewProviderFailures: Array.isArray(aiReviewReceipt?.batchFailures) ? aiReviewReceipt.batchFailures.length : 0,
    aiReviewBatchFailures: Array.isArray(aiReviewReceipt?.batchFailures) ? aiReviewReceipt.batchFailures : [],
    summariesPublished,
    rawRecords: Number(rawReceipt?.sourceRecords ?? 0),
    topicRecords: Number(summaryReceipt?.weekly?.rows ?? 0),
    operatorRecords: Number(publishReceipt?.newTables?.master?.rows ?? 0),
    summaryVersions: summaryVerified ? { analysisVersion: summaryReceipt.analysisVersion, dedupVersion: summaryReceipt.dedupVersion, summaryVersion: summaryReceipt.summaryVersion } : null,
    detailEnrichmentVersion: publishReceipt?.version ?? null,
  };
}

function periodArgs(options) {
  return ['--period-start', options.periodStart, '--period-end', options.periodEnd];
}

function collectionArgs(options) {
  return ['--base-url', options.baseUrl, '--env-file', options.envFile, ...periodArgs(options)];
}

function localArgs(options) {
  return ['--runtime-root', options.runtimeRoot, ...periodArgs(options)];
}

function summaryArgs(options) {
  if (!options.operatorXlsx) throw new Error('building FAQ summaries requires --operator-xlsx');
  return [...localArgs(options), '--operator-xlsx', options.operatorXlsx];
}

function appToken(baseUrl) {
  const token = String(baseUrl).match(/\/base\/([^?/#]+)/u)?.[1];
  if (!token) throw new Error('baseUrl must contain /base/<app-token>');
  return token;
}

export function buildAdvanceCommand(action, options, status = null) {
  const confirm = ['--confirm-app-token', appToken(options.baseUrl)];
  if (action === 'COLLECT_EVIDENCE') return null;
  if (action === 'LOCK_TOP5') return { script: 'runtime/run-question-library-collection.mjs', args: collectionArgs(options) };
  if (action === 'BUILD_LOCAL_SNAPSHOT') return {
    script: 'runtime/run-question-library-collection.mjs',
    args: [...collectionArgs(options), '--evidence-root', resolve(options.runtimeRoot ?? 'runtime', 'question-library-collection', `${options.periodStart}_${options.periodEnd}`), '--output-dir', resolve(options.runtimeRoot ?? 'runtime', 'question-library-collection', `${options.periodStart}_${options.periodEnd}`), '--apply', ...confirm],
  };
  if (action === 'ANALYZE_LOCAL') return { script: 'runtime/run-faq-text-analysis.mjs', args: localArgs(options) };
  if (action === 'RUN_AI_REVIEW') return { script: 'runtime/run-faq-ai-review.mjs', args: localArgs(options) };
  // 人工核验队列为空（本周无合格竞品）时无需人工介入，直接产出最终分类收据；
  // 只要还有待核验项就保持为人工步骤，不自动放行。
  if (action === 'REVIEW_AI_HUMAN_QUEUE') {
    return status?.aiReviewNeedsHumanReview === 0
      ? { script: 'runtime/run-faq-human-review.mjs', args: localArgs(options) }
      : null;
  }
  if (action === 'BUILD_LOCAL_SUMMARIES') return { script: 'runtime/run-faq-topic-summary.mjs', args: summaryArgs(options) };
  if (action === 'PUBLISH_FEISHU_SUMMARIES') {
    if (!options.masterTableId || !options.weeklyTableId) throw new Error('publishing FAQ detail replacement requires --master-table-id and --weekly-table-id');
    if (!options.operatorXlsx) throw new Error('publishing FAQ detail replacement requires --operator-xlsx');
    return {
      script: 'runtime/publish-faq-detail-enrichment.mjs',
      args: ['--phase', 'prepare', ...periodArgs(options), '--operator-xlsx', options.operatorXlsx, '--base-url', options.baseUrl, '--env-file', options.envFile, '--master-table-id', options.masterTableId, '--weekly-table-id', options.weeklyTableId],
    };
  }
  if (action === 'DONE') return null;
  throw new Error(`Unsupported FAQ action: ${action}`);
}

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, envFile: DEFAULT_ENV_FILE, runtimeRoot: 'runtime', advance: false, replaceCurrent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--advance') options.advance = true;
    else if (arg === '--status') options.advance = false;
    else if (arg === '--replace-current') options.replaceCurrent = true;
    else if (['--base-url', '--env-file', '--runtime-root', '--period-start', '--period-end', '--master-table-id', '--weekly-table-id', '--operator-xlsx'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const name of ['periodStart', 'periodEnd']) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name === 'periodStart' ? 'period-start' : 'period-end'} must be YYYY-MM-DD`);
  }
  options.period = `${options.periodStart}_${options.periodEnd}`;
  return options;
}

async function persistStatus(options, status) {
  const directory = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'operator-status.json'), `${JSON.stringify({ ...status, checkedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let status = await inspectFaqOperatorStatus(options);
  await persistStatus(options, status);
  if (!options.advance || status.nextAction === 'DONE') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const command = buildAdvanceCommand(status.nextAction, options, status);
  if (!command) {
    const message = status.nextAction === 'REVIEW_AI_HUMAN_QUEUE'
      ? '请先处理 human-review-queue.jsonl 中的人工核验项；队列清零前不会执行飞书发布。'
      : '按 xws-faq-operator Skill 从首个未完成商品继续采集；不得伪造完成状态。';
    console.log(JSON.stringify({ ...status, mode: 'ACTION_REQUIRED', message }, null, 2));
    return;
  }
  const result = spawnSync(process.execPath, [command.script, ...command.args], { cwd: resolve('.'), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `FAQ stage failed: ${status.nextAction}`);
  status = await inspectFaqOperatorStatus(options);
  await persistStatus(options, status);
  console.log(JSON.stringify({ advancedStage: command.script, status, output: result.stdout.trim() }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
