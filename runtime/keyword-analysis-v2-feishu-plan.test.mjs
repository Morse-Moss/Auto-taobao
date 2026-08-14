import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEST_TABLE_ID,
  assertTestTableMutation,
  buildTestTableFieldPlan,
} from './keyword-analysis-v2-feishu-plan.mjs';

const currentFields = [
  { field_id: 'fldRank', field_name: '排名', type: 1 },
  { field_id: 'fldSearch', field_name: '搜索词', type: 1 },
  { field_id: 'fldPopularity', field_name: '搜索人气', type: 1 },
  { field_id: 'fldClick', field_name: '点击率', type: 1 },
  { field_id: 'fldTrade', field_name: '支付转化率', type: 1 },
  { field_id: 'fldMerge', field_name: '标准归并词', type: 3 },
  { field_id: 'fldClass', field_name: '关键词分类', type: 3 },
  { field_id: 'fldLabels', field_name: '细分标签', type: 4 },
  { field_id: 'fldIntent', field_name: '用户意图', type: 3 },
  { field_id: 'fldSource', field_name: '来源渠道', type: 20 },
];

test('field plan reuses the existing schema and creates no fields', () => {
  const plan = buildTestTableFieldPlan(currentFields, {
    batchId: 'TEST-YG-20260811-01',
  });
  assert.deepEqual(plan.updates.map((item) => item.fieldName), [
    '排名', '标准归并词', '关键词分类', '细分标签', '用户意图', '平台来源',
  ]);
  assert.deepEqual(plan.creates, []);
  assert.equal(plan.updates.find((item) => item.fieldName === '排名').body.type, 2);
  assert.equal(plan.updates.find((item) => item.fieldName === '标准归并词').body.type, 1);
  assert.deepEqual(
    plan.updates.find((item) => item.fieldName === '关键词分类').body.property.options.map((item) => item.name),
    ['大词', '品牌词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词'],
  );
  assert.ok(
    plan.updates.find((item) => item.fieldName === '细分标签').body.property.options
      .every((item) => item.name.includes('/')),
  );
  assert.deepEqual(
    plan.updates.find((item) => item.fieldName === '用户意图').body.property.options.map((item) => item.name),
    ['了解型', '对比型', '购买型', '灵感型', '问题解决型'],
  );
});

test('field plan never creates fields on resume', () => {
  const initial = buildTestTableFieldPlan(currentFields, { batchId: 'TEST-YG-20260811-01' });
  const resumed = buildTestTableFieldPlan(currentFields, { batchId: 'TEST-YG-20260811-01' });
  assert.deepEqual(initial.creates, []);
  assert.deepEqual(resumed.creates, []);
});

test('mutation guard blocks records, deletes, other tables, and unknown fields', () => {
  const allowedUpdate = {
    method: 'PUT',
    path: `/bitable/v1/apps/app/tables/${TEST_TABLE_ID}/fields/fldRank`,
    body: { field_name: '排名', type: 2 },
  };
  assert.doesNotThrow(() => assertTestTableMutation(allowedUpdate, {
    appToken: 'app',
    allowedExistingFieldIds: new Set(['fldRank']),
  }));
  assert.throws(() => assertTestTableMutation({
    method: 'POST',
    path: `/bitable/v1/apps/app/tables/${TEST_TABLE_ID}/records/batch_create`,
    body: { records: [] },
  }, { appToken: 'app', allowedExistingFieldIds: new Set(['fldRank']) }), /blocked/i);
  assert.throws(() => assertTestTableMutation({
    method: 'DELETE', path: `/bitable/v1/apps/app/tables/${TEST_TABLE_ID}`, body: undefined,
  }, { appToken: 'app', allowedExistingFieldIds: new Set(['fldRank']) }), /blocked/i);
  assert.throws(() => assertTestTableMutation({
    method: 'PUT', path: '/bitable/v1/apps/app/tables/tblFormal/fields/fldRank', body: { field_name: '排名', type: 2 },
  }, { appToken: 'app', allowedExistingFieldIds: new Set(['fldRank']) }), /blocked/i);
  assert.throws(() => assertTestTableMutation({
    method: 'POST', path: `/bitable/v1/apps/app/tables/${TEST_TABLE_ID}/fields`, body: { field_name: '审核人', type: 1 },
  }, { appToken: 'app', allowedExistingFieldIds: new Set(['fldRank']) }), /blocked/i);
});
