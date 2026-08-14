import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_TABLE_ID,
  ANALYSIS_TABLE_NAME,
  APP_TOKEN,
  FIELD_ADDITIONS,
  HISTORY_TABLE_ID,
  HISTORY_TABLE_NAME,
  KEYWORD_LIBRARY_TABLE_ID,
  KEYWORD_LIBRARY_TABLE_NAME,
  assertHelperFieldMutation,
  buildFieldCreatePlan,
  summarizeSnapshotDifference,
  verifyFieldAddition,
} from './add-keyword-history-helper-fields.mjs';

function field(id, name, type = 1) {
  return { field_id: id, field_name: name, type };
}

function table(tableId, tableName, fields, records = []) {
  return { tableId, tableName, fields, records };
}

function snapshot({ analysisFields, historyFields, analysisRecords, historyRecords } = {}) {
  return [
    table(ANALYSIS_TABLE_ID, ANALYSIS_TABLE_NAME, analysisFields ?? [
      field('fldRank', '排名', 2),
      field('fldDate', '采集日期', 5),
    ], analysisRecords ?? [{ record_id: 'recAnalysis', fields: { 排名: 1, 搜索词: '浴缸' } }]),
    table(HISTORY_TABLE_ID, HISTORY_TABLE_NAME, historyFields ?? [
      field('fldHistoryRank', '排名', 2),
      field('fldHistoryDate', '采集日期', 5),
    ], historyRecords ?? [{ record_id: 'recHistory', fields: { 排名: 1, 搜索词: '浴缸' } }]),
    table(KEYWORD_LIBRARY_TABLE_ID, KEYWORD_LIBRARY_TABLE_NAME, [
      field('fldKeyword', '关键词编号'),
    ], [{ record_id: 'recLibrary', fields: { 关键词编号: 'KW000001' } }]),
  ];
}

function appendFields(before, plan) {
  return before.map((item) => ({
    ...item,
    records: structuredClone(item.records),
    fields: [
      ...item.fields,
      ...plan.creates
        .filter((create) => create.tableId === item.tableId)
        .map((create, index) => field(`fldNew${item.tableId}${index}`, create.fieldName, create.body.type)),
    ],
  }));
}

test('creates only the three admitted numeric fields after 采集日期', () => {
  const plan = buildFieldCreatePlan(snapshot());

  assert.deepEqual(plan.creates.map((item) => [item.tableId, item.fieldName, item.body.type]), [
    [ANALYSIS_TABLE_ID, '已有有效批次数', 2],
    [ANALYSIS_TABLE_ID, '近8批出现次数', 2],
    [HISTORY_TABLE_ID, '批次编号', 2],
  ]);
  assert.equal(plan.recordsWillBeWritten, false);
  assert.equal(FIELD_ADDITIONS.flatMap((item) => item.fields).length, 3);
});

test('resumes without writes when all three helper fields already exist in order', () => {
  const before = snapshot({
    analysisFields: [
      field('fldRank', '排名', 2),
      field('fldDate', '采集日期', 5),
      field('fldBatches', '已有有效批次数', 2),
      field('fldAppearances', '近8批出现次数', 2),
    ],
    historyFields: [
      field('fldHistoryRank', '排名', 2),
      field('fldHistoryDate', '采集日期', 5),
      field('fldBatchNumber', '批次编号', 2),
    ],
  });

  assert.deepEqual(buildFieldCreatePlan(before).creates, []);
});

test('refuses to append when another field already follows 采集日期', () => {
  const before = snapshot({
    analysisFields: [
      field('fldRank', '排名', 2),
      field('fldDate', '采集日期', 5),
      field('fldOther', '用户新增字段'),
    ],
  });

  assert.throws(() => buildFieldCreatePlan(before), /requires.*last existing field/iu);
});

test('mutation guard permits only the admitted field-create endpoints', () => {
  assert.doesNotThrow(() => assertHelperFieldMutation({
    method: 'POST',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables/${ANALYSIS_TABLE_ID}/fields`,
    body: { field_name: '已有有效批次数', type: 2 },
  }));

  for (const request of [
    {
      method: 'POST',
      path: `/bitable/v1/apps/${APP_TOKEN}/tables/${ANALYSIS_TABLE_ID}/records/batch_update`,
      body: { records: [] },
    },
    {
      method: 'POST',
      path: `/bitable/v1/apps/${APP_TOKEN}/tables/${KEYWORD_LIBRARY_TABLE_ID}/fields`,
      body: { field_name: '批次编号', type: 2 },
    },
    {
      method: 'POST',
      path: `/bitable/v1/apps/${APP_TOKEN}/tables/${HISTORY_TABLE_ID}/fields`,
      body: { field_name: '批次编号', type: 1 },
    },
  ]) {
    assert.throws(() => assertHelperFieldMutation(request), /blocked/i);
  }
});

test('verification rejects any existing-field or record mutation', () => {
  const before = snapshot();
  const plan = buildFieldCreatePlan(before);
  const after = appendFields(before, plan);

  assert.doesNotThrow(() => verifyFieldAddition({ before, after, plan }));

  const changedRecords = structuredClone(after);
  changedRecords[0].records[0].fields.搜索词 = '被改写';
  assert.throws(() => verifyFieldAddition({ before, after: changedRecords, plan }), /record data changed/iu);
});

test('verification accepts Feishu projecting newly created fields onto every record', () => {
  const before = snapshot();
  const plan = buildFieldCreatePlan(before);
  const after = appendFields(before, plan);
  after[0].records[0].fields.已有有效批次数 = null;
  after[0].records[0].fields.近8批出现次数 = null;
  after[1].records[0].fields.批次编号 = null;

  assert.doesNotThrow(() => verifyFieldAddition({ before, after, plan }));
});

test('difference summary reports changed field names without exposing cell values', () => {
  const before = snapshot();
  const after = structuredClone(before);
  after[0].records[0].fields.搜索词 = '已改变';
  after[1].records.push({ record_id: 'recAdded', fields: { 搜索词: '新增' } });

  assert.deepEqual(summarizeSnapshotDifference(before, after), {
    tables: [
      {
        tableName: ANALYSIS_TABLE_NAME,
        recordCountBefore: 1,
        recordCountAfter: 1,
        changedRecordCount: 1,
        addedRecordCount: 0,
        removedRecordCount: 0,
        changedFieldNames: ['搜索词'],
      },
      {
        tableName: HISTORY_TABLE_NAME,
        recordCountBefore: 1,
        recordCountAfter: 2,
        changedRecordCount: 0,
        addedRecordCount: 1,
        removedRecordCount: 0,
        changedFieldNames: [],
      },
    ],
  });
});
