#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const FORMULA_SCRIPT = path.join(PROJECT_ROOT, 'runtime', 'apply-weekly-decision-formulas.mjs');
const HUITUN_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'huitun-to-feishu-keyword-heat', 'scripts', 'run-huitun-topic-heat.mjs');
const HISTORY_SCRIPT = path.join(SCRIPT_DIR, 'sync-decision-history.mjs');

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv, dependencies = {}) {
  const options = {
    apply: false,
    recalculateExistingSnapshots: false,
    envFile: 'E:/小红书/.env.local',
    proxy: 'http://127.0.0.1:3456',
    runRoot: path.join(PROJECT_ROOT, 'runtime', 'weekly-runs'),
    maxCandidates: 50,
    resultMaxAgeHours: 24,
  };
  const values = new Set([
    'pre-ai-manifest',
    'base-url', 'current-table-id', 'current-table-name', 'previous-table-id', 'previous-table-name',
    'verify-history-batch', 'expected-verified-batch-rows', 'history-table-id', 'history-table-name',
    'current-batch-number', 'expected-current-rows', 'expected-history-rows', 'env-file', 'proxy',
    'run-root', 'huitun-results', 'max-candidates', 'result-max-age-hours', 'confirm-base',
    'confirm-current-table', 'confirm-history-table',
  ]);
  const explicit = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply' || name === 'recalculate-existing-snapshots') {
      options[optionKey(name)] = true;
      explicit.add(optionKey(name));
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    const key = optionKey(name);
    options[key] = value;
    explicit.add(key);
    index += 1;
  }
  if (options.preAiManifest) {
    options.preAiManifest = path.resolve(options.preAiManifest);
    const readManifest = dependencies.readManifest ?? ((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    const manifest = readManifest(options.preAiManifest);
    if (manifest?.status !== 'READY_FOR_AI' || !manifest.postAi) {
      throw new Error('--pre-ai-manifest must reference a READY_FOR_AI manifest with postAi context');
    }
    const contextFields = [
      'baseUrl', 'currentTableId', 'currentTableName', 'historyTableId', 'historyTableName',
      'previousTableId', 'previousTableName', 'verifyHistoryBatch', 'expectedVerifiedBatchRows',
      'currentBatchNumber', 'expectedCurrentRows', 'expectedHistoryRows', 'envFile', 'proxy',
    ];
    for (const key of contextFields) {
      const value = manifest.postAi[key];
      if (value == null || value === '') continue;
      if (explicit.has(key) && String(options[key]) !== String(value)) {
        throw new Error(`--pre-ai-manifest conflicts with explicit ${key}`);
      }
      if (!explicit.has(key)) options[key] = value;
    }
  }
  const required = [
    'baseUrl', 'currentTableId', 'currentTableName', 'historyTableId', 'historyTableName',
    'currentBatchNumber', 'expectedCurrentRows', 'expectedHistoryRows',
  ];
  const missing = required.filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);

  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  if (Boolean(options.previousTableId) !== Boolean(options.previousTableName)) {
    throw new Error('--previous-table-id and --previous-table-name must be supplied together');
  }
  if (Boolean(options.verifyHistoryBatch) !== Boolean(options.expectedVerifiedBatchRows)) {
    throw new Error('--verify-history-batch and --expected-verified-batch-rows must be supplied together');
  }
  if (options.verifyHistoryBatch && !options.previousTableId) {
    throw new Error('--verify-history-batch requires the previous analysis table');
  }
  for (const name of ['currentBatchNumber', 'expectedCurrentRows', 'expectedHistoryRows', 'maxCandidates', 'verifyHistoryBatch', 'expectedVerifiedBatchRows']) {
    if (options[name] === undefined) continue;
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new Error(`${name} must be a positive integer`);
  }
  options.resultMaxAgeHours = Number(options.resultMaxAgeHours);
  if (!Number.isFinite(options.resultMaxAgeHours) || options.resultMaxAgeHours < 0.1) {
    throw new Error('resultMaxAgeHours must be at least 0.1');
  }
  if (options.huitunResults) options.huitunResults = path.resolve(options.huitunResults);
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error(`--apply requires --confirm-base ${options.appToken}`);
  }
  if (options.apply && options.confirmCurrentTable !== options.currentTableId) {
    throw new Error(`--apply requires --confirm-current-table ${options.currentTableId}`);
  }
  if (options.apply && options.confirmHistoryTable !== options.historyTableId) {
    throw new Error(`--apply requires --confirm-history-table ${options.historyTableId}`);
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
        reject(new Error(`Stage failed (${path.basename(script)}, exit ${code}): ${stderr.trim() || stdout.trim()}`));
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

function parseJsonLines(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function defaultRunHuitun(options) {
  const args = [
    '--app-token', options.appToken,
    '--table-id', options.tableId,
    '--table-name', options.tableName,
    '--env-file', options.envFile,
    '--proxy', options.proxy,
    '--output-dir', options.outputDir,
    '--max-candidates', String(options.maxCandidates),
    '--result-max-age-hours', String(options.resultMaxAgeHours),
  ];
  if (options.resultsPath) args.push('--results', options.resultsPath);
  if (options.apply) args.push('--apply', '--confirm-table', options.tableId);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUITUN_SCRIPT, ...args], { cwd: PROJECT_ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = parseJsonLines(stderr).at(-1);
        const error = new Error(detail?.error || `Huitun stage failed with exit ${code}`);
        error.code = detail?.status || 'FAILED';
        error.details = detail?.details || {};
        reject(error);
        return;
      }
      const runDir = parseJsonLines(stdout).reverse().find((item) => item.runDir)?.runDir;
      if (!runDir) {
        reject(new Error('Huitun stage returned no run directory'));
        return;
      }
      try {
        resolve(JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')));
      } catch {
        reject(new Error('Huitun stage returned no readable manifest'));
      }
    });
  });
}

function defaultWriteManifest(runDir, payload) {
  const file = path.join(runDir, 'post-ai-manifest.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return file;
}

function formulaChanges(summary) {
  return (summary.schemaFieldsToRename?.length ?? 0)
    + (summary.schemaFieldsToCreate?.length ?? 0)
    + (summary.formulaFieldsToUpdate?.length ?? 0);
}

function buildHuitunOptions(options, runDir, { apply = false, resultsPath = '' } = {}) {
  return {
    appToken: options.appToken,
    tableId: options.currentTableId,
    tableName: options.currentTableName,
    envFile: options.envFile,
    proxy: options.proxy,
    outputDir: path.join(runDir, 'huitun'),
    maxCandidates: options.maxCandidates,
    resultMaxAgeHours: options.resultMaxAgeHours,
    resultsPath: resultsPath ? path.resolve(resultsPath) : '',
    apply,
  };
}

export async function runPostAiWorkflow(options, dependencies = {}) {
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const runHuitun = dependencies.runHuitun ?? defaultRunHuitun;
  const makeDirectory = dependencies.makeDirectory ?? ((directory) => fs.mkdirSync(directory, { recursive: true }));
  const writeManifest = dependencies.writeManifest ?? defaultWriteManifest;
  const runDir = path.resolve(options.runRoot, `batch-${options.currentBatchNumber}`, `post-ai-${stamp()}`);
  makeDirectory(runDir);

  const finish = (status, stages) => {
    const manifest = {
      status,
      createdAt: new Date().toISOString(),
      target: {
        appToken: options.appToken,
        currentTableId: options.currentTableId,
        currentTableName: options.currentTableName,
        historyTableId: options.historyTableId,
        historyTableName: options.historyTableName,
        currentBatchNumber: options.currentBatchNumber,
      },
      stages,
      runDir,
    };
    const manifestFile = writeManifest(runDir, manifest);
    return { ...manifest, manifestFile };
  };

  const formulaArgs = [
    '--base-url', options.baseUrl,
    '--table-id', options.currentTableId,
    '--table-name', options.currentTableName,
    '--env-file', options.envFile,
  ];
  const formulaDryRun = await runProcess(FORMULA_SCRIPT, formulaArgs);
  if (formulaDryRun.mode !== 'DRY_RUN_READY') throw new Error('Decision formula stage did not reach DRY_RUN_READY');
  let formulaApply = null;
  if (formulaChanges(formulaDryRun) > 0) {
    if (!options.apply) return finish('FORMULAS_DRY_RUN_READY', { formulas: { dryRun: formulaDryRun, apply: null } });
    formulaApply = await runProcess(FORMULA_SCRIPT, [
      ...formulaArgs,
      '--receipt-file', path.join(runDir, 'decision-formulas-receipt.json'),
      '--apply', '--confirm-base', options.appToken, '--confirm-table', options.currentTableId,
    ]);
    if (formulaApply.mode !== 'APPLIED_AND_VERIFIED') throw new Error('Decision formula stage did not verify');
  }

  const huitunDryRun = await runHuitun(buildHuitunOptions(options, runDir, {
    resultsPath: options.huitunResults || '',
  }));
  let huitunApply = null;
  if (huitunDryRun.status === 'DRY_RUN_READY') {
    if (!options.apply) {
      return finish('HUITUN_DRY_RUN_READY', {
        formulas: { dryRun: formulaDryRun, apply: formulaApply },
        huitun: { dryRun: huitunDryRun, apply: null },
      });
    }
    if (!huitunDryRun.resultsPath) throw new Error('Huitun dry-run returned no reusable result path');
    huitunApply = await runHuitun(buildHuitunOptions(options, runDir, {
      apply: true,
      resultsPath: huitunDryRun.resultsPath,
    }));
    if (huitunApply.status !== 'APPLIED_AND_VERIFIED') throw new Error('Huitun apply stage did not verify');
  } else if (huitunDryRun.status !== 'DONE_NO_CANDIDATES') {
    throw new Error(`Unexpected Huitun state: ${huitunDryRun.status}`);
  }

  const historyArgs = [
    '--base-url', options.baseUrl,
    '--current-table-id', options.currentTableId,
    '--current-table-name', options.currentTableName,
    '--history-table-id', options.historyTableId,
    '--history-table-name', options.historyTableName,
    '--current-batch-number', String(options.currentBatchNumber),
    '--expected-current-rows', String(options.expectedCurrentRows),
    '--expected-history-rows', String(options.expectedHistoryRows),
    '--env-file', options.envFile,
  ];
  if (options.previousTableId) {
    historyArgs.push('--previous-table-id', options.previousTableId, '--previous-table-name', options.previousTableName);
  }
  if (options.verifyHistoryBatch) {
    historyArgs.push(
      '--verify-history-batch', String(options.verifyHistoryBatch),
      '--expected-verified-batch-rows', String(options.expectedVerifiedBatchRows),
    );
  }
  if (options.recalculateExistingSnapshots) historyArgs.push('--recalculate-existing-snapshots');
  const historyDryRun = await runProcess(HISTORY_SCRIPT, historyArgs);
  if (historyDryRun.mode !== 'DRY_RUN_READY') throw new Error('Decision history stage did not reach DRY_RUN_READY');
  if (!options.apply) {
    return finish('POST_AI_DRY_RUN_READY', {
      formulas: { dryRun: formulaDryRun, apply: formulaApply },
      huitun: { dryRun: huitunDryRun, apply: huitunApply },
      history: { dryRun: historyDryRun, apply: null },
    });
  }
  const historyApply = await runProcess(HISTORY_SCRIPT, [
    ...historyArgs,
    '--receipt-file', path.join(runDir, 'decision-history-receipt.json'),
    '--apply', '--confirm-base', options.appToken,
    '--confirm-current-table', options.currentTableId,
    '--confirm-history-table', options.historyTableId,
  ]);
  if (historyApply.mode !== 'APPLIED_AND_VERIFIED') throw new Error('Decision history stage did not verify');
  return finish('POST_AI_COMPLETED', {
    formulas: { dryRun: formulaDryRun, apply: formulaApply },
    huitun: { dryRun: huitunDryRun, apply: huitunApply },
    history: { dryRun: historyDryRun, apply: historyApply },
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify(await runPostAiWorkflow(options), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: error.code || 'FAILED', error: error.message, details: error.details || {} }));
    process.exitCode = error.code === 'HUMAN_REQUIRED' ? 2 : error.code === 'STALLED' ? 3 : 1;
  });
}
