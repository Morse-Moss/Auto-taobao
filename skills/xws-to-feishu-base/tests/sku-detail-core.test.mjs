import assert from 'node:assert/strict';
import test from 'node:test';

import * as competitorCore from '../scripts/competitor-v2-core.mjs';

const textField = (field_id, field_name) => ({ field_id, field_name, type: 1 });
const selectField = (field_id, field_name, type, names) => ({
  field_id,
  field_name,
  type,
  property: { options: names.map((name) => ({ id: `${field_id}-${name}`, name })) },
});

function currentSkuFields() {
  return [
    textField('fldSkuUrl', '商品链接'),
    textField('fldSkuTitle', '商品标题'),
    selectField('fldSkuClass', '竞品分类', 4, ['A-爆款竞品']),
    textField('fldSkuName', 'SKU名称'),
    textField('fldSkuSpec', 'SKU规格'),
    textField('fldSkuSize', 'SKU尺寸'),
    textField('fldSkuSummary', '尺寸汇总'),
    selectField('fldSkuSpace', '适用空间', 4, ['小户型', '常规卫生间', '大户型']),
    selectField('fldSkuStatus', '采集状态', 3, ['待采集', '已采集', '需人工核验']),
    selectField('fldSkuPending', '待补数据项', 4, ['SKU明细', 'SKU尺寸', '主图空间判断']),
  ];
}

test('SKU detail field contract has a reproducible two-space outcome and no retired space', () => {
  const fields = competitorCore.SKU_DETAIL_FIELDS;
  assert.deepEqual(fields.map((field) => field.name), [
    '商品链接', '商品标题', '竞品分类', 'SKU名称', 'SKU规格',
    'SKU尺寸', '尺寸汇总', '适用空间', '空间判定状态', '空间判定依据',
    '商品ID', 'SKU唯一键', '采集状态', '待补数据项',
  ]);
  const space = fields.find((field) => field.name === '适用空间');
  assert.equal(space.type, 3);
  assert.deepEqual(space.property.options.map((option) => option.name), ['小户型', '常规卫生间']);
  assert.doesNotMatch(JSON.stringify(fields), /大户型/u);
});

test('SKU space rule uses explicit normalized dimensions and sends all ambiguous cases to review', () => {
  assert.equal(typeof competitorCore.classifySkuSpace, 'function');
  const classify = (skuSize, skuSpec = '') => competitorCore.classifySkuSpace({ skuSize, skuSpec });

  for (const [skuSize, expectedSpace] of [
    ['800mm', '小户型'],
    ['1.2米', '小户型'],
    ['1.3m', '常规卫生间'],
    ['180cm', '常规卫生间'],
  ]) {
    const result = classify(skuSize);
    assert.equal(result.applicableSpace, expectedSpace);
    assert.equal(result.status, '已判定');
    assert.match(result.skuSize, /m$/u);
  }

  for (const skuSize of ['1.25m', '1.9m', '', '800mm/1.5m', '0.8-1.2m']) {
    const result = classify(skuSize);
    assert.equal(result.applicableSpace, null, skuSize);
    assert.equal(result.status, '需人工核验', skuSize);
  }
  assert.equal(classify('', '1.2米').applicableSpace, '小户型');
  const thicknessInSpec = classify('1.6m', 'pmma（25mm厚）亚光白+有溢水+下水器+排水软管');
  assert.equal(thicknessInSpec.applicableSpace, '常规卫生间');
  assert.equal(thicknessInSpec.status, '已判定');
  assert.doesNotMatch(JSON.stringify(classify('1.9m')), /大户型/u);
});

test('SKU dimension summaries are sorted, unit-normalized, and do not infer missing dimensions', () => {
  assert.equal(typeof competitorCore.summarizeSkuDimensions, 'function');
  assert.equal(competitorCore.summarizeSkuDimensions(['170cm', '1500mm', '1.5米']), '1.5m-1.7m');
  assert.equal(competitorCore.summarizeSkuDimensions(['', '型号A', '800']), '');
});

test('SKU schema migration plan changes only an empty SKU table and creates the reciprocal main-table relation', () => {
  assert.equal(typeof competitorCore.buildSkuSchemaMigrationPlan, 'function');
  const plan = competitorCore.buildSkuSchemaMigrationPlan({
    appToken: 'appSku',
    mainTableId: 'tblMain',
    skuTableId: 'tblSku',
    expectedMainRows: 1333,
    mainRecordCount: 1333,
    skuRecordCount: 0,
    mainFields: [textField('fldMainTitle', '商品标题')],
    skuFields: currentSkuFields(),
  });

  assert.deepEqual(
    plan.operations.filter((operation) => operation.method === 'PUT').map((operation) => operation.fieldName),
    ['竞品分类', '适用空间', '待补数据项'],
  );
  assert.deepEqual(
    plan.operations.filter((operation) => operation.method === 'POST').map((operation) => operation.fieldName),
    ['所属竞品', '空间判定状态', '空间判定依据', '商品ID', 'SKU唯一键'],
  );
  const relation = plan.operations.find((operation) => operation.fieldName === '所属竞品');
  assert.deepEqual(relation.body, {
    field_name: '所属竞品',
    type: 21,
    property: { multiple: false, table_id: 'tblMain', back_field_name: 'SKU采集明细' },
  });
  const space = plan.operations.find((operation) => operation.fieldName === '适用空间');
  assert.equal(space.body.type, 3);
  assert.deepEqual(space.body.property.options.map((option) => option.name), ['小户型', '常规卫生间']);
  assert.doesNotMatch(JSON.stringify(plan), /大户型/u);

  assert.throws(() => competitorCore.buildSkuSchemaMigrationPlan({
    appToken: 'appSku', mainTableId: 'tblMain', skuTableId: 'tblSku', expectedMainRows: 1333,
    mainRecordCount: 1333, skuRecordCount: 1, mainFields: [], skuFields: currentSkuFields(),
  }), /SKU明细 must be empty/u);
});

test('SKU schema mutation guard rejects record, delete, and main-table requests', () => {
  assert.equal(typeof competitorCore.assertSkuSchemaMutation, 'function');
  const scope = {
    appToken: 'appSku',
    skuTableId: 'tblSku',
    operations: [{
      method: 'PUT', fieldId: 'fldSkuSpace', fieldName: '适用空间',
      body: { field_name: '适用空间', type: 3, property: { options: [{ name: '小户型' }, { name: '常规卫生间' }] } },
    }],
  };
  assert.doesNotThrow(() => competitorCore.assertSkuSchemaMutation({
    method: 'PUT',
    path: '/bitable/v1/apps/appSku/tables/tblSku/fields/fldSkuSpace',
    body: scope.operations[0].body,
  }, scope));
  assert.throws(() => competitorCore.assertSkuSchemaMutation({
    method: 'POST',
    path: '/bitable/v1/apps/appSku/tables/tblSku/records/batch_create',
    body: { records: [] },
  }, scope), /Blocked SKU schema mutation/u);
  assert.throws(() => competitorCore.assertSkuSchemaMutation({
    method: 'DELETE',
    path: '/bitable/v1/apps/appSku/tables/tblSku/fields/fldSkuSpace',
    body: {},
  }, scope), /Blocked SKU schema mutation/u);
  assert.throws(() => competitorCore.assertSkuSchemaMutation({
    method: 'PUT',
    path: '/bitable/v1/apps/appSku/tables/tblMain/fields/fldMainTitle',
    body: scope.operations[0].body,
  }, scope), /Blocked SKU schema mutation/u);
});
