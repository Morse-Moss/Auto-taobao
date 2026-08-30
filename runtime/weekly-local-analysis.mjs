#!/usr/bin/env node

import crypto from 'node:crypto';

import { analyzeKeyword } from './local-keyword-analysis.mjs';
import { classifySearchHeat, classifyTradeHeat } from './keyword-dual-table-core.mjs';

const PROVIDERS = new Set(['cc', 'codex', 'workbuddy']);
const PROVIDER_FIELDS = new Set(['内容热度', '对应产品方向']);
const PRODUCT_DIRECTIONS = new Set(['小户型深泡款', '人造石高端款', '方形独立式', '靠墙式小浴缸', '']);
const ALL_ANALYSIS_FIELDS = new Set([
  '标准归并词', '关键词分类', '细分标签', '用户意图', '搜索热度', '交易热度',
  '内容热度', '是否重点词', '优先级', '对应产品方向',
]);

const CONTENT_HEAT_PROMPT = `你是浴缸内容选题价值评估器。\n内容热度是内容创作潜力预测，不是真实内容平台热度。\n判定：明确问题、对比、选购、场景或可解释属性，且搜索热度或交易热度为高时输出高；有清晰属性或场景但信号一般时输出中；纯品牌、店铺、导航、过度宽泛、信息不足，或搜索与交易信号都弱且无内容切入点时输出低；无法根据输入确认时输出待核验。\n不得补造平台数据，也不得因品牌知名自动输出高。只输出：低、中、高、待核验。`;
const PRODUCT_DIRECTION_PROMPT = `你是浴缸品类产品规划分析器。\n输入：原始关键词、标准归并词、关键词分类、细分标签。\n只允许输出以下四个方向之一或空字符串：小户型深泡款、人造石高端款、方形独立式、靠墙式小浴缸。\n无法可靠匹配时必须留空，不得输出其他属性词或自造方向。\n不得根据常识补充关键词中不存在的属性。品牌、店铺、地域、颜色不进入产品方向。服务型问题留空。`;

export const ANALYSIS_REGISTRY = Object.freeze({
  version: '2026-08-27.1',
  fields: Object.freeze([
    { name: '标准归并词', owner: 'rule', input: ['原始关键词', '搜索词'], output: 'text', missing: 'REVIEW_REQUIRED' },
    { name: '关键词分类', owner: 'rule', input: ['原始关键词', '搜索词'], output: 'enum', missing: 'REVIEW_REQUIRED' },
    { name: '细分标签', owner: 'rule', input: ['原始关键词', '搜索词'], output: 'list', missing: 'REVIEW_REQUIRED' },
    { name: '用户意图', owner: 'rule', input: ['原始关键词', '搜索词'], output: 'enum', missing: 'REVIEW_REQUIRED' },
    { name: '搜索热度', owner: 'rule', input: ['搜索人气'], output: 'enum', missing: '待核验' },
    { name: '交易热度', owner: 'rule', input: ['支付转化率'], output: 'enum', missing: '待核验' },
    { name: '内容热度', owner: 'llm', input: ['原始关键词', '搜索热度', '交易热度'], output: 'enum', missing: 'LLM_EVIDENCE_REQUIRED' },
    { name: '是否重点词', owner: 'rule', input: ['关键词分类', '搜索热度', '交易热度', '近2周重点达标次数'], output: 'enum', missing: '待数据' },
    { name: '优先级', owner: 'rule', input: ['关键词分类', '细分标签', '搜索热度', '交易热度', '内容热度', '灰豚话题浏览量'], output: 'enum', missing: '待数据' },
    { name: '对应产品方向', owner: 'llm', input: ['原始关键词', '标准归并词', '关键词分类', '细分标签'], output: 'text', missing: 'LLM_EVIDENCE_REQUIRED' },
  ]),
  prompts: Object.freeze({ contentHeat: CONTENT_HEAT_PROMPT, productDirection: PRODUCT_DIRECTION_PROMPT }),
});

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => item?.text ?? item?.name ?? item ?? '').join('');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function sourceKeyword(record) {
  const keyword = plain(record.fields?.['原始关键词']) || plain(record.fields?.['搜索词']);
  if (!keyword) throw new Error(`Record ${record.record_id} has no source keyword`);
  return keyword;
}

function taskKey(task) {
  return `${task.recordId}${task.keywordId}${task.fields.join(',')}`;
}

function promptFor(record, fields) {
  const values = Object.fromEntries(['原始关键词', '标准归并词', '关键词分类', '细分标签', '搜索热度', '交易热度']
    .map((name) => [name, plain(record.fields?.[name])]));
  return `${CONTENT_HEAT_PROMPT}\n${PRODUCT_DIRECTION_PROMPT}\n${JSON.stringify(values)}\n输出字段：${fields.join('、')}`;
}

export function buildAnalysisTasks({ records, fields }) {
  const fieldNames = new Set(fields.map((field) => field.field_name ?? field.name));
  if (!fieldNames.has('原始关键词') && !fieldNames.has('搜索词')) {
    throw new Error('Missing required analysis source field: 原始关键词 or 搜索词');
  }
  const tasks = [];
  records.forEach((record, index) => {
    const keywordId = plain(record.fields?.['关键词编号']);
    if (!keywordId) throw new Error(`Record ${record.record_id} has no keyword id`);
    const providerTaskId = `p${String(index + 1).padStart(4, '0')}`;
    const prompt = promptFor(record, ['内容热度', '对应产品方向']);
    for (const field of ['内容热度', '对应产品方向']) {
      tasks.push({
        taskId: `${record.record_id}:${field}`,
        providerTaskId,
        recordId: record.record_id,
        keywordId,
        fields: [field],
        prompt,
        promptHash: canonicalDigest(prompt),
      });
    }
  });
  return tasks;
}

function validContentHeat(value) {
  return ['低', '中', '高', '待核验'].includes(value);
}

function validProviderValue(field, value) {
  if (field === '内容热度') return validContentHeat(value);
  return typeof value === 'string' && PRODUCT_DIRECTIONS.has(value);
}

export function parseProviderResults({ provider, tasks, output }) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported provider: ${provider}`);
  if (!Array.isArray(output)) throw new Error('Invalid provider result: output must be an array');
  const expected = new Map(tasks.map((task) => [taskKey(task), task]));
  const expectedByProviderTask = new Map();
  for (const task of tasks) {
    const recordTasks = expectedByProviderTask.get(task.providerTaskId) ?? new Map();
    recordTasks.set(task.fields[0], task);
    expectedByProviderTask.set(task.providerTaskId, recordTasks);
  }
  const isAggregate = output.some((item) => item && item.taskId && !item.field && !item.record_id);
  if (isAggregate && output.some((item) => !item || !item.taskId || item.field || item.record_id)) {
    throw new Error('Invalid provider result: mixed output formats');
  }
  if (isAggregate) {
    const seenRecords = new Set();
    const parsed = [];
    for (const item of output) {
      const providerTaskId = plain(item.taskId);
      const recordTasks = expectedByProviderTask.get(providerTaskId);
      if (!recordTasks || seenRecords.has(providerTaskId)) throw new Error(`Invalid provider result for ${providerTaskId}`);
      seenRecords.add(providerTaskId);
      for (const [field, task] of recordTasks) {
        const value = item[field];
        if (!validProviderValue(field, value)) throw new Error(`Invalid provider result for ${providerTaskId}:${field}`);
        parsed.push({
          provider, taskId: task.taskId, providerTaskId, recordId: task.recordId, keywordId: task.keywordId,
          field, value, promptHash: task.promptHash,
          outputHash: canonicalDigest(item), validation: 'VALIDATED',
        });
      }
    }
    if (seenRecords.size !== expectedByProviderTask.size) throw new Error(`Missing provider result: expected ${expectedByProviderTask.size}, received ${seenRecords.size}`);
    return parsed;
  }
  const seen = new Set();
  const parsed = output.map((item) => {
    const field = plain(item.field);
    const key = `${plain(item.record_id)}${plain(item.keyword_id)}${field}`;
    const task = expected.get(key);
    if (!task || seen.has(key) || !validProviderValue(field, item.value)) {
      throw new Error(`Invalid provider result for ${key}`);
    }
    if (item.prompt_hash && item.prompt_hash !== task.promptHash) throw new Error(`Invalid provider result prompt hash for ${key}`);
    seen.add(key);
    return {
      provider, taskId: task.taskId, recordId: task.recordId, keywordId: task.keywordId,
      field, value: item.value, promptHash: task.promptHash,
      outputHash: canonicalDigest(item), validation: 'VALIDATED',
    };
  });
  if (seen.size !== expected.size) throw new Error(`Missing provider result: expected ${expected.size}, received ${seen.size}`);
  return parsed;
}

function calculateRuleValues(record, historyRecords) {
  const fields = record.fields ?? {};
  const keyword = sourceKeyword(record);
  const analysis = analyzeKeyword(keyword);
  const searchHeat = classifySearchHeat(plain(fields['搜索人气']));
  const tradeHeat = classifyTradeHeat(plain(fields['支付转化率']));
  const prior = historyRecords.filter((item) => plain(item.fields?.['关键词编号']) === plain(fields['关键词编号']));
  const priorTargets = prior.filter((item) => ['高'].includes(plain(item.fields?.['搜索热度'])) && ['中', '高'].includes(plain(item.fields?.['交易热度']))).length;
  const currentTarget = analysis['关键词分类'] === '品牌词' ? 0 : (searchHeat === '高' && ['中', '高'].includes(tradeHeat) ? 1 : 0);
  const focus = searchHeat === '高' && ['中', '高'].includes(tradeHeat) && priorTargets + currentTarget >= 2 ? '是' : '否';
  return {
    ...analysis,
    搜索热度: searchHeat,
    交易热度: tradeHeat,
    是否重点词: focus,
    优先级: '待数据',
    __targetCount: priorTargets + currentTarget,
  };
}

function applyPriority(values, huitunByKeyword) {
  const views = huitunByKeyword.get(values.__keywordId);
  const contentReady = ['中', '高'].includes(values['内容热度']);
  const searchReady = ['中', '高'].includes(values['搜索热度']);
  const tradeReady = ['中', '高'].includes(values['交易热度']);
  if (!values['关键词分类'] || !searchReady || !tradeReady || !contentReady) return '待数据';
  if (values['关键词分类'] === '品牌词') return 'C-常规跟踪';
  if (views != null && views >= 10000000 && values['交易热度'] === '高') return 'A-立即跟进';
  if (searchReady && contentReady && values['交易热度'] === '高' && views == null) return 'A候选';
  if (searchReady && tradeReady) return 'B-持续观察';
  return 'C-常规跟踪';
}

function normalizeHuitunResults(results) {
  const map = new Map();
  for (const item of results?.items ?? []) {
    const keywordId = plain(item.keywordId ?? item.keyword_id ?? item.关键词编号);
    const views = item.views ?? item.viewCount ?? item.浏览量 ?? item.rawViews;
    if (keywordId && Number.isFinite(Number(views))) map.set(keywordId, Number(views));
  }
  return map;
}

function hasCompleteHuitunEvidence(results, analysisValues) {
  const items = results?.items;
  if (!results || !Array.isArray(items)) return false;
  const aCandidates = analysisValues.filter((item) => item.fields['优先级'] === 'A候选');
  if (aCandidates.length === 0) return true;
  const byKeyword = normalizeHuitunResults(results);
  return aCandidates.every((item) => byKeyword.has(item.keywordId));
}

function requireThreeTableSnapshot({ historyTable, libraryTable, libraryRecords, collectionDate, batchNumber }) {
  if (!historyTable?.tableId || !libraryTable?.tableId || !Array.isArray(libraryRecords)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(String(collectionDate || ''))
      || !Number.isInteger(Number(batchNumber)) || Number(batchNumber) < 1) {
    throw new Error('Three-table publish plan requires frozen history and library snapshots');
  }
}

function identityFor(category, keyword) {
  const normalizedCategory = plain(category).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const normalizedKeyword = plain(keyword).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalizedCategory || !normalizedKeyword) throw new Error('Keyword identity requires a category and keyword');
  return `${normalizedCategory}${normalizedKeyword}`;
}

function buildLibraryPlan(records, libraryRecords, category) {
  const existing = new Map();
  for (const record of libraryRecords) {
    const fields = record.fields ?? {};
    const identity = plain(fields.唯一匹配键) || identityFor(fields.一级类目, fields.原始关键词);
    if (existing.has(identity)) throw new Error(`Duplicate library identity: ${identity}`);
    existing.set(identity, record);
  }
  const seen = new Set();
  const creates = [];
  const numberByIdentity = new Map();
  for (const record of records) {
    const keyword = plain(record.fields?.['原始关键词']) || plain(record.fields?.['搜索词']);
    const identity = identityFor(category, keyword);
    if (seen.has(identity)) throw new Error(`Duplicate source keyword identity: ${identity}`);
    seen.add(identity);
    const existingRecord = existing.get(identity);
    if (existingRecord) {
      const number = plain(existingRecord.fields?.关键词编号);
      if (!/^KW\d{6}$/u.test(number)) throw new Error(`Keyword number has not settled for ${identity}`);
      numberByIdentity.set(identity, number);
      continue;
    }
    creates.push({
      fields: {
        唯一匹配键: identity,
        一级类目: category,
        原始关键词: keyword,
        规范化关键词: keyword.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(),
      },
    });
  }
  return { creates, numberByIdentity };
}

function historySnapshotFields(record, values, keywordNumber, category, collectionDate, batchNumber) {
  const source = record.fields ?? {};
  return {
    排名: plain(source.排名),
    搜索词: plain(source.搜索词) || plain(source.原始关键词),
    搜索人气: plain(source.搜索人气),
    点击率: plain(source.点击率),
    支付转化率: plain(source.支付转化率),
    关键词编号: keywordNumber,
    采集日期: Date.parse(`${collectionDate}T00:00:00+08:00`),
    批次编号: batchNumber,
    批次有效性: '有效',
    一级类目: category,
    主关键词: category,
    原始关键词: plain(source.原始关键词) || plain(source.搜索词),
    来源渠道: '淘宝',
    搜索热度: values['搜索热度'],
    交易热度: values['交易热度'],
    是否重点词: values['是否重点词'],
    优先级: values['优先级'],
  };
}

function buildHistoryPlan({ records, analysisValues, historyRecords, libraryPlan, category, collectionDate, batchNumber }) {
  const existing = new Map();
  for (const record of historyRecords) {
    const fields = record.fields ?? {};
    const key = `${plain(fields.批次编号)}${plain(fields.关键词编号)}`;
    if (existing.has(key)) throw new Error(`Duplicate history identity: ${key}`);
    existing.set(key, record);
  }
  const creates = [];
  const updates = [];
  for (const record of records) {
    const keyword = plain(record.fields?.['原始关键词']) || plain(record.fields?.['搜索词']);
    const identity = identityFor(category, keyword);
    const keywordNumber = libraryPlan.numberByIdentity.get(identity);
    if (!keywordNumber) throw new Error('Library snapshot is missing a settled keyword number');
    const values = analysisValues.find((item) => item.record_id === record.record_id)?.fields;
    const fields = historySnapshotFields(record, values, keywordNumber, category, collectionDate, batchNumber);
    const key = `${batchNumber}${keywordNumber}`;
    const prior = existing.get(key);
    if (!prior) {
      creates.push({ fields });
      continue;
    }
    const missing = {};
    for (const [name, value] of Object.entries(fields)) {
      const priorValue = plain(prior.fields?.[name]);
      if (!priorValue) {
        missing[name] = value;
      } else if (priorValue !== plain(value)) {
        throw new Error(`Existing history record conflicts for ${keywordNumber}:${name}`);
      }
    }
    if (Object.keys(missing).length > 0) updates.push({ record_id: prior.record_id, fields: missing });
  }
  return { creates, updates };
}

export function buildPublishPlan({ appToken, currentTable, updates }) {
  if (!appToken || !currentTable?.tableId) throw new Error('Publish target is required');
  const normalized = updates.map((update) => ({ record_id: update.record_id, fields: update.fields }));
  if (normalized.some((update) => !update.record_id || !update.fields || Object.keys(update.fields).some((name) => !ALL_ANALYSIS_FIELDS.has(name)))) {
    throw new Error('Publish plan contains unauthorized fields');
  }
  const plan = { appToken, tableId: currentTable.tableId, tableName: currentTable.tableName, updates: normalized };
  return { ...plan, planDigest: canonicalDigest(plan) };
}

export function validatePublishPlan(plan, current) {
  if (!plan || plan.appToken !== current.appToken || plan.tableId !== current.tableId) throw new Error('Publish target mismatch');
  const expectedDigest = canonicalDigest({ appToken: plan.appToken, tableId: plan.tableId, tableName: plan.tableName, updates: plan.updates });
  if (plan.planDigest !== expectedDigest) throw new Error('Plan digest mismatch');
  const currentIds = new Set(current.records.map((record) => record.record_id));
  if (plan.updates.some((update) => !currentIds.has(update.record_id))) throw new Error('Publish record mismatch');
  return true;
}

export function validatePublishReadback(plan, records) {
  const currentById = new Map(records.map((record) => [record.record_id, record]));
  for (const update of plan.updates) {
    const record = currentById.get(update.record_id);
    if (!record) throw new Error('Publish record mismatch');
    for (const [name, value] of Object.entries(update.fields)) {
      if (JSON.stringify(record.fields?.[name]) !== JSON.stringify(value)) {
        throw new Error(`Publish value mismatch for ${update.record_id}:${name}`);
      }
    }
  }
  return true;
}

export function buildLocalAnalysisArtifact({ appToken, currentTable, historyTable, libraryTable, fields, records, historyRecords = [], libraryRecords, collectionDate, batchNumber, providerResults, huitunResults, sourceEvidence = {} }) {
  const tasks = buildAnalysisTasks({ records, fields });
  if (!Array.isArray(providerResults) || providerResults.length !== tasks.length) throw new Error('LLM_EVIDENCE_REQUIRED');
  const byTask = new Map(providerResults.map((result) => [result.taskId, result]));
  if (tasks.some((task) => !byTask.has(task.taskId))) throw new Error('LLM_EVIDENCE_REQUIRED');
  requireThreeTableSnapshot({ historyTable, libraryTable, libraryRecords, collectionDate, batchNumber });
  const huitunByKeyword = normalizeHuitunResults(huitunResults);
  const analysisValues = records.map((record) => {
    const values = calculateRuleValues(record, historyRecords);
    const keywordId = plain(record.fields?.['关键词编号']);
    values.__keywordId = keywordId;
    for (const task of tasks.filter((item) => item.recordId === record.record_id)) values[task.fields[0]] = byTask.get(task.taskId).value;
    values['优先级'] = applyPriority(values, huitunByKeyword);
    delete values.__targetCount;
    delete values.__keywordId;
    return { record_id: record.record_id, keywordId, fields: values };
  });
  const updates = analysisValues.map((item) => ({ record_id: item.record_id, fields: item.fields }));
  const libraryPlan = buildLibraryPlan(records, libraryRecords, '浴缸');
  if (libraryPlan.creates.length > 0) throw new Error('KEYWORD_LIBRARY_EVIDENCE_REQUIRED');
  const historyPlan = buildHistoryPlan({ records, analysisValues, historyRecords, libraryPlan, category: '浴缸', collectionDate, batchNumber });
  const currentPlan = buildPublishPlan({ appToken, currentTable, updates });
  const evidence = {
    source: sourceEvidence,
    providerDigest: canonicalDigest(providerResults),
    huitunDigest: canonicalDigest(huitunResults ?? null),
    promptDigest: canonicalDigest(ANALYSIS_REGISTRY.prompts),
    historySnapshotDigest: canonicalDigest(historyRecords),
    librarySnapshotDigest: canonicalDigest(libraryRecords),
  };
  const status = hasCompleteHuitunEvidence(huitunResults, analysisValues)
    ? 'PUBLISH_READY'
    : 'EXTERNAL_EVIDENCE_REQUIRED';
  const publishPlan = {
    appToken,
    tables: {
      current: currentPlan,
      history: { tableId: historyTable.tableId, tableName: historyTable.tableName, creates: historyPlan.creates, updates: historyPlan.updates },
      library: { tableId: libraryTable.tableId, tableName: libraryTable.tableName, creates: libraryPlan.creates },
    },
  };
  const frozenPublishPlan = { ...publishPlan, planDigest: canonicalDigest(publishPlan) };
  return {
    status,
    registryVersion: ANALYSIS_REGISTRY.version,
    registryDigest: canonicalDigest(ANALYSIS_REGISTRY),
    target: { appToken, tableId: currentTable.tableId, tableName: currentTable.tableName },
    evidence,
    analysisValues,
    providerResults,
    huitunResults,
    publishPlan: frozenPublishPlan,
    artifactDigest: canonicalDigest({ status, evidence, analysisValues, publishPlan: frozenPublishPlan }),
  };
}
