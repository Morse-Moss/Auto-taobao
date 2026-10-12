import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RECEIPT_SCHEMA_VERSION,
  EXECUTION_STATUSES,
  EVIDENCE_STATUSES,
  HUMAN_GATE_STATUSES,
  LEASE_STATUSES,
  PUBLICATION_STATUSES,
  FAILURE_CLASSES,
  createRunReceipt,
  appendBatch,
  appendStep,
  appendArtifact,
  finalizeRunReceipt,
  validateRunReceipt,
  writeRunReceipt
} from './run-receipt-v1.mjs';

// 测试临时目录：node:os tmpdir + 随机子目录，结束后统一清理（recursive force，包 try/catch）。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `run-receipt-v1-${crypto.randomUUID().slice(0, 8)}-`));

function makeReceipt(overrides = {}) {
  return createRunReceipt({
    workflow: 'promotion-daily',
    workflowVersion: '1.0.0',
    targetDate: '2026-10-09',
    mode: 'apply',
    batchSize: 5,
    ...overrides
  });
}

test('constants are frozen closed sets matching spec', () => {
  assert.equal(RECEIPT_SCHEMA_VERSION, 'run-receipt-v1');
  assert.ok(Object.isFrozen(EXECUTION_STATUSES));
  assert.ok(Object.isFrozen(EVIDENCE_STATUSES));
  assert.ok(Object.isFrozen(HUMAN_GATE_STATUSES));
  assert.ok(Object.isFrozen(LEASE_STATUSES));
  assert.ok(Object.isFrozen(PUBLICATION_STATUSES));
  assert.ok(Object.isFrozen(FAILURE_CLASSES));
  assert.deepEqual(EXECUTION_STATUSES, ['QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED']);
  assert.ok(FAILURE_CLASSES.includes('COMMIT_UNKNOWN'));
});

test('legal skeleton creates and validates clean', () => {
  const receipt = makeReceipt();
  assert.equal(receipt.execution, 'RUNNING');
  assert.equal(receipt.failureClass, null);
  assert.deepEqual(receipt.batches, []);
  assert.deepEqual(receipt.shops, []);
  assert.deepEqual(receipt.artifacts, []);
  assert.ok(receipt.startedAt);
  assert.equal(receipt.finishedAt, undefined);
  assert.match(receipt.runId, /^promotion-daily-2026-10-09-/);
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('runId can be supplied and is used verbatim', () => {
  const receipt = makeReceipt({ runId: 'my-run-1' });
  assert.equal(receipt.runId, 'my-run-1');
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('rejects one illegal value per status axis (execution/evidence/humanGate/lease/publication sets are closed)', () => {
  assert.throws(() => createRunReceipt({ workflow: '', workflowVersion: '1.0.0', targetDate: '2026-10-09', mode: 'apply', batchSize: 1 }), /invalid workflow/);
  assert.throws(() => makeReceipt({ mode: 'force' }), /invalid mode/);
  assert.throws(() => makeReceipt({ batchSize: 0 }), /invalid batchSize/);
  assert.throws(() => makeReceipt({ targetDate: '2026/10/09' }), /invalid targetDate/);
  assert.throws(() => makeReceipt({ workflowVersion: 'v1' }), /invalid workflow.version/);
  assert.throws(() => appendBatch(makeReceipt(), { index: 0, execution: 'DONE' }), /invalid batch execution/);
  assert.throws(() => appendBatch(makeReceipt(), { index: -1 }), /invalid batch index/);
  const withBatch = appendBatch(makeReceipt(), { index: 0, shops: ['盖文淘宝'] });
  assert.throws(() => appendStep(withBatch, 0, { name: 'publish', execution: 'OK' }), /invalid step execution/);
  assert.throws(() => appendStep(withBatch, 0, { name: 'publish', publication: 'WROTE' }), /invalid step publication/);
  assert.throws(() => appendStep(withBatch, 0, { name: 'publish', evidence: ['ok', 3] }), /evidence must be string\[\]/);
  assert.throws(() => appendBatch(makeReceipt(), { index: 0, release: { requested: true, observed: true, status: 'FREE' } }), /invalid release.status/);
});

test('appendStep throws on out-of-range batchIndex', () => {
  const receipt = appendBatch(makeReceipt(), { index: 1 });
  assert.throws(() => appendStep(receipt, 0, { name: 'x' }), /batchIndex out of range/);
  assert.throws(() => appendStep(receipt, 99, { name: 'x' }), /batchIndex out of range/);
});

test('dry-run shape is legal: execution SUCCEEDED + publication NOT_REQUESTED coexist', () => {
  const receipt = createRunReceipt({ workflow: 'promotion-daily', workflowVersion: '1.0.0', targetDate: '2026-10-09', mode: 'dry-run', batchSize: 5 });
  appendBatch(receipt, { index: 1, shops: ['盖文淘宝'], execution: 'SUCCEEDED' });
  appendStep(receipt, 1, { name: 'collect-keyword', execution: 'SUCCEEDED', evidence: [] });
  appendStep(receipt, 1, { name: 'publish', execution: 'SUCCEEDED', publication: 'NOT_REQUESTED' });
  finalizeRunReceipt(receipt, { execution: 'SUCCEEDED' });
  assert.equal(receipt.batches[0].steps[1].publication, 'NOT_REQUESTED');
  assert.equal(receipt.execution, 'SUCCEEDED');
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('finalize sets finishedAt, rejects illegal execution/failureClass/finishedAt', () => {
  const receipt = makeReceipt();
  finalizeRunReceipt(receipt, { execution: 'FAILED', failureClass: 'TRANSIENT_EXTERNAL', finishedAt: '2026-10-10T00:30:00Z' });
  assert.equal(receipt.finishedAt, '2026-10-10T00:30:00Z');
  assert.deepEqual(validateRunReceipt(receipt), []);
  assert.throws(() => finalizeRunReceipt(makeReceipt(), { execution: 'DONE' }), /invalid execution/);
  assert.throws(() => finalizeRunReceipt(makeReceipt(), { execution: 'FAILED', failureClass: 'SOMETHING_ELSE' }), /invalid failureClass/);
  assert.throws(() => finalizeRunReceipt(makeReceipt(), { execution: 'FAILED', finishedAt: '10/10/2026' }), /invalid finishedAt/);
});

test('validateRunReceipt rejects one illegal value on each of the five axes', () => {
  // 1) execution 轴
  assert.ok(validateRunReceipt({ ...makeReceipt(), execution: 'DONE' }).some((e) => e.includes('top-level execution invalid')));
  const r2 = makeReceipt();
  appendBatch(r2, { index: 1 });
  r2.batches[0].execution = 'PARTIAL';
  assert.ok(validateRunReceipt(r2).some((e) => e.includes('batches[0].execution invalid')));
  // 2) evidence 轴：evidence 是字符串数组，用数组混入非字符串表达非法
  const r3 = makeReceipt();
  appendBatch(r3, { index: 1 });
  appendStep(r3, 1, { name: 'collect', evidence: ['a'] });
  r3.batches[0].steps[0].evidence = ['a', 42];
  assert.ok(validateRunReceipt(r3).some((e) => e.includes('steps[0].evidence must be string[]')));
  // 3) humanGate 轴：闭合集仅由常量表达，非法值不得混入（校验集冻结且不含任意串）
  assert.ok(!HUMAN_GATE_STATUSES.includes('WAITING_FOR_APPROVAL'));
  assert.ok(!EVIDENCE_STATUSES.includes('MAYBE'));
  // 4) lease 轴：release.status 闭合集（先合法构造，再改坏，走 validate 而非 append 的前置抛错）
  const r4 = makeReceipt();
  appendBatch(r4, { index: 1, release: { requested: true, observed: false, status: 'HELD' } });
  r4.batches[0].release.status = 'HALF';
  assert.ok(validateRunReceipt(r4).some((e) => e.includes('release.status must be one of RELEASED/HELD/PARTIAL/UNKNOWN')));
  // 5) publication 轴
  const r5 = makeReceipt();
  appendBatch(r5, { index: 1 });
  r5.batches[0].steps.push({ name: 'publish', execution: 'SUCCEEDED', publication: 'WROTE' });
  assert.ok(validateRunReceipt(r5).some((e) => e.includes('publication invalid')));
});

test('validateRunReceipt rejects illegal failureClass with a pointed message', () => {
  const errors = validateRunReceipt({ ...makeReceipt(), failureClass: 'MYSTERY' });
  assert.ok(errors.some((e) => e.includes('failureClass must be null or one of')));
});

test('validateRunReceipt flags corrupted schemaVersion by name', () => {
  const errors = validateRunReceipt({ ...makeReceipt(), schemaVersion: 'run-receipt-v2' });
  assert.ok(errors.some((e) => e.includes('schemaVersion must be exactly "run-receipt-v1"')));
});

// ── 2026-10-10 对抗审查整改（A3/B）：appendArtifact 结构化 + 跨轴校验 ──────────

const GOOD_ARTIFACT = Object.freeze({
  path: 'evidence/batches-2026-10-09/batches.json',
  size: 1024,
  sha256: 'a'.repeat(64),
});

test('appendArtifact 只收 { path, size, sha256 } 形对象（裸字符串/坏形状当场点名拒绝）', () => {
  const receipt = makeReceipt();
  appendArtifact(receipt, { ...GOOD_ARTIFACT });
  assert.deepEqual(receipt.artifacts, [{ ...GOOD_ARTIFACT }]);
  assert.deepEqual(validateRunReceipt(receipt), []);
  // 旧签名（裸字符串路径）不再合法：丢掉 size/哈希两条证据轴的形态要被拒。
  assert.throws(() => appendArtifact(makeReceipt(), GOOD_ARTIFACT.path),
    /invalid artifact: must be \{ path, size, sha256 \}/);
  assert.throws(() => appendArtifact(makeReceipt(), { path: 'x', size: -1, sha256: 'a'.repeat(64) }),
    /invalid artifact\.size/);
  assert.throws(() => appendArtifact(makeReceipt(), { path: 'x', size: 1, sha256: 'zz'.repeat(32) }),
    /invalid artifact\.sha256/);
});

test('validateRunReceipt 拒绝非字符串 shop 元素（点名到下标）', () => {
  const receipt = makeReceipt();
  receipt.shops.push('盖文淘宝', { shop: '网林天猫' });
  const errors = validateRunReceipt(receipt);
  assert.ok(errors.some((e) => e.includes('shops[1] must be a non-empty string')),
    `要点名 shops[1]。实际：\n${errors.join('\n')}`);
});

test('validateRunReceipt 拒绝坏形状 artifact 元素（字符串/缺 sha256/非 64 位十六进制）', () => {
  const r1 = makeReceipt();
  r1.artifacts.push('evidence/batches.json');
  assert.ok(validateRunReceipt(r1).some((e) => e.includes('artifacts[0] must be { path, size, sha256 }')));
  const r2 = makeReceipt();
  r2.artifacts.push({ path: 'x', size: 1 });
  assert.ok(validateRunReceipt(r2).some((e) => e.includes('artifacts[0].sha256 must be 64 hex chars')));
  const r3 = makeReceipt();
  r3.artifacts.push({ path: 'x', size: 1.5, sha256: 'a'.repeat(64) });
  assert.ok(validateRunReceipt(r3).some((e) => e.includes('artifacts[0].size must be a non-negative integer')));
});

test('跨轴校验：execution=SUCCEEDED 而 shops 非空 ⇒ 点名拒绝（writeRunReceipt 拒落盘）', () => {
  const receipt = makeReceipt();
  appendBatch(receipt, { index: 1, shops: ['盖文淘宝'], execution: 'SUCCEEDED' });
  finalizeRunReceipt(receipt, { execution: 'SUCCEEDED' });
  receipt.shops.push('盖文淘宝');
  const errors = validateRunReceipt(receipt);
  assert.ok(errors.some((e) => e.includes('execution SUCCEEDED requires shops to be empty')),
    `要点名 shops 互斥。实际：\n${errors.join('\n')}`);
  const file = path.join(tmpRoot, 'succeeded-with-shops.json');
  assert.throws(() => writeRunReceipt(file, receipt), /refusing to write invalid run receipt/);
  assert.equal(fs.existsSync(file), false);
});

test('跨轴校验：execution=SUCCEEDED 而 failureClass 非 null ⇒ 点名拒绝', () => {
  const receipt = makeReceipt();
  finalizeRunReceipt(receipt, { execution: 'SUCCEEDED' });
  receipt.failureClass = 'HUMAN_REQUIRED';
  const errors = validateRunReceipt(receipt);
  assert.ok(errors.some((e) => e.includes('execution SUCCEEDED requires failureClass to be null')),
    `要点名 failureClass 互斥。实际：\n${errors.join('\n')}`);
});

test('合法组合不受跨轴校验误伤：FAILED+shops 非空、SUCCEEDED+空 shops 都过', () => {
  const failed = makeReceipt();
  appendBatch(failed, { index: 1, shops: ['盖文淘宝'], execution: 'FAILED' });
  finalizeRunReceipt(failed, { execution: 'FAILED', failureClass: 'HUMAN_REQUIRED' });
  failed.shops.push('盖文淘宝');
  assert.deepEqual(validateRunReceipt(failed), []);
  const ok = makeReceipt();
  appendBatch(ok, { index: 1, shops: ['盖文淘宝'], execution: 'SUCCEEDED' });
  appendArtifact(ok, { ...GOOD_ARTIFACT });
  finalizeRunReceipt(ok, { execution: 'SUCCEEDED' });
  assert.deepEqual(validateRunReceipt(ok), []);
});

test('writeRunReceipt round-trips to deep-equal object on disk', () => {
  const receipt = makeReceipt({ runId: 'roundtrip-1' });
  appendBatch(receipt, { index: 1, shops: ['盖文淘宝'], execution: 'SUCCEEDED', release: { requested: true, observed: true, status: 'RELEASED' } });
  appendStep(receipt, 1, { name: 'collect-keyword', execution: 'SUCCEEDED', evidence: [] });
  appendStep(receipt, 1, { name: 'publish', execution: 'SUCCEEDED', publication: 'VERIFIED' });
  finalizeRunReceipt(receipt, { execution: 'SUCCEEDED', failureClass: null, finishedAt: '2026-10-10T00:30:00Z' });
  const file = path.join(tmpRoot, 'nested', 'run-receipt.json');
  writeRunReceipt(file, receipt);
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(loaded, receipt);
});

test('writeRunReceipt refuses to write invalid receipt to disk', () => {
  const bad = makeReceipt();
  bad.schemaVersion = 'legacy-v0';
  const file = path.join(tmpRoot, 'should-not-exist.json');
  assert.throws(() => writeRunReceipt(file, bad), /refusing to write invalid run receipt/);
  assert.equal(fs.existsSync(file), false);
});

test('spec §6.2 example shape validates clean', () => {
  const receipt = {
    schemaVersion: 'run-receipt-v1',
    runId: 'promotion-daily-2026-10-09-abc123',
    workflow: { id: 'promotion-daily', version: '1.0.0' },
    targetDate: '2026-10-09',
    mode: 'apply',
    batchSize: 5,
    execution: 'SUCCEEDED',
    batches: [
      {
        index: 1,
        shops: ['盖文淘宝'],
        execution: 'SUCCEEDED',
        steps: [
          { name: 'collect-keyword', execution: 'SUCCEEDED', evidence: [] },
          { name: 'collect-audience', execution: 'SUCCEEDED', evidence: [] },
          { name: 'publish', execution: 'SUCCEEDED', publication: 'VERIFIED' }
        ],
        release: { requested: true, observed: true, status: 'RELEASED' }
      }
    ],
    shops: [],
    artifacts: [],
    failureClass: null,
    startedAt: '2026-10-10T00:00:00Z',
    finishedAt: '2026-10-10T00:30:00Z'
  };
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论；tmpdir 由系统回收。
  }
});

// ---------------------------------------------------------------------------
// codeFingerprint（2026-10-12 加，HEAD-VS-WORKTREE 事故止血第 3 件）
// 钉三件事：① 合法指纹原样入回执且过校验；② 半截/坏形状当场点名拒绝
// （半截指纹比没有更误导）；③ 缺省 null 合法（老回执与采集失败不许被罚）。
// ---------------------------------------------------------------------------
test('codeFingerprint：合法指纹原样入回执并通过校验', () => {
  const fp = { gitHead: 'a'.repeat(40), dirtyCount: 3, dirtySha256: 'b'.repeat(64) };
  const receipt = makeReceipt({ codeFingerprint: fp });
  assert.deepEqual(receipt.codeFingerprint, fp);
  assert.deepEqual(validateRunReceipt(receipt), []);
});

test('codeFingerprint：半截/坏形状在 create 与 validate 两处都要被点名拒绝', () => {
  assert.throws(() => makeReceipt({ codeFingerprint: { gitHead: 'a'.repeat(40) } }),
    /invalid codeFingerprint/u, '缺 dirtyCount/dirtySha256 的半截指纹要在构造期拒');
  assert.throws(() => makeReceipt({ codeFingerprint: { gitHead: 'short', dirtyCount: 0, dirtySha256: null } }),
    /invalid codeFingerprint/u, 'gitHead 不是 40 hex 要拒');
  const bad = makeReceipt();
  bad.codeFingerprint = { gitHead: null, dirtyCount: -1, dirtySha256: null };
  const errors = validateRunReceipt(bad);
  assert.ok(errors.some((e) => e.includes('codeFingerprint')), '负数 dirtyCount 要在校验期被点名');
});

test('codeFingerprint：缺省 null 合法（采集失败/老回执不许被罚）', () => {
  const receipt = makeReceipt();
  assert.equal(receipt.codeFingerprint, null);
  assert.deepEqual(validateRunReceipt(receipt), []);
});
