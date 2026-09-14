// xws.faq.product-collect 适配器的契约测试。
//
// 这里有一条**刻意的**测试：与 runtime/run-question-library-collection.mjs 的 readEvidence 做交叉验证。
// 适配器为了避免「Skill 反向依赖 runtime」（实施计划风险表）而没有 import 它，
// 于是收据契约的判定逻辑存在两份同义实现。交叉验证就是防漂移的那道闸：
// 同一组夹具必须让两边给出完全一致的接受/拒绝结论，否则本测试失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adapter, collectContract, parseCsv, parseCsv as adapterParseCsv,
  resetStateForTest, EVIDENCE_SCHEMA_VERSION,
} from '../scripts/adapter.faq-product.mjs';
import { readEvidence, parseCsv as runtimeParseCsv } from '../../../runtime/run-question-library-collection.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const QA_CSV = '问题,回答\n安装方便吗,"可以,自己装"\n会滑吗,不会\n';
const REVIEWS_CSV = '评论,日期\n很好用,2026-09-01\n很满意,2026-09-02\n很满意,2026-09-03\n';

// 一份"完整且自洽"的商品证据。每个用例只改一个地方，用来证明判定确实落在那个点上。
async function makeFixture({
  productId = '7001',
  qaCsv = QA_CSV,
  reviewsCsv = REVIEWS_CSV,
  qaReceipt = {},
  reviewsReceipt = {},
  zipHeader = 'PK',
  omit = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faq-product-'));
  const directory = join(root, productId);
  await mkdir(directory, { recursive: true });
  const qaBytes = Buffer.from(qaCsv, 'utf8');
  const reviewBytes = Buffer.from(reviewsCsv, 'utf8');
  const zipBytes = Buffer.concat([Buffer.from(zipHeader, 'ascii'), Buffer.alloc(16, 1)]);

  const files = {
    'qa.csv': qaBytes,
    'reviews.csv': reviewBytes,
    'reviews-source.zip': zipBytes,
    'qa-receipt.json': Buffer.from(JSON.stringify({
      productId, sourceFile: 'qa.csv', sha256: sha256(qaBytes), status: 'COMPLETED', ...qaReceipt,
    }), 'utf8'),
    'reviews-receipt.json': Buffer.from(JSON.stringify({
      productId, sourceFile: 'reviews-source.zip', normalizedFile: 'reviews.csv',
      sha256: sha256(zipBytes), normalizedSha256: sha256(reviewBytes), status: 'COMPLETED',
      scope: { content: '全部', date: '全部', sku: '未指定', impression: '未筛选', analysis: '未调用' },
      ...reviewsReceipt,
    }), 'utf8'),
  };
  for (const [name, bytes] of Object.entries(files)) {
    if (omit.includes(name)) continue;
    await writeFile(join(directory, name), bytes);
  }
  return { root, directory, productId };
}

// 交叉验证的判据：两边都只回答「接受还是拒绝」。
async function verdicts(fixture) {
  resetStateForTest();
  let adapterAccepted = true;
  try {
    await adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, { identity: null });
    await adapter.collectArtifact({ context: { identity: null }, observation: { productId: fixture.productId } });
  } catch {
    adapterAccepted = false;
  }
  let runtimeAccepted = true;
  try {
    await readEvidence(fixture.root, fixture.productId);
  } catch {
    runtimeAccepted = false;
  }
  return { adapterAccepted, runtimeAccepted };
}

test('requiredFields 声明的键必须都出现在工件对象表面', async () => {
  const fixture = await makeFixture();
  resetStateForTest();
  await adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, { identity: null });
  const artifact = await adapter.collectArtifact({ context: { identity: null }, observation: { productId: fixture.productId } });
  // 这条断言防的正是 sycm.feishu.weekly 的 D11 缺陷：
  // requiredFields 只写进字节内部时 structure 验证器会静默空转。
  for (const field of collectContract().requiredFields) {
    assert.notEqual(artifact[field], undefined, `artifact surface is missing required field ${field}`);
    assert.notEqual(artifact[field], null, `artifact surface field ${field} is null`);
  }
  await rm(fixture.root, { recursive: true, force: true });
});

test('完整证据产出可独立复验的工件', async () => {
  const fixture = await makeFixture();
  resetStateForTest();
  const started = await adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, { identity: null });
  assert.equal(started.qaRows, 2);
  assert.equal(started.reviewRows, 3);
  const artifact = await adapter.collectArtifact({ context: { identity: null }, observation: { productId: fixture.productId } });
  assert.equal(artifact.schemaVersion, EVIDENCE_SCHEMA_VERSION);
  assert.equal(artifact.rowCount, 5);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(sha256(artifact.bytes), artifact.sha256);
  assert.deepEqual(await adapter.validate(artifact), { ok: true });
  await rm(fixture.root, { recursive: true, force: true });
});

test('工件表面被篡改时 validate 必须拒绝（表面与字节不一致）', async () => {
  const fixture = await makeFixture();
  resetStateForTest();
  await adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, { identity: null });
  const artifact = await adapter.collectArtifact({ context: { identity: null }, observation: { productId: fixture.productId } });
  const tampered = { ...artifact, qaRows: 999 };
  const verdict = await adapter.validate(tampered);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'STRUCTURE_INVALID');
  await rm(fixture.root, { recursive: true, force: true });
});

test('缺失证据文件 → EVIDENCE_MISSING', async () => {
  const fixture = await makeFixture({ omit: ['reviews-source.zip'] });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'EVIDENCE_MISSING',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('收据商品身份不一致 → RECEIPT_IDENTITY_MISMATCH', async () => {
  const fixture = await makeFixture({ qaReceipt: { productId: '9999' } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'RECEIPT_IDENTITY_MISMATCH',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('收据来源文件不一致 → SOURCE_FILE_MISMATCH', async () => {
  const fixture = await makeFixture({ reviewsReceipt: { normalizedFile: 'other.csv' } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'SOURCE_FILE_MISMATCH',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('摘要不一致 → RECEIPT_HASH_MISMATCH', async () => {
  const fixture = await makeFixture({ qaReceipt: { sha256: 'f'.repeat(64) } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'RECEIPT_HASH_MISMATCH',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('评论原文压缩包不是 PK → ARCHIVE_INVALID', async () => {
  const fixture = await makeFixture({ zipHeader: 'XX', reviewsReceipt: { sha256: undefined } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'ARCHIVE_INVALID',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('评论筛选口径被改动 → REVIEW_SCOPE_MISMATCH', async () => {
  const fixture = await makeFixture({
    reviewsReceipt: { scope: { content: '全部', date: '全部', sku: '未指定', impression: '未筛选', analysis: '已调用' } },
  });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'REVIEW_SCOPE_MISMATCH',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('试用态调用过评价分析 → TRIAL_ANALYSIS_CALLED', async () => {
  const fixture = await makeFixture({ reviewsReceipt: { trial: { analysisCalls: 1 } } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'TRIAL_ANALYSIS_CALLED',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('空来源未显式声明 → UNDECLARED_EMPTY_SOURCE', async () => {
  const fixture = await makeFixture({ qaCsv: '问题,回答\n', qaReceipt: { status: 'COMPLETED' } });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'UNDECLARED_EMPTY_SOURCE',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('下架商品的 0 行证据是合法的（EMPTY_SOURCE_ROWS + 原因）', async () => {
  const fixture = await makeFixture({
    qaCsv: '问题,回答\n',
    reviewsCsv: '评论,日期\n',
    qaReceipt: { status: 'EMPTY_SOURCE_ROWS' },
    reviewsReceipt: { status: 'EMPTY_SOURCE_ROWS', unavailableReason: '商品已下架' },
  });
  resetStateForTest();
  const started = await adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, { identity: null });
  assert.equal(started.qaRows, 0);
  assert.equal(started.reviewRows, 0);
  const artifact = await adapter.collectArtifact({ context: { identity: null }, observation: { productId: fixture.productId } });
  assert.equal(artifact.rowCount, 0);
  // 0 行也必须能通过能力自检——这正是本能力刻意不声明 completeness/row_count/artifact_integrity 的原因：
  // 那三个通用验证器都会把「合法的 0 行」判成不完整。
  assert.deepEqual(await adapter.validate(artifact), { ok: true });
  assert.deepEqual((await verdicts(fixture)).adapterAccepted, true);
  await rm(fixture.root, { recursive: true, force: true });
});

test('下架商品没写原因 → UNDECLARED_EMPTY_SOURCE', async () => {
  const fixture = await makeFixture({
    reviewsCsv: '评论,日期\n',
    reviewsReceipt: { status: 'EMPTY_SOURCE_ROWS' },
  });
  resetStateForTest();
  await assert.rejects(
    () => adapter.start({ productId: fixture.productId, evidenceDir: fixture.directory }, {}),
    (error) => error.code === 'UNDECLARED_EMPTY_SOURCE',
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test('parseCsv 与 runtime 侧逐条同语义（引号/逗号/换行/空行）', () => {
  const samples = [
    '问题,回答\n"安装,方便吗？","可以\n自己装"\n',
    'a,b\n1,2\n\n3,4\n',
    'a,b\r\n1,2\r\n',
    'a,b\n,\n1,2\n',
    'only-header\n',
    '',
  ];
  for (const sample of samples) {
    assert.equal(
      adapterParseCsv(sample).length,
      runtimeParseCsv(sample).length,
      `row count drift for sample ${JSON.stringify(sample)}`,
    );
  }
});

// ── 交叉验证：两份同义实现必须给出完全一致的接受/拒绝结论 ──────────────────────
test('交叉验证：适配器与 runtime readEvidence 结论完全一致', async () => {
  const cases = [
    ['完整证据', {}],
    ['缺失压缩包', { omit: ['reviews-source.zip'] }],
    ['商品身份不一致', { qaReceipt: { productId: '9999' } }],
    ['来源文件不一致', { reviewsReceipt: { normalizedFile: 'other.csv' } }],
    ['摘要不一致', { qaReceipt: { sha256: 'f'.repeat(64) } }],
    ['压缩包非法', { zipHeader: 'XX', reviewsReceipt: { sha256: undefined } }],
    ['筛选口径被改', { reviewsReceipt: { scope: { content: '全部', date: '全部', sku: '未指定', impression: '未筛选', analysis: '已调用' } } }],
    ['试用态调过分析', { reviewsReceipt: { trial: { analysisCalls: 1 } } }],
    ['空来源未声明', { qaCsv: '问题,回答\n', qaReceipt: { status: 'COMPLETED' } }],
    ['合法空证据', { qaCsv: '问题,回答\n', reviewsCsv: '评论,日期\n', qaReceipt: { status: 'EMPTY_SOURCE_ROWS' }, reviewsReceipt: { status: 'EMPTY_SOURCE_ROWS', unavailableReason: '已下架' } }],
    ['空评论无原因', { reviewsCsv: '评论,日期\n', reviewsReceipt: { status: 'EMPTY_SOURCE_ROWS' } }],
  ];
  for (const [label, overrides] of cases) {
    const fixture = await makeFixture(overrides);
    const { adapterAccepted, runtimeAccepted } = await verdicts(fixture);
    assert.equal(adapterAccepted, runtimeAccepted, `verdict drift for case「${label}」`);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cross-check helper 用到的 parseCsv 导出与 runtime 不同源', () => {
  assert.equal(typeof parseCsv, 'function');
  assert.notEqual(parseCsv, runtimeParseCsv);
});
