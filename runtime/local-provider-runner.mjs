#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;

const COMMANDS = Object.freeze({
  cc: Object.freeze({ command: executable('claude'), args: ['-p'] }),
  codex: Object.freeze({ command: executable('codex'), args: ['exec', '-'] }),
  workbuddy: Object.freeze({ command: executable('workbuddy'), args: ['run'] }),
});

const CONTENT_HEAT_RULES = '内容热度是内容创作潜力预测，不是真实内容平台热度。明确问题、对比、选购、场景或可解释属性，且搜索热度或交易热度为高时输出高；有清晰属性或场景但信号一般时输出中；纯品牌、店铺、导航、过度宽泛、信息不足，或搜索与交易信号都弱且无内容切入点时输出低；无法根据输入确认时输出待核验。不得补造平台数据，也不得因品牌知名自动输出高。';

export function buildProviderCommand(provider, taskFile) {
  const definition = COMMANDS[provider];
  if (!definition) throw new Error(`Unsupported provider: ${provider}`);
  if (!taskFile) throw new Error('Provider task file is required');
  return {
    command: definition.command,
    args: provider === 'cc'
      ? [...definition.args, '--output-format', 'json']
      : definition.args,
    taskFile,
  };
}

export function parseProviderOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch {
    throw new Error('Invalid provider output: expected JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid provider output: expected an array');
  return parsed;
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/u.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function defaultSpawnProcess(command, args, taskFile, input) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args.map(quoteWindowsArg)].join(' ')], { windowsHide: true })
      : spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Provider ${command} failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

export async function runProvider(provider, taskFile, dependencies = {}) {
  const definition = buildProviderCommand(provider, taskFile);
  const readTaskFile = dependencies.readTaskFile ?? ((file) => readFileSync(file, 'utf8'));
  const taskText = readTaskFile(taskFile);
  let providerTasks;
  try {
    const taskList = JSON.parse(taskText);
    const byProviderTask = new Map();
    for (const task of taskList) {
      if (!task?.providerTaskId || !Array.isArray(task.fields) || !task.prompt) {
        throw new Error('invalid task');
      }
      if (!byProviderTask.has(task.providerTaskId)) {
        byProviderTask.set(task.providerTaskId, {
          providerTaskId: task.providerTaskId,
          fields: ['内容热度', '对应产品方向'],
          prompt: task.prompt,
        });
      }
    }
    providerTasks = [...byProviderTask.values()];
  } catch {
    throw new Error('Provider task file must contain a JSON array of valid tasks');
  }
  const input = `You are a batch processor, not a conversational assistant. Execute every task now. Do not ask questions, explain, summarize, or use tools. Return exactly one JSON object for each of the ${providerTasks.length} distinct providerTaskId values in the task list. Each object must have taskId equal to the providerTaskId and exactly these keys: taskId, 内容热度, 对应产品方向. 内容热度 must be one of 低, 中, 高, 待核验. 对应产品方向 must be exactly one of 小户型深泡款, 人造石高端款, 方形独立式, 靠墙式小浴缸, or an empty string. Return only the JSON array, with no markdown or other text.\n\n[CONTENT_HEAT_RULES]\n${CONTENT_HEAT_RULES}\n\n[TASKS]\n${JSON.stringify(providerTasks)}`;
  const spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
  const output = await spawnProcess(definition.command, definition.args, definition.taskFile, input);
  return parseProviderOutput(output);
}
