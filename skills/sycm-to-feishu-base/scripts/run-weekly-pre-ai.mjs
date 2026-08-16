#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSourceCsv } from './update-weekly-base.mjs';
import { verifyExportPair } from '../../sycm-export-search-rank/scripts/source-period-proof.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const EXPORT_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'sycm-export-search-rank', 'scripts', 'export-search-rank.mjs');
const COPY_SCRIPT = path.join(SCRIPT_DIR, 'copy-weekly-table.mjs');
const UPDATE_SCRIPT = path.join(SCRIPT_DIR, 'update-weekly-base.mjs');

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    category: '浴缸',
    sycmCategory: '普通浴缸',
    cateId: '50002411',
    proxy: 'http://127.0.0.1:3456',
    envFile: 'E:/小红书/.env.local',
    runRoot: path.join(PROJECT_ROOT, 'runtime', 'weekly-runs'),
    historyTableName: '关键词历史总表 V1',
  };
  const values = new Set([
    'base-url', 'source-table-id', 'source-table-name', 'new-table-name', 'history-table-id', 'history-table-name',
    'library-table-id', 'collection-date', 'batch-number', 'expected-history-before', 'category',
    'sycm-category', 'cate-id', 'proxy', 'env-file', 'run-root', 'source-csv', 'confirm-base',
    'source-xlsx', 'invalidate-history-batch', 'expected-invalid-batch-rows',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply') {
      options.apply = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  const required = [
    'baseUrl', 'sourceTableId', 'sourceTableName', 'historyTableId', 'libraryTableId',
    'collectionDate', 'batchNumber', 'expectedHistoryBefore',
  ];
  const missing = required.filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.collectionDate) ||
      !Number.isFinite(Date.parse(`${options.collectionDate}T00:00:00+08:00`))) {
    throw new Error('--collection-date must be a valid YYYY-MM-DD date');
  }
  for (const name of ['batchNumber', 'expectedHistoryBefore']) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error(`${name} must be a positive integer`);
  }
  options.newTableName ||= `关键词分析 V1（${options.collectionDate}）`;
  if (Boolean(options.sourceCsv) !== Boolean(options.sourceXlsx)) {
    throw new Error('Explicit reuse requires both --source-csv and --source-xlsx');
  }
  options.skipExport = Boolean(options.sourceCsv && options.sourceXlsx);
  if (options.sourceCsv) options.sourceCsv = path.resolve(options.sourceCsv);
  if (options.sourceXlsx) options.sourceXlsx = path.resolve(options.sourceXlsx);
  if (Boolean(options.invalidateHistoryBatch) !== Boolean(options.expectedInvalidBatchRows)) {
    throw new Error('--invalidate-history-batch and --expected-invalid-batch-rows must be supplied together');
  }
  for (const name of ['invalidateHistoryBatch', 'expectedInvalidBatchRows']) {
    if (options[name] === undefined) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (options.invalidateHistoryBatch && options.invalidateHistoryBatch >= options.batchNumber) {
    throw new Error('--invalidate-history-batch must be older than --batch-number');
  }
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error(`--apply requires --confirm-base ${options.appToken}`);
  }
  return options;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

async function defaultRunProcess(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: PROJECT_ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error(`Stage failed (${path.basename(script)}, exit ${code}): ${stderr.trim() || stdout.trim()}`);
        error.exitCode = code;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Stage returned invalid JSON (${path.basename(script)})`));
      }
    });
  });
}

function defaultWriteManifest(runDir, payload) {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'pre-ai-manifest.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return file;
}

export async function runWorkflow(options, dependencies = {}) {
  if (!options.apply) {
    return {
      status: 'PLAN_ONLY',
      collectionDate: options.collectionDate,
      batchNumber: options.batchNumber,
      sourceMode: options.skipExport ? 'EXPLICIT_EXPORT_PAIR' : 'FRESH_SYCM_EXPORT',
      newTableName: options.newTableName,
      writesPlanned: false,
    };
  }
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const readSourceCsv = dependencies.readSourceCsv ?? ((file) => parseSourceCsv(fs.readFileSync(file, 'utf8')));
  const verifySourcePair = dependencies.verifySourcePair ?? verifyExportPair;
  const writeManifest = dependencies.writeManifest ?? defaultWriteManifest;
  const makeDirectory = dependencies.makeDirectory ?? ((directory) => fs.mkdirSync(directory, { recursive: true }));
  const runDir = path.resolve(options.runRoot, options.collectionDate, `pre-ai-${stamp()}`);
  makeDirectory(runDir);

  let sourceCsv = options.sourceCsv;
  let sourceXlsx = options.sourceXlsx ?? null;
  let exportReceipt = null;
  if (!options.skipExport) {
    const outputDir = path.join(runDir, 'sycm');
    makeDirectory(outputDir);
    exportReceipt = await runProcess(EXPORT_SCRIPT, [
      '--from-home', '--period', '7d', '--date', options.collectionDate,
      '--cate-id', options.cateId, '--category', options.sycmCategory,
      '--proxy', options.proxy, '--output-dir', outputDir,
      '--prefix', `ordinary-bathtub-week-${options.collectionDate.replaceAll('-', '')}`,
    ]);
    if (!exportReceipt.ok || !exportReceipt.csv || !exportReceipt.xlsx) throw new Error('SYCM export did not return validated CSV and XLSX paths');
    const reporting = exportReceipt.metadata;
    if (reporting?.period !== '7天' || reporting?.dayCount !== 7 || reporting?.endDate !== options.collectionDate) {
      throw new Error('SYCM export did not prove a verified 7-day reporting window ending on the collection date');
    }
    sourceCsv = exportReceipt.csv;
    sourceXlsx = exportReceipt.xlsx;
  }
  const sourceProof = await verifySourcePair({
    csv: sourceCsv,
    xlsx: sourceXlsx,
    expectedEndDate: options.collectionDate,
  });
  const sourceRows = readSourceCsv(sourceCsv);
  if (sourceProof.rowCount !== sourceRows.length) {
    throw new Error(`Source proof expected ${sourceProof.rowCount} rows; CSV contains ${sourceRows.length}`);
  }

  const copyArgs = [
    '--base-url', options.baseUrl,
    '--source-table-id', options.sourceTableId,
    '--source-table-name', options.sourceTableName,
    '--new-table-name', options.newTableName,
    '--proxy', options.proxy,
  ];
  const copyDryRun = await runProcess(COPY_SCRIPT, copyArgs);
  const copy = await runProcess(COPY_SCRIPT, [...copyArgs, '--apply', '--confirm-base', options.appToken]);
  if (!copy.newTableId || copy.newTableName !== options.newTableName) throw new Error('Weekly table copy did not return the requested table identity');

  const receiptFile = path.join(runDir, 'weekly-base-update-receipt.json');
  const updateArgs = [
    '--base-url', options.baseUrl,
    '--source-csv', sourceCsv,
    '--source-xlsx', sourceXlsx,
    '--weekly-table-id', copy.newTableId,
    '--weekly-table-name', copy.newTableName,
    '--history-table-id', options.historyTableId,
    '--library-table-id', options.libraryTableId,
    '--protected-table-id', options.sourceTableId,
    '--protected-table-name', options.sourceTableName,
    '--collection-date', options.collectionDate,
    '--batch-number', String(options.batchNumber),
    '--expected-source-rows', String(sourceRows.length),
    '--expected-history-before', String(options.expectedHistoryBefore),
    '--category', options.category,
    '--env-file', options.envFile,
  ];
  if (options.invalidateHistoryBatch) {
    updateArgs.push(
      '--invalidate-history-batch', String(options.invalidateHistoryBatch),
      '--expected-invalid-batch-rows', String(options.expectedInvalidBatchRows),
    );
  }
  const updateDryRun = await runProcess(UPDATE_SCRIPT, updateArgs);
  if (updateDryRun.mode !== 'DRY_RUN_READY') throw new Error('Weekly Base update did not reach DRY_RUN_READY');
  const update = await runProcess(UPDATE_SCRIPT, [
    ...updateArgs,
    '--receipt-file', receiptFile,
    '--apply', '--confirm-base', options.appToken, '--confirm-weekly-table', copy.newTableId,
  ]);
  if (update.mode !== 'APPLIED_AND_VERIFIED') throw new Error('Weekly Base update did not verify');

  const manifest = {
    status: 'READY_FOR_AI',
    createdAt: new Date().toISOString(),
    collectionDate: options.collectionDate,
    batchNumber: options.batchNumber,
    source: {
      mode: options.skipExport ? 'EXPLICIT_EXPORT_PAIR' : 'FRESH_SYCM_EXPORT',
      csv: sourceCsv,
      xlsx: sourceXlsx,
      rows: sourceRows.length,
      exportReceipt,
      proof: sourceProof,
    },
    weeklyTable: { id: copy.newTableId, name: copy.newTableName, url: copy.newTableUrl },
    copyDryRun,
    copy,
    updateDryRun,
    update,
    postAi: {
      runner: path.join(SCRIPT_DIR, 'run-weekly-post-ai.mjs'),
      baseUrl: options.baseUrl,
      currentTableId: copy.newTableId,
      currentTableName: copy.newTableName,
      previousTableId: options.sourceTableId,
      previousTableName: options.sourceTableName,
      historyTableId: options.historyTableId,
      historyTableName: options.historyTableName,
      currentBatchNumber: options.batchNumber,
      expectedCurrentRows: sourceRows.length,
      expectedHistoryRows: options.expectedHistoryBefore + sourceRows.length,
      envFile: options.envFile,
      proxy: options.proxy,
    },
    nextStage: '只运行运营已确认的复制 AI 字段；完成后把本清单交给 postAi.runner，一次续跑公式、灰豚和历史同步。对应产品方向由近两周达标次数公式自动重算。',
  };
  const manifestFile = writeManifest(runDir, manifest);
  return { ...manifest, manifestFile };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify(await runWorkflow(options), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode === 2 ? 2 : 1;
  });
}
