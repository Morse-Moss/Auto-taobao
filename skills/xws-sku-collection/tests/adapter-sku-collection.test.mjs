// xws.sku.collection 的能力自检与两段式验收。
//
// 这些用例覆盖三件事：
//  1. 采集段（复验本地证据 + 已审批计划）在**证据被改坏**时必须逐条确定性拒绝，
//     而不是把坏证据当成功采下来；
//  2. 只凭工件字节就能把发布段跑起来（跨进程恢复的前提），并且写入自身幂等；
//  3. 发布段必须由外部回读收场：回读不收敛只能是 UNKNOWN（等对账），绝不能是 VERIFIED。
//
// 全程不碰真实 Feishu：Feishu 客户端与 env 读取走 setDependenciesForTest 注入。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APPROVED_SPACES,
  ARTIFACT_SURFACE_FIELDS,
  EVIDENCE_SCHEMA_VERSION,
  adapter,
  capabilityId,
  collectContract,
  createPublisher,
  indexRecordsByUniqueKey,
  isUnknownWriteFailure,
  manifestVersion,
  plainText,
  readSkuBatch,
  relationRecordIds,
  resetStateForTest,
  setDependenciesForTest,
  sha256Hex,
  stableJson,
  verifyRowsAgainstRecords,
} from '../scripts/adapter.sku-collection.mjs';

import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';
import { createLoader } from '../../../runtime/sop-runtime/skill-loader.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createEvidenceStore } from '../../../runtime/sop-runtime/evidence-store.mjs';
import { runTwoStage } from '../../../runtime/sop-runtime/two-stage-runner.mjs';

const IDENTITY = {
  tenantId: 'sycm', storeId: 'bathtub', platform: 'taobao',
  accountId: 'buyer-1', browserProfileId: 'edge-isolated', contractVersion: 'sop-context-v1',
};

// tests/ 目录：跨 Skill 路径断言必须相对本文件解析，不能依赖进程 cwd。
const here = dirname(fileURLToPath(import.meta.url));

const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const SKU_TABLE_ID = 'tblddWTrPeB4TKmR';
const PRODUCT_ID = '700000000001';
const MAIN_RECORD_ID = 'recMain0001';
const PARSER_TEXT = '// fixture payload parser build\nexport const build = "fixture-parser-v1";\n';

const sha256 = (text) => sha256Hex(Buffer.from(text, 'utf8'));

function payloadText() {
  return ['1.5米', '1.5米-白色', '1.5米-黑色'].join('\n');
}

function topologyFixture(payloadSha, combinations = 2) {
  const lines = payloadText().split('\n');
  const line = (value) => ({ nameSha256: sha256(value), payloadLineSha256: sha256(value), payloadLineIndex: lines.indexOf(value), empty: false });
  const all = [
    { skuId: 'sku-1', propertyValueIndexes: [0, 0] },
    { skuId: 'sku-2', propertyValueIndexes: [0, 1] },
  ];
  return {
    version: 'xws-tmall-sku-topology-v1',
    payloadSha256: payloadSha,
    dimensionPropertyIndex: 0,
    specificationPropertyIndex: 1,
    specificationSegmentCount: 2,
    specificationSegmentCounts: [2],
    specificationSeparator: '-',
    properties: [
      { propertyIndex: 0, propertyNameSha256: sha256('尺寸'), values: [line('1.5米')] },
      { propertyIndex: 1, propertyNameSha256: sha256('规格'), values: [line('1.5米-白色'), line('1.5米-黑色')] },
    ],
    validCombinations: all.slice(0, combinations),
  };
}

function writeFields(skuId, space = '常规卫生间') {
  return {
    商品链接: `https://item.taobao.com/item.htm?id=${PRODUCT_ID}`,
    商品标题: '夹具竞品浴缸',
    竞品分类: 'A-爆款竞品',
    SKU名称: '1.5米',
    SKU规格: `1.5米-${skuId}`,
    SKU尺寸: '1.5米',
    尺寸汇总: '1.5米',
    空间判定状态: '已判定',
    空间判定依据: 'SKU 尺寸标准化为1.5m；规则=1.3m-1.8m',
    采集状态: '已采集',
    适用空间: space,
    商品ID: PRODUCT_ID,
    SKU唯一键: `${PRODUCT_ID}|${skuId}`,
    所属竞品: [MAIN_RECORD_ID],
  };
}

function planItems({ toCreate = 2, alreadyPresent = 0 } = {}) {
  const items = [];
  for (let index = 0; index < toCreate; index += 1) {
    const skuId = `sku-${index + 1}`;
    items.push({ skuId, uniqueKey: `${PRODUCT_ID}|${skuId}`, action: 'toCreate', writeFields: writeFields(skuId) });
  }
  for (let index = 0; index < alreadyPresent; index += 1) {
    const skuId = `sku-${toCreate + index + 1}`;
    items.push({ skuId, uniqueKey: `${PRODUCT_ID}|${skuId}`, action: 'alreadyPresent', recordId: `rec${index + 1}` });
  }
  return items;
}

// 完整夹具批次：六份输入全部落盘，摘要互相绑死。
// overrides 用来在**不改夹具结构**的前提下只破坏一处，让每个拒绝码都有唯一嫌疑。
async function fixtureBatch(root, overrides = {}) {
  const directory = resolve(root, 'batch');
  await mkdir(directory, { recursive: true });
  const payload = overrides.payload ?? payloadText();
  const payloadSha = sha256(payload);
  const topology = overrides.topology ?? topologyFixture(payloadSha, overrides.combinations ?? 2);
  const topologyText = JSON.stringify(topology, null, 2) + '\n';
  const topologySha = sha256(topologyText);
  const parserText = overrides.parserText ?? PARSER_TEXT;
  const parserSha = sha256(parserText);

  const captureReceipt = overrides.captureReceipt ?? {
    captureId: 'capture-1',
    payloadSha256: payloadSha,
    metadata: {
      productId: PRODUCT_ID,
      recordId: MAIN_RECORD_ID,
      productUrl: `https://item.taobao.com/item.htm?id=${PRODUCT_ID}`,
      productTitle: '夹具竞品浴缸',
      validity: '是',
      classification: 'A-爆款竞品',
    },
  };
  const items = overrides.items ?? planItems();
  const manifest = overrides.manifest ?? {
    version: 'xws-sku-dry-run-manifest-v1',
    mode: 'DRY_RUN',
    target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID },
    evidence: { payloadSha256: payloadSha, topologySha256: topologySha },
    parser: { sha256: parserSha },
    source: {
      mainRecordId: MAIN_RECORD_ID,
      productId: PRODUCT_ID,
      productUrl: `https://item.taobao.com/item.htm?id=${PRODUCT_ID}`,
      competitorClass: 'A-爆款竞品',
    },
    plan: {
      summary: {
        parsedRows: items.length,
        toCreate: items.filter((item) => item.action === 'toCreate').length,
        alreadyPresent: items.filter((item) => item.action === 'alreadyPresent').length,
        conflict: overrides.conflict ?? 0,
        duplicateExistingKeys: overrides.duplicateExistingKeys ?? 0,
        writeReady: overrides.writeReady ?? true,
      },
      items,
    },
  };

  const paths = {
    payloadFile: join(directory, 'xws-sku-payload.txt'),
    captureReceipt: join(directory, 'xws-sku-capture.json'),
    topologyFile: join(directory, 'xws-sku-topology.json'),
    topologyReceipt: join(directory, 'xws-sku-topology-receipt.json'),
    manifestFile: join(directory, 'xws-sku-dry-run-manifest.json'),
    parserFile: join(directory, 'xws-sku-payload-parser.mjs'),
    evidenceDir: directory,
  };
  const topologyReceipt = overrides.topologyReceipt ?? {
    productId: PRODUCT_ID,
    payloadSha256: payloadSha,
    topologySha256: topologySha,
    propertyCount: topology.properties.length,
    validCombinationCount: topology.validCombinations.length,
  };

  await Promise.all([
    writeFile(paths.payloadFile, payload, 'utf8'),
    writeFile(paths.captureReceipt, JSON.stringify(captureReceipt, null, 2), 'utf8'),
    writeFile(paths.topologyFile, topologyText, 'utf8'),
    writeFile(paths.topologyReceipt, JSON.stringify(topologyReceipt, null, 2), 'utf8'),
    writeFile(paths.manifestFile, overrides.manifestText ?? JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    writeFile(paths.parserFile, parserText, 'utf8'),
  ]);
  return { directory, paths, manifest, topology, payloadSha, topologySha, parserSha };
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

// 假 Feishu：只实现被用到的两个方法，且**记录调用**，让「幂等写入」可以被断言而不是被相信。
function fakeFeishu({ records = [], failWith = null, onListRecords = null } = {}) {
  const calls = { listRecords: 0, batches: [] };
  const table = [...records];
  return {
    calls,
    table,
    async listRecords() {
      calls.listRecords += 1;
      if (onListRecords) onListRecords(calls);
      return [...table];
    },
    async batchCreateRecords(fieldsList) {
      if (failWith) throw failWith;
      calls.batches.push(fieldsList);
      const created = fieldsList.map((fields, index) => {
        const record = { record_id: `recNew${table.length + index + 1}`, fields };
        table.push(record);
        return record.record_id;
      });
      return created;
    },
  };
}

function installFakeFeishu(client) {
  setDependenciesForTest({
    readEnvFile: async () => ({ appId: 'cli_app', appSecret: 'cli_secret' }),
    createClient: async () => client,
  });
}

function collectInputOf(paths) {
  return {
    evidenceDir: paths.evidenceDir,
    payloadFile: paths.payloadFile,
    captureReceipt: paths.captureReceipt,
    topologyFile: paths.topologyFile,
    topologyReceipt: paths.topologyReceipt,
    manifestFile: paths.manifestFile,
    parserFile: paths.parserFile,
  };
}

async function runBatch({ deps, paths, overrides = {} }) {
  return runTwoStage({
    ...deps,
    capabilityId,
    identity: { ...IDENTITY },
    businessKey: `xws-sku|${PRODUCT_ID}`,
    collectInput: collectInputOf(paths),
    workDir: deps.workDir,
    ...overrides,
  });
}

async function expectRejection(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `expected ${code}, received ${error?.code}: ${error?.message}`);
    return true;
  });
}

test('manifest 与实现自述一致：名称、版本、能力 id 不得漂移', async () => {
  const { registry } = await buildRegistryFromDisk();
  const entry = registry.require(capabilityId);
  assert.equal(entry.manifest.name, capabilityId);
  assert.equal(entry.manifest.version, manifestVersion);
  assert.equal(entry.manifest.entry, 'scripts/adapter.sku-collection.mjs');
  assert.deepEqual([...entry.manifest.sideEffects], ['local_parse', 'feishu_write']);
  // 有外部写副作用 → 必须声明发布期验证器，否则注册期就该失败。
  assert.ok(entry.manifest.validation.includes('publication'));
  assert.ok(entry.manifest.validation.includes('readback'));
});

test('collectContract 声明的 requiredFields 与工件表面清单同源', () => {
  assert.deepEqual(collectContract().requiredFields, [...ARTIFACT_SURFACE_FIELDS]);
  assert.equal(collectContract().capabilityId, capabilityId);
  assert.equal(collectContract().evidenceSchemaVersion, EVIDENCE_SCHEMA_VERSION);
});

test('只跑采集段：证据复验通过、发布轴保持 NOT_REQUESTED、游标不推进、运行终结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-collect-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const receipt = await runBatch({ deps, paths });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.collect.rowCount, 2);
    assert.equal(receipt.publicationStatus, 'NOT_REQUESTED');
    assert.equal(receipt.publish.verdict, 'NOT_ATTEMPTED');
    assert.equal(receipt.cursorAdvanced, false);
    assert.equal(receipt.executionStatus, 'SUCCEEDED');
    const surface = JSON.parse(readFileSync(receipt.collect.artifactPath, 'utf8'));
    for (const field of ARTIFACT_SURFACE_FIELDS) {
      assert.notEqual(surface[field], undefined, `${field} 必须出现在工件表面`);
    }
    assert.equal(surface.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(surface.productId, PRODUCT_ID);
    assert.equal(surface.planToCreate, 2);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('六份证据缺一即拒收，且拒绝码指向缺失项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-missing-'));
  try {
    const { paths } = await fixtureBatch(root);
    for (const key of ['payloadFile', 'captureReceipt', 'topologyFile', 'topologyReceipt', 'manifestFile', 'parserFile']) {
      const broken = { ...collectInputOf(paths), [key]: '' };
      await expectRejection(readSkuBatch(broken), 'EVIDENCE_MISSING');
      const absent = { ...collectInputOf(paths), [key]: join(paths.evidenceDir, `nope-${key}.json`) };
      await expectRejection(readSkuBatch(absent), 'EVIDENCE_MISSING');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('payload 被改写 → 采集收据哈希失配，拒绝码是 RECEIPT_HASH_MISMATCH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-payload-'));
  try {
    const { paths } = await fixtureBatch(root);
    await writeFile(paths.payloadFile, '1.5米\n1.5米-白色\n', 'utf8');
    await expectRejection(readSkuBatch(collectInputOf(paths)), 'RECEIPT_HASH_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拓扑文件被改写 → 拓扑收据哈希失配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-topology-'));
  try {
    const batch = await fixtureBatch(root);
    const mutated = { ...batch.topology, specificationSegmentCounts: [1] };
    await writeFile(batch.paths.topologyFile, JSON.stringify(mutated, null, 2) + '\n', 'utf8');
    await expectRejection(readSkuBatch(collectInputOf(batch.paths)), 'RECEIPT_HASH_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('计划与证据不绑定（evidence 块哈希不符）→ 拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-evidence-bind-'));
  try {
    const { paths } = await fixtureBatch(root);
    const text = readFileSync(paths.manifestFile, 'utf8');
    await writeFile(paths.manifestFile, text.replace(/"topologySha256": "[0-9a-f]{64}"/u, `"topologySha256": "${'0'.repeat(64)}"`), 'utf8');
    await expectRejection(readSkuBatch(collectInputOf(paths)), 'RECEIPT_HASH_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('来源身份不一致（拓扑收据指向别的商品）→ RECEIPT_IDENTITY_MISMATCH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-identity-'));
  try {
    const { paths, topologySha, payloadSha, topology } = await fixtureBatch(root);
    await writeFile(paths.topologyReceipt, JSON.stringify({
      productId: '799999999999', payloadSha256: payloadSha, topologySha256: topologySha,
      propertyCount: topology.properties.length, validCombinationCount: topology.validCombinations.length,
    }, null, 2), 'utf8');
    await expectRejection(readSkuBatch(collectInputOf(paths)), 'RECEIPT_IDENTITY_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('非有效竞品 / 非 A-B 分类一律不写：SOURCE_NOT_ELIGIBLE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-eligible-'));
  try {
    for (const metadata of [
      { validity: '否', classification: 'A-爆款竞品' },
      { validity: '待确认', classification: 'A-爆款竞品' },
      { validity: '是', classification: 'C-差异化竞品' },
      { validity: '是', classification: '' },
    ]) {
      const { paths } = await fixtureBatch(await mkdtemp(join(root, 'case-')), {
        captureReceipt: {
          captureId: 'capture-1',
          payloadSha256: sha256(payloadText()),
          metadata: {
            productId: PRODUCT_ID, recordId: MAIN_RECORD_ID,
            productUrl: `https://item.taobao.com/item.htm?id=${PRODUCT_ID}`,
            ...metadata,
          },
        },
      });
      await expectRejection(readSkuBatch(collectInputOf(paths)), 'SOURCE_NOT_ELIGIBLE');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('计划未 write-ready（conflict>0）→ PLAN_NOT_WRITE_READY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-ready-'));
  try {
    const { paths } = await fixtureBatch(root, { writeReady: false, conflict: 1 });
    await expectRejection(readSkuBatch(collectInputOf(paths)), 'PLAN_NOT_WRITE_READY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan item 越界：大户型 / 错误的所属竞品 / 非本商品的唯一键，逐个拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-item-'));
  try {
    const base = planItems({ toCreate: 1 });
    const cases = [
      [{ ...base[0], writeFields: { ...base[0].writeFields, 适用空间: '大户型' } }, 'ITEM_INVALID'],
      [{ ...base[0], writeFields: { ...base[0].writeFields, 所属竞品: ['recOther'] } }, 'ITEM_INVALID'],
      [{ ...base[0], writeFields: { ...base[0].writeFields, 所属竞品: [] } }, 'ITEM_INVALID'],
      [{ ...base[0], uniqueKey: `${PRODUCT_ID}|sku-x`, writeFields: { ...base[0].writeFields, SKU唯一键: `${PRODUCT_ID}|sku-x` } }, 'ITEM_INVALID'],
      [{ ...base[0], uniqueKey: '700000000002|sku-1' }, 'ITEM_INVALID'],
      [{ skuId: 'sku-1', uniqueKey: `${PRODUCT_ID}|sku-1`, action: 'conflict' }, 'PLAN_NOT_WRITE_READY'],
    ];
    for (const [item, code] of cases) {
      const { paths } = await fixtureBatch(await mkdtemp(join(root, 'case-')), { items: [item], combinations: 1 });
      await expectRejection(readSkuBatch(collectInputOf(paths)), code);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('重复唯一键 / 拓扑组合数与计划行数不符 → PLAN_MISMATCH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-count-'));
  try {
    const duplicated = [planItems({ toCreate: 1 })[0], planItems({ toCreate: 1 })[0]];
    const first = await fixtureBatch(await mkdtemp(join(root, 'dup-')), { items: duplicated, combinations: 2 });
    await expectRejection(readSkuBatch(collectInputOf(first.paths)), 'ITEM_INVALID');

    const second = await fixtureBatch(await mkdtemp(join(root, 'count-')), { items: planItems({ toCreate: 1 }), combinations: 2 });
    await expectRejection(readSkuBatch(collectInputOf(second.paths)), 'PLAN_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parser 漂移：计划声明的解析器摘要与给出的 parser 字节不符 → 拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-parser-'));
  try {
    const { paths } = await fixtureBatch(root);
    await writeFile(paths.parserFile, `${PARSER_TEXT}// drifted\n`, 'utf8');
    await expectRejection(readSkuBatch(collectInputOf(paths)), 'RECEIPT_HASH_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工件表面被篡改 / 行数与字节不符 → 能力自检失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-artifact-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const receipt = await runBatch({ deps, paths });
    const payload = JSON.parse(readFileSync(receipt.collect.artifactPath, 'utf8'));
    const artifact = {
      ...payload,
      // range 与 rowCount 是框架侧从 skuRowCount 派生的陈述（字节里只有 skuRowCount）。
      range: { start: 1, end: payload.skuRowCount },
      rowCount: payload.skuRowCount,
      bytes: readFileSync(receipt.collect.artifactPath),
      sha256: receipt.collect.sha256,
    };
    const artifactValidation = await adapter.validate(artifact);
    assert.equal(artifactValidation.ok, true, JSON.stringify(artifactValidation));

    assert.equal((await adapter.validate({ ...artifact, productId: 'tampered' })).code, 'STRUCTURE_INVALID');
    assert.equal((await adapter.validate({ ...artifact, sha256: 'a'.repeat(64) })).code, 'DIGEST_MISMATCH');
    assert.equal((await adapter.validate({ ...artifact, rowCount: 99 })).code, 'STRUCTURE_INVALID');
    assert.equal((await adapter.validate({ ...artifact, bytes: null })).code, 'ARTIFACT_INCOMPLETE');
    assert.equal((await adapter.validate(null)).code, 'ARTIFACT_INCOMPLETE');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('提交段走完：写入 → 外部回读 → VERIFIED → 游标推进到已验收行数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-commit-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const client = fakeFeishu();
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.gate.status, 'APPROVED');
    assert.equal(receipt.publish.verdict, 'VERIFIED');
    assert.equal(receipt.publicationStatus, 'VERIFIED');
    assert.equal(receipt.cursorAdvanced, true);
    assert.deepEqual(receipt.verifiedCursor, { start: 1, end: 2, version: 1 });
    assert.equal(client.calls.batches.length, 1);
    assert.equal(client.calls.batches[0].length, 2);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('回读不收敛（行缺失）只能是 UNKNOWN，不能是 VERIFIED，也不终结运行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-unknown-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    // 写入「成功」但外部状态不认（模拟部分落库 / 最终一致性）：回读只看到 1 行。
    const client = fakeFeishu({ onListRecords: () => { client.table.length = Math.min(client.table.length, 1); } });
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publish.verdict, 'UNKNOWN');
    assert.equal(receipt.publish.requiresReconcile, true);
    assert.equal(receipt.publicationStatus, 'UNKNOWN');
    assert.equal(receipt.cursorAdvanced, false);
    assert.equal(receipt.executionStatus, null, '未结算的运行不能自称成功');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('目标不一致（请求写另一个 base/表）→ 结构上拒绝，连不上也不写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-target-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const client = fakeFeishu();
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: 'tblOtherTable' } },
      },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publish.verdict, 'REJECTED');
    assert.match(receipt.publish.error ?? '', /TARGET_MISMATCH/u);
    assert.equal(client.calls.batches.length, 0, '目标不一致时不允许产生任何写入');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('写入自身幂等：目标表已有同唯一键时不重复创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-idempotent-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const existing = {
      record_id: 'recExisting',
      fields: { SKU唯一键: `${PRODUCT_ID}|sku-1`, 所属竞品: [MAIN_RECORD_ID], 适用空间: '常规卫生间' },
    };
    const client = fakeFeishu({ records: [existing] });
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.publish.verdict, 'VERIFIED', JSON.stringify(receipt.publish));
    assert.equal(client.calls.batches.length, 1);
    assert.deepEqual(client.calls.batches[0].map((fields) => fields.SKU唯一键), [`${PRODUCT_ID}|sku-2`]);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('写入结果未知（5xx / 超时）进 UNKNOWN，不当作可重试的失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-write-unknown-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const client = fakeFeishu({ failWith: Object.assign(new Error('Feishu API failed: 503'), { status: 503 }) });
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.publish.verdict, 'UNKNOWN');
    assert.equal(receipt.publish.requiresReconcile, true);
    assert.equal(receipt.publicationStatus, 'UNKNOWN');
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('确定性拒绝（4xx）不冒充未知，直接 REJECTED 并可被上游判定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-write-rejected-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const client = fakeFeishu({ failWith: Object.assign(new Error('Feishu API failed: 400 invalid field'), { status: 400 }) });
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        operator: 'fixture-operator',
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.publish.verdict, 'REJECTED');
    assert.match(receipt.publish.error ?? '', /FEISHU_WRITE_REJECTED/u);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('人工闸门：未登记 operator 时提交路径必须停在 HUMAN_REQUIRED，且一次外部调用都不发生', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sku-gate-'));
  try {
    const deps = await harness(root);
    const { paths } = await fixtureBatch(root);
    const client = fakeFeishu();
    installFakeFeishu(client);
    const receipt = await runBatch({
      deps, paths,
      overrides: {
        commit: true,
        expectedRows: 2,
        publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } },
      },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
    assert.equal(receipt.gate.status, 'WAITING_HUMAN');
    assert.equal(client.calls.listRecords, 0);
    assert.equal(client.calls.batches.length, 0);
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('createPublisher 的纯函数边界：缺工件字节 / 缺目标即拒绝', async () => {
  assert.throws(() => createPublisher({}), /artifactBytes is required/u);
  const bytes = Buffer.from(stableJson({ target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID }, mainRecordId: MAIN_RECORD_ID, rows: [{ uniqueKey: 'a|b', action: 'toCreate', writeFields: {} }] }), 'utf8');
  assert.throws(() => createPublisher({ artifactBytes: bytes, publishInput: {} }), /TARGET_REQUIRED/u);
  const hooks = createPublisher({ artifactBytes: bytes, publishInput: { envFile: 'E:/x/.env.local', target: { appToken: APP_TOKEN, skuTableId: SKU_TABLE_ID } } });
  assert.equal(typeof hooks.handler, 'function');
  assert.equal(typeof hooks.readBack, 'function');
});

test('回读归一化：富文本、关联字段与重复唯一键的判定', () => {
  assert.equal(plainText([{ text: 'abc' }, { text: 'def' }]), 'abcdef');
  assert.equal(plainText('  x  '), 'x');
  assert.deepEqual(relationRecordIds([MAIN_RECORD_ID]), [MAIN_RECORD_ID]);
  assert.deepEqual(relationRecordIds([{ record_ids: [MAIN_RECORD_ID, MAIN_RECORD_ID] }]), [MAIN_RECORD_ID]);
  assert.deepEqual(relationRecordIds([{ record_id: MAIN_RECORD_ID }]), [MAIN_RECORD_ID]);

  const index = indexRecordsByUniqueKey([
    { record_id: 'r1', fields: { SKU唯一键: 'p|1' } },
    { record_id: 'r2', fields: { SKU唯一键: 'p|1' } },
    { record_id: 'r3', fields: { SKU唯一键: 'p|2' } },
  ]);
  assert.equal(index.size, 2);
  const verification = verifyRowsAgainstRecords(
    [{ uniqueKey: 'p|1', space: null }, { uniqueKey: 'p|2', space: '小户型' }, { uniqueKey: 'p|3', space: null }],
    [{ record_id: 'r3', fields: { SKU唯一键: 'p|2', 适用空间: '常规卫生间', 所属竞品: [MAIN_RECORD_ID] } }].concat([
      { record_id: 'r1', fields: { SKU唯一键: 'p|1', 所属竞品: [MAIN_RECORD_ID] } },
      { record_id: 'r2', fields: { SKU唯一键: 'p|1', 所属竞品: [MAIN_RECORD_ID] } },
    ]),
    MAIN_RECORD_ID,
  );
  assert.deepEqual(verification.missing, ['p|3']);
  assert.deepEqual(verification.duplicated, ['p|1']);
  assert.equal(verification.mismatched.length, 1);
  assert.equal(verification.mismatched[0].uniqueKey, 'p|2');
  assert.deepEqual(verification.verified, []);
});

test('isUnknownWriteFailure 只把「可能已落库」的失败判成未知', () => {
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { status: 500 })), true);
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { status: 408 })), true);
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isUnknownWriteFailure(new Error('fetch failed')), true);
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(isUnknownWriteFailure(Object.assign(new Error('x'), { status: 403 })), false);
  assert.equal(isUnknownWriteFailure(new Error('invalid field name')), false);
});

test('只读能力不导出空 publisher：本能力必须导出 createPublisher（有外部写副作用）', async () => {
  const module = await import('../scripts/adapter.sku-collection.mjs');
  assert.equal(typeof module.createPublisher, 'function');
  assert.ok(APPROVED_SPACES.includes('小户型') && APPROVED_SPACES.includes('常规卫生间'));
  assert.equal(APPROVED_SPACES.includes('大户型'), false);
});

test('跨 Skill 依赖不漂移：懒加载的 Feishu 客户端就是注册表里 adapter.feishu 指向的那个实现', async () => {
  const { registry } = await buildRegistryFromDisk();
  const entry = registry.require('adapter.feishu');
  // 与 adapter.sku-collection.mjs 里 defaultCreateClient 的相对导入解析到同一个文件。
  const declared = resolve(here, '../..', 'xws-to-feishu-base', entry.manifest.entry);
  const imported = resolve(here, '..', 'scripts', '../../xws-to-feishu-base/scripts/feishu-client.mjs');
  assert.equal(imported, declared);
  const module = await import(pathToFileURL(imported).href);
  assert.equal(typeof module.FeishuClient, 'function');
  // 能力必须把这条依赖写进 manifest，而不是偷偷 import。
  const capability = registry.require(capabilityId);
  assert.ok(capability.manifest.dependencies.some((dep) => dep.id === 'adapter.feishu'));
});
