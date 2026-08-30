import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviderCommand, parseProviderOutput, runProvider } from './local-provider-runner.mjs';

test('provider command is explicit and reads the task prompt from stdin', () => {
  assert.deepEqual(buildProviderCommand('codex', 'tasks.json'), {
    command: process.platform === 'win32' ? 'codex.cmd' : 'codex',
    args: ['exec', '-'],
    taskFile: 'tasks.json',
  });
  assert.deepEqual(buildProviderCommand('cc', 'tasks.json'), {
    command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
    args: ['-p', '--output-format', 'json'],
    taskFile: 'tasks.json',
  });
  assert.throws(() => buildProviderCommand('unknown', 'tasks.json'), /unsupported provider/i);
});

test('provider output must be a JSON array', () => {
  assert.deepEqual(parseProviderOutput('[{"record_id":"rec1"}]'), [{ record_id: 'rec1' }]);
  assert.throws(() => parseProviderOutput('not-json'), /invalid provider output/i);
  assert.throws(() => parseProviderOutput('{"record_id":"rec1"}'), /array/i);
});

test('runner delegates to injected process without provider fallback', async () => {
  const calls = [];
  const result = await runProvider('cc', 'tasks.json', {
    readTaskFile: () => JSON.stringify([{
      taskId: 'real-record-id:内容热度', recordId: 'real-record-id', providerTaskId: 'p0001',
      keywordId: 'KW000001', fields: ['内容热度'], prompt: '分析浴缸', promptHash: 'hash',
    }]),
    spawnProcess: async (command, args, taskFile, input) => {
      calls.push({ command, args, taskFile, input });
      return '[{"record_id":"rec1","value":"中"}]';
    },
  });
  assert.deepEqual(result, [{ record_id: 'rec1', value: '中' }]);
  assert.deepEqual(calls[0], {
    command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
    args: ['-p', '--output-format', 'json'],
    taskFile: 'tasks.json',
    input: 'You are a batch processor, not a conversational assistant. Execute every task now. Do not ask questions, explain, summarize, or use tools. Return exactly one JSON object for each of the 1 distinct providerTaskId values in the task list. Each object must have taskId equal to the providerTaskId and exactly these keys: taskId, 内容热度, 对应产品方向. 内容热度 must be one of 低, 中, 高, 待核验. 对应产品方向 must be exactly one of 小户型深泡款, 人造石高端款, 方形独立式, 靠墙式小浴缸, or an empty string. Return only the JSON array, with no markdown or other text.\n\n[CONTENT_HEAT_RULES]\n内容热度是内容创作潜力预测，不是真实内容平台热度。明确问题、对比、选购、场景或可解释属性，且搜索热度或交易热度为高时输出高；有清晰属性或场景但信号一般时输出中；纯品牌、店铺、导航、过度宽泛、信息不足，或搜索与交易信号都弱且无内容切入点时输出低；无法根据输入确认时输出待核验。不得补造平台数据，也不得因品牌知名自动输出高。\n\n[TASKS]\n[{"providerTaskId":"p0001","fields":["内容热度","对应产品方向"],"prompt":"分析浴缸"}]',
  });
  await assert.rejects(runProvider('workbuddy', 'tasks.json', {
    readTaskFile: () => '[]',
    spawnProcess: async () => { throw new Error('provider unavailable'); },
  }), /provider unavailable/iu);
});
