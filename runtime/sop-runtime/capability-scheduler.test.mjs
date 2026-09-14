// 调度侧驱动器的单测。
//
// 与 two-stage-runner.test.mjs 同一个套路：用「合成能力 + 真实两段式运行器」把「探测 → 跳过/发起」
// 的判决面单独钉住，不验证任何一条业务能力的细节（那是 huitun 自己的用例该管的事）。
//
// 这里最要紧的三类断言：
//  1. **跳过只发生在探测给出确定结论时**。探测器坏掉/没实现/给出怪状态，一律照常发起——
//     因为「多做一次本来会失败的运行」是可见的，「少做一次本来该做的活」是不可见的。
//  2. **不建运行**。跳过必须是「一条运行都没创建」，而不是「创建一条运行再把它标成跳过」：
//     用真实 Controller 的 idFactory 计数器直接证明，而不是相信收据里的 scheduled:false。
//  3. **五条出口的字段恒等**，尤其 humanRequired 必须每条路径都在场（用 Object.hasOwn 断言，
//     不用 === false——`undefined` 恰好也是假，会掩盖「这条路径忘了设置」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import {
  QUEUE_PROBE_EXPORT,
  QUEUE_STATES,
  SCHEDULE_OUTCOMES,
  SCHEDULE_RECEIPT_FIELDS,
  SKIPPABLE_QUEUE_STATES,
  SchedulerError,
  exitCodeFor,
  normalizeProbeResult,
  parseSchedulerArgs,
  probeCapabilityQueue,
  runScheduled,
} from './capability-scheduler.mjs';

const READY = Object.freeze({ state: 'READY', code: 'CANDIDATES_READY', reason: '3 candidate keyword(s) are queued', candidateCount: 3 });
const EMPTY = Object.freeze({ state: 'EMPTY', code: 'NO_CANDIDATES', reason: 'the A_ONLY candidate queue is empty', candidateCount: 0 });
const WAITING = Object.freeze({ state: 'WAITING_HUMAN', code: 'AI_REQUIRED', reason: '2 populated row(s) are still awaiting settlement', candidateCount: null });

const IDENTITY = Object.freeze({
  tenantId: 't1', storeId: 's1', platform: 'fake',
  accountId: 'a1', browserProfileId: 'p1', contractVersion: '1.0.0',
});

const ARTIFACT_BYTES = Buffer.from('{"rows":2,"keyword":"浴缸"}\n', 'utf8');

const manifestOf = (overrides = {}) => ({
  schemaVersion: 'skill-manifest-v1',
  name: 'fake.cap',
  version: '1.0.0',
  kind: 'capability',
  description: 'synthetic capability for scheduler tests',
  entry: 'scripts/fake.mjs',
  inputs: [], outputs: [],
  preconditions: [],
  permissions: ['filesystem.read'],
  sideEffects: ['local_parse'],
  dependencies: [],
  validation: ['structure', 'row_count', 'digest', 'readback', 'publication'],
  recovery: { supported: true, resumeFrom: 'idempotent_commit' },
  owner: 'test',
  tags: [],
  ...overrides,
});

// 合成能力。`probe` 不给就是「本能力没有探测契约」——那也是一条必须照常发起的状态。
function capabilityModuleOf({ probe } = {}) {
  return {
    capabilityId: 'fake.cap',
    manifestVersion: '1.0.0',
    collectContract: () => ({ requiredFields: ['artifactId', 'schemaVersion'] }),
    adapter: {
      checkSession: async () => ({ ok: true }),
      prepare: async () => {},
      start: async () => ({ rows: 2 }),
      observe: async ({ context }) => ({ identity: context.identity, rows: 2 }),
      collectArtifact: async () => ({
        artifactId: 'fake-artifact',
        artifactKind: 'json',
        bytes: ARTIFACT_BYTES,
        sha256: createHash('sha256').update(ARTIFACT_BYTES).digest('hex'),
        rowCount: 2,
        range: { start: 1, end: 2 },
        schemaVersion: 'fake-artifact-v1',
      }),
      validate: async () => ({ ok: true }),
      release: async () => {},
    },
    ...(typeof probe === 'function' ? { [QUEUE_PROBE_EXPORT]: probe } : {}),
  };
}

function makeHarness({ manifest = manifestOf(), module = capabilityModuleOf(), loader = null } = {}) {
  const store = createMemoryStore();
  // 直接数 createRun 的调用次数，而不是数 idFactory：idFactory 造的是 attempt id，
  // 用它当「有没有建运行」的证据是错的（这条断言本身就是一次假绿的候选）。
  const runs = { created: 0 };
  const countingStore = {
    ...store,
    createRun: async (args) => {
      runs.created += 1;
      return store.createRun(args);
    },
  };
  const controller = createController({ store: countingStore });
  const ledger = createSideEffectLedger({ store: countingStore });
  const dir = mkdtempSync(path.join(tmpdir(), 'scheduler-'));
  const evidenceStore = createEvidenceStore({ root: path.join(dir, 'evidence') });
  const registry = {
    require: () => ({ manifest, digest: 'sha256:test' }),
    names: () => ['fake.cap'],
    assertSideEffectDeclared: () => true,
    assertPermissionDeclared: () => true,
  };
  const defaultLoader = { loadAdapter: async () => ({ module, adapter: module.adapter, sourcePath: '/fake.mjs' }) };
  // 注意：运行器与 Controller 必须拿到**同一个**被包了一层的 store，否则计数会漏掉运行器那次调用。
  return { store: countingStore, controller, ledger, evidenceStore, registry, loader: loader ?? defaultLoader, runs, workDir: dir };
}

function stubRunner({ ok = true, failureClass = null, reasons = [] } = {}) {
  const calls = [];
  return {
    calls,
    runner: async (options) => {
      calls.push(options);
      return { ok, failureClass, reasons, runId: 'run-from-stub-runner', admitted: true };
    },
  };
}

async function schedule({ manifest, module, loader, stub = null, options = {} } = {}) {
  const harness = makeHarness({ manifest, module, loader });
  const receipt = await runScheduled({
    registry: harness.registry,
    loader: harness.loader,
    store: harness.store,
    controller: harness.controller,
    ledger: harness.ledger,
    evidenceStore: harness.evidenceStore,
    capabilityId: 'fake.cap',
    identity: { ...IDENTITY },
    target: 'https://example.feishu.cn/base/appTokenAbc',
    businessKey: 'fake|2026-09-14',
    expectedRows: 2,
    collectInput: { resultsFile: 'x.json' },
    workDir: harness.workDir,
    ...(stub ? { runner: stub.runner } : {}),
    ...options,
  });
  return { receipt, harness, stub };
}

test('探测没拿到结论时一律照常发起：无 loader / 加载失败 / 能力未实现探测', async () => {
  // 「没有 loader」用桩运行器观察：真实运行器本身也需要 loader，用它反而看不到调度器的判决。
  const noLoaderStub = stubRunner();
  const noLoader = await schedule({ loader: {}, stub: noLoaderStub });
  assert.equal(noLoader.receipt.probe.state, 'UNAVAILABLE');
  assert.equal(noLoader.receipt.probe.code, 'PROBE_NOT_AVAILABLE');
  assert.equal(noLoader.receipt.probe.probed, false);
  assert.equal(noLoader.receipt.outcome, 'PROCEEDED_WITHOUT_PROBE');
  assert.equal(noLoaderStub.calls.length, 1, '探不出来时必须照常发起');

  const loadFailedStub = stubRunner();
  const loadFailed = await schedule({
    loader: { loadAdapter: async () => { throw new Error('module exploded'); } },
    stub: loadFailedStub,
  });
  assert.equal(loadFailed.receipt.probe.state, 'UNAVAILABLE');
  assert.equal(loadFailed.receipt.probe.code, 'PROBE_LOAD_FAILED');
  assert.match(loadFailed.receipt.probe.probeError, /module exploded/u);
  assert.equal(loadFailed.receipt.probe.probed, false);
  assert.equal(loadFailed.receipt.outcome, 'PROCEEDED_WITHOUT_PROBE');
  assert.equal(loadFailed.receipt.scheduled, true);
  assert.equal(loadFailedStub.calls.length, 1, '载入失败也只影响探测，不拦下运行');

  // 唯一一个「真实运行确实被创建」的探不出结论用例：能力没实现探测契约。
  const notImplemented = await schedule({ module: capabilityModuleOf() });
  assert.equal(notImplemented.receipt.probe.state, 'NOT_PROBED');
  assert.equal(notImplemented.receipt.probe.code, 'NO_PROBE_CONTRACT');
  assert.match(notImplemented.receipt.probe.reason, /does not export probeQueue/u);
  assert.equal(notImplemented.receipt.scheduled, true);
  assert.equal(notImplemented.harness.runs.created, 1);
});

test('探测抛异常：不下结论、原因原样带出，仍然照常发起（探测器坏掉不能变成静默漏做）', async () => {
  const { receipt, harness } = await schedule({
    module: capabilityModuleOf({
      probe: async () => {
        const error = new Error('Feishu API failed: 403 Forbidden');
        error.code = 'FEISHU_FORBIDDEN';
        throw error;
      },
    }),
  });
  assert.equal(receipt.probe.state, 'UNAVAILABLE');
  assert.equal(receipt.probe.code, 'FEISHU_FORBIDDEN', '探测器的错误码要原样带出来，不能改写成一个笼统的失败');
  assert.match(receipt.probe.reason, /403 Forbidden/u);
  assert.equal(receipt.probe.probed, false);
  assert.equal(receipt.outcome, 'PROCEEDED_WITHOUT_PROBE');
  assert.equal(receipt.scheduled, true);
  assert.equal(harness.runs.created, 1);
});

test('探测返回不可识别的状态：不当作空队列，归为 UNAVAILABLE 并留下原始结论', async () => {
  const { receipt, harness } = await schedule({
    module: capabilityModuleOf({ probe: async () => ({ state: 'MAYBE', candidateCount: 0 }) }),
  });
  assert.equal(receipt.probe.state, 'UNAVAILABLE');
  assert.equal(receipt.probe.code, 'PROBE_STATE_UNKNOWN');
  assert.match(receipt.probe.reason, /MAYBE/u);
  assert.deepEqual(receipt.probe.detail, { state: 'MAYBE', candidateCount: 0 }, '认不出来的原始结论要留在收据里');
  assert.equal(receipt.scheduled, true, '认不出来的状态绝不能被当成空队列');
  assert.equal(harness.runs.created, 1);
});

test('READY：发起真实运行，收据把运行收据整体带出来', async () => {
  const seen = [];
  const { receipt, harness } = await schedule({
    module: capabilityModuleOf({
      probe: async (args) => {
        seen.push(args);
        return { ...READY };
      },
    }),
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].collectInput, { resultsFile: 'x.json' }, '调用方的采集输入必须原样喂给探测器');
  assert.equal(seen[0].target, 'https://example.feishu.cn/base/appTokenAbc');
  assert.equal(seen[0].expectedRows, 2);
  assert.ok(!Object.hasOwn(seen[0], 'capabilityId'), '探测器不需要被告知自己的 ID：它就在实现里');
  assert.equal(receipt.outcome, 'RAN');
  assert.equal(receipt.scheduled, true);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.queueState, 'READY');
  assert.equal(receipt.queueCode, 'CANDIDATES_READY');
  assert.equal(receipt.candidateCount, 3);
  assert.equal(receipt.humanRequired, false);
  assert.match(receipt.run.runId, /^[0-9a-f-]{8,}$/u);
  assert.equal(receipt.run.mode, 'dry-run');
  assert.equal(receipt.run.collect.rowCount, 2, '运行收据就是运行器返回的那一份，不做二次包装');
  assert.equal(receipt.run.publicationStatus, 'NOT_REQUESTED');
  assert.equal(harness.runs.created, 1);
});

test('EMPTY：跳过且一条运行都没创建，ok=true（没有要做的活不是失败）', async () => {
  const { receipt, harness } = await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...EMPTY }) }) });
  assert.equal(receipt.outcome, 'SKIPPED_EMPTY_QUEUE');
  assert.equal(receipt.scheduled, false);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.humanRequired, false);
  assert.equal(receipt.failureClass, null);
  assert.equal(receipt.run, null);
  assert.equal(receipt.queueCode, 'NO_CANDIDATES');
  assert.equal(receipt.candidateCount, 0);
  assert.equal(receipt.reasons.length, 1);
  assert.equal(harness.runs.created, 0, '空队列不得留下运行记录——这正是这条驱动器存在的理由');
});

test('WAITING_HUMAN：暂停等上游结算，不创建运行，且 ok=false / humanRequired=true', async () => {
  const { receipt, harness } = await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...WAITING }) }) });
  assert.equal(receipt.outcome, 'PAUSED_FOR_HUMAN');
  assert.equal(receipt.scheduled, false);
  assert.equal(receipt.ok, false, '等人工不是「完成」，不能报绿');
  assert.equal(receipt.humanRequired, true);
  assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
  assert.equal(receipt.candidateCount, null, '未结算时候选数是未知，不能编一个 0 出来');
  assert.equal(receipt.probe.detail.state, 'WAITING_HUMAN');
  assert.equal(harness.runs.created, 0);
});

test('forceRun 抑制探测：探测函数一次都没被调用，即使它说空队列也照常发起', async () => {
  let probed = 0;
  const { receipt, harness } = await schedule({
    module: capabilityModuleOf({ probe: async () => { probed += 1; return { ...EMPTY }; } }),
    options: { forceRun: true },
  });
  assert.equal(probed, 0, 'forceRun 的语义就是「别问，跑」');
  assert.equal(receipt.queueCode, 'PROBE_SUPPRESSED');
  assert.equal(receipt.queueState, 'NOT_PROBED');
  assert.equal(receipt.outcome, 'PROCEEDED_WITHOUT_PROBE');
  assert.equal(receipt.scheduled, true);
  assert.equal(harness.runs.created, 1);
});

test('probeOnly：只探测不发起（给排产方用），等人工时退出语义与暂停一致', async () => {
  const ready = await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...READY }) }), options: { probeOnly: true } });
  assert.equal(ready.receipt.outcome, 'PROBED_ONLY');
  assert.equal(ready.receipt.scheduled, false);
  assert.equal(ready.receipt.ok, true);
  assert.equal(ready.receipt.humanRequired, false);
  assert.equal(ready.receipt.candidateCount, 3);
  assert.equal(ready.harness.runs.created, 0);

  const waiting = await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...WAITING }) }), options: { probeOnly: true } });
  assert.equal(waiting.receipt.outcome, 'PROBED_ONLY');
  assert.equal(waiting.receipt.ok, false);
  assert.equal(waiting.receipt.humanRequired, true);
  assert.equal(waiting.harness.runs.created, 0);
});

test('五条出口共用同一组字段，humanRequired 每条路径都在场', async () => {
  const cases = [
    await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...READY }) }) }),
    await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...EMPTY }) }) }),
    await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...WAITING }) }) }),
    await schedule({ module: capabilityModuleOf() }),
    await schedule({ module: capabilityModuleOf({ probe: async () => ({ ...READY }) }), options: { probeOnly: true } }),
  ];
  const seen = new Set();
  for (const item of cases) {
    assert.deepEqual(Object.keys(item.receipt).sort(), [...SCHEDULE_RECEIPT_FIELDS].sort(), '收据字段必须恒等');
    for (const key of SCHEDULE_RECEIPT_FIELDS) {
      assert.ok(Object.hasOwn(item.receipt, key), `${key} 必须存在（undefined 冒充「否」会掩盖漏设置）`);
    }
    assert.equal(typeof item.receipt.humanRequired, 'boolean');
    assert.equal(typeof item.receipt.scheduled, 'boolean');
    seen.add(item.receipt.outcome);
  }
  assert.deepEqual([...seen].sort(), [...SCHEDULE_OUTCOMES].sort(), '出口枚举必须与实际发出的出口一一对应');
});

test('调度器自己的开关不会漏进运行器选项', async () => {
  const stub = stubRunner();
  await schedule({
    module: capabilityModuleOf({ probe: async () => ({ ...READY }) }),
    stub,
    options: { forceRun: false, probeOnly: false, probeOptions: { sneaky: true } },
  });
  const forwarded = stub.calls[0];
  for (const key of ['forceRun', 'probeOnly', 'probe', 'runner']) {
    assert.ok(!Object.hasOwn(forwarded, key), `${key} 是调度器的开关，不许漏进运行器`);
  }
  assert.equal(forwarded.capabilityId, 'fake.cap');
  assert.equal(forwarded.businessKey, 'fake|2026-09-14');
  assert.deepEqual(forwarded.collectInput, { resultsFile: 'x.json' });
});

test('运行未通过时收据如实反映 run.ok 与失败分类，humanRequired 跟着失败分类走', async () => {
  const failed = await schedule({
    module: capabilityModuleOf({ probe: async () => ({ ...READY }) }),
    stub: stubRunner({ ok: false, failureClass: 'EVIDENCE_INVALID', reasons: ['artifact incomplete'] }),
  });
  assert.equal(failed.receipt.outcome, 'RAN');
  assert.equal(failed.receipt.ok, false);
  assert.equal(failed.receipt.failureClass, 'EVIDENCE_INVALID');
  assert.equal(failed.receipt.humanRequired, false);
  assert.deepEqual(failed.receipt.reasons, ['artifact incomplete']);
  assert.equal(failed.receipt.run.ok, false);

  const human = await schedule({
    module: capabilityModuleOf({ probe: async () => ({ ...READY }) }),
    stub: stubRunner({ ok: false, failureClass: 'HUMAN_REQUIRED' }),
  });
  assert.equal(human.receipt.humanRequired, true);
  assert.equal(human.receipt.failureClass, 'HUMAN_REQUIRED');
});

test('归一化是必然步骤且幂等：注入的探测器也要过同一道状态白名单', async () => {
  assert.equal(normalizeProbeResult({ state: 'ready', candidateCount: 3 }).state, 'READY', '大小写不敏感');
  assert.equal(normalizeProbeResult({ state: 'ready', candidateCount: 3 }).probed, true);
  assert.equal(normalizeProbeResult({ state: 'EMPTY', candidateCount: -1 }).candidateCount, null, '负数不是候选数');
  assert.equal(normalizeProbeResult(null).code, 'PROBE_EMPTY_RESULT');
  assert.equal(normalizeProbeResult({ state: 'READY', candidateCount: 1 }).probed, true);

  // 幂等：默认实现产出的「没结论」收据再归一化一遍必须原样。
  const inconclusive = { probed: false, state: 'UNAVAILABLE', code: 'PROBE_LOAD_FAILED', reason: 'boom', probeError: 'boom' };
  const again = normalizeProbeResult(inconclusive);
  assert.equal(again.state, 'UNAVAILABLE');
  assert.equal(again.code, 'PROBE_LOAD_FAILED');
  assert.equal(again.probed, false);
  assert.equal(again.reason, 'boom');

  // 已经归一化过的「有结论」收据同样保持稳定。
  const normalized = normalizeProbeResult({ state: 'EMPTY', code: 'NO_CANDIDATES', reason: 'empty', candidateCount: 0 });
  assert.deepEqual(normalizeProbeResult(normalized), normalized);
});

test('可跳过集合只含「确定没活」的两个状态：把 READY 放进来就是静默漏做', () => {
  assert.deepEqual([...SKIPPABLE_QUEUE_STATES].sort(), ['EMPTY', 'WAITING_HUMAN']);
  for (const state of SKIPPABLE_QUEUE_STATES) {
    assert.ok(QUEUE_STATES.includes(state), `${state} 必须是合法状态`);
  }
  for (const state of ['READY', 'UNAVAILABLE', 'NOT_PROBED']) {
    assert.ok(!SKIPPABLE_QUEUE_STATES.includes(state), `${state} 绝不可跳过`);
  }
});

test('CLI 参数：--probe-only / --force-run 是布尔开关（不吃值），也不给 run profile 添新要求', () => {
  const probe = parseSchedulerArgs(['--capability', 'a', '--probe-only', '--collect-input', '{"x":1}']);
  assert.equal(probe.probeOnly, true);
  assert.equal(probe.forceRun, false);
  assert.equal(probe.capability, 'a');
  assert.equal(probe.collectInput, '{"x":1}');
  assert.equal(probe.businessKey, undefined, 'probe profile 不要求 --business-key');

  const forced = parseSchedulerArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k', '--force-run']);
  assert.equal(forced.forceRun, true);
  assert.equal(forced.probeOnly, false);
  assert.equal(forced.businessKey, 'k');

  // run profile 的原要求一字未改。
  assert.throws(() => parseSchedulerArgs(['--capability', 'a']), /--identity is required/);
  assert.throws(() => parseSchedulerArgs(['--capability', 'a', '--identity', '{}', '--business-key', 'k', '--commit']), /--operator is required with --commit/);
  assert.equal(parseSchedulerArgs(['--help']).help, true);
});

test('退出码映射：完成/无可做之事=0，运行未通过=2，需要人工=3', () => {
  assert.equal(exitCodeFor({ outcome: 'SKIPPED_EMPTY_QUEUE', ok: true, humanRequired: false }), 0);
  assert.equal(exitCodeFor({ outcome: 'PAUSED_FOR_HUMAN', ok: false, humanRequired: true }), 3);
  assert.equal(exitCodeFor({ outcome: 'PROBED_ONLY', ok: true, humanRequired: false }), 0);
  assert.equal(exitCodeFor({ outcome: 'PROBED_ONLY', ok: false, humanRequired: true }), 3);
  assert.equal(exitCodeFor({ outcome: 'RAN', ok: true, humanRequired: false }), 0);
  assert.equal(exitCodeFor({ outcome: 'RAN', ok: false, humanRequired: false }), 2);
});

test('缺 registry / capabilityId 属调用方缺陷，直接抛（不伪装成调度结论）', async () => {
  await assert.rejects(
    () => runScheduled({ capabilityId: 'fake.cap' }),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_INPUT_REQUIRED',
  );
  await assert.rejects(
    () => runScheduled({ registry: makeHarness().registry }),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_INPUT_REQUIRED',
  );
  await assert.rejects(
    () => probeCapabilityQueue({}),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_INPUT_REQUIRED',
  );
});
