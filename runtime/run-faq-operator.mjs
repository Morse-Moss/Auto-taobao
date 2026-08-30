#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from './faq-local-summary.mjs';
import { FAQ_SCHEMA_VERSION } from './faq-topic-summary.mjs';
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

function publicationVerified(receipt, period) {
  return verified(receipt, period)
    && receipt.version === 'faq-detail-enrichment-v1.0.0'
    && receipt.master?.name === '问题主库'
    && receipt.weekly?.name === `问题库_${period}`
    && receipt.master?.records === 1692
    && receipt.weekly?.records === 1692
    && receipt.master?.updates >= 0
    && receipt.weekly?.updates >= 0
    && Number(receipt.feishuWrites) >= 0;
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
  return { completedProducts, evidenceComplete: products.length === 5 && completedProducts === 5, blocker };
}

export async function inspectFaqOperatorStatus({ runtimeRoot = 'runtime', period }) {
  const collectionDir = resolve(runtimeRoot, 'question-library-collection', period);
  const analysisDir = resolve(runtimeRoot, 'faq-analysis', period);
  const manifest = await readJson(resolve(collectionDir, 'top5-manifest.json'));
  const products = Array.isArray(manifest?.products) ? manifest.products : [];
  const manifestLocked = manifest?.period === period && products.length === 5
    && products.every((product) => String(product?.productId ?? '').trim());
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
    localSummariesBuilt: summaryVerified,
    summariesPublished,
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
    localSummariesBuilt: summaryVerified,
    summariesPublished,
    rawRecords: Number(rawReceipt?.sourceRecords ?? 0),
    topicRecords: Number(summaryReceipt?.weekly?.rows ?? 0),
    operatorRecords: Number(publishReceipt?.master?.records ?? 0),
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

export function buildAdvanceCommand(action, options) {
  const confirm = ['--confirm-app-token', appToken(options.baseUrl)];
  if (action === 'COLLECT_EVIDENCE') return null;
  if (action === 'LOCK_TOP5') return { script: 'runtime/run-question-library-collection.mjs', args: collectionArgs(options) };
  if (action === 'BUILD_LOCAL_SNAPSHOT') return {
    script: 'runtime/run-question-library-collection.mjs',
    args: [...collectionArgs(options), '--evidence-root', resolve(options.runtimeRoot ?? 'runtime', 'question-library-collection', `${options.periodStart}_${options.periodEnd}`), '--output-dir', resolve(options.runtimeRoot ?? 'runtime', 'question-library-collection', `${options.periodStart}_${options.periodEnd}`), '--apply', ...confirm],
  };
  if (action === 'ANALYZE_LOCAL') return { script: 'runtime/run-faq-text-analysis.mjs', args: localArgs(options) };
  if (action === 'BUILD_LOCAL_SUMMARIES') return { script: 'runtime/run-faq-topic-summary.mjs', args: summaryArgs(options) };
  if (action === 'PUBLISH_FEISHU_SUMMARIES') {
    if (!options.masterTableId || !options.weeklyTableId) throw new Error('publishing FAQ detail enrichment requires --master-table-id and --weekly-table-id');
    if (!options.operatorXlsx) throw new Error('publishing FAQ detail enrichment requires --operator-xlsx');
    return {
      script: 'runtime/publish-faq-detail-enrichment.mjs',
      args: [...periodArgs(options), '--operator-xlsx', options.operatorXlsx, '--base-url', options.baseUrl, '--env-file', options.envFile, '--master-table-id', options.masterTableId, '--weekly-table-id', options.weeklyTableId, '--apply', ...confirm],
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
  const command = buildAdvanceCommand(status.nextAction, options);
  if (!command) {
    console.log(JSON.stringify({ ...status, mode: 'BROWSER_ACTION_REQUIRED', message: '按 xws-faq-operator Skill 从首个未完成商品继续采集；不得伪造完成状态。' }, null, 2));
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
