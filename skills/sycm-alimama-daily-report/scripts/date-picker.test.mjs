import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAlimamaState, buildAlimamaUrl, extractIsoDates, isSingleDaySelection,
  resolveAppliedDate, resolveDateMode, selectDayHits, shiftIso, shiftMonth, siteAdapter,
} from './date-picker.mjs';

test('resolveDateMode 只在目标日等于站点时区昨日时走预设', () => {
  const now = new Date('2026-09-16T09:00:00+08:00');
  assert.deepEqual(resolveDateMode({ requested: '2026-09-15', now }),
    { requested: '2026-09-15', today: '2026-09-16', yesterday: '2026-09-15', mode: 'preset' });
  assert.equal(resolveDateMode({ requested: '2026-09-14', now }).mode, 'explicit');
  assert.throws(() => resolveDateMode({ requested: '2026/09/14', now }), /invalid requested date/u);
});

test('resolveDateMode 按站点时区判昨日，不随宿主时区漂移', () => {
  // 这一刻 UTC 还是 09-15，北京时间已经 09-16 04:00
  const now = new Date('2026-09-15T20:00:00Z');
  assert.equal(resolveDateMode({ requested: '2026-09-15', now }).mode, 'preset');
  assert.equal(resolveDateMode({ requested: '2026-09-14', now }).mode, 'explicit');
});

test('shiftIso 跨月回退', () => {
  assert.equal(shiftIso('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftIso('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftIso('2026-09-14', 1), '2026-09-15');
  assert.throws(() => shiftIso('2026-9-1', -1), /invalid iso date/u);
});

test('shiftMonth 用于同月比较驱动翻月，处理跨年', () => {
  assert.equal(shiftMonth('2026-09-14', -1), '2026-08');
  assert.equal(shiftMonth('2026-01-05', -1), '2025-12');
  assert.equal(shiftMonth('2026-12-05', 1), '2027-01');
  assert.equal(shiftMonth('2026-09-30', 0), '2026-09');
});

test('extractIsoDates 从页面文本里取全部日期', () => {
  assert.deepEqual(extractIsoDates('统计时间 2026-09-15'), ['2026-09-15']);
  assert.deepEqual(extractIsoDates('已选择：2026-09-14 至 2026-09-14'), ['2026-09-14', '2026-09-14']);
  assert.deepEqual(extractIsoDates('过去 7 天'), []);
  assert.deepEqual(extractIsoDates(null), []);
});

test('buildAlimamaUrl 把日期/场景/周期/粒度全部编码进 hash', () => {
  const url = buildAlimamaUrl({ requested: '2026-09-14' });
  const hash = url.slice(url.indexOf('#!/report/account') + '#!/report/account'.length);
  const params = new URLSearchParams(hash.replace(/^\?/u, ''));
  assert.equal(params.get('startTime'), '2026-09-14');
  assert.equal(params.get('endTime'), '2026-09-14');
  assert.equal(params.get('effectEqual'), '30');
  assert.equal(params.get('granularity'), 'day');
  assert.deepEqual(JSON.parse(params.get('bizCodeIn')), ['onebpSearch', 'onebpDisplay']);
  // 区间必须是单日，否则会静默变成多日累计
  assert.equal(params.get('startTime'), params.get('endTime'));
});

test('resolveAppliedDate 把「昨日」回显换算成具体日期', () => {
  assert.equal(resolveAppliedDate({ text: '昨日', yesterday: '2026-09-15' }), '2026-09-15');
  assert.equal(resolveAppliedDate({ text: '2026-09-14', yesterday: '2026-09-15' }), '2026-09-14');
  assert.equal(resolveAppliedDate({ text: '昨日 2026-09-15', yesterday: '2026-09-15' }), '2026-09-15');
  // 两个不同日期 → 判不出唯一值，必须返回 null 让上层报错
  assert.equal(resolveAppliedDate({ text: '2026-09-14 至 2026-09-15', yesterday: '2026-09-15' }), null);
  assert.equal(resolveAppliedDate({ text: '过去 7 天', yesterday: '2026-09-15' }), null);
});

const alimamaState = (overrides = {}) => ({
  applied: '2026-09-14',
  triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '2026-09-14', '分日',
    '全部计划', '周环比', '展现量', '请选择', '维度 营销场景', '20条/页'],
  ...overrides,
});

test('assertAlimamaState 通过真实筛选栏文本，并按语义识别而非索引', () => {
  const checked = assertAlimamaState({ state: alimamaState(), requested: '2026-09-14', yesterday: '2026-09-15' });
  assert.equal(checked.applied, '2026-09-14');
  assert.equal(checked.filters.effectCycle, '30天累计数据');
  assert.equal(checked.filters.granularity, '分日');
  // 打乱顺序也必须通过：断言不能绑死 trigger 的下标
  const shuffled = alimamaState({ triggers: ['分日', ' 2026-09-14', '30天累计数据', '末次点击归因', '关键词推广', '人群推广', 'x', 'y', 'z', 'u', 'v'] });
  assert.equal(assertAlimamaState({ state: shuffled, requested: '2026-09-14', yesterday: '2026-09-15' }).applied, '2026-09-14');
});

test('assertAlimamaState 对日期不符/场景缺失/周期不符逐条报错', () => {
  assert.throws(() => assertAlimamaState({ state: alimamaState(), requested: '2026-09-15', yesterday: '2026-09-15' }),
    /applied date/u);
  assert.throws(() => assertAlimamaState({
    state: alimamaState({ triggers: ['关键词推广', '末次点击归因', '30天累计数据', '2026-09-14', '分日', 'a', 'b', 'c', 'd', 'e', 'f'] }),
    requested: '2026-09-14', yesterday: '2026-09-15',
  }), /missing 人群推广/u);
  assert.throws(() => assertAlimamaState({
    state: alimamaState({ triggers: ['关键词推广 人群推广', '末次点击归因', '15天累计数据', '2026-09-14', '分日', 'a', 'b', 'c', 'd', 'e', 'f'] }),
    requested: '2026-09-14', yesterday: '2026-09-15',
  }), /30天累计数据/u);
});

test('assertAlimamaState 支持「昨日」回显（预设模式）', () => {
  const state = alimamaState({ applied: '昨日', triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '昨日', '分日', 'a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(assertAlimamaState({ state, requested: '2026-09-15', yesterday: '2026-09-15' }).applied, '2026-09-15');
});

test('siteAdapter 只接受已实测的两个站点', () => {
  assert.equal(siteAdapter('alimama').route, 'url-hash');
  assert.equal(siteAdapter('sycm').route, 'preset-or-calendar');
  assert.equal(siteAdapter('sycm').defaultExpectTab, '询单到付款');
  assert.equal(siteAdapter('alimama').defaultExpectTab, null);
  assert.throws(() => siteAdapter('tmall'), /unknown site/u);
});

// 面板实测结构：同一个月出现两次（rangeLeft / rangeRight），各自只带 current-month 的日格。
const calendarBlocks = (year, month, overrides = {}) => ([
  { index: 0, year, month, cells: [{ text: '31', x: 10, y: 10, inside: true }, { text: '14', x: 20, y: 20, inside: true }, { text: '30', x: 30, y: 30, inside: true }] },
  { index: 1, year, month, cells: [{ text: '31', x: 100, y: 10, inside: true }, { text: '14', x: 110, y: 20, inside: true }, { text: '30', x: 120, y: 30, inside: true }] },
].map((block) => ({ ...block, ...overrides })));

test('selectDayHits 在同月的两个块里各取到一次目标日', () => {
  const { dayNumber, hits } = selectDayHits(calendarBlocks(2026, 9), '2026-09-14');
  assert.equal(dayNumber, 14);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.blockIndex), [0, 1]);
  assert.deepEqual(hits.map((hit) => hit.cell.x), [20, 110]);
});

test('selectDayHits 目标月不可见时报出可见月份，不静默点错', () => {
  assert.throws(() => selectDayHits(calendarBlocks(2026, 8), '2026-09-14'), /does not show 2026-09.*2026-08/u);
  assert.throws(() => selectDayHits([], '2026-09-14'), /does not show 2026-09/u);
});

test('selectDayHits 目标日在块内缺失或重复时报错', () => {
  const missing = calendarBlocks(2026, 9).map((block) => ({
    ...block, cells: block.cells.filter((cell) => cell.text !== '14'),
  }));
  assert.throws(() => selectDayHits(missing, '2026-09-14'), /expected one day 14, got 0/u);
  const duplicated = calendarBlocks(2026, 9).map((block) => ({
    ...block, cells: [...block.cells, { text: '14', x: 99, y: 99, inside: true }],
  }));
  assert.throws(() => selectDayHits(duplicated, '2026-09-14'), /expected one day 14, got 2/u);
});

test('isSingleDaySelection 只认「X 至 X」', () => {
  assert.equal(isSingleDaySelection('已选择：2026-09-14 至 2026-09-14', '2026-09-14'), true);
  assert.equal(isSingleDaySelection('已选择：2026-09-14 至 2026-09-15', '2026-09-14'), false);
  assert.equal(isSingleDaySelection('已选择：2026-09-14', '2026-09-14'), false);
  assert.equal(isSingleDaySelection(null, '2026-09-14'), false);
});
