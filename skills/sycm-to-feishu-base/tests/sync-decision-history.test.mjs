import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDecisionHistoryMutation,
  buildDecisionHistoryPlan,
  buildDecisionHistorySchemaPlan,
  parseOptions,
  planVerifiedBatchPromotion,
  verifyDecisionHistoryApply,
} from '../scripts/sync-decision-history.mjs';

const current = (recordId, keywordNumber, fields = {}) => ({
  record_id: recordId,
  fields: {
    关键词编号: keywordNumber,
    关键词分类: '场景词',
    细分标签: ['场景/家用'],
    搜索热度: '高',
    内容热度: '中',
    交易热度: '高',
    优先级: 'B-持续观察',
    ...fields,
  },
});

const history = (recordId, batchNumber, keywordNumber, snapshot = null, validity = '有效', fields = {}) => ({
  record_id: recordId,
  fields: {
    批次编号: batchNumber,
    关键词编号: keywordNumber,
    重点达标: snapshot,
    批次有效性: validity,
    ...fields,
  },
});

test('plans one history snapshot per batch and a two-week count for the current table', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [
      { batchNumber: 1, records: [
        current('p1', 'KW000001'),
        current('p2', 'KW000002', { 搜索热度: '中' }),
      ] },
      { batchNumber: 2, records: [
        current('c1', 'KW000001'),
        current('c2', 'KW000002'),
        current('c3', 'KW000003', { 优先级: 'A-立即跟进' }),
      ] },
    ],
    historyRecords: [
      history('h11', 1, 'KW000001'),
      history('h12', 1, 'KW000002'),
      history('h21', 2, 'KW000001'),
      history('h22', 2, 'KW000002'),
      history('h23', 2, 'KW000003'),
    ],
    currentBatchNumber: 2,
  });

  assert.deepEqual(plan.historyUpdates, [
    { record_id: 'h11', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } },
    { record_id: 'h12', fields: { 重点达标: 0, A级达标: 0, 探索达标: 1 } },
    { record_id: 'h21', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } },
    { record_id: 'h22', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } },
    { record_id: 'h23', fields: { 重点达标: 1, A级达标: 1, 探索达标: 1 } },
  ]);
  assert.deepEqual(plan.currentUpdates, [
    { record_id: 'c1', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } },
    { record_id: 'c2', fields: { 近2周重点达标次数: 1, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } },
    { record_id: 'c3', fields: { 近2周重点达标次数: 1, 近2周A级达标次数: 1, 近2周探索达标次数: 1 } },
  ]);
  assert.deepEqual(plan.latestBatchNumbers, [1, 2]);
  assert.equal(plan.pendingHistory.length, 0);
  assert.equal(plan.pendingCurrent.length, 0);
});

test('keeps the key-word snapshot independent when only content heat is missing', () => {
  const incomplete = current('c1', 'KW000001', { 内容热度: '' });
  const oneBatch = buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 2, records: [incomplete] }],
    historyRecords: [history('h21', 2, 'KW000001')],
    currentBatchNumber: 2,
  });
  assert.deepEqual(oneBatch.historyUpdates, [
    { record_id: 'h21', fields: { 重点达标: 1, A级达标: 0 } },
  ]);
  assert.deepEqual(oneBatch.currentUpdates, []);
  assert.deepEqual(oneBatch.pendingHistory.map((item) => item.fieldName), ['探索达标']);
  assert.equal(oneBatch.pendingCurrent.length, 3);

  const missingAi = buildDecisionHistoryPlan({
    batchTables: [
      { batchNumber: 1, records: [current('p1', 'KW000001')] },
      { batchNumber: 2, records: [incomplete] },
    ],
    historyRecords: [history('h11', 1, 'KW000001'), history('h21', 2, 'KW000001')],
    currentBatchNumber: 2,
  });
  assert.deepEqual(missingAi.currentUpdates, [
    { record_id: 'c1', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0 } },
  ]);
  assert.deepEqual(missingAi.pendingCurrent.map((item) => item.fieldName), ['近2周探索达标次数']);
});

test('future weeks can reuse a stored previous snapshot without reopening every old analysis table', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 3, records: [current('c3', 'KW000001')] }],
    historyRecords: [
      history('h21', 2, 'KW000001', 1, '有效', { A级达标: 0, 探索达标: 1 }),
      history('h31', 3, 'KW000001'),
    ],
    currentBatchNumber: 3,
  });
  assert.deepEqual(plan.historyUpdates, [{ record_id: 'h31', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } }]);
  assert.deepEqual(plan.currentUpdates, [{ record_id: 'c3', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } }]);
});

test('uses only verified valid batches and ignores an intervening daily batch', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [
      { batchNumber: 1, records: [current('p1', 'KW000001')] },
      { batchNumber: 3, records: [current('c3', 'KW000001')] },
    ],
    historyRecords: [
      history('h11', 1, 'KW000001', 1, '有效', { A级达标: 0, 探索达标: 1 }),
      history('h21', 2, 'KW000001', 1, '无效-周期错误', { A级达标: 0, 探索达标: 1 }),
      history('h31', 3, 'KW000001'),
    ],
    currentBatchNumber: 3,
  });
  assert.deepEqual(plan.latestBatchNumbers, [1, 3]);
  assert.deepEqual(plan.ignoredBatchNumbers, [2]);
  assert.deepEqual(plan.currentUpdates, [{ record_id: 'c3', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } }]);
});

test('treats a legacy blank validity as unverified instead of silently accepting it', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 3, records: [current('c3', 'KW000001')] }],
    historyRecords: [
      history('h11', 1, 'KW000001', 1, '', { A级达标: 0, 探索达标: 1 }),
      history('h21', 2, 'KW000001', 1, '无效-周期错误', { A级达标: 0, 探索达标: 1 }),
      history('h31', 3, 'KW000001'),
    ],
    currentBatchNumber: 3,
  });
  assert.deepEqual(plan.latestBatchNumbers, [3]);
  assert.deepEqual(plan.ignoredBatchNumbers, [1, 2]);
  assert.deepEqual(plan.currentUpdates, []);
  assert.equal(plan.pendingCurrent.length, 3);
  assert.deepEqual([...new Set(plan.pendingCurrent.map((item) => item.reason))], ['INSUFFICIENT_HISTORY']);
});

test('promotes only an exact blank legacy batch whose keyword set matches the previous table', () => {
  const previous = [
    current('p1', 'KW000001'),
    current('p2', 'KW000002'),
    { record_id: 'placeholder', fields: {} },
  ];
  const records = [
    history('h11', 1, 'KW000001', null, ''),
    history('h12', 1, 'KW000002', null, ''),
    history('h21', 2, 'KW000001', null, '无效-周期错误'),
    history('h31', 3, 'KW000001'),
  ];
  const plan = planVerifiedBatchPromotion({
    historyRecords: records,
    previousRecords: previous,
    verifyHistoryBatch: 1,
    expectedVerifiedBatchRows: 2,
  });
  assert.deepEqual(plan.updates, [
    { record_id: 'h11', fields: { 批次有效性: '有效' } },
    { record_id: 'h12', fields: { 批次有效性: '有效' } },
  ]);
  assert.equal(plan.keywordCount, 2);
});

test('verified legacy batch promotion fails closed on row, identity, or validity conflicts', () => {
  const previous = [current('p1', 'KW000001')];
  const blankHistory = [history('h11', 1, 'KW000001', null, '')];
  assert.throws(() => planVerifiedBatchPromotion({
    historyRecords: blankHistory,
    previousRecords: previous,
    verifyHistoryBatch: 1,
    expectedVerifiedBatchRows: 2,
  }), /expected 2 rows/iu);
  assert.throws(() => planVerifiedBatchPromotion({
    historyRecords: blankHistory,
    previousRecords: [current('p2', 'KW000002')],
    verifyHistoryBatch: 1,
    expectedVerifiedBatchRows: 1,
  }), /keyword set/iu);
  assert.throws(() => planVerifiedBatchPromotion({
    historyRecords: [history('h11', 1, 'KW000001', null, '无效-周期错误')],
    previousRecords: previous,
    verifyHistoryBatch: 1,
    expectedVerifiedBatchRows: 1,
  }), /conflicting 批次有效性/iu);
});

test('fails closed on duplicate keyword numbers within one batch or mismatched history rows', () => {
  assert.throws(() => buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [current('a', 'KW000001'), current('b', 'KW000001')] }],
    historyRecords: [history('h1', 1, 'KW000001')],
    currentBatchNumber: 1,
  }), /duplicate keyword number/iu);

  assert.throws(() => buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [current('a', 'KW000001')] }],
    historyRecords: [history('h1', 1, 'KW000002')],
    currentBatchNumber: 1,
  }), /does not match/iu);
});

test('ignores a completely blank Feishu placeholder but rejects a populated row without an identity', () => {
  const blank = { record_id: 'blank', fields: {} };
  const valid = buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [current('a', 'KW000001'), blank] }],
    historyRecords: [history('h1', 1, 'KW000001')],
    currentBatchNumber: 1,
  });
  assert.deepEqual(valid.historyUpdates, [{ record_id: 'h1', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } }]);

  assert.throws(() => buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [
      current('a', 'KW000001'),
      { record_id: 'broken', fields: { 排名: '2', 搜索词: '小浴缸' } },
    ] }],
    historyRecords: [history('h1', 1, 'KW000001')],
    currentBatchNumber: 1,
  }), /invalid keyword number/iu);
});

test('does not overwrite a conflicting derived snapshot', () => {
  assert.throws(() => buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [current('a', 'KW000001')] }],
    historyRecords: [history('h1', 1, 'KW000001', 0)],
    currentBatchNumber: 1,
  }), /conflict/iu);
});

test('plans all three history snapshot fields without touching the deprecated analysis field', () => {
  assert.deepEqual(buildDecisionHistorySchemaPlan({ fields: [] }), {
    creates: [
      { fieldName: '重点达标', body: { field_name: '重点达标', type: 2 } },
      { fieldName: 'A级达标', body: { field_name: 'A级达标', type: 2 } },
      { fieldName: '探索达标', body: { field_name: '探索达标', type: 2 } },
    ],
  });
  assert.deepEqual(buildDecisionHistorySchemaPlan({
    fields: [
      { field_id: 'fldSnapshot', field_name: '重点达标', type: 2 },
      { field_id: 'fldA', field_name: 'A级达标', type: 2 },
      { field_id: 'fldExplore', field_name: '探索达标', type: 2 },
    ],
  }), { creates: [] });
  assert.throws(() => buildDecisionHistorySchemaPlan({
    fields: [{ field_id: 'fldSnapshot', field_name: '重点达标', type: 1 }],
  }), /number type 2/iu);
});

test('mutation guard permits only the new history snapshot and current helper writes', () => {
  const scope = {
    appToken: 'app',
    currentTableId: 'tblCurrent',
    historyTableId: 'tblHistory',
    allowHistoryFieldCreate: true,
    verifiedBatchRecordIds: new Set(['hLegacy']),
  };
  const root = '/bitable/v1/apps/app/tables';
  assert.doesNotThrow(() => assertDecisionHistoryMutation({
    method: 'POST',
    path: `${root}/tblHistory/fields`,
    body: { field_name: '重点达标', type: 2 },
  }, scope));
  assert.doesNotThrow(() => assertDecisionHistoryMutation({
    method: 'POST',
    path: `${root}/tblHistory/records/batch_update`,
    body: { records: [{ record_id: 'hLegacy', fields: { 批次有效性: '有效' } }] },
  }, scope));
  assert.doesNotThrow(() => assertDecisionHistoryMutation({
    method: 'POST',
    path: `${root}/tblHistory/records/batch_update`,
    body: { records: [{ record_id: 'h1', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } }] },
  }, scope));
  assert.doesNotThrow(() => assertDecisionHistoryMutation({
    method: 'POST',
    path: `${root}/tblCurrent/records/batch_update`,
    body: { records: [{ record_id: 'c1', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } }] },
  }, scope));

  for (const request of [
    { method: 'POST', path: `${root}/tblCurrent/records/batch_update`, body: { records: [{ record_id: 'c1', fields: { 是否重点词: '是' } }] } },
    { method: 'POST', path: `${root}/tblHistory/records/batch_update`, body: { records: [{ record_id: 'h1', fields: { 采集日期: 1 } }] } },
    { method: 'DELETE', path: `${root}/tblHistory/fields/fldOld`, body: {} },
  ]) assert.throws(() => assertDecisionHistoryMutation(request, scope), /Blocked unauthorized/iu);
});

test('CLI is read-only by default and apply requires exact three-target confirmations', () => {
  const args = [
    '--base-url', 'https://example.feishu.cn/base/appToken',
    '--current-table-id', 'tblCurrent',
    '--current-table-name', '关键词分析 V1（2026-08-14）',
    '--previous-table-id', 'tblPrevious',
    '--previous-table-name', '关键词分析 V1（修正版）',
    '--verify-history-batch', '1',
    '--expected-verified-batch-rows', '267',
    '--history-table-id', 'tblHistory',
    '--history-table-name', '关键词历史总表 V1',
    '--current-batch-number', '2',
    '--expected-current-rows', '267',
    '--expected-history-rows', '567',
  ];
  const dryRun = parseOptions(args);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.appToken, 'appToken');
  assert.equal(dryRun.currentBatchNumber, 2);
  assert.equal(dryRun.verifyHistoryBatch, 1);

  assert.throws(() => parseOptions([...args, '--apply']), /confirm-base/iu);
  const apply = parseOptions([
    ...args, '--apply',
    '--confirm-base', 'appToken',
    '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory',
  ]);
  assert.equal(apply.apply, true);
});

test('write verification permits only planned helpers and the dependent key-word formula result', () => {
  const before = {
    currentFields: [{ field_id: 'f1', field_name: '搜索词', type: 1 }],
    historyFields: [{ field_id: 'h1', field_name: '批次编号', type: 2 }],
    currentRecords: [current('c1', 'KW000001', { 搜索词: '浴缸', 是否重点词: '待数据' })],
    historyRecords: [history('r1', 2, 'KW000001')],
  };
  const schemaPlan = buildDecisionHistorySchemaPlan({ fields: before.historyFields });
  const plan = {
    historyUpdates: [{ record_id: 'r1', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } }],
    currentUpdates: [{ record_id: 'c1', fields: { 近2周重点达标次数: 2, 近2周A级达标次数: 0, 近2周探索达标次数: 2 } }],
  };
  const after = structuredClone(before);
  after.historyFields.push(
    { field_id: 'h2', field_name: '重点达标', type: 2 },
    { field_id: 'h3', field_name: 'A级达标', type: 2 },
    { field_id: 'h4', field_name: '探索达标', type: 2 },
  );
  after.historyRecords[0].fields.重点达标 = 1;
  after.historyRecords[0].fields.A级达标 = 0;
  after.historyRecords[0].fields.探索达标 = 1;
  after.currentRecords[0].fields.近2周重点达标次数 = 2;
  after.currentRecords[0].fields.近2周A级达标次数 = 0;
  after.currentRecords[0].fields.近2周探索达标次数 = 2;
  after.currentRecords[0].fields.是否重点词 = '是';
  assert.deepEqual(verifyDecisionHistoryApply({ before, after, schemaPlan, plan }), {
    historyFieldsCreated: 3,
    historyRecordsWritten: 1,
    currentRecordsWritten: 1,
  });

  const corrupted = structuredClone(after);
  corrupted.currentRecords[0].fields.搜索词 = '被改坏';
  assert.throws(() => verifyDecisionHistoryApply({ before, after: corrupted, schemaPlan, plan }), /business data/iu);
});
