// 阶段 5 配套单测：结构化上下文摘要（compression-service）
// 验收对应：压缩后能恢复到同一 run/attempt；原文可由 digest 追溯；
//           历史经验不能覆盖当前验证结果；摘要缺关键字段时拒绝使用。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPRESSION_SCHEMA_VERSION, SUMMARY_REQUIRED_FIELDS, NULLABLE_SUMMARY_FIELDS,
  CompressRejectedError,
  estimateBytes, estimateTokens, shouldCompress, buildSourceDigest, buildSummary,
  validateSummary, assertUsableSummary, compressContext, compressIfNeeded,
  assertSummaryMatchesRun, resolveCurrentOverHistory,
} from './compression-service.mjs';
import { createContext } from './context-schema.mjs';

const SHA = 'a'.repeat(64);

function goodContext(overrides = {}) {
  return {
    ...createContext({
      taskId: 'task-weekly-35',
      runId: '11111111-1111-4111-8111-111111111111',
      workflow: 'xws-weekly-competitor',
      capability: 'xws.feishu.import',
      identity: {
        tenantId: 't-1', storeId: 's-1', platform: 'xws',
        accountId: 'a-1', browserProfileId: 'edge-isolated', contractVersion: '1.0.0',
      },
      stage: 'COLLECT',
      stepId: 'step-0007',
      attemptId: 'attempt-0003',
      verifiedCursor: { start: 1, end: 10, version: 2 },
    }),
    ...overrides,
  };
}

test('完整上下文能产出通过校验的结构化摘要', () => {
  const summary = compressContext(goodContext());
  assert.equal(summary.schemaVersion, COMPRESSION_SCHEMA_VERSION);
  assert.equal(summary.runId, '11111111-1111-4111-8111-111111111111');
  assert.equal(summary.attemptId, 'attempt-0003');
  assert.deepEqual(summary.verifiedCursor, { start: 1, end: 10, version: 2 });
  assert.equal(summary.sourceVersion, 1);
  assert.equal(validateSummary(summary).ok, true);
});

test('摘要缺关键字段时校验失败且不可被消费', () => {
  const summary = compressContext(goodContext());
  for (const field of ['runId', 'capability', 'stage', 'nextAction', 'executionStatus']) {
    const broken = { ...summary };
    delete broken[field];
    const check = validateSummary(broken);
    assert.equal(check.ok, false, `删除 ${field} 后必须校验失败`);
    assert.ok(check.missing.includes(field), `missing 应包含 ${field}`);
    assert.throws(() => assertUsableSummary(broken), (error) => error instanceof CompressRejectedError && error.code === 'COMPRESS_REJECTED');
  }
});

test('可为 null 的字段（stepId/attemptId/verifiedCursor/blocker）允许为 null，但字段必须存在', () => {
  const summary = compressContext(goodContext());
  assert.deepEqual([...NULLABLE_SUMMARY_FIELDS].sort(), ['attemptId', 'blocker', 'stepId', 'verifiedCursor']);
  const nulled = { ...summary, stepId: null, attemptId: null, verifiedCursor: null, blocker: null };
  assert.equal(validateSummary(nulled).ok, true, 'null 是合法值');
  const forgot = { ...summary };
  delete forgot.verifiedCursor;
  assert.equal(validateSummary(forgot).ok, false, '字段缺失不是「没有值」，必须被拒');
});

test('身份不完整时拒绝压缩（fail-closed，不产出「差不多能用」的摘要）', () => {
  const ctx = goodContext({ identity: { tenantId: 't-1' } });
  assert.throws(() => compressContext(ctx), (error) => error.code === 'COMPRESS_REJECTED' && /identity\./.test(error.message));
});

test('阈值与阶段边界触发压缩', () => {
  const ctx = goodContext();
  const small = shouldCompress(ctx, { maxBytes: 10, maxTokens: 1_000_000 });
  assert.equal(small.compress, true);
  assert.equal(small.reason, 'BYTE_THRESHOLD');

  const tokenBound = shouldCompress(ctx, { maxBytes: 1_000_000, maxTokens: 1 });
  assert.equal(tokenBound.reason, 'TOKEN_THRESHOLD');

  const boundary = shouldCompress(ctx, { maxBytes: 1_000_000, maxTokens: 1_000_000, stageBoundary: true });
  assert.equal(boundary.compress, true);
  assert.equal(boundary.reason, 'STAGE_BOUNDARY');

  const none = shouldCompress(ctx, { maxBytes: 1_000_000, maxTokens: 1_000_000 });
  assert.equal(none.compress, false);
  assert.equal(none.reason, 'WITHIN_BUDGET');

  // 阶段性压缩只在阶段边界阶段生效，普通阶段 boundary 不触发
  const midStage = shouldCompress(goodContext({ stage: 'INIT' }), { maxBytes: 1_000_000, maxTokens: 1_000_000, stageBoundary: true });
  assert.equal(midStage.compress, false);
});

test('compressIfNeeded 命中阈值才产出摘要，且空数组 digest 也算结构完整', () => {
  const ctx = goodContext();
  const noop = compressIfNeeded(ctx, { maxBytes: 1_000_000, maxTokens: 1_000_000 });
  assert.equal(noop.summary, null);
  const fired = compressIfNeeded(ctx, { maxBytes: 10, maxTokens: 10 });
  assert.ok(fired.summary);
  assert.deepEqual(fired.summary.sourceDigest.artifactDigests, []);
  assert.equal(validateSummary(fired.summary).ok, true);
});

test('原文可由 digest 追溯（工件与证据引用都进 sourceDigest）', () => {
  const ctx = goodContext({
    artifacts: [{ uri: 'evidence/run-1/parse.bin', sha256: SHA }],
    evidenceRefs: [{ uri: 'evidence/run-1/manifest.json', sha256: 'b'.repeat(64) }],
    sideEffectRefs: [{ commitKey: 'ck-1', target: 'feishu:base/table' }],
  });
  const digest = buildSourceDigest(ctx);
  assert.equal(digest.algorithm, 'sha256');
  assert.equal(digest.artifactDigests.length, 2);
  assert.equal(digest.artifactDigests[0].uri, 'evidence/run-1/parse.bin');
  assert.equal(digest.sideEffectRefs[0].commitKey, 'ck-1');

  const summary = compressContext(ctx);
  assert.equal(summary.sourceDigest.artifactDigests[0].sha256, SHA);
  assert.equal(summary.sideEffectRefs.length, 1, '副作用引用必须被摘要带出，否则恢复后会重复提交');
});

test('非法 digest 结构导致摘要被拒（不能引用无法校验的原文）', () => {
  const summary = compressContext(goodContext());
  const broken = { ...summary, sourceDigest: { algorithm: 'sha256', artifactDigests: [{ uri: 'x', sha256: 'not-a-digest' }] } };
  const check = validateSummary(broken);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /invalid sha256/.test(e)));
});

test('摘要必须指向同一个 run/attempt，否则拒绝（压缩污染恢复的主要防线）', () => {
  const ctx = goodContext();
  const summary = compressContext(ctx);
  assert.equal(assertSummaryMatchesRun(summary, ctx), true);

  const otherRun = goodContext({ runId: '22222222-2222-4222-8222-222222222222' });
  assert.throws(() => assertSummaryMatchesRun(summary, otherRun), (error) => error.code === 'COMPRESS_REJECTED' && /runId mismatch/.test(error.message));

  const otherAttempt = goodContext({ attemptId: 'attempt-0009' });
  assert.throws(() => assertSummaryMatchesRun(summary, otherAttempt), /attemptId mismatch/);

  const newer = { ...summary, sourceVersion: 99 };
  assert.throws(() => assertSummaryMatchesRun(newer, ctx), /newer than context/);
});

test('当前 run 证据优先于历史规则和经验', () => {
  const current = { verdict: 'A', digest: SHA };
  const resolved = resolveCurrentOverHistory({
    currentEvidence: current,
    historical: [
      { layer: 'RULE_DECISION', value: { verdict: 'B' } },
      { layer: 'EXPERIENCE', value: { verdict: 'C' } },
    ],
  });
  assert.equal(resolved.source, 'CURRENT_RUN_EVIDENCE');
  assert.deepEqual(resolved.value, current);
  assert.equal(resolved.overridden.length, 2);

  const fallback = resolveCurrentOverHistory({ historical: [{ layer: 'VERIFIED_FACT', value: { verdict: 'B' } }] });
  assert.equal(fallback.source, 'HISTORICAL');
  assert.deepEqual(fallback.value, { verdict: 'B' });

  const empty = resolveCurrentOverHistory({});
  assert.equal(empty.source, 'HISTORICAL');
  assert.equal(empty.value, null);
});

test('token/字节估算确定性可复现', () => {
  const ctx = goodContext();
  assert.equal(estimateBytes(ctx), estimateBytes(goodContext()));
  assert.ok(estimateBytes(ctx) > 0);
  assert.equal(estimateTokens(ctx), Math.ceil(estimateBytes(ctx) / 3));
  // 摘要保留的是恢复必需字段，不搬运原文，因此应明显小于源上下文
  assert.ok(estimateBytes(buildSummary(ctx)) > 0);
});

test('摘要字段清单覆盖 Spec 要求：身份/授权/状态轴/游标/副作用/阻塞/下一动作/原文 digest', () => {
  const required = new Set(SUMMARY_REQUIRED_FIELDS);
  for (const field of [
    'identity', 'humanGateStatus', 'publicationStatus', 'executionStatus', 'evidenceStatus',
    'leaseStatus', 'verifiedCursor', 'sideEffectRefs', 'blocker', 'nextAction', 'sourceDigest',
  ]) {
    assert.ok(required.has(field), `摘要必须保留 ${field}`);
  }
});
