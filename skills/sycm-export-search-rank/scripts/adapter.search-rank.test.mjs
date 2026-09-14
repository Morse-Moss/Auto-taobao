// sycm.search-rank.export 适配器的契约测试（实施计划迁移顺序第 4 项）。
//
// 两条刻意的测试：
//   1) **与 runtime 的交叉验证**：适配器为避免「Skill 反向依赖 runtime」（实施计划风险表）
//      没有 import runtime/，于是工件形状/范围/摘要的判定在两边各有一份。
//      同一组事实必须让 runtime 的验证器与适配器的自检给出完全一致的结论，否则本测试失败。
//   2) **只用真 registry + 真 loader + 真 adapter**，只把 store 换成内存、把浏览器流程换成夹具：
//      这样测的是「这条能力能不能被运行时驱动」，而不是「函数能不能被调用」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  adapter, capabilityId, collectContract, manifestVersion, resetStateForTest,
  setFlowRunnerForTest, stableJson, EVIDENCE_SCHEMA_VERSION,
} from './adapter.search-rank.mjs';
import { defaultExportArgs, resolveExportArgs } from './export-search-rank.mjs';

import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';
import { createLoader } from '../../../runtime/sop-runtime/skill-loader.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createEvidenceStore } from '../../../runtime/sop-runtime/evidence-store.mjs';
import { runTwoStage } from '../../../runtime/sop-runtime/two-stage-runner.mjs';
import {
  validateContiguousPrefix, validateStructure, validateCompleteness,
} from '../../../runtime/sop-runtime/validator.mjs';

const IDENTITY = {
  tenantId: 'sycm', storeId: 'bathtub', platform: 'sycm',
  accountId: 'seller-1', browserProfileId: 'edge-isolated', contractVersion: 'sop-context-v1',
};

const CSV_HEADER = '排名,搜索词,搜索人气,点击率,支付转化率';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 夹具流程：与真实流程返回**同形**的结果（metadata / csvFile / xlsxFile / proof）。
// 真实流程需要 Edge + 生意参谋登录态，单元测试不碰真实浏览器；但产物必须是真文件，
// 否则"摘要复算/产物复验"这两道就只能靠 mock 断言，测不出真东西。
async function fixtureFlow(args) {
  await mkdir(args.outputDir, { recursive: true });
  const rows = [
    [1, '浴缸', '1.2万', '3.1%', '1.4%'],
    [2, '泡澡桶', '9800', '2.7%', '1.1%'],
    [3, '成人浴缸', '7600', '2.2%', '0.9%'],
  ];
  const csvFile = join(args.outputDir, 'shengyicanmou-search-ranking-2026-09-12.csv');
  const xlsxFile = join(args.outputDir, 'shengyicanmou-search-ranking-2026-09-12.xlsx');
  await writeFile(csvFile, `\uFEFF${[CSV_HEADER, ...rows.map((row) => row.join(','))].join('\r\n')}\r\n`, 'utf8');
  // XLSX 只要求"非空且存在"（配对校验由流程内的 Python 校验承担，不属于本适配器职责）。
  await writeFile(xlsxFile, Buffer.from('PK\u0003\u0004synthetic-workbook', 'latin1'));
  return {
    metadata: {
      source: '生意参谋搜索排行',
      sourceUrl: 'https://sycm.taobao.com/mc/free/search_rank',
      date: '2026-09-12',
      period: '7天',
      startDate: '2026-09-06',
      endDate: '2026-09-12',
      dayCount: 7,
      dateRange: '2026-09-06 ~ 2026-09-12',
      category: '普通浴缸',
      cateId: '50002411',
      exportedAt: '2026-09-13T01:00:00.000Z',
      pages: 1,
      rowCount: rows.length,
      rankRange: `1-${rows.length}`,
      uniqueRanks: true,
      contiguousRanks: true,
      uniqueTerms: true,
      nonEmptyMetrics: true,
      pageSizes: [rows.length],
    },
    csvFile,
    xlsxFile,
    proof: { status: 'success', rows: rows.length, source: 'verify-export-pair' },
  };
}

async function harness(root) {
  const { registry, result } = await buildRegistryFromDisk();
  assert.equal(result.ok, true, `registry must be valid: ${JSON.stringify(result.errors ?? [])}`);
  const store = createMemoryStore();
  const controller = createController({ store, idFactory: (() => { let n = 0; return () => `run-${++n}`; })() });
  const workDir = resolve(root, 'work');
  await mkdir(workDir, { recursive: true });
  return {
    registry,
    loader: createLoader({ registry }),
    store,
    controller,
    ledger: createSideEffectLedger({ store }),
    evidenceStore: createEvidenceStore({ root: resolve(workDir, 'evidence') }),
    workDir,
  };
}

function collectInput(outputDir) {
  return { proxy: 'http://127.0.0.1:3456', cateId: '50002411', category: '普通浴缸', outputDir };
}

async function runCollect({ root, deps, outputDir = null, overrides = {} }) {
  const out = outputDir ?? resolve(root, 'out');
  const receipt = await runTwoStage({
    ...deps,
    capabilityId,
    identity: { ...IDENTITY },
    businessKey: `sycm-search-rank|2026-09-06|2026-09-12`,
    collectInput: collectInput(out),
    workDir: deps.workDir,
    ...overrides,
  });
  return { receipt, out };
}

function artifactFromReceipt(receipt) {
  const bytes = readFileSync(receipt.collect.artifactPath);
  const payload = JSON.parse(bytes.toString('utf8'));
  // range 不在证据字节里（字节里只有 rowCount），它是从 rowCount 派生的陈述：
  // 搜索排行天然 1..N 连续，流程内 validateRows 已经保证过。这里按同一规则重建。
  return {
    bytes,
    payload,
    artifact: { ...payload, range: { start: 1, end: payload.rowCount }, bytes, sha256: receipt.collect.sha256 },
  };
}

test('collectContract 声明的 requiredFields 必须逐个出现在工件表面（D11 类缺陷防线）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const { payload } = artifactFromReceipt(receipt);
    const missing = collectContract().requiredFields.filter((field) => payload[field] === undefined || payload[field] === null);
    assert.deepEqual(missing, [], 'structure 验证器只看工件表面：声明的字段必须真的在那里');
    assert.equal(payload.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(payload.identity.tenantId, IDENTITY.tenantId, '工件必须绑定发起运行的 identity');
  } finally {
    setFlowRunnerForTest(fixtureFlow);
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('只读能力走完采集段：验证器全过、发布轴保持 NOT_REQUESTED、游标不推进、运行终结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });

    assert.equal(receipt.ok, true);
    assert.equal(receipt.mode, 'dry-run');
    assert.equal(receipt.collect.rowCount, 3);
    assert.equal(receipt.collect.sha256.length, 64);
    for (const name of ['source_identity', 'contiguous_prefix', 'row_count', 'structure', 'adapter']) {
      assert.ok(
        receipt.collect.validators.some((entry) => entry.startsWith(`${name}:ok`)),
        `${name} must pass, got: ${receipt.collect.validators.join(',')}`,
      );
    }
    assert.equal(receipt.publish.verdict, 'NOT_ATTEMPTED');
    assert.equal(receipt.publicationStatus, 'NOT_REQUESTED', '只读能力不该凭空产生一条待回读的外部写入');
    assert.equal(receipt.cursorAdvanced, false);
    assert.equal(receipt.executionStatus, 'SUCCEEDED', '本次调用该做的都做完了，运行必须终结');

    const context = await deps.controller.getContext(receipt.runId);
    assert.equal(context.evidenceStatus, 'VALIDATED');
    // 只读采集模式下调用方没有声明预期行数，游标保持「未建立」——
    // 不拿采到的行数冒充已达成的游标。
    assert.equal(context.verifiedCursor ?? null, null);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('工件范围与 runtime 的 contiguous_prefix 判定一致（交叉验证，防两份实现漂移）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    const { artifact, payload } = artifactFromReceipt(receipt);
    const context = await deps.controller.getContext(receipt.runId);

    assert.deepEqual(artifact.range, { start: 1, end: payload.rowCount });
    // runtime 侧同义判定：游标为 0 时工件必须从第 1 名开始
    assert.equal(validateContiguousPrefix(context, artifact).ok, true);
    assert.equal(validateContiguousPrefix({ verifiedCursor: { end: 0 } }, { range: { start: 2, end: 3 } }).ok, false, '错位必须被拒');
    // structure / row_count 也必须在 runtime 侧同结论
    assert.equal(validateStructure(artifact, collectContract()).ok, true);
    assert.equal(validateCompleteness(artifact, {}).ok, true);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('表面字段与字节内容不一致即拒绝（改一半的篡改不能静默通过）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    const { artifact } = artifactFromReceipt(receipt);

    assert.equal((await adapter.validate(artifact)).ok, true, '未篡改的工件必须先自检通过');
    const tampered = { ...artifact, rowCount: 999 };
    const verdict = await adapter.validate(tampered);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'STRUCTURE_INVALID');
    assert.deepEqual(verdict.details.fields, ['rowCount']);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('产物文件被改写后证据失效（摘要不符即 DIGEST_MISMATCH，不降级成警告）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt, out } = await runCollect({ root, deps });
    const { artifact } = artifactFromReceipt(receipt);
    writeFileSync(join(out, 'shengyicanmou-search-ranking-2026-09-12.csv'), '排名,搜索词\n1,被改过的\n', 'utf8');

    const verdict = await adapter.validate(artifact);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'DIGEST_MISMATCH');
    assert.match(String(verdict.details.reason), /csv product changed/);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('产物文件被删除后证据失效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt, out } = await runCollect({ root, deps });
    const { artifact } = artifactFromReceipt(receipt);
    rmSync(join(out, 'shengyicanmou-search-ranking-2026-09-12.xlsx'));

    const verdict = await adapter.validate(artifact);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'ARTIFACT_INCOMPLETE');
    assert.match(String(verdict.details.reason), /xlsx product is missing/);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('工件摘要必须可复算：改一个字节即 DIGEST_MISMATCH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(fixtureFlow);
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    const { artifact } = artifactFromReceipt(receipt);
    const mutated = { ...artifact, bytes: Buffer.from(`${artifact.bytes.toString('utf8')} `, 'utf8') };

    const verdict = await adapter.validate(mutated);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'DIGEST_MISMATCH');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('代理浏览器不可达归类为可重试的外部故障（而不是 BUG）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(async () => { throw new Error('fetch failed'); });
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.stage, 'COLLECT');
    assert.equal(receipt.failureClass, 'TRANSIENT_EXTERNAL', '代理不可达是可重试故障，不是能力缺陷');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('需要人工的登录/类目提示归类为 HUMAN_REQUIRED（中文提示不能被默认分类器当成 BUG）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(async () => {
    const error = new Error('标签页已登录但不在搜索排行页面，请人工通过市场 > 搜索排行打开目标页');
    error.code = 'HUMAN_REQUIRED';
    throw error;
  });
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');

    const context = await deps.controller.getContext(receipt.runId);
    assert.equal(context.executionStatus, 'PAUSED');
    assert.equal(context.humanGateStatus, 'WAITING_HUMAN');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('零行导出不能成为证据（空排名没有可复核的内容）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(async (args) => {
    const base = await fixtureFlow(args);
    return { ...base, metadata: { ...base.metadata, rowCount: 0, rankRange: '1-0' } };
  });
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'EVIDENCE_INVALID');
    assert.match(String(receipt.error), /no rows/);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('未经验证夹具确认的流程返回残缺结果即失败（缺 CSV/XLSX 对不算采到）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sycm-rank-'));
  setFlowRunnerForTest(async () => ({ metadata: { rowCount: 3, startDate: '2026-09-06', endDate: '2026-09-12' } }));
  try {
    const deps = await harness(root);
    const { receipt } = await runCollect({ root, deps });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'EVIDENCE_INVALID');
    assert.match(String(receipt.error), /no CSV\/XLSX pair/);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('start() 之前调用 collectArtifact 直接失败（不允许"没有采集就出证据"）', async () => {
  resetStateForTest();
  await assert.rejects(
    () => adapter.collectArtifact({ context: { runId: 'r1' }, observation: {} }),
    (error) => error.code === 'EVIDENCE_MISSING',
  );
  await assert.rejects(() => adapter.observe({ context: {}, started: {} }), (error) => error.code === 'EVIDENCE_MISSING');
});

test('适配器与 CLI 共用同一份默认参数（否则两边会静默分叉）', () => {
  const defaults = defaultExportArgs();
  const resolved = resolveExportArgs({});
  assert.equal(resolved.cateId, defaults.cateId);
  assert.equal(resolved.category, defaults.category);
  assert.equal(resolved.delayMs, defaults.delayMs);
  assert.equal(resolved.maxPages, defaults.maxPages);
  assert.equal(resolved.period, defaults.period);
  assert.equal(resolved.fromHome, defaults.fromHome);
});

test('参数校验失败即拒绝（不做静默兜底）', () => {
  assert.throws(() => resolveExportArgs({ delayMs: 100 }), /delayMs must be at least 800/u);
  assert.throws(() => resolveExportArgs({ maxPages: 0 }), /maxPages must be a positive integer/u);
  assert.throws(() => resolveExportArgs({ period: '30d' }), /supports only 7d/u);
  assert.throws(() => resolveExportArgs({ cateId: '' }), /cateId is required/u);
  assert.throws(() => resolveExportArgs({ outputDir: '' }), /outputDir is required/u);
  assert.throws(() => resolveExportArgs({ proxy: '' }), /proxy is required/u);
});

test('stableJson 与键序无关（摘要必须只由内容决定）', () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] }), stableJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(sha256(Buffer.from(stableJson({ a: 1, b: 2 }))), sha256(Buffer.from(stableJson({ b: 2, a: 1 }))));
});

test('模块自述与实际导出一致（能力 ID / 版本 / 与 manifest 对齐）', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, capabilityId);
  assert.equal(manifest.version, manifestVersion);
  assert.equal(manifest.entry, 'scripts/adapter.search-rank.mjs');
  assert.equal(manifest.sideEffects.includes('feishu_write'), false, '本能力不得声明外部写副作用');
  const contract = collectContract();
  assert.equal(contract.capabilityId, capabilityId);
  assert.equal(contract.evidenceSchemaVersion, EVIDENCE_SCHEMA_VERSION);
  for (const name of Object.keys(contract.omittedValidators)) {
    assert.equal(
      manifest.validation.includes(name), false,
      `${name} 已声明为"刻意不声明"，就不能出现在 manifest.validation 里`,
    );
  }
});
