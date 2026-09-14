// sycm.feishu.weekly 两段式实现的单测。
// 采集段会真的启动浏览器导出，测试一律通过 setDependenciesForTest 注入假实现；
// 生产路径完全不被测试触及。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adapter, capabilityId, manifestVersion, stableJson, collectContract,
  createPublisher, setDependenciesForTest, resetDependenciesForTest,
  ARTIFACT_SCHEMA_VERSION, SOURCE_FIELDS, FAILURE_CLASS_BY_CODE, fatalError,
} from '../scripts/adapter.feishu-weekly.mjs';
import { FAILURE_CLASS } from '../../../runtime/sop-runtime/context-schema.mjs';
import { actionForFailure, classifyExternalFailure } from '../../../runtime/sop-runtime/policy.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { admitTask } from '../../../runtime/sop-runtime/task-admission.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createCapabilityPublisher } from '../../../runtime/sop-runtime/publication.mjs';
import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(SCRIPT_DIR, '..', 'manifest.json'), 'utf8'));

const BASE_URL = 'https://example.feishu.cn/base/appTokenAbc123';

function targetOf() {
  return {
    baseUrl: BASE_URL,
    sourceTableId: 'tblSource',
    sourceTableName: '关键词分析 V1（2026-09-06）',
    newTableName: '关键词分析 V1（2026-09-13）',
    historyTableId: 'tblHistory',
    libraryTableId: 'tblLibrary',
    protectedTableId: 'tblProtected',
    protectedTableName: '竞品主表',
  };
}

function baseInput(overrides = {}) {
  return {
    collectionDate: '2026-09-13',
    batchNumber: 6,
    expectedHistoryBefore: 40,
    category: '浴缸',
    outputDir: 'runtime/test-output',
    cateId: '50002411',
    target: targetOf(),
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'sycm-weekly-'));
}

function writeSourceCsv(dir, rows) {
  const header = SOURCE_FIELDS.join(',');
  const body = rows.map((row) => SOURCE_FIELDS.map((name) => row[name]).join(',')).join('\n');
  const file = path.join(dir, 'source.csv');
  writeFileSync(file, `${header}\n${body}\n`, 'utf8');
  return file;
}

const VALID_ROWS = [
  { 排名: 1, 搜索词: '浴缸', 搜索人气: '1000', 点击率: '10%', 支付转化率: '5%' },
  { 排名: 2, 搜索词: '独立浴缸', 搜索人气: '500', 点击率: '8%', 支付转化率: '3%' },
];

// 真实的 parseSourceCsv 语义：头必须完全一致、排名连续唯一、字段非空。测试直接复用它，
// 避免测试里再造一份「宽松版解析」，让采集段的业务约束被真实覆盖。
async function withRealParser() {
  const { parseSourceCsv } = await import('../scripts/update-weekly-base.mjs');
  setDependenciesForTest({ parseSourceCsv });
}

test('自报能力 ID 与版本和 manifest 完全一致（Loader 按此校验，不一致会拒绝装载）', () => {
  assert.equal(manifest.name, capabilityId);
  assert.equal(manifest.version, manifestVersion);
  assert.equal(manifest.entry, 'scripts/adapter.feishu-weekly.mjs');
  assert.equal(manifest.kind, 'capability');
});

test('adapter 满足 Worker 适配器契约（7 个方法齐全）', () => {
  for (const name of ['checkSession', 'prepare', 'start', 'observe', 'collectArtifact', 'validate', 'release']) {
    assert.equal(typeof adapter[name], 'function', `adapter.${name} must be a function`);
  }
});

test('stableJson 与键顺序无关，保证同结果同摘要', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(stableJson(null), 'null');
  assert.equal(stableJson([1, 'x']), '[1,"x"]');
});

test('prepare 在缺关键输入时拒绝，不进入任何外部动作', async () => {
  await assert.rejects(() => adapter.prepare({}), /outputDir is required/);
  await assert.rejects(() => adapter.prepare({ outputDir: 'x' }), /collectionDate/);
  await assert.rejects(
    () => adapter.prepare(baseInput({ collectionDate: '2026-9-13' })),
    /collectionDate must be a valid YYYY-MM-DD/,
  );
  await assert.rejects(
    () => adapter.prepare(baseInput({ cateId: null })),
    /cateId is required when no sourceCsv\/sourceXlsx pair/,
  );
  await assert.rejects(
    () => adapter.prepare(baseInput({ sourceCsv: 'a.csv' })),
    /explicit reuse requires both sourceCsv and sourceXlsx/,
  );
  await assert.rejects(
    () => adapter.prepare(baseInput({ target: { ...targetOf(), baseUrl: 'http://example.feishu.cn/base/x' } })),
    /must be an https/,
  );
  await assert.rejects(
    () => adapter.prepare(baseInput({ target: { ...targetOf(), historyTableId: null } })),
    /target is missing required keys: historyTableId/,
  );
  await assert.rejects(() => adapter.prepare(baseInput({ batchNumber: 0 })), /batchNumber must be a positive integer/);
});

test('采集段（新导出）：校验 7 天窗口证明、解析源行并产出可复验工件', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  const calls = [];
  setDependenciesForTest({
    runProcess: (script, args) => {
      calls.push({ script: path.basename(script), args });
      return { ok: true, csv, xlsx: path.join(dir, 'source.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } };
    },
    verifyPair: ({ csv: c, xlsx, expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate, csv: c, xlsx }),
  });

  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  const started = await adapter.start(input);
  assert.equal(started.rows, 2);
  assert.equal(calls.length, 1, '只调用一次导出');
  assert.ok(calls[0].args.includes('--from-home'));
  assert.ok(calls[0].args.includes('2026-09-13'));

  const context = { identity: { tenantId: 't', storeId: 's' }, target: BASE_URL };
  const observation = await adapter.observe({ context, started });
  assert.equal(observation.rows, 2);
  assert.equal(observation.proofEndDate, '2026-09-13');
  assert.deepEqual(observation.keywords, ['浴缸', '独立浴缸']);

  const artifact = await adapter.collectArtifact({ context, observation });
  assert.equal(artifact.artifactKind, 'json');
  assert.equal(artifact.rowCount, 2);
  assert.deepEqual(artifact.range, { start: 1, end: 2 });
  for (const name of SOURCE_FIELDS) assert.equal(artifact[name], 2, `${name} 的非空计数应为 2`);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);

  const check = await adapter.validate(artifact, context);
  assert.equal(check.ok, true, JSON.stringify(check.details ?? {}));

  // 工件必须自证：包含源行、目标与预期，发布段据此重建输入而不依赖内存状态。
  const payload = JSON.parse(artifact.bytes.toString('utf8'));
  assert.equal(payload.schemaVersion, ARTIFACT_SCHEMA_VERSION);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.source.mode, 'FRESH_SYCM_EXPORT');
  assert.equal(payload.expected.sourceRows, 2);
  assert.equal(payload.expected.historyBefore, 40);
  assert.equal(payload.target.appToken, 'appTokenAbc123');

  resetDependenciesForTest();
});

test('采集段（显式复用对）：不调用导出，仍必须通过源文件对证明', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  const xlsx = path.join(dir, 'source.xlsx');
  writeFileSync(xlsx, 'x');
  let exportCalls = 0;
  setDependenciesForTest({
    runProcess: () => { exportCalls += 1; throw new Error('must not run the exporter when a pair is supplied'); },
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });

  const input = baseInput({ outputDir: dir, sourceCsv: csv, sourceXlsx: xlsx });
  await adapter.prepare(input);
  await adapter.start(input);
  assert.equal(exportCalls, 0);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });
  const payload = JSON.parse(artifact.bytes.toString('utf8'));
  assert.equal(payload.source.mode, 'EXPLICIT_EXPORT_PAIR');
  resetDependenciesForTest();
});

test('采集段：导出未证明 7 天窗口即判证据无效，绝不继续', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '30天', dayCount: 30, endDate: '2026-09-13' } }),
  });
  await assert.rejects(() => adapter.start(baseInput({ outputDir: dir })), /did not prove a verified 7-day reporting window/);
  resetDependenciesForTest();
});

test('能力自检拦住坏工件：排名不连续、字段为空、关键词重复、证明日期不符、目标不符', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const good = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });
  const context = { identity: { tenantId: 't' }, target: BASE_URL };

  const mutate = (fn) => {
    const payload = JSON.parse(good.bytes.toString('utf8'));
    fn(payload);
    const bytes = Buffer.from(`${stableJson(payload)}\n`, 'utf8');
    return { ...good, bytes };
  };

  const badRank = mutate((payload) => { payload.rows[1]['排名'] = 3; });
  assert.match((await adapter.validate(badRank, context)).details.reason, /contiguous from 1/);

  const emptyField = mutate((payload) => { payload.rows[0]['搜索人气'] = ''; });
  assert.match((await adapter.validate(emptyField, context)).details.reason, /must not be empty/);

  const dupKeyword = mutate((payload) => { payload.rows[1]['搜索词'] = payload.rows[0]['搜索词']; });
  assert.match((await adapter.validate(dupKeyword, context)).details.reason, /must be unique/);

  const badProof = mutate((payload) => { payload.source.proof.endDate = '2026-09-12'; });
  assert.match((await adapter.validate(badProof, context)).details.reason, /proof endDate does not match collectionDate/);

  const badProofRows = mutate((payload) => { payload.source.proof.rowCount = 9; });
  assert.match((await adapter.validate(badProofRows, context)).details.reason, /proof rowCount does not match/);

  const badSchema = mutate((payload) => { payload.schemaVersion = 'other-v1'; });
  assert.match((await adapter.validate(badSchema, context)).details.reason, /schemaVersion must be/);

  const badTarget = await adapter.validate(good, { identity: {}, target: 'https://example.feishu.cn/base/otherToken' });
  assert.match(badTarget.details.reason, /does not match the admitted target/);

  assert.equal((await adapter.validate({ bytes: Buffer.from('not json', 'utf8') }, context)).ok, false);
  assert.equal((await adapter.validate(null, context)).ok, false);
  resetDependenciesForTest();
});

test('collectContract 的 requiredFields 与工件实际键一致（否则 structure 验证器会误判）', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });
  for (const field of collectContract().requiredFields) {
    assert.notEqual(artifact[field], undefined, `工件缺少契约声明的键：${field}`);
  }
  resetDependenciesForTest();
});

test('发布段：缺工件字节即拒绝装配钩子', () => {
  assert.throws(() => createPublisher({}), /artifactBytes is required/);
});

test('发布段：dry-run 不传 --apply；两个写入阶段都被调用且顺序固定', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });

  const seen = [];
  setDependenciesForTest({
    runProcess: (script, args) => {
      seen.push({ script: path.basename(script), args });
      if (path.basename(script) === 'copy-weekly-table.mjs') return { newTableId: 'tblNew' };
      return { ok: true };
    },
  });

  const hooks = createPublisher({ artifactBytes: artifact.bytes, publishInput: { envFile: 'E:/x/.env.local' } });
  assert.equal(typeof hooks.handler, 'function');
  assert.equal(typeof hooks.readBack, 'function');
  const result = await hooks.handler();
  assert.deepEqual(seen.map((entry) => entry.script), ['copy-weekly-table.mjs', 'update-weekly-base.mjs']);
  for (const entry of seen) assert.ok(!entry.args.includes('--apply'), 'dry-run 不得带 --apply');
  assert.equal(result.weeklyTableId, 'tblNew');
  assert.equal(result.sourceRows, 2);

  // --apply 模式必须补齐全部确认参数（否则 CLI 自己会拒绝，属于防误写）
  seen.length = 0;
  const committing = createPublisher({ artifactBytes: artifact.bytes, publishInput: { dryRun: false, envFile: 'E:/x/.env.local' } });
  await committing.handler();
  const copyArgs = seen[0].args;
  assert.ok(copyArgs.includes('--apply'));
  assert.ok(copyArgs.includes('--confirm-base') && copyArgs.includes('appTokenAbc123'));
  const updateArgs = seen[1].args;
  assert.ok(updateArgs.includes('--apply'));
  assert.ok(updateArgs.includes('--confirm-weekly-table') && updateArgs.includes('tblNew'));
  assert.ok(updateArgs.includes('--expected-source-rows') && updateArgs.includes('2'));
  assert.ok(updateArgs.includes('--expected-history-before') && updateArgs.includes('40'));
  resetDependenciesForTest();
});

test('发布段回读：缺 weeklyTableId 即失败（不允许用「其他表」冒充验收对象）', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });

  const noTable = createPublisher({ artifactBytes: artifact.bytes });
  const noTableError = await noTable.readBack().then(() => null, (error) => error);
  assert.equal(noTableError.code, 'PUBLISH_TARGET_UNKNOWN');
  assert.equal(noTableError.failureClass, 'POLICY_DENIED');
  assert.match(noTableError.message, /publishInput\.weeklyTableId/u);

  const reads = [];
  setDependenciesForTest({
    readRecords: async ({ tableId }) => {
      reads.push(tableId);
      return tableId === 'tblNew'
        ? [{ fields: { 搜索词: '浴缸' } }, { fields: { 搜索词: '独立浴缸' } }]
        : [{ fields: { 批次编号: 1 } }];
    },
  });
  const good = createPublisher({ artifactBytes: artifact.bytes, publishInput: { weeklyTableId: 'tblNew' } });
  const receipt = await good.readBack();
  assert.deepEqual(reads, ['tblNew', 'tblHistory']);
  assert.equal(receipt.rows, 2);
  assert.equal(receipt.historyRows, 1);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
  assert.ok(receipt.verifiedAt);
  resetDependenciesForTest();
});

// ── 凭据来源：readBack 必须能自己从 publishInput.envFile 拿到凭据 ──────────────
// 锁的是一条只有真实 --commit 才暴露的缺陷（2026-09-14）：
// 运行器的发布钩子工厂只传 artifactBytes/evidence/period/target/collectInput/publishInput/manifest，
// **从来不传 `env`**；而 readBack 走 OpenAPI 要 FEISHU_APP_ID/SECRET。
// 只认注入 `env` 的后果：外部写入真的成功了、回读验收却永远拿不到凭据 →
// 发布段被判 UNKNOWN（合法结论但不是事实），并凭空制造一次人工对账。
// 离线测试照不到，是因为这条路径只在「真实网络客户端」里——其余回读用例统一注入 deps.readRecords，
// 而 readRecords 是在凭据解析**之后**才被用上的那一环。deps.createReadApi 就是补上的那道缝。
test('发布段回读：凭据从 publishInput.envFile 读，不依赖运行器不传的 env 参数', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=secret_test\n', 'utf8');
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });

  const seen = [];
  setDependenciesForTest({
    createReadApi: ({ appId, appSecret, appToken, envFile: used }) => {
      seen.push({ appId, appSecret, appToken, envFile: used });
      return { listRecords: async (tableId) => (tableId === 'tblNew' ? [{ fields: { 搜索词: '浴缸' } }] : []) };
    },
  });

  // 刻意不传 env —— 与运行器真实调用形态一致。
  const hooks = createPublisher({ artifactBytes: artifact.bytes, publishInput: { weeklyTableId: 'tblNew', envFile } });
  const receipt = await hooks.readBack();
  assert.deepEqual(seen, [{ appId: 'cli_test', appSecret: 'secret_test', appToken: 'appTokenAbc123', envFile }]);
  assert.equal(receipt.rows, 1);
  assert.equal(receipt.weeklyTableId, 'tblNew');

  // env 文件不存在时给确定性拒绝码，而不是让 ENOENT 直接冒出去。
  const missing = createPublisher({ artifactBytes: artifact.bytes, publishInput: { weeklyTableId: 'tblNew', envFile: path.join(dir, 'nope.env') } });
  const error = await missing.readBack().then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'INPUT_REQUIRED');
  assert.equal(error.failureClass, 'POLICY_DENIED');
  assert.match(error.message, /env file not found/u);
  resetDependenciesForTest();
});

test('工件字节可独立复验：摘要随内容变化，内容不变则摘要不变', async () => {
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const first = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });
  const second = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });
  assert.equal(first.sha256, second.sha256, '同一输入必须得到同一摘要');
  assert.deepEqual([...first.bytes], [...second.bytes]);
  resetDependenciesForTest();
});

// ── 失败分类：确定性拒绝码 → 运行时失败分类 ──────────────────────────────
// 这里锁的是一条真实缺陷的修复，与 xws.feishu.import 同一修法：
// 本能力的守卫原来抛**裸 Error**（没有 code / failureClass）
//   → side-effect-ledger 回落 policy.classifyExternalFailure
//   → 该函数只认 HTTP 状态码与**英文**关键词，本能力的中文守卫消息两样都没有
//   → 归 BUG → actionForFailure('BUG') = STOP_AND_ALERT「bug suspected, stop automation」。
// 于是「调用方把 target 给缺了」被汇报成「疑似代码有 bug，停线」，把运维引向排查代码。
// 修法：能力自己给 code + 分类（词表在本模块），框架一行未改，只按分类决定下一步。
// 词表完整性由本文件末尾的源码守卫锁住。
const TARGET_MESSAGE = 'target is missing required keys: historyTableId';

test('词表里的每个失败分类都是运行时认可的 FAILURE_CLASS，且都能映射成下一步动作', () => {
  assert.equal(Object.isFrozen(FAILURE_CLASS_BY_CODE), true);
  for (const [code, failureClass] of Object.entries(FAILURE_CLASS_BY_CODE)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/u, `code 命名不规范：${code}`);
    assert.ok(FAILURE_CLASS.includes(failureClass), `${code} → ${failureClass} 不是运行时认可的失败分类`);
    assert.doesNotMatch(actionForFailure(failureClass).reason, /^unknown failure class/u, code);
  }
});

test('调用方/目标没准备好的拒绝归 POLICY_DENIED，证据不符归 EVIDENCE_INVALID，顺序被破坏仍是 BUG', () => {
  for (const code of [
    'INPUT_REQUIRED', 'SOURCE_NOT_FOUND', 'PERIOD_INVALID', 'NUMBER_INVALID',
    'BASE_URL_INVALID', 'TARGET_INCOMPLETE', 'PUBLISH_TARGET_UNKNOWN',
  ]) {
    assert.equal(FAILURE_CLASS_BY_CODE[code], 'POLICY_DENIED', code);
    assert.equal(actionForFailure(FAILURE_CLASS_BY_CODE[code]).action, 'FAIL', code);
  }
  for (const code of ['EXPORT_UNVERIFIED', 'SOURCE_PROOF_MISMATCH']) {
    assert.equal(FAILURE_CLASS_BY_CODE[code], 'EVIDENCE_INVALID', code);
    assert.equal(actionForFailure(FAILURE_CLASS_BY_CODE[code]).action, 'REJECT_EVIDENCE', code);
  }
  for (const code of ['STAGE_FAILED', 'COPY_NO_TABLE_ID']) {
    assert.equal(FAILURE_CLASS_BY_CODE[code], 'CAPABILITY_DEGRADED', code);
    assert.equal(actionForFailure(FAILURE_CLASS_BY_CODE[code]).action, 'DEGRADE_CAPABILITY', code);
  }
  assert.equal(FAILURE_CLASS_BY_CODE.STAGE_ORDER, 'BUG');
  assert.equal(actionForFailure('BUG').action, 'STOP_AND_ALERT');
});

test('缺陷复现：同一条消息，裸 Error 归 BUG 停线，挂上 code 归策略拒绝', () => {
  const bare = classifyExternalFailure(new Error(TARGET_MESSAGE));
  assert.equal(bare, 'BUG');
  assert.equal(actionForFailure(bare).action, 'STOP_AND_ALERT');

  const coded = fatalError('TARGET_INCOMPLETE', TARGET_MESSAGE);
  assert.equal(coded.failureClass, 'POLICY_DENIED');
  assert.equal(actionForFailure(coded.failureClass).action, 'FAIL');
});

test('fatalError 同时挂上 code 与 failureClass，且不改动消息本身', () => {
  const error = fatalError('TARGET_INCOMPLETE', TARGET_MESSAGE, { missing: ['historyTableId'] });
  assert.equal(error.message, TARGET_MESSAGE);
  assert.equal(error.code, 'TARGET_INCOMPLETE');
  assert.equal(error.failureClass, 'POLICY_DENIED');
  assert.deepEqual(error.details, { missing: ['historyTableId'] });
  // 没有 details 时不塞空对象：收据里「没有这条信息」与「这条信息是 {}」不是一回事。
  assert.equal(Object.hasOwn(fatalError('STAGE_ORDER', 'x'), 'details'), false);
});

test('未登记的 code 立刻抛错，不许悄悄退回默认分类器', () => {
  assert.throws(() => fatalError('NOT_REGISTERED', 'x'), /unregistered failure code: NOT_REGISTERED/u);
});

test('真入口下每类拒绝都带上自己的 code（参数 / 日期 / URL / 目标 / 数值 / 源文件 / 证据）', async () => {
  const codeOf = async (fn) => (await fn().then(() => null, (error) => error))?.code ?? null;

  assert.equal(await codeOf(() => adapter.prepare({})), 'INPUT_REQUIRED');
  assert.equal(await codeOf(() => adapter.prepare({ outputDir: 'x' })), 'PERIOD_INVALID');
  assert.equal(await codeOf(() => adapter.prepare(baseInput({ cateId: null }))), 'INPUT_REQUIRED');
  assert.equal(await codeOf(() => adapter.prepare(baseInput({ sourceCsv: 'a.csv' }))), 'INPUT_REQUIRED');
  assert.equal(
    await codeOf(() => adapter.prepare(baseInput({ sourceCsv: 'nope.csv', sourceXlsx: 'nope.xlsx' }))),
    'SOURCE_NOT_FOUND',
  );
  assert.equal(
    await codeOf(() => adapter.prepare(baseInput({ target: { ...targetOf(), baseUrl: 'http://example.feishu.cn/base/x' } }))),
    'BASE_URL_INVALID',
  );
  assert.equal(
    await codeOf(() => adapter.prepare(baseInput({ target: { ...targetOf(), historyTableId: null } }))),
    'TARGET_INCOMPLETE',
  );
  assert.equal(await codeOf(() => adapter.prepare(baseInput({ batchNumber: 0 }))), 'NUMBER_INVALID');

  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  // 导出没证明 7 天窗口：这条消息同样既无状态码也无英文关键词，修复前一样会被说成 BUG。
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '30天', dayCount: 30, endDate: '2026-09-13' } }),
  });
  assert.equal(await codeOf(() => adapter.start(baseInput({ outputDir: dir }))), 'EXPORT_UNVERIFIED');

  // 源文件对的证明与 CSV 行数不符：换输入才能继续，不是重试同一份。
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: () => ({ status: 'success', rowCount: 9, endDate: '2026-09-13' }),
  });
  assert.equal(await codeOf(() => adapter.start(baseInput({ outputDir: dir }))), 'SOURCE_PROOF_MISMATCH');
  resetDependenciesForTest();

  // 回读前置没备好（缺飞书应用凭据）：同样是调用方问题，不该说成代码 bug。
  // 修复前这里也是裸 Error，消息里既无状态码也无英文关键词 → 同样会被归 BUG。
  const hooks = createPublisher({
    artifactBytes: Buffer.from(stableJson({ target: { historyTableId: 'tblHistory' }, expected: {}, source: {} }), 'utf8'),
    publishInput: { weeklyTableId: 'tblNew' },
  });
  assert.equal(await codeOf(() => hooks.readBack()), 'INPUT_REQUIRED');
});

// 收据级：这一层原来读不到 failureClass，只会回落到 classifyExternalFailure。
// 用真 registry / 真 Controller / 真账本 / 真发布段跑一遍，断言收据现在说的是「策略拒绝」。
async function admittedWriteRun({ registry, manifest, taskId, target = BASE_URL }) {
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: () => `attempt-${taskId}` });
  const admission = await admitTask({
    store,
    spec: {
      taskId,
      workflow: 'sycm.weekly.review',
      capability: manifest.name,
      identity: {
        tenantId: 'sycm', storeId: 'bathtub-flagship', platform: 'sycm',
        accountId: 'operator', browserProfileId: 'local', contractVersion: 'sycm-weekly-v1',
      },
      target,
      targetEnd: 1,
      sideEffects: [...manifest.sideEffects],
      write: true,
    },
    registeredCapabilities: registry.names(),
    idFactory: () => `run-${taskId}`,
  });
  assert.equal(admission.admitted, true, JSON.stringify(admission.rejectionReasons));
  const runId = admission.runId;
  assert.equal(admission.context.humanGateStatus, 'WAITING_HUMAN', '写外部的高风险能力准入即开闸');
  await controller.approve(runId, { operator: 'test-operator' });
  const started = await controller.beginAttempt(runId, { stage: 'PUBLISH' });
  await controller.completeAttempt(runId, { attemptId: started.attemptId, nextAction: 'COMMIT' });
  await controller.markEvidenceValidated(runId);
  return { store, controller, ledger: createSideEffectLedger({ store }), runId };
}

test('收据级：能力自己的拒绝落成 blocker.class=POLICY_DENIED，而不是 BUG', async () => {
  const { registry, result: registryResult } = await buildRegistryFromDisk();
  assert.equal(registryResult.ok, true, JSON.stringify(registryResult.errors));
  const manifest = registry.require(capabilityId).manifest;
  const { controller, ledger, runId } = await admittedWriteRun({ registry, manifest, taskId: 'sycm-weekly-reject' });

  // 真入口产出的错误（不是手工构造的）：调用方把 target 给缺了。
  const thrown = await adapter
    .prepare(baseInput({ target: { ...targetOf(), historyTableId: null } }))
    .then(() => null, (error) => error);
  assert.equal(thrown.code, 'TARGET_INCOMPLETE');
  assert.equal(thrown.failureClass, 'POLICY_DENIED');
  // 同一句消息在默认分类器下会被说成代码缺陷——这就是修复要挡住的那一步。
  assert.equal(classifyExternalFailure(new Error(thrown.message)), 'BUG');

  const publisher = createCapabilityPublisher({
    registry, controller, ledger, capabilityId: manifest.name,
    contract: { publication: { rows: 2 }, readback: { rows: 2 } },
  });
  const result = await publisher.publish({
    runId,
    target: BASE_URL,
    businessKey: 'sycm-weekly-target-incomplete',
    effectClass: 'feishu_write',
    handler: async () => { throw thrown; },
    readBack: async () => ({ verifiedAt: new Date().toISOString(), rows: 2, digest: 'unused' }),
    expected: { rows: 2 },
  });

  assert.equal(result.verdict, 'REJECTED');
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'READY', '确定未发生即未发布：发布轴不该被写成已提交');
  assert.equal(ctx.blocker.class, 'POLICY_DENIED');
  assert.equal(ctx.nextAction, 'TERMINAL');
  assert.match(ctx.blocker.detail, /policy denied/u);
  assert.doesNotMatch(ctx.blocker.detail, /bug suspected/u);
});

// 接线缺陷的回归守卫（2026-09-14 发现）：账本调 readBack 时**不传** handler 的返回值
// （side-effect-ledger.verify 只给 businessKey/commitKey/target），而本能力的 readBack
// 需要「handler 里克隆出来的新表 id」。修复前真实 --commit 必然落 UNKNOWN。
// 这条测试刻意**不传** publishInput.weeklyTableId，走「同一进程内 write → readback」主路径，
// 断言发布轴能走到 VERIFIED —— 它失败就意味着接线又断了。
test('收据级：handler 克隆出的新表 id 会被同一次 publish 的 readBack 用上，发布轴走到 VERIFIED', async () => {
  const { registry, result: registryResult } = await buildRegistryFromDisk();
  assert.equal(registryResult.ok, true, JSON.stringify(registryResult.errors));
  const manifest = registry.require(capabilityId).manifest;
  const { controller, ledger, runId } = await admittedWriteRun({ registry, manifest, taskId: 'sycm-weekly-verified' });

  // 真采集段产工件：导出与源文件对校验用假实现（不启动浏览器），业务解析用真解析器。
  const dir = tempDir();
  await withRealParser();
  const csv = writeSourceCsv(dir, VALID_ROWS);
  setDependenciesForTest({
    runProcess: () => ({ ok: true, csv, xlsx: path.join(dir, 'x.xlsx'), metadata: { period: '7天', dayCount: 7, endDate: '2026-09-13' } }),
    verifyPair: ({ expectedEndDate }) => ({ status: 'success', rowCount: 2, endDate: expectedEndDate }),
  });
  const input = baseInput({ outputDir: dir });
  await adapter.prepare(input);
  await adapter.start(input);
  const artifact = await adapter.collectArtifact({ context: { identity: {} }, observation: {} });

  const readTableIds = [];
  setDependenciesForTest({
    runProcess: (script) => (path.basename(script) === 'copy-weekly-table.mjs' ? { newTableId: 'tblCloned' } : { ok: true }),
    readRecords: async ({ tableId }) => {
      readTableIds.push(tableId);
      return tableId === 'tblCloned'
        ? [{ fields: { 搜索词: '浴缸' } }, { fields: { 搜索词: '独立浴缸' } }]
        : [{ fields: { 批次编号: 1 } }];
    },
  });

  const hooks = createPublisher({ artifactBytes: artifact.bytes, publishInput: { dryRun: false, envFile: 'E:/x/.env.local' } });
  const publisher = createCapabilityPublisher({
    registry, controller, ledger, capabilityId: manifest.name,
    contract: { publication: { rows: 2 }, readback: { rows: 2 } },
  });
  const result = await publisher.publish({
    runId,
    target: BASE_URL,
    businessKey: 'sycm-weekly-publish-wiring',
    effectClass: 'feishu_write',
    handler: hooks.handler,
    readBack: hooks.readBack,
    // expected 只声明行数/摘要；**不声明**任何表 id，所以 readBack 只能靠 handler 的产物。
    expected: { rows: 2 },
  });

  assert.equal(result.verdict, 'VERIFIED', JSON.stringify({ validation: result.validation, receipt: result.receipt }));
  assert.equal(result.receipt.weeklyTableId, 'tblCloned');
  assert.equal(result.receipt.rows, 2);
  assert.deepEqual(readTableIds, ['tblCloned', 'tblHistory']);
  const ctx = await controller.getContext(runId);
  assert.equal(ctx.publicationStatus, 'VERIFIED');
  resetDependenciesForTest();
});

// 源码守卫：这是「下一个守卫」的防线。谁再往本能力的运行时路径上加一条裸 `throw new Error(...)`，
// 它就会被悄悄归成 BUG（停线）——这条断言让那种回归在测试里当场失败。
// 判定方式：只看**非注释行**里有没有 throw 这个词（整行注释先剔掉，所以注释里写 "throw" 不算），
// 这样行内写法（`if (x) throw fatalError(...)`）与独立写法都能扫到。
test('运行时路径上的每个 throw 都走 fatalError', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../scripts/adapter.feishu-weekly.mjs', import.meta.url)), 'utf8',
  );
  const throwLines = source.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
    .filter((line) => /\bthrow\b/u.test(line));
  assert.ok(throwLines.length > 0, '一个 throw 都没扫到，守卫可能失效了');
  const bare = throwLines.filter((line) => !line.includes('throw fatalError('));
  // 唯一允许的例外：fatalError 自己那条「code 漏登记」的喊停（它必须裸抛，否则就成了循环）。
  for (const line of bare) {
    assert.match(line, /if \(!failureClass\) throw new Error\(`unregistered failure code/u, line);
  }
  assert.equal(bare.length, 1, '有没登记失败分类的 throw');
});
