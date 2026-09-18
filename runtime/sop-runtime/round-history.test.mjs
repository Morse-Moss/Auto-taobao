// 轮次历史（只追加账本）的单测。
//
// 这个模块的唯一目的是让「这种麻烦多久来一次」有一个**能被复核**的数字（见 round-history.mjs
// 文件头）。所以本文件的重点不是「代码跑通了」，而是三条容易悄悄失真的地方：
//   1. **分母**：哪些轮次该进账本。少记一类，「频率」就偏低，而偏低正好会让人做出「不必做」的错决定。
//   2. **分子**：同一问题持续中的轮次（被去重）不许重复计数，否则一次登录失效会被数成几十次。
//   3. **坏账本**：读少一行不许静默 —— 它同样让频率偏低。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HISTORY_FILE,
  HISTORY_SKIP_OUTCOMES,
  ROUND_HISTORY_FIELDS,
  buildHistoryEntry,
  createFileRoundHistory,
  createMemoryRoundHistory,
  parseHistoryText,
  renderHistoryReport,
  shouldRecord,
  summarizeHistory,
} from './round-history.mjs';
import { main as reportMain, parseReportArgs, REPORT_USAGE } from './round-history-report.mjs';

const AT = '2026-09-15T01:00:00.000Z';
const NOW = Date.parse('2026-09-18T00:00:00.000Z');

const entry = (over = {}) => buildHistoryEntry({
  at: AT,
  dayKey: '2026-09-15',
  outcome: 'FAILED',
  reason: 'LOGIN_REQUIRED',
  businessKey: 'sycm.alimama.daily/店A/2026-09-15',
  capability: 'sycm.alimama.daily',
  source: { storeId: '店A', shopName: '浴缸A店', machine: 'DEPLOY-01', browserProfile: 'daily' },
  notification: { status: 'SENT', action: 'SEND', alertId: 'round-店A-20260915T090000' },
  health: { status: 'OK' },
  ...over,
});

// ── 写什么：口径 ────────────────────────────────────────────────────────────

test('只有「没过到期闸门」的轮次不进账本；其余都必须进（分母不许偏小）', () => {
  assert.deepEqual([...HISTORY_SKIP_OUTCOMES], ['SKIPPED_NOT_DUE', 'SKIPPED_ALREADY_DONE']);
  for (const outcome of HISTORY_SKIP_OUTCOMES) {
    assert.equal(shouldRecord({ outcome }), false, outcome);
  }
  // 这几个是分母的核心：它们正是「这一轮真的打算干活、但没干成」。
  for (const outcome of ['BLOCKED_BY_HEALTH', 'PAUSED_FOR_HUMAN', 'COMPLETED', 'COMPLETED_WITH_HEAL', 'FAILED', 'ERROR', 'SKIPPED_EMPTY_QUEUE']) {
    assert.equal(shouldRecord({ outcome }), true, outcome);
  }
});

test('needs 在**写入时**定稿：判定表的结论随行落盘，不靠事后现查', () => {
  const line = entry();
  assert.equal(line.version, 'round-history-v1');
  assert.equal(line.needs, 'ONSITE');
  assert.equal(line.needsKnown, true);
  assert.equal(line.storeId, '店A');
  assert.equal(line.shopName, '浴缸A店');
  assert.equal(line.machine, 'DEPLOY-01');
  assert.equal(line.browserProfile, 'daily');
  assert.equal(line.alertId, 'round-店A-20260915T090000');
  assert.equal(line.healthStatus, 'OK');
  // 行契约不许漂：字段清单与产出的键必须一一对上。
  assert.deepEqual(Object.keys(line).sort(), [...ROUND_HISTORY_FIELDS].sort());
});

test('判定表里没有的理由要显式标成「未登记」，不许安静落进「未细分」', () => {
  const unknown = entry({ reason: 'A_KEY_THAT_NOBODY_REGISTERED' });
  assert.equal(unknown.needsKnown, false);
  assert.equal(unknown.needs, null);
  const actionOnly = entry({ reason: 'BUDGET_EXHAUSTED' });
  assert.equal(actionOnly.needsKnown, true, '「升级」这个动作本身是登记过的理由');
  assert.equal(actionOnly.needs, null, '它只是没细分到具体经手人');
  const none = entry({ reason: null });
  assert.equal(none.needsKnown, false);
  assert.equal(none.needs, null);
});

test('账本里不留自由文本；通知失败原文要过凭据遮盖并截断', () => {
  const leaky = entry({
    notification: {
      status: 'FAILED',
      action: 'SEND',
      alertId: 'round-x',
      error: `connect failed cli_abcdefgh12345678 token=0123456789abcdef0123456789abcdef ${'x'.repeat(400)}`,
    },
  });
  assert.doesNotMatch(leaky.notifyError, /cli_abcdefgh12345678/u);
  assert.doesNotMatch(leaky.notifyError, /0123456789abcdef0123456789abcdef/u);
  assert.ok(leaky.notifyError.length <= 200, '失败原文要截断：它会进诊断包');
});

// ── 落点：只追加 ────────────────────────────────────────────────────────────

test('文件落点是 JSONL，且只追加（第二行进来不许重写第一行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-history-'));
  const file = join(dir, 'nested', 'round-history.jsonl');
  const port = createFileRoundHistory(file);
  assert.equal(port.file, join(dir, 'nested', 'round-history.jsonl'));

  await port.append(entry());
  const first = readFileSync(file, 'utf8');
  await port.append(entry({ at: '2026-09-16T01:00:00.000Z', dayKey: '2026-09-16', reason: 'PLATFORM_CONTROL' }));

  const after = readFileSync(file, 'utf8');
  assert.ok(after.startsWith(first), '追加不该改动已有内容');
  assert.equal(after.split('\n').filter(Boolean).length, 2);
  const { entries, corrupted } = await port.read();
  assert.equal(corrupted.length, 0);
  assert.deepEqual(entries.map((item) => item.reason), ['LOGIN_REQUIRED', 'PLATFORM_CONTROL']);
});

test('读不存在/空文件 ⇒ 空账本，不是错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-history-'));
  const { entries, corrupted } = await createFileRoundHistory(join(dir, 'nope.jsonl')).read();
  assert.deepEqual(entries, []);
  assert.deepEqual(corrupted, []);
});

test('坏行不许静默：要数出来并给出行号', () => {
  const { entries, corrupted } = parseHistoryText('{"a":1}\n\nnot json\n[1,2]\n{"b":2}\n');
  assert.deepEqual(entries, [{ a: 1 }, { b: 2 }]);
  assert.equal(corrupted.length, 2);
  assert.deepEqual(corrupted.map((item) => item.line), [3, 4]);
  for (const item of corrupted) assert.equal(typeof item.reason, 'string');
});

// ── 统计：分子分母的口径 ────────────────────────────────────────────────────

test('同一问题持续中（DEDUPED）不算一次新发生，但必须单列出来', () => {
  const lines = [
    entry(),
    entry({ at: '2026-09-15T02:00:00.000Z', notification: { status: 'DEDUPED', action: 'DEDUPED', alertId: 'round-店A-20260915T090000' } }),
    entry({ at: '2026-09-15T03:00:00.000Z', notification: { status: 'DEDUPED', action: 'DEDUPED', alertId: 'round-店A-20260915T090000' } }),
  ];
  const summary = summarizeHistory(lines, { now: NOW, days: 30 });
  assert.equal(summary.traced, 3);
  assert.equal(summary.events.total, 1, '一次登录失效 + 两次去重 = 一次新发生');
  assert.equal(summary.events.ONSITE, 1);
  assert.equal(summary.continuing.total, 2);
  assert.equal(summary.continuing.ONSITE, 2);
});

test('未细分 / 未登记 / 各经手人分桶，且按天、按店给出分布', () => {
  const lines = [
    entry(),
    entry({ at: '2026-09-16T01:00:00.000Z', dayKey: '2026-09-16', reason: 'EGRESS_PROXY_UNREACHABLE' }),
    entry({ at: '2026-09-17T01:00:00.000Z', dayKey: '2026-09-17', reason: 'COMMIT_UNKNOWN', source: { storeId: '店B', machine: 'DEPLOY-02' } }),
    entry({ at: '2026-09-17T02:00:00.000Z', dayKey: '2026-09-17', reason: 'BUDGET_EXHAUSTED', source: {} }),
    entry({ at: '2026-09-17T03:00:00.000Z', dayKey: '2026-09-17', reason: 'A_KEY_THAT_NOBODY_REGISTERED' }),
  ];
  const summary = summarizeHistory(lines, { now: NOW, days: 30 });
  assert.equal(summary.events.total, 5);
  assert.equal(summary.events.ONSITE, 2);
  assert.equal(summary.events.RECONCILE, 1);
  assert.equal(summary.events.UNSPECIFIED, 1, 'BUDGET_EXHAUSTED 是登记过的「未细分」');
  assert.equal(summary.events.UNCLASSIFIED, 1, '未登记的理由要单独一桶，否则漏登记会藏在「其它」里');
  assert.deepEqual(summary.byDay.map((day) => [day.dayKey, day.traced, day.onsite]), [
    ['2026-09-15', 1, 1], ['2026-09-16', 1, 1], ['2026-09-17', 3, 0],
  ]);
  const stores = summary.byStore.map((store) => `${store.storeId}:${store.events}`);
  // 没标注店铺的条目要能自己占一行，不许被并进某个店（并进去等于把「漏填店铺」藏起来）。
  assert.deepEqual(stores.sort(), ['(未标注店铺):1', '店A:3', '店B:1'].sort());
  assert.deepEqual(summary.byMachine.map((item) => item.machine).sort(), ['(未标注机器)', 'DEPLOY-01', 'DEPLOY-02']);
  assert.equal(summary.byReason[0].reason, 'A_KEY_THAT_NOBODY_REGISTERED');
  assert.equal(summary.byReason.find((item) => item.reason === 'LOGIN_REQUIRED').title, '插件或平台登录已失效');
});

test('「本该通知人却没送出去」按动作判定：恢复通知没送出去不算这一类', () => {
  const lines = [
    entry({ notification: { status: 'FAILED', action: 'SEND', error: 'boom' } }),
    entry({ at: '2026-09-16T01:00:00.000Z', notification: { status: 'NOT_CONFIGURED', action: 'SEND' } }),
    entry({ at: '2026-09-17T01:00:00.000Z', reason: 'SUCCESS', notification: { status: 'NOT_CONFIGURED', action: 'RESOLVE' } }),
  ];
  const summary = summarizeHistory(lines, { now: NOW, days: 30 });
  assert.deepEqual(summary.undelivered, { FAILED: 1, NOT_CONFIGURED: 1, total: 2 });
});

test('窗口外与时间解析不出来的条目都要报出来，不许安静丢掉', () => {
  const lines = [
    entry(),
    entry({ at: '2026-01-01T00:00:00.000Z', dayKey: '2026-01-01' }),
    entry({ at: null }),
  ];
  const summary = summarizeHistory(lines, { now: NOW, days: 30 });
  assert.equal(summary.traced, 1);
  assert.equal(summary.outsideWindow, 1);
  assert.equal(summary.undated, 1);
});

test('空账本：不报错，且报告必须说清「无法回填」', () => {
  const summary = summarizeHistory([], { now: NOW, days: 7 });
  assert.equal(summary.traced, 0);
  assert.equal(summary.last, null);
  const report = renderHistoryReport(summary, { file: DEFAULT_HISTORY_FILE });
  assert.match(report, /最近 7 天/u);
  assert.match(report, /无法回填/u);
});

// ── 报告 ────────────────────────────────────────────────────────────────────

test('人话报告要给出「需要人到现场」的次数、占比，并在有坏行时点名', () => {
  const summary = summarizeHistory([entry(), entry({ at: '2026-09-16T01:00:00.000Z', dayKey: '2026-09-16', reason: 'COMMIT_UNKNOWN' })], { now: NOW, days: 30 });
  const report = renderHistoryReport(summary, { file: 'runtime/.round-history.jsonl', corrupted: [{ line: 7, reason: 'boom' }] });
  assert.match(report, /需要人到现场（ONSITE）：1 次新发生，涉及 1 天/u);
  assert.match(report, /需要人到现场占 50\.0%/u);
  assert.match(report, /2026-09-15：轮次 1，打扰 1，其中需要人到现场 1/u);
  assert.match(report, /2026-09-16：轮次 1，打扰 1，其中需要人到现场 0/u);
  assert.match(report, /坏行：1 条（行号 7）/u);
  assert.match(report, /LOGIN_REQUIRED（插件或平台登录已失效｜ONSITE）/u);
});

// ── 读取端 CLI ──────────────────────────────────────────────────────────────

const capture = () => {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
};

test('CLI：--help / 参数写错 / 天数不是正数 都要给出人话与退出码', async () => {
  const sink = capture();
  assert.equal(await reportMain(['--help'], sink), 0);
  assert.match(sink.text(), /--days <n>/u);
  assert.match(REPORT_USAGE, /--json/u);

  const bad = capture();
  assert.equal(await reportMain(['--nope'], bad), 2);
  assert.match(bad.text(), /Unknown argument: --nope/u);

  const badDays = capture();
  assert.equal(await reportMain(['--days', 'abc'], badDays), 2);
  assert.match(badDays.text(), /--days must be a positive number/u);

  const badNow = capture();
  assert.equal(await reportMain(['--now', 'not-a-time'], badNow), 2);
});

test('CLI：--json 输出结构化结果；有坏行时退出码 1（历史被读少会让频率偏低）', async () => {
  const text = `${JSON.stringify(entry())}\nnope\n`;
  const sink = capture();
  assert.equal(await reportMain(['--json', '--days', '30', '--now', '2026-09-18T00:00:00.000Z'], { ...sink, readText: () => text }), 1);
  const parsed = JSON.parse(sink.text());
  assert.equal(parsed.traced, 1);
  assert.equal(parsed.events.ONSITE, 1);
  assert.equal(parsed.corrupted.length, 1);
  assert.equal(parsed.missing, false);

  const clean = capture();
  assert.equal(await reportMain(['--json'], { ...clean, readText: () => `${JSON.stringify(entry())}\n` }), 0);
  assert.equal(JSON.parse(clean.text()).corrupted.length, 0);
});

test('CLI：文件不存在与文件为空要分开说（前者是配置问题，后者是还没跑过）', async () => {
  const missing = capture();
  const code = await reportMain(['--file', join(tmpdir(), 'definitely-not-here-9f8a', 'x.jsonl')], missing);
  assert.equal(code, 0, '空账本不是错误');
  assert.match(missing.text(), /历史文件还不存在/u);
  assert.match(missing.text(), /从没在这台机器上跑过/u);
});

test('CLI：--file 指向真实文件时能读回来（含写入 → 读回一整圈）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-history-'));
  const file = join(dir, 'round-history.jsonl');
  writeFileSync(file, `${JSON.stringify(entry())}\n`, 'utf8');
  const sink = capture();
  assert.equal(await reportMain(['--file', file, '--days', '30', '--now', '2026-09-18T00:00:00.000Z'], sink), 0);
  assert.match(sink.text(), /需要人到现场（ONSITE）：1 次/u);
  assert.match(sink.text(), /文件：/u);
});

test('parseReportArgs 只认自己声明的键，未知参数直接报错', () => {
  assert.deepEqual(parseReportArgs([]), { days: 30, file: null, json: false, now: null, help: false });
  assert.equal(parseReportArgs(['--days', '7']).days, 7);
  assert.throws(() => parseReportArgs(['--days']), /requires a value/u);
  assert.throws(() => parseReportArgs(['positional']), /Unknown argument/u);
});
