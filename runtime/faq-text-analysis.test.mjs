import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_ANALYSIS_VERSION,
  FAQ_ANALYSIS_FIELDS,
  classifyFaqText,
  buildAnalysisRecords,
  isExplicitDefaultReview,
} from './faq-text-analysis.mjs';

test('classifyFaqText returns multiple pain and positive labels', () => {
  const result = classifyFaqText('不包安装，浴缸很重很难搬，但是外观很好看，质感不错');
  assert.deepEqual(result.labels, ['重量大/搬运困难', '不包安装/安装费贵']);
  assert.deepEqual(result.painLabels, ['重量大/搬运困难', '不包安装/安装费贵']);
  assert.equal(result.isPain, true);
});

test('negative positive signals do not create false pain labels', () => {
  const result = classifyFaqText('没有一点味道，排水顺畅，好清洁，尺寸刚刚好');
  assert.deepEqual(result.labels, ['好评-无异味', '好评-易清洁']);
  assert.equal(result.isPain, false);
});

test('default review detection is explicit and blank content is invalid', () => {
  assert.equal(isExplicitDefaultReview('该用户觉得商品非常好，给出好评'), true);
  assert.deepEqual(classifyFaqText('该用户觉得商品非常好，给出好评').labels, ['系统默认/无内容']);
  assert.equal(classifyFaqText('   ').isValid, false);
});

test('buildAnalysisRecords preserves raw fields and emits versioned labels', () => {
  const records = buildAnalysisRecords([
    { recordId: 'rec1', fields: { 商品ID: 'p1', 原始内容: '长度尺寸正合适', 来源类型: '评论', 来源记录唯一键: 'k1' } },
    { recordId: 'rec2', fields: { 商品ID: 'p2', 原始内容: '尺寸有差距，质量一般', 来源类型: '评论', 来源记录唯一键: 'k2' } },
  ]);
  assert.equal(records.length, 3);
  assert.equal(records[0].fields.原始内容, '长度尺寸正合适');
  assert.equal(records[0].fields.分类标签, '其他评价');
  assert.equal(records[0].fields.是否痛点, '否');
  assert.equal(records[0].fields.分析版本, FAQ_ANALYSIS_VERSION);
  assert.deepEqual(records.slice(1).map((record) => record.fields.分类标签), ['尺寸不符/偏大偏小', '品质瑕疵(划痕/裂纹/破损)']);
  assert.equal(records[1].fields.出现次数, undefined);
  assert.deepEqual(FAQ_ANALYSIS_FIELDS.map((field) => field.name), [
    '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
    '来源类型', '原始内容', '分类标签', '是否痛点', '出现次数', '采集状态',
    '来源记录唯一键', '采集时间', '分析版本',
  ]);
  assert.equal(FAQ_ANALYSIS_FIELDS.find((field) => field.name === '出现次数').type, 2);
});
