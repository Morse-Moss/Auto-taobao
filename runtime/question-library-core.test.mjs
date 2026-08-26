import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUESTION_WEEKLY_FIELDS,
  buildQuestionRecord,
  normalizeExportRows,
  selectTopABCompetitors,
  sourceRecordKey,
} from './question-library-core.mjs';

function competitor({ id, monthly, rank, classification = 'A-爆款竞品', validity = '是' }) {
  return {
    recordId: `rec-${id}`,
    fields: {
      商品ID: id,
      商品链接: `https://item.taobao.com/item.htm?id=${id}`,
      商品标题: `浴缸 ${id}`,
      竞品分类: classification,
      是否有效竞品: validity,
      月收货人数计算值: monthly,
      序号: rank,
    },
  };
}

test('weekly schema contains stable product, source, raw-content, and idempotency fields', () => {
  assert.deepEqual(QUESTION_WEEKLY_FIELDS.map((field) => field.name), [
    '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
    '来源类型', '原始内容', '高频问题或关键词', '出现次数', '采集状态',
    '来源记录唯一键', '采集时间',
  ]);
});

test('selectTopABCompetitors uses formula monthly value and rank as deterministic tie-breaker', () => {
  const rows = [
    competitor({ id: 'a', monthly: 90, rank: 9 }),
    competitor({ id: 'b', monthly: 120, rank: 8 }),
    competitor({ id: 'c', monthly: 120, rank: 3 }),
    competitor({ id: 'd', monthly: 80, rank: 1 }),
    competitor({ id: 'e', monthly: 70, rank: 2 }),
    competitor({ id: 'f', monthly: 999, rank: 4, validity: '否' }),
    competitor({ id: 'g', monthly: 999, rank: 5, classification: 'B-高价值竞品' }),
    competitor({ id: 'h', monthly: '', rank: 6 }),
  ];
  assert.deepEqual(selectTopABCompetitors(rows, { limit: 5 }).map((row) => row.fields.商品ID), [
    'g', 'c', 'b', 'a', 'd',
  ]);
});

test('selectTopACompetitors unwraps Feishu select/formula display values', () => {
  const row = competitor({ id: 'array', monthly: 200, rank: 1 });
  row.fields.竞品分类 = [{ text: 'A-爆款竞品', type: 'text' }];
  row.fields.是否有效竞品 = [{ text: '是', type: 'text' }];
  assert.equal(selectTopABCompetitors([row]).length, 1);
});

test('normalizeExportRows preserves each question and answer as one raw record', () => {
  const rows = normalizeExportRows('问大家', [
    { 问题: '好安装吗？', 回答: '自己安装即可' },
    { 问题: '有异味吗？', 回答: '没有' },
  ]);
  assert.deepEqual(rows, [
    { sourceRowNumber: 2, rawContent: '问题：好安装吗？\n回答：自己安装即可' },
    { sourceRowNumber: 3, rawContent: '问题：有异味吗？\n回答：没有' },
  ]);
});

test('normalizeExportRows preserves review raw text and ignores blank rows', () => {
  const rows = normalizeExportRows('评论', [
    { 评论内容: '物流很快', 时间: '2026-08-25' },
    { 评论内容: '', 时间: '' },
    { 评论内容: '安装方便', 时间: '2026-08-24' },
  ]);
  assert.deepEqual(rows, [
    { sourceRowNumber: 2, rawContent: '物流很快' },
    { sourceRowNumber: 4, rawContent: '安装方便' },
  ]);
});

test('sourceRecordKey is stable and buildQuestionRecord leaves analysis fields empty', () => {
  const key = sourceRecordKey({ period: '2026-08-23_2026-08-29', productId: 'p1', sourceType: '评论', sourceHash: 'abc', sourceRowNumber: 2 });
  assert.equal(key, '2026-08-23_2026-08-29|p1|评论|abc|2');
  const record = buildQuestionRecord({
    period: '2026-08-23_2026-08-29',
    competitor: competitor({ id: 'p1', monthly: 100, rank: 1 }),
    sourceType: '评论',
    rawContent: '物流很快',
    sourceHash: 'abc',
    sourceRowNumber: 2,
    collectedAt: '2026-08-25T10:00:00.000Z',
  });
  assert.equal(record.原始内容, '物流很快');
  assert.equal(record.高频问题或关键词, '');
  assert.equal(record.出现次数, '');
  assert.equal(record.采集状态, '已采集');
  assert.equal(record.来源记录唯一键, key);
});
