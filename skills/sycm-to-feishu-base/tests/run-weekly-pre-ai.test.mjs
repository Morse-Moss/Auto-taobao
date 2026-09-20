import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseOptions, runWorkflow } from '../scripts/run-weekly-pre-ai.mjs';
import { activeProfileName, envFilePath } from '../../../runtime/feishu-targets.mjs';

const baseArgs = [
  '--base-url', 'https://example.feishu.cn/base/appToken',
  '--source-table-id', 'tblPrevious',
  '--source-table-name', '关键词分析 V1（2026-08-14）',
  '--history-table-id', 'tblHistory',
  '--library-table-id', 'tblLibrary',
  '--collection-date', '2026-08-21',
  '--batch-number', '3',
  '--expected-history-before', '567',
];

test('pre-AI orchestration is plan-only unless the Base is explicitly confirmed', () => {
  const plan = parseOptions(baseArgs);
  assert.equal(plan.apply, false);
  assert.equal(plan.newTableName, '关键词分析 V1（2026-08-21）');
  assert.throws(() => parseOptions([...baseArgs, '--apply']), /confirm-base/iu);
  assert.equal(parseOptions([...baseArgs, '--apply', '--confirm-base', 'appToken']).apply, true);
});

test('an explicit CSV/XLSX pair is the only supported way to skip a fresh SYCM export', async () => {
  assert.throws(() => parseOptions([...baseArgs, '--source-csv', 'D:\\data\\week.csv']), /source-xlsx/iu);
  assert.throws(() => parseOptions([...baseArgs, '--source-xlsx', 'D:\\data\\week.xlsx']), /source-csv/iu);
  const options = parseOptions([
    ...baseArgs,
    '--source-csv', 'D:\\data\\week.csv',
    '--source-xlsx', 'D:\\data\\week.xlsx',
  ]);
  assert.equal(options.sourceCsv, 'D:\\data\\week.csv');
  assert.equal(options.sourceXlsx, 'D:\\data\\week.xlsx');
  assert.equal(options.skipExport, true);
  assert.equal(parseOptions(baseArgs).skipExport, false);
  assert.equal((await runWorkflow(options)).sourceMode, 'EXPLICIT_EXPORT_PAIR');
});

test('workflow prepares a local input snapshot without any Feishu mutation', async () => {
  const options = parseOptions([
    ...baseArgs,
    '--source-csv', 'D:\\data\\week.csv',
    '--source-xlsx', 'D:\\data\\week.xlsx',
    '--apply', '--confirm-base', 'appToken',
  ]);
  const calls = [];
  const runProcess = async (script) => {
    calls.push(script);
    throw new Error(`Feishu mutation must not run: ${script}`);
  };
  const result = await runWorkflow(options, {
    runProcess,
    readSourceCsv: () => [
      { 排名: '1', 搜索词: '浴缸' },
      { 排名: '2', 搜索词: '小浴缸' },
    ],
    verifySourcePair: async () => ({ period: '7天', startDate: '2026-08-15', endDate: '2026-08-21', dayCount: 7, rowCount: 2 }),
    makeDirectory: () => {},
    writeFile: () => {},
    writeManifest: () => 'manifest.json',
  });

  assert.equal(result.status, 'LOCAL_INPUT_READY');
  assert.match(result.nextStage, /PUBLISH_READY artifact/u);
  assert.equal(result.target.newTableName, options.newTableName);
  assert.equal(result.postAi.currentBatchNumber, 3);
  assert.equal(result.postAi.expectedCurrentRows, 2);
  assert.equal(result.postAi.expectedHistoryRows, 569);
  assert.equal(result.postAi.historyTableId, 'tblHistory');
  assert.equal(result.postAi.previousTableId, 'tblPrevious');
  assert.equal(calls.length, 0);
});

test('an explicit artifact pair is rejected before any remote write when its proof is not seven days', async () => {
  const options = parseOptions([
    ...baseArgs,
    '--source-csv', 'D:\\data\\day.csv',
    '--source-xlsx', 'D:\\data\\day.xlsx',
    '--apply', '--confirm-base', 'appToken',
  ]);
  await assert.rejects(runWorkflow(options, {
    verifySourcePair: async () => { throw new Error('Export pair is not a verified 7-day reporting window'); },
    runProcess: async () => { throw new Error('remote write must not run after invalid source proof'); },
    makeDirectory: () => {},
  }), /verified 7-day reporting window/iu);
});

test('fresh weekly collection requires a verified seven-day SYCM receipt', async () => {
  const options = parseOptions([...baseArgs, '--apply', '--confirm-base', 'appToken']);
  const calls = [];
  const runProcess = async (script, args) => {
    calls.push({ script, args });
    if (script.endsWith('export-search-rank.mjs')) {
      return {
        ok: true,
        csv: 'week.csv',
        xlsx: 'week.xlsx',
        metadata: {
          period: '7天',
          startDate: '2026-08-15',
          endDate: '2026-08-21',
          dayCount: 7,
          dateRange: '2026-08-15 ~ 2026-08-21',
        },
      };
    }
    if (script.endsWith('copy-weekly-table.mjs')) {
      return { newTableId: 'tblCurrent', newTableName: options.newTableName, newTableUrl: 'https://example.feishu.cn/base/appToken?table=tblCurrent' };
    }
    if (script.endsWith('update-weekly-base.mjs')) {
      return args.includes('--apply')
        ? { mode: 'APPLIED_AND_VERIFIED' }
        : { mode: 'DRY_RUN_READY' };
    }
    throw new Error(`unexpected script ${script}`);
  };

  await runWorkflow(options, {
    runProcess,
    readSourceCsv: () => [{ 排名: '1', 搜索词: '浴缸' }],
    verifySourcePair: async () => ({ period: '7天', startDate: '2026-08-15', endDate: '2026-08-21', dayCount: 7, rowCount: 1 }),
    makeDirectory: () => {},
    writeFile: () => {},
    writeManifest: () => 'manifest.json',
  });

  const exporter = calls.find((call) => call.script.endsWith('export-search-rank.mjs'));
  assert.deepEqual(exporter.args.slice(0, 5), ['--from-home', '--period', '7d', '--date', '2026-08-21']);
});

// 默认凭据文件必须来自租户登记表。
// 反例（2026-09-20 实测）：脚本默认值是旧租户的 E:/小红书/.env.local，而 base 已经
// 搬到 kcne618basvj，于是「拿旧租户凭据读新租户 base」报 91403 Forbidden —— 一个
// 会被误读成「应用没被加为协作者」的假故障。
// 这里对着访问器断言而不是写死字面量：写死等于把当前默认值固化成测试（坑 34）。
test('the default credentials file comes from the tenant registry', () => {
  assert.equal(parseOptions(baseArgs).envFile, envFilePath(activeProfileName()));

  const source = readFileSync(new URL('../scripts/run-weekly-pre-ai.mjs', import.meta.url), 'utf8');
  assert.match(source, /envFile: envFilePath\(activeProfileName\(\)\)/u);
  assert.doesNotMatch(source, /envFile: 'E:\//u);
});

test('fresh weekly collection stops on a daily SYCM receipt', async () => {
  const options = parseOptions([...baseArgs, '--apply', '--confirm-base', 'appToken']);
  await assert.rejects(
    runWorkflow(options, {
      runProcess: async (script) => {
        if (script.endsWith('export-search-rank.mjs')) {
          return {
            ok: true,
            csv: 'day.csv',
            xlsx: 'day.xlsx',
            metadata: { period: '日', startDate: '2026-08-21', endDate: '2026-08-21', dayCount: 1 },
          };
        }
        throw new Error('remote write must not run after an invalid export receipt');
      },
      makeDirectory: () => {},
    }),
    /verified 7-day reporting window/u,
  );
});
