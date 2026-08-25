import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOptions, validateFieldContract } from './apply-local-keyword-analysis.mjs';

test('write mode requires exact base and table confirmations', () => {
  const common = [
    '--app-token', 'app1', '--table-id', 'tbl1', '--table-name', 'Current',
    '--env-file', 'secret.env',
  ];
  assert.equal(parseOptions(common).apply, false);
  assert.equal(parseOptions([...common, '--replace-user-intent']).replaceUserIntent, true);
  assert.throws(() => parseOptions([...common, '--apply']), /confirm-base/);
  assert.throws(() => parseOptions([...common, '--apply', '--confirm-base', 'app1']), /confirm-table/);
  const options = parseOptions([
    ...common, '--apply', '--confirm-base', 'app1', '--confirm-table', 'tbl1',
  ]);
  assert.equal(options.apply, true);
});

test('field contract requires exact writable types and controlled options', () => {
  const fields = [
    { field_name: '原始关键词', type: 1 },
    { field_name: '标准归并词', type: 1 },
    { field_name: '关键词分类', type: 3, property: { options: [
      '大词', '品牌词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词',
    ].map((name) => ({ name })) } },
    { field_name: '细分标签', type: 4, property: { options: [
      { name: '场景/小户型' }, { name: '材质/亚克力' }, { name: '痛点/漏水' },
    ] } },
    { field_name: '用户意图', type: 3, property: { options: [
      '了解型', '对比型', '购买型', '灵感型', '问题解决型',
    ].map((name) => ({ name })) } },
  ];
  assert.doesNotThrow(() => validateFieldContract(fields, {
    categories: ['大词', '品牌词'], labels: ['场景/小户型'], intents: ['了解型'],
  }));
  assert.throws(() => validateFieldContract(
    fields.map((field) => field.field_name === '细分标签' ? { ...field, type: 1 } : field),
    { categories: [], labels: [], intents: [] },
  ), /细分标签 expected type 4/);
  assert.throws(() => validateFieldContract(fields, {
    categories: ['未知类'], labels: [], intents: [],
  }), /missing option/);
});

test('field contract accepts the live formula-backed source keyword field', () => {
  const fields = [
    { field_name: '原始关键词', type: 20 },
    { field_name: '标准归并词', type: 1 },
    { field_name: '关键词分类', type: 3, property: { options: [{ name: '大词' }] } },
    { field_name: '细分标签', type: 4, property: { options: [] } },
    { field_name: '用户意图', type: 3, property: { options: [{ name: '了解型' }] } },
  ];
  assert.doesNotThrow(() => validateFieldContract(fields, {
    categories: ['大词'], labels: [], intents: ['了解型'],
  }));
});

test('field contract accepts the live AI-backed standard merge field', () => {
  const fields = [
    { field_name: '原始关键词', type: 20 },
    { field_name: '标准归并词', type: 25 },
    { field_name: '关键词分类', type: 3, property: { options: [{ name: '大词' }] } },
    { field_name: '细分标签', type: 4, property: { options: [] } },
    { field_name: '用户意图', type: 3, property: { options: [{ name: '了解型' }] } },
  ];
  assert.doesNotThrow(() => validateFieldContract(fields, {
    categories: ['大词'], labels: [], intents: ['了解型'],
  }));
});
