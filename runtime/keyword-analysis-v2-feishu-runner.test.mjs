import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyFieldPlan,
  verifyPreparedTestTable,
} from './keyword-analysis-v2-feishu-runner.mjs';

test('runner applies admitted field updates without creating fields', async () => {
  const calls = [];
  const api = {
    async updateField(fieldId, body) { calls.push(['update', fieldId, body.field_name]); },
    async createField(body) { calls.push(['create', body.field_name]); },
  };
  const result = await applyFieldPlan(api, {
    updates: [{ fieldId: 'fld1', body: { field_name: '排名', type: 2 } }],
    creates: [],
  });
  assert.deepEqual(calls, [
    ['update', 'fld1', '排名'],
  ]);
  assert.deepEqual(result, { updatedCount: 1, createdCount: 0 });
});

test('verification accepts the repaired empty test table and rejects stale options', () => {
  const fields = [
    { field_name: '排名', type: 2 },
    { field_name: '标准归并词', type: 1 },
    { field_name: '关键词分类', type: 3, property: { options: [
      '大词', '品牌词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词',
    ].map((name) => ({ name })) } },
    { field_name: '细分标签', type: 4, property: { options: [{ name: '场景/小户型' }] } },
    { field_name: '用户意图', type: 3, property: { options: [
      '了解型', '对比型', '购买型', '灵感型', '问题解决型',
    ].map((name) => ({ name })) } },
    { field_name: '平台来源', type: 20 },
  ];
  const receipt = verifyPreparedTestTable({ fields, recordCount: 0 });
  assert.equal(receipt.recordCount, 0);
  assert.equal(receipt.mainCategoryOptionCount, 9);
  assert.equal(receipt.intentOptionCount, 5);
  assert.equal(receipt.invalidFineLabelOptionCount, 0);

  const stale = structuredClone(fields);
  stale.find((field) => field.field_name === '细分标签').property.options.push({ name: '浴缸' });
  assert.throws(
    () => verifyPreparedTestTable({ fields: stale, recordCount: 0 }),
    /invalid controlled label option/i,
  );
});
