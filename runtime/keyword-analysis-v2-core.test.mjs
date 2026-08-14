import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAND_DICTIONARY,
  FINE_LABEL_DICTIONARY,
  MAIN_CATEGORIES,
  PROMPTS,
  TEST_ANALYSIS_FIELDS,
  buildV2FormulaDefinitions,
  classifyIntentBySignal,
  extractBrands,
  validateFineLabels,
  validateStandardMerge,
} from './keyword-analysis-v2-core.mjs';

test('V2 schema reuses the original analysis columns without adding fields', () => {
  assert.deepEqual(TEST_ANALYSIS_FIELDS.map((field) => field.name), [
    '排名', '搜索词', '搜索人气', '点击率', '支付转化率',
    '关键词编号', '一级类目', '主关键词', '原始关键词', '标准归并词',
    '关键词分类', '细分标签', '用户意图', '分析状态', '平台来源',
    '搜索热度', '内容热度（后续）',
    '交易热度', '是否重点词', '优先级', '对应产品方向', '采集日期',
  ]);
  assert.equal(TEST_ANALYSIS_FIELDS[0].type, 2);
  assert.equal(TEST_ANALYSIS_FIELDS.at(-1).type, 5);
});

test('V2 formulas retain raw ranges without adding batch or collection-date fields', () => {
  const formulas = buildV2FormulaDefinitions({
    tableId: 'tblTest',
    fieldIds: {
      搜索词: 'fldSearch',
      搜索人气: 'fldPopularity',
      支付转化率: 'fldTrade',
    },
  });
  assert.deepEqual(Object.keys(formulas), [
    '一级类目', '主关键词', '原始关键词', '平台来源', '搜索热度', '交易热度',
  ]);
  assert.match(formulas.原始关键词, /fldSearch/);
  assert.match(formulas.平台来源, /淘宝/);
  assert.equal('批次编号' in formulas, false);
  assert.match(formulas.搜索热度, /15万 ~ 30万/);
  assert.match(formulas.交易热度, /无数据/);
  assert.equal('采集日期' in formulas, false);
});

test('main classification contract has nine mutually exclusive values', () => {
  assert.deepEqual(MAIN_CATEGORIES, [
    '大词', '品牌词', '材质词', '场景词', '痛点词',
    '款式词', '风格词', '尺寸词', '功能词',
  ]);
});

test('brand dictionary extracts canonical names without treating them as labels', () => {
  assert.ok(BRAND_DICTIONARY.length >= 8);
  assert.deepEqual(extractBrands('TOTO浴缸官方旗舰店'), ['TOTO']);
  assert.deepEqual(extractBrands('科勒铸铁浴缸'), ['科勒']);
  assert.deepEqual(extractBrands('普通浴缸'), []);
});

test('controlled labels accept dictionary values and explicit numeric dimensions', () => {
  assert.ok(FINE_LABEL_DICTIONARY['场景'].includes('小户型'));
  assert.deepEqual(validateFineLabels('场景/小户型、款式/步入式、尺寸/1.5米'), {
    valid: true,
    invalid: [],
  });
});

test('controlled labels reject category words, free segmentation, and inferred labels', () => {
  assert.deepEqual(validateFineLabels('浴缸、家用、小户型'), {
    valid: false,
    invalid: ['浴缸', '家用', '小户型'],
  });
  assert.deepEqual(validateFineLabels('款式/靠墙式'), {
    valid: true,
    invalid: [],
  });
  assert.deepEqual(validateFineLabels('款式/不存在款式'), {
    valid: false,
    invalid: ['款式/不存在款式'],
  });
});

test('standard merge preserves demand-changing information and falls back to source', () => {
  assert.deepEqual(validateStandardMerge('科勒铸铁浴缸', '科勒浴缸'), {
    valid: false,
    reason: '归并词删除了明确需求信息',
  });
  assert.deepEqual(validateStandardMerge('小户型浴缸', '浴缸'), {
    valid: false,
    reason: '禁止向上归类',
  });
  assert.deepEqual(validateStandardMerge('小浴缸', '小浴缸'), {
    valid: true,
    reason: '',
  });
});

test('intent signals use fixed precedence and retain the matched basis', () => {
  assert.deepEqual(classifyIntentBySignal('浴缸漏水维修价格'), {
    intent: '问题解决型',
    basis: '规则命中：漏水',
  });
  assert.deepEqual(classifyIntentBySignal('科勒浴缸哪个好'), {
    intent: '对比型',
    basis: '规则命中：哪个好',
  });
  assert.deepEqual(classifyIntentBySignal('TOTO浴缸官方旗舰店'), {
    intent: '购买型',
    basis: '规则命中：官方旗舰店',
  });
  assert.deepEqual(classifyIntentBySignal('浴缸装修效果图'), {
    intent: '灵感型',
    basis: '规则命中：效果图',
  });
  assert.equal(classifyIntentBySignal('小户型浴缸'), null);
});

test('prompts encode the approved boundaries instead of the retired behavior', () => {
  assert.deepEqual(Object.keys(PROMPTS), ['关键词分类', '细分标签', '标准归并词', '用户意图']);
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    assert.match(prompt, /\{\{原始关键词\}\}/, `${name} must contain the real-field placeholder`);
  }
  assert.match(PROMPTS.关键词分类, /九类/);
  assert.match(PROMPTS.关键词分类, /科勒铸铁浴缸.*材质词/s);
  assert.doesNotMatch(PROMPTS.关键词分类, /品牌字段/);
  assert.match(PROMPTS.细分标签, /禁止输出.*浴缸/s);
  assert.match(PROMPTS.细分标签, /维度\/标签/);
  assert.doesNotMatch(PROMPTS.细分标签, /品牌字段/);
  assert.match(PROMPTS.标准归并词, /只根据原始关键词本身/);
  assert.match(PROMPTS.标准归并词, /语义完全相同.*同一输出/s);
  assert.match(PROMPTS.标准归并词, /家庭浴缸.*家用浴缸/s);
  assert.match(PROMPTS.标准归并词, /浪鲸.*浪鲸/s);
  assert.match(PROMPTS.标准归并词, /无法确认时.*原始关键词/s);
  assert.match(PROMPTS.标准归并词, /小浴缸.*小户型浴缸.*不得/s);
  assert.match(PROMPTS.标准归并词, /不得根据其他字段.*补全/s);
  assert.doesNotMatch(PROMPTS.标准归并词, /\{\{一级类目\}\}/);
  assert.match(PROMPTS.用户意图, /问题解决型\s*>\s*对比型\s*>\s*购买型\s*>\s*灵感型\s*>\s*了解型/);
  assert.match(PROMPTS.用户意图, /漏水.*哪个好.*旗舰店.*效果图/s);
  assert.doesNotMatch(PROMPTS.用户意图, /仅用于规则未命中/);
  assert.doesNotMatch(PROMPTS.用户意图, /97/);
});
