import fs from 'node:fs/promises';

export const LEGACY_AI_FIELDS = Object.freeze([
  '关键词归类', '标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度', '对应产品方向',
]);

const PROMPT_HEADINGS = [
  ['A', '关键词归类'], ['B', '标准归并词'], ['C', '关键词分类'], ['D', '细分标签'],
  ['E', '用户意图'], ['F', '内容热度'], ['G', '对应产品方向'],
];
const PROMPT_HEADING_RE = /^###\s+([A-G])\.\s+(.+?)\s*$/gmu;
const CATEGORY_VALUES = new Set(['大词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词', '无匹配类别']);
const CLASSIFICATION_VALUES = new Set([
  '核心大词', '安装方式词', '材质词', '形状与风格词', '功能与特点词', '尺寸词',
  '适用人群与场景词', '品牌词', '地域词', '颜色词', '通用词', '无匹配类别',
]);
const INTENT_VALUES = new Set(['了解型', '购买决策型', '对比选择型', '场景需求型', '问题解决型']);
const CONTENT_VALUES = new Set(['AI预测-高', 'AI预测-中', 'AI预测-低']);
const PRODUCT_VALUES = new Set(['小户型深泡款', '人造石高端款', '方形独立式', '靠墙式小浴缸', '']);

function normalizePath(file) {
  const value = String(file);
  return value.startsWith('/') && /^\/[A-Za-z]:/u.test(value) ? value.slice(1) : value;
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => item?.text ?? item?.name ?? item ?? '').join('、');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

export async function extractLegacyPrompts(file) {
  const source = await fs.readFile(normalizePath(file), 'utf8');
  const matches = [...source.matchAll(PROMPT_HEADING_RE)];
  const prompts = {};
  for (let index = 0; index < matches.length; index += 1) {
    const [, letter, heading] = matches[index];
    const expected = PROMPT_HEADINGS.find(([key]) => key === letter);
    if (!expected || !(heading === expected[1] || heading.startsWith(`${expected[1]}（`))) continue;
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? source.length;
    const section = source.slice(start, end);
    const block = section.match(/```text\s*\r?\n([\s\S]*?)\r?\n```/u);
    if (!block?.[1]?.trim()) throw new Error(`Prompt ${expected[1]} has no fenced text block`);
    prompts[expected[1]] = block[1].trim();
  }
  const missing = LEGACY_AI_FIELDS.filter((field) => !prompts[field]);
  if (missing.length) throw new Error(`Missing legacy Feishu prompts: ${missing.join('、')}`);
  return Object.fromEntries(LEGACY_AI_FIELDS.map((field) => [field, prompts[field]]));
}

function replacePlaceholders(prompt, values) {
  return prompt.replace(/<([^>]+)>/gu, (_, name) => {
    const key = String(name).replace(/字段$/u, '');
    return Object.hasOwn(values, key) ? values[key] : '';
  });
}

export function buildLegacyTasks({ prompts, records }) {
  if (!prompts || LEGACY_AI_FIELDS.some((field) => !prompts[field])) throw new Error('All legacy prompts are required');
  if (!Array.isArray(records) || records.length === 0) throw new Error('Records are required');
  return records.map((record, index) => {
    const fields = record.fields ?? {};
    const keyword = plain(fields['原始关键词']) || plain(fields['搜索词']);
    const keywordId = plain(fields['关键词编号']);
    if (!record.record_id || !keyword || !keywordId) throw new Error(`Record ${index + 1} is missing id, keyword, or keyword id`);
    const values = Object.fromEntries([
      '原始关键词', '关键词归类', '标准归并词', '关键词分类', '细分标签', '用户意图', '搜索热度', '交易热度',
    ].map((name) => [name, plain(fields[name])]));
    values['原始关键词'] ||= keyword;
    const prompt = LEGACY_AI_FIELDS.map((field) => `【${field}】\n${replacePlaceholders(prompts[field], values)}`).join('\n\n');
    return {
      taskId: record.record_id,
      recordId: record.record_id,
      keywordId,
      keyword,
      fields: [...LEGACY_AI_FIELDS],
      inputs: values,
      prompt,
    };
  });
}

export function buildLegacyProviderInput({ prompts, tasks }) {
  if (!prompts || LEGACY_AI_FIELDS.some((field) => !prompts[field])) throw new Error('All legacy prompts are required');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Tasks are required');
  return {
    prompts: Object.fromEntries(LEGACY_AI_FIELDS.map((field) => [field, prompts[field]])),
    outputFields: [...LEGACY_AI_FIELDS],
    tasks: tasks.map((task) => ({ taskId: task.taskId, keywordId: task.keywordId, keyword: task.keyword, inputs: task.inputs })),
  };
}

export function splitLegacyTasks(tasks, batchSize = 10) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Tasks are required');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Batch size must be a positive integer');
  const batches = [];
  for (let index = 0; index < tasks.length; index += batchSize) batches.push(tasks.slice(index, index + batchSize));
  return batches;
}

export function aggregateLegacyBatchResults(tasks, batchResults) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Tasks are required');
  if (!(batchResults instanceof Map)) throw new Error('Batch results are required');
  const expected = new Set(tasks.map((task) => task.taskId));
  const seen = new Set();
  const aggregate = [];
  for (const results of batchResults.values()) {
    if (!Array.isArray(results)) throw new Error('Invalid batch results');
    for (const result of results) {
      const taskId = plain(result?.taskId || result?.record_id);
      if (!expected.has(taskId)) throw new Error(`Unknown batch result: ${taskId}`);
      if (seen.has(taskId)) throw new Error(`duplicate batch result: ${taskId}`);
      seen.add(taskId);
      aggregate.push(result);
    }
  }
  if (seen.size !== expected.size) throw new Error('incomplete or missing batch results');
  return tasks.map((task) => aggregate.find((result) => plain(result.taskId || result.record_id) === task.taskId));
}

export function shouldStopAfterBatch(batchNumber, batchCount, limit = 0) {
  if (!Number.isInteger(batchNumber) || !Number.isInteger(batchCount) || batchNumber < 1 || batchCount < 1) throw new Error('Batch numbers must be positive integers');
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Batch limit must be a non-negative integer');
  return limit > 0 && batchNumber === limit && batchNumber < batchCount;
}

function validateLabels(value) {
  const text = plain(value);
  if (!text) return true;
  const labels = text.split(/[、,，;；\n]+/u).map((item) => item.trim()).filter(Boolean);
  return labels.length > 0 && labels.every((label) => !/^浴缸$/u.test(label));
}

function validateResult(task, item) {
  if (!item || plain(item.taskId) !== task.taskId) throw new Error(`Invalid provider result for ${task.taskId}`);
  const fields = Object.fromEntries(LEGACY_AI_FIELDS.map((field) => [field, plain(item[field])]));
  if (!CATEGORY_VALUES.has(fields['关键词归类'])) throw new Error(`Invalid 关键词归类 for ${task.taskId}`);
  if (!fields['标准归并词']) throw new Error(`Invalid 标准归并词 for ${task.taskId}`);
  if (!CLASSIFICATION_VALUES.has(fields['关键词分类'])) throw new Error(`Invalid 关键词分类 for ${task.taskId}`);
  if (!validateLabels(fields['细分标签'])) throw new Error(`Invalid 细分标签 for ${task.taskId}`);
  if (!INTENT_VALUES.has(fields['用户意图'])) throw new Error(`Invalid 用户意图 for ${task.taskId}`);
  if (!CONTENT_VALUES.has(fields['内容热度'])) throw new Error(`Invalid 内容热度 for ${task.taskId}`);
  if (!PRODUCT_VALUES.has(fields['对应产品方向'])) throw new Error(`Invalid 对应产品方向 for ${task.taskId}`);
  return { record_id: task.recordId, keywordId: task.keywordId, keyword: task.keyword, 字段: fields };
}

export function parseLegacyProviderResults({ tasks, output }) {
  if (!Array.isArray(output)) throw new Error('Invalid provider output: expected an array');
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  if (byId.size !== tasks.length || output.length !== tasks.length) throw new Error('Provider result count does not match tasks');
  const seen = new Set();
  const parsed = output.map((item) => {
    const task = byId.get(plain(item?.taskId));
    if (!task || seen.has(task.taskId)) throw new Error(`Duplicate or unknown provider result: ${plain(item?.taskId)}`);
    seen.add(task.taskId);
    return validateResult(task, item);
  });
  if (seen.size !== tasks.length) throw new Error('Provider results are incomplete');
  return parsed;
}
