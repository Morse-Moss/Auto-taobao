// 排期模块的单测：本仓库对排期的核心诉求是「周期算对」和「配置错了不许开跑」。
//
// 三个最容易错、因此单独钉住的地方：
//   1. **周期口径**：竞品周表的周期是「周日~周六」，触发在周一 → 跑的是**上一周**。
//      算错一周不会报错，只会安静地写错数据，所以这里用真实日期逐条对齐。
//   2. **幂等键必须随周期变**：配置里写死一个键，等于「跑过一次就永远不再跑」。
//      validateSchedule 直接拒绝这种写法。
//   3. **停用的条目也要能算出窗口**：运营看计划时要看到「启用后会怎么跑」，
//      一片 null 会被读成「没配」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_CHECK_KEYS,
  PERIOD_KINDS,
  ROUND_SCHEDULE_VERSION,
  WHEN_KINDS,
  dateKey,
  describeSchedule,
  evaluateSchedule,
  findRound,
  parseScheduleJson,
  planSchedule,
  renderBusinessKey,
  resolvePeriod,
  serveRounds,
  tickRounds,
  validateSchedule,
} from './round-schedule.mjs';

const BASE_IDENTITY = Object.freeze({
  tenantId: 'sycm',
  storeId: 'bathtub-industry',
  platform: 'sycm',
  accountId: 'operator',
  browserProfileId: 'local',
  contractVersion: 'sycm-weekly-v1',
});

const entry = (overrides = {}) => ({
  name: 'weekly-competitor',
  enabled: true,
  capability: 'sycm.feishu.weekly',
  when: { kind: 'weekly', weekday: 'MO', at: '09:00' },
  period: { kind: 'PREVIOUS_WEEK_SUN_SAT' },
  identity: { ...BASE_IDENTITY },
  ...overrides,
});

const scheduleOf = (rounds) => ({ version: ROUND_SCHEDULE_VERSION, rounds });
const at = (iso) => new Date(iso).valueOf();

// ── 周期口径 ────────────────────────────────────────────────────────────────

test('the weekly competitor period is the finished Sunday-to-Saturday week', () => {
  // 2026-09-14 是周一，2026-09-15 是周二。
  const monday = new Date('2026-09-14T09:00:00+08:00');
  const decided = evaluateSchedule(entry(), at('2026-09-14T09:00:00+08:00'));
  assert.equal(decided.windowKey, '2026-09-06~2026-09-12');
  assert.equal(decided.period.startDate, '2026-09-06');
  assert.equal(decided.period.endDate, '2026-09-12');
  // 周日是周首：那一天自己属于「本周」。
  assert.equal(dateKey(new Date('2026-09-06T00:00:00+08:00')), '2026-09-06');
  assert.equal(new Date('2026-09-06T00:00:00+08:00').getDay(), 0);
  assert.equal(monday.getDay(), 1);

  // 同一周的周二（机器那天才开机）补跑，仍然是上一周那一份，不会漂移。
  const tuesday = evaluateSchedule(entry(), at('2026-09-15T12:00:00+08:00'));
  assert.equal(tuesday.windowKey, decided.windowKey);
  assert.equal(tuesday.businessKey, decided.businessKey);
});

test('period kinds cover the project vocabulary and clamp to real calendar dates', () => {
  assert.deepEqual([...PERIOD_KINDS], ['TODAY', 'YESTERDAY', 'PREVIOUS_WEEK_SUN_SAT', 'CURRENT_WEEK_SUN_SAT', 'PREVIOUS_MONTH']);
  assert.deepEqual([...WHEN_KINDS], ['daily', 'weekly', 'monthly']);

  const trigger = new Date('2026-09-15T09:00:00+08:00');
  assert.equal(resolvePeriod({ kind: 'TODAY' }, trigger).label, '2026-09-15~2026-09-15');
  assert.equal(resolvePeriod({ kind: 'YESTERDAY' }, trigger).label, '2026-09-14~2026-09-14');
  assert.equal(resolvePeriod({ kind: 'CURRENT_WEEK_SUN_SAT' }, trigger).label, '2026-09-13~2026-09-19');
  assert.equal(resolvePeriod({ kind: 'PREVIOUS_MONTH' }, trigger).label, '2026-08-01~2026-08-31');
  // 2 月的上一个月必须落在 1 月 31 天，而不是「31 号」这种不存在的日期。
  assert.equal(resolvePeriod({ kind: 'PREVIOUS_MONTH' }, new Date('2026-03-15T09:00:00+08:00')).label, '2026-02-01~2026-02-28');
  assert.throws(() => resolvePeriod({ kind: 'NOPE' }, trigger), /unknown period kind/);
});

test('monthly schedules clamp to the last day of a short month', () => {
  const monthly = entry({ when: { kind: 'monthly', dayOfMonth: 31, at: '08:00' }, period: { kind: 'TODAY' } });
  const february = evaluateSchedule(monthly, at('2026-02-28T12:00:00+08:00'));
  assert.equal(february.triggerAt, new Date('2026-02-28T08:00:00+08:00').toISOString());
  assert.equal(february.due, true);
  // 下一个月回到 31 号（3 月有 31 天）。
  assert.equal(dateKey(new Date(february.nextTriggerAt)), '2026-03-31');
});

// ── 到点判定 ────────────────────────────────────────────────────────────────

test('a weekly round is not due before its trigger time', () => {
  const before = evaluateSchedule(entry(), at('2026-09-14T08:59:00+08:00'));
  assert.equal(before.due, false);
  assert.equal(before.reason, 'NOT_DUE');
  // 那一刻的最近一次触发是**上一周**的周一，窗口随之变化。
  assert.equal(before.windowKey, '2026-08-30~2026-09-05');

  const at9 = evaluateSchedule(entry(), at('2026-09-14T09:00:00+08:00'));
  assert.equal(at9.due, true);
  assert.equal(at9.reason, 'DUE');
});

test('a daily round is due on the day and rolls to the next day', () => {
  const daily = entry({ when: { kind: 'daily', at: '07:30' }, period: { kind: 'YESTERDAY' } });
  const morning = evaluateSchedule(daily, at('2026-09-15T07:31:00+08:00'));
  assert.equal(morning.due, true);
  assert.equal(morning.windowKey, '2026-09-14~2026-09-14');
  const early = evaluateSchedule(daily, at('2026-09-15T07:00:00+08:00'));
  assert.equal(early.due, false);
  assert.equal(early.windowKey, '2026-09-13~2026-09-13');
  assert.equal(dateKey(new Date(morning.nextTriggerAt)), '2026-09-16');
});

test('a round does not become due just because its last trigger is long past', () => {
  // 这是刚修掉的那个缺陷的**正向形式**：曾经 due 被算成 `now >= 最近一次触发时刻`，
  // 而「最近一次触发」永远在过去 → 第一次触发之后 due 恒为真 → 每条排期每醒一次就跑一遍。
  // 它不报错、不失败，只是安静地重复干活，所以必须直接把「多久算久」钉死。
  const stale = [
    '2026-09-15T09:01:00+08:00', // 周二，刚过一分钟
    '2026-09-16T09:00:00+08:00', // 周三
    '2026-10-14T09:00:00+08:00', // 整整一个月后的周三
    '2027-09-14T09:00:00+08:00', // 一年后的周二
  ];
  for (const iso of stale) {
    const decided = evaluateSchedule(entry(), at(iso));
    assert.equal(decided.due, false, `${iso} must not be due`);
    assert.equal(decided.reason, 'NOT_DUE');
    assert.equal(decided.isLastTriggerToday, false);
    // 距上一次触发的时间是**有界**的（周排期最多 7 天），不是单调增长的——
    // 别把「过期越来越久」写进断言：到期口径是「当天那一次」，所以它根本不会越积越久。
    assert.ok(decided.hoursSinceTriggerAt > 0, `${iso} must report a positive staleness`);
    assert.ok(decided.hoursSinceTriggerAt < 24 * 7, `${iso} staleness must stay inside one week`);
  }

  // 反过来：紧接着的两个周一该跑就跑——「只算当天」这条规则不能变成「谁都不跑」。
  for (const iso of ['2026-09-21T09:00:00+08:00', '2026-09-28T09:00:00+08:00']) {
    const decided = evaluateSchedule(entry(), at(iso));
    assert.equal(decided.due, true, `${iso} is a Monday at 09:00 and must be due`);
    assert.equal(decided.hoursSinceTriggerAt, 0);
  }
});

test('the plan exposes how stale the last trigger is, without claiming the round ran', () => {
  const plan = planSchedule(scheduleOf([entry()]), at('2026-09-15T12:00:00+08:00'));
  const row = plan.rows[0];
  assert.equal(row.due, false);
  assert.equal(row.isLastTriggerToday, false);
  assert.equal(row.hoursSinceTriggerAt, 27); // 周一 09:00 → 周二 12:00
  assert.equal(row.nextTriggerAt, new Date('2026-09-21T09:00:00+08:00').toISOString());
  // 排期层**不**声称「上次跑过 / 没跑过」：那要查运行账本，这里连字段都不给。
  // 给了字段就会被读成结论，而「漏跑了」和「跑过了」都不是排期层看得见的事。
  assert.equal(Object.hasOwn(row, 'ran'), false);
  assert.equal(Object.hasOwn(row, 'alreadyDone'), false);
  assert.equal(Object.hasOwn(row, 'missed'), false);
});

test('a disabled round still reports its window and next trigger, but is never due', () => {
  const disabled = entry({ enabled: false });
  const decided = evaluateSchedule(disabled, at('2026-09-14T10:00:00+08:00'));
  assert.equal(decided.due, false);
  assert.equal(decided.enabled, false);
  assert.equal(decided.reason, 'DISABLED');
  assert.equal(decided.windowKey, '2026-09-06~2026-09-12');
  assert.ok(decided.businessKey.endsWith('2026-09-06~2026-09-12'));
});

test('the derived business key changes with the window, so later weeks really do run', () => {
  const week1 = evaluateSchedule(entry(), at('2026-09-14T09:00:00+08:00'));
  const week2 = evaluateSchedule(entry(), at('2026-09-21T09:00:00+08:00'));
  assert.equal(week1.businessKey, 'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12');
  assert.equal(week2.businessKey, 'sycm.feishu.weekly/bathtub-industry/2026-09-13~2026-09-19');
  assert.notEqual(week1.businessKey, week2.businessKey);
  assert.equal(renderBusinessKey(entry({ businessKeyTemplate: 'r/{name}/{periodStart}/{storeId}' }), week1), 'r/weekly-competitor/2026-09-06/bathtub-industry');
});

// ── 多店铺：同一能力 × 多个 storeId（2026-09-17 补）──────────────────────────
//
// 背景：运营日报一共 13 家店，每店一条排期、跑同一个能力。
// 缺了店铺维度，13 条会算出**同一个业务键** → 在同一把键上互相覆盖、互相压制，
// 表现是「配置合法、跑得起来、报成功，只是安静地少跑 12 家」。
// 这一组同时钉两件事：默认模板的形状，以及「手写模板绕过默认值」时那道校验闸。

test('the default business key carries the store, so one capability can run for many shops', () => {
  const first = evaluateSchedule(entry(), at('2026-09-14T09:00:00+08:00'));
  assert.equal(first.businessKey, 'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12');

  const second = evaluateSchedule(
    entry({ name: 'weekly-shop-2', identity: { ...BASE_IDENTITY, storeId: 'bathtub-flagship' } }),
    at('2026-09-14T09:00:00+08:00'),
  );
  assert.notEqual(second.businessKey, first.businessKey);
  assert.equal(second.businessKey, 'sycm.feishu.weekly/bathtub-flagship/2026-09-06~2026-09-12');
});

test('多家店铺共用同一个能力是合法的：三条排期三个键，一个都不许被压掉', () => {
  const schedule = scheduleOf([
    entry(),
    entry({ name: 'weekly-shop-2', identity: { ...BASE_IDENTITY, storeId: 'bathtub-flagship' } }),
    entry({ name: 'weekly-shop-3', identity: { ...BASE_IDENTITY, storeId: 'bathtub-tmall' } }),
  ]);
  const validation = validateSchedule(schedule);
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  const keys = planSchedule(schedule, at('2026-09-15T12:00:00+08:00')).rows.map((row) => row.businessKey);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3);
});

test('手写模板漏掉 {storeId} 而同一能力排了多条 → 拒绝开跑，并点名是哪几条', () => {
  const schedule = scheduleOf([
    entry({ businessKeyTemplate: '{capability}/{windowKey}' }),
    entry({
      name: 'weekly-shop-2',
      businessKeyTemplate: '{capability}/{windowKey}',
      identity: { ...BASE_IDENTITY, storeId: 'bathtub-flagship' },
    }),
  ]);
  const validation = validateSchedule(schedule);
  assert.equal(validation.ok, false);
  const joined = validation.errors.join('\n');
  assert.match(joined, /has no \{storeId\}/);
  assert.match(joined, /weekly-competitor/);
  assert.match(joined, /weekly-shop-2/);
});

test('同一能力下两家店写成同一个 storeId → 拒绝（键照样会撞）', () => {
  const validation = validateSchedule(scheduleOf([entry(), entry({ name: 'weekly-shop-2' })]));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /already has a round for storeId "bathtub-industry"/);
});

test('只有一条排期时，不带 {storeId} 的自定义模板仍然接受（不误伤既有配置）', () => {
  const validation = validateSchedule(
    scheduleOf([entry({ businessKeyTemplate: 'r/{capability}/{windowKey}' })]),
  );
  assert.equal(validation.ok, true, validation.errors.join('\n'));
});

test('the human-readable description says when and which period', () => {
  assert.equal(describeSchedule(entry()), '每周一 09:00，跑上一周（周日~周六）');
  assert.equal(describeSchedule(entry({ when: { kind: 'daily', at: '06:15' }, period: { kind: 'YESTERDAY' } })), '每天 06:15，跑前一天');
  assert.equal(describeSchedule(entry({ when: { kind: 'monthly', dayOfMonth: 1, at: '08:00' }, period: { kind: 'PREVIOUS_MONTH' } })), '每月 1 日 08:00，跑上一个月');
});

// ── 配置校验：错的配置不许开跑 ──────────────────────────────────────────────

test('a valid schedule passes and an invalid one lists every problem', () => {
  assert.equal(validateSchedule(scheduleOf([entry()])).ok, true);
  assert.deepEqual(validateSchedule(scheduleOf([entry()])).errors, []);

  const broken = validateSchedule({
    version: ROUND_SCHEDULE_VERSION,
    rounds: [
      entry({ name: '', when: { kind: 'weekly', at: '25:00' }, capability: null }),
      entry({ name: 'dup' }),
      entry({ name: 'dup' }),
      entry({ name: 'no-identity', identity: { tenantId: 'sycm' } }),
      entry({ name: 'bad-period', period: { kind: 'LAST_TUESDAY' } }),
      entry({ name: 'bad-month', when: { kind: 'monthly', at: '09:00' } }),
      entry({ name: 'fixed-key', businessKeyTemplate: 'weekly-competitor-once' }),
      entry({ name: 'commit-no-operator', commit: true }),
    ],
  });
  assert.equal(broken.ok, false);
  const joined = broken.errors.join('\n');
  assert.match(joined, /name is required/);
  assert.match(joined, /when\.at must look like/);
  assert.match(joined, /capability is required/);
  assert.match(joined, /duplicate round name/);
  assert.match(joined, /identity\.storeId is required/);
  assert.match(joined, /period\.kind must be one of/);
  assert.match(joined, /when\.dayOfMonth must be 1\.\.31/);
  assert.match(joined, /must include \{windowKey\}/);
  assert.match(joined, /operator is required when commit is true/);
});

test('a schedule with no rounds is rejected instead of silently running nothing', () => {
  assert.deepEqual(validateSchedule({ version: ROUND_SCHEDULE_VERSION, rounds: [] }).ok, false);
  assert.deepEqual(validateSchedule(null).ok, false);
  assert.deepEqual(validateSchedule({ version: 'round-schedule-v9', rounds: [entry()] }).errors[0], 'unexpected version: round-schedule-v9 (expected round-schedule-v1)');
});

test('parseScheduleJson reports invalid JSON instead of inventing a schedule', () => {
  assert.equal(parseScheduleJson(JSON.stringify(scheduleOf([entry()]))).ok, true);
  assert.throws(() => parseScheduleJson('  '), /schedule JSON is empty/);
  assert.throws(() => parseScheduleJson('{ not json'), /not valid JSON/);
});

test('the shipped config file is valid and its period matches the real SOP week', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../runtime/round-schedule.json', import.meta.url), 'utf8');
  const parsed = parseScheduleJson(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.ok, true);
  // 这条排期在 2026-09-22 改过名：weekly-competitor → weekly-keyword
  // （原名与它实际借用的能力 `sycm.feishu.weekly` 不符，那个名字是历史遗留）。
  // 改名**不影响业务幂等键**：出厂条目没有 businessKeyTemplate，走默认的
  // `{capability}/{storeId}/{windowKey}`（见 round-schedule.mjs 的 DEFAULT_BUSINESS_KEY_TEMPLATE），
  // 里面没有 {name}。所以这里跟着改的是**期望值**，不是判据口径 —— 若哪天名字又变，
  // 这条会红，那正是想要的效果（改名必须是有意识的行为）。
  const weekly = findRound(parsed.schedule, 'weekly-keyword');
  assert.ok(weekly, 'the shipped schedule must describe the weekly keyword round');
  // 出厂默认必须是停用的：配置文件在版本库里，启用与否是部署决策。
  assert.equal(weekly.enabled, false);
  assert.equal(evaluateSchedule(weekly, at('2026-09-14T09:00:00+08:00')).windowKey, '2026-09-06~2026-09-12');
});

// ── 一次叫醒的行为 ──────────────────────────────────────────────────────────

test('a tick runs only the due rounds and records the waiting ones', async () => {
  const fired = [];
  // 三条排期跑同一个能力 ⇒ 必须分属三家店（一家店一个 storeId）。
  // 这不是为了迁就校验：多店铺就是本仓库的原定路线，同一能力下两条排期**只能**靠 storeId 区分。
  const schedule = scheduleOf([
    entry({ name: 'due-one' }),
    entry({
      name: 'waiting-one',
      when: { kind: 'weekly', weekday: 'FR', at: '09:00' },
      identity: { ...BASE_IDENTITY, storeId: 'shop-fr' },
    }),
    entry({ name: 'off-one', enabled: false, identity: { ...BASE_IDENTITY, storeId: 'shop-off' } }),
  ]);
  const results = await tickRounds({
    schedule,
    nowAt: at('2026-09-14T09:00:00+08:00'),
    runRoundOnce: async (item, decision) => { fired.push({ name: item.name, key: decision.businessKey }); return { outcome: 'COMPLETED' }; },
  });
  assert.deepEqual(fired.map((item) => item.name), ['due-one']);
  assert.deepEqual(results.map((item) => [item.name, item.ran]), [['due-one', true], ['waiting-one', false], ['off-one', false]]);
  assert.equal(results[1].decision.reason, 'NOT_DUE');
  assert.equal(results[2].decision.reason, 'DISABLED');
});

test('an invalid schedule makes a tick fail loudly rather than run a subset', async () => {
  await assert.rejects(
    () => tickRounds({ schedule: scheduleOf([entry({ capability: null })]), nowAt: Date.now(), runRoundOnce: async () => ({}) }),
    /schedule is invalid/,
  );
});

test('the scheduler itself does not dedupe: the same due round is offered every tick', async () => {
  // 去重是**幂等键 + 准入**的职责（同一 businessKey 不会跑第二次），不是排期层的职责。
  // 排期层在这里做去重会掩盖真正的重复（例如两条排期算出同一个键）。
  let ticks = 0;
  const fired = [];
  await serveRounds({
    schedule: scheduleOf([entry()]),
    intervalMs: 1000,
    maxTicks: 3,
    now: () => at('2026-09-14T09:00:00+08:00'),
    sleep: async () => { ticks += 1; },
    runRoundOnce: async (item, decision) => { fired.push(decision.businessKey); return {}; },
  });
  assert.equal(ticks, 2); // 3 ticks = 跑 3 次 + 睡眠 2 次
  assert.deepEqual(fired, [
    'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12',
    'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12',
    'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12',
  ]);
  assert.equal(new Set(fired).size, 1); // 同一周期同一个键 → 下游靠它去重
});

test('the serve loop wakes on the configured interval and reports each tick', async () => {
  const sleeps = [];
  const ticks = [];
  await serveRounds({
    schedule: scheduleOf([entry({ name: 'off', enabled: false })]),
    intervalMs: 15_000,
    maxTicks: 2,
    now: () => at('2026-09-14T09:00:00+08:00'),
    sleep: async (ms) => { sleeps.push(ms); },
    runRoundOnce: async () => { throw new Error('nothing is due, this must not run'); },
    onTick: async ({ tick, results }) => { ticks.push([tick, results[0].ran]); },
  });
  assert.deepEqual(sleeps, [15_000]);
  assert.deepEqual(ticks, [[1, false], [2, false]]);
});

test('the plan lists every round with its next trigger and derived key', () => {
  const plan = planSchedule(
    scheduleOf([
      entry(),
      entry({ name: 'off', enabled: false, identity: { ...BASE_IDENTITY, storeId: 'shop-off' } }),
    ]),
    at('2026-09-15T12:00:00+08:00'),
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.rows[0].due, false); // 周一上午 9:00 已过、下一次是下周一
  assert.equal(dateKey(new Date(plan.rows[0].nextTriggerAt)), '2026-09-21');
  assert.equal(plan.rows[0].businessKey, 'sycm.feishu.weekly/bathtub-industry/2026-09-06~2026-09-12');

  const invalid = planSchedule(scheduleOf([entry({ capability: null })]), Date.now());
  assert.equal(invalid.ok, false);
  assert.equal(invalid.rows.length, 0);
  assert.ok(invalid.errors.length > 0);
});

// ── 体检开关的配置校验（实施计划第 4 步接线）─────────────────────────────────
//
// 为什么要在这里拦：`healthCheck` 写坏的后果不是「报错」，而是**这一轮静默地不做体检**
// （配置层没拦住 → 编排层按「没开」处理）。而「体检没跑」与「体检通过」在收据里长得像。
// 所以形状必须在解析配置时就判掉，且 `--show-plan`（只读、不碰数据库）也要能报出来。

test('healthCheck 不写 / false / null 一律合法，且等于「不体检」', () => {
  for (const value of [undefined, false, null]) {
    const result = validateSchedule(scheduleOf([value === undefined ? entry() : entry({ healthCheck: value })]));
    assert.equal(result.ok, true, `${String(value)} 应当合法：${result.errors.join('; ')}`);
  }
});

test('healthCheck 的合法写法：true / {} / { browser } / { pages } / 两者都给', () => {
  for (const value of [true, {}, { browser: 'dailyReport' }, { pages: true }, { browser: 'dailyReport', pages: true }]) {
    const result = validateSchedule(scheduleOf([entry({ healthCheck: value })]));
    assert.equal(result.ok, true, `${JSON.stringify(value)} 应当合法：${result.errors.join('; ')}`);
  }
});

test('healthCheck 写坏了要在配置解析时就报出来（否则表现为「体检长期静默地没开」）', () => {
  const cases = [
    ['字符串', 'yes', /must be true\/false or an object/u],
    ['数组', [], /must be true\/false or an object/u],
    ['未知键（打错字）', { browsr: 'dailyReport' }, /unknown key/u],
    ['pages 不是布尔', { pages: 'yes' }, /pages must be a boolean/u],
    ['browser 是空串', { browser: '   ' }, /browser must be a non-empty string/u],
  ];
  for (const [label, value, pattern] of cases) {
    const result = validateSchedule(scheduleOf([entry({ healthCheck: value })]));
    assert.equal(result.ok, false, `${label} 应当被拒`);
    assert.match(result.errors.join('; '), pattern, label);
  }
});

test('允许的键名清单只有一处来源（排期层），编排层引用它而不是另抄一份', () => {
  // 这条是防「两处键名清单各自漂移」：加一个键却只改了一边，会出现
  // 「校验放过、接线不认」的静默组合。清单本身归排期层（校验在这里跑）。
  assert.deepEqual([...HEALTH_CHECK_KEYS], ['browser', 'pages']);
});
