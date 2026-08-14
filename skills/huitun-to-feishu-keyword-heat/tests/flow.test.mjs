import assert from 'node:assert/strict';
import test from 'node:test';

let flow = {};
try {
  flow = await import('../scripts/flow.mjs');
} catch {
  // RED phase: the production module does not exist yet.
}

const missing = (name) => () => assert.fail(`missing export: ${name}`);
const parseDisplayedViews = flow.parseDisplayedViews ?? missing('parseDisplayedViews');
const normalizeTopic = flow.normalizeTopic ?? missing('normalizeTopic');
const classifyTopicSnapshot = flow.classifyTopicSnapshot ?? missing('classifyTopicSnapshot');
const contentHeatForViews = flow.contentHeatForViews ?? missing('contentHeatForViews');
const detectHumanRequired = flow.detectHumanRequired ?? missing('detectHumanRequired');
const selectRunTarget = flow.selectRunTarget ?? missing('selectRunTarget');
const parseOptions = flow.parseOptions ?? missing('parseOptions');
const candidateKeyword = flow.candidateKeyword ?? missing('candidateKeyword');
const advanceQuerySettlement = flow.advanceQuerySettlement ?? missing('advanceQuerySettlement');
const resultSnapshotSignature = flow.resultSnapshotSignature ?? missing('resultSnapshotSignature');
const canonicalEqual = flow.canonicalEqual ?? missing('canonicalEqual');

test('parses Huitun display units without changing the displayed evidence', () => {
  assert.equal(parseDisplayedViews('109.4w'), 1_094_000);
  assert.equal(parseDisplayedViews('1,314'), 1_314);
  assert.equal(parseDisplayedViews('2.5万'), 25_000);
  assert.equal(parseDisplayedViews('1.2亿'), 120_000_000);
  assert.throws(() => parseDisplayedViews('--'), /unsupported/i);
});

test('matches only an exact topic after trimming the surrounding hashes', () => {
  const result = classifyTopicSnapshot({
    keyword: '家用浴缸',
    rows: [
      ['#成人家用浴缸#', '9.5w', '3', '0', ''],
      ['#家用浴缸#', '109.4w', '2,054', '70', ''],
      ['#浴缸家用#', '2.2w', '59', '2', ''],
    ],
    emptyText: '',
  });
  assert.equal(normalizeTopic(result.topic), '家用浴缸');
  assert.deepEqual(result, {
    keyword: '家用浴缸',
    status: 'FOUND_EXACT',
    topic: '#家用浴缸#',
    viewsRaw: '109.4w',
    views: 1_094_000,
  });
});

test('returns zero when Huitun has no exact topic and never sums similar topics', () => {
  assert.deepEqual(classifyTopicSnapshot({
    keyword: '家用浴缸',
    rows: [['#成人家用浴缸#', '9.5w'], ['#浴缸家用#', '2.2w']],
    emptyText: '',
  }), {
    keyword: '家用浴缸',
    status: 'NO_EXACT_TOPIC',
    topic: null,
    viewsRaw: '灰豚返回相近话题，无完全同名话题',
    views: 0,
  });

  assert.deepEqual(classifyTopicSnapshot({
    keyword: '新型泡澡浴缸',
    rows: [],
    emptyText: '没有找到话题~~点击这里',
  }), {
    keyword: '新型泡澡浴缸',
    status: 'NO_EXACT_TOPIC',
    topic: null,
    viewsRaw: '没有找到话题~~点击这里',
    views: 0,
  });
});

test('uses the confirmed 1000w threshold and no invented middle band', () => {
  assert.equal(contentHeatForViews(9_999_999), '低');
  assert.equal(contentHeatForViews(10_000_000), '高');
});

test('checks only visible blockers so hidden QR components do not trigger a false alarm', () => {
  assert.equal(detectHumanRequired({ visibleTexts: [], accountText: 'ID：1001392394' }), null);
  assert.equal(detectHumanRequired({ visibleTexts: ['请使用微信扫码登录'], accountText: '' })?.code, 'LOGIN_CHALLENGE');
  assert.equal(detectHumanRequired({ visibleTexts: ['请完成滑块验证'], accountText: '' })?.code, 'CAPTCHA');
  assert.equal(detectHumanRequired({ visibleTexts: ['账号异常，请进行安全验证'], accountText: '' })?.code, 'SECURITY');
  assert.equal(detectHumanRequired({ visibleTexts: ['登录/注册'] }, { allowLogin: true }), null);
  assert.equal(detectHumanRequired({ visibleTexts: ['请使用微信扫码登录'] }, { allowLogin: true })?.code, 'LOGIN_CHALLENGE');
  assert.equal(detectHumanRequired({ visibleTexts: ['短信验证'] }, { allowLogin: true })?.code, 'LOGIN_CHALLENGE');
  assert.equal(detectHumanRequired({ visibleTexts: ['请登录'] }, { allowLogin: true })?.code, 'LOGIN_REQUIRED');
  assert.equal(detectHumanRequired({ visibleTexts: ['账号异常，请进行安全验证'] }, { allowLogin: true })?.code, 'SECURITY');
});

test('does not accept stale result rows until the submitted query causes a transition', () => {
  const stale = {
    query: '新型泡澡浴缸',
    rows: [['#家用浴缸#', '109.4w']],
    emptyText: '',
    loading: 0,
  };
  const preSignature = resultSnapshotSignature(stale);
  let state = {};
  ({ state } = advanceQuerySettlement({ keyword: stale.query, preSignature, state, snapshot: stale }));
  const second = advanceQuerySettlement({ keyword: stale.query, preSignature, state, snapshot: stale });
  assert.equal(second.result, null);
  assert.equal(second.state.transitionSeen, false);

  ({ state } = advanceQuerySettlement({
    keyword: stale.query,
    preSignature,
    state: second.state,
    snapshot: { ...stale, loading: 1 },
  }));
  ({ state } = advanceQuerySettlement({ keyword: stale.query, preSignature, state, snapshot: stale }));
  const settled = advanceQuerySettlement({ keyword: stale.query, preSignature, state, snapshot: stale });
  assert.equal(settled.result.status, 'NO_EXACT_TOPIC');

  const alreadyLoading = { ...stale, loading: 1 };
  const loadingSignature = resultSnapshotSignature(alreadyLoading);
  let loadingState = {};
  ({ state: loadingState } = advanceQuerySettlement({
    keyword: stale.query,
    preSignature: loadingSignature,
    preLoading: true,
    state: loadingState,
    snapshot: alreadyLoading,
  }));
  ({ state: loadingState } = advanceQuerySettlement({
    keyword: stale.query,
    preSignature: loadingSignature,
    preLoading: true,
    state: loadingState,
    snapshot: { ...stale, loading: 0 },
  }));
  const stillStale = advanceQuerySettlement({
    keyword: stale.query,
    preSignature: loadingSignature,
    preLoading: true,
    state: loadingState,
    snapshot: { ...stale, loading: 0 },
  });
  assert.equal(stillStale.result, null);
});

test('compares field definitions without depending on object key order', () => {
  assert.equal(canonicalEqual(
    [{ field_id: 'fld1', property: { options: [{ id: '1', name: '高' }] } }],
    [{ property: { options: [{ name: '高', id: '1' }] }, field_id: 'fld1' }],
  ), true);
});

test('reads Feishu text fields without assuming they are plain strings', () => {
  assert.equal(candidateKeyword({ fields: { 搜索词: '家用浴缸' } }), '家用浴缸');
  assert.equal(candidateKeyword({ fields: { 搜索词: [{ text: '家用浴缸' }] } }), '家用浴缸');
});

test('rediscovers only the tab labeled for the current run', () => {
  const targets = [
    { targetId: 'user-tab', type: 'page', url: 'https://xhs.huitun.com/#/home' },
    { targetId: 'run-tab', type: 'page', url: 'https://xhs.huitun.com/#/anchor/anchor_topic', automationLabel: 'run-1' },
  ];
  assert.equal(selectRunTarget(targets, 'run-1').targetId, 'run-tab');
  assert.throws(() => selectRunTarget(targets, 'run-2'), /labeled Huitun target/i);
});

test('CLI defaults to dry-run and requires an exact table confirmation for writes', () => {
  const options = parseOptions([]);
  assert.equal(options.apply, false);
  assert.equal(options.proxy, 'http://127.0.0.1:3456');
  assert.equal(options.tableId, 'tblN1uT1LpzyqqWx');
  assert.equal(options.resultMaxAgeMs, 24 * 60 * 60 * 1_000);
  assert.throws(() => parseOptions(['--apply']), /confirm-table/i);
  assert.equal(parseOptions(['--apply', '--confirm-table', 'tblN1uT1LpzyqqWx']).apply, true);
});
