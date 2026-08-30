import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_REGISTRY,
  buildAnalysisTasks,
  buildLocalAnalysisArtifact,
  buildPublishPlan,
  canonicalDigest,
  parseProviderResults,
  validatePublishPlan,
  validatePublishReadback,
} from './weekly-local-analysis.mjs';

const records = [
  {
    record_id: 'rec1',
    fields: {
      排名: '1', 搜索词: '小户型亚克力浴缸', 搜索人气: '1200 ~ 2500', 点击率: '10%', 支付转化率: '5% ~ 7.5%',
      关键词编号: 'KW000001', 原始关键词: '小户型亚克力浴缸',
    },
  },
  {
    record_id: 'rec2',
    fields: {
      排名: '2', 搜索词: '浴缸漏水维修', 搜索人气: '600 ~ 1200', 点击率: '5%', 支付转化率: '1% ~ 2.5%',
      关键词编号: 'KW000002', 原始关键词: '浴缸漏水维修',
    },
  },
];

const fields = [
  { field_id: 'f1', field_name: '原始关键词', type: 1 },
  { field_id: 'f2', field_name: '标准归并词', type: 1 },
  { field_id: 'f3', field_name: '关键词分类', type: 3 },
  { field_id: 'f4', field_name: '细分标签', type: 4 },
  { field_id: 'f5', field_name: '用户意图', type: 3 },
  { field_id: 'f6', field_name: '搜索热度', type: 1 },
  { field_id: 'f7', field_name: '交易热度', type: 1 },
  { field_id: 'f8', field_name: '内容热度', type: 1 },
  { field_id: 'f9', field_name: '是否重点词', type: 1 },
  { field_id: 'f10', field_name: '优先级', type: 1 },
  { field_id: 'f11', field_name: '对应产品方向', type: 1 },
];

test('registry declares owners and prompts from one source', () => {
  assert.equal(ANALYSIS_REGISTRY.fields.find((field) => field.name === '搜索热度').owner, 'rule');
  assert.equal(ANALYSIS_REGISTRY.fields.find((field) => field.name === '内容热度').owner, 'llm');
  assert.match(ANALYSIS_REGISTRY.prompts.productDirection, /只允许输出以下四个方向之一/u);
});

test('local analysis creates provider tasks without any Feishu mutation', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  assert.equal(tasks.length, records.length * 2);
  assert.ok(tasks.every((task) => task.recordId && task.keywordId && task.providerTaskId && task.promptHash));
  assert.ok(new Set(tasks.map((task) => task.providerTaskId)).size === records.length);
  assert.ok(tasks.every((task) => task.fields.every((field) => ['内容热度', '对应产品方向'].includes(field))));
});

test('provider aggregates use local short task identities and map to real records', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const result = parseProviderResults({
    provider: 'codex',
    tasks,
    output: records.map((record, index) => ({
      taskId: `p${String(index + 1).padStart(4, '0')}`,
      内容热度: '中',
      对应产品方向: '',
    })),
  });
  assert.deepEqual(new Set(result.map((item) => item.recordId)), new Set(records.map((record) => record.record_id)));
  assert.throws(() => parseProviderResults({
    provider: 'codex',
    tasks,
    output: records.map((record, index) => ({
      taskId: `p${String(index + 1).padStart(4, '0')}`,
      内容热度: '中',
      对应产品方向: index === 0 ? '小户型' : '',
    })),
  }), /invalid provider result/i);
});

test('provider results require exact record identity and validated fields', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const result = parseProviderResults({
    provider: 'codex',
    tasks,
    output: tasks.map((task) => ({
      record_id: task.recordId,
      keyword_id: task.keywordId,
      field: task.fields[0],
      value: task.fields[0] === '内容热度' ? '中' : '小户型深泡款',
    })),
  });
  assert.equal(result.length, tasks.length);
  assert.throws(() => parseProviderResults({ provider: 'cc', tasks, output: [] }), /missing provider result/i);
  assert.throws(() => parseProviderResults({
    provider: 'cc', tasks, output: [{ ...result[0], value: 0 }],
  }), /invalid provider result/i);
});

test('provider results normalize Codex record aggregates only for known tasks', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const result = parseProviderResults({
    provider: 'codex',
    tasks,
    output: tasks.filter((task) => task.fields[0] === '内容热度').map((task) => ({
      taskId: task.providerTaskId,
      内容热度: '中',
      对应产品方向: '',
    })),
  });
  assert.equal(result.length, tasks.length);
  assert.ok(result.every((item) => item.keywordId && item.recordId));
  assert.throws(() => parseProviderResults({
    provider: 'codex',
    tasks,
    output: [{ taskId: 'unknown', 内容热度: '中', 对应产品方向: '' }, ...tasks.filter((task) => task.fields[0] === '内容热度').slice(1).map((task) => ({ taskId: task.providerTaskId, 内容热度: '中', 对应产品方向: '' }))],
  }), /invalid provider result/i);
});

test('artifact refuses to finalize without complete local AI evidence', () => {
  assert.throws(() => buildLocalAnalysisArtifact({
    appToken: 'app', currentTable: { tableId: 'tblCurrent', tableName: '周表', recordCount: 2 },
    fields, records, historyRecords: [], providerResults: [], huitunResults: null,
  }), /LLM_EVIDENCE_REQUIRED/);
});

test('artifact rejects a three-table publish plan without frozen history and library snapshots', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const providerResults = parseProviderResults({
    provider: 'workbuddy', tasks,
    output: tasks.map((task) => ({
      record_id: task.recordId, keyword_id: task.keywordId, field: task.fields[0],
      value: task.fields[0] === '内容热度' ? '中' : '小户型深泡款',
    })),
  });
  assert.throws(() => buildLocalAnalysisArtifact({
    appToken: 'app', currentTable: { tableId: 'tblCurrent', tableName: '周表', recordCount: 2 },
    fields, records, historyRecords: [], providerResults, huitunResults: { items: [] },
  }), /history.*library.*snapshot|three-table/i);
});

test('artifact includes history and library plans when snapshots are frozen', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const providerResults = parseProviderResults({
    provider: 'workbuddy', tasks,
    output: tasks.map((task) => ({
      record_id: task.recordId, keyword_id: task.keywordId, field: task.fields[0],
      value: task.fields[0] === '内容热度' ? '中' : '小户型深泡款',
    })),
  });
  const artifact = buildLocalAnalysisArtifact({
    appToken: 'app',
    currentTable: { tableId: 'tblCurrent', tableName: '周表', recordCount: 2 },
    historyTable: { tableId: 'tblHistory', tableName: '历史表', recordCount: 0 },
    libraryTable: { tableId: 'tblLibrary', tableName: '编号库', recordCount: 2 },
    fields, records, historyRecords: [], libraryRecords: [
      { record_id: 'lib1', fields: { 唯一匹配键: '浴缸小户型亚克力浴缸', 一级类目: '浴缸', 原始关键词: '小户型亚克力浴缸', 规范化关键词: '小户型亚克力浴缸', 关键词编号: 'KW000001' } },
      { record_id: 'lib2', fields: { 唯一匹配键: '浴缸浴缸漏水维修', 一级类目: '浴缸', 原始关键词: '浴缸漏水维修', 规范化关键词: '浴缸漏水维修', 关键词编号: 'KW000002' } },
    ], collectionDate: '2026-08-21', batchNumber: 3,
    providerResults, huitunResults: { items: [] },
  });
  assert.equal(artifact.publishPlan.tables.history.tableId, 'tblHistory');
  assert.equal(artifact.publishPlan.tables.library.tableId, 'tblLibrary');
  assert.equal(artifact.publishPlan.tables.history.creates.length, 2);
  assert.equal(artifact.publishPlan.tables.library.creates.length, 0);
});

test('history plan updates incomplete existing records without overwriting settled values', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const providerResults = parseProviderResults({
    provider: 'workbuddy', tasks,
    output: tasks.map((task) => ({
      record_id: task.recordId, keyword_id: task.keywordId, field: task.fields[0],
      value: task.fields[0] === '内容热度' ? '中' : '小户型深泡款',
    })),
  });
  const artifact = buildLocalAnalysisArtifact({
    appToken: 'app',
    currentTable: { tableId: 'tblCurrent', tableName: '周表', recordCount: 2 },
    historyTable: { tableId: 'tblHistory', tableName: '历史表', recordCount: 1 },
    libraryTable: { tableId: 'tblLibrary', tableName: '编号库', recordCount: 2 },
    fields, records, historyRecords: [{ record_id: 'hist1', fields: {
      批次编号: '3', 关键词编号: 'KW000001', 排名: '1', 搜索词: '小户型亚克力浴缸',
      搜索人气: '1200 ~ 2500', 点击率: '10%', 支付转化率: '5% ~ 7.5%',
      一级类目: '浴缸', 原始关键词: '小户型亚克力浴缸',
      搜索热度: '高', 交易热度: '高', 是否重点词: null, 优先级: null,
    } }], libraryRecords: [
      { record_id: 'lib1', fields: { 唯一匹配键: '浴缸小户型亚克力浴缸', 一级类目: '浴缸', 原始关键词: '小户型亚克力浴缸', 关键词编号: 'KW000001' } },
      { record_id: 'lib2', fields: { 唯一匹配键: '浴缸浴缸漏水维修', 一级类目: '浴缸', 原始关键词: '浴缸漏水维修', 关键词编号: 'KW000002' } },
    ], collectionDate: '2026-08-21', batchNumber: 3,
    providerResults, huitunResults: { items: [] },
  });
  assert.equal(artifact.publishPlan.tables.history.creates.length, 1);
  assert.equal(artifact.publishPlan.tables.history.updates.length, 1);
  assert.equal(artifact.publishPlan.tables.history.updates[0].record_id, 'hist1');
  assert.equal(artifact.publishPlan.tables.history.updates[0].fields['是否重点词'], '是');
  assert.equal(artifact.publishPlan.tables.history.updates[0].fields['优先级'], 'A候选');
});

test('artifact stores final values and publish plan without formulas', () => {
  const tasks = buildAnalysisTasks({ records, fields });
  const providerResults = parseProviderResults({
    provider: 'workbuddy', tasks,
    output: tasks.map((task) => ({
      record_id: task.recordId, keyword_id: task.keywordId, field: task.fields[0],
      value: task.fields[0] === '内容热度' ? '中' : '小户型深泡款',
    })),
  });
  const artifact = buildLocalAnalysisArtifact({
    appToken: 'app', currentTable: { tableId: 'tblCurrent', tableName: '周表', recordCount: 2 },
    historyTable: { tableId: 'tblHistory', tableName: '历史表', recordCount: 0 },
    libraryTable: { tableId: 'tblLibrary', tableName: '编号库', recordCount: 2 },
    fields, records, historyRecords: [], libraryRecords: [
      { record_id: 'lib1', fields: { 唯一匹配键: '浴缸小户型亚克力浴缸', 一级类目: '浴缸', 原始关键词: '小户型亚克力浴缸', 关键词编号: 'KW000001' } },
      { record_id: 'lib2', fields: { 唯一匹配键: '浴缸浴缸漏水维修', 一级类目: '浴缸', 原始关键词: '浴缸漏水维修', 关键词编号: 'KW000002' } },
    ], collectionDate: '2026-08-21', batchNumber: 3,
    providerResults, huitunResults: { items: [] },
  });
  assert.equal(artifact.status, 'EXTERNAL_EVIDENCE_REQUIRED');
  assert.equal(artifact.analysisValues.length, 2);
  assert.ok(artifact.analysisValues.every((item) => item.fields['搜索热度']));
  assert.ok(artifact.publishPlan.planDigest);
  assert.ok(artifact.analysisValues.every((item) => !Object.values(item.fields).some((value) => String(value).includes('formula'))));
});

test('publish plan rejects identity or digest drift', () => {
  const plan = buildPublishPlan({
    appToken: 'app', currentTable: { tableId: 'tblCurrent', tableName: '周表' },
    updates: [{ record_id: 'rec1', fields: { 内容热度: '中' } }],
  });
  assert.doesNotThrow(() => validatePublishPlan(plan, {
    appToken: 'app', tableId: 'tblCurrent', records: records.map((record) => ({ record_id: record.record_id, fields: { 内容热度: '中' } })),
  }));
  assert.doesNotThrow(() => validatePublishPlan(plan, {
    appToken: 'app', tableId: 'tblCurrent', records: records.map((record) => ({ record_id: record.record_id, fields: { 内容热度: '低' } })),
  }));
  assert.throws(() => validatePublishReadback(plan, records.map((record) => ({ record_id: record.record_id, fields: { 内容热度: '低' } }))), /publish value mismatch/i);
  assert.throws(() => validatePublishPlan(plan, { appToken: 'wrong', tableId: 'tblCurrent', records: [] }), /publish target mismatch/i);
  assert.throws(() => validatePublishPlan({ ...plan, planDigest: canonicalDigest({}) }, {
    appToken: 'app', tableId: 'tblCurrent', records: records.map((record) => ({ record_id: record.record_id })),
  }), /plan digest mismatch/i);
});
