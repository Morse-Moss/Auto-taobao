import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_FIELDS,
  HISTORY_FIELDS,
  KEYWORD_LIBRARY_FIELDS,
  buildFormulaDefinitions,
  buildKeywordIdentityKey,
  buildKeywordNumberMap,
  buildSeedRecords,
  classifySearchHeat,
  classifyTradeHeat,
  countKeywordNumberMappingDifferences,
  findTableById,
  normalizeKeyword,
  assertKeywordNumberOnlyMutation,
  sameDistribution,
} from './keyword-dual-table-core.mjs';

test('analysis table keeps both keyword columns and puts collection date last', () => {
  const names = ANALYSIS_FIELDS.map((field) => field.name);
  assert.deepEqual(names, [
    '排名', '搜索词', '搜索人气', '点击率', '支付转化率',
    '关键词编号', '一级类目', '主关键词', '原始关键词',
    '标准归并词', '关键词分类', '细分标签', '用户意图', '分析状态',
    '来源渠道', '搜索热度', '内容热度', '交易热度',
    '是否重点词', '优先级', '对应产品方向', '采集日期',
  ]);
});

test('history table owns the five trend fields and puts collection date last', () => {
  const names = HISTORY_FIELDS.map((field) => field.name);
  assert.deepEqual(names, [
    '排名', '搜索词', '搜索人气', '点击率', '支付转化率',
    '关键词编号', '一级类目', '主关键词', '原始关键词', '来源渠道',
    '搜索热度', '交易热度', '出现状态', '排名环比',
    '搜索人气环比', '交易环比', '综合趋势变化', '采集日期',
  ]);
});

test('keyword library uses a six-digit permanent auto-number field', () => {
  assert.deepEqual(KEYWORD_LIBRARY_FIELDS.map((field) => field.name), [
    '唯一匹配键', '一级类目', '原始关键词', '规范化关键词', '关键词编号',
  ]);
  const numberField = KEYWORD_LIBRARY_FIELDS.at(-1);
  assert.equal(numberField.type, 1005);
  assert.deepEqual(numberField.property.auto_serial.options, [
    { type: 'fixed_text', value: 'KW' },
    { type: 'system_number', value: '6' },
  ]);
});

test('heat classifiers follow the approved operations thresholds', () => {
  assert.equal(classifySearchHeat('15万 ~ 30万'), '高');
  assert.equal(classifySearchHeat('5000 ~ 1万'), '高');
  assert.equal(classifySearchHeat('2500 ~ 5000'), '高');
  assert.equal(classifySearchHeat('1200 ~ 2500'), '高');
  assert.equal(classifySearchHeat('600 ~ 1200'), '中');
  assert.equal(classifySearchHeat('300 ~ 600'), '低');
  assert.equal(classifySearchHeat('0 ~ 20'), '低');
  assert.equal(classifyTradeHeat('-'), '无数据');
  assert.equal(classifyTradeHeat('0% ~ 1%'), '低');
  assert.equal(classifyTradeHeat('1% ~ 2.5%'), '中');
  assert.equal(classifyTradeHeat('2.5% ~ 5%'), '中');
  assert.equal(classifyTradeHeat('5% ~ 7.5%'), '高');
  assert.equal(classifyTradeHeat('40% ~ 45%'), '高');
});

test('formula contract has six active fields and trade heat ignores click rate', () => {
  const formulas = buildFormulaDefinitions({
    tableId: 'tblTarget',
    fieldIds: {
      搜索词: 'fldSearch',
      搜索人气: 'fldPopularity',
      点击率: 'fldClick',
      支付转化率: 'fldTrade',
    },
  });
  assert.deepEqual(Object.keys(formulas), [
    '一级类目', '主关键词', '原始关键词', '来源渠道', '搜索热度', '交易热度',
  ]);
  assert.match(formulas.原始关键词, /fldSearch/);
  assert.match(formulas.搜索热度, /fldPopularity\]="1200 ~ 2500"[\s\S]*,"高"/u);
  assert.match(formulas.搜索热度, /fldPopularity\]="600 ~ 1200"[\s\S]*,"中"/u);
  assert.match(formulas.搜索热度, /fldPopularity\]="300 ~ 600"[\s\S]*,"低"/u);
  assert.doesNotMatch(formulas.交易热度, /fldClick/);
  assert.match(formulas.交易热度, /fldTrade/);
});

test('seed records preserve the five source facts without inventing a date', () => {
  const source = [{
    fields: {
      排名: '1',
      搜索词: '浴缸',
      搜索人气: '15万 ~ 30万',
      点击率: '80%',
      支付转化率: '-',
    },
  }];
  const analysis = buildSeedRecords(source, 'analysis');
  const history = buildSeedRecords(source, 'history');
  assert.deepEqual(analysis, [{
    排名: '1', 搜索词: '浴缸', 搜索人气: '15万 ~ 30万', 点击率: '80%',
    支付转化率: '-', 分析状态: '待审核',
  }]);
  assert.deepEqual(history, [{
    排名: '1', 搜索词: '浴缸', 搜索人气: '15万 ~ 30万', 点击率: '80%',
    支付转化率: '-',
  }]);
  assert.equal('采集日期' in analysis[0], false);
  assert.equal('采集日期' in history[0], false);
});

test('distribution comparison ignores object key insertion order', () => {
  assert.equal(
    sameDistribution({ 低: 276, 高: 9, 中: 15 }, { 中: 15, 低: 276, 高: 9 }),
    true,
  );
  assert.equal(sameDistribution({ 高: 9 }, { 高: 8 }), false);
});

test('keyword normalization applies NFKC, trims, collapses spaces, and lowercases latin text', () => {
  assert.equal(normalizeKeyword('　ＡＢＣ　 浴缸  '), 'abc 浴缸');
  assert.equal(normalizeKeyword('浴缸\t\t下水器'), '浴缸 下水器');
});

test('keyword identity reuses one key within a category and isolates different categories', () => {
  assert.equal(
    buildKeywordIdentityKey('浴缸', '　ＡＢＣ 浴缸 '),
    buildKeywordIdentityKey('浴缸', 'abc   浴缸'),
  );
  assert.notEqual(
    buildKeywordIdentityKey('浴缸', '台上盆'),
    buildKeywordIdentityKey('洗手台', '台上盆'),
  );
});

test('keyword number map accepts permanent KW numbers and rejects duplicate identities or numbers', () => {
  const records = [
    { fields: { 一级类目: '浴缸', 原始关键词: '浴缸', 关键词编号: 'KW000001' } },
    { fields: { 一级类目: '浴缸', 原始关键词: '小浴缸', 关键词编号: 'KW000002' } },
  ];
  assert.deepEqual([...buildKeywordNumberMap(records)], [
    ['浴缸\u001f浴缸', 'KW000001'],
    ['浴缸\u001f小浴缸', 'KW000002'],
  ]);
  assert.throws(
    () => buildKeywordNumberMap([...records, records[0]]),
    /duplicate identity/i,
  );
  assert.throws(
    () => buildKeywordNumberMap([
      records[0],
      { fields: { 一级类目: '洗手台', 原始关键词: '台上盆', 关键词编号: 'KW000001' } },
    ]),
    /duplicate keyword number/i,
  );
  assert.throws(
    () => buildKeywordNumberMap([
      { fields: { 一级类目: '浴缸', 原始关键词: '浴缸', 关键词编号: 'KW-浴缸' } },
    ]),
    /invalid keyword number/i,
  );
});

test('keyword number comparison reports zero only when both business tables share the same mapping', () => {
  const analysis = [
    { fields: { 一级类目: '浴缸', 原始关键词: '浴缸', 关键词编号: 'KW000001' } },
    { fields: { 一级类目: '浴缸', 原始关键词: '小浴缸', 关键词编号: 'KW000002' } },
  ];
  const history = structuredClone(analysis);
  assert.equal(countKeywordNumberMappingDifferences(analysis, history), 0);
  history[1].fields.关键词编号 = 'KW000003';
  assert.equal(countKeywordNumberMappingDifferences(analysis, history), 1);
});

test('required tables fail closed while an optional retired table may be absent', () => {
  const tables = [{ table_id: 'tblSource', name: '源表' }];
  assert.equal(findTableById(tables, 'tblSource', { required: true }).name, '源表');
  assert.equal(findTableById(tables, 'tblRetired', { required: false }), null);
  assert.throws(
    () => findTableById(tables, 'tblMissing', { required: true }),
    /required table not found/i,
  );
});

test('number-only mutation policy rejects formula, business-data, and destructive writes', () => {
  const scope = {
    appToken: 'app',
    libraryTableName: '关键词编号库 V1',
    libraryTableIds: new Set(['tblLibrary']),
    businessTableIds: new Set(['tblAnalysis', 'tblHistory']),
  };
  assert.doesNotThrow(() => assertKeywordNumberOnlyMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables',
    body: {
      table: {
        name: '关键词编号库 V1',
        fields: KEYWORD_LIBRARY_FIELDS.map((field) => ({ field_name: field.name })),
      },
    },
  }, scope));
  assert.doesNotThrow(() => assertKeywordNumberOnlyMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables/tblAnalysis/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 关键词编号: 'KW000001' } }] },
  }, scope));
  assert.doesNotThrow(() => assertKeywordNumberOnlyMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables/tblLibrary/records/batch_create',
    body: { records: [{ fields: { 唯一匹配键: '浴缸', 一级类目: '浴缸', 原始关键词: '浴缸', 规范化关键词: '浴缸' } }] },
  }, scope));
  assert.throws(() => assertKeywordNumberOnlyMutation({
    method: 'PUT', path: '/bitable/v1/apps/app/tables/tblAnalysis/fields/fld1', body: {},
  }, scope), /blocked non-number mutation/i);
  assert.throws(() => assertKeywordNumberOnlyMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables/tblAnalysis/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 关键词编号: 'KW000001', 标准归并词: '浴缸' } }] },
  }, scope), /blocked non-number mutation/i);
  assert.throws(() => assertKeywordNumberOnlyMutation({
    method: 'DELETE', path: '/bitable/v1/apps/app/tables/tblAnalysis', body: undefined,
  }, scope), /blocked non-number mutation/i);
  assert.throws(() => assertKeywordNumberOnlyMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables',
    body: { table: { name: '关键词分析 V1（修正版）', fields: [] } },
  }, scope), /blocked non-number mutation/i);
});
