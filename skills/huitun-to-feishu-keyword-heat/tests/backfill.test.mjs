import assert from 'node:assert/strict';
import test from 'node:test';

let flow = {};
try {
  flow = await import('../scripts/flow.mjs');
} catch {
  // RED phase: the production module does not exist yet.
}

const missing = (name) => () => assert.fail(`missing export: ${name}`);
const buildUpdatePlan = flow.buildUpdatePlan ?? missing('buildUpdatePlan');
const assertAuthorizedMutation = flow.assertAuthorizedMutation ?? missing('assertAuthorizedMutation');
const verifyBackfill = flow.verifyBackfill ?? missing('verifyBackfill');
const selectCandidates = flow.selectCandidates ?? missing('selectCandidates');
const buildQueueBinding = flow.buildQueueBinding ?? missing('buildQueueBinding');

const NOW = Date.parse('2026-08-14T08:00:00.000Z');
const TARGET = { appToken: 'app', tableId: 'table', tableName: '关键词分析 V1（修正版）' };

const resultItems = [
    { keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#家用浴缸#', viewsRaw: '109.4w', views: 1_094_000 },
    { keyword: '新型泡澡浴缸', status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: '没有找到话题~~点击这里', views: 0 },
];

function record(id, search, priority = 'A候选', extra = {}) {
  return {
    record_id: id,
    fields: {
      搜索词: search,
      优先级: priority,
      关键词分类: '大词',
      搜索热度: '高',
      交易热度: '高',
      内容热度: '中',
      ...extra,
    },
  };
}

function context(records) {
  return {
    binding: buildQueueBinding({ ...TARGET, records }),
    maxAgeMs: 24 * 60 * 60 * 1_000,
    nowMs: NOW,
  };
}

function resultDocument(records, overrides = {}) {
  return {
    schemaVersion: 1,
    source: {
      platform: '灰豚数据红薯版',
      page: '话题搜索',
      url: 'https://xhs.huitun.com/#/anchor/anchor_topic',
      collected_at: '2026-08-14T07:59:00.000Z',
      match_rule: '去除话题首尾#后与搜索词完全一致；不累加相近话题',
    },
    target: context(records).binding,
    items: resultItems,
    ...overrides,
  };
}

function planFor(records, document = resultDocument(records)) {
  return buildUpdatePlan({ records, resultDocument: document, resultContext: context(records) });
}

test('requires every A candidate to have a unique non-empty keyword', () => {
  const records = [record('r1', '家用浴缸'), record('r2', '浴缸', 'B-持续观察')];
  assert.deepEqual(selectCandidates(records).map((item) => item.fields.搜索词), ['家用浴缸']);
  assert.throws(() => selectCandidates([...records, record('r3', '')]), /empty A-candidate keyword/i);
  assert.throws(() => selectCandidates([record('r1', '家用浴缸'), record('r2', '家用浴缸')]), /duplicate/i);
});

test('requires the result set to equal the complete live A-candidate queue', () => {
  const records = [record('r1', '家用浴缸'), record('r2', '新型泡澡浴缸'), record('r3', '浴缸', 'B-持续观察')];
  const plan = planFor(records);
  assert.deepEqual(plan.updates, [
    { record_id: 'r1', fields: { 灰豚话题浏览量: 1_094_000 } },
    { record_id: 'r2', fields: { 灰豚话题浏览量: 0 } },
  ]);
  const changed = [...records, record('r4', '新增候选')];
  assert.throws(() => buildUpdatePlan({ records: changed, resultDocument: resultDocument(records), resultContext: context(changed) }), /binding|queue differs/i);
});

test('rejects reused results with missing, wrong, or stale Huitun provenance', () => {
  const records = [record('r1', '家用浴缸'), record('r2', '新型泡澡浴缸')];
  assert.throws(() => buildUpdatePlan({ records, resultDocument: { items: resultItems }, resultContext: context(records) }), /schema|source|provenance/i);
  assert.throws(() => planFor(records, resultDocument(records, {
    source: { ...resultDocument(records).source, platform: '抖音版' },
  })), /source|platform/i);
  assert.throws(() => planFor(records, resultDocument(records, {
    source: { ...resultDocument(records).source, collected_at: '2000-01-01T00:00:00.000Z' },
  })), /expired|stale/i);
  assert.throws(() => planFor(records, resultDocument(records, {
    target: { ...context(records).binding, queueFingerprint: 'wrong' },
  })), /binding/i);
});

test('refuses to overwrite a non-empty Huitun field', () => {
  const records = [
    record('r1', '家用浴缸', 'A候选', { 灰豚话题浏览量: 123 }),
    record('r2', '新型泡澡浴缸'),
  ];
  assert.throws(() => planFor(records), /refusing to overwrite/i);
});

test('allows only the exact topic-view batch update against the confirmed target', () => {
  const records = [record('r1', '家用浴缸'), record('r2', '新型泡澡浴缸')];
  const plan = planFor(records);
  const apiPath = '/bitable/v1/apps/app/tables/table/records/batch_update';
  assert.doesNotThrow(() => assertAuthorizedMutation({
    appToken: 'app', tableId: 'table', method: 'POST', apiPath, body: { records: plan.updates }, plan,
  }));
  assert.throws(() => assertAuthorizedMutation({
    appToken: 'app', tableId: 'table', method: 'POST', apiPath,
    body: { records: [{ record_id: 'r1', fields: { 优先级: 'A-立即跟进' } }] }, plan,
  }), /unauthorized/i);
});

test('verification permits formula settlement but rejects every unrelated change', () => {
  const before = [record('r1', '家用浴缸'), record('r2', '新型泡澡浴缸')];
  const plan = planFor(before);
  const after = [
    record('r1', '家用浴缸', 'B-持续观察', { 灰豚话题浏览量: 1_094_000 }),
    record('r2', '新型泡澡浴缸', 'B-持续观察', { 灰豚话题浏览量: 0 }),
  ];
  assert.equal(verifyBackfill({ before, after, plan }).recordsWritten, 2);
  const corrupted = structuredClone(after);
  corrupted[0].fields.原始关键词 = '被改动';
  assert.throws(() => verifyBackfill({ before, after: corrupted, plan }), /unauthorized/i);
  const formulaCorrupted = structuredClone(after);
  formulaCorrupted[0].fields.是否重点词 = '是';
  assert.throws(() => verifyBackfill({ before, after: formulaCorrupted, plan }), /unauthorized/i);
});

test('B fallback keeps medium-trade keywords at B even when Huitun views exceed 1000w', () => {
  const records = [record('r1', '浴缸', 'B-持续观察', {
    搜索热度: '高',
    交易热度: '中',
    内容热度: '高',
    灰豚话题浏览量: 700_000_000,
  })];
  const binding = buildQueueBinding({ ...TARGET, records, candidateMode: 'B_FALLBACK' });
  const document = {
    schemaVersion: 1,
    source: {
      platform: '灰豚数据红薯版',
      page: '话题搜索',
      url: 'https://xhs.huitun.com/#/anchor/anchor_topic',
      collected_at: '2026-08-14T07:59:00.000Z',
      match_rule: '去除话题首尾#后与搜索词完全一致；不累加相近话题',
    },
    target: binding,
    items: [{ keyword: '浴缸', status: 'FOUND_EXACT', topic: '#浴缸#', viewsRaw: '7.0亿', views: 700_000_000 }],
  };
  const plan = buildUpdatePlan({
    records,
    resultDocument: document,
    candidateMode: 'B_FALLBACK',
    resultContext: { binding, maxAgeMs: 24 * 60 * 60 * 1_000, nowMs: NOW },
  });
  assert.equal(plan.expected[0].expectedPriority, 'B-持续观察');
  assert.deepEqual(plan.updates, []);
});

test('Huitun only writes topic views and preserves the upstream content heat', () => {
  const records = [record('r1', '家用浴缸', 'A候选', {
    搜索热度: '高',
    交易热度: '高',
    内容热度: '中',
  })];
  const document = {
    schemaVersion: 1,
    source: {
      platform: '灰豚数据红薯版',
      page: '话题搜索',
      url: 'https://xhs.huitun.com/#/anchor/anchor_topic',
      collected_at: '2026-08-14T07:59:00.000Z',
      match_rule: '去除话题首尾#后与搜索词完全一致；不累加相近话题',
    },
    target: buildQueueBinding({ ...TARGET, records }),
    // An old result file may contain this derived value; it must be ignored.
    items: [{ keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#家用浴缸#', viewsRaw: '1.2亿', views: 120_000_000, contentHeat: '高' }],
  };
  const plan = buildUpdatePlan({ records, resultDocument: document, resultContext: context(records) });
  assert.deepEqual(plan.updates, [{ record_id: 'r1', fields: { 灰豚话题浏览量: 120_000_000 } }]);
  assert.equal(plan.expected[0].desired.内容热度, undefined);

  const apiPath = '/bitable/v1/apps/app/tables/table/records/batch_update';
  assert.doesNotThrow(() => assertAuthorizedMutation({
    appToken: 'app', tableId: 'table', method: 'POST', apiPath,
    body: { records: plan.updates }, plan,
  }));
  assert.throws(() => assertAuthorizedMutation({
    appToken: 'app', tableId: 'table', method: 'POST', apiPath,
    body: { records: [{ record_id: 'r1', fields: { 内容热度: '高' } }] }, plan,
  }), /unauthorized/i);

  const after = [record('r1', '家用浴缸', 'A-立即跟进', {
    搜索热度: '高',
    交易热度: '高',
    内容热度: '中',
    灰豚话题浏览量: 120_000_000,
  })];
  assert.deepEqual(verifyBackfill({ before: records, after, plan }).verified, [{
    keyword: '家用浴缸',
    contentHeat: '中',
    views: 120_000_000,
    priority: 'A-立即跟进',
  }]);
});
