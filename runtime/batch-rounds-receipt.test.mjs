// 「rounds → run-receipt-v1」映射的离线判据（2026-10-10 对抗审查整改 A 项）。
//
// 为什么必须有：这段映射的三条纪律（驻留终态 ⇒ FAILED、失败店只收逐店名单、
// apply 下 chain 步 publication=UNKNOWN）每一条都对应一位审查员点名的**状态失真**。
// 抽成纯函数的意义就是让它们可被点名、可被突变验证 —— 把映射改坏成恒 PAUSED，
// 这里的用例必须红，而不是等下一次真机驻留翻车才发现。
//
// 纪律（同 run-batches-cli.test.mjs）：不起进程、不碰文件系统 —— 全部 plain data 进出。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOLD_EXIT } from './daily-job-plan.mjs';
import { validateRunReceipt } from './run-receipt-v1.mjs';
import { buildRunReceiptFromRounds } from './batch-rounds-receipt.mjs';

const ENTRY = Object.freeze({ id: 'daily-report', version: '1.0.0' });
const DATE = '2026-10-09';
const ARTIFACT = Object.freeze({
  path: 'evidence/batches-2026-10-09/batches.json',
  size: 2048,
  sha256: 'b'.repeat(64),
});

/** 一轮的标准形状（run-batches 真实喂进来的 plain data）。 */
function round(overrides = {}) {
  return {
    index: 1,
    shops: ['盖文淘宝', '网林天猫'],
    chainStatus: 0,
    steps: { start: 0, 'login-preflight': 0, chain: 0, stop: 0 },
    decision: { release: true },
    unfixable: [],
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildRunReceiptFromRounds({
    entry: ENTRY, targetDate: DATE, mode: 'dry-run', batchSize: 5,
    rounds: [round()], blocked: null, holdEnabled: true, holdStatus: null, hardFail: 0,
    batchesArtifact: { ...ARTIFACT },
    ...overrides,
  });
}

test('全绿路径：未被挡 + 全批链 0 + 无硬失败 ⇒ SUCCEEDED，shops 空，回执整体合法', () => {
  const receipt = build();
  assert.equal(receipt.execution, 'SUCCEEDED');
  assert.deepEqual(receipt.shops, []);
  assert.equal(receipt.failureClass, null);
  assert.deepEqual(receipt.artifacts, [{ ...ARTIFACT }]);
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('dry-run ⇒ chain 步 publication=NOT_REQUESTED；其余步骤也一律 NOT_REQUESTED', () => {
  const receipt = build({ mode: 'dry-run' });
  const steps = receipt.batches[0].steps;
  const chain = steps.find((s) => s.name === 'chain');
  assert.equal(chain.publication, 'NOT_REQUESTED');
  assert.ok(steps.every((s) => s.publication === 'NOT_REQUESTED'));
});

test('apply ⇒ chain 步 publication=UNKNOWN（真实写入但未独立回读）；非 chain 步仍 NOT_REQUESTED', () => {
  const receipt = build({ mode: 'apply' });
  const steps = receipt.batches[0].steps;
  assert.equal(steps.find((s) => s.name === 'chain').publication, 'UNKNOWN');
  for (const s of steps.filter((x) => x.name !== 'chain')) {
    assert.equal(s.publication, 'NOT_REQUESTED', `${s.name} 不写飞书，不许标 UNKNOWN`);
  }
  assert.deepEqual(validateRunReceipt(receipt), []);
});

// ── 驻留终态映射（审查二 P1-1：已终止的驻留不是 PAUSED）─────────────────────────

function blockedCase(holdStatus, extra = {}) {
  return build({
    rounds: [round({ chainStatus: 1, unfixable: ['盖文淘宝'], steps: { start: 0, 'login-preflight': 0, chain: 1, stop: 'skipped' }, decision: { release: false } })],
    blocked: { batch: 1, summaryPath: 'evidence/batches-2026-10-09/b1/summary.json', cause: 'ROUND_LOGIN_WALL' },
    holdEnabled: true,
    holdStatus,
    ...extra,
  });
}

test('驻留终态 TIMED_OUT（等到截止时间也没人处理）⇒ execution=FAILED（不是 PAUSED）', () => {
  const receipt = blockedCase(HOLD_EXIT.TIMED_OUT);
  assert.equal(receipt.execution, 'FAILED');
  assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
  assert.deepEqual(receipt.shops, ['盖文淘宝']);
});

test('驻留终态 RESUME_FAILED（续跑仍没成功，需要技术）⇒ execution=FAILED', () => {
  assert.equal(blockedCase(HOLD_EXIT.RESUME_FAILED).execution, 'FAILED');
});

test('驻留终态 NO_VERDICT（读不到结论，没挂住）⇒ execution=FAILED', () => {
  assert.equal(blockedCase(HOLD_EXIT.NO_VERDICT).execution, 'FAILED');
});

test('驻留终态 NO_HOLD（判下来不需要人，没挂住）⇒ execution=FAILED', () => {
  assert.equal(blockedCase(HOLD_EXIT.NO_HOLD).execution, 'FAILED');
});

test('被挡但给了 --no-hold（holdEnabled=false、驻没跑）⇒ execution=FAILED', () => {
  assert.equal(blockedCase(null, { holdEnabled: false }).execution, 'FAILED');
});

test('RESUMED_OK（驻留后自动续跑成功）⇒ SUCCEEDED、shops=[]、failureClass=null（恢复后不再挂失败清单）', () => {
  const receipt = blockedCase(HOLD_EXIT.RESUMED_OK);
  assert.equal(receipt.execution, 'SUCCEEDED');
  assert.deepEqual(receipt.shops, [], '恢复后不许再挂着失败店清单');
  assert.equal(receipt.failureClass, null);
  // 当时失败的批次仍如实记 FAILED —— 那是发生过的事实，恢复只改变**整轮**终判。
  assert.equal(receipt.batches[0].execution, 'FAILED');
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('PAUSED 不可达：本映射产出的 execution 只会是 SUCCEEDED/FAILED（finalize 时刻驻留必然已终止）', () => {
  const states = [
    build(),
    blockedCase(HOLD_EXIT.TIMED_OUT),
    blockedCase(HOLD_EXIT.RESUME_FAILED),
    blockedCase(HOLD_EXIT.NO_VERDICT),
    blockedCase(HOLD_EXIT.NO_HOLD),
    blockedCase(HOLD_EXIT.RESUMED_OK),
    blockedCase(null, { holdEnabled: false }),
  ];
  for (const receipt of states) {
    assert.ok(['SUCCEEDED', 'FAILED'].includes(receipt.execution),
      `PAUSED 不可达（run-batches 的驻留是同步子进程，finalize 时必然已终止）。实际：${receipt.execution}`);
  }
});

// ── 失败店清单（审查二 P1-4：不把整批成功店伪标成失败店）──────────────────────

test('链失败但拿不到逐店名单（unfixable 缺失/为空）⇒ shops=[] —— 批次级失败留在 batches[].execution', () => {
  const receipt = build({
    rounds: [round({ chainStatus: 1, unfixable: [] })],
  });
  assert.equal(receipt.execution, 'FAILED');
  assert.deepEqual(receipt.shops, [], '拿不到逐店名单时不得退回整批名单（那会把批内成功店伪标成失败店）');
  assert.equal(receipt.batches[0].execution, 'FAILED', '批次级失败必须仍可见');
  assert.equal(receipt.failureClass, null);
});

test('unfixable 字段整个缺失（调用方没给）⇒ 同样退化为 shops=[]，不点名', () => {
  const { unfixable, ...withoutUnfixable } = round({ chainStatus: 1 });
  assert.equal(unfixable !== undefined, true); // 上面只是从对象里摘掉它
  const receipt = build({ rounds: [withoutUnfixable] });
  assert.equal(receipt.execution, 'FAILED');
  assert.deepEqual(receipt.shops, []);
});

test('拿到逐店名单 ⇒ 只点名那几家（批内其余成功店不进 shops）', () => {
  const receipt = build({
    rounds: [
      round({ index: 1, chainStatus: 1, unfixable: ['网林天猫'] }),
      round({ index: 2, shops: ['科塔淘宝'], chainStatus: 0 }),
    ],
  });
  assert.deepEqual(receipt.shops, ['网林天猫']);
  assert.equal(receipt.batches[0].execution, 'FAILED');
  assert.equal(receipt.batches[1].execution, 'SUCCEEDED');
});

test('多批失败 ⇒ 逐店名单按批序合入 shops（成功批零贡献）', () => {
  const receipt = build({
    rounds: [
      round({ index: 1, chainStatus: 1, unfixable: ['盖文淘宝'] }),
      round({ index: 2, shops: ['科塔淘宝'], chainStatus: 1, unfixable: ['科塔淘宝', '网林家居'] }),
      round({ index: 3, shops: ['里可林天猫'], chainStatus: 0 }),
    ],
  });
  assert.deepEqual(receipt.shops, ['盖文淘宝', '科塔淘宝', '网林家居']);
});

// ── 其余轴的形状守卫 ──────────────────────────────────────────────────────────

test('release 轴纪律：requested=true ⇒ observed:false + status:UNKNOWN；requested=false ⇒ HELD', () => {
  const receipt = build({
    rounds: [
      round({ index: 1, decision: { release: true }, chainStatus: 0 }),
      round({ index: 2, shops: ['科塔淘宝'], chainStatus: 0, decision: { release: false } }),
    ],
  });
  assert.deepEqual(receipt.batches[0].release, { requested: true, observed: false, status: 'UNKNOWN' });
  assert.deepEqual(receipt.batches[1].release, { requested: false, observed: false, status: 'HELD' });
  assert.ok(receipt.batches.every((b) => b.release.observed === false), 'observed 恒 false —— 没做端口回读就不许假装观察到');
});

test("steps 只收有退出码的步骤：'skipped' 不进 steps（它的事实由 release 轴表达）", () => {
  const receipt = build({
    rounds: [round({ chainStatus: 1, steps: { start: 0, 'login-preflight': 0, chain: 1, stop: 'skipped' } })],
  });
  assert.ok(receipt.batches[0].steps.every((s) => typeof s.execution === 'string'));
  assert.equal(receipt.batches[0].steps.some((s) => s.name === 'stop'), false);
});

test('stop 没停干净（hardFail>0，链全 0）⇒ execution=FAILED（与业务退出码 1 对齐，不写假成功）', () => {
  const receipt = build({ rounds: [round({ steps: { start: 0, 'login-preflight': 0, chain: 0, stop: 1 } })], hardFail: 1 });
  assert.equal(receipt.execution, 'FAILED');
  assert.equal(receipt.failureClass, null);
});

test('failureClass：UNFIXABLE_SHOPS 成因 ⇒ HUMAN_REQUIRED；ROUND_BLOCKED 成因不定 ⇒ null', () => {
  const unfixableBlocked = build({
    rounds: [round({ chainStatus: 1, unfixable: ['盖文淘宝'] })],
    blocked: { batch: 1, summaryPath: 's', cause: 'UNFIXABLE_SHOPS' },
    holdEnabled: true, holdStatus: HOLD_EXIT.TIMED_OUT,
  });
  assert.equal(unfixableBlocked.failureClass, 'HUMAN_REQUIRED');
  const roundBlocked = build({
    rounds: [round({ chainStatus: 1, unfixable: [] })],
    blocked: { batch: 1, summaryPath: 's', cause: 'ROUND_BLOCKED' },
    holdEnabled: true, holdStatus: HOLD_EXIT.TIMED_OUT,
  });
  assert.equal(roundBlocked.failureClass, null);
});

test('batchesArtifact 缺省 ⇒ artifacts=[]（不硬造工件记录）', () => {
  const receipt = build({ batchesArtifact: null });
  assert.deepEqual(receipt.artifacts, []);
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('runId 透传：给了就用调用方的（可复现的回执 id）', () => {
  const receipt = build({ runId: 'daily-report-2026-10-09-fixed' });
  assert.equal(receipt.runId, 'daily-report-2026-10-09-fixed');
});

// ── 与 validateRunReceipt 的跨轴联合（A3 的端到端形态）────────────────────────

test('映射产物 + validateRunReceipt：SUCCEEDED + shops 非空的非法组合会被点名拒绝', () => {
  const receipt = build(); // SUCCEEDED、shops=[]
  receipt.shops.push('盖文淘宝'); // 人为改坏：成功回执挂失败店
  const errors = validateRunReceipt(receipt);
  assert.ok(errors.some((e) => e.includes('execution SUCCEEDED requires shops to be empty')),
    `要点名拒绝。实际：\n${errors.join('\n')}`);
});
