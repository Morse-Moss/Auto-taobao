import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertCollectionDateAvailable,
  assertAuthorizedMutation,
  assertHistoryFieldContract,
  assertWeeklyFieldContract,
  buildBatchValiditySchemaPlan,
  buildBusinessRecords,
  buildIdentityKey,
  buildLibrarySeed,
  countHistoryBatches,
  normalizeKeyword,
  parseOptions,
  parseSourceCsv,
  planExistingRecords,
  planInvalidBatchUpdates,
  planPreviousBatchUpdates,
} from '../scripts/update-weekly-base.mjs';
import { activeProfileName, envFilePath } from '../../../runtime/feishu-targets.mjs';

const baseArgs = [
  '--base-url', 'https://example.feishu.cn/base/appToken',
  '--source-csv', 'D:\\data\\week.csv',
  '--source-xlsx', 'D:\\data\\week.xlsx',
  '--weekly-table-id', 'tblWeekly',
  '--weekly-table-name', '关键词分析 V1（2026-08-14）',
  '--history-table-id', 'tblHistory',
  '--library-table-id', 'tblLibrary',
  '--protected-table-id', 'tblPrevious',
  '--protected-table-name', '关键词分析 V1（修正版）',
  '--collection-date', '2026-08-14',
  '--batch-number', '2',
  '--expected-source-rows', '267',
  '--expected-history-before', '300',
];

// 默认凭据文件必须来自租户登记表。
// 反例（2026-09-20 实测）：默认值曾是旧租户的 E:/小红书/.env.local，而 base 已搬到
// kcne618basvj —— 「旧租户凭据读新租户 base」报 91403 Forbidden，会被误读成权限问题。
// 对着访问器断言而不是写死字面量（写死等于把当前默认值固化成测试 —— 坑 34）。
test('the default credentials file comes from the tenant registry', () => {
  assert.equal(parseOptions(baseArgs).envFile, envFilePath(activeProfileName()));

  const source = readFileSync(new URL('../scripts/update-weekly-base.mjs', import.meta.url), 'utf8');
  assert.match(source, /envFile: envFilePath\(activeProfileName\(\)\)/u);
  assert.doesNotMatch(source, /envFile: 'E:\//u);
});

test('weekly update CLI is read-only unless both Base and weekly table are confirmed', () => {
  const dryRun = parseOptions(baseArgs);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.appToken, 'appToken');
  assert.equal(dryRun.batchNumber, 2);
  assert.equal(dryRun.previousBatchNumber, 1);
  assert.equal(dryRun.protectedTableName, '关键词分析 V1（修正版）');

  const protectedNameIndex = baseArgs.indexOf('--protected-table-name');
  assert.throws(() => parseOptions([
    ...baseArgs.slice(0, protectedNameIndex),
    ...baseArgs.slice(protectedNameIndex + 2),
  ]), /protectedTableName/u);

  assert.throws(() => parseOptions([...baseArgs, '--apply']), /confirm-base/u);
  assert.throws(() => parseOptions([
    ...baseArgs, '--apply', '--confirm-base', 'appToken', '--confirm-weekly-table', 'wrong',
  ]), /does not match/u);

  const apply = parseOptions([
    ...baseArgs,
    '--apply',
    '--confirm-base', 'appToken',
    '--confirm-weekly-table', 'tblWeekly',
  ]);
  assert.equal(apply.apply, true);

  const batchIndex = baseArgs.indexOf('--batch-number');
  const correction = parseOptions([
    ...baseArgs.slice(0, batchIndex + 1), '3', ...baseArgs.slice(batchIndex + 2),
    '--invalidate-history-batch', '2',
    '--expected-invalid-batch-rows', '267',
  ]);
  assert.equal(correction.invalidateHistoryBatch, 2);
  assert.equal(correction.expectedInvalidBatchRows, 267);
});

test('source CSV preserves displayed ranges and requires contiguous unique ranks', () => {
  const csv = [
    '排名,搜索词,搜索人气,点击率,支付转化率',
    '1,浴缸,5000 ~ 1万,59%,1% ~ 2.5%',
    '2,小浴缸,150 ~ 300,61%,-',
  ].join('\r\n');
  assert.deepEqual(parseSourceCsv(csv), [
    { 排名: '1', 搜索词: '浴缸', 搜索人气: '5000 ~ 1万', 点击率: '59%', 支付转化率: '1% ~ 2.5%' },
    { 排名: '2', 搜索词: '小浴缸', 搜索人气: '150 ~ 300', 点击率: '61%', 支付转化率: '-' },
  ]);
  assert.throws(() => parseSourceCsv(csv.replace('2,小浴缸', '3,小浴缸')), /contiguous/u);
  assert.throws(() => parseSourceCsv(csv.replace('2,小浴缸', '1,小浴缸')), /unique/u);
});

test('keyword identities are stable within a category and missing library rows contain no invented number', () => {
  assert.equal(normalizeKeyword(' ＴＯＴＯ  浴缸 '), 'toto 浴缸');
  assert.notEqual(buildIdentityKey('浴缸', '浴缸'), buildIdentityKey('洗手台', '浴缸'));

  const rows = [
    { 排名: '1', 搜索词: '浴缸' },
    { 排名: '2', 搜索词: '小浴缸' },
  ];
  const existing = [{ fields: {
    唯一匹配键: buildIdentityKey('浴缸', '浴缸'),
    一级类目: '浴缸',
    原始关键词: '浴缸',
    规范化关键词: '浴缸',
    关键词编号: 'KW000001',
  } }];
  const seed = buildLibrarySeed(rows, existing, '浴缸');
  assert.equal(seed.missing.length, 1);
  assert.deepEqual(Object.keys(seed.missing[0]).sort(), [
    '一级类目', '原始关键词', '唯一匹配键', '规范化关键词',
  ].sort());
});

test('business writes separate the weekly table from cumulative history', () => {
  const rows = [
    { 排名: '1', 搜索词: '浴缸', 搜索人气: '5000 ~ 1万', 点击率: '59%', 支付转化率: '1% ~ 2.5%' },
  ];
  const mapping = new Map([[buildIdentityKey('浴缸', '浴缸'), 'KW000001']]);
  const desired = buildBusinessRecords(rows, mapping, {
    category: '浴缸', collectionDate: '2026-08-14', batchNumber: 2,
  });
  assert.equal(desired.weekly.length, 1);
  assert.equal(desired.history.length, 1);
  assert.equal(desired.weekly[0].关键词编号, 'KW000001');
  assert.equal(desired.weekly[0].批次编号, undefined);
  assert.equal(desired.history[0].批次编号, 2);
  assert.equal(desired.history[0].批次有效性, '有效');
  assert.equal(desired.weekly[0].采集日期, Date.parse('2026-08-14T00:00:00+08:00'));
});

test('history validity schema is additive and the correction plan is exact and idempotent', () => {
  assert.deepEqual(buildBatchValiditySchemaPlan([]), {
    creates: [{ fieldName: '批次有效性', body: { field_name: '批次有效性', type: 1 } }],
  });
  assert.deepEqual(buildBatchValiditySchemaPlan([
    { field_id: 'fldValidity', field_name: '批次有效性', type: 1 },
  ]), { creates: [] });
  assert.throws(() => buildBatchValiditySchemaPlan([
    { field_id: 'fldValidity', field_name: '批次有效性', type: 2 },
  ]), /text type 1/iu);

  const records = [
    { record_id: 'b1', fields: { 批次编号: 1, 批次有效性: null } },
    { record_id: 'b2a', fields: { 批次编号: 2, 批次有效性: null } },
    { record_id: 'b2b', fields: { 批次编号: 2, 批次有效性: '无效-周期错误' } },
  ];
  assert.deepEqual(planInvalidBatchUpdates(records, {
    invalidateHistoryBatch: 2,
    expectedInvalidBatchRows: 2,
  }), [{ record_id: 'b2a', fields: { 批次有效性: '无效-周期错误' } }]);
  assert.deepEqual(planInvalidBatchUpdates(records.map((record) => ({
    ...record,
    fields: { ...record.fields, ...(record.fields.批次编号 === 2 ? { 批次有效性: '无效-周期错误' } : {}) },
  })), {
    invalidateHistoryBatch: 2,
    expectedInvalidBatchRows: 2,
  }), []);
  assert.throws(() => planInvalidBatchUpdates(records, {
    invalidateHistoryBatch: 2,
    expectedInvalidBatchRows: 267,
  }), /expected 267 rows/iu);
});

test('resume planner adds only missing ranks and rejects conflicts or extras', () => {
  const desired = [
    { 排名: '1', 搜索词: '浴缸', 关键词编号: 'KW000001', 采集日期: 1 },
    { 排名: '2', 搜索词: '小浴缸', 关键词编号: 'KW000002', 采集日期: 1 },
  ];
  const existing = [{ record_id: 'rec1', fields: desired[0] }];
  assert.deepEqual(planExistingRecords(existing, desired, ['排名', '搜索词', '关键词编号', '采集日期']), {
    create: [desired[1]],
    matchedCount: 1,
  });
  assert.throws(() => planExistingRecords([
    { record_id: 'rec1', fields: { ...desired[0], 搜索词: '冲突' } },
  ], desired, ['排名', '搜索词', '关键词编号', '采集日期']), /conflict/u);
  assert.throws(() => planExistingRecords([
    ...existing, { record_id: 'extra', fields: { 排名: '3' } },
  ], desired, ['排名', '搜索词', '关键词编号', '采集日期']), /unexpected rank/u);
});

test('previous history rows can only move from blank to the immediately preceding batch', () => {
  const records = [
    { record_id: 'r1', fields: { 批次编号: null } },
    { record_id: 'r2', fields: { 批次编号: 1 } },
  ];
  assert.deepEqual(planPreviousBatchUpdates(records, 1), [
    { record_id: 'r1', fields: { 批次编号: 1 } },
  ]);
  assert.throws(() => planPreviousBatchUpdates([
    { record_id: 'r1', fields: { 批次编号: 9 } },
  ], 1), /unexpected batch/u);
});

test('later weekly runs preserve every valid older history batch', () => {
  const records = [
    { record_id: 'batch1', fields: { 批次编号: 1 } },
    { record_id: 'batch2', fields: { 批次编号: 2 } },
  ];
  assert.deepEqual(planPreviousBatchUpdates(records, 2), []);
  assert.throws(() => planPreviousBatchUpdates([
    ...records,
    { record_id: 'blank', fields: { 批次编号: null } },
  ], 2), /blank batch/u);
});

test('history receipts report a dynamic batch distribution', () => {
  const records = [
    { fields: { 批次编号: 1 } },
    { fields: { 批次编号: 1 } },
    { fields: { 批次编号: 2 } },
    { fields: { 批次编号: 3 } },
  ];
  assert.deepEqual(countHistoryBatches(records), { 1: 2, 2: 1, 3: 1 });
});

test('deprecated valid-batch helper is no longer required by the weekly contract', () => {
  const required = [
    '排名', '搜索词', '搜索人气', '点击率', '支付转化率', '关键词编号', '采集日期',
    '一级类目', '主关键词', '原始关键词', '标准归并词', '关键词分类', '细分标签',
    '用户意图', '来源渠道', '搜索热度', '内容热度', '交易热度',
    '是否重点词', '优先级', '对应产品方向', '近2周重点达标次数', '灰豚话题浏览量',
  ].map((field_name, index) => ({ field_id: `fld${index}`, field_name }));
  assert.doesNotThrow(() => assertWeeklyFieldContract(required));
  assert.throws(() => assertWeeklyFieldContract(required.filter((field) => field.field_name !== '近2周重点达标次数')), /近2周重点达标次数/u);
});

test('history contract requires the per-batch key-word snapshot field', () => {
  const names = [
    '排名', '搜索词', '搜索人气', '点击率', '支付转化率', '关键词编号', '采集日期', '批次编号',
    '一级类目', '主关键词', '原始关键词', '来源渠道', '搜索热度', '交易热度',
    '出现状态', '排名环比', '搜索人气环比', '交易环比', '综合趋势变化', '重点达标', '批次有效性',
  ];
  const fields = names.map((field_name, index) => ({ field_id: `fld${index}`, field_name }));
  assert.doesNotThrow(() => assertHistoryFieldContract(fields));
  assert.throws(() => assertHistoryFieldContract(fields.filter((field) => field.field_name !== '重点达标')), /重点达标/u);
});

test('a collection date can resume its own batch but cannot create a second batch', () => {
  const date = Date.parse('2026-08-14T00:00:00+08:00');
  assert.doesNotThrow(() => assertCollectionDateAvailable([
    { fields: { 批次编号: 2, 采集日期: date } },
  ], { batchNumber: 2, collectionDate: '2026-08-14' }));
  assert.throws(() => assertCollectionDateAvailable([
    { fields: { 批次编号: 2, 采集日期: date } },
  ], { batchNumber: 3, collectionDate: '2026-08-14' }), /already belongs to batch 2/iu);
});

test('mutation guard permits only the four admitted weekly write shapes', () => {
  const scope = {
    appToken: 'appToken', weeklyTableId: 'tblWeekly', historyTableId: 'tblHistory',
    libraryTableId: 'tblLibrary', previousBatchNumber: 1, currentBatchNumber: 2,
    allowBatchValidityFieldCreate: true,
    invalidBatchRecordIds: new Set(['rInvalid']),
  };
  const root = '/bitable/v1/apps/appToken/tables';
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblHistory/fields`,
    body: { field_name: '批次有效性', type: 1 },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblLibrary/records/batch_create`,
    body: { records: [{ fields: { 唯一匹配键: 'k', 一级类目: '浴缸', 原始关键词: '浴缸', 规范化关键词: '浴缸' } }] },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblWeekly/records/batch_create`,
    body: { records: [{ fields: { 排名: '1', 搜索词: '浴缸', 搜索人气: 'x', 点击率: 'x', 支付转化率: '-', 关键词编号: 'KW000001', 采集日期: 1 } }] },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblHistory/records/batch_update`,
    body: { records: [{ record_id: 'r1', fields: { 批次编号: 1 } }] },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblHistory/records/batch_create`,
    body: { records: [{ fields: { 排名: '1', 搜索词: '浴缸', 搜索人气: 'x', 点击率: 'x', 支付转化率: '-', 关键词编号: 'KW000001', 采集日期: 1, 批次编号: 2, 批次有效性: '有效' } }] },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST', path: `${root}/tblHistory/records/batch_update`,
    body: { records: [{ record_id: 'rInvalid', fields: { 批次有效性: '无效-周期错误' } }] },
  }, scope));

  for (const request of [
    { method: 'DELETE', path: `${root}/tblWeekly`, body: {} },
    { method: 'POST', path: `${root}/tblPrevious/records/batch_update`, body: { records: [] } },
    { method: 'POST', path: `${root}/tblHistory/records/batch_update`, body: { records: [{ record_id: 'r1', fields: { 采集日期: 1 } }] } },
  ]) {
    assert.throws(() => assertAuthorizedMutation(request, scope), /Blocked unauthorized mutation/u);
  }
});
