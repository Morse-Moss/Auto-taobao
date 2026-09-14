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
  ARTIFACT_SCHEMA_VERSION, SOURCE_FIELDS,
} from '../scripts/adapter.feishu-weekly.mjs';

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
    /target.historyTableId is required/,
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
  await assert.rejects(() => noTable.readBack(), /requires publishInput.weeklyTableId/);

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
