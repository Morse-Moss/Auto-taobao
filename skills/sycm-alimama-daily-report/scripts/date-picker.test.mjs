import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  applyDate,
  assertAlimamaState, buildAlimamaUrl, extractIsoDates, isFuncPermissionDenied, isSingleDaySelection,
  needsStaleReload, SHOP_FUNC_NO_PERMISSION,
  resolveAppliedDate, resolveDateMode, resolveTarget, selectDayHits, shiftIso, shiftMonth, siteAdapter,
} from './date-picker.mjs';

// 落位的 stdout 是要给人看的（客户演示时甚至会被录进视频），所以「设计上允许」与「真的出错」
// 在措辞上必须分得开：这一步读不到是允许的，真正判据是随后的回读断言。
// 原来记成 `read-before-failed` 并把 `HTTP 400 …` 打出来，看着像脚本报错，而 status 其实是 APPLIED。
test('落位 trace：动作前读不到写成「可缺省」，不许用 failed 的措辞', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'date-picker.mjs'), 'utf8');
  assert.match(source, /say\('read-before-skipped', \{\s*\n\s*tolerated: true/u, '要显式标出这一步是可容忍的');
  assert.match(source, /detail: String\(before\.unreadable\)/u, '原始文本收进 detail 备查即可');
  // 只判**代码形态**：注释里必然要写清「原先叫什么、为什么改」，那种出现是应该保留的。
  // （源码级守卫被自己的注释绊倒过一次，与端口守卫「注释里解释为什么别写死」是同一类。）
  assert.equal(/say\('read-before-failed'/u.test(source), false, '别再用 failed 描述一个设计上允许的缺省');
  assert.ok(/say\('read-before-failed'/.test("  say('read-before-failed', { error });"),
    '判据本身失效了（拿真的违规写法都测不出来）');
});

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

// 站点页会被「同页签导航」带走：采集店铺报表把生意参谋留在报表预览页上，回填前重跑落位就会
// 报 `expected one sycm page …, got 0`（2026-09-17 实跑）。回位必须是落位自己的事，
// 但也不能乱导航 —— 只在「同一主机下恰好一个页面」时才动它。
test('落位认不出页面时按 entryUrl 回位，且只动同一主机下那一个页面', async () => {
  const run = async (initial) => {
    const calls = [];
    let current = initial;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const body = String(url).includes('/navigate')
        ? (() => { current = [
          { type: 'page', targetId: 'sycm-page', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
          { type: 'page', targetId: 'alimama-page', url: 'https://one.alimama.com/index.html' },
        ]; return { frameId: 'sycm-page' }; })()
        : current;
      const text = JSON.stringify(body);
      return { ok: true, text: async () => text, json: async () => body };
    };
    try {
      const recovered = [];
      const targetId = await resolveTarget({ proxy: 'http://127.0.0.1:1', site: 'sycm', onRecover: (info) => recovered.push(info) });
      return { targetId, recovered, calls };
    } finally { globalThis.fetch = realFetch; }
  };

  const preview = { type: 'page', targetId: 'sycm-page', url: 'https://sycm.taobao.com/lyone/auto_analysis/datafetch/report_generation?reportId=1' };
  const alimama = { type: 'page', targetId: 'alimama-page', url: 'https://one.alimama.com/index.html#!/report/download-list' };

  const ok = await run([preview, alimama]);
  assert.equal(ok.targetId, 'sycm-page', '回位之后要认回应用内页');
  assert.equal(ok.recovered.length, 1, '回位这一步必须留下痕迹（会进 trace）');
  assert.match(ok.recovered[0].entryUrl, /performance\/new#\/shop/u);
  const navs = ok.calls.filter((call) => call.includes('/navigate'));
  assert.equal(navs.length, 1, '只许动一个页面');
  assert.ok(navs[0].includes('sycm-page'), '动的是生意参谋那一页，不是阿里妈妈');
  assert.ok(navs[0].includes(encodeURIComponent('https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop')),
    '必须按登记的回位地址导航');

  // 同一主机下出现两个页面 ⇒ 现场不是我以为的样子，宁可报错也别乱导航。
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = [preview, { ...preview, targetId: 'other' }, alimama];
    const text = JSON.stringify(body);
    return { ok: true, text: async () => text, json: async () => body };
  };
  try {
    await assert.rejects(() => resolveTarget({ proxy: 'http://127.0.0.1:1', site: 'sycm' }),
      /expected one sycm page on .* got 0/u);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.filter((call) => call.includes('/navigate')).length, 0, '不明确时一次导航都不许发');
});

// 阿里妈妈没有回位地址（它本来就在自己的页面上，靠 URL hash 认）—— 别给它编一个。
test('只有生意参谋登记了回位地址', () => {
  assert.match(siteAdapter('sycm').entryUrl, /sycm\.taobao\.com/u);
  assert.equal(siteAdapter('alimama').entryUrl, undefined);
});

// ------------------------------------------------- 落位重试（2026-09-20 现场修的一处）

// 现场（evidence/multi-shop-2026-09-19-rerun3/盖文淘宝/02-alimama-date.txt）：
// 两家店都停在 alimama-date，报出来的却是**读取表达式原样抛出**
// （`filter bar not ready; triggers=0` / `date trigger ambiguous: []`），调用栈顶是
// `settle …:434` —— 也就是第一次读就穿透出整步，navigate 之后只过了 1.2 秒。
// 那两次报错的语义都是「还没渲染完」，不是「落位输了」；而原来那个「8 次重试」在这种情况下
// 一次都跑不到。实测冷挂载到筛选栏齐全要 6190ms
// （evidence/alimama-cold-mount-2026-09-20/02-cold-tab-experiment.txt）。
// 下面这条按现场序列回放：读两次读不到、第三次才齐 ⇒ 必须判成功。
const ALIMAMA_READY_STATE = {
  applied: ' 昨日',
  triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', ' 昨日', '分日',
    '全部计划', '周环比', '展现量', '请选择', '维度 营销场景', '20条/页'],
};

// 假代理：只答落位要用的三个口子（/targets、/navigate、/eval），eval 按给定序列作答。
// 用假代理而不是桩函数，是为了让 navigate → settle 的真实顺序也被跑到。
function stubProxy({ evalResults, targets = [{ type: 'page', targetId: 'alimama-page', url: 'https://one.alimama.com/index.html' }] }) {
  const calls = [];
  let evalIndex = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, body: init?.body ?? null });
    const respond = (ok, status, payload) => ({
      ok, status, text: async () => JSON.stringify(payload), json: async () => payload,
    });
    if (text.includes('/targets')) {
      return respond(true, 200, targets);
    }
    if (text.includes('/navigate')) return respond(true, 200, { frameId: 'alimama-page' });
    // 生意参谋那条路要真实点击（页签、预设），所以桩必须认这个口子 ——
    // 阿里妈妈那条路靠 navigate，用不到它。
    if (text.includes('/clickPoint')) return respond(true, 200, { ok: true });
    if (text.includes('/eval')) {
      const result = evalResults[Math.min(evalIndex, evalResults.length - 1)];
      evalIndex += 1;
      if (result.error) return respond(false, 400, { error: result.error });
      return respond(true, 200, { value: JSON.stringify(result.state) });
    }
    throw new Error(`stub 没实现这个口子：${text}`);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = realFetch; },
    evalCalls: () => evalIndex,
    reloads: () => calls.filter((call) => String(call.body ?? '').includes('location.reload')),
  };
}

const settleCase = { site: 'alimama', requested: '2026-09-19', proxy: 'http://127.0.0.1:1',
  now: new Date('2026-09-20T09:00:00+08:00'), settleMs: 1 };

test('落位：navigate 之后头两次读不到（页面还没渲染完）不算失败，等到齐为止', async () => {
  const stub = stubProxy({ evalResults: [
    { error: 'alimama filter bar not ready; triggers=0' },   // 动作前那次读取（按设计可缺省）
    { error: 'alimama filter bar not ready; triggers=0' },   // settle 第 1 轮
    { error: 'alimama date trigger ambiguous: []' },         // settle 第 2 轮（现场天猫正是这句）
    { state: ALIMAMA_READY_STATE },                          // settle 第 3 轮
  ] });
  try {
    const result = await applyDate(settleCase);
    assert.equal(result.status, 'APPLIED');
    assert.equal(result.observedAfter, ' 昨日');
    const steps = result.trace.map((step) => step.step);
    assert.ok(steps.includes('read-before-skipped'), '动作前读不到仍按设计缺省');
    const retried = result.trace.find((step) => step.step === 'settle-retried');
    assert.ok(retried, '等了不止一轮就要留痕 —— 否则「这一步为什么慢」永远只能靠复现');
    assert.equal(retried.reads, 3);
    assert.equal(retried.readFailures, 2);
    // 读不到的那几轮不许把 navigate 重发一遍：返回 URL hash 就够了，重发等于把页面推回去重挂。
    assert.equal(stub.calls.filter((call) => call.url.includes('/navigate')).length, 1);
  } finally { stub.restore(); }
});

test('落位：一直读不到时，报错要点名「读了几次、最后一次为什么读不到」', async () => {
  const stub = stubProxy({ evalResults: [{ error: 'alimama filter bar not ready; triggers=0' }] });
  try {
    await assert.rejects(() => applyDate(settleCase), (error) => {
      assert.match(error.message, /state did not settle to 2026-09-19/u);
      assert.match(error.message, /读了 16 次/u, '预算要写在报错里，别让人猜等过多久');
      assert.match(error.message, /读不到 16 次/u, '「一次都没读成」与「读成了但对不上」必须分得开');
      assert.match(error.message, /triggers=0/u, '最后一次读不到的原因要带出来');
      assert.equal(error.trace.at(-1).step, 'navigate', 'trace 仍要停在最后一步');
      return true;
    });
  } finally { stub.restore(); }
});

test('落位：读得到但日期对不上时，报错里要留着「最后读成什么样」', async () => {
  const stub = stubProxy({ evalResults: [{ state: { ...ALIMAMA_READY_STATE, applied: '2026-09-16' } }] });
  try {
    await assert.rejects(() => applyDate(settleCase), (error) => {
      assert.match(error.message, /读不到 0 次/u, '这不是读不到，是读到了没落位');
      assert.match(error.message, /alimama applied date is/u);
      assert.match(error.message, /lastReadError=none/u);
      return true;
    });
  } finally { stub.restore(); }
});

// 源码级接线守卫：这条是本次修的那个「位置错」，所以判的是**位置**，不是行为 ——
// 行为已经被上面三条用例按住，但位置一旦退回去，行为用例会因为「第一次读恰好成功」而全绿。
test('落位：settle 里那次读取必须在容错里（放在 try 之外＝第一次读就穿透）', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'date-picker.mjs'), 'utf8');
  assert.match(source, /try \{\s*\n\s*state = await readSiteState/u, '读取要在 try 里');
  assert.equal(/^\s*last = await readSiteState/mu.test(source), false,
    '别再让读取直接赋值 —— 读不到就不再是「再等一轮」而是「整步失败」');
  assert.match(source, /if \(attempt > 0\) say\('settle-retried'/u, '重试要留痕');
});

// ---------------------------------------------------------------- 生意参谋「页面过期」

// 2026-09-21 现场：五家店的工作页全部读回「统计时间 2026-09-19」（目标日 09-20），
// 8×1.2s 级别地反复读也不变；而真重载一次之后立刻变成 09-20。
// 成因是「1天」是相对预设、只在页面加载时解析，点一个**已经选中**的预设不会触发重新取数。
const SYCM_TARGET = [{ type: 'page', targetId: 'sycm-page',
  url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' }];
const SYCM_TABS = ['智能问数', '业绩分析', '汇总分析', '询单到付款'];
const sycmState = (applied, activeTabs) => ({ applied, tabs: SYCM_TABS, activeTabs });
const sycmPresetCase = { site: 'sycm', requested: '2026-09-20', proxy: 'http://127.0.0.1:1',
  now: new Date('2026-09-21T11:41:00+08:00'), expectTab: '询单到付款', settleMs: 1 };

test('needsStaleReload：只按读数判「页面是不是停在上一轮的渲染上」', () => {
  const at = (observed) => needsStaleReload({ observed, requested: '2026-09-20', yesterday: '2026-09-20' });
  assert.equal(at('统计时间 2026-09-19'), true, '读数停在昨天之前 ⇒ 页面是旧的');
  assert.equal(at('统计时间 2026-09-20'), false, '读数已经是目标日 ⇒ 不动它');
  assert.equal(at(null), true, '读不到就不知道它是不是新的 ⇒ 按「先重载」处理');
  assert.equal(at('统计时间 2026-09-14 至 2026-09-20'), true,
    '读成区间时解析不出唯一日期 ⇒ 同样按过期处理（这正是不许把 7 天区间当单日的判据）');
});

test('落位：生意参谋读数停在旧日期时先真重载，重载后读数对了才继续', async () => {
  const stub = stubProxy({
    targets: SYCM_TARGET,
    evalResults: [
      { state: sycmState('统计时间 2026-09-19', ['询单到付款']) },  // 1 动作前读取：过期
      { error: 'Execution context was destroyed' },                 // 2 重载调用（上下文被拆，预期内）
      { state: sycmState('统计时间 2026-09-20', ['汇总分析']) },    // 3 重载后读取：对上了
      { state: { active: false, point: [492, 277] } },              // 4 页签表达式
      { state: sycmState('统计时间 2026-09-20', ['询单到付款']) },  // 5 点完页签后的复核
      { state: { point: [821, 162] } },                             // 6 预设表达式
      { state: sycmState('统计时间 2026-09-20', ['询单到付款']) },  // 7 settle 第 1 轮
    ],
  });
  try {
    const result = await applyDate(sycmPresetCase);
    assert.equal(result.status, 'APPLIED');
    assert.equal(result.observedAfter, '统计时间 2026-09-20');
    assert.equal(stub.reloads().length, 1, '旧页面必须被真重载一次');
    assert.equal(result.pageReload.observedAfterReload, '统计时间 2026-09-20');
    assert.match(String(result.pageReload.reloadError), /Execution context/u,
      '重载调用本身报错是预期内的（上下文被拆），要如实记下来，不能当成失败');
    const steps = result.trace.map((step) => step.step);
    assert.ok(steps.includes('reload-stale-page'), '为什么重载要留痕');
    assert.ok(steps.includes('reloaded'), '重载的结果要留痕');
  } finally { stub.restore(); }
});

test('落位：读数本来就是目标日时不重载（行为与从前逐字相同）', async () => {
  const stub = stubProxy({
    targets: SYCM_TARGET,
    evalResults: [
      { state: sycmState('统计时间 2026-09-20', ['询单到付款']) },
      { state: { active: true, point: [492, 277] } },
      { state: { point: [821, 162] } },
      { state: sycmState('统计时间 2026-09-20', ['询单到付款']) },
    ],
  });
  try {
    const result = await applyDate(sycmPresetCase);
    assert.equal(result.status, 'APPLIED');
    assert.equal(stub.reloads().length, 0, '读数已经对了就不该动页面（否则每次跑都白重载一遍）');
    assert.equal(result.pageReload, null);
    assert.equal(result.presetWasNoop, true,
      '读数本来就对 ⇒ 这次点击其实是空操作，收据要如实写出来（历史每轮都是这个形态）');
  } finally { stub.restore(); }
});

test('落位：重载之后读数仍不对 ⇒ 报错要排除「页面过期」这个成因', async () => {
  const stub = stubProxy({
    targets: SYCM_TARGET,
    evalResults: [
      { state: sycmState('统计时间 2026-09-19', ['询单到付款']) },
      { error: 'Execution context was destroyed' },
      { state: sycmState('统计时间 2026-09-19', ['汇总分析']) },   // 重载了，但平台就是没有这一天的数
    ],
  });
  try {
    await assert.rejects(() => applyDate(sycmPresetCase), (error) => {
      assert.match(error.message, /页面停在旧渲染这一种成因已排除/u,
        '重载都救不回来时，必须把「页面过期」这条成因排除掉，否则看的人会去重载页面白跑一趟');
      assert.match(error.message, /平台这一天还没有数/u);
      return true;
    });
  } finally { stub.restore(); }
});

// ------------------------------------------------- 「这一项订购不在账号上」的判据（2026-09-21）
//
// 现场：科塔的工作页加载不出来。我们先后把它归因成「页面停在旧渲染」「导航方式不对」
// 「体检窗口太短」，三条全错 —— 真正的判据是**问平台一句**：同一个地址，
// 平台答 {code:0} 表示这个账号能用、{code:5903} 表示这个账号没这一项。
// 所以这一节钉两件事：① 「问不到」绝不能当结论用；② 两条失败路径都**真的接了**这个判据。

test('功能权限判据：只有「问到了、平台说不」才算数', () => {
  assert.equal(isFuncPermissionDenied({ asked: true, code: 5903 }), true);
  // 平台说能用 ⇒ 不许判成没订购：判错这一档会把健康店一起拦下（前四家会被牵连）
  for (const code of [0, '0', null, undefined, 5902]) {
    assert.equal(isFuncPermissionDenied({ asked: true, code }), false, `code=${code} 不许判成没订购`);
  }
  // **问不到**（页面漂走了 / 网络抖 / eval 的上下文被拆）一律不算 ——「无法解释」不能当结论用
  assert.equal(isFuncPermissionDenied({ asked: false, code: 5903 }), false, '没问到就不许下结论');
  assert.equal(isFuncPermissionDenied({ asked: false, why: '没有可在其上查询的页面' }), false);
  assert.equal(isFuncPermissionDenied({}), false);
  assert.equal(isFuncPermissionDenied(), false);
  assert.equal(SHOP_FUNC_NO_PERMISSION, 'SHOP_FUNC_NO_PERMISSION', '这个名字是跨文件的约定，驱动靠它分告警，别改名');
});

test('接线：两条「读数起不来」的失败路径都真接了功能权限判据', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'date-picker.mjs'), 'utf8');
  // ① 「重载也救不回来」那条路：先问平台、再按答复决定报哪种错，顺序不能反
  const reloadProbe = source.indexOf('probeShopFuncPermission({ proxy, site, targetId: page })');
  const reloadThrow = source.indexOf('重新加载页面后读数仍是');
  assert.ok(reloadProbe > 0, '找不到「重载也救不回来」那条路上的问平台调用（改代码时请同步这条判据）');
  assert.ok(reloadThrow > reloadProbe, '问平台必须在抛错之前 —— 反了就等于没接');
  assert.ok(source.slice(reloadProbe, reloadThrow).includes('isFuncPermissionDenied(probe)'), '问了要判，不能只是问');
  // ② 「回位也认不出页面」那条路（现场里科塔是漂到首页才被认出来的）
  const targetProbe = source.indexOf('probeShopFuncPermission({ proxy, site })');
  const targetThrow = source.indexOf('expected one ${site} page on ${proxy}');
  assert.ok(targetProbe > 0, '找不到「认不出页面」那条路上的问平台调用');
  assert.ok(targetThrow > targetProbe, '这一条同样必须先问后抛');
  // ③ 抛出去必须带确定性名字：告警链靠它把这一类与「通用失败」分开（否则会被报成「去窗口补页面」）
  assert.equal((source.match(/namedFailure\(SHOP_FUNC_NO_PERMISSION/gu) ?? []).length, 2, '两条失败路径各一处，别只改一条');
  // ④ 问的必须是**真模块**：带 /new 的是壳，对谁都放行，拿它当判据会永远判「没问题」
  assert.equal(siteAdapter('sycm').permissionProbeUrl.includes('/new'), false, '壳地址不能当判据（2026-09-21 实测它对谁都回 code:0）');
  assert.match(siteAdapter('sycm').permissionProbeUrl, /sycm\.taobao\.com\/qos\/service\/frame\/shop\/performance$/u);
  assert.equal(siteAdapter('alimama').permissionProbeUrl, undefined, '阿里妈妈没有这个查询口子，别给它编一个');
});
