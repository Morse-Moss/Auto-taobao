import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_IDS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';

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
const selectCandidates = flow.selectCandidates ?? missing('selectCandidates');
const advanceQuerySettlement = flow.advanceQuerySettlement ?? missing('advanceQuerySettlement');
const resultSnapshotSignature = flow.resultSnapshotSignature ?? missing('resultSnapshotSignature');
const canonicalEqual = flow.canonicalEqual ?? missing('canonicalEqual');
const assertProxyBrowserHealth = flow.assertProxyBrowserHealth ?? missing('assertProxyBrowserHealth');
const hasConfirmedAccount = flow.hasConfirmedAccount ?? missing('hasConfirmedAccount');

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

test('stops before Huitun candidate selection while populated AI rows are pending', () => {
  assert.throws(() => selectCandidates([
    { record_id: 'rec-pending', fields: { 搜索词: '家用浴缸', 优先级: '待数据' } },
    { record_id: 'rec-candidate', fields: { 搜索词: '小浴缸', 优先级: 'A候选' } },
  ]), (error) => {
    assert.equal(error.code, 'AI_REQUIRED');
    assert.match(error.message, /1 populated row.*待数据/iu);
    return true;
  });

  assert.throws(() => selectCandidates([
    { record_id: 'rec-unsettled', fields: { 搜索词: '家用浴缸', 优先级: '' } },
  ]), (error) => error.code === 'AI_REQUIRED' && /blank/iu.test(error.message));

  assert.deepEqual(selectCandidates([
    { record_id: 'rec-placeholder', fields: { 搜索词: '', 优先级: '待数据' } },
    { record_id: 'rec-candidate', fields: { 搜索词: '小浴缸', 优先级: 'A候选' } },
    { record_id: 'rec-final', fields: { 搜索词: '普通浴缸', 优先级: 'C-暂不跟进' } },
  ]).map((record) => record.record_id), ['rec-candidate']);
});

test('B fallback selects strict high-search medium/high-trade rows only when no A queue exists', () => {
  const b = { record_id: 'rec-b', fields: { 搜索词: '浴缸', 搜索热度: '高', 交易热度: '中', 优先级: '待数据' } };
  assert.deepEqual(selectCandidates([b], { mode: 'B_FALLBACK' }).map((record) => record.record_id), ['rec-b']);
  assert.throws(() => selectCandidates([
    b,
    { record_id: 'rec-a', fields: { 搜索词: '人造石浴缸', 优先级: 'A候选' } },
  ], { mode: 'B_FALLBACK' }), /A-candidate queue exists/i);
  assert.deepEqual(selectCandidates([
    { record_id: 'rec-low', fields: { 搜索词: '小浴缸', 搜索热度: '低', 交易热度: '高', 优先级: '待数据' } },
  ], { mode: 'B_FALLBACK' }), []);
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
  const target = ['--table-id', 'tblCurrent', '--table-name', '关键词分析 V1（2026-08-14）'];
  assert.throws(() => parseOptions([]), /table-id, table-name/iu);
  const options = parseOptions(target);
  assert.equal(options.apply, false);
  // 端口与浏览器 id 对着登记表断言，不写死数字：写死就变成把旧默认值固化成测试（坑 34）。
  assert.equal(options.proxy, `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`);
  assert.equal(options.browserId, BROWSER_IDS.dailyReport);
  assert.notEqual(options.proxy, 'http://127.0.0.1:3456');
  assert.equal(options.tableId, 'tblCurrent');
  assert.equal(options.resultMaxAgeMs, 24 * 60 * 60 * 1_000);
  assert.equal(options.candidateMode, 'A_ONLY');
  assert.equal(parseOptions([...target, '--fallback-b']).candidateMode, 'B_FALLBACK');
  assert.throws(() => parseOptions([...target, '--apply']), /confirm-table/i);
  assert.equal(parseOptions([...target, '--apply', '--confirm-table', 'tblCurrent']).apply, true);
});

test('proxy health must identify the requested Edge browser', () => {
  assert.doesNotThrow(() => assertProxyBrowserHealth({ status: 'ok', connected: true, browser: { id: 'edge' } }, 'edge'));
  assert.throws(() => assertProxyBrowserHealth({ status: 'ok', connected: true, browser: { id: 'browser-service' } }, 'edge'), /browser mismatch/i);
  assert.throws(() => assertProxyBrowserHealth({ status: 'ok', connected: false, browser: { id: 'edge' } }, 'edge'), /not connected/i);
});

test('confirmed Huitun accounts accept both ID and DY header formats', () => {
  assert.equal(hasConfirmedAccount('ID：1001392394'), true);
  assert.equal(hasConfirmedAccount('DY003719756'), true);
  assert.equal(hasConfirmedAccount('登录/注册'), false);
});
