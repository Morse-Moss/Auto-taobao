import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORMAL_TABLE_ID,
  assertFormalFieldMutation,
  assertRecordsUnchanged,
  buildFormalFieldPlan,
  verifyFormalTable,
} from './keyword-analysis-v2-formal-migration.mjs';

const option = (id, name) => ({ id, name, color: 0 });

const fields = [
  { field_id: 'fldMerge', field_name: '标准归并词', type: 3, property: { options: [option('optMerge', '浴缸')] } },
  { field_id: 'fldClass', field_name: '关键词分类', type: 3, property: { options: [
    option('optBig', '大词'), option('optMaterial', '材质词'), option('optScene', '场景词'),
    option('optPain', '痛点词'), option('optStyle', '款式词'), option('optDesign', '风格词'),
    option('optSize', '尺寸词'), option('optFunction', '功能词'),
  ] } },
  { field_id: 'fldLabels', field_name: '细分标签', type: 4, property: { options: [
    option('optOldBath', '浴缸'), option('optOldSmall', '小户型'),
  ] } },
  { field_id: 'fldIntent', field_name: '用户意图', type: 3, property: { options: [
    option('optKnow', '了解型'), option('optCompare', '对比型'), option('optBuy', '购买型'),
    option('optIdea', '灵感型'), option('optSolve', '问题解决型'),
    option('optDirty', '你是一个关键词意图分析助手，请结合上下文输出'),
  ] } },
  ...Array.from({ length: 18 }, (_, index) => ({
    field_id: `fldOther${index}`,
    field_name: `其他${index}`,
    type: 1,
  })),
];

test('formal plan changes only four existing fields and creates no fields', () => {
  const plan = buildFormalFieldPlan(fields, { usedIntentOptionNames: new Set(['了解型']) });
  assert.deepEqual(plan.updates.map((item) => item.fieldName), [
    '关键词分类', '细分标签', '用户意图', '标准归并词',
  ]);
  assert.deepEqual(plan.creates, []);
  assert.equal(plan.updates.at(-1).body.type, 1);
});

test('formal plan preserves option ids, adds required values, and retains legacy labels', () => {
  const plan = buildFormalFieldPlan(fields, { usedIntentOptionNames: new Set(['了解型']) });
  const classification = plan.updates.find((item) => item.fieldName === '关键词分类').body.property.options;
  assert.equal(classification.find((item) => item.name === '大词').id, 'optBig');
  assert.ok(classification.some((item) => item.name === '品牌词'));

  const labels = plan.updates.find((item) => item.fieldName === '细分标签').body.property.options;
  assert.equal(labels.find((item) => item.name === '浴缸').id, 'optOldBath');
  assert.ok(labels.some((item) => item.name === '场景/小户型'));
  assert.ok(labels.some((item) => item.name === '款式/步入式'));

  const intents = plan.updates.find((item) => item.fieldName === '用户意图').body.property.options;
  assert.deepEqual(intents.map((item) => item.name), ['了解型', '对比型', '购买型', '灵感型', '问题解决型']);
  assert.equal(intents[0].id, 'optKnow');
});

test('formal plan refuses to remove an intent option that is still used', () => {
  assert.throws(
    () => buildFormalFieldPlan(fields, {
      usedIntentOptionNames: new Set(['了解型', '你是一个关键词意图分析助手，请结合上下文输出']),
    }),
    /used intent option/i,
  );
});

test('formal mutation guard blocks records, creates, deletes, other tables, and unknown fields', () => {
  const allowed = new Map([
    ['fldMerge', '标准归并词'], ['fldClass', '关键词分类'],
    ['fldLabels', '细分标签'], ['fldIntent', '用户意图'],
  ]);
  assert.doesNotThrow(() => assertFormalFieldMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/app/tables/${FORMAL_TABLE_ID}/fields/fldMerge`,
    body: { field_name: '标准归并词', type: 1 },
  }, { appToken: 'app', allowedFields: allowed }));
  for (const request of [
    { method: 'POST', path: `/bitable/v1/apps/app/tables/${FORMAL_TABLE_ID}/records/batch_create`, body: {} },
    { method: 'POST', path: `/bitable/v1/apps/app/tables/${FORMAL_TABLE_ID}/fields`, body: {} },
    { method: 'DELETE', path: `/bitable/v1/apps/app/tables/${FORMAL_TABLE_ID}/fields/fldMerge` },
    { method: 'PUT', path: '/bitable/v1/apps/app/tables/tblOther/fields/fldMerge', body: { field_name: '标准归并词' } },
    { method: 'PUT', path: `/bitable/v1/apps/app/tables/${FORMAL_TABLE_ID}/fields/fldOther`, body: { field_name: '其他' } },
  ]) {
    assert.throws(
      () => assertFormalFieldMutation(request, { appToken: 'app', allowedFields: allowed }),
      /blocked/i,
    );
  }
});

test('formal verification requires the exact table identity and baseline dimensions', () => {
  assert.doesNotThrow(() => verifyFormalTable({
    tableName: '关键词分析 V1（修正版）', fields, recordCount: 300,
  }));
  assert.throws(() => verifyFormalTable({
    tableName: '关键词分析 V1（修正版）', fields, recordCount: 299,
  }), /300 records/i);
  assert.throws(() => verifyFormalTable({
    tableName: '关键词分析 V1', fields, recordCount: 300,
  }), /table name/i);
});

test('record comparison is order-independent and detects any cell mutation', () => {
  const before = [
    { record_id: 'rec1', fields: { 搜索词: '浴缸', 细分标签: ['浴缸'] } },
    { record_id: 'rec2', fields: { 搜索词: '小浴缸', 用户意图: '了解型' } },
  ];
  assert.doesNotThrow(() => assertRecordsUnchanged(before, [...before].reverse()));
  const changed = structuredClone(before);
  changed[0].fields.搜索词 = '被修改';
  assert.throws(() => assertRecordsUnchanged(before, changed), /record data changed/i);
});
