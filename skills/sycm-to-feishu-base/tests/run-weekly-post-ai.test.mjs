import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { parseOptions, runPostAiWorkflow } from '../scripts/run-weekly-post-ai.mjs';

const baseArgs = [
  '--base-url', 'https://example.feishu.cn/base/appToken',
  '--current-table-id', 'tblCurrent',
  '--current-table-name', '关键词分析 V1（2026-08-21）',
  '--previous-table-id', 'tblPrevious',
  '--previous-table-name', '关键词分析 V1（修正版）',
  '--verify-history-batch', '1',
  '--expected-verified-batch-rows', '300',
  '--history-table-id', 'tblHistory',
  '--history-table-name', '关键词历史总表 V1',
  '--current-batch-number', '4',
  '--expected-current-rows', '300',
  '--expected-history-rows', '1167',
];

test('post-AI orchestration is read-only by default and apply requires all exact confirmations', () => {
  assert.equal(parseOptions(baseArgs).apply, false);
  assert.throws(() => parseOptions([...baseArgs, '--apply']), /confirm-base/iu);
  assert.throws(() => parseOptions([
    ...baseArgs,
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
  ]), /confirm-history-table/iu);
  assert.equal(parseOptions([
    ...baseArgs,
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory',
  ]).apply, true);
});

test('post-AI orchestration can resume from the exact context stored by the pre-AI manifest', () => {
  const options = parseOptions(['--pre-ai-manifest', 'pre-ai-manifest.json'], {
    readManifest: () => ({
      status: 'READY_FOR_AI',
      postAi: {
        baseUrl: 'https://example.feishu.cn/base/appToken',
        currentTableId: 'tblCurrent',
        currentTableName: '关键词分析 V1（2026-08-21）',
        previousTableId: 'tblPrevious',
        previousTableName: '关键词分析 V1（修正版）',
        verifyHistoryBatch: 1,
        expectedVerifiedBatchRows: 300,
        historyTableId: 'tblHistory',
        historyTableName: '关键词历史总表 V1',
        currentBatchNumber: 4,
        expectedCurrentRows: 300,
        expectedHistoryRows: 1167,
        envFile: 'E:/小红书/.env.local',
        proxy: 'http://127.0.0.1:3456',
      },
    }),
  });

  assert.equal(options.currentTableId, 'tblCurrent');
  assert.equal(options.historyTableId, 'tblHistory');
  assert.equal(options.previousTableId, 'tblPrevious');
  assert.equal(options.expectedHistoryRows, 1167);
  assert.equal(options.preAiManifest, path.resolve('pre-ai-manifest.json'));
});

test('full apply runs formulas, Huitun, and history in guarded dry-run/apply order', async () => {
  const options = parseOptions([
    ...baseArgs,
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory',
  ]);
  const calls = [];
  const runProcess = async (script, args) => {
    const name = path.basename(script);
    calls.push({ kind: name, apply: args.includes('--apply'), args });
    if (name === 'apply-weekly-decision-formulas.mjs') {
      return args.includes('--apply')
        ? { mode: 'APPLIED_AND_VERIFIED' }
        : { mode: 'DRY_RUN_READY', schemaFieldsToRename: [], schemaFieldsToCreate: [], formulaFieldsToUpdate: ['对应产品方向'] };
    }
    if (name === 'sync-decision-history.mjs') {
      return args.includes('--apply')
        ? { mode: 'APPLIED_AND_VERIFIED' }
        : { mode: 'DRY_RUN_READY', planned: { historyFieldsToCreate: 0, historySnapshotsToWrite: 300, currentCountsToWrite: 300 } };
    }
    throw new Error(`unexpected script ${name}`);
  };
  const runHuitun = async (huitunOptions) => {
    calls.push({ kind: 'huitun', apply: huitunOptions.apply, options: huitunOptions });
    return huitunOptions.apply
      ? { status: 'APPLIED_AND_VERIFIED', verification: { recordsWritten: 2 } }
      : { status: 'DRY_RUN_READY', resultsPath: 'results.json', plannedRecordUpdates: 2 };
  };

  const result = await runPostAiWorkflow(options, {
    runProcess,
    runHuitun,
    makeDirectory: () => {},
    writeManifest: () => 'post-ai-manifest.json',
  });

  assert.equal(result.status, 'POST_AI_COMPLETED');
  assert.deepEqual(calls.map((call) => `${call.kind}:${call.apply}`), [
    'apply-weekly-decision-formulas.mjs:false',
    'apply-weekly-decision-formulas.mjs:true',
    'huitun:false',
    'huitun:true',
    'sync-decision-history.mjs:false',
    'sync-decision-history.mjs:true',
  ]);
  assert.equal(calls[3].options.resultsPath, path.resolve('results.json'));
  assert.equal(calls[5].args.includes('--confirm-history-table'), true);
  assert.equal(calls[4].args.includes('--previous-table-id'), true);
  assert.equal(calls[4].args.includes('--verify-history-batch'), true);
});

test('no Huitun candidates skips its apply and still synchronizes history', async () => {
  const options = parseOptions([
    ...baseArgs,
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory',
  ]);
  const calls = [];
  const result = await runPostAiWorkflow(options, {
    runProcess: async (script, args) => {
      const name = path.basename(script);
      calls.push({ kind: name, apply: args.includes('--apply') });
      if (name === 'apply-weekly-decision-formulas.mjs') {
        return { mode: 'DRY_RUN_READY', schemaFieldsToRename: [], schemaFieldsToCreate: [], formulaFieldsToUpdate: [] };
      }
      return args.includes('--apply') ? { mode: 'APPLIED_AND_VERIFIED' } : { mode: 'DRY_RUN_READY', planned: {} };
    },
    runHuitun: async (huitunOptions) => {
      calls.push({ kind: 'huitun', apply: huitunOptions.apply });
      return { status: 'DONE_NO_CANDIDATES' };
    },
    makeDirectory: () => {},
    writeManifest: () => 'post-ai-manifest.json',
  });

  assert.equal(result.status, 'POST_AI_COMPLETED');
  assert.deepEqual(calls.map((call) => `${call.kind}:${call.apply}`), [
    'apply-weekly-decision-formulas.mjs:false',
    'huitun:false',
    'sync-decision-history.mjs:false',
    'sync-decision-history.mjs:true',
  ]);
});

test('dry-run stops before Huitun when formula migration is still pending', async () => {
  const calls = [];
  const result = await runPostAiWorkflow(parseOptions(baseArgs), {
    runProcess: async (script) => {
      calls.push(path.basename(script));
      return { mode: 'DRY_RUN_READY', schemaFieldsToRename: [], schemaFieldsToCreate: ['近2周A级达标次数'], formulaFieldsToUpdate: [] };
    },
    runHuitun: async () => { throw new Error('Huitun must not run before formulas are current'); },
    makeDirectory: () => {},
    writeManifest: () => 'post-ai-manifest.json',
  });

  assert.equal(result.status, 'FORMULAS_DRY_RUN_READY');
  assert.deepEqual(calls, ['apply-weekly-decision-formulas.mjs']);
});

test('Huitun dry-run with candidates stops before history when apply is absent', async () => {
  const calls = [];
  const result = await runPostAiWorkflow(parseOptions(baseArgs), {
    runProcess: async (script) => {
      calls.push(path.basename(script));
      return { mode: 'DRY_RUN_READY', schemaFieldsToRename: [], schemaFieldsToCreate: [], formulaFieldsToUpdate: [] };
    },
    runHuitun: async () => ({ status: 'DRY_RUN_READY', resultsPath: 'results.json', plannedRecordUpdates: 1 }),
    makeDirectory: () => {},
    writeManifest: () => 'post-ai-manifest.json',
  });

  assert.equal(result.status, 'HUITUN_DRY_RUN_READY');
  assert.deepEqual(calls, ['apply-weekly-decision-formulas.mjs']);
});
