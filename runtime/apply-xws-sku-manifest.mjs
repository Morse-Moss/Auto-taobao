#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

import {
  assertFreshPlanMatchesManifest,
  assertPostWritePlan,
  buildSkuBatchCreateRequest,
} from './apply-xws-sku-manifest-core.mjs';
import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';

const RUNTIME_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const COLLECTION_DIRECTORY = resolve(RUNTIME_DIRECTORY, 'competitor-v2-sku-collection');
const DRY_RUN_SCRIPT = resolve(RUNTIME_DIRECTORY, 'run-xws-sku-dry-run.mjs');
const PROFILE = activeProfileName();
const TARGET = {
  appToken: competitorBaseToken(PROFILE),
  mainTableId: tableId('competitorMain', PROFILE),
  mainTableName: '竞品主表',
  skuTableId: tableId('skuDetail', PROFILE),
  skuTableName: 'SKU明细',
};

const RECOVERABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function errorStatus(error) {
  const direct = [error?.status, error?.statusCode, error?.response?.status]
    .map((value) => Number(value))
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  if (direct !== undefined) return direct;
  const match = String(error?.message ?? '').match(/\b([45]\d{2})\b/u);
  return match ? Number(match[1]) : undefined;
}

export function isRecoverableWriteError(error) {
  const status = errorStatus(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (status !== undefined && status >= 500) return true;

  const code = String(error?.code ?? '').trim().toUpperCase();
  if (RECOVERABLE_NETWORK_CODES.has(code) || error?.name === 'AbortError') return true;

  const message = String(error?.message ?? '');
  if (/\b(?:connection reset|fetch failed|network|socket hang up|timed?\s*out|timeout)\b/iu.test(message)
    && !/\b(?:authentication|blocked|forbidden|invalid|permission|unauthorized)\b/iu.test(message)) {
    return true;
  }
  return false;
}

function parseEnv(value) {
  const output = {};
  for (const rawLine of String(value).split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let entry = line.slice(separator + 1).trim();
    if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) {
      entry = entry.slice(1, -1);
    }
    output[key] = entry;
  }
  return output;
}

function positiveInteger(value, option) {
  if (!/^\d+$/u.test(String(value)) || Number(value) < 1) {
    throw new Error(option + ' must be a positive integer');
  }
  return Number(value);
}

export function parseApplyArgs(argv) {
  const options = {
    apply: false,
  };
  const valueOptions = new Map([
    ['--manifest', 'manifest'],
    ['--env-file', 'envFile'],
    ['--confirm-app-token', 'confirmAppToken'],
    ['--confirm-sku-table-id', 'confirmSkuTableId'],
    ['--confirm-record-count', 'confirmRecordCount'],
    ['--output-directory', 'outputDirectory'],
    ['--payload-file', 'payloadFile'],
    ['--capture-receipt', 'captureReceipt'],
    ['--topology-file', 'topologyFile'],
    ['--topology-receipt', 'topologyReceipt'],
  ]);
  const evidenceArguments = new Set([
    '--payload-file', '--capture-receipt', '--topology-file', '--topology-receipt',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error('Unknown or blocked argument: ' + argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    options[key] = argument === '--confirm-record-count'
      ? positiveInteger(value, argument)
      : value;
    index += 1;
  }
  if (!options.apply) throw new Error('--apply is required for the guarded SKU write');
  for (const option of [
    'manifest', 'envFile', 'confirmAppToken', 'confirmSkuTableId', 'confirmRecordCount', 'outputDirectory',
  ]) {
    if (options[option] == null || options[option] === '') {
      throw new Error('--' + option.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase()) + ' is required');
    }
  }
  if (options.confirmAppToken !== TARGET.appToken) throw new Error('--confirm-app-token mismatch');
  if (options.confirmSkuTableId !== TARGET.skuTableId) throw new Error('--confirm-sku-table-id mismatch');
  for (const argument of evidenceArguments) {
    const key = valueOptions.get(argument);
    if (!options[key]) {
      throw new Error(argument.slice(2) + ' is required for every guarded apply');
    }
  }
  return options;
}

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(name + ' is not valid JSON');
  }
}

async function readManifest(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) throw new Error('SKU manifest is unavailable');
  const text = await readFile(absolutePath, 'utf8');
  return { path: absolutePath, text, sha256: sha256(text), manifest: parseJson(text, 'SKU manifest') };
}

export function runNode(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        const error = new Error('Fresh SKU dry-run failed before a record write');
        error.retryable = isRecoverableWriteError(new Error(stderr));
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function evidenceArgs(options) {
  return [
    '--payload-file', options.payloadFile,
    '--capture-receipt', options.captureReceipt,
    '--topology-file', options.topologyFile,
    '--topology-receipt', options.topologyReceipt,
    '--output-directory', options.outputDirectory,
  ];
}

async function runFreshDryRun(options) {
  const result = await runNode([
    DRY_RUN_SCRIPT,
    ...evidenceArgs(options),
    '--env-file', options.envFile,
  ]);
  const receipt = parseJson(result.stdout, 'Fresh SKU dry-run receipt');
  if (receipt.mode !== 'DRY_RUN_READY' || Number(receipt?.plan?.toCreate) !== options.confirmRecordCount
    || Number(receipt?.plan?.conflict) !== 0 || Number(receipt?.plan?.duplicateExistingKeys) !== 0) {
    throw new Error('Fresh SKU dry-run no longer matches the authorized write plan');
  }
  const freshManifest = await readManifest(receipt.manifestPath);
  return { receipt, freshManifest };
}

async function readClient(envFile) {
  const absoluteEnvFile = resolve(envFile);
  if (!existsSync(absoluteEnvFile)) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(absoluteEnvFile, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials are unavailable');
  const client = new CompetitorV2FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: TARGET.appToken,
  });
  await client.authenticate();
  return client;
}

function recordIdsFromWriteResponse(data, expectedRecordCount) {
  const ids = (data?.records ?? []).map((record) => String(record?.record_id ?? '').trim()).filter(Boolean);
  if (ids.length !== expectedRecordCount || new Set(ids).size !== ids.length) {
    throw new Error('Feishu did not confirm creation of the authorized record count');
  }
  return ids;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function verifyPostWrite(options, beforeSkuRecordCount) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const fresh = await runFreshDryRunAfterWrite(options);
      const verification = classifyPostWriteVerification({
        fresh,
        expectedRecordCount: options.confirmRecordCount,
        beforeSkuRecordCount,
      });
      if (!verification.ok) {
        const error = new Error('Post-write SKU verification failed: ' + verification.reason);
        error.retryable = verification.retryable;
        throw error;
      }
      return fresh;
    } catch (error) {
      lastError = error;
      if (!isRetryablePostWriteVerificationError(error) || attempt >= 9) break;
      await wait(750);
    }
  }
  throw lastError ?? new Error('Post-write SKU verification did not settle');
}

async function runFreshDryRunAfterWrite(options) {
  const result = await runNode([
    DRY_RUN_SCRIPT,
    ...evidenceArgs(options),
    '--env-file', options.envFile,
  ]);
  const receipt = parseJson(result.stdout, 'Post-write SKU dry-run receipt');
  const freshManifest = await readManifest(receipt.manifestPath);
  return { receipt, freshManifest };
}

export function classifyPostWriteVerification({ fresh, expectedRecordCount, beforeSkuRecordCount }) {
  const plan = fresh?.freshManifest?.manifest?.plan;
  const summary = plan?.summary;
  if (!summary || !Array.isArray(plan?.items)) {
    return { ok: false, retryable: false, reason: 'invalid-plan' };
  }
  if (Number(summary.conflict) > 0 || Number(summary.duplicateExistingKeys) > 0) {
    return { ok: false, retryable: false, reason: 'contract-conflict' };
  }
  const numericSummaryKeys = ['parsedRows', 'toCreate', 'alreadyPresent', 'conflict', 'duplicateExistingKeys'];
  if (numericSummaryKeys.some((key) => !Number.isInteger(Number(summary[key])) || Number(summary[key]) < 0)) {
    return { ok: false, retryable: false, reason: 'invalid-plan' };
  }
  if (Number(summary.parsedRows) !== expectedRecordCount) {
    return { ok: false, retryable: false, reason: 'source-changed' };
  }
  if (Number(summary.alreadyPresent) > expectedRecordCount) {
    return { ok: false, retryable: false, reason: 'unexpected-extra-records' };
  }
  if (Number(summary.toCreate) !== 0 || Number(summary.alreadyPresent) !== expectedRecordCount) {
    return { ok: false, retryable: true, reason: 'not-converged' };
  }
  if (Number(fresh?.receipt?.verification?.skuRecordCount) !== beforeSkuRecordCount + expectedRecordCount) {
    return { ok: false, retryable: true, reason: 'record-count-not-settled' };
  }
  try {
    assertPostWritePlan(plan, { expectedRecordCount });
  } catch {
    return { ok: false, retryable: false, reason: 'post-write-contract' };
  }
  return { ok: true, retryable: false, reason: 'verified' };
}

export function isRetryablePostWriteVerificationError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  return isRecoverableWriteError(error);
}

export function buildApplyReceipt({
  manifestPath,
  manifestSha256,
  createdRecordIds,
  beforeSkuRecordCount,
  afterSkuRecordCount,
  verifiedPlan,
  expectedRecordCount,
  writeOutcome = 'api-confirmed',
}) {
  const items = verifiedPlan?.items ?? [];
  const verifiedRecordCount = items.filter((item) => item.action === 'alreadyPresent' && item.recordId).length;
  const apiConfirmedRecordCount = createdRecordIds.length;
  return {
    mode: 'APPLIED_AND_VERIFIED',
    target: TARGET,
    authorization: { recordCount: expectedRecordCount },
    manifest: { path: manifestPath, sha256: manifestSha256 },
    write: {
      outcome: writeOutcome,
      apiConfirmedRecordCount,
      verifiedRecordCount,
      // Kept as a compatibility alias; it means API-confirmed records only.
      createdRecordCount: apiConfirmedRecordCount,
      beforeSkuRecordCount,
      afterSkuRecordCount,
    },
    verification: {
      verifiedUniqueKeys: items.filter((item) => item.action === 'alreadyPresent' && item.recordId).length,
      verifiedRelations: items.filter((item) => item.action === 'alreadyPresent' && item.recordId).length,
      verifiedSpaceDecisions: items.filter((item) => item.action === 'alreadyPresent' && item.recordId).length,
    },
  };
}

async function persistReceipt(receipt, outputDirectory) {
  const runId = new Date().toISOString().replace(/[-:.]/gu, '') + '-' + randomUUID();
  const path = resolve(outputDirectory, 'xws-sku-apply-receipt-' + runId + '.json');
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return path;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseApplyArgs(argv);
  const approved = await readManifest(options.manifest);
  buildSkuBatchCreateRequest(approved.manifest, { target: TARGET, expectedRecordCount: options.confirmRecordCount });

  const fresh = await runFreshDryRun(options);
  assertFreshPlanMatchesManifest(approved.manifest, fresh.freshManifest.manifest.plan, {
    expectedRecordCount: options.confirmRecordCount,
  });
  const request = buildSkuBatchCreateRequest(fresh.freshManifest.manifest, {
    target: TARGET,
    expectedRecordCount: options.confirmRecordCount,
  });

  const client = await readClient(options.envFile);
  let createdRecordIds = [];
  let writeOutcome = 'api-confirmed';
  try {
    createdRecordIds = recordIdsFromWriteResponse(
      await client.request(request.method, request.path, request.body),
      options.confirmRecordCount,
    );
  } catch (error) {
    if (!isRecoverableWriteError(error)) throw error;
    writeOutcome = 'readback-recovered';
  }

  const verified = await verifyPostWrite(options, Number(fresh.receipt.verification.skuRecordCount));
  const receipt = buildApplyReceipt({
    manifestPath: approved.path,
    manifestSha256: approved.sha256,
    createdRecordIds,
    beforeSkuRecordCount: Number(fresh.receipt.verification.skuRecordCount),
    afterSkuRecordCount: Number(verified.receipt.verification.skuRecordCount),
    verifiedPlan: verified.freshManifest.manifest.plan,
    expectedRecordCount: options.confirmRecordCount,
    writeOutcome,
  });
  const receiptPath = await persistReceipt(receipt, options.outputDirectory);
  const batchIndexPath = await updateSkuBatchIndex({
    directory: options.outputDirectory,
    source: {
      mainRecordId: verified.freshManifest.manifest.source?.mainRecordId,
      productId: verified.freshManifest.manifest.source?.productId,
      productUrl: verified.freshManifest.manifest.source?.productUrl,
      classification: verified.freshManifest.manifest.source?.competitorClass,
    },
    artifacts: {
      manifest: approved.path,
      applyReceipt: receiptPath,
      finalDryRunReceipt: verified.receipt.receiptPath,
    },
    status: 'APPLIED_AND_VERIFIED',
  });
  receipt.batchIndexPath = batchIndexPath;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8' });
  console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
  return { ...receipt, receiptPath };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
