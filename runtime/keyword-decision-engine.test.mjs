import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERNALS,
  PRODUCT_DIRECTION_PROMPT,
  assertAuthorizedMutation,
  buildDecisionPlan,
  comparePlatformRange,
} from './keyword-decision-engine.mjs';

const searchRanges = [
  '0 ~ 20', '20 ~ 50', '50 ~ 150', '150 ~ 300', '300 ~ 600', '600 ~ 1200',
  '1200 ~ 2500', '2500 ~ 5000', '5000 ~ 1万', '1万 ~ 2万',
];

function record(id, fields = {}) {
  return {
    record_id: id,
    fields: {
      关键词编号: 'KW000001',
      一级类目: '浴缸',
      主关键词: '浴缸',
      来源渠道: '淘宝',
      原始关键词: '小户型浴缸',
      搜索词: '小户型浴缸',
      排名: '80',
      搜索人气: '5000 ~ 1万',
      支付转化率: '2.5% ~ 5%',
      搜索热度: '高',
      交易热度: '中',
      是否重点词: null,
      优先级: null,
      ...fields,
    },
  };
}

function week(index) {
  return Date.parse(`2026-0${index + 1}-05T00:00:00+08:00`);
}

test('platform ranges compare only exact known intervals', () => {
  assert.equal(comparePlatformRange('5000 ~ 1万', '2500 ~ 5000', searchRanges), '上升');
  assert.equal(comparePlatformRange('2500 ~ 5000', '2500 ~ 5000', searchRanges), '稳定');
  assert.equal(comparePlatformRange('1200 ~ 2500', '2500 ~ 5000', searchRanges), '下降');
  assert.equal(comparePlatformRange('-', '2500 ~ 5000', searchRanges), '不可比');
  assert.equal(comparePlatformRange('未知区间', '2500 ~ 5000', searchRanges), '不可比');
  assert.equal(comparePlatformRange('0 ~ 20', '20 ~ 50', searchRanges), '下降');
});

test('weekly grouping follows Asia/Shanghai rather than UTC day boundaries', () => {
  assert.equal(
    INTERNALS.mondayKey('2026-08-10T00:30:00+08:00'),
    INTERNALS.mondayKey('2026-08-16T23:30:00+08:00'),
  );
  assert.notEqual(
    INTERNALS.mondayKey('2026-08-09T23:30:00+08:00'),
    INTERNALS.mondayKey('2026-08-10T00:30:00+08:00'),
  );
});

test('fewer than eight valid weekly batches keeps key-word status observing', () => {
  const history = Array.from({ length: 7 }, (_, index) => record(`h${index}`, {
    采集日期: week(index),
  }));
  const plan = buildDecisionPlan({ currentRecords: [record('current')], historyRecords: history });
  assert.equal(plan.decisions[0].desired.是否重点词, '观察中');
});

test('eight-week window marks six appearances as key and five as non-key', () => {
  const batches = Array.from({ length: 8 }, (_, index) => record(`scope-${index}`, {
    关键词编号: index < 6 ? 'KW000001' : `KW9${index}`,
    原始关键词: index < 6 ? '小户型浴缸' : `占位词${index}`,
    搜索词: index < 6 ? '小户型浴缸' : `占位词${index}`,
    采集日期: week(index),
  }));
  const six = buildDecisionPlan({ currentRecords: [record('current')], historyRecords: batches });
  assert.equal(six.decisions[0].desired.是否重点词, '是');

  batches[5] = record('scope-5', {
    关键词编号: 'KW900005', 原始关键词: '占位词5', 搜索词: '占位词5', 采集日期: week(5),
  });
  const five = buildDecisionPlan({ currentRecords: [record('current')], historyRecords: batches });
  assert.equal(five.decisions[0].desired.是否重点词, '否');
});

test('duplicates in the same week count once for long-term frequency', () => {
  const history = Array.from({ length: 8 }, (_, index) => record(`h${index}`, {
    关键词编号: index < 5 ? 'KW000001' : `KW8${index}`,
    采集日期: week(index),
  }));
  history.push(record('duplicate', { 采集日期: week(0) + 24 * 60 * 60 * 1000 }));
  const plan = buildDecisionPlan({ currentRecords: [record('current')], historyRecords: history });
  assert.equal(plan.decisions[0].desired.是否重点词, '否');
});

test('first batch uses current high search and trade to assign B only', () => {
  const current = [
    record('high'),
    record('low', { 关键词编号: 'KW000002', 搜索热度: '低', 交易热度: '中' }),
  ];
  const plan = buildDecisionPlan({ currentRecords: current, historyRecords: [] });
  assert.deepEqual(plan.decisions.map((item) => item.desired.优先级), [
    'B-持续观察', '观察中',
  ]);
});

test('second batch can trigger A when conversion and another signal rise without decline', () => {
  const previous = record('previous', {
    采集日期: week(0), 排名: '90', 搜索人气: '2500 ~ 5000', 支付转化率: '1% ~ 2.5%',
  });
  const plan = buildDecisionPlan({ currentRecords: [record('current')], historyRecords: [previous] });
  assert.equal(plan.decisions[0].desired.优先级, 'A-立即跟进');
});

test('rank and search rising cannot exceed B when trade is incomparable', () => {
  const previous = record('previous', {
    采集日期: week(0), 排名: '100', 搜索人气: '2500 ~ 5000', 支付转化率: '-', 交易热度: '无数据',
  });
  const current = record('current', { 支付转化率: '-', 交易热度: '无数据' });
  const plan = buildDecisionPlan({ currentRecords: [current], historyRecords: [previous] });
  assert.equal(plan.decisions[0].desired.优先级, 'B-持续观察');
});

test('a new or returning top-100 word with medium trade is A', () => {
  const previousScope = record('other', {
    关键词编号: 'KW000999', 原始关键词: '其他浴缸', 搜索词: '其他浴缸', 采集日期: week(1),
  });
  const current = record('current', { 排名: '99', 交易热度: '中' });
  const plan = buildDecisionPlan({ currentRecords: [current], historyRecords: [previousScope] });
  assert.equal(plan.decisions[0].desired.优先级, 'A-立即跟进');
});

test('diverging comparable signals are B and non-rising ordinary signals are C', () => {
  const previous = record('previous', {
    采集日期: week(0), 排名: '70', 搜索人气: '2500 ~ 5000', 支付转化率: '2.5% ~ 5%',
    搜索热度: '中', 交易热度: '中',
  });
  const diverging = record('diverging', {
    排名: '60', 搜索人气: '1200 ~ 2500', 支付转化率: '2.5% ~ 5%', 搜索热度: '低',
  });
  const stable = record('stable', {
    排名: '70', 搜索人气: '2500 ~ 5000', 支付转化率: '2.5% ~ 5%', 搜索热度: '中',
  });
  assert.equal(buildDecisionPlan({ currentRecords: [diverging], historyRecords: [previous] }).decisions[0].desired.优先级, 'B-持续观察');
  assert.equal(buildDecisionPlan({ currentRecords: [stable], historyRecords: [previous] }).decisions[0].desired.优先级, 'C-常规跟踪');
});

test('one comparable stable or declining signal stays observing even when current heat is high', () => {
  const previous = record('previous', {
    采集日期: week(0), 排名: '', 搜索人气: '1万 ~ 2万', 支付转化率: '-', 交易热度: '无数据',
  });
  const current = record('current', { 排名: '', 支付转化率: '-', 交易热度: '中' });
  const plan = buildDecisionPlan({ currentRecords: [current], historyRecords: [previous] });
  assert.equal(plan.decisions[0].desired.优先级, '观察中');
});

test('blank rows are ignored and non-empty decisions are conflicts, never overwritten', () => {
  const current = [
    record('manual', { 是否重点词: '是', 优先级: 'A-立即跟进' }),
    record('blank', {
      关键词编号: '', 原始关键词: '', 搜索词: '', 排名: '', 搜索人气: '', 支付转化率: '',
    }),
  ];
  const plan = buildDecisionPlan({ currentRecords: current, historyRecords: [] });
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.conflicts.length, 2);
  assert.equal(plan.ignoredBlankCount, 1);
});

test('product direction prompt uses the four approved fields and rejects invented attributes', () => {
  for (const field of ['原始关键词', '标准归并词', '关键词分类', '细分标签']) {
    assert.match(PRODUCT_DIRECTION_PROMPT, new RegExp(`\\{\\{${field}\\}\\}`));
  }
  assert.match(PRODUCT_DIRECTION_PROMPT, /原始关键词是最终事实依据/);
  assert.match(PRODUCT_DIRECTION_PROMPT, /禁止补充.*没有明确表达/s);
  assert.match(PRODUCT_DIRECTION_PROMPT, /清洁.*维修.*漏水.*不形成产品方向/s);
  assert.match(PRODUCT_DIRECTION_PROMPT, /定位.*人群\/场景.*尺寸.*材质.*风格.*形状\/款式.*安装方式.*功能\/需求.*浴缸/s);
  assert.doesNotMatch(PRODUCT_DIRECTION_PROMPT, /小户型深泡款|人造石高端款|方形独立式|靠墙式小浴缸/);
});

test('mutation guard permits only current-table decisions and product-direction field config', () => {
  const scope = {
    appToken: 'app',
    currentTableId: 'tblCurrent',
    productDirectionFieldId: 'fldDirection',
  };
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app/tables/tblCurrent/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 是否重点词: '观察中', 优先级: 'B-持续观察' } }] },
  }, scope));
  assert.doesNotThrow(() => assertAuthorizedMutation({
    method: 'PUT',
    path: '/bitable/v1/apps/app/tables/tblCurrent/fields/fldDirection',
    body: { field_name: '对应产品方向', type: 1 },
  }, scope));
  for (const request of [
    {
      method: 'POST', path: '/bitable/v1/apps/app/tables/tblHistory/records/batch_update',
      body: { records: [{ record_id: 'rec1', fields: { 优先级: 'A-立即跟进' } }] },
    },
    {
      method: 'POST', path: '/bitable/v1/apps/app/tables/tblCurrent/records/batch_update',
      body: { records: [{ record_id: 'rec1', fields: { 用户意图: '购买型' } }] },
    },
    {
      method: 'DELETE', path: '/bitable/v1/apps/app/tables/tblCurrent/records/rec1', body: {},
    },
  ]) {
    assert.throws(() => assertAuthorizedMutation(request, scope), /Blocked unauthorized mutation/);
  }
});
