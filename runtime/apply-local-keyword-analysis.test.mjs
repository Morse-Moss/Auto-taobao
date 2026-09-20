import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseOptions, readbackText, validateFieldContract } from './apply-local-keyword-analysis.mjs';

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

test('readback text unwraps formula-shaped values instead of stringifying to [object Object]', () => {
  // 公式字段（type=20）从飞书 API 读回来是对象，不是字符串。2026-09-20 第一次真跑时
  // 收据里的 `priorityDistribution` 整条变成 `{"[object Object]": 300}` —— 看着像有数据，
  // 实际什么都没说。这条断言把「归一出可读文本」钉住。
  assert.equal(readbackText({ type: 'text', value: [{ text: 'C-常规跟踪' }] }), 'C-常规跟踪');
  assert.equal(readbackText([{ text: 'A' }, { text: 'B' }]), 'AB');
  assert.equal(readbackText({ value: [{ text: '高' }, { text: '中' }] }), '高中');
  assert.equal(readbackText({ value: '标量' }), '标量');
  assert.equal(readbackText({ text: ' 待数据 ' }), '待数据');
  assert.equal(readbackText({ name: '场景/小户型' }), '场景/小户型');
  assert.equal(readbackText('  常规  '), '常规');
  assert.equal(readbackText(0), '0');
  assert.equal(readbackText(null), '');
  assert.equal(readbackText(undefined), '');
  assert.equal(readbackText({ type: 'text', value: [] }), '');
  assert.equal(readbackText({ value: null }), '');
  for (const sample of [
    { type: 'text', value: [{ text: 'C-常规跟踪' }] },
    [{ text: 'A' }, { text: 'B' }],
    { value: [{ text: '高' }] },
    { text: ' 待数据 ' },
  ]) {
    const once = readbackText(sample);
    assert.ok(!once.includes('[object Object]'), 'readback 不得退化成 [object Object]');
    // 幂等：结果被回喂也必须原样返回。不幂等意味着「带空格的键」和「不带空格的键」
    // 会被统计成两条，把分布悄悄撕开。
    assert.equal(readbackText(once), once, `readback 必须幂等（样本 ${JSON.stringify(sample)}）`);
    assert.equal(once, once.trim(), 'readback 结果不得带首尾空白');
  }
});

test('receipt source uses readbackText for the formula-backed 优先级 column', () => {
  // 只测函数还不够：真正出问题的是调用点。如果哪天有人把这里改回 `String(...)`，
  // 函数测试依然全绿而收据又开始产假信息，所以对调用点本身留一条源码断言。
  const sourceFile = fileURLToPath(new URL('./apply-local-keyword-analysis.mjs', import.meta.url));
  const source = fs.readFileSync(sourceFile, 'utf8');
  assert.ok(
    source.includes('readbackText(record.fields?.优先级)'),
    '收据里的 priorityDistribution 必须走 readbackText',
  );
  assert.ok(
    !source.includes('String(record.fields?.优先级'),
    '不得把公式字段直接 String() 化（会得到 [object Object]）',
  );
  assert.ok(path.isAbsolute(sourceFile));
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
