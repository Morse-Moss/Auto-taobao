import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertValidationMutation,
  buildValidationRows,
  buildValidationTableDefinition,
  verifyExpectedRows,
} from './verify-weekly-decision-formulas-live.mjs';

const APP_TOKEN = 'appToken';
const TABLE_ID = 'tblValidation';
const TABLE_NAME = '__公式验证_两周实时联动_20260817T120000Z';

test('validation fixture covers live two-week decisions and unknown evidence', () => {
  const rows = buildValidationRows();
  assert.deepEqual(rows.map((row) => row.fields.搜索词), [
    '__验证_主推联动',
    '__验证_A候选联动',
    '__验证_探索联动',
    '__验证_品牌排除',
    '__验证_缺历史证据',
  ]);
  const candidate = rows.find((row) => row.fields.搜索词 === '__验证_A候选联动');
  assert.equal(candidate.fields.灰豚话题浏览量, null);
  assert.equal(candidate.expected.优先级, 'A候选');
  assert.equal(candidate.expected.近2周A级达标次数, '');
  const unknown = rows.find((row) => row.fields.搜索词 === '__验证_缺历史证据');
  assert.equal(unknown.expected.近2周重点达标次数, '');
  assert.equal(unknown.expected.是否重点词, '待数据');
});

test('validation mutation guard permits only the isolated table and approved test rows', () => {
  const definition = buildValidationTableDefinition(TABLE_NAME);
  const rows = buildValidationRows();
  const scope = { appToken: APP_TOKEN, tableId: TABLE_ID, tableName: TABLE_NAME, definition, rows };
  assert.doesNotThrow(() => assertValidationMutation({
    method: 'POST',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables`,
    body: { table: definition },
  }, { ...scope, tableId: null }));
  assert.doesNotThrow(() => assertValidationMutation({
    method: 'POST',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`,
    body: { records: rows.map(({ fields }) => ({ fields })) },
  }, scope));
  assert.doesNotThrow(() => assertValidationMutation({
    method: 'POST',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`,
    body: { records: [{ record_id: 'recCandidate', fields: { 灰豚话题浏览量: 10_000_000 } }] },
  }, scope));
  assert.throws(() => assertValidationMutation({
    method: 'POST',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables/tblFormal/records/batch_update`,
    body: { records: [{ record_id: 'recFormal', fields: { 灰豚话题浏览量: 10_000_000 } }] },
  }, scope), /Blocked unauthorized/iu);
  assert.throws(() => assertValidationMutation({
    method: 'DELETE',
    path: `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}`,
  }, scope), /Blocked unauthorized/iu);
});

test('live result verification rejects missing, wrong, and formula-error outputs', () => {
  const expected = buildValidationRows();
  const records = expected.map((row, index) => ({
    record_id: `rec${index}`,
    fields: { ...row.fields, ...row.expected },
  }));
  assert.deepEqual(verifyExpectedRows(records, expected), { rowsVerified: expected.length });
  const wrong = structuredClone(records);
  wrong[1].fields.优先级 = 'B-持续观察';
  assert.throws(() => verifyExpectedRows(wrong, expected), /outcome mismatch/iu);
  const errored = structuredClone(records);
  errored[0].fields.近2周重点达标次数 = '#ERROR!';
  assert.throws(() => verifyExpectedRows(errored, expected), /formula error/iu);
});
