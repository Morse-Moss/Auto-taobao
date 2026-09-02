import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalysisRecords } from './faq-text-analysis.mjs';
import {
  FAQ_DETAIL_FIELDS,
  assertDetailReadBack,
  buildDetailReplacementPlan,
  detailRowsHash,
  sourceTopicSetHash,
} from './faq-detail-enrichment.mjs';

const period = '2026-08-23_2026-08-29';
const raw = {
  recordId: 'raw-1',
  fields: {
    商品ID: 'p1',
    商品链接: 'https://item.example.test/?id=p1',
    来源类型: '评论',
    原始内容: '没有一点味道，排水顺畅，外观好看',
    来源记录唯一键: 'source-1',
    crossWeekDedupKey: 'text:source-1',
    sourceDedupKey: 'source-1',
    采集状态: '已采集',
  },
};

function content() {
  return {
    content: {
      异味问题: { 痛点描述: '异味描述', 典型问题: '是否有异味？', 典型用户原话: '无异味原话' },
      '排水/漏水问题': { 痛点描述: '排水描述', 典型问题: '排水是否顺畅？', 典型用户原话: '排水原话' },
      '好评-外观颜值': { 痛点描述: '', 典型问题: '外观是否好看？', 典型用户原话: '外观原话' },
      '好评-无异味': { 痛点描述: '', 典型问题: '是否没有异味？', 典型用户原话: '无异味原话' },
    },
  };
}

test('replacement plan materializes independently evidenced positive source-topic rows', () => {
  const records = buildAnalysisRecords([raw]);
  const plan = buildDetailReplacementPlan({ finalRecords: records, operatorContent: content(), period });
  assert.equal(plan.master.rowCount, records.length);
  assert.equal(plan.weekly.rowCount, records.length);
  assert.equal(plan.fields, FAQ_DETAIL_FIELDS);
  assert.equal(plan.denominator, 1);
  for (const label of ['好评-外观颜值', '好评-无异味']) {
    const row = plan.weekly.rows.find((item) => item.分类标签 === label);
    assert.equal(row.是否痛点, '否');
    assert.equal(row.来源记录唯一键, 'source-1');
    assert.equal(row.出现次数, 1);
    assert.equal(row.占比, 1);
  }
  assert.equal(plan.weekly.rows.some((item) => ['异味问题', '排水/漏水问题'].includes(item.分类标签)), false);
  assert.equal(plan.master.sourceTopicHash, sourceTopicSetHash(records));
  assert.equal(plan.master.rowsHash, detailRowsHash(plan.master.rows));
});

test('detail schema places operator fields after occurrence count and formats share', () => {
  const names = FAQ_DETAIL_FIELDS.map(({ name }) => name);
  const occurrenceIndex = names.indexOf('出现次数');
  assert.deepEqual(names.slice(occurrenceIndex, occurrenceIndex + 5), [
    '出现次数', '痛点描述', '典型问题', '典型用户原话', '占比',
  ]);
  assert.equal(FAQ_DETAIL_FIELDS.find(({ name }) => name === '占比').property.formatter, '0.00%');
});

test('detail statistics count unique sources instead of source-topic rows', () => {
  const first = buildAnalysisRecords([{
    ...raw,
    fields: { ...raw.fields, 原始内容: '打开以后很臭，排水漏水' },
  }]);
  const secondSmell = structuredClone(buildAnalysisRecords([{
    recordId: 'raw-2',
    fields: {
      ...raw.fields,
      原始内容: '打开以后很臭，味道很重',
      来源记录唯一键: 'source-2',
      crossWeekDedupKey: 'text:source-2',
    },
  }]).find((record) => record.fields.分类标签 === '异味问题'));
  secondSmell.recordId = 'raw-2-smell';
  secondSmell.fields.来源记录唯一键 = 'source-2';
  secondSmell.crossWeekDedupKey = 'text:source-2';
  secondSmell.fields.crossWeekDedupKey = 'text:source-2';
  const records = [
    first.find((record) => record.fields.分类标签 === '异味问题'),
    first.find((record) => record.fields.分类标签 === '排水/漏水问题'),
    secondSmell,
  ];
  const plan = buildDetailReplacementPlan({ finalRecords: records, operatorContent: content(), period });
  assert.equal(plan.denominator, 2);
  assert.notEqual(records[0].fields.来源记录唯一键, records[2].fields.来源记录唯一键);
  assert.notEqual(records[0].crossWeekDedupKey, records[2].crossWeekDedupKey);
  assert.deepEqual(plan.topicStatistics['异味问题'], { count: 2, share: 1 });
  assert.deepEqual(plan.topicStatistics['排水/漏水问题'], { count: 1, share: 0.5 });
  for (const row of plan.weekly.rows.filter((item) => item.分类标签 === '异味问题')) {
    assert.equal(row.出现次数, 2);
    assert.equal(row.占比, 1);
  }
  const drainage = plan.weekly.rows.find((item) => item.分类标签 === '排水/漏水问题');
  assert.equal(drainage.出现次数, 1);
  assert.equal(drainage.占比, 0.5);
});

test('reviewed supplemental labels use human evidence when operator catalog has no entry', () => {
  const [base] = buildAnalysisRecords([raw]);
  const supplemental = structuredClone(base);
  supplemental.fields.分类标签 = '安装困难';
  supplemental.fields.是否痛点 = '是';
  supplemental.fields.痛点判定依据 = '安装比较麻烦点';
  supplemental.humanReviewReason = '评论明确表达实际安装过程较麻烦';
  const plan = buildDetailReplacementPlan({ finalRecords: [supplemental], operatorContent: content(), period });
  assert.equal(plan.weekly.rows[0].痛点描述, '评论明确表达实际安装过程较麻烦');
  assert.equal(plan.weekly.rows[0].典型问题, '安装困难');
  assert.equal(plan.weekly.rows[0].典型用户原话, '安装比较麻烦点');
});

test('replacement plan rejects duplicate source-topic identity', () => {
  const [record] = buildAnalysisRecords([raw]);
  assert.throws(() => buildDetailReplacementPlan({ finalRecords: [record, structuredClone(record)], operatorContent: content(), period }), /duplicate source-topic identity/u);
});

test('read-back verification detects row mutation and count drift', () => {
  const records = buildAnalysisRecords([raw]);
  const plan = buildDetailReplacementPlan({ finalRecords: records, operatorContent: content(), period });
  const readBack = plan.weekly.rows.map((fields, index) => ({ recordId: `rec-${index}`, fields: structuredClone(fields) }));
  readBack[0].fields.占比 = Number((readBack[0].fields.占比 - 4e-16).toPrecision(15));
  assert.equal(assertDetailReadBack({ records: readBack, expectedRows: plan.weekly.rows }).rowCount, records.length);
  readBack[0].fields.出现次数 += 1;
  assert.throws(() => assertDetailReadBack({ records: readBack, expectedRows: plan.weekly.rows }), /read-back mismatch/u);
  readBack[0].fields.出现次数 -= 1;
  readBack[0].fields.占比 = 0.5;
  assert.throws(() => assertDetailReadBack({ records: readBack, expectedRows: plan.weekly.rows }), /read-back mismatch/u);
  assert.throws(() => assertDetailReadBack({ records: readBack.slice(1), expectedRows: plan.weekly.rows }), /record count mismatch/u);
});
