import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  AUTH_STATUS_VOCABULARY,
  BROWSER_PORT_NAMES,
  PLATFORM_LABELS,
  SITE_PLATFORM,
  buildAccountsPayload,
  buildEnvPayload,
  buildRunsPayload,
  deriveAccountGroups,
  lampForBrowserPort,
  lampForProxyPort,
  presentationForStatus,
} from './state.mjs';
import { BROWSER_PROFILES, PROJECT_PORTS, ROUTES } from '../browser-ports.mjs';

// 登记表里出现的每个站点都必须能归到一个平台卡上。
// 不做这条断言的话，将来给某条路线加一个站点（比如加个 tmall 子站），
// 界面上会**静默少一张账号卡** —— 运营看不到那个账号要登录，跑到那里才卡住。
test('every site declared in the route registry maps to an account card', () => {
  const unmapped = [];
  for (const [routeName, route] of Object.entries(ROUTES)) {
    for (const site of route.sites) {
      if (!SITE_PLATFORM[site]) unmapped.push(`${routeName}:${site}`);
      else if (!PLATFORM_LABELS[SITE_PLATFORM[site]]) unmapped.push(`${routeName}:${site} (无卡标题)`);
    }
  }
  assert.deepEqual(unmapped, []);
});

// 反向：不许留下没人用的站点映射（否则平台表会慢慢变成一堆死条目）。
test('site-to-platform map has no entries for sites nobody uses', () => {
  const declared = new Set(Object.values(ROUTES).flatMap((route) => route.sites));
  assert.deepEqual(Object.keys(SITE_PLATFORM).filter((site) => !declared.has(site)), []);
});

// 端口灯要真探的那个端口，必须是登记表里真实存在的键 —— 拼错键名会拿到 undefined，
// 而 undefined 端口会让探针静默失败并显示成「没在运行」（假灰）。
test('every browser has registered ports and every registered port name is real', () => {
  const keys = Object.keys(BROWSER_PROFILES);
  assert.deepEqual(Object.keys(BROWSER_PORT_NAMES).sort(), keys.sort());
  for (const key of keys) {
    const names = BROWSER_PORT_NAMES[key];
    assert.deepEqual(Object.keys(names).sort(), ['browser', 'proxy']);
    for (const portKey of Object.values(names)) {
      assert.ok(Number.isInteger(PROJECT_PORTS[portKey]), `${portKey} 不在 PROJECT_PORTS 里`);
    }
  }
  // 两个浏览器的端口不能撞（撞了就等于「灯亮着但不是你这个浏览器」）。
  const used = Object.values(BROWSER_PORT_NAMES).flatMap((names) => Object.values(names)).map((k) => PROJECT_PORTS[k]);
  assert.equal(new Set(used).size, used.length);
});

test('account groups are derived from the registry, keyed by browser profile', () => {
  const groups = deriveAccountGroups();
  assert.deepEqual(groups.map((group) => group.key), Object.keys(BROWSER_PROFILES));
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group.cards.map((card) => card.platform)]));
  assert.deepEqual(byKey.competitor, ['taobaoBuyer']);
  assert.deepEqual([...byKey.dailyReport].sort(), ['alimama', 'feishu', 'huitun', 'qianniu', 'sycm']);
  // 每张卡都必须能追到「它属于哪个 profile」，页面按它分组。
  for (const group of groups) {
    for (const card of group.cards) assert.equal(card.profileKey, group.key);
  }
});

// 一期最危险的失败模式：示例数据被当成真实体检结果。所以接口必须自报 probed=false，
// 且每张卡都带 sample=true；将来真接了体检，这两处会被一起改掉（改一处就会红）。
test('accounts payload never claims to be probed while it is still sample data', () => {
  const payload = buildAccountsPayload();
  assert.equal(payload.probed, false);
  assert.equal(payload.statusSource, 'SAMPLE_NOT_PROBED');
  assert.match(payload.notice, /示例/u);
  const cards = payload.groups.flatMap((group) => group.cards);
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.equal(card.sample, true, `${card.accountKey} 没标 sample`);
    assert.equal(card.checkedAt, null);
    assert.equal(card.evidencePath, null);
  }
});

// 预留的平台只能是灰灯，绝不许绿 —— 假绿灯比红灯危害大（§3.2）。
test('the reserved platform is grey and carries a reason, never a green light', () => {
  const cards = buildAccountsPayload().groups.flatMap((group) => group.cards);
  const reserved = cards.filter((card) => card.reserved);
  assert.deepEqual(reserved.map((card) => card.platform), ['qianniu']);
  for (const card of reserved) {
    assert.equal(card.lamp, 'grey');
    assert.equal(card.status, null);
    assert.match(card.reason, /预留/u);
    assert.deepEqual(card.buttons, []);
  }
});

// 词表与外观必须一一对应（双向）：许漏一个状态会让界面显示「未登记的状态」，
// 而多一个外观条目会让「已经覆盖了」这件事变得可疑。
test('every vocabulary status has a presentation and every presentation is in the vocabulary', () => {
  for (const status of AUTH_STATUS_VOCABULARY) {
    const presentation = presentationForStatus(status);
    assert.equal(presentation.unregistered, undefined, `${status} 没有登记外观`);
    assert.ok(['green', 'amber', 'red', 'grey', 'blue'].includes(presentation.lamp), `${status} 的灯色不在五色里`);
    assert.ok(Array.isArray(presentation.buttons));
  }
  // 体检脚本现在真正会产出的状态，逐个点名 —— 它们必须都有可点按钮或不许有按钮。
  assert.deepEqual(presentationForStatus('AUTH_READY').buttons, []);
  assert.equal(presentationForStatus('AUTH_REQUIRED').buttons[0].id, 'open-login');
  assert.equal(presentationForStatus('ACCOUNT_MISMATCH').buttons[0].id, 'switch-login');
  assert.equal(presentationForStatus('AUTH_UNKNOWN').lamp, 'grey');
  // 没登记的状态走 fail-closed：灰灯 + 让运营重新检查，不冒充绿。
  const unknown = presentationForStatus('SOMETHING_NEW');
  assert.equal(unknown.lamp, 'grey');
  assert.equal(unknown.unregistered, true);
});

// 「一个按钮走天下」是设计文档明令禁止的。三种需要人的状态必须给三种不同的动作。
test('needing-human states are not all mapped to the same button', () => {
  const ids = ['AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'RISK_BLOCKED', 'PLUGIN_UNAVAILABLE', 'AUTH_UNKNOWN']
    .map((status) => presentationForStatus(status).buttons.map((button) => button.id).join('+'));
  assert.equal(new Set(ids).size, ids.length);
});

// 「词表里有、体检还没产出」的状态必须被显式列出来，否则会让人以为风控与过期已覆盖。
test('statuses that the preflight cannot emit yet are declared, not silently shown as live', () => {
  const payload = buildAccountsPayload();
  assert.deepEqual([...payload.notYetEmittedStatuses].sort(), ['AUTH_EXPIRING', 'RISK_BLOCKED']);
});

test('env payload probes both browsers and keeps the registry as the only source', async () => {
  const payload = await buildEnvPayload({
    timeoutMs: 50,
    inspect: async (port) => ({ status: 'free', port }),
  });
  assert.deepEqual(payload.browsers.map((browser) => browser.key), Object.keys(BROWSER_PROFILES));
  for (const browser of payload.browsers) {
    assert.equal(browser.lights.browser.verdict, 'free');
    assert.equal(browser.lights.browser.lamp, 'grey');
    assert.equal(browser.lights.proxy.lamp, 'grey');
    assert.ok(browser.routesSummary.includes('账号='));
    assert.deepEqual(browser.routes, Object.keys(ROUTES).filter((name) => ROUTES[name].browser === browser.key));
  }
  assert.equal(payload.console.port, PROJECT_PORTS.operatorConsole);
  assert.equal(payload.console.host, '127.0.0.1');
});

test('the launch dropdown is fed by the registry, not by a copy inside the page', async () => {
  const payload = await buildEnvPayload({ timeoutMs: 50, inspect: async () => ({ status: 'free' }) });
  assert.deepEqual(payload.routes.map((route) => route.key), Object.keys(ROUTES));
  const competitorImport = payload.routes.find((route) => route.key === 'competitorImport');
  assert.equal(competitorImport.noBrowser, true);
  assert.match(competitorImport.noBrowserReason, /不开浏览器/u);
});

test('browser port lamps distinguish ours / foreign / unknown / free', () => {
  assert.equal(lampForBrowserPort({ verdict: 'ours' }).lamp, 'green');
  assert.equal(lampForBrowserPort({ verdict: 'foreign' }).lamp, 'red');
  assert.equal(lampForBrowserPort({ verdict: 'unknown' }).lamp, 'amber');
  assert.equal(lampForBrowserPort({ verdict: 'free' }).lamp, 'grey');
  // 「在监听但读不出身份」不许当绿，也不许当红：没有正面证据就下判决 = 一次网络抖动变成一次事故。
  assert.equal(lampForProxyPort({ status: 'occupied-unidentified' }).lamp, 'green');
  assert.equal(lampForProxyPort({ status: 'occupied' }).lamp, 'amber');
  assert.equal(lampForProxyPort({ status: 'free' }).lamp, 'grey');
});

// ---------------------------------------------------------------------------
// 进度块：真读文件，取不到就灰 + 带理由
// ---------------------------------------------------------------------------

function fakeLayout(periods) {
  const root = mkdtempSync(resolve(tmpdir(), 'opconsole-'));
  const runtimeRoot = resolve(root, 'runtime');
  const repoRoot = root;
  mkdirSync(resolve(runtimeRoot, 'faq-analysis'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'evidence'), { recursive: true });
  for (const { period, status, evidence } of periods) {
    if (status) {
      mkdirSync(resolve(runtimeRoot, 'faq-analysis', period), { recursive: true });
      writeFileSync(resolve(runtimeRoot, 'faq-analysis', period, 'operator-status.json'), JSON.stringify(status));
    }
    if (evidence) {
      writeFileSync(resolve(repoRoot, 'evidence', `faq-operator-status-${period}.json`), JSON.stringify(evidence));
    }
  }
  return { runtimeRoot, repoRoot };
}

const completeStatus = (period, extra = {}) => ({
  period,
  status: 'DONE',
  nextAction: 'DONE',
  manifestLocked: true,
  evidenceComplete: true,
  localSnapshotBuilt: true,
  localAnalysisVerified: true,
  aiReviewComplete: true,
  humanReviewComplete: true,
  localSummariesBuilt: true,
  summariesPublished: true,
  rawRecords: 27,
  checkedAt: new Date().toISOString(),
  ...extra,
});

test('progress reads the live operator status file and renders its stage list', () => {
  const { runtimeRoot, repoRoot } = fakeLayout([{ period: '2026-09-13_2026-09-19', status: completeStatus('2026-09-13_2026-09-19', { summariesPublished: false }) }]);
  const payload = buildRunsPayload({ runtimeRoot, repoRoot });
  assert.equal(payload.runs.length, 1);
  const run = payload.runs[0];
  assert.equal(run.available, true);
  assert.equal(run.statusSource, 'runtime/faq-analysis');
  assert.equal(run.sourcePath, 'runtime/faq-analysis/2026-09-13_2026-09-19/operator-status.json');
  assert.equal(run.status, 'IN_PROGRESS');
  assert.equal(run.nextAction, 'PUBLISH_FEISHU_SUMMARIES');
  assert.equal(run.stages.length, 8);
  assert.deepEqual(run.stageCounts, { done: 7, total: 8, current: 1 });
  assert.equal(payload.defaultPeriod, '2026-09-13_2026-09-19');
});

test('progress falls back to the evidence snapshot and says so', () => {
  const { runtimeRoot, repoRoot } = fakeLayout([{ period: '2026-09-06_2026-09-12', evidence: completeStatus('2026-09-06_2026-09-12') }]);
  const run = buildRunsPayload({ runtimeRoot, repoRoot }).runs[0];
  assert.equal(run.statusSource, 'evidence');
  assert.equal(run.sourcePath, 'evidence/faq-operator-status-2026-09-06_2026-09-12.json');
  assert.equal(run.status, 'DONE');
});

test('live status wins over the archived evidence snapshot for the same period', () => {
  const { runtimeRoot, repoRoot } = fakeLayout([{
    period: '2026-09-13_2026-09-19',
    status: completeStatus('2026-09-13_2026-09-19', { localSummariesBuilt: false, summariesPublished: false, humanReviewComplete: false, aiReviewComplete: false }),
    evidence: completeStatus('2026-09-13_2026-09-19'),
  }]);
  const run = buildRunsPayload({ runtimeRoot, repoRoot }).runs[0];
  assert.equal(run.statusSource, 'runtime/faq-analysis');
  assert.equal(run.status, 'IN_PROGRESS');
});

// 取不到就灰，而且要带理由（reasonCode）。0 行必须带 reasonCode 是本项目的既有纪律。
test('an unreadable or missing snapshot becomes a grey block with a reason code', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'opconsole-'));
  const runtimeRoot = resolve(root, 'runtime');
  mkdirSync(resolve(runtimeRoot, 'faq-analysis', '2026-09-13_2026-09-19'), { recursive: true });
  const payload = buildRunsPayload({ runtimeRoot, repoRoot: root });
  assert.equal(payload.runs.length, 1);
  assert.equal(payload.runs[0].available, false);
  assert.equal(payload.runs[0].reasonCode, 'NO_STATUS_FILE_IN_PERIOD_DIR');
  assert.ok(payload.runs[0].reason.length > 0);
  assert.equal(payload.runs[0].statusSource, null);
  // 文件不存在时也必须给出「本来该读哪个文件」：只说「取不到」而不说去哪儿找，
  // 运营没法自查 —— 这正是灰块与「真没问题」的区别。
  assert.equal(payload.runs[0].lookedFor, 'runtime/faq-analysis/2026-09-13_2026-09-19/operator-status.json');
  // 没有任何周期记录时也不许崩，defaultPeriod 为 null 让界面显示空态。
  const emptyRoot = mkdtempSync(resolve(tmpdir(), 'opconsole-'));
  const empty = buildRunsPayload({ runtimeRoot: resolve(emptyRoot, 'runtime'), repoRoot: emptyRoot });
  assert.deepEqual(empty.runs, []);
  assert.equal(empty.defaultPeriod, null);
});

test('a self-contradicting snapshot is reported instead of crashing the console', () => {
  const { runtimeRoot, repoRoot } = fakeLayout([{
    period: '2026-09-13_2026-09-19',
    // 后置阶段完成、前置未完成 —— 状态机会抛错，界面必须把它降级成一整块灰 + 理由。
    status: { period: '2026-09-13_2026-09-19', manifestLocked: false, localSnapshotBuilt: true, checkedAt: new Date().toISOString() },
  }]);
  const run = buildRunsPayload({ runtimeRoot, repoRoot }).runs[0];
  assert.equal(run.available, false);
  assert.equal(run.reasonCode, 'STATUS_FILE_INCONSISTENT');
  assert.equal(run.sourcePath, 'runtime/faq-analysis/2026-09-13_2026-09-19/operator-status.json');
});

test('a completed period is never flagged as a stale snapshot', () => {
  // DONE 的周期不存在「快照过期」这个问题：没有在跑的东西，快照旧是正常的。
  // 对它发脾气会让运营每周都看到一次无意义的黄字警告。
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const { runtimeRoot, repoRoot } = fakeLayout([{ period: '2026-09-13_2026-09-19', status: completeStatus('2026-09-13_2026-09-19', { checkedAt: old }) }]);
  const run = buildRunsPayload({ runtimeRoot, repoRoot }).runs[0];
  assert.equal(run.status, 'DONE');
  assert.equal(run.stale, false);
  assert.ok(run.ageMs > 4 * 24 * 3600 * 1000);
});

test('an unfinished run whose snapshot is old is flagged stale', () => {
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { runtimeRoot, repoRoot } = fakeLayout([{
    period: '2026-09-13_2026-09-19',
    status: completeStatus('2026-09-13_2026-09-19', { summariesPublished: false, checkedAt: old }),
  }]);
  const run = buildRunsPayload({ runtimeRoot, repoRoot }).runs[0];
  assert.equal(run.status, 'IN_PROGRESS');
  assert.equal(run.stale, true);
});

test('payload declares which chains have a stage list and which do not', () => {
  const payload = buildRunsPayload({ runtimeRoot: resolve(tmpdir(), 'nope-runtime'), repoRoot: resolve(tmpdir(), 'nope-repo') });
  assert.deepEqual(payload.availableChains.map((chain) => chain.key), ['faq']);
  assert.equal(payload.availableChains[0].stageList, true);
  // 其它链不许编阶段清单：必须显式说明缺什么，而不是画一条假的进度条。
  assert.deepEqual(payload.missingChains.map((chain) => chain.key), ['dailyReport', 'weekly', 'competitor']);
  for (const chain of payload.missingChains) assert.ok(chain.reason.length > 0);
});
