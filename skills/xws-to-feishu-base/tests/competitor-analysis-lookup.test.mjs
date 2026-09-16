// 线上竞品主表的「尺寸」「适用空间」是 19 查找引用（Lookup），不是声明里的
// TEXT/MULTI_SELECT。这组测试把由此产生的契约钉住：
//   * Lookup 可以被公式引用（可读），但绝不能进任何记录写入计划（不可写）；
//   * 缺项判据按类型分流，且公式串与本地复核谓词共用同一份来源；
//   * 真正不支持的类型（日期/复选框/附件…）仍然 fail-closed。
import assert from 'node:assert/strict';
import test from 'node:test';

import * as competitorCore from '../scripts/competitor-v2-core.mjs';

const TEXT = 1;
const NUMBER = 2;
const MULTI_SELECT = 4;
const LOOKUP = 19;
const FORMULA = 20;
const ATTRIBUTE_NAMES = ['材质分类', '外形', '安装方式', '功能', '风格'];

function liveFields({ sizeType = LOOKUP, spaceType = LOOKUP, attributeType = TEXT } = {}) {
  return [
    { field_id: 'fldTitle', field_name: '商品标题', type: TEXT },
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: FORMULA, property: { formula_expression: 'x' } },
    { field_id: 'fldExclusion', field_name: '排除原因', type: FORMULA, property: { formula_expression: 'x' } },
    { field_id: 'fldPrice', field_name: '价格', type: NUMBER },
    { field_id: 'fldRaw', field_name: '月收货人数', type: TEXT },
    { field_id: 'fldCount', field_name: '月收货人数计算值', type: FORMULA },
    { field_id: 'fldBasis', field_name: '计算口径', type: FORMULA },
    { field_id: 'fldAmount', field_name: '月收货金额', type: FORMULA },
    { field_id: 'fldBand', field_name: '客单价带分类', type: FORMULA },
    { field_id: 'fldClass', field_name: '竞品分类', type: FORMULA },
    ...ATTRIBUTE_NAMES.map((name, index) => ({
      field_id: `fldAttr${index}`, field_name: name, type: attributeType,
      ...(attributeType === MULTI_SELECT ? { property: { options: [] } } : {}),
    })),
    { field_id: 'fldSize', field_name: '尺寸', type: sizeType },
    { field_id: 'fldSpace', field_name: '适用空间', type: spaceType },
    { field_id: 'fldStatus', field_name: '数据状态', type: FORMULA },
    { field_id: 'fldPending', field_name: '待补数据项', type: FORMULA },
  ];
}

function pendingFormula(plan) {
  return plan.formulas.find((item) => item.fieldName === '待补数据项').body.property.formula_expression;
}

test('analysis descriptors separate the declared type from the live read-only lookup', () => {
  const described = new Map(
    competitorCore.describeCompetitorAnalysisFields(liveFields()).map((item) => [item.name, item]),
  );
  assert.equal(described.get('尺寸').type, LOOKUP);
  assert.equal(described.get('尺寸').declaredType, TEXT);
  assert.equal(described.get('尺寸').writable, false);
  assert.equal(described.get('适用空间').writable, false);
  assert.equal(described.get('材质分类').writable, true);

  // 只有记录值、拿不到 schema 的调用方回落到声明类型 → 历史判据不变。
  const declaredOnly = new Map(
    competitorCore.describeCompetitorAnalysisFields([]).map((item) => [item.name, item]),
  );
  assert.equal(declaredOnly.get('尺寸').type, TEXT);
  assert.equal(declaredOnly.get('尺寸').writable, true);
  assert.equal(declaredOnly.get('适用空间').type, MULTI_SELECT);
});

test('field migration plan accepts live lookup 尺寸/适用空间 and still references them from formulas', () => {
  const plan = competitorCore.buildCompetitorFieldMigrationPlan({ tableId: 'tblMain', fields: liveFields() });
  const pending = pendingFormula(plan);
  assert.match(pending, /ISBLANK\(bitable::\$table\[tblMain\]\.\$field\[fldSize\]\)/u);
  assert.match(pending, /ISBLANK\(bitable::\$table\[tblMain\]\.\$field\[fldSpace\]\)/u);
  // 查找引用里不会出现哨兵文本，所以判据里不许再拿它们跟「无注明」比。
  assert.equal(pending.includes('fldSize]="无注明"'), false);
  assert.equal(pending.includes('fldSpace]="无注明"'), false);
  assert.deepEqual(plan.formulas.map((item) => item.fieldName).length, 9);
});

test('field migration plan never extends the option list of a lookup field', () => {
  const plan = competitorCore.buildCompetitorFieldMigrationPlan({
    tableId: 'tblMain',
    fields: liveFields({ attributeType: MULTI_SELECT }),
  });
  assert.deepEqual(plan.optionUpdates.map((item) => item.fieldName), ATTRIBUTE_NAMES);
  const installation = plan.optionUpdates.find((item) => item.fieldName === '安装方式');
  assert.ok(installation.body.property.options.some((option) => option.name === '台上/搁置'));
});

test('record write plans never write a sentinel into a lookup attribute', () => {
  const fields = liveFields();
  const records = [{ record_id: 'rec1', fields: { 是否有效竞品: '是', 价格: 500 } }];

  const sentinelWrites = competitorCore.buildCompetitorAISentinelPlan({ records, fields })
    .flatMap((item) => Object.keys(item.fields));
  assert.ok(sentinelWrites.includes('材质分类'));
  assert.equal(sentinelWrites.includes('尺寸'), false);
  assert.equal(sentinelWrites.includes('适用空间'), false);

  const analysisWrites = competitorCore.buildCompetitorAIAnalysisPlan({ records, fields })
    .flatMap((item) => Object.keys(item.fields));
  assert.ok(analysisWrites.length > 0);
  assert.equal(analysisWrites.includes('尺寸'), false);
  assert.equal(analysisWrites.includes('适用空间'), false);
});

test('lookup attributes count as missing only when blank, ignoring the sentinel text', () => {
  const analysisFields = competitorCore.describeCompetitorAnalysisFields(liveFields());
  const base = {
    是否有效竞品: '是',
    月收货人数计算值: '10',
    材质分类: '人造石',
    外形: '椭圆',
    安装方式: '独立',
    功能: '按摩',
    风格: '极简',
  };
  const blank = competitorCore.pendingCompetitorAnalysisItems(
    { ...base, 尺寸: '', 适用空间: [] }, '是', analysisFields,
  );
  assert.ok(blank.includes('尺寸'));
  assert.ok(blank.includes('适用空间'));

  const filled = competitorCore.pendingCompetitorAnalysisItems(
    { ...base, 尺寸: '1500x700', 适用空间: '小户型' }, '是', analysisFields,
  );
  assert.equal(filled.includes('尺寸'), false);
  assert.equal(filled.includes('适用空间'), false);
});

test('a genuinely unsupported analysis field type still fails closed', () => {
  // 这条缝刻意开在缺陷的**旁边**而不是后面：放宽 Lookup 不等于接受任意类型。
  for (const type of [5, 7, 17, 2]) {
    assert.throws(
      () => competitorCore.buildCompetitorFieldMigrationPlan({ tableId: 'tblMain', fields: liveFields({ sizeType: type }) }),
      /Unsupported AI field type for 尺寸/u,
      `type ${type} must stay unsupported`,
    );
  }
});
