// 「驻留 → 判据转正 → 只补失败店自动续跑」的离线判据。
//
// 为什么这一层值得这么密的用例：这一层每一条判据判错的代价都不是「难看」，而是
//   · 判错方向 A（把不需要人的算成需要人）⇒ **每天早上把机器白挂几小时**，而且没人看得出来；
//   · 判错方向 B（把需要人的算成不需要人）⇒ 人赶到机器前，窗口已经被收走
//     （2026-09-25 与 09-26 连着两天都是这一种）；
//   · 判错「读不到」⇒ 拿着一个还堵着的现场去写飞书（本项目最贵的一类错误）。
// 所以这里逐条钉住：要不要驻留、驻留到几点、多久问一次、从哪一步重跑、以及
// **两条通知的字段名必须落在渲染白名单里**（否则那一行会被静默吞掉，本地看着对、飞书里少一行）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { READABLE_SOURCE_KEYS } from './notify-feishu-core.mjs';
import { HOLD_EXIT, buildHoldResumeArgs, buildJobPlan, shouldRunStep } from './daily-job-plan.mjs';
import {
  DEFAULT_HOLD_UNTIL, DEFAULT_POLL_SECONDS, POLL_SECONDS_BY_CAUSE, PROBE_STATES, RESUME_FLOOR_BY_CAUSE,
  buildResumeArgv, closeOutNotice, deadlineReached, holdDecision, holdStatusLine, judgeProbes,
  minutesOfDay, parseClock, pollSecondsFor, resumeFloorFor, resumeResultNotice, resumeStageListFrom,
} from './hold-and-resume-plan.mjs';
import { failedShopsOf, parseArgs as parseHoldArgs } from '../scripts/hold-and-resume.mjs';

const STAGES = ['health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report',
  'promotion-fetch', 'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback'];

// ---------------------------------------------------------------------------
// 什么时候结束（到点判据）
// ---------------------------------------------------------------------------
test('截止时间：只认 HH:MM，格式不对**不回落**（回落成 0 会让驻留立刻结束）', () => {
  assert.deepEqual(parseClock('12:00'), { ok: true, minutes: 720 });
  assert.deepEqual(parseClock(' 9:05 '), { ok: true, minutes: 545 });
  assert.deepEqual(parseClock('00:00'), { ok: true, minutes: 0 });
  for (const bad of ['12', '12:0', '24:00', '12:60', '', null, undefined, 'noon']) {
    assert.equal(parseClock(bad).ok, false, `${JSON.stringify(bad)} 应当被拒`);
    assert.ok(parseClock(bad).error, '拒的时候要给一句人话');
  }
  assert.equal(DEFAULT_HOLD_UNTIL, '12:00');
});

test('到点判据：`>=` 而不是 `>`（正好那一刻就该收尾，不许再多挂一轮）', () => {
  assert.equal(deadlineReached({ nowMinutes: 719, untilMinutes: 720 }), false);
  assert.equal(deadlineReached({ nowMinutes: 720, untilMinutes: 720 }), true);
  assert.equal(deadlineReached({ nowMinutes: 721, untilMinutes: 720 }), true);
  // 分钟数与本地时钟同一把尺子（`parseClock('12:00').minutes` 与它比才有意义）。
  const noon = new Date(2026, 8, 26, 12, 0, 0);
  assert.equal(minutesOfDay(noon), 720);
  assert.equal(deadlineReached({ nowMinutes: minutesOfDay(noon), untilMinutes: parseClock('12:00').minutes }), true);
});

// ---------------------------------------------------------------------------
// 要不要驻留（这一条判错＝白挂几小时，或者人到场时窗口没了）
// ---------------------------------------------------------------------------
test('不需要人时**绝不驻留**：默认行为必须与从前逐字相同', () => {
  // 不给 humanCauses ⇒ 当空集。这是「新能力默认关」在纯函数这一层的落点。
  assert.equal(holdDecision({}).needed, false);
  assert.equal(holdDecision({ failed: [{ shop: '科塔淘宝', cause: 'STAGE_FAILED', stage: 'push' }] }).needed, false);
  assert.equal(holdDecision({ failed: [{ shop: '科塔淘宝', cause: 'SHOP_FUNC_NO_PERMISSION' }] }).needed, false);
  assert.equal(holdDecision({ failed: [{ shop: '科塔淘宝', cause: 'DUPLICATE_TARGET' }] }).needed, false);
  // `SHOP_FUNC_NO_PERMISSION` 刻意不算「要人」：要去生意参谋找订购，不是浏览器里的事。
  assert.equal(holdDecision({ failed: [{ shop: 'A', cause: 'SHOP_FUNC_NO_PERMISSION' }],
    humanCauses: ['NEEDS_LOGIN', 'PAGE_OBSTRUCTED'] }).needed, false);
});

test('需要人时：点名那几家，且续跑**只补那几家**（整轮重跑会撞同一天+同店铺的查重键）', () => {
  const decision = holdDecision({
    failed: [
      { shop: '科塔淘宝', cause: 'PAGE_OBSTRUCTED', stage: 'promotion-submit' },
      { shop: '网林天猫', cause: 'STAGE_FAILED', stage: 'promotion-fetch' },
      { shop: '盖文天猫', cause: 'NEEDS_LOGIN', stage: 'sycm-date' },
    ],
    humanCauses: ['NEEDS_LOGIN', 'PAGE_OBSTRUCTED'],
  });
  assert.equal(decision.needed, true);
  assert.equal(decision.roundLevel, false);
  assert.deepEqual(decision.subjects, ['科塔淘宝', '盖文天猫'], '只点名「只有人能解除」的那几家');
  assert.deepEqual(decision.resumeShops, ['科塔淘宝', '盖文天猫']);
  assert.deepEqual(decision.causes, ['PAGE_OBSTRUCTED', 'NEEDS_LOGIN'], '成因去重且保持出现顺序');
});

test('整轮被挡**一律算需要人**，且**不能点名**（不给 --shops 就是整轮重跑）', () => {
  // 能挡住整轮的只有两种成因 —— 商家浏览器掉登录（09-25 现场）与页面真的缺（09-22 现场）——
  // 两种都只有人能解除。它不受 humanCauses 管：那是个**逐店**词表，用在这里会漏掉
  // 「一家都没跑起来」的那一轮。
  const decision = holdDecision({ failed: [], roundBlocked: true, roundCause: 'NEEDS_LOGIN', humanCauses: [] });
  assert.equal(decision.needed, true);
  assert.equal(decision.roundLevel, true);
  assert.deepEqual(decision.causes, ['NEEDS_LOGIN']);
  assert.equal(decision.resumeShops, null, '整轮被挡时没有「已写过的那几家」，不能假装点名');
});

test('轮询间隔按成因分：取**最勤**的那个（多成因时以最敏感的那条判据为准）', () => {
  assert.equal(pollSecondsFor(['PAGE_OBSTRUCTED']), 30, '广告那条是只读 DOM 查询：便宜，可以问得勤');
  assert.equal(pollSecondsFor(['NEEDS_LOGIN']), 120, '登录那条要连平台读页面：慢一点，本身就是风控面');
  assert.equal(pollSecondsFor(['PAGE_OBSTRUCTED', 'NEEDS_LOGIN']), 30);
  assert.equal(pollSecondsFor([]), DEFAULT_POLL_SECONDS, '没有成因时给一个保守的默认值');
  assert.equal(pollSecondsFor(['UNKNOWN_CAUSE']), DEFAULT_POLL_SECONDS, '认不出来的成因不许当成 0 或 undefined');
  assert.equal(POLL_SECONDS_BY_CAUSE.ROUND_BLOCKED, 120);
});

// ---------------------------------------------------------------------------
// 重跑哪几步（这一条判错＝漏跑一段，而漏跑一段的续跑看起来与成功一模一样）
// ---------------------------------------------------------------------------
test('续跑起点：从失败那一步跑到结尾，且 **health-check 永远带上**', () => {
  assert.deepEqual(resumeStageListFrom(['push'], STAGES),
    ['health-check', 'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback']);
  // 人刚动过浏览器 ⇒ 页签与端口必须重新体检过才敢往下写。
  assert.equal(resumeStageListFrom(['promotion-submit'], STAGES)[0], 'health-check');
  // 多店合并＝后缀的并集还是后缀 ⇒ 取**最早**那处。
  assert.deepEqual(resumeStageListFrom(['push', 'promotion-submit'], STAGES),
    resumeStageListFrom(['promotion-submit'], STAGES));
});

test('认不出阶段名 ⇒ 返回 null（不点名＝整链），绝不猜一个起点', () => {
  // 猜的代价是**漏跑一段**，而漏跑一段的续跑看起来与成功一模一样。
  assert.equal(resumeStageListFrom([null], STAGES), null);
  assert.equal(resumeStageListFrom(['alimama-ate'], STAGES), null);
  assert.equal(resumeStageListFrom([], STAGES), null);
  assert.equal(resumeStageListFrom(undefined, STAGES), null);
});

test('起点下探：人碰过页面 ⇒ 退到 alimama-date（日期落位要重做），而且**只许往前、不许往后**', () => {
  // 为什么必须下探：驻留期间那一页被人关过弹窗、或者被我们自己重载过 ⇒ 页面上的**日期筛选**
  // 已经不在原处，而 alimama-date 正是把日期落上去的那一步。漏了它，续跑会拿着一个没有日期的
  // 报表页往下做 —— 出来的数看着像数据，实际是别的时段。
  assert.equal(RESUME_FLOOR_BY_CAUSE.PAGE_OBSTRUCTED, 'alimama-date');
  assert.equal(RESUME_FLOOR_BY_CAUSE.NEEDS_LOGIN, 'alimama-date');

  const pushed = resumeStageListFrom(['push'], STAGES, { floorStage: 'alimama-date' });
  assert.deepEqual(pushed,
    ['health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report', 'promotion-fetch',
      'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback']);

  // 反面：起点在失败那一步**之后**时，不许把它挪后（那会漏跑失败那一步本身）。
  const later = resumeStageListFrom(['promotion-submit'], STAGES, { floorStage: 'push' });
  assert.equal(later.includes('promotion-submit'), true, 'floor 在失败点之后时，失败那一步仍必须在名单里');
  assert.equal(later.includes('alimama-date'), false);

  // 认不出的 floor 不生效（当没给）—— 但它也**不许**把结果变成 null。
  assert.deepEqual(resumeStageListFrom(['push'], STAGES, { floorStage: '不存在' }), resumeStageListFrom(['push'], STAGES));

  // 多成因时取阶段表里最靠前的那个起点。
  assert.equal(resumeFloorFor(['NEEDS_LOGIN'], STAGES), 'alimama-date');
  assert.equal(resumeFloorFor(['NOT_A_CAUSE'], STAGES), null);
  assert.equal(resumeFloorFor([], STAGES), null);
});

test('续跑的命令行：带上 --commit 与目标日，只补那几家那几步', () => {
  const argv = buildResumeArgv({
    chainScript: 'C:/repo/skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
    date: '2026-09-25', shops: ['科塔淘宝'], stages: ['health-check', 'push'],
  });
  assert.deepEqual(argv.slice(1, 4), ['--date', '2026-09-25', '--commit']);
  assert.ok(argv.includes('--notify'), '续跑是「出事才发」的那一档：它失败时必须叫人');
  assert.deepEqual(argv.slice(argv.indexOf('--shops'), argv.indexOf('--shops') + 2), ['--shops', '科塔淘宝']);
  assert.deepEqual(argv.slice(argv.indexOf('--only'), argv.indexOf('--only') + 2), ['--only', 'health-check,push']);
  // 刻意**不**传这两个：
  //   · `--login-preflight`：那份结论是这一轮开跑前写的，人刚登完/刚关完弹窗之后它已经过期，
  //     拿它当解释会把「这次为什么失败」说成上一次的成因；
  //   · `--will-resume`：续跑只做一次，之后不再驻留 ⇒ 承诺「系统会自己继续」会变成假话。
  assert.equal(argv.includes('--login-preflight'), false);
  assert.equal(argv.includes('--will-resume'), false);
  // 整轮那一档：不给 --shops / --only（＝整链重跑），这是**唯一**允许整轮跑的情形。
  const round = buildResumeArgv({ chainScript: 'x.mjs', date: '2026-09-25' });
  assert.equal(round.includes('--shops'), false);
  assert.equal(round.includes('--only'), false);
});

// ---------------------------------------------------------------------------
// 「好了没有」（这一条判错＝拿着还堵着的现场去写飞书）
// ---------------------------------------------------------------------------
test('判据转正：只有「一个都没在等、也没有读不到」才算好了；**空集不算好**', () => {
  const ready = judgeProbes([{ state: 'ready' }]);
  assert.equal(ready.ready, true);
  assert.equal(ready.total, 1);

  // 「读不到」绝不当成「好了」（本项目最贵的一类错误）。
  assert.equal(judgeProbes([{ state: 'unknown' }]).ready, false);
  assert.equal(judgeProbes([{ state: 'ready' }, { state: 'unknown' }]).ready, false);
  assert.equal(judgeProbes([{ state: 'ready' }, { state: 'waiting' }]).ready, false);
  // 「没东西可探」也不等于「都好了」——否则一个探针都没配的那一轮会立刻发起续跑。
  assert.equal(judgeProbes([]).ready, false);
  assert.equal(judgeProbes(undefined).ready, false);
  assert.deepEqual([...PROBE_STATES], ['ready', 'waiting', 'unknown']);
  // 三种状态都被如实归类（不能把 waiting 算进 unknown 里，否则状态行会误导人）。
  const mixed = judgeProbes([{ state: 'waiting' }, { state: 'unknown' }, { state: 'ready' }]);
  assert.equal(mixed.waiting.length, 1);
  assert.equal(mixed.unknown.length, 1);
  assert.equal(mixed.total, 3);
});

test('驻留状态行：带时间、已等多久、等到几点，以及每个对象的现状（不许静默）', () => {
  const line = holdStatusLine({ at: new Date(2026, 8, 26, 9, 30, 5), waitedMs: 65 * 60 * 1000, until: '12:00',
    probes: [{ subject: '科塔淘宝', why: '还有一层盖住整页的弹窗（DIV#wrapper_dlg_624）' }] });
  assert.match(line, /已等 65 分钟/u);
  assert.match(line, /等到 12:00/u);
  assert.match(line, /科塔淘宝：还有一层盖住整页的弹窗/u);
  assert.match(line, /^\[驻留\] 09:30:05/u);
});

// ---------------------------------------------------------------------------
// 两条通知（字段名必须落在渲染白名单里，否则那一行会被**静默吞掉**）
// ---------------------------------------------------------------------------
const WHITELISTED = new Set(READABLE_SOURCE_KEYS.map(([key]) => key));
const NOTICES = () => [
  ['到点没等到人', closeOutNotice({ date: '2026-09-26', subjects: ['科塔淘宝'] })],
  ['续跑成功', resumeResultNotice({ date: '2026-09-26', shops: ['科塔淘宝'], ok: true })],
  ['续跑失败', resumeResultNotice({ date: '2026-09-26', shops: ['科塔淘宝'], ok: false, detail: '退出码 1' })],
];

test('通知：source 的键必须都在白名单里（漏一个 ⇒ 收信人看不到那一行，而本地看着完全正常）', () => {
  for (const [name, notice] of NOTICES()) {
    for (const key of Object.keys(notice.source)) {
      assert.ok(WHITELISTED.has(key), `${name} 的 source.${key} 不在白名单里 ⇒ 这一行会被静默丢掉`);
    }
    assert.equal(notice.source.targetLabel, '日报一轮');
    assert.equal(notice.source.period, '2026-09-26');
    assert.equal(notice.source.shopName, '科塔淘宝');
    // 两条都得有编号与指纹：没有编号就没法去重，没有指纹就没法判「同一处再出问题」。
    assert.ok(notice.alertId, `${name} 缺 alertId`);
    assert.ok(notice.fingerprint, `${name} 缺 fingerprint`);
    assert.ok(notice.title && notice.reason && notice.action, `${name} 三段自由文本缺一不可`);
  }
});

test('通知：三条各有各的编号，且续跑成功/失败**不许共用同一个指纹**', () => {
  const [closeOut, resumed, failed] = NOTICES().map(([, notice]) => notice);
  assert.equal(new Set([closeOut.alertId, resumed.alertId, failed.alertId]).size, 3);
  assert.notEqual(resumed.fingerprint, failed.fingerprint,
    '共用指纹会让「失败了一次」被上一轮的「成功了」挡掉');
  assert.equal(failed.severity, 'ERROR');
  assert.equal(resumed.severity, 'INFO');
});

test('通知：文案是给运营看的 —— 不出现阶段名/结论代号/路径/命令行/链接/账号名', () => {
  // 同驱动那一条判据的口径：**形状**比词表更能抓住泄漏（路径、命令行、编号）。
  const shapes = [
    [/[A-Za-z]:[\\/]/u, '盘符路径'],
    [/(?:^|[^A-Za-z])(?:evidence|runtime|skills|scripts)[\\/]/u, '仓库内相对目录'],
    [/(?:^|\s)--[a-z][a-z-]+/u, '命令行参数'],
    [/\bnode(?:\.exe)?\b/u, '命令行本体'],
    [/https?:\/\//u, '链接'],
  ];
  for (const [name, notice] of NOTICES()) {
    const free = [notice.title, notice.reason, notice.action].join('\n');
    for (const cause of ['PAGE_OBSTRUCTED', 'NEEDS_LOGIN', 'ROUND_BLOCKED', 'STAGE_FAILED']) {
      assert.equal(free.includes(cause), false, `${name} 里出现了结论代号 ${cause}`);
    }
    for (const stage of STAGES) {
      assert.equal(free.includes(stage), false, `${name} 里出现了英文阶段名 ${stage}`);
    }
    for (const [pattern, label] of shapes) {
      const hit = free.match(pattern);
      assert.equal(Boolean(hit), false, `${name} 里出现了${label}：${hit?.[0] ?? ''}`);
    }
    assert.ok(/科塔淘宝|这一轮/u.test(free), `${name} 要说清是谁`);
  }
  // 「等到点没等到人」那一条必须给出**下一步**：窗口已经被放掉，静默结束等于
  // 「人以为还有现场，其实没了」。
  const closeOut = NOTICES()[0][1];
  assert.match(closeOut.action, /重新跑/u);
  // 续跑失败那一条必须说清「不会再自己试第二次」，否则收信人会一直等下去。
  const failedNotice = NOTICES()[2][1];
  assert.match(failedNotice.action, /不会再自动重跑第二次/u);
  // 两种结果的告警编号必须不同：同编号时「成功」那条会先把去重窗口占住，
  // 之后的「失败」会被自己的成功记录挡掉（真实缺陷，2026-09-26 修）。
  assert.notEqual(NOTICES()[1][1].alertId, NOTICES()[2][1].alertId);
});

// ---------------------------------------------------------------------------
// CLI 层的两条（参数解析、以及「逐店失败」的归一化）
// ---------------------------------------------------------------------------
test('CLI：--date 必给（不给它拼不出结论路径），--until 格式当场校验', () => {
  assert.match(parseHoldArgs([]).error, /--date/u);
  assert.match(parseHoldArgs(['--date', '2026-09-25', '--until', '25:00']).error, /超出范围/u);
  assert.match(parseHoldArgs(['--date', '2026-09-25', '--poll-seconds', '0']).error, /正整数/u);
  assert.match(parseHoldArgs(['--date', '2026-09-25', '--wat']).error, /未知参数/u);
  const ok = parseHoldArgs(['--date', '2026-09-25', '--once']);
  assert.equal(ok.date, '2026-09-25');
  assert.equal(ok.untilMinutes, 720, '默认等到当天 12:00');
  assert.equal(ok.once, true);
  assert.equal(ok.resume, true);
  assert.equal(ok.release, true);
  assert.equal(ok.notify, true, '命令行直接跑这一档默认发告警；定时链那一路会显式压成 --no-notify');
  // 结论文件的默认落点由 --date 拼出来（不给 --summary 时）。
  assert.match(ok.summary.replaceAll('\\', '/'), /evidence\/multi-shop-2026-09-25\/summary\.json$/u);
});

test('CLI：逐店失败的归一化用的是**链自己的**分类器（不在这里另写一份判据）', () => {
  const summary = { shops: {
    里可林淘宝: { status: 'ok' },
    科塔淘宝: { status: 'failed', failedStage: 'promotion-submit', failureOutput: 'x' },
  } };
  const failed = failedShopsOf(summary);
  assert.deepEqual(failed.map((item) => item.shop), ['科塔淘宝']);
  assert.equal(failed[0].stage, 'promotion-submit');
  assert.equal(failed[0].cause, 'STAGE_FAILED', '认不出来的失败落兜底类 ⇒ 不驻留（不会白挂几小时）');
  assert.deepEqual(failedShopsOf({}), []);
  assert.deepEqual(failedShopsOf(null), []);
});

test('CLI：退出码口径只有一处（入口拿 4 把整轮翻绿，其余一律保持链的结论）', () => {
  assert.deepEqual({ ...HOLD_EXIT },
    { NO_HOLD: 0, RESUME_FAILED: 1, NO_VERDICT: 2, TIMED_OUT: 3, RESUMED_OK: 4 });
  // 4 必须是**唯一**的「好了」那一档：`scripts/run-daily-job.mjs` 只认它。
  assert.equal(HOLD_EXIT.NO_HOLD === HOLD_EXIT.RESUMED_OK, false);
});

// ---------------------------------------------------------------------------
// 接线（防「纯函数全绿、没人调」）
// ---------------------------------------------------------------------------
test('接线：定时计划里真的有「驻留」这一步，且它只在链失败时才执行', () => {
  const plan = buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\evidence\\daily-job-2026-09-25' });
  const names = plan.steps.map((step) => step.name);
  assert.deepEqual(names, ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'chain', 'hold-and-resume']);
  const hold = plan.holdStep;
  assert.ok(hold, '计划里没有驻留那一步 ⇒ 「留窗口给人」一次也不会发生');
  assert.equal(hold.onlyWhenChainFailed, true, '链成功的那一天它不许执行（默认行为必须逐字不变）');
  assert.equal(hold.blocking, false, '它不许覆盖链的退出码（只有它能翻绿，见入口那段注释）');
  assert.match(hold.file, /scripts\/hold-and-resume\.mjs$/u);
  // 结论路径由计划自己算出，且与链写 summary.json 的地方是**同一个根**。
  const summaryAt = hold.args.indexOf('--summary');
  assert.ok(summaryAt >= 0, '驻留那一步没拿到结论路径 ⇒ 它只会判「读不到」然后不驻留');
  assert.equal(hold.args[summaryAt + 1], 'D:\\repo\\evidence\\multi-shop-2026-09-25\\summary.json');
  // 告警出口默认不投递（本文件头第 ③ 条不变量对每一个出口都成立）。
  assert.equal(hold.args.includes('--no-notify'), true);
  assert.equal(buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e', notify: true })
    .holdStep.args.includes('--notify'), true);
});

test('接线：没有具体某一天时**不加**这一步（给字面量 yesterday 会拼出不存在的结论路径）', () => {
  assert.equal(buildJobPlan().holdStep, null);
  assert.equal(buildJobPlan({ artifactsDir: 'D:\\repo\\e' }).holdStep, null);
  assert.equal(buildJobPlan({ resolvedDate: '2026-09-25' }).holdStep, null);
  // `--no-hold` 是一键退回旧行为的开关。
  assert.equal(buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e', hold: false }).holdStep, null);
  assert.equal(buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e' }).steps
    .some((step) => step.name === 'hold-and-resume'), true);
});

test('接线：`--will-resume` 跟着「这一轮会不会驻留」走（承诺系统会自己续跑就必须真有驻留）', () => {
  const withHold = buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\evidence\\daily-job-2026-09-25' });
  const chain = withHold.steps.find((step) => step.name === 'chain');
  assert.equal(chain.args.includes('--will-resume'), true,
    '有驻留却不告诉链 ⇒ 告警永远说「告诉技术同学重跑一次」，而机器其实已经留住了窗口');
  // 反面：没有驻留（手工/排查/分批/--no-hold）时**不许**给 —— 那会变成一句兑现不了的承诺。
  for (const plan of [buildJobPlan(), buildJobPlan({ batches: 2, resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e' }),
    buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e', hold: false })]) {
    const step = plan.steps.find((entry) => entry.name === 'chain' || entry.name === 'batch-chain');
    assert.equal(step.args.includes('--will-resume'), false);
  }
});

test('接线：分批形态**明确不驻留**（刻意的缺口，要有名字而不是静默少一段）', () => {
  // 分批存在的理由就是「跑完一批就把它放掉，把内存让给下一批」，与「按住几家窗口几小时」
  // 在同一条命令里直接冲突，且「剩下那几批还跑不跑」没有设计过。
  // 生产路径（不带 --batches）不受影响。
  const plan = buildJobPlan({ batches: 2, resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e' });
  assert.equal(plan.batchWithoutHold, true);
  assert.equal(plan.holdStep, null);
  assert.equal(plan.steps.some((step) => step.name === 'hold-and-resume'), false);
});

test('接线：入口那一步「该不该执行」的判据是纯函数（写在入口里会测不到，而写反了两头都错）', () => {
  const step = { name: 'hold-and-resume', onlyWhenChainFailed: true };
  assert.equal(shouldRunStep(step, { chainStatus: 0 }), false, '链成功了 ⇒ 跳过（默认行为必须逐字不变）');
  assert.equal(shouldRunStep(step, { chainStatus: 1 }), true, '链失败 ⇒ 执行（它自己去判要不要驻留）');
  assert.equal(shouldRunStep(step, { chainStatus: 3 }), true);
  // `null` ＝ 链那一步还没轮到／压根没跑 ⇒ 也要执行：这一步自己会读结论、
  // 读不到就退 2 走人（多跑一次判据的代价，远小于「该留窗口却没留」）。
  assert.equal(shouldRunStep(step, { chainStatus: null }), true);
  assert.equal(shouldRunStep(step), true);
  // 没有这个标记的步骤永远照跑。
  assert.equal(shouldRunStep({ name: 'chain' }, { chainStatus: 0 }), true);
  assert.equal(shouldRunStep(null, { chainStatus: 1 }), true);
});

test('接线：入口真的把「哪一天」与「证据目录」交给计划了（漏一个就静默少一段）', () => {
  // 与 `login-preflight` 那条同样的纪律：计划那侧全绿而宿主漏传时，症状是静默的 ——
  // 驻留那一步干脆不进计划，日志里少一行，而「留窗口给人」一次也不会发生。
  const job = buildJobPlan({ resolvedDate: '2026-09-25', artifactsDir: 'D:\\repo\\e' });
  assert.ok(job.holdStep, '前提：两个都给时必须有这一步');
  assert.equal(buildHoldResumeArgs({ date: '2026-09-25' }).length > 0, true);
  assert.throws(() => buildHoldResumeArgs({}), /需要 date/u);
  assert.throws(() => buildHoldResumeArgs({ date: '2026-09-25', notify: true, notifyPrint: true }), /互斥/u);
});
