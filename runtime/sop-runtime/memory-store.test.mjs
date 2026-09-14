// 阶段 5 配套单测：分层记忆（memory-store）
// 验收对应：作用域/来源/置信度/有效期/退役/冲突处理；历史记忆不能覆盖当前验证结果。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_LAYERS, CURRENT_RUN_LAYERS, LAYER_PRECEDENCE,
  MemoryError, isExpired, isUsable, validateMemory, compareAuthority, resolveConflict,
  resolveMemory, assertNoHistoryOverride, createMemoryPort, createMemoryStore,
} from './memory-store.mjs';

const T0 = '2026-09-14T00:00:00.000Z';
const T1 = '2026-09-15T00:00:00.000Z';
const T2 = '2026-09-16T00:00:00.000Z';

function makeStore(now = T0) {
  return createMemoryStore({ port: createMemoryPort({ nowIso: () => now }) });
}

test('记忆记录必须带合法层级、作用域和来源', () => {
  assert.deepEqual([...MEMORY_LAYERS], ['RUN_CONTEXT', 'EVIDENCE', 'VERIFIED_FACT', 'RULE_DECISION', 'EXPERIENCE']);
  assert.equal(validateMemory({ layer: 'NOT_A_LAYER', scope: 's', source: 'src', value: 1 }).ok, false);
  assert.equal(validateMemory({ layer: 'EXPERIENCE', source: 'src', value: 1 }).ok, false, '缺作用域必须拒绝');
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', value: 1 }).ok, false, '缺来源必须拒绝');
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', source: 'src', value: 1 }).ok, true);
});

test('置信度必须落在 [0,1]，有效期必须自洽', () => {
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', source: 'x', value: 1, confidence: 1.5 }).ok, false);
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', source: 'x', value: 1, confidence: -0.1 }).ok, false);
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', source: 'x', value: 1, validFrom: T1, validUntil: T0 }).ok, false);
  assert.equal(validateMemory({ layer: 'EXPERIENCE', scope: 's', source: 'x', value: 1, validFrom: T0, validUntil: T1 }).ok, true);
});

test('入库存校验失败即拒绝，不产生半条记录', async () => {
  const store = makeStore();
  await assert.rejects(() => store.put({ layer: 'EXPERIENCE', scope: 's', value: 1 }), (error) => error.code === 'INVALID_MEMORY');
  assert.equal((await store.list()).length, 0);
});

test('按作用域隔离，默认不返回已退役记忆', async () => {
  const store = makeStore();
  await store.put({ layer: 'VERIFIED_FACT', scope: 'weekly/2026-35', topic: 'material', source: 'validator', value: { a: 1 } });
  await store.put({ layer: 'VERIFIED_FACT', scope: 'weekly/2026-36', topic: 'material', source: 'validator', value: { a: 2 } });
  assert.equal((await store.list()).length, 2);

  const retired = await store.put({ layer: 'EXPERIENCE', scope: 'weekly/2026-35', topic: 'stall', source: 'ops', value: { hint: 'x' } });
  await store.retire(retired.memoryId, { reason: 'fixed upstream' });
  assert.equal((await store.list()).length, 2, '退役后默认检索不到');
  assert.equal((await store.list({ includeRetired: true })).length, 3, '退役记忆仍可追溯（不物理删除）');
});

test('有效期过期后不再参与决策', async () => {
  const store = makeStore(T0);
  await store.put({
    layer: 'EXPERIENCE', scope: 'weekly/2026-35', topic: 'risk-control', source: 'ops',
    value: { hint: 'stale' }, validFrom: T0, validUntil: T1,
  });
  const before = await store.resolve({ scope: 'weekly/2026-35', topic: 'risk-control', at: T0 });
  assert.equal(before.source, 'HISTORICAL');
  const after = await store.resolve({ scope: 'weekly/2026-35', topic: 'risk-control', at: T2 });
  assert.equal(after.source, 'NONE', '过期记忆不得被检索');

  const record = { validUntil: T1 };
  assert.equal(isExpired(record, T2), true);
  assert.equal(isUsable({ ...record, retired: false }, T2), false);
});

test('同 scope+topic 下权威更高的新记忆会退役旧记忆，而不是覆盖删除', async () => {
  const store = makeStore();
  const oldFact = await store.put({ layer: 'VERIFIED_FACT', scope: 'weekly/2026-35', topic: 'material-mix', source: 'validator', value: { acrylic: 0.5 }, confidence: 0.9, validFrom: T0 });
  const newFact = await store.put({ layer: 'VERIFIED_FACT', scope: 'weekly/2026-35', topic: 'material-mix', source: 'validator', value: { acrylic: 0.62 }, confidence: 0.95, validFrom: T1 });

  assert.deepEqual(newFact.supersedes, [oldFact.memoryId]);
  const oldRow = await store.get(oldFact.memoryId);
  assert.equal(oldRow.retired, true);
  assert.match(oldRow.retiredReason, /superseded by/);
  const live = await store.list();
  assert.equal(live.length, 1);
  assert.equal(live[0].value.acrylic, 0.62);
});

test('冲突判定顺序固定：层级 -> 置信度 -> 更新时间 -> 标识（不依赖插入顺序）', () => {
  const base = { scope: 's', topic: 't', source: 'x', value: 1, validFrom: T0 };
  const evidence = { ...base, memoryId: 'm-evidence', layer: 'EVIDENCE', confidence: 0.1 };
  const fact = { ...base, memoryId: 'm-fact', layer: 'VERIFIED_FACT', confidence: 0.99 };
  assert.equal(resolveConflict([fact, evidence]).memoryId, 'm-evidence', '当前运行层优先于历史层');

  const older = { ...base, memoryId: 'm-old', layer: 'RULE_DECISION', confidence: 0.8, validFrom: T0 };
  const newer = { ...base, memoryId: 'm-new', layer: 'RULE_DECISION', confidence: 0.8, validFrom: T1 };
  assert.equal(resolveConflict([older, newer]).memoryId, 'm-new');

  const a = { ...base, memoryId: 'm-a', layer: 'EXPERIENCE', confidence: 0.5 };
  const b = { ...base, memoryId: 'm-b', layer: 'EXPERIENCE', confidence: 0.5 };
  assert.equal(compareAuthority(a, b), 'm-a'.localeCompare('m-b'));
  assert.equal(resolveConflict([b, a]).memoryId, resolveConflict([a, b]).memoryId, '结果与插入顺序无关');
  assert.equal(resolveConflict([]), null);
});

test('当前 run 证据优先，历史层一律被覆盖（含被标记为 overridden）', async () => {
  const store = makeStore();
  await store.put({ layer: 'EXPERIENCE', scope: 'weekly/2026-35', topic: 'material-mix', source: 'ops', value: { acrylic: 0.4 }, confidence: 0.9 });
  await store.put({ layer: 'RULE_DECISION', scope: 'weekly/2026-35', topic: 'material-mix', source: 'adr', value: { acrylic: 0.55 }, confidence: 0.9 });
  await store.put({ layer: 'EVIDENCE', scope: 'weekly/2026-35', topic: 'material-mix', source: 'validator', value: { acrylic: 0.62 }, confidence: 0.6 });

  const resolved = await store.resolve({ scope: 'weekly/2026-35', topic: 'material-mix', at: T0 });
  assert.equal(resolved.source, 'CURRENT_RUN');
  assert.equal(resolved.record.layer, 'EVIDENCE');
  assert.equal(resolved.record.value.acrylic, 0.62);
  assert.equal(resolved.overridden.length, 2, '历史规则与经验都被覆盖');

  // 也可以显式传入当前证据
  const explicit = await store.resolve({ scope: 'weekly/2026-35', topic: 'material-mix', currentEvidence: { source: 'readback', value: { acrylic: 0.7 }, evidenceDigest: 'd'.repeat(64) } });
  assert.equal(explicit.record.value.acrylic, 0.7);
  assert.equal(explicit.record.evidenceDigest, 'd'.repeat(64));
});

test('把历史记忆当作当前事实会失败关闭', () => {
  const history = [{ memoryId: 'm-1', layer: 'EXPERIENCE', value: { verdict: 'A' } }];
  assert.throws(
    () => assertNoHistoryOverride({ current: { value: { verdict: 'B' } }, history }),
    (error) => error instanceof MemoryError && error.code === 'HISTORY_OVERRIDE_FORBIDDEN',
  );
  assert.equal(assertNoHistoryOverride({ current: { value: 1 }, history: [] }).ok, true);
  assert.equal(assertNoHistoryOverride({ current: null, history }).ok, true, '没有当前证据时历史只作兜底，不构成覆盖');
});

test('记忆带证据摘要时可追溯来源', async () => {
  const store = makeStore();
  const digest = 'c'.repeat(64);
  const row = await store.put({
    layer: 'VERIFIED_FACT', scope: 'weekly/2026-35', topic: 'row-count', source: 'validator',
    value: { rows: 1462 }, evidenceDigest: digest, runId: '11111111-1111-4111-8111-111111111111',
  });
  const loaded = await store.get(row.memoryId);
  assert.equal(loaded.evidenceDigest, digest);
  assert.equal(loaded.runId, '11111111-1111-4111-8111-111111111111');
});

test('当前运行层的定义与优先级保持稳定', () => {
  assert.deepEqual([...CURRENT_RUN_LAYERS], ['RUN_CONTEXT', 'EVIDENCE']);
  assert.ok(LAYER_PRECEDENCE.EVIDENCE > LAYER_PRECEDENCE.VERIFIED_FACT);
  assert.ok(LAYER_PRECEDENCE.VERIFIED_FACT > LAYER_PRECEDENCE.RULE_DECISION);
  assert.ok(LAYER_PRECEDENCE.RULE_DECISION > LAYER_PRECEDENCE.EXPERIENCE);
});
