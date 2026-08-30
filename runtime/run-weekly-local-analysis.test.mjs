import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isMainModule, runLocalAnalysis } from './run-weekly-local-analysis.mjs';

test('CLI entry comparison handles Windows file URLs', () => {
  assert.equal(isMainModule(fileURLToPath(import.meta.url), fileURLToPath(import.meta.url)), true);
});

const input = {
  appToken: 'appToken',
  currentTable: { tableId: 'tblCurrent', tableName: '关键词分析 V1（2026-08-21）', recordCount: 1 },
  fields: [
    { field_name: '原始关键词', type: 1 },
    { field_name: '关键词编号', type: 1 },
    { field_name: '搜索人气', type: 1 },
    { field_name: '支付转化率', type: 1 },
  ],
  records: [{ record_id: 'rec1', fields: {
    原始关键词: '小户型亚克力浴缸', 关键词编号: 'KW000001', 搜索人气: '1200 ~ 2500', 支付转化率: '5% ~ 7.5%',
  } }],
  historyRecords: [],
  historyTable: { tableId: 'tblHistory', tableName: '历史表', recordCount: 0 },
  libraryTable: { tableId: 'tblLibrary', tableName: '编号库', recordCount: 1 },
  libraryRecords: [{ record_id: 'lib1', fields: {
    一级类目: '浴缸', 原始关键词: '小户型亚克力浴缸', 关键词编号: 'KW000001',
  } }],
  collectionDate: '2026-08-21',
  batchNumber: 3,
};

test('local runner writes tasks and artifact without remote dependencies', async () => {
  const files = new Map();
  const result = await runLocalAnalysis(input, {
    provider: 'codex',
    huitunResults: { items: [] },
    providerOutput: [{ record_id: 'rec1', keyword_id: 'KW000001', field: '内容热度', value: '中' },
      { record_id: 'rec1', keyword_id: 'KW000001', field: '对应产品方向', value: '小户型深泡款' }],
    writeFile: (file, content) => files.set(file, content),
  });
  assert.equal(result.status, 'EXTERNAL_EVIDENCE_REQUIRED');
  assert.ok(files.has('tasks.json'));
  assert.ok(files.has('provider-results.json'));
  assert.ok(files.has('analysis-artifact.json'));
});

test('local runner requires an explicit provider', async () => {
  await assert.rejects(runLocalAnalysis(input, { providerOutput: [] }), /provider is required/i);
});
