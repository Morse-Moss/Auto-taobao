import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_ANALYSIS_VERSION,
  FAQ_ANALYSIS_FIELDS,
  classifyFaqText,
  buildAnalysisRecords,
} from './faq-text-analysis.mjs';

test('classifyFaqText uses the fixed priority dictionary and returns one primary topic', () => {
  assert.equal(classifyFaqText('收到后发现有一点味道，尺寸放进小户型刚刚好'), '材质与异味');
  assert.equal(classifyFaqText('客服回复很快，售后沟通很周到'), '售后服务');
  assert.equal(classifyFaqText('完全没有明确问题，只是晒单'), '其他/无法判断');
});

test('buildAnalysisRecords preserves raw fields and emits deterministic topic labels', () => {
  const records = buildAnalysisRecords([
    { recordId: 'rec1', fields: { 商品ID: 'p1', 原始内容: '长度尺寸正合适', 来源类型: '评论' } },
    { recordId: 'rec2', fields: { 商品ID: 'p2', 原始内容: '尺寸也合适', 来源类型: '评论' } },
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].fields.原始内容, '长度尺寸正合适');
  assert.equal(records[0].fields.高频问题或关键词, '尺寸适配');
  assert.equal(records[0].fields.分析版本, FAQ_ANALYSIS_VERSION);
  assert.equal(records[0].fields.出现次数, undefined);
  assert.deepEqual(FAQ_ANALYSIS_FIELDS.map((field) => field.name), [
    '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
    '来源类型', '原始内容', '高频问题或关键词', '出现次数', '采集状态',
    '来源记录唯一键', '采集时间', '分析版本',
  ]);
  assert.equal(FAQ_ANALYSIS_FIELDS.find((field) => field.name === '出现次数').type, 2);
});
