import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { activeProfileName, envFilePath } from '../../../runtime/feishu-targets.mjs';
import {
  assertCurrentVisualizationReady,
  assertDecisionHistoryMutation,
  assertDecisionHistoryFieldContract,
  buildDecisionHistoryPlan,
  buildDecisionHistorySchemaPlan,
  FeishuApi,
  parseOptions,
  planVerifiedBatchPromotion,
  verifyDecisionHistoryApply,
} from '../scripts/sync-decision-history.mjs';

const current = (recordId, keywordNumber, fields = {}) => ({
  record_id: recordId,
  fields: {
    关键词编号: keywordNumber,
    标准归并词: '浴缸',
    关键词分类: '场景词',
    细分标签: ['场景/家用'],
    搜索热度: '高',
    内容热度: '中',
    交易热度: '高',
    是否重点词: '是',
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

test('retries only transient not-ready Feishu reads with bounded backoff', async () => {
  let calls = 0;
  const sleeps = [];
  const api = new FeishuApi({
    appId: 'app-id',
    appSecret: 'app-secret',
    appToken: 'app-token',
    mutationGuard: () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 400, json: async () => ({ code: 1254607, msg: 'Data not ready' }) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: ['ready'] } }) };
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    readRetryDelays: [250, 1000],
  });
  assert.deepEqual(await api.request('GET', '/records'), { items: ['ready'] });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 1000]);

  calls = 0;
  await assert.rejects(() => api.request('POST', '/records', { value: 1 }), /1254607/iu);
  assert.equal(calls, 1);
});

test('dry-run can plan before snapshot fields exist but apply requires all write targets', () => {
  const analysisFields = [
    '关键词编号', '标准归并词', '关键词分类', '细分标签', '搜索热度', '内容热度',
    '交易热度', '是否重点词', '优先级',
  ].map((field_name) => ({ field_name }));
  assert.doesNotThrow(() => assertDecisionHistoryFieldContract({
    currentFields: analysisFields,
    previousFields: analysisFields,
    hasPreviousTable: true,
    apply: false,
  }));
  assert.throws(() => assertDecisionHistoryFieldContract({
    currentFields: analysisFields,
    previousFields: analysisFields,
    hasPreviousTable: true,
    apply: true,
  }), /上一有效周重点达标/iu);
  assert.doesNotThrow(() => assertDecisionHistoryFieldContract({
    currentFields: [
      ...analysisFields,
      ...['上一有效周重点达标', '上一有效周A级达标', '上一有效周探索达标']
        .map((field_name) => ({ field_name })),
    ],
    previousFields: analysisFields,
    hasPreviousTable: true,
    apply: true,
  }));
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
    { record_id: 'h11', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } },
    { record_id: 'h12', fields: { 重点达标: 0, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } },
    { record_id: 'h21', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } },
    { record_id: 'h22', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } },
    { record_id: 'h23', fields: { 重点达标: 1, A级达标: 1, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'A-立即跟进' } },
  ]);
  assert.deepEqual(plan.currentUpdates, [
    { record_id: 'c1', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } },
    { record_id: 'c2', fields: { 上一有效周重点达标: 0, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } },
    { record_id: 'c3', fields: { 上一有效周重点达标: 0, 上一有效周A级达标: 0, 上一有效周探索达标: 0 } },
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
    { record_id: 'h21', fields: { 重点达标: 1, A级达标: 0, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } },
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
    { record_id: 'c1', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } },
  ]);
  assert.equal(missingAi.pendingCurrent.length, 0);
});

test('keeps A-candidate history unknown until Huitun evidence resolves it', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [
      { batchNumber: 1, records: [current('p1', 'KW000001')] },
      { batchNumber: 2, records: [current('c1', 'KW000001', { 优先级: 'A候选' })] },
    ],
    historyRecords: [
      history('h11', 1, 'KW000001'),
      history('h21', 2, 'KW000001'),
    ],
    currentBatchNumber: 2,
  });
  const currentHistoryUpdate = plan.historyUpdates.find((update) => update.record_id === 'h21');
  assert.equal(Object.hasOwn(currentHistoryUpdate.fields, 'A级达标'), false);
  assert.deepEqual(plan.pendingHistory.filter((item) => item.recordId === 'h21' && item.fieldName === 'A级达标'), [{
    recordId: 'h21',
    batchNumber: 2,
    keywordNumber: 'KW000001',
    fieldName: 'A级达标',
    reason: 'HUITUN_PENDING',
  }]);
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
  assert.deepEqual(plan.historyUpdates, [{ record_id: 'h31', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } }]);
  assert.deepEqual(plan.currentUpdates, [{ record_id: 'c3', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } }]);
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
  assert.deepEqual(plan.currentUpdates, [{ record_id: 'c3', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } }]);
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
  assert.deepEqual(valid.historyUpdates, [{ record_id: 'h1', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1, 标准归并词: '浴缸', 是否重点词: '是', 优先级: 'B-持续观察' } }]);

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

test('plans all three numeric snapshot fields and validates their types', () => {
  const formula = 'IF(AND(bitable::$table[tblHistory].$field[fldBatch]=3,bitable::$table[tblHistory].$field[fldValidity]="有效"),"是","否")';
  const baseFields = [
    { field_id: 'fldBatch', field_name: '批次编号', type: 2 },
    { field_id: 'fldValidity', field_name: '批次有效性', type: 1 },
    { field_id: 'fldMerge', field_name: '标准归并词', type: 1 },
    { field_id: 'fldImportant', field_name: '是否重点词', type: 1 },
    { field_id: 'fldPriority', field_name: '优先级', type: 1 },
    { field_id: 'fldCurrent', field_name: '本期标记', type: 20, property: { formula_expression: formula } },
  ];
  assert.deepEqual(buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 3,
    fields: baseFields,
  }), {
    creates: [
      { fieldName: '重点达标', body: { field_name: '重点达标', type: 2 } },
      { fieldName: 'A级达标', body: { field_name: 'A级达标', type: 2 } },
      { fieldName: '探索达标', body: { field_name: '探索达标', type: 2 } },
    ],
    updates: [],
  });
  assert.deepEqual(buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 3,
    fields: [
      ...baseFields,
      { field_id: 'fldSnapshot', field_name: '重点达标', type: 2 },
      { field_id: 'fldA', field_name: 'A级达标', type: 2 },
      { field_id: 'fldExplore', field_name: '探索达标', type: 2 },
    ],
  }), { creates: [], updates: [] });
  assert.throws(() => buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 3,
    fields: [...baseFields, { field_id: 'fldSnapshot', field_name: '重点达标', type: 1 }],
  }), /number type 2/iu);
});

test('snapshots the three dashboard dimensions from each supplied weekly analysis table', () => {
  const plan = buildDecisionHistoryPlan({
    batchTables: [{ batchNumber: 1, records: [current('c1', 'KW000001', {
      标准归并词: '家用浴缸',
      是否重点词: '是',
      优先级: 'A-立即跟进',
    })] }],
    historyRecords: [history('h1', 1, 'KW000001')],
    currentBatchNumber: 1,
  });
  assert.deepEqual(plan.historyUpdates, [{
    record_id: 'h1',
    fields: {
      重点达标: 1,
      A级达标: 1,
      探索达标: 1,
      标准归并词: '家用浴缸',
      是否重点词: '是',
      优先级: 'A-立即跟进',
    },
  }]);
  assert.equal(plan.pendingHistory.length, 0);
});

test('plans dashboard snapshot fields and one formula-driven current-period marker', () => {
  const expression = 'IF(AND(bitable::$table[tblHistory].$field[fldBatch]=3,bitable::$table[tblHistory].$field[fldValidity]="有效"),"是","否")';
  assert.deepEqual(buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 3,
    fields: [
      { field_id: 'fldBatch', field_name: '批次编号', type: 2 },
      { field_id: 'fldValidity', field_name: '批次有效性', type: 1 },
    ],
  }), {
    creates: [
      { fieldName: '重点达标', body: { field_name: '重点达标', type: 2 } },
      { fieldName: 'A级达标', body: { field_name: 'A级达标', type: 2 } },
      { fieldName: '探索达标', body: { field_name: '探索达标', type: 2 } },
      { fieldName: '标准归并词', body: { field_name: '标准归并词', type: 1 } },
      { fieldName: '是否重点词', body: { field_name: '是否重点词', type: 1 } },
      { fieldName: '优先级', body: { field_name: '优先级', type: 1 } },
      { fieldName: '本期标记', body: { field_name: '本期标记', type: 20, property: { formula_expression: expression } } },
    ],
    updates: [],
  });
});

test('updates only the current-period formula when the valid batch advances', () => {
  const fields = [
    { field_id: 'fldBatch', field_name: '批次编号', type: 2 },
    { field_id: 'fldValidity', field_name: '批次有效性', type: 1 },
    { field_id: 'fldTarget', field_name: '重点达标', type: 2 },
    { field_id: 'fldA', field_name: 'A级达标', type: 2 },
    { field_id: 'fldExplore', field_name: '探索达标', type: 2 },
    { field_id: 'fldMerge', field_name: '标准归并词', type: 1 },
    { field_id: 'fldImportant', field_name: '是否重点词', type: 1 },
    { field_id: 'fldPriority', field_name: '优先级', type: 1 },
    {
      field_id: 'fldCurrent',
      field_name: '本期标记',
      type: 20,
      property: {
        formula_expression: 'IF(AND(bitable::$table[tblHistory].$field[fldBatch]=2,bitable::$table[tblHistory].$field[fldValidity]="有效"),"是","否")',
      },
    },
  ];
  const plan = buildDecisionHistorySchemaPlan({ tableId: 'tblHistory', currentBatchNumber: 3, fields });
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, [{
    fieldId: 'fldCurrent',
    fieldName: '本期标记',
    body: {
      field_name: '本期标记',
      type: 20,
      property: {
        formula_expression: 'IF(AND(bitable::$table[tblHistory].$field[fldBatch]=3,bitable::$table[tblHistory].$field[fldValidity]="有效"),"是","否")',
      },
    },
  }]);
  const settledFields = fields.map((field) => field.field_id === 'fldCurrent'
    ? { ...field, ...structuredClone(plan.updates[0].body) }
    : field);
  assert.deepEqual(buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 3,
    fields: settledFields,
  }), { creates: [], updates: [] });
});

test('blocks apply before the current dashboard snapshots are complete', () => {
  const plan = buildDecisionHistoryPlan({
    currentBatchNumber: 3,
    batchTables: [{ batchNumber: 3, records: [current('c1', 'KW000001', { 优先级: '' })] }],
    historyRecords: [history('h1', 3, 'KW000001')],
  });
  assert.throws(() => assertCurrentVisualizationReady(plan, 3), /incomplete: 1 cells/iu);

  const complete = buildDecisionHistoryPlan({
    currentBatchNumber: 3,
    batchTables: [{ batchNumber: 3, records: [current('c1', 'KW000001')] }],
    historyRecords: [history('h1', 3, 'KW000001')],
  });
  assert.doesNotThrow(() => assertCurrentVisualizationReady(complete, 3));
});

test('an invalid batch can never evaluate as the current dashboard period', () => {
  const historyFields = [
    { field_id: 'fldBatch', field_name: '批次编号', type: 2 },
    { field_id: 'fldValidity', field_name: '批次有效性', type: 1 },
    { field_id: 'fldKey', field_name: '本期标记', type: 20, property: {
      formula_expression: 'IF(AND(bitable::$table[tblHistory].$field[fldBatch]=3,bitable::$table[tblHistory].$field[fldValidity]="有效"),"是","否")',
    } },
  ];
  const before = {
    currentFields: [],
    currentRecords: [],
    historyFields,
    historyRecords: [history('valid', 3, 'KW000001', null, '有效'), history('invalid', 3, 'KW000002', null, '无效-周期错误')],
  };
  const after = structuredClone(before);
  after.historyRecords[0].fields.本期标记 = '是';
  after.historyRecords[1].fields.本期标记 = '否';
  assert.equal(verifyDecisionHistoryApply({
    before,
    after,
    schemaPlan: { creates: [], updates: [] },
    plan: { historyUpdates: [], currentUpdates: [] },
    currentBatchNumber: 3,
  }).currentPeriodRows, 1);

  after.historyRecords[1].fields.本期标记 = '是';
  assert.throws(() => verifyDecisionHistoryApply({
    before,
    after,
    schemaPlan: { creates: [], updates: [] },
    plan: { historyUpdates: [], currentUpdates: [] },
    currentBatchNumber: 3,
  }), /expected 否/iu);
});

test('requires dashboard source fields on weekly analysis tables', () => {
  const oldFields = [
    '关键词编号', '关键词分类', '细分标签', '搜索热度', '内容热度', '交易热度', '优先级',
  ].map((field_name) => ({ field_name }));
  assert.throws(() => assertDecisionHistoryFieldContract({
    currentFields: oldFields,
  }), /标准归并词/iu);
});

test('mutation guard permits only the new history snapshot and current helper writes', () => {
  const scope = {
    appToken: 'app',
    currentTableId: 'tblCurrent',
    historyTableId: 'tblHistory',
    schemaPlan: {
      creates: [{ fieldName: '重点达标', body: { field_name: '重点达标', type: 2 } }],
      updates: [],
    },
    historyUpdates: [{ record_id: 'h1', fields: { 重点达标: 1, A级达标: 0, 探索达标: 1 } }],
    currentUpdates: [{ record_id: 'c1', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } }],
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
    body: { records: [{ record_id: 'c1', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } }] },
  }, scope));

  for (const request of [
    { method: 'POST', path: `${root}/tblCurrent/records/batch_update`, body: { records: [{ record_id: 'c1', fields: { 是否重点词: '是' } }] } },
    { method: 'POST', path: `${root}/tblHistory/records/batch_update`, body: { records: [{ record_id: 'h1', fields: { 采集日期: 1 } }] } },
    { method: 'DELETE', path: `${root}/tblHistory/fields/fldOld`, body: {} },
  ]) assert.throws(() => assertDecisionHistoryMutation(request, scope), /Blocked unauthorized/iu);
});

// parseOptions 要求一组必填目标参数；抽到模块级，供「默认值」与「三目标确认」两处共用，
// 避免两处各写一份 13 行参数表（写两份迟早漂移）。
const CLI_ARGS = [
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

test('CLI is read-only by default and apply requires exact three-target confirmations', () => {
  const args = CLI_ARGS;
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

// 默认凭据文件必须来自租户登记表。这一条与 pre-ai / update-weekly-base / post-ai 三处同因：
// 脚本里写死旧租户的 E:/小红书/.env.local，而 base 已经搬到 kcne618basvj，
// 于是「拿旧租户凭据读新租户 base」报 91403 Forbidden —— 会被误读成
// 「应用没被加为协作者」的假故障（2026-09-20 实测）。
// 断言对着访问器而不是字面量：写死字面量等于把当前默认值固化成测试。
test('the default credentials file comes from the tenant registry', () => {
  assert.equal(parseOptions(CLI_ARGS).envFile, envFilePath(activeProfileName()));

  const source = readFileSync(new URL('../scripts/sync-decision-history.mjs', import.meta.url), 'utf8');
  assert.match(source, /envFile: envFilePath\(activeProfileName\(\)\)/u);
  assert.doesNotMatch(source, /envFile: 'E:\//u);
});

test('write verification permits only planned helpers and the dependent key-word formula result', () => {
  const before = {
    currentFields: [{ field_id: 'f1', field_name: '搜索词', type: 1 }],
    historyFields: [
      { field_id: 'h1', field_name: '批次编号', type: 2 },
      { field_id: 'h2', field_name: '批次有效性', type: 1 },
    ],
    currentRecords: [current('c1', 'KW000001', { 搜索词: '浴缸', 是否重点词: '待数据' })],
    historyRecords: [history('r1', 2, 'KW000001')],
  };
  const schemaPlan = buildDecisionHistorySchemaPlan({
    tableId: 'tblHistory',
    currentBatchNumber: 2,
    fields: before.historyFields,
  });
  const plan = {
    historyUpdates: [{ record_id: 'r1', fields: {
      重点达标: 1,
      A级达标: 0,
      探索达标: 1,
      标准归并词: '浴缸',
      是否重点词: '是',
      优先级: 'B-持续观察',
    } }],
    currentUpdates: [{ record_id: 'c1', fields: { 上一有效周重点达标: 1, 上一有效周A级达标: 0, 上一有效周探索达标: 1 } }],
  };
  const after = structuredClone(before);
  after.historyFields.push(...schemaPlan.creates.map((create, index) => ({
    field_id: `new${index + 1}`,
    ...structuredClone(create.body),
  })));
  Object.assign(after.historyRecords[0].fields, plan.historyUpdates[0].fields, { 本期标记: '是' });
  after.currentRecords[0].fields.上一有效周重点达标 = 1;
  after.currentRecords[0].fields.上一有效周A级达标 = 0;
  after.currentRecords[0].fields.上一有效周探索达标 = 1;
  after.currentRecords[0].fields.是否重点词 = '是';
  assert.deepEqual(verifyDecisionHistoryApply({ before, after, schemaPlan, plan, currentBatchNumber: 2 }), {
    historyFieldsCreated: 7,
    historyFieldsUpdated: 0,
    historyRecordsWritten: 1,
    currentRecordsWritten: 1,
    currentPeriodRows: 1,
  });

  const corrupted = structuredClone(after);
  corrupted.currentRecords[0].fields.搜索词 = '被改坏';
  assert.throws(() => verifyDecisionHistoryApply({
    before,
    after: corrupted,
    schemaPlan,
    plan,
    currentBatchNumber: 2,
  }), /business data/iu);
});
