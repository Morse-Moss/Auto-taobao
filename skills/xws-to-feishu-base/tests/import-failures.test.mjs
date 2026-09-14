// 失败分类：确定性拒绝码 → 运行时失败分类。
//
// 这里锁的是一个真实缺陷的修复（2026-09-14 在新租户做写验证时踩到）：
//   import-runner 的周期守卫抛**裸 Error**（没有 code / failureClass）
//   → side-effect-ledger 回落 policy.classifyExternalFailure
//   → 该函数只认 HTTP 状态码与英文关键词，这条消息两样都没有
//   → 归 BUG → actionForFailure('BUG') = STOP_AND_ALERT「bug suspected, stop automation」。
// 于是「调用方漏了 --period-start/--period-end」被汇报成「疑似代码有 bug，停线」，
// 把运维引向排查代码而不是补参数。这与 policy 自己写的意图相反。
//
// 因此本文件不只测「词表长什么样」，还测一个观测面：**同一句消息，挂没挂 code 会得到
// 不同结论**——这条断言就是缺陷的复现，也是修复的证据。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FAILURE_CLASS_BY_CODE, XWS_HEADERS, fatalError, parseBaseUrl, validateSourceHeaders, validateTarget,
} from '../scripts/import-core.mjs';
import { runImport } from '../scripts/import-runner.mjs';
import { createFeishuImportPublisher } from '../scripts/adapter.feishu-import.mjs';
import { FAILURE_CLASS } from '../../../runtime/sop-runtime/context-schema.mjs';
import { actionForFailure, classifyExternalFailure } from '../../../runtime/sop-runtime/policy.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { admitTask } from '../../../runtime/sop-runtime/task-admission.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createCapabilityPublisher } from '../../../runtime/sop-runtime/publication.mjs';
import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';

// 与守卫抛出的那条消息逐字一致（含中文日期字段名与那半句分号），
// 这样「裸 Error 与带 code 的 Error 只差一个属性」才是被真正锁住的事实。
const PERIOD_MESSAGE = 'Target table has date fields (数据开始日期, 数据结束日期, 采集时间) '
  + 'but no --period-start/--period-end given; refusing to create an undated period table';

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

// 一个「空且合同完整」的目标表：16 个源列 + 三个周期日期字段。
// 契约齐全才走得进守卫，所以夹具必须给全，不能只给会被判到的那几个字段。
function targetFields({ withDateFields = true } = {}) {
  const fields = XWS_HEADERS.map((fieldName) => ({
    fieldId: `f-${fieldName}`,
    fieldName,
    type: fieldName === '商品图片' ? 17 : 1,
  }));
  if (withDateFields) {
    for (const fieldName of ['数据开始日期', '数据结束日期', '采集时间']) {
      fields.push({ fieldId: `f-${fieldName}`, fieldName, type: 5 });
    }
  }
  return fields;
}

function sourceRow() {
  return Object.fromEntries(XWS_HEADERS.map((name, index) => [name, name === '序号' ? String(index + 1) : '']));
}

function fakeClient({ fields = targetFields() } = {}) {
  const client = {
    async getRecordCount() { return 0; },
    async listFields() { return fields; },
    async uploadFile() { return null; },
    async batchCreateRecords() { return []; },
    async listRecords() { return []; },
  };
  return client;
}

test('词表里的每个失败分类都是运行时认可的 FAILURE_CLASS', () => {
  assert.equal(Object.isFrozen(FAILURE_CLASS_BY_CODE), true);
  for (const [code, failureClass] of Object.entries(FAILURE_CLASS_BY_CODE)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/u, `code 命名不规范：${code}`);
    assert.ok(FAILURE_CLASS.includes(failureClass), `${code} → ${failureClass} 不是运行时认可的失败分类`);
    // 分类必须能被映射成下一步动作，否则等于把「原因未知」写进了收据。
    assert.doesNotMatch(actionForFailure(failureClass).reason, /^unknown failure class/u, code);
  }
});

test('调用方/目标没准备好的拒绝一律归 POLICY_DENIED，不再被说成代码 bug', () => {
  const policyDenied = [
    'PERIOD_REQUIRED', 'PERIOD_INVALID', 'CLIENT_REQUIRED', 'INPUT_REQUIRED', 'INPUT_NOT_FOUND',
    'BASE_URL_INVALID', 'TARGET_NOT_EMPTY', 'TARGET_IMAGE_FIELD', 'TARGET_FIELDS_MISSING',
  ];
  for (const code of policyDenied) {
    assert.equal(FAILURE_CLASS_BY_CODE[code], 'POLICY_DENIED', code);
    assert.equal(actionForFailure(FAILURE_CLASS_BY_CODE[code]).action, 'FAIL', code);
  }
  // 反向守卫：写后外部行为不符与进程内调用顺序被破坏，都仍然是 BUG（停线交人工）。
  for (const code of ['POST_WRITE_COUNT_MISMATCH', 'POST_WRITE_VERIFY_MISMATCH', 'STAGE_ORDER']) {
    assert.equal(FAILURE_CLASS_BY_CODE[code], 'BUG', code);
    assert.equal(actionForFailure(FAILURE_CLASS_BY_CODE[code]).action, 'STOP_AND_ALERT', code);
  }
});

test('缺陷复现：同一条消息，裸 Error 归 BUG 停线，挂上 code 归策略拒绝', () => {
  const bare = classifyExternalFailure(new Error(PERIOD_MESSAGE));
  assert.equal(bare, 'BUG');
  assert.equal(actionForFailure(bare).action, 'STOP_AND_ALERT');

  const coded = fatalError('PERIOD_REQUIRED', PERIOD_MESSAGE);
  assert.equal(coded.failureClass, 'POLICY_DENIED');
  assert.equal(actionForFailure(coded.failureClass).action, 'FAIL');
});

test('fatalError 同时挂上 code 与 failureClass，且不改动消息本身', () => {
  const error = fatalError('TARGET_NOT_EMPTY', 'Target table must be empty; found 3 records', { recordCount: 3 });
  assert.equal(error.message, 'Target table must be empty; found 3 records');
  assert.equal(error.code, 'TARGET_NOT_EMPTY');
  assert.equal(error.failureClass, 'POLICY_DENIED');
  assert.deepEqual(error.details, { recordCount: 3 });
  // 没有 details 时不塞空对象：收据里「没有这条信息」与「这条信息是 {}」不是一回事。
  assert.equal(Object.hasOwn(fatalError('STAGE_ORDER', 'x'), 'details'), false);
});

test('未登记的 code 立刻抛错，不许悄悄退回默认分类器', () => {
  assert.throws(() => fatalError('NOT_REGISTERED', 'x'), /unregistered failure code: NOT_REGISTERED/u);
});

test('合同类拒绝各自带上自己的 code（表头 / 目标 / URL / 单元格值）', () => {
  assert.equal(codeOf(() => validateSourceHeaders(['x'])), 'SOURCE_HEADERS');
  assert.equal(codeOf(() => validateSourceHeaders([...XWS_HEADERS].with(5, '付款人数X'))), 'SOURCE_HEADERS');
  assert.equal(codeOf(() => parseBaseUrl('')), 'BASE_URL_INVALID');
  assert.equal(codeOf(() => parseBaseUrl('not a url')), 'BASE_URL_INVALID');
  assert.equal(codeOf(() => parseBaseUrl('https://example.feishu.cn/base/base1')), 'BASE_URL_INVALID');
  assert.equal(codeOf(() => validateTarget({ recordCount: 2, fields: [] })), 'TARGET_NOT_EMPTY');
  assert.equal(
    codeOf(() => validateTarget({ recordCount: 0, fields: [{ fieldName: '商品图片', type: 2 }] })),
    'TARGET_IMAGE_FIELD',
  );
  const partial = targetFields().filter((field) => field.fieldName !== '卖点');
  assert.equal(codeOf(() => validateTarget({ recordCount: 0, fields: partial })), 'TARGET_FIELDS_MISSING');
});

test('周期守卫的失败经**真**提交账本落成 POLICY_DENIED，而不是 BUG', async () => {
  // 真入口：不构造致命错误，直接跑运行时用的那个 runImport。
  const thrown = await runImport({
    manifest: { headers: [...XWS_HEADERS], rows: [sourceRow()], images: [] },
    client: fakeClient(),
    commit: true,
  }).then(() => null, (error) => error);

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.code, 'PERIOD_REQUIRED');
  assert.equal(thrown.failureClass, 'POLICY_DENIED');
  assert.equal(thrown.message, PERIOD_MESSAGE);
  assert.deepEqual(thrown.details.dateFields, ['数据开始日期', '数据结束日期', '采集时间']);

  // 真账本：这一层原来读不到 failureClass，只会回落到 classifyExternalFailure。
  const store = createMemoryStore();
  const ledger = createSideEffectLedger({ store });
  const prepared = await ledger.prepare({
    runId: 'run-period-guard-1',
    target: 'https://example.feishu.cn/base/base1?table=table1',
    businessKey: 'period-guard',
  });
  const committed = await ledger.commit({
    commitKey: prepared.commitKey,
    businessKey: 'period-guard',
    handler: async () => { throw thrown; },
  });

  assert.equal(committed.status, 'FAILED');
  assert.equal(committed.failureClass, 'POLICY_DENIED');
  assert.equal(actionForFailure(committed.failureClass).action, 'FAIL');

  const persisted = await store.loadCommit(prepared.commitKey);
  assert.equal(persisted.failureClass, 'POLICY_DENIED');
  assert.match(persisted.error, /refusing to create an undated period table/u);
});

test('发布段钩子（生产路径上的那个 handler）原样交出 code 与 failureClass', async () => {
  const artifactBytes = Buffer.from(JSON.stringify({
    headers: [...XWS_HEADERS],
    rows: [sourceRow()],
    images: [],
  }), 'utf8');
  const hooks = createFeishuImportPublisher({ client: fakeClient(), artifactBytes, period: null });

  const error = await hooks.handler().then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'PERIOD_REQUIRED');
  assert.equal(error.failureClass, 'POLICY_DENIED');
});

test('适配器把能力的失败码词表暴露出来（与另三个适配器同一位置）', async () => {
  const adapter = await import('../scripts/adapter.feishu-import.mjs');
  assert.equal(adapter.FAILURE_CLASS_BY_CODE, FAILURE_CLASS_BY_CODE);
});

// 收据级复现：这一条测的字段，就是 2026-09-14 那次真机演练里写错的那个。
// 当天收据的 `blocker.class` 是 `BUG`、理由「bug suspected, stop automation」；
// 真实原因是调用方漏了 --period-start/--period-end。这里用真 registry / 真 Controller /
// 真账本 / 真发布段跑一遍，断言收据现在说的是「策略拒绝」。
test('收据级：守卫失败落成 blocker.class=POLICY_DENIED，而不是 BUG', async () => {
  // 用真 registry（从磁盘发现全部 manifest），因为本能力声明了 adapter.feishu 依赖，
  // 只喂自己的 manifest 会被依赖图判为 DEPENDENCY_MISSING。
  const { registry, result: registryResult } = await buildRegistryFromDisk();
  assert.equal(registryResult.ok, true, JSON.stringify(registryResult.errors));
  const manifest = registry.require('xws.feishu.import').manifest;

  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => 'attempt-receipt' });
  const ledger = createSideEffectLedger({ store });
  const admission = await admitTask({
    store,
    spec: {
      taskId: 'xws-import-receipt',
      workflow: 'competitor.weekly.import',
      capability: manifest.name,
      identity: {
        tenantId: 'sycm', storeId: 'bathtub-flagship', platform: 'xws',
        accountId: 'operator', browserProfileId: 'local', contractVersion: 'xws-16f-v1',
      },
      target: 'https://example.feishu.cn/base/base1?table=table1',
      targetEnd: 1,
      sideEffects: [...manifest.sideEffects],
      write: true,
    },
    registeredCapabilities: registry.names(),
    idFactory: () => 'run-receipt',
  });
  const runId = admission.runId;
  assert.equal(admission.context.humanGateStatus, 'WAITING_HUMAN', '写外部的高风险能力准入即开闸');
  await controller.approve(runId, { operator: 'test-operator' });

  const started = await controller.beginAttempt(runId, { stage: 'PUBLISH' });
  await controller.completeAttempt(runId, { attemptId: started.attemptId, nextAction: 'COMMIT' });
  await controller.markEvidenceValidated(runId);

  const artifactBytes = Buffer.from(JSON.stringify({
    headers: [...XWS_HEADERS],
    rows: [sourceRow()],
    images: [],
  }), 'utf8');
  const hooks = createFeishuImportPublisher({ client: fakeClient(), artifactBytes, period: null });
  const publisher = createCapabilityPublisher({
    registry, controller, ledger, capabilityId: manifest.name,
    contract: { publication: { rows: 1 }, readback: { rows: 1 } },
  });

  const result = await publisher.publish({
    runId,
    target: 'https://example.feishu.cn/base/base1?table=table1',
    businessKey: 'receipt-period-guard',
    effectClass: 'feishu_write',
    handler: hooks.handler,
    readBack: hooks.readBack,
    expected: { rows: 1 },
  });

  assert.equal(result.verdict, 'REJECTED');
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'READY', '确定未发生即未发布：发布轴不该被写成已提交');
  assert.equal(ctx.blocker.class, 'POLICY_DENIED');
  assert.equal(ctx.nextAction, 'TERMINAL');
  assert.match(ctx.blocker.detail, /policy denied/u);
  assert.doesNotMatch(ctx.blocker.detail, /bug suspected/u);
});

// 源码守卫：这是「下一个守卫」的防线。谁再往运行时路径上加一条裸 `throw new Error(...)`，
// 它就会被悄悄归成 BUG（停线）——这条断言让那种回归在测试里当场失败。
// 判定方式：只看**非注释行**里有没有 throw 这个词（整行注释先剔掉，所以注释里写 "throw" 不算），
// 这样行内写法（`if (x) throw fatalError(...)`）与独立写法都能扫到。
test('运行时路径上的每个 throw 都走 fatalError', () => {
  const sources = Object.fromEntries(['import-core.mjs', 'import-runner.mjs', 'adapter.feishu-import.mjs']
    .map((name) => [name, readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), 'utf8')]));
  const throwLines = (source) => source.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
    .filter((line) => /\bthrow\b/u.test(line));
  for (const [name, source] of Object.entries(sources)) {
    const lines = throwLines(source);
    assert.ok(lines.length > 0, `${name}: 一个 throw 都没扫到，守卫可能失效了`);
    const bare = lines.filter((line) => !line.includes('throw fatalError('));
    // 唯一允许的例外：fatalError 自己那条「code 漏登记」的喊停（它必须裸抛，否则就成了循环）。
    for (const line of bare) {
      assert.match(line, /if \(!failureClass\) throw new Error\(`unregistered failure code/u, `${name}: ${line}`);
    }
    assert.equal(bare.length, name === 'import-core.mjs' ? 1 : 0, `${name}: 有没登记失败分类的 throw`);
  }
});
