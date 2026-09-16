#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

import { buildSkuEvidence } from './build-xws-sku-dry-run-manifest.mjs';
import { buildSkuDryRunPlan } from './xws-sku-dry-run-core.mjs';
import { parseXwsSkuPayload } from './xws-sku-payload-parser.mjs';
import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';
import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const RUNTIME_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const COLLECTION_DIRECTORY = resolve(RUNTIME_DIRECTORY, 'competitor-v2-sku-collection');
const PARSER_PATH = resolve(RUNTIME_DIRECTORY, 'xws-sku-payload-parser.mjs');
const PROFILE = activeProfileName();
const DEFAULT_ENV_FILE = envFilePath(PROFILE);
const TARGET = {
  appToken: competitorBaseToken(PROFILE),
  mainTableId: tableId('competitorMain', PROFILE),
  mainTableName: '竞品主表',
  skuTableId: tableId('skuDetail', PROFILE),
  skuTableName: 'SKU明细',
};

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(name + ' is required');
  return normalized;
}

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(name + ' is not valid JSON');
  }
}

function displayText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(displayText).join('').trim();
  if (typeof value === 'object') return String(value.text ?? value.value ?? value.name ?? '').trim();
  return String(value).trim();
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

function parseArgs(argv) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
  };
  const valueOptions = new Map([
    ['--env-file', 'envFile'],
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
    const key = valueOptions.get(argument);
    if (!key) {
      throw new Error('Unknown or blocked argument: ' + argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    options[key] = value;
    index += 1;
  }
  for (const argument of evidenceArguments) {
    const key = valueOptions.get(argument);
    if (!options[key]) throw new Error(argument.slice(2) + ' is required for every SKU dry-run');
  }
  if (!options.outputDirectory) throw new Error('--output-directory is required for every SKU dry-run');
  return options;
}

export const parseDryRunArgs = parseArgs;

function assertTable(tables, tableId, name) {
  const matches = tables.filter((table) => table.tableId === tableId && table.name === name);
  if (matches.length !== 1) throw new Error('Authorized table mismatch: ' + tableId);
  return matches[0];
}

export function assertMainTableHasRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('竞品主表 must contain at least one main record');
  }
  return records;
}

function selectedRecord(records, recordId) {
  const matches = records.filter((record) => record.recordId === recordId);
  if (matches.length !== 1) throw new Error('Expected exactly one selected main record; received ' + matches.length);
  return matches[0];
}

async function readLocalEvidence(options) {
  const paths = {
    payload: resolve(options.payloadFile),
    captureReceipt: resolve(options.captureReceipt),
    topology: resolve(options.topologyFile),
    topologyReceipt: resolve(options.topologyReceipt),
  };
  for (const [name, filePath] of Object.entries(paths)) {
    if (!existsSync(filePath)) throw new Error(`SKU ${name} evidence file is unavailable: ${filePath}`);
  }
  const [rawPayload, captureText, topologyText, topologyReceiptText, parserText] = await Promise.all([
    readFile(paths.payload, 'utf8'),
    readFile(paths.captureReceipt, 'utf8'),
    readFile(paths.topology, 'utf8'),
    readFile(paths.topologyReceipt, 'utf8'),
    readFile(PARSER_PATH, 'utf8'),
  ]);
  const captureReceipt = parseJson(captureText, 'SKU capture receipt');
  const topologyReceipt = parseJson(topologyReceiptText, 'SKU topology receipt');
  const topology = parseJson(topologyText, 'SKU topology');
  return {
    rawPayload,
    topology,
    evidence: buildSkuEvidence({ rawPayload, captureReceipt, topologyText, topologyReceipt }),
    parserSha256: sha256(parserText),
  };
}

async function readLiveState(envFile) {
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
  const [tables, mainFields, skuFields, mainRecords, skuRecords] = await Promise.all([
    client.listTables(),
    client.listFields(TARGET.mainTableId),
    client.listFields(TARGET.skuTableId),
    client.listRecords(TARGET.mainTableId),
    client.listRecords(TARGET.skuTableId),
  ]);
  assertTable(tables, TARGET.mainTableId, TARGET.mainTableName);
  assertTable(tables, TARGET.skuTableId, TARGET.skuTableName);
  assertMainTableHasRecords(mainRecords);
  return { mainFields, skuFields, mainRecords, skuRecords };
}

export function buildDryRunReceipt({
  target,
  evidence,
  mainRecordCount,
  skuRecordCount,
  plan,
  manifestPath,
  manifestSha256,
  receiptPath,
}) {
  return {
    mode: plan.summary.writeReady ? 'DRY_RUN_READY' : 'DRY_RUN_BLOCKED',
    target: {
      appToken: target.appToken,
      mainTableId: target.mainTableId,
      skuTableId: target.skuTableId,
    },
    source: {
      mainRecordId: evidence.source.mainRecordId,
      productId: evidence.source.productId,
      payloadSha256: evidence.payloadSha256,
      topologySha256: evidence.topologySha256,
    },
    verification: {
      propertyCount: evidence.propertyCount,
      validCombinationCount: evidence.validCombinationCount,
      mainRecordCount,
      skuRecordCount,
    },
    plan: { ...plan.summary },
    manifestPath,
    manifestSha256,
    receiptPath,
  };
}

async function writeArtifacts({ outputDirectory, evidence, parserSha256, source, live, parsed, plan, evidencePaths }) {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replace(/[-:.]/gu, '') + '-' + randomUUID();
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const manifestPath = resolve(directory, 'xws-sku-dry-run-manifest-' + runId + '.json');
  const receiptPath = resolve(directory, 'xws-sku-dry-run-receipt-' + runId + '.json');
  const manifest = {
    version: 'xws-sku-dry-run-manifest-v1',
    mode: 'DRY_RUN',
    generatedAt,
    target: TARGET,
    inputs: {
      payloadFile: basename(evidencePaths.payload),
      captureReceiptFile: basename(evidencePaths.captureReceipt),
      topologyFile: basename(evidencePaths.topology),
      topologyReceiptFile: basename(evidencePaths.topologyReceipt),
      parserFile: basename(PARSER_PATH),
    },
    evidence,
    parser: { sha256: parserSha256 },
    source,
    liveRead: {
      mainRecordCount: live.mainRecords.length,
      skuRecordCount: live.skuRecords.length,
      selectedRecordId: source.mainRecordId,
      selectedRecordValidity: displayText(live.mainRecord.fields?.是否有效竞品),
      selectedRecordClassification: displayText(live.mainRecord.fields?.竞品分类),
    },
    parsedSchema: parsed.sourceSchema,
    plan,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSha256 = sha256(manifestText);
  await writeFile(manifestPath, manifestText, { encoding: 'utf8', flag: 'wx' });

  const receipt = buildDryRunReceipt({
    target: TARGET,
    evidence,
    mainRecordCount: live.mainRecords.length,
    skuRecordCount: live.skuRecords.length,
    plan,
    manifestPath,
    manifestSha256,
    receiptPath,
  });
  const batchIndexPath = await updateSkuBatchIndex({
    directory,
    source: {
      mainRecordId: source.mainRecordId,
      productId: source.productId,
      productUrl: source.productUrl,
      classification: source.competitorClass,
      validity: displayText(live.mainRecord.fields?.是否有效竞品),
    },
    artifacts: {
      payload: evidencePaths.payload,
      captureReceipt: evidencePaths.captureReceipt,
      topology: evidencePaths.topology,
      topologyReceipt: evidencePaths.topologyReceipt,
      manifest: manifestPath,
      dryRunReceipt: receiptPath,
    },
    status: receipt.mode,
    updatedAt: generatedAt,
  });
  receipt.batchIndexPath = batchIndexPath;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const local = await readLocalEvidence(options);
  const live = await readLiveState(options.envFile);
  const mainRecord = selectedRecord(live.mainRecords, local.evidence.source.mainRecordId);
  const source = {
    productId: local.evidence.source.productId,
    productUrl: local.evidence.source.productUrl,
    productTitle: required(displayText(mainRecord.fields?.商品标题), 'selected main record title'),
    competitorClass: local.evidence.source.capturedClassification,
    mainRecordId: local.evidence.source.mainRecordId,
  };
  const parsed = parseXwsSkuPayload(local.rawPayload, source, local.topology);
  const plan = buildSkuDryRunPlan({
    target: TARGET,
    source,
    mainRecord,
    mainFields: live.mainFields,
    skuFields: live.skuFields,
    skuRecords: live.skuRecords,
    parsedRows: parsed.rows,
  });
  const receipt = await writeArtifacts({
    outputDirectory: options.outputDirectory,
    evidence: local.evidence,
    parserSha256: local.parserSha256,
    source,
    live: { ...live, mainRecord },
    parsed,
    plan,
    evidencePaths: {
      payload: resolve(options.payloadFile),
      captureReceipt: resolve(options.captureReceipt),
      topology: resolve(options.topologyFile),
      topologyReceipt: resolve(options.topologyReceipt),
    },
  });
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
