#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildProviderCommand, parseProviderOutput } from './local-provider-runner.mjs';
import {
  LEGACY_AI_FIELDS,
  buildLegacyProviderInput,
  buildLegacyTasks,
  extractLegacyPrompts,
  aggregateLegacyBatchResults,
  parseLegacyProviderResults,
  splitLegacyTasks,
  shouldStopAfterBatch,
} from './legacy-feishu-prompt-analysis.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const DEFAULT_PROMPT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'keyword-formulas-ai-prompts-20260809.md');

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function parseOptions(argv) {
  const options = {
    provider: 'codex',
    envFile: 'E:/小红书/.env.local',
    promptFile: DEFAULT_PROMPT_FILE,
    outputDir: path.resolve('runtime', 'weekly-local-analysis'),
  };
  const values = new Set(['app-token', 'table-id', 'table-name', 'collection-date', 'batch-number', 'env-file', 'prompt-file', 'output-dir', 'provider', 'expected-rows', 'batch-size', 'stop-after-batch']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') || !values.has(arg.slice(2))) throw new Error(`Unknown or invalid option: ${arg}`);
    const name = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[name] = value;
  }
  for (const key of ['appToken', 'tableId', 'tableName', 'collectionDate', 'batchNumber']) if (!options[key]) throw new Error(`Missing required option: --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  options.expectedRows = Number(options.expectedRows ?? 300);
  options.batchNumber = Number(options.batchNumber);
  options.batchSize = Number(options.batchSize ?? 10);
  options.stopAfterBatch = Number(options.stopAfterBatch ?? 0);
  if (!Number.isInteger(options.expectedRows) || options.expectedRows < 1) throw new Error('--expected-rows must be a positive integer');
  if (!Number.isInteger(options.batchNumber) || options.batchNumber < 1) throw new Error('--batch-number must be a positive integer');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error('--batch-size must be a positive integer');
  if (!Number.isInteger(options.stopAfterBatch) || options.stopAfterBatch < 0) throw new Error('--stop-after-batch must be a non-negative integer');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.collectionDate)) throw new Error('--collection-date must be YYYY-MM-DD');
  if (!['cc', 'codex', 'workbuddy'].includes(options.provider)) throw new Error('--provider must be cc, codex, or workbuddy');
  return options;
}

class FeishuReader {
  constructor({ appId, appSecret, appToken }) { this.appId = appId; this.appSecret = appSecret; this.appToken = appToken; this.token = null; }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error('Feishu authentication failed');
    this.token = payload.tenant_access_token;
  }

  async request(requestPath) {
    const response = await fetch(`${API_ROOT}${requestPath}`, { headers: { Authorization: `Bearer ${this.token}` } });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu read failed: ${requestPath}`);
    return payload.data ?? {};
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async getTable(tableId) {
    const tables = await this.request(`/bitable/v1/apps/${this.appToken}/tables?page_size=100`);
    return (tables.items ?? []).find((item) => item.table_id === tableId);
  }
}

function quoteWindowsArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/u.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function runProvider(provider, taskFile, input) {
  const definition = buildProviderCommand(provider, taskFile);
  const args = provider === 'codex'
    ? [definition.args[0], '--skip-git-repo-check', ...definition.args.slice(1)]
    : definition.args;
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [definition.command, ...args.map(quoteWindowsArg)].join(' ')], { windowsHide: true })
      : spawn(definition.command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(parseProviderOutput(stdout)) : reject(new Error(`Provider failed: ${stderr.trim()}`)));
    child.stdin.end(input);
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readCompletedBatch(file, tasks) {
  if (!fs.existsSync(file)) return null;
  try {
    return parseLegacyProviderResults({ tasks, output: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch {
    return null;
  }
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('、') : String(value ?? '');
  return /[,"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu environment is missing app credentials');
  const reader = new FeishuReader({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await reader.authenticate();
  const [table, records, prompts] = await Promise.all([
    reader.getTable(options.tableId), reader.listRecords(options.tableId), extractLegacyPrompts(options.promptFile),
  ]);
  if (!table || table.name !== options.tableName) throw new Error('Confirmed table identity mismatch');
  if (records.length !== options.expectedRows) throw new Error(`Expected ${options.expectedRows} records; received ${records.length}`);
  const tasks = buildLegacyTasks({ prompts, records });
  const outputDir = path.resolve(options.outputDir, `${options.collectionDate}-batch-${options.batchNumber}-batched`);
  fs.mkdirSync(outputDir, { recursive: true });
  const topLevelTasks = tasks.map((task) => ({ taskId: task.taskId, keywordId: task.keywordId, keyword: task.keyword, inputs: task.inputs }));
  writeJson(path.join(outputDir, 'tasks.json'), topLevelTasks);
  const batches = splitLegacyTasks(tasks, options.batchSize);
  const batchResults = new Map();
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchName = `batch-${String(index + 1).padStart(3, '0')}`;
    const batchDir = path.join(outputDir, batchName);
    fs.mkdirSync(batchDir, { recursive: true });
    const validatedFile = path.join(batchDir, 'validated-results.json');
    const completed = readCompletedBatch(validatedFile, batch);
    if (completed) {
      batchResults.set(batchName, completed);
      console.error(`Reusing ${batchName} (${batch.length} validated results)`);
      if (shouldStopAfterBatch(index + 1, batches.length, options.stopAfterBatch)) {
        writeJson(path.join(outputDir, 'manifest.json'), { status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, recordCount: records.length, processedRecords: Math.min((index + 1) * options.batchSize, records.length), batchSize: options.batchSize, batchCount: batches.length, completedBatches: index + 1, promptDigest: digest(prompts) });
        console.log(JSON.stringify({ status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, completedBatches: index + 1, batchCount: batches.length, outputDir }, null, 2));
        return;
      }
      continue;
    }
    const priorOutputFile = path.join(batchDir, 'provider-output.json');
    if (fs.existsSync(priorOutputFile)) {
      try {
        const recovered = parseLegacyProviderResults({ tasks: batch, output: JSON.parse(fs.readFileSync(priorOutputFile, 'utf8')) });
        writeJson(validatedFile, recovered);
        batchResults.set(batchName, recovered);
        console.error(`Recovered ${batchName} from existing provider output (${batch.length} validated results)`);
        if (shouldStopAfterBatch(index + 1, batches.length, options.stopAfterBatch)) {
          writeJson(path.join(outputDir, 'manifest.json'), { status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, recordCount: records.length, processedRecords: Math.min((index + 1) * options.batchSize, records.length), batchSize: options.batchSize, batchCount: batches.length, completedBatches: index + 1, promptDigest: digest(prompts) });
          console.log(JSON.stringify({ status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, completedBatches: index + 1, batchCount: batches.length, outputDir }, null, 2));
          return;
        }
        continue;
      } catch {
        console.error(`Ignoring invalid prior output for ${batchName}`);
      }
    }
    const envelope = buildLegacyProviderInput({ prompts, tasks: batch });
    const taskFile = path.join(batchDir, 'tasks.json');
    const inputFile = path.join(batchDir, 'provider-input.json');
    writeJson(taskFile, envelope.tasks);
    writeJson(inputFile, envelope);
    const providerInput = `你正在执行一批浴缸关键词结构化分析。只处理 TASKS 中的每条任务，不要提问、解释或调用工具。严格按照 PROMPTS 中的规则，返回一个 JSON 数组；数组必须包含每个 taskId 恰好一次，每个对象只能包含 taskId 和七个输出字段：${LEGACY_AI_FIELDS.join('、')}。字段值必须满足各自提示词的枚举/格式要求。只返回 JSON 数组，不要 Markdown。\n\nPROMPTS:\n${JSON.stringify(envelope.prompts)}\n\nTASKS:\n${JSON.stringify(envelope.tasks)}`;
    console.error(`Running ${batchName} (${batch.length} tasks)`);
    const output = await runProvider(options.provider, taskFile, providerInput);
    writeJson(path.join(batchDir, 'provider-output.json'), output);
    const validated = parseLegacyProviderResults({ tasks: batch, output });
    writeJson(validatedFile, validated);
    batchResults.set(batchName, validated);
    if (shouldStopAfterBatch(index + 1, batches.length, options.stopAfterBatch)) {
      writeJson(path.join(outputDir, 'manifest.json'), { status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, recordCount: records.length, processedRecords: (index + 1) * options.batchSize > records.length ? records.length : (index + 1) * options.batchSize, batchSize: options.batchSize, batchCount: batches.length, completedBatches: index + 1, promptDigest: digest(prompts) });
      console.log(JSON.stringify({ status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_PARTIAL', provider: options.provider, completedBatches: index + 1, batchCount: batches.length, outputDir }, null, 2));
      return;
    }
  }
  const results = aggregateLegacyBatchResults(tasks, batchResults);
  const artifact = {
    status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_READY',
    provider: options.provider,
    promptFile: path.resolve(options.promptFile),
    promptDigest: digest(prompts),
    collectionDate: options.collectionDate,
    batchNumber: options.batchNumber,
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    recordCount: records.length,
    results,
  };
  const artifactFile = path.join(outputDir, 'analysis-artifact.json');
  const csvFile = path.join(outputDir, 'analysis.csv');
  writeJson(artifactFile, artifact);
  const headers = ['关键词编号', '搜索词', ...LEGACY_AI_FIELDS];
  const lines = [headers.join(',')];
  for (const result of results) lines.push([result.keywordId, result.keyword, ...LEGACY_AI_FIELDS.map((field) => result.字段[field])].map(csvCell).join(','));
  fs.writeFileSync(csvFile, `${lines.join('\n')}\n`, 'utf8');
  writeJson(path.join(outputDir, 'manifest.json'), { status: artifact.status, provider: options.provider, recordCount: records.length, batchSize: options.batchSize, batchCount: batches.length, artifactFile, csvFile, promptDigest: artifact.promptDigest });
  console.log(JSON.stringify({ status: artifact.status, provider: options.provider, recordCount: records.length, batchCount: batches.length, artifactFile, csvFile, promptDigest: artifact.promptDigest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
