#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

function publicationVerified(receipt, period) {
  if (receipt?.mode !== 'APPLIED_AND_VERIFIED' || Number(receipt?.targetRecords) < 1) return false;
  if (receipt.period) return receipt.period === period;
  return receipt.source?.name === `问题库分析_${period}`
    && receipt.summary?.name === `问题主题汇总_${period}`;
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
    readJson(resolve(collectionDir, 'apply-receipt.json')),
    readJson(resolve(analysisDir, 'apply-receipt.json')),
    readJson(resolve(analysisDir, 'topic-summary-apply-receipt.json')),
    readJson(resolve(analysisDir, 'template-sync-receipt.json')),
  ]);
  const rawImported = verified(rawReceipt, period);
  const summaryVerified = verified(summaryReceipt, period);
  const analysisVerified = verified(analysisReceipt, period)
    || (summaryVerified && Number(summaryReceipt.detailRecords) > 0);
  const operatorPublished = publicationVerified(publishReceipt, period);
  const state = determineFaqOperatorState({
    blocker: evidence.blocker,
    manifestLocked,
    evidenceComplete: evidence.evidenceComplete,
    rawImported,
    analysisVerified,
    summaryVerified,
    operatorPublished,
  });
  return {
    period,
    ...state,
    top5Count: products.length,
    completedProducts: evidence.completedProducts,
    manifestLocked,
    evidenceComplete: evidence.evidenceComplete,
    rawImported,
    analysisVerified,
    summaryVerified,
    operatorPublished,
    rawRecords: Number(rawReceipt?.tableRecordCount ?? summaryReceipt?.detailRecords ?? 0),
    topicRecords: Number(summaryReceipt?.topicRecords ?? 0),
    operatorRecords: Number(publishReceipt?.targetRecords ?? 0),
  };
}

function commonArgs(options) {
  return [
    '--base-url', options.baseUrl,
    '--env-file', options.envFile,
    '--period-start', options.periodStart,
    '--period-end', options.periodEnd,
  ];
}

function appToken(baseUrl) {
  const token = String(baseUrl).match(/\/base\/([^?/#]+)/u)?.[1];
  if (!token) throw new Error('baseUrl must contain /base/<app-token>');
  return token;
}

export function buildAdvanceCommand(action, options) {
  const args = commonArgs(options);
  const confirm = ['--confirm-app-token', appToken(options.baseUrl)];
  if (action === 'COLLECT_EVIDENCE') return null;
  if (action === 'LOCK_TOP5') return { script: 'runtime/run-question-library-collection.mjs', args };
  if (action === 'IMPORT_RAW') return {
    script: 'runtime/run-question-library-collection.mjs',
    args: [...args, '--evidence-root', resolve(options.runtimeRoot ?? 'runtime', 'question-library-collection', `${options.periodStart}_${options.periodEnd}`), '--apply', ...confirm],
  };
  if (action === 'ANALYZE') return { script: 'runtime/run-faq-text-analysis.mjs', args: [...args, '--apply', ...confirm] };
  if (action === 'SUMMARIZE') return { script: 'runtime/run-faq-topic-summary.mjs', args: [...args, '--apply', ...confirm] };
  if (action === 'PUBLISH_OPERATOR_TABLE') {
    if (!options.replaceCurrent) throw new Error('publishing the operator table requires explicit replacement intent');
    return { script: 'runtime/sync-question-library-template.mjs', args: ['--env-file', options.envFile, '--period-start', options.periodStart, '--period-end', options.periodEnd, '--apply', '--replace-current', ...confirm] };
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
    else if (['--base-url', '--env-file', '--runtime-root', '--period-start', '--period-end'].includes(arg)) {
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
