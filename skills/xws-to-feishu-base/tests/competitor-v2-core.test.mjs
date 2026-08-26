import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as competitorCore from '../scripts/competitor-v2-core.mjs';
import {
  COMPETITOR_MAIN_FIELDS,
  QUESTION_LIBRARY_FIELDS,
  SKU_DETAIL_FIELDS,
  buildCompetitorRecord,
  buildFeishuCompetitorRecord,
  classifyPriceBand,
  parseMonthlyReceived,
} from '../scripts/competitor-v2-core.mjs';

const sourceRow = (overrides = {}) => ({
  序号: 1,
  商品图片: 'https://example.test/1.jpg',
  商品标题: '人造石独立式椭圆日式按摩恒温浴缸',
  商品链接: 'https://item.taobao.com/item.htm?id=1',
  价格: '2500',
  月收货人数: '100+',
  类目: '普通浴缸',
  同款数: '2',
  平台: '淘宝',
  占位类型: '自然位',
  店铺名: '测试店铺',
  店铺旺旺: 'test',
  店铺类型: '非金牌店铺',
  地址: '广东 佛山',
  收藏人数: '-',
  卖点: '包邮',
  ...overrides,
});

test('main schema preserves all 16 source fields before V2 analysis fields', () => {
  assert.deepEqual(COMPETITOR_MAIN_FIELDS.slice(0, 16).map((field) => field.name), [
    '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
    '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
    '店铺类型', '地址', '收藏人数', '卖点',
  ]);
  assert.deepEqual(COMPETITOR_MAIN_FIELDS.slice(16).map((field) => field.name), [
    '搜索关键词', '月收货人数计算值', '计算口径', '月收货金额',
    '客单价带分类', '材质分类', '外形', '安装方式', '功能', '风格',
    '竞品分类', '尺寸', '适用空间', '数据状态', '待补数据项',
    '是否有效竞品', '排除原因',
  ]);
});

test('monthly received parsing preserves exact, lower-bound, and unknown semantics', () => {
  assert.deepEqual(parseMonthlyReceived('97'), {
    raw: '97', value: 97, basis: '精确值',
  });
  assert.deepEqual(parseMonthlyReceived('100+'), {
    raw: '100+', value: 100, basis: '下限值',
  });
  assert.deepEqual(parseMonthlyReceived('本月行业热销'), {
    raw: '本月行业热销', value: null, basis: '不可计算',
  });
  assert.deepEqual(parseMonthlyReceived('行业销量Top3'), {
    raw: '行业销量Top3', value: null, basis: '不可计算',
  });
});

test('price bands are non-overlapping at every approved boundary', () => {
  assert.throws(() => classifyPriceBand(''), /价格 is required/u);
  assert.equal(classifyPriceBand(999.99), '1000以下');
  assert.equal(classifyPriceBand(1000), '1000-3000');
  assert.equal(classifyPriceBand(2999.99), '1000-3000');
  assert.equal(classifyPriceBand(3000), '3000-6000');
  assert.equal(classifyPriceBand(5999.99), '3000-6000');
  assert.equal(classifyPriceBand(6000), '6000-8000');
  assert.equal(classifyPriceBand(7999.99), '6000-8000');
  assert.equal(classifyPriceBand(8000), '8000以上');
});

test('known title evidence produces multi-value attributes and one highest-priority class', () => {
  const record = buildCompetitorRecord(sourceRow({ 是否有效竞品: '是' }), { searchKeyword: '浴缸' });
  assert.equal(record.月收货人数, '100+');
  assert.equal(record.月收货人数计算值, 100);
  assert.equal(record.计算口径, '下限值');
  assert.equal(record.月收货金额, 250000);
  assert.equal(record.客单价带分类, '1000-3000');
  assert.deepEqual(record.材质分类, ['人造石']);
  assert.deepEqual(record.外形, ['椭圆']);
  assert.deepEqual(record.安装方式, ['独立']);
  assert.deepEqual(record.功能, ['按摩', '恒温']);
  assert.deepEqual(record.风格, ['日式']);
  assert.equal(record.竞品分类, 'A-爆款竞品');
});

test('approved material aliases normalize to human-made stone and C uses price only', () => {
  const record = buildCompetitorRecord(sourceRow({
    商品标题: 'PMMA高分子绮美石亚克力人造石异形浴缸',
    价格: '8000',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.deepEqual(record.材质分类, ['人造石']);
  assert.equal(record.竞品分类, 'C-差异化竞品');
  assert.equal(record.待补数据项.includes('C类主图造型'), false);
});

test('待确认 and invalid rows use the explicit not-applicable analysis sentinel', () => {
  const record = buildCompetitorRecord(sourceRow({
    商品标题: '未知卫浴商品',
  }), { searchKeyword: '浴缸' });
  assert.equal(record.是否有效竞品, '待确认');
  assert.equal(record.排除原因, '');
  assert.equal(record.月收货人数计算值, null);
  assert.equal(record.月收货金额, null);
  assert.equal(record.竞品分类, '不适用');
  assert.equal(record.数据状态, '');
  assert.deepEqual(record.材质分类, ['不适用']);
  assert.deepEqual(record.外形, ['不适用']);
  assert.deepEqual(record.安装方式, ['不适用']);
  assert.deepEqual(record.功能, ['不适用']);
  assert.deepEqual(record.风格, ['不适用']);
  assert.equal(record.尺寸, '不适用');
  assert.deepEqual(record.适用空间, ['不适用']);
  assert.deepEqual(record.待补数据项, []);
});

test('invalid competitors retain source data but skip every derived analysis field', () => {
  const record = buildCompetitorRecord(sourceRow({ 是否有效竞品: '否' }), { searchKeyword: '浴缸' });
  assert.equal(record.商品标题, sourceRow().商品标题);
  assert.equal(record.月收货人数, '100+');
  assert.equal(record.月收货人数计算值, null);
  assert.equal(record.计算口径, '');
  assert.equal(record.月收货金额, null);
  assert.deepEqual(record.材质分类, ['不适用']);
  assert.deepEqual(record.外形, ['不适用']);
  assert.deepEqual(record.安装方式, ['不适用']);
  assert.deepEqual(record.功能, ['不适用']);
  assert.deepEqual(record.风格, ['不适用']);
  assert.equal(record.竞品分类, '不适用');
  assert.equal(record.尺寸, '不适用');
  assert.deepEqual(record.适用空间, ['不适用']);
  assert.equal(record.数据状态, '');
  assert.deepEqual(record.待补数据项, []);
});

test('Feishu record uses a real attachment and omits blank calculated values', () => {
  const record = buildFeishuCompetitorRecord(sourceRow({
    月收货人数: '本月行业热销',
  }), 'file-token-1', { searchKeyword: '浴缸' });
  assert.deepEqual(record.商品图片, [{ file_token: 'file-token-1' }]);
  assert.equal('月收货人数计算值' in record, false);
  assert.equal('月收货金额' in record, false);
  assert.equal(record.尺寸, '不适用');
  assert.deepEqual(record.适用空间, ['不适用']);
});

test('D uses price below 1000 and C uses the approved 8000 price threshold', () => {
  const d = buildCompetitorRecord(sourceRow({
    商品标题: '异形浴缸',
    价格: '999.99',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(d.竞品分类, 'D-价格/流量型竞品');

  const c = buildCompetitorRecord(sourceRow({
    商品标题: '异形浴缸',
    价格: '9000',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(c.竞品分类, 'C-差异化竞品');
  assert.equal(c.待补数据项.includes('C类主图造型'), false);
});

test('updated competitor labels distinguish mid-price, low-price, no-class, and not-applicable rows', () => {
  const midPrice = buildCompetitorRecord(sourceRow({
    商品标题: '成人浴缸',
    价格: '9000',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(midPrice.竞品分类, 'C-差异化竞品');

  const lowPrice = buildCompetitorRecord(sourceRow({
    商品标题: '成人浴缸',
    价格: '999',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(lowPrice.竞品分类, 'D-价格/流量型竞品');

  const noClass = buildCompetitorRecord(sourceRow({
    商品标题: '成人浴缸',
    价格: '2500',
    月收货人数: '1',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(noClass.竞品分类, '无分类');

  const notApplicable = buildCompetitorRecord(sourceRow({
    商品标题: '浴缸配件下水器',
    价格: '2500',
    月收货人数: '1',
    是否有效竞品: '否',
  }), { searchKeyword: '浴缸' });
  assert.equal(notApplicable.竞品分类, '不适用');
});

test('record migration fills valid blanks with 无注明 and invalid rows with 不适用 without overwriting valid evidence', () => {
  const valid = sourceRow({
    是否有效竞品: '是',
    材质分类: [],
    外形: ['椭圆'],
    安装方式: [],
    功能: [],
    风格: [],
    尺寸: '',
    适用空间: [],
  });
  const invalid = sourceRow({
    是否有效竞品: '否',
    材质分类: ['亚克力'],
    外形: ['方形'],
    安装方式: ['独立'],
    功能: ['按摩'],
    风格: ['日式'],
    尺寸: '1500x700',
    适用空间: ['常规卫生间'],
  });
  const updates = competitorCore.buildCompetitorRecordMigrationPlan({
    records: [
      { record_id: 'rec-valid', fields: valid },
      { record_id: 'rec-invalid', fields: invalid },
    ],
    searchKeyword: '浴缸',
  });
  assert.deepEqual(updates, [
    {
      recordId: 'rec-valid',
      fields: {
        材质分类: ['无注明'],
        安装方式: ['无注明'],
        功能: ['无注明'],
        风格: ['无注明'],
        尺寸: '无注明',
        适用空间: ['无注明'],
      },
    },
    {
      recordId: 'rec-invalid',
      fields: {
        材质分类: ['不适用'],
        外形: ['不适用'],
        安装方式: ['不适用'],
        功能: ['不适用'],
        风格: ['不适用'],
        尺寸: '不适用',
        适用空间: ['不适用'],
      },
    },
  ]);
});

test('migration preserves text AI field contracts and emits scalar sentinel values', () => {
  const fields = [
    ...['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']
      .map((name, index) => ({ field_id: `fldAi${index}`, field_name: name, type: 1 })),
  ];
  const updates = competitorCore.buildCompetitorRecordMigrationPlan({
    records: [{ record_id: 'rec-text', fields: { 是否有效竞品: '是' } }],
    fields,
    searchKeyword: '浴缸',
  });
  assert.deepEqual(updates, [{
    recordId: 'rec-text',
    fields: {
      材质分类: '无注明', 外形: '无注明', 安装方式: '无注明',
      功能: '无注明', 风格: '无注明', 尺寸: '无注明', 适用空间: '无注明',
    },
  }]);
});

test('AI sentinel plan requires settled Feishu validity and never overwrites existing values', () => {
  assert.equal(typeof competitorCore.buildCompetitorAISentinelPlan, 'function');
  const fields = [
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 20 },
    ...['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']
      .map((name, index) => ({ field_id: `fldAi${index}`, field_name: name, type: index === 5 ? 1 : 1 })),
  ];
  const updates = competitorCore.buildCompetitorAISentinelPlan({
    records: [{
      record_id: 'rec-valid',
      fields: { 是否有效竞品: '是', 材质分类: '已有人审值' },
    }, {
      record_id: 'rec-invalid',
      fields: { 是否有效竞品: '否', 外形: '已有值' },
    }],
    fields,
  });
  assert.deepEqual(updates, [{
    recordId: 'rec-valid',
    fields: {
      外形: '无注明', 安装方式: '无注明', 功能: '无注明',
      风格: '无注明', 尺寸: '无注明', 适用空间: '无注明',
    },
  }, {
    recordId: 'rec-invalid',
    fields: {
      材质分类: '不适用', 安装方式: '不适用', 功能: '不适用',
      风格: '不适用', 尺寸: '不适用', 适用空间: '不适用',
    },
  }]);
  assert.throws(() => competitorCore.buildCompetitorAISentinelPlan({
    records: [{ record_id: 'rec-unsettled', fields: {} }],
    fields,
  }), /validity formula is unsettled/u);
});

test('AI analysis plan backfills reproducible attribute evidence after Feishu validity settles', () => {
  const fields = [
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 20 },
    ...['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']
      .map((name, index) => ({ field_id: `fldAi${index}`, field_name: name, type: 1 })),
  ];
  const updates = competitorCore.buildCompetitorAIAnalysisPlan({
    records: [{ record_id: 'rec1', fields: {
      商品标题: '人造石独立式椭圆日式按摩恒温浴缸', 卖点: '', 价格: '2500', 月收货人数: '100+', 是否有效竞品: '是',
    } }],
    fields,
  });
  assert.deepEqual(updates, [{ recordId: 'rec1', fields: {
    材质分类: '人造石', 外形: '椭圆', 安装方式: '独立',
    功能: '按摩、恒温', 风格: '日式', 尺寸: '无注明', 适用空间: '无注明',
  } }]);
});

test('AI analysis extracts only explicit dimensions and space evidence from the title', () => {
  const fields = [
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 20 },
    ...['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']
      .map((name, index) => ({ field_id: `fldAi${index}`, field_name: name, type: 1 })),
  ];
  const updates = competitorCore.buildCompetitorAIAnalysisPlan({
    records: [{ record_id: 'rec-size-space', fields: {
      商品标题: '亚克力浴缸 尺寸1500×700×580mm 小空间/常规卫生间',
      卖点: '', 价格: '2500', 月收货人数: '10', 是否有效竞品: '是',
    } }],
    fields,
  });
  assert.deepEqual(updates, [{ recordId: 'rec-size-space', fields: {
    材质分类: '亚克力', 外形: '无注明', 安装方式: '无注明',
    功能: '无注明', 风格: '无注明', 尺寸: '1500×700×580mm',
    适用空间: '小户型、常规卫生间',
  } }]);
});

test('dimension and space extraction does not infer from vague audience or product words', () => {
  const record = buildCompetitorRecord(sourceRow({
    商品标题: '家用成人双人浴缸小尺寸',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(record.尺寸, '无注明');
  assert.deepEqual(record.适用空间, ['无注明']);
});

test('pending formula checks all seven AI fields and treats 无注明 as missing evidence', () => {
  const fields = [
    { field_id: 'fldTitle', field_name: '商品标题', type: 1 },
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 3 },
    { field_id: 'fldExclusionReason', field_name: '排除原因', type: 1 },
    { field_id: 'fldPrice', field_name: '价格', type: 2 },
    { field_id: 'fldRawCount', field_name: '月收货人数', type: 1 },
    { field_id: 'fldCount', field_name: '月收货人数计算值', type: 2 },
    { field_id: 'fldBasis', field_name: '计算口径', type: 3 },
    { field_id: 'fldAmount', field_name: '月收货金额', type: 2 },
    { field_id: 'fldBand', field_name: '客单价带分类', type: 3 },
    { field_id: 'fldClass', field_name: '竞品分类', type: 4 },
    { field_id: 'fldMaterial', field_name: '材质分类', type: 4 },
    { field_id: 'fldShape', field_name: '外形', type: 4 },
    { field_id: 'fldInstallation', field_name: '安装方式', type: 4 },
    { field_id: 'fldFunction', field_name: '功能', type: 4 },
    { field_id: 'fldStyle', field_name: '风格', type: 4 },
    { field_id: 'fldSize', field_name: '尺寸', type: 1 },
    { field_id: 'fldSpace', field_name: '适用空间', type: 4 },
    { field_id: 'fldStatus', field_name: '数据状态', type: 3 },
    { field_id: 'fldPending', field_name: '待补数据项', type: 4, property: { options: [] } },
  ];
  const plan = competitorCore.buildCompetitorFieldMigrationPlan({ tableId: 'tblMain', fields });
  const pending = plan.formulas.find((item) => item.fieldName === '待补数据项')
    .body.property.formula_expression;
  assert.match(pending, /fldMaterial/u);
  assert.match(pending, /fldShape/u);
  assert.match(pending, /fldInstallation/u);
  assert.match(pending, /fldFunction/u);
  assert.match(pending, /fldStyle/u);
  assert.match(pending, /fldSize/u);
  assert.match(pending, /fldSpace/u);
  assert.match(pending, /无注明/u);
});

test('AI prompts explicitly return 无注明 for valid evidence gaps and 不适用 outside the analysis set', () => {
  const prompts = competitorCore.COMPETITOR_AI_PROMPTS;
  for (const prompt of Object.values(prompts)) {
    assert.match(prompt, /无注明/u);
    assert.match(prompt, /不适用/u);
  }
});

test('applicable-space AI prompt maps only explicit space evidence and defaults when absent', () => {
  const prompt = competitorCore.COMPETITOR_AI_PROMPTS.适用空间;
  assert.match(prompt, /小空间归为“小户型”/u);
  assert.match(prompt, /明确“常规卫生间”归为“常规卫生间”/u);
  assert.match(prompt, /没有明确证据时输出“无注明”/u);
  assert.doesNotMatch(prompt, /只有明确出现.+才输出“无注明”/u);
});

test('AI prompts use only explicit source evidence and contain no retired shape-special logic', () => {
  assert.ok(competitorCore.COMPETITOR_AI_PROMPTS, 'AI prompt contract must be exported');
  const { COMPETITOR_AI_PROMPTS } = competitorCore;
  assert.deepEqual(Object.keys(COMPETITOR_AI_PROMPTS), [
    '材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间',
  ]);
  const combined = Object.values(COMPETITOR_AI_PROMPTS).join('\n');
  assert.doesNotMatch(combined, /造型特殊|主图判断|C类主图/u);
  assert.match(COMPETITOR_AI_PROMPTS.材质分类, /PMMA/u);
  assert.match(COMPETITOR_AI_PROMPTS.材质分类, /杜邦石/u);
  assert.match(combined, /不得推断|没有明确证据/u);
});

test('copyable AI prompt reference stays synchronized with the executable prompt source', () => {
  const reference = readFileSync(
    new URL('../references/competitor-v2-ai-prompts.md', import.meta.url),
    'utf8',
  );
  for (const [fieldName, prompt] of Object.entries(competitorCore.COMPETITOR_AI_PROMPTS)) {
    assert.match(reference, new RegExp(`## ${fieldName}`, 'u'));
    assert.ok(reference.includes(prompt), `${fieldName} prompt differs from the copyable reference`);
  }
});

test('field migration plan creates review fields and makes only safe deterministic fields formulas', () => {
  assert.equal(typeof competitorCore.buildCompetitorFieldMigrationPlan, 'function');
  const fields = [
    { field_id: 'fldTitle', field_name: '商品标题', type: 1 },
    { field_id: 'fldCategory', field_name: '类目', type: 1 },
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 3 },
    { field_id: 'fldExclusionReason', field_name: '排除原因', type: 1 },
    { field_id: 'fldPrice', field_name: '价格', type: 2 },
    { field_id: 'fldRawCount', field_name: '月收货人数', type: 1 },
    { field_id: 'fldCount', field_name: '月收货人数计算值', type: 2 },
    { field_id: 'fldBasis', field_name: '计算口径', type: 3 },
    { field_id: 'fldAmount', field_name: '月收货金额', type: 2 },
    { field_id: 'fldBand', field_name: '客单价带分类', type: 3 },
    { field_id: 'fldClass', field_name: '竞品分类', type: 4 },
    { field_id: 'fldMaterial', field_name: '材质分类', type: 4 },
    { field_id: 'fldShape', field_name: '外形', type: 4 },
    { field_id: 'fldInstallation', field_name: '安装方式', type: 4, property: { options: [
      { id: 'independent', name: '独立' },
    ] } },
    { field_id: 'fldFunction', field_name: '功能', type: 4 },
    { field_id: 'fldStyle', field_name: '风格', type: 4 },
    { field_id: 'fldSize', field_name: '尺寸', type: 1 },
    { field_id: 'fldSpace', field_name: '适用空间', type: 4 },
    { field_id: 'fldStatus', field_name: '数据状态', type: 3 },
    { field_id: 'fldPending', field_name: '待补数据项', type: 4, property: { options: [] } },
  ];
  const plan = competitorCore.buildCompetitorFieldMigrationPlan({ tableId: 'tblMain', fields });
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.formulas.map((item) => item.fieldName), [
    '是否有效竞品', '排除原因',
    '月收货人数计算值', '计算口径', '月收货金额',
    '客单价带分类', '竞品分类', '待补数据项', '数据状态',
  ]);
  assert.match(plan.formulas[0].body.property.formula_expression, /洗脚池/u);
  assert.match(plan.formulas[0].body.property.formula_expression, /龙头/u);
  assert.match(plan.formulas[0].body.property.formula_expression, /FIND\("浴缸"/u);
  assert.doesNotMatch(plan.formulas[0].body.property.formula_expression, /CONTAIN\(.+"浴缸"/u);
  assert.match(plan.formulas[0].body.property.formula_expression, /"是".+"待确认"/u);
  assert.match(plan.formulas[1].body.property.formula_expression, /浴缸配件/u);
  assert.match(plan.formulas[2].body.property.formula_expression, /fldRawCount/u);
  for (const formula of plan.formulas.slice(2)) {
    assert.doesNotMatch(
      formula.body.property.formula_expression,
      /fldValidity/u,
      `${formula.fieldName} must not depend on the formula validity field`,
    );
  }
  assert.match(plan.formulas[6].body.property.formula_expression, /CONTAIN\(.+人造石/u);
  assert.match(plan.formulas[6].body.property.formula_expression, /A-爆款竞品/u);
  assert.match(plan.formulas[6].body.property.formula_expression, /C-差异化竞品/u);
  assert.match(plan.formulas[6].body.property.formula_expression, /D-价格\/流量型竞品/u);
  assert.deepEqual(plan.optionUpdates.map((item) => item.fieldName), [
    '材质分类', '外形', '安装方式', '功能', '风格', '适用空间',
  ]);
  assert.ok(plan.optionUpdates.find((item) => item.fieldName === '安装方式')
    .body.property.options.some((item) => item.name === '台上/搁置'));
  assert.ok(plan.optionUpdates.every((item) => item.body.property.options.some((option) => option.name === '无注明')));
});

test('field migration plan does not add select options or use multi-select predicates for text AI fields', () => {
  const fields = [
    { field_id: 'fldTitle', field_name: '商品标题', type: 1 },
    { field_id: 'fldValidity', field_name: '是否有效竞品', type: 20 },
    { field_id: 'fldExclusionReason', field_name: '排除原因', type: 20 },
    { field_id: 'fldPrice', field_name: '价格', type: 2 },
    { field_id: 'fldRawCount', field_name: '月收货人数', type: 1 },
    { field_id: 'fldCount', field_name: '月收货人数计算值', type: 20 },
    { field_id: 'fldBasis', field_name: '计算口径', type: 20 },
    { field_id: 'fldAmount', field_name: '月收货金额', type: 20 },
    { field_id: 'fldBand', field_name: '客单价带分类', type: 20 },
    { field_id: 'fldClass', field_name: '竞品分类', type: 20 },
    ...['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']
      .map((name, index) => ({ field_id: `fldText${index}`, field_name: name, type: 1 })),
    { field_id: 'fldStatus', field_name: '数据状态', type: 20 },
    { field_id: 'fldPending', field_name: '待补数据项', type: 20 },
  ];
  const plan = competitorCore.buildCompetitorFieldMigrationPlan({ tableId: 'tblText', fields });
  assert.deepEqual(plan.optionUpdates, []);
  const pending = plan.formulas.find((item) => item.fieldName === '待补数据项')
    .body.property.formula_expression;
  assert.equal(
    pending.includes('CONTAIN(bitable::$table[tblText].$field[fldText0]'),
    false,
  );
  assert.ok(
    pending.includes('bitable::$table[tblText].$field[fldText0]="无注明"'),
  );
  const competitorClass = plan.formulas.find((item) => item.fieldName === '竞品分类')
    .body.property.formula_expression;
  assert.equal(
    competitorClass.includes('CONTAIN(bitable::$table[tblText].$field[fldText0]'),
    false,
  );
  assert.ok(
    competitorClass.includes('FIND("人造石",bitable::$table[tblText].$field[fldText0])>0'),
  );
});

test('validity formula policy keeps bathtub synonyms and rejects only explicit non-competitors', () => {
  assert.equal(typeof competitorCore.classifyCompetitorValidity, 'function');
  const classify = (title, category = '家装主材 >> 浴缸/淋浴房') => (
    competitorCore.classifyCompetitorValidity({ 商品标题: title, 类目: category })
  );
  assert.deepEqual(classify('亚克力浴缸家用小户型成人独立式洗澡盆'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('木质浴缸家用成人泡澡浴桶'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('TOTO独立式进口洗澡盆儿童浴盆家用深泡浴缸小户型T968PA(08)'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('亚克力嵌入式加厚成人老人家庭酒店洗浴水疗浴缸浴盆洗澡送下水器'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('惠达浴缸家用成人小户型亚克力方形日式浴缸靠枕淋浴房一体式新款'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('独立式亚克力家用四周一体可移动座板深泡小浴缸龙头缸可定制尺寸'), {
    validity: '是', reason: '',
  });
  assert.deepEqual(classify('网红款人造石洗脚池泡脚盆', '卫浴用品'), {
    validity: '否', reason: '非浴缸主体',
  });
  assert.deepEqual(classify('SSWW浪鲸浴缸龙头手持淋浴花洒套装'), {
    validity: '否', reason: '浴缸配件',
  });
  assert.deepEqual(classify('宠物SPA浴缸狗洗澡池'), {
    validity: '否', reason: '非浴缸主体',
  });
  assert.deepEqual(classify('未知卫浴商品', '卫浴用品'), {
    validity: '待确认', reason: '',
  });
  assert.deepEqual(classify('未知卫浴商品', '家装主材 >> 浴缸/淋浴房 >> 浴缸'), {
    validity: '待确认', reason: '',
  });
});

test('record migration never resets user or AI data', () => {
  assert.equal(typeof competitorCore.buildCompetitorRecordMigrationPlan, 'function');
  const source = sourceRow({
    商品标题: 'PMMA高分子浴缸',
    价格: '9000',
    月收货人数: '10',
    材质分类: ['人造石'],
    外形: ['椭圆'],
    安装方式: ['独立'],
    功能: ['按摩'],
    风格: ['日式'],
    尺寸: '1500x700',
    适用空间: ['常规卫生间'],
  });
  const updates = competitorCore.buildCompetitorRecordMigrationPlan({
    records: [{ record_id: 'rec1', fields: { ...source, 待补数据项: ['C类主图造型'] } }],
    searchKeyword: '浴缸',
  });
  assert.deepEqual(updates, []);
});

test('migration CLI requires exact apply confirmations', () => {
  assert.equal(typeof competitorCore.parseCompetitorMigrationArgs, 'function');
  assert.throws(() => competitorCore.parseCompetitorMigrationArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app123?table=tbl123',
  ]), /--expected-rows is required/u);
  const dryRun = competitorCore.parseCompetitorMigrationArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app123?table=tbl123',
    '--expected-rows', '1333',
  ]);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.tableId, 'tbl123');
  assert.throws(() => competitorCore.parseCompetitorMigrationArgs([
    '--base-url', 'https://tenant.feishu.cn/base/app123?table=tbl123',
    '--expected-rows', '1333', '--env-file', 'C:/credentials.env', '--apply',
  ]), /confirm-app-token/u);
});

test('migration mutation guard blocks deletes, field creation, formula record writes, and unrelated fields', () => {
  assert.equal(typeof competitorCore.assertCompetitorMigrationMutation, 'function');
  const scope = {
    appToken: 'app123',
    tableId: 'tbl123',
    allowedFieldIds: new Set(['fldPending', 'fldAmount', 'fldBand', 'fldValidity']),
  };
  assert.doesNotThrow(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'PUT',
    path: '/bitable/v1/apps/app123/tables/tbl123/fields/fldValidity',
    body: { field_name: '是否有效竞品', type: 20 },
  }, scope));
  assert.throws(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app123/tables/tbl123/fields',
    body: { field_name: '是否有效竞品', type: 3 },
  }, scope), /Blocked/u);
  assert.doesNotThrow(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app123/tables/tbl123/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 材质分类: '无注明' } }] },
  }, scope));
  assert.throws(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app123/tables/tbl123/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 竞品分类: 'A-爆款竞品' } }] },
  }, scope), /Blocked/u);
  assert.throws(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'DELETE', path: '/bitable/v1/apps/app123/tables/tbl123/fields/fldPending', body: {},
  }, scope), /Blocked/u);
  assert.throws(() => competitorCore.assertCompetitorMigrationMutation({
    method: 'PUT',
    path: '/bitable/v1/apps/app123/tables/tblOther/fields/fldPending',
    body: { field_name: '待补数据项' },
  }, scope), /Blocked/u);
});

test('migration filters already-current record updates for idempotent reruns', () => {
  assert.equal(typeof competitorCore.filterChangedCompetitorRecordUpdates, 'function');
  const updates = [
    { recordId: 'rec1', fields: { 是否有效竞品: '待确认', 材质分类: ['人造石'] } },
    { recordId: 'rec2', fields: { 是否有效竞品: '待确认', 材质分类: ['亚克力'] } },
  ];
  const current = [
    { recordId: 'rec1', fields: { 是否有效竞品: '待确认', 材质分类: ['人造石'] } },
    { recordId: 'rec2', fields: { 是否有效竞品: '待确认', 材质分类: ['人造石'] } },
  ];
  assert.deepEqual(
    competitorCore.filterChangedCompetitorRecordUpdates({ records: current, updates }),
    [{ recordId: 'rec2', fields: { 材质分类: ['亚克力'] } }],
  );
});

test('formula read-back normalizes Feishu rich-text arrays', () => {
  assert.equal(typeof competitorCore.plainFeishuFormulaValue, 'function');
  assert.equal(competitorCore.plainFeishuFormulaValue([
    { text: '1000-3000', type: 'text' },
  ]), '1000-3000');
  assert.equal(competitorCore.plainFeishuFormulaValue('26500'), '26500');
  assert.equal(competitorCore.plainFeishuFormulaValue(null), '');
});

test('migration verification treats empty multi-selects and two-decimal money as equivalent', () => {
  assert.equal(typeof competitorCore.equivalentFeishuFieldValue, 'function');
  assert.equal(typeof competitorCore.equivalentFeishuMoney, 'function');
  assert.equal(competitorCore.equivalentFeishuFieldValue(null, []), true);
  assert.equal(competitorCore.equivalentFeishuFieldValue(['人造石'], ['人造石']), true);
  assert.equal(competitorCore.equivalentFeishuMoney(87337.9, 87337.90000000001), true);
});

test('missing source evidence stays blank and is disclosed instead of being inferred', () => {
  const record = buildCompetitorRecord(sourceRow({
    商品标题: '家用成人浴缸',
    月收货人数: '本月行业热销',
    是否有效竞品: '是',
  }), { searchKeyword: '浴缸' });
  assert.equal(record.月收货人数计算值, null);
  assert.equal(record.月收货金额, null);
  assert.deepEqual(record.功能, ['无注明']);
  assert.equal(record.功能.includes('普通'), false);
  assert.equal(record.数据状态, '部分待补');
  assert.ok(record.待补数据项.includes('月收货人数精确值'));
  assert.ok(record.待补数据项.includes('功能'));
});

test('A/B rows identify the deferred SKU and applicable-space work', () => {
  const record = buildCompetitorRecord(sourceRow({ 是否有效竞品: '是' }), { searchKeyword: '浴缸' });
  assert.equal(record.尺寸, '无注明');
  assert.deepEqual(record.适用空间, ['无注明']);
  assert.ok(record.待补数据项.includes('SKU尺寸'));
  assert.ok(record.待补数据项.includes('适用空间'));
  assert.equal(record.待补数据项.filter((item) => item === '适用空间').length, 1);
});

test('price-missing helper treats null and blank values as missing without treating zero as missing', () => {
  assert.equal(competitorCore.priceIsMissing(null), true);
  assert.equal(competitorCore.priceIsMissing(''), true);
  assert.equal(competitorCore.priceIsMissing('  '), true);
  assert.equal(competitorCore.priceIsMissing(0), false);
});

test('empty SKU and question tables have explicit next-stage schemas', () => {
  assert.deepEqual(SKU_DETAIL_FIELDS.map((field) => field.name), [
    '商品链接', '商品标题', '竞品分类', 'SKU名称', 'SKU规格',
    'SKU尺寸', '尺寸汇总', '适用空间', '空间判定状态', '空间判定依据',
    '商品ID', 'SKU唯一键', '采集状态', '待补数据项',
  ]);
  const skuSpace = SKU_DETAIL_FIELDS.find((field) => field.name === '适用空间');
  assert.equal(skuSpace.type, 3);
  assert.deepEqual(skuSpace.property.options.map((option) => option.name), ['小户型', '常规卫生间']);
  assert.doesNotMatch(JSON.stringify(SKU_DETAIL_FIELDS), /大户型/u);
  assert.deepEqual(QUESTION_LIBRARY_FIELDS.map((field) => field.name), [
    '商品链接', '商品标题', '竞品分类', '来源类型', '原始内容',
    '高频问题或关键词', '出现次数', '采集状态',
  ]);
});
