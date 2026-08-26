import test from 'node:test';
import assert from 'node:assert/strict';

import { applyOperatorPublish, planTemplateSync } from './sync-question-library-template.mjs';

const row = (content) => ({
  商品链接: 'https://item.taobao.com/item.htm?id=1',
  商品标题: '测试浴缸',
  竞品分类: ['B-高价值竞品'],
  来源类型: '评论',
  原始内容: content,
  高频问题或关键词: '材质与异味',
  出现次数: 2,
  采集状态: '已采集',
});

test('empty operator table plans a first publish', () => {
  assert.deepEqual(planTemplateSync([], [row('a')]), { mode: 'CREATE_EMPTY_TARGET', toCreate: 1, toDelete: 0 });
});

test('same operator snapshot is idempotent', () => {
  assert.deepEqual(planTemplateSync([row('a')], [row('a')]), { mode: 'NOOP_EXACT_MATCH', toCreate: 0, toDelete: 0 });
});

test('different period is blocked without explicit replacement', () => {
  assert.deepEqual(planTemplateSync([row('old')], [row('new')]), { mode: 'BLOCKED_NON_EMPTY_MISMATCH', toCreate: 0, toDelete: 0 });
});

test('different period plans replacement only when explicitly enabled', () => {
  assert.deepEqual(planTemplateSync([row('old')], [row('new'), row('new-2')], true), { mode: 'REPLACE_CURRENT', toCreate: 2, toDelete: 1 });
});

function fakeClient(initial, mismatchAfterCreate = false) {
  let records = initial.map((fields, index) => ({ recordId: `old${index}`, fields }));
  let sequence = 0;
  let mismatchPending = mismatchAfterCreate;
  return {
    async batchDeleteRecords(_tableId, ids) { records = records.filter((record) => !ids.includes(record.recordId)); },
    async batchCreateRecords(_tableId, fieldsList) {
      records.push(...fieldsList.map((fields) => ({ recordId: `new${sequence++}`, fields })));
    },
    async listRecords() {
      if (mismatchPending && records.some((record) => record.recordId.startsWith('new'))) {
        mismatchPending = false;
        return records.map((record, index) => index === 0 ? { ...record, fields: { ...record.fields, 原始内容: '损坏' } } : record);
      }
      return records;
    },
    snapshot() { return records.map((record) => record.fields); },
  };
}

test('replacement restores the previous operator snapshot when read-back verification fails', async () => {
  const previous = [row('old')];
  const client = fakeClient(previous, true);
  await assert.rejects(() => applyOperatorPublish({
    client,
    tableId: 'tblRS5lo0nNN3DOJ',
    plan: { mode: 'REPLACE_CURRENT' },
    existingRecords: [{ recordId: 'old0', fields: previous[0] }],
    existingRows: previous,
    desiredRows: [row('new')],
    writeBackup: async () => {},
  }), /read-back mismatch/u);
  assert.deepEqual(client.snapshot(), previous);
});

test('failed first publish removes partial new rows and leaves the operator table empty', async () => {
  const client = fakeClient([], true);
  await assert.rejects(() => applyOperatorPublish({
    client,
    tableId: 'tblRS5lo0nNN3DOJ',
    plan: { mode: 'CREATE_EMPTY_TARGET' },
    existingRecords: [],
    existingRows: [],
    desiredRows: [row('new')],
    writeBackup: async () => {},
  }), /read-back mismatch/u);
  assert.deepEqual(client.snapshot(), []);
});
