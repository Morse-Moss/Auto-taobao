import assert from 'node:assert/strict';
import test from 'node:test';

import {
  A_THRESHOLD,
  APP_TOKEN,
  TABLE_ID,
  assertHuitunMutation,
  buildHuitunUpdatePlan,
  contentHeatForViews,
  normalizeResults,
  parseDisplayedViews,
  verifyHuitunBackfill,
} from './apply-huitun-results.mjs';

function record(id, search, priority = 'A候选', extra = {}) {
  return { record_id: id, fields: { 搜索词: search, 优先级: priority, ...extra } };
}

const resultDocument = {
  items: [
    { keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#家用浴缸#', viewsRaw: '109.4w', views: 1_094_000 },
    { keyword: '新型泡澡浴缸', status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: '没有找到话题~~点击这里', views: 0 },
  ],
};

test('parses Huitun display units without losing the displayed value', () => {
  assert.equal(parseDisplayedViews('109.4w'), 1_094_000);
  assert.equal(parseDisplayedViews('1,314'), 1_314);
  assert.equal(parseDisplayedViews('1.2亿'), 120_000_000);
  assert.throws(() => parseDisplayedViews('--'), /unsupported/i);
});

test('uses only the confirmed 1000w boundary for content heat', () => {
  assert.equal(contentHeatForViews(A_THRESHOLD - 1), '低');
  assert.equal(contentHeatForViews(A_THRESHOLD), '高');
});

test('normalizes exact and no-result Huitun evidence', () => {
  assert.deepEqual(normalizeResults(resultDocument).map((item) => ({ keyword: item.keyword, heat: item.contentHeat })), [
    { keyword: '家用浴缸', heat: '低' },
    { keyword: '新型泡澡浴缸', heat: '低' },
  ]);
  assert.throws(() => normalizeResults({ items: [
    { keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#成人家用浴缸#', viewsRaw: '9.5w', views: 95_000 },
  ] }), /not an exact match/i);
});

test('builds updates only for the complete live A candidate queue', () => {
  const records = [record('rec1', '家用浴缸'), record('rec2', '新型泡澡浴缸'), record('rec3', '浴缸', 'B-持续观察')];
  const plan = buildHuitunUpdatePlan({ records, resultDocument });
  assert.deepEqual(plan.updates, [
    { record_id: 'rec1', fields: { '内容热度（后续）': '低', 灰豚话题浏览量: 1_094_000 } },
    { record_id: 'rec2', fields: { '内容热度（后续）': '低', 灰豚话题浏览量: 0 } },
  ]);
  assert.throws(() => buildHuitunUpdatePlan({
    records: [...records, record('rec4', '新增候选')],
    resultDocument,
  }), /queue differs/i);
});

test('mutation guard accepts only the exact two-field plan', () => {
  const plan = buildHuitunUpdatePlan({
    records: [record('rec1', '家用浴缸'), record('rec2', '新型泡澡浴缸')],
    resultDocument,
  });
  const apiPath = `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`;
  assert.doesNotThrow(() => assertHuitunMutation({ method: 'POST', apiPath, body: { records: plan.updates }, plan }));
  assert.throws(() => assertHuitunMutation({
    method: 'POST',
    apiPath,
    body: { records: [{ record_id: 'rec1', fields: { 优先级: 'A-立即跟进' } }] },
    plan,
  }), /unauthorized/i);
});

test('verification allows formula settlement but rejects unrelated changes', () => {
  const before = [record('rec1', '家用浴缸'), record('rec2', '新型泡澡浴缸')];
  const plan = buildHuitunUpdatePlan({ records: before, resultDocument });
  const after = [
    record('rec1', '家用浴缸', 'B-持续观察', { '内容热度（后续）': '低', 灰豚话题浏览量: 1_094_000 }),
    record('rec2', '新型泡澡浴缸', 'B-持续观察', { '内容热度（后续）': '低', 灰豚话题浏览量: 0 }),
  ];
  assert.equal(verifyHuitunBackfill({ before, after, plan }).recordsWritten, 2);
  const changed = structuredClone(after);
  changed[0].fields.原始关键词 = '被改动';
  assert.throws(() => verifyHuitunBackfill({ before, after: changed, plan }), /unauthorized/i);
});
