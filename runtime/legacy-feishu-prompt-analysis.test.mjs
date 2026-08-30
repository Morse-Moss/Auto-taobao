import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_AI_FIELDS,
  aggregateLegacyBatchResults,
  buildLegacyProviderInput,
  buildLegacyTasks,
  extractLegacyPrompts,
  parseLegacyProviderResults,
  splitLegacyTasks,
  shouldStopAfterBatch,
} from './legacy-feishu-prompt-analysis.mjs';

const PROMPT_FILE = new URL('./keyword-formulas-ai-prompts-20260809.md', import.meta.url);

test('extracts all seven approved Feishu prompts from the archived artifact', async () => {
  const prompts = await extractLegacyPrompts(PROMPT_FILE.pathname);
  assert.deepEqual(Object.keys(prompts), LEGACY_AI_FIELDS);
  assert.match(prompts['关键词归类'], /只允许输出以下一个值/u);
  assert.match(prompts['内容热度'], /AI预测-高/u);
  assert.match(prompts['对应产品方向'], /小户型深泡款/u);
});

test('builds one local task per record with placeholders resolved', async () => {
  const prompts = await extractLegacyPrompts(PROMPT_FILE.pathname);
  const tasks = buildLegacyTasks({
    prompts,
    records: [{ record_id: 'rec1', fields: {
      搜索词: '小户型浴缸', 关键词编号: 'KW-1', 搜索人气: '600 ~ 1200',
      点击率: '70%', 支付转化率: '2.5% ~ 5%',
    } }],
  });
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].fields, LEGACY_AI_FIELDS);
  assert.match(tasks[0].prompt, /小户型浴缸/u);
  assert.doesNotMatch(tasks[0].prompt, /<[^>]+字段>/u);
});

test('validates aggregate provider results against task ids and output contracts', async () => {
  const prompts = await extractLegacyPrompts(PROMPT_FILE.pathname);
  const [task] = buildLegacyTasks({
    prompts,
    records: [{ record_id: 'rec1', fields: { 搜索词: '浴缸', 关键词编号: 'KW-1' } }],
  });
  const parsed = parseLegacyProviderResults({
    tasks: [task],
    output: [{ taskId: task.taskId, 关键词归类: '大词', 标准归并词: '浴缸', 关键词分类: '核心大词',
      细分标签: '', 用户意图: '了解型', 内容热度: 'AI预测-低', 对应产品方向: '' }],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].字段.用户意图, '了解型');
  assert.throws(() => parseLegacyProviderResults({
    tasks: [task],
    output: [{ taskId: task.taskId, 关键词归类: '不是枚举', 标准归并词: '浴缸', 关键词分类: '核心大词',
      细分标签: '', 用户意图: '了解型', 内容热度: 'AI预测-低', 对应产品方向: '' }],
  }), /关键词归类/u);
});

test('builds a compact provider envelope with prompts shared once', async () => {
  const prompts = await extractLegacyPrompts(PROMPT_FILE.pathname);
  const [task] = buildLegacyTasks({
    prompts,
    records: [{ record_id: 'rec1', fields: { 搜索词: '浴缸', 关键词编号: 'KW-1' } }],
  });
  const envelope = buildLegacyProviderInput({ prompts, tasks: [task] });
  assert.equal(envelope.tasks.length, 1);
  assert.ok(envelope.prompts['关键词归类'].includes('浴缸关键词分类器'));
  assert.equal(envelope.tasks[0].taskId, 'rec1');
  assert.equal(envelope.tasks[0].keyword, '浴缸');
  assert.equal(JSON.stringify(envelope).includes(task.prompt), false);
});

test('splits tasks into deterministic batches with complete non-overlapping coverage', () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({ taskId: `rec-${index + 1}` }));
  const batches = splitLegacyTasks(tasks, 10);
  assert.deepEqual(batches.map((batch) => batch.map((task) => task.taskId)), [
    Array.from({ length: 10 }, (_, index) => `rec-${index + 1}`),
    Array.from({ length: 10 }, (_, index) => `rec-${index + 11}`),
    ['rec-21', 'rec-22', 'rec-23', 'rec-24', 'rec-25'],
  ]);
});

test('aggregates only complete validated batch results and rejects gaps or duplicates', () => {
  const tasks = [{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'c' }];
  const batchResults = new Map([['batch-001', [{ taskId: 'a' }]], ['batch-002', [{ taskId: 'b' }]], ['batch-003', [{ taskId: 'c' }]]]);
  assert.deepEqual(aggregateLegacyBatchResults(tasks, batchResults).map((item) => item.taskId), ['a', 'b', 'c']);
  assert.throws(() => aggregateLegacyBatchResults(tasks, new Map([['batch-001', [{ taskId: 'a' }]], ['batch-003', [{ taskId: 'c' }]]])), /incomplete|missing/u);
  assert.throws(() => aggregateLegacyBatchResults(tasks, new Map([['batch-001', [{ taskId: 'a' }]], ['batch-002', [{ taskId: 'a' }]], ['batch-003', [{ taskId: 'c' }]]])), /duplicate/u);
});

test('supports an explicit canary limit without claiming full completion', () => {
  assert.equal(shouldStopAfterBatch(1, 30, 1), true);
  assert.equal(shouldStopAfterBatch(1, 30, 0), false);
  assert.equal(shouldStopAfterBatch(2, 30, 1), false);
});
