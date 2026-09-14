// huitun.keyword-heat.collect 的能力自检与两段式验收。
//
// 这些用例覆盖四件事：
//  1. 采集段（results.json + 飞书只读）× 队列实况的复验：来源身份、队列指纹、字段类型、
//     新鲜度、逐行身份——每一条被改坏时都必须给出**唯一的确定性拒绝码**，而不是泛化失败；
//  2. 只凭工件字节就能把发布段跑起来（跨进程恢复的前提），并且写入对账式幂等；
//  3. 发布段必须由外部回读（含优先级公式结算）收场：没收敛就只能是 UNKNOWN，绝不是 VERIFIED；
//  4. 已登记依赖 adapter.feishu 的入口路径不得漂移。
//
// 拒绝码有两个观察面，两者都要测：
//  - 直接调 readHuitunBatch：拿到的是确定性 code（这是「为什么这批词没通过」的结论）；
//  - 经 runTwoStage：拿到的是 receipt.failureClass（这是运行时据此决定重试/等人工的依据）。
//  只测其中一面，都会漏掉「code 对但映射错」这类缺陷。
//
// 全程不碰真实 Feishu、不碰浏览器：Feishu 客户端与 env 读取走 setDependenciesForTest 注入。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_SURFACE_FIELDS,
  EVIDENCE_SCHEMA_VERSION,
  HuitunEvidenceError,
  WRITABLE_FIELD,
  adapter,
  artifactPlan,
  buildReadbackReceipt,
  capabilityId,
  collectContract,
  createPublisher,
  isUnknownWriteFailure,
  manifestVersion,
  readHuitunBatch,
  resetStateForTest,
  setDependenciesForTest,
  sha256Hex,
  stableJson,
  translateFlowError,
} from '../scripts/adapter.huitun-keyword-heat.mjs';
import { HUITUN_RESULT_SCHEMA_VERSION, buildQueueBinding, plain } from '../scripts/flow.mjs';

import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';
import { createLoader } from '../../../runtime/sop-runtime/skill-loader.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createEvidenceStore } from '../../../runtime/sop-runtime/evidence-store.mjs';
import { runTwoStage } from '../../../runtime/sop-runtime/two-stage-runner.mjs';

const IDENTITY = {
  tenantId: 'sycm', storeId: 'keyword-heat', platform: 'xhs',
  accountId: 'operator', browserProfileId: 'edge-isolated', contractVersion: 'sop-context-v1',
};

// tests/ 目录：跨 Skill 路径断言必须相对本文件解析，不能依赖进程 cwd。
const here = dirname(fileURLToPath(import.meta.url));

const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TABLE_ID = 'tblHuitunKeyword01';
const TABLE_NAME = '关键词库_夹具';
const ENV_TEXT = 'FEISHU_APP_ID=cli_app\nFEISHU_APP_SECRET=cli_secret\n';
const SOURCE_IDENTITY = '灰豚数据红薯版|话题搜索|https://xhs.huitun.com/#/anchor/anchor_topic|去除话题首尾#后与搜索词完全一致；不累加相近话题';
const RESULT_SOURCE = {
  platform: '灰豚数据红薯版',
  page: '话题搜索',
  url: 'https://xhs.huitun.com/#/anchor/anchor_topic',
  match_rule: '去除话题首尾#后与搜索词完全一致；不累加相近话题',
};

// 两个 A 候选 + 一行非候选（证明 selectCandidates 真的在筛，而不是把整表当队列）。
function baseRecords() {
  return [
    {
      record_id: 'recA1',
      fields: {
        搜索词: '家用浴缸',
        关键词分类: '场景词',
        细分标签: '卫浴',
        搜索热度: '高',
        交易热度: '高',
        内容热度: '高',
        优先级: 'A候选',
      },
    },
    {
      record_id: 'recA2',
      fields: {
        搜索词: '小户型浴缸',
        关键词分类: '场景词',
        细分标签: '小户型',
        搜索热度: '中',
        交易热度: '中',
        内容热度: '低',
        优先级: 'A候选',
      },
    },
    {
      record_id: 'recB1',
      fields: {
        搜索词: '浴缸品牌',
        关键词分类: '品牌词',
        细分标签: '卫浴',
        搜索热度: '高',
        交易热度: '高',
        内容热度: '高',
        优先级: 'B-持续观察',
      },
    },
  ];
}

const REQUIRED_FIELD_TYPES = [
  { fieldName: '搜索词', type: 1 },
  { fieldName: '关键词分类', type: 3 },
  { fieldName: '细分标签', type: 3 },
  { fieldName: '搜索热度', type: 3 },
  { fieldName: '交易热度', type: 3 },
  { fieldName: '内容热度', type: 1 },
  { fieldName: WRITABLE_FIELD, type: 2 },
  { fieldName: '优先级', type: 20 },
];

function resultItems() {
  return [
    { keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#家用浴缸#', viewsRaw: '1200w', views: 12_000_000 },
    { keyword: '小户型浴缸', status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: '灰豚返回相近话题，无完全同名话题', views: 0 },
  ];
}

function documentFor(binding, overrides = {}) {
  return {
    schemaVersion: HUITUN_RESULT_SCHEMA_VERSION,
    source: { ...RESULT_SOURCE, collected_at: overrides.collectedAt ?? new Date().toISOString() },
    target: overrides.documentTarget ?? binding,
    items: overrides.items ?? resultItems(),
  };
}

// 完整夹具批次：results.json 与目标表实况互相绑死。
// overrides 用来在**不改夹具结构**的前提下只破坏一处，让每个拒绝码都有唯一嫌疑。
async function fixtureBatch(root, overrides = {}) {
  const directory = resolve(root, 'batch');
  await mkdir(directory, { recursive: true });
  const appToken = overrides.appToken ?? APP_TOKEN;
  const tableId = overrides.tableId ?? TABLE_ID;
  const tableName = overrides.tableName ?? TABLE_NAME;
  const records = overrides.records ?? baseRecords();
  const candidateMode = overrides.candidateMode ?? 'A_ONLY';
  const binding = overrides.binding ?? buildQueueBinding({ appToken, tableId, tableName, records, candidateMode });
  const document = overrides.document ?? documentFor(binding, overrides);
  const resultsFile = join(directory, 'results.json');
  const envFile = join(directory, '.env.fixture');
  await Promise.all([
    writeFile(resultsFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    writeFile(envFile, ENV_TEXT, 'utf8'),
  ]);
  return { directory, resultsFile, envFile, document, binding, records, tableName, tableId, appToken };
}

function collectInputOf(batch, overrides = {}) {
  return {
    resultsFile: batch.resultsFile,
    envFile: batch.envFile,
    appToken: batch.appToken,
    tableId: batch.tableId,
    tableName: batch.tableName,
    ...overrides,
  };
}

// 假 Feishu：实现被用到的四个方法，并且**记录调用**——
// 这样「幂等写入」与「没授权时一次外部调用都没发生」是被断言出来的，而不是被相信的。
// priorityByRecord 模拟公式字段的异步重算：真实 Base 会自己算，这里由用例显式给出结果；
// 不给就是不重算（默认即「公式一直没结算」这个最危险的失败模式）。
function fakeFeishu({
  records = baseRecords(),
  tables = null,
  fields = null,
  failUpdateWith = null,
  priorityByRecord = {},
  onUpdate = null,
} = {}) {
  const calls = { listTables: 0, listFields: 0, listRecords: 0, updateBatches: [] };
  const table = records.map((record) => ({ record_id: record.record_id, fields: { ...record.fields } }));
  return {
    calls,
    table,
    async listTables() {
      calls.listTables += 1;
      return tables ?? [{ tableId: TABLE_ID, name: TABLE_NAME }];
    },
    async listFields() {
      calls.listFields += 1;
      return fields ?? REQUIRED_FIELD_TYPES.map((field) => ({ ...field }));
    },
    async listRecords() {
      calls.listRecords += 1;
      return table.map((record) => ({ record_id: record.record_id, fields: { ...record.fields } }));
    },
    async batchUpdateRecords(updates) {
      if (failUpdateWith) throw failUpdateWith;
      calls.updateBatches.push(updates.map((update) => ({ record_id: update.record_id, fields: { ...update.fields } })));
      for (const update of updates) {
        const record = table.find((item) => item.record_id === update.record_id);
        if (!record) throw new Error(`unknown record ${update.record_id}`);
        Object.assign(record.fields, update.fields);
        const next = priorityByRecord[update.record_id];
        if (next !== undefined) record.fields.优先级 = next;
      }
      if (onUpdate) onUpdate(calls);
      return updates.map((update) => update.record_id);
    },
  };
}

function installFakeFeishu(client) {
  setDependenciesForTest({
    readEnvFile: async () => ENV_TEXT,
    createClient: async () => client,
  });
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

async function runHeat({ deps, collectInput, overrides = {} }) {
  return runTwoStage({
    ...deps,
    capabilityId,
    identity: { ...IDENTITY },
    businessKey: `huitun|${TABLE_ID}`,
    expectedRows: 2,
    collectInput,
    workDir: deps.workDir,
    ...overrides,
  });
}

function commitOverrides(batch, extra = {}) {
  return {
    commit: true,
    operator: 'ops-zhang',
    publishInput: {
      target: { appToken: batch.appToken, tableId: batch.tableId, tableName: batch.tableName },
      envFile: batch.envFile,
      pollMs: 5,
      settleTimeoutMs: 200,
      ...extra,
    },
  };
}

async function expectCode(promise, code, failureClass = null) {
  const error = await promise.then(() => null, (value) => value);
  assert.ok(error, `expected ${code}, but the call resolved`);
  assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`);
  if (failureClass) assert.equal(error.failureClass, failureClass);
}

async function withFixture(name, options, body) {
  const root = await mkdtemp(join(tmpdir(), `huitun-${name}-`));
  try {
    const deps = await harness(root);
    const batch = await fixtureBatch(root, options.batch ?? {});
    const client = fakeFeishu(options.client ?? {});
    installFakeFeishu(client);
    await body({ root, deps, batch, client });
  } finally {
    resetStateForTest();
    await rm(root, { recursive: true, force: true });
  }
}

// ── manifest / 契约 ────────────────────────────────────────────────────────

test('manifest 与实现自述一致：名称、版本、入口、副作用、发布期验证器不得漂移', async () => {
  const { registry } = await buildRegistryFromDisk();
  const entry = registry.require(capabilityId);
  assert.equal(entry.manifest.name, capabilityId);
  assert.equal(entry.manifest.version, manifestVersion);
  assert.equal(entry.manifest.entry, 'scripts/adapter.huitun-keyword-heat.mjs');
  assert.deepEqual([...entry.manifest.sideEffects], ['browser_read', 'local_artifact', 'feishu_write']);
  // 有外部写副作用 → 必须声明发布期验证器，否则注册期就该失败。
  assert.ok(entry.manifest.validation.includes('publication'));
  assert.ok(entry.manifest.validation.includes('readback'));
  assert.ok(entry.manifest.validation.includes('structure'));
  // 恢复点是提交记录，不是游标：UNKNOWN 只能对账，重试必须落在同一个 commitKey 上。
  assert.equal(entry.manifest.recovery.resumeFrom, 'idempotent_commit');
});

test('collectContract 的 requiredFields 与工件表面清单同源，且被声明为刻意省略的验证器不得出现在 manifest 里', async () => {
  const contract = collectContract();
  assert.deepEqual(contract.requiredFields, [...ARTIFACT_SURFACE_FIELDS]);
  assert.equal(contract.capabilityId, capabilityId);
  assert.equal(contract.evidenceSchemaVersion, EVIDENCE_SCHEMA_VERSION);
  const { registry } = await buildRegistryFromDisk();
  const declared = registry.require(capabilityId).manifest.validation;
  for (const omitted of Object.keys(contract.omittedValidators)) {
    assert.equal(declared.includes(omitted), false, `${omitted} 声明为刻意省略，就不能出现在 manifest.validation 里`);
  }
});

test('跨 Skill 依赖漂移守卫：manifest 的 adapter.feishu 与适配器里那条相对导入指向同一个已登记入口', async () => {
  const { registry } = await buildRegistryFromDisk();
  const adapterEntry = registry.require('adapter.feishu');
  // 注册表把 dependencies 规范化成 { id, range }：断言 id，不依赖字符串形态（那是注册表的职责）。
  const declared = registry.require(capabilityId).manifest.dependencies;
  assert.ok(declared.some((dep) => dep.id === 'adapter.feishu'), 'manifest 必须声明 adapter.feishu 依赖');
  const expected = resolve(here, '..', '..', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs');
  const registered = resolve(here, '..', '..', '..', 'skills', 'xws-to-feishu-base', adapterEntry.manifest.entry);
  assert.equal(registered, expected, '注册表里的 adapter.feishu 入口必须就是适配器相对导入的那个模块');
});

// ── 采集段 ──────────────────────────────────────────────────────────────────

test('只跑采集段：复验通过、发布轴保持 NOT_REQUESTED、游标不推进、运行终结', async () => {
  await withFixture('collect', {}, async ({ deps, batch }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch) });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.collect.rowCount, 2);
    assert.equal(receipt.publicationStatus, 'NOT_REQUESTED');
    assert.equal(receipt.publish.verdict, 'NOT_ATTEMPTED');
    assert.equal(receipt.cursorAdvanced, false);
    assert.equal(receipt.executionStatus, 'SUCCEEDED');
    // manifest 声明的采集期验证器，加上 Worker 恒定追加的能力自检（adapter.validate）。
    // 顺序固定：先声明集，再自检。
    assert.deepEqual(receipt.collect.validators, ['source_identity:ok', 'structure:ok', 'row_count:ok', 'adapter:ok']);
    const surface = JSON.parse(readFileSync(receipt.collect.artifactPath, 'utf8'));
    for (const field of ARTIFACT_SURFACE_FIELDS) {
      assert.notEqual(surface[field], undefined, `${field} 必须出现在工件表面`);
    }
    assert.equal(surface.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(surface.sourceIdentity, SOURCE_IDENTITY);
    assert.equal(surface.keywordCount, 2);
    assert.equal(surface.planUpdates, 2);
    assert.equal(surface.resultsSha256, sha256Hex(readFileSync(batch.resultsFile)));
    assert.equal(surface.tableId, TABLE_ID);
    // 候选行里只有 A 候选进入队列：品牌词行不得出现。
    assert.deepEqual(surface.queue.map((item) => item.recordId), ['recA1', 'recA2']);
    // 只写一个字段，且写的是「按队列实况算出的值」。
    assert.deepEqual(surface.plan.updates.map((update) => Object.keys(update.fields)), [[WRITABLE_FIELD], [WRITABLE_FIELD]]);
    assert.equal(surface.plan.updates[0].record_id, 'recA1');
    assert.equal(surface.plan.updates[0].fields[WRITABLE_FIELD], 12_000_000);
  });
});

test('采集段把 优先级 的公式预期一起算进工件（回读要靠它判断公式是否结算）', async () => {
  await withFixture('expect', {}, async ({ deps, batch }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch) });
    const surface = JSON.parse(readFileSync(receipt.collect.artifactPath, 'utf8'));
    const byKeyword = new Map(surface.plan.expected.map((item) => [item.keyword, item]));
    // 高搜索 + 高交易 + 高内容 + 浏览量过 1000 万门槛 → A-立即跟进
    assert.equal(byKeyword.get('家用浴缸').expectedPriority, 'A-立即跟进');
    // 中搜索 + 中交易 → B-持续观察（浏览量 0 不参与 A 判定）
    assert.equal(byKeyword.get('小户型浴缸').expectedPriority, 'B-持续观察');
    // 守卫字段必须取自采集时的实况
    assert.equal(byKeyword.get('家用浴缸').guard.内容热度, '高');
    assert.equal(byKeyword.get('小户型浴缸').guard.交易热度, '中');
    assert.equal(surface.plan.expected.length, surface.keywordCount);
  });
});

test('identity 随运行上下文进入车道，且与采集观察一致（source_identity 不是空转）', async () => {
  await withFixture('identity', {}, async ({ deps, batch }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch) });
    assert.deepEqual(receipt.gate.lane.split('/').slice(0, 2), ['sycm', 'keyword-heat']);
  });
});

test('结果文档里的来源平台被改坏 → SOURCE_MISMATCH', async () => {
  await withFixture('source', {
    batch: {
      document: {
        schemaVersion: HUITUN_RESULT_SCHEMA_VERSION,
        source: { ...RESULT_SOURCE, platform: '别的平台', collected_at: new Date().toISOString() },
        target: buildQueueBinding({ appToken: APP_TOKEN, tableId: TABLE_ID, tableName: TABLE_NAME, records: baseRecords(), candidateMode: 'A_ONLY' }),
        items: resultItems(),
      },
    },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'SOURCE_MISMATCH', 'EVIDENCE_INVALID');
  });
});

test('结果文档与队列实况失去绑定 → QUEUE_CHANGED（表名或队列任一变化）', async () => {
  await withFixture('binding', {
    batch: {
      documentTarget: buildQueueBinding({ appToken: APP_TOKEN, tableId: TABLE_ID, tableName: '另一张表', records: baseRecords(), candidateMode: 'A_ONLY' }),
    },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'QUEUE_CHANGED', 'EVIDENCE_INVALID');
  });
});

test('结果文档过期 → RESULT_STALE', async () => {
  await withFixture('stale', {
    batch: { collectedAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString() },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'RESULT_STALE', 'EVIDENCE_INVALID');
  });
});

test('结果文档多出一个关键词 → QUEUE_CHANGED（队列与结果必须逐词对齐）', async () => {
  await withFixture('extra', {
    batch: { items: [...resultItems(), { keyword: '多余词', status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: '无', views: 0 }] },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'QUEUE_CHANGED', 'EVIDENCE_INVALID');
  });
});

test('浏览量文案无法解析 → RESULT_INVALID', async () => {
  await withFixture('viewsraw', {
    batch: { items: [{ keyword: '家用浴缸', status: 'FOUND_EXACT', topic: '#家用浴缸#', viewsRaw: '很多', views: 1 }, { keyword: '小户型浴缸', status: 'NO_EXACT_TOPIC', topic: null, viewsRaw: '无', views: 0 }] },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'RESULT_INVALID', 'EVIDENCE_INVALID');
  });
});

test('目标表名不符 → TABLE_MISMATCH；缺授权字段 → FIELD_MISSING；字段类型不符 → FIELD_TYPE_MISMATCH', async () => {
  await withFixture('tablename', { client: { tables: [{ tableId: TABLE_ID, name: '别的表名' }] } }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'TABLE_MISMATCH', 'POLICY_DENIED');
  });
  await withFixture('fields', {
    client: { fields: REQUIRED_FIELD_TYPES.filter((field) => field.fieldName !== '优先级') },
  }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'FIELD_MISSING', 'POLICY_DENIED');
  });
  await withFixture('fieldtype', {
    client: { fields: REQUIRED_FIELD_TYPES.map((field) => (field.fieldName === WRITABLE_FIELD ? { ...field, type: 1 } : field)) },
  }, async ({ deps, batch }) => {
    // 把数字字段当成文本字段会让「写入成功」静默变成字符串——必须在写之前就拒绝。
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'FIELD_TYPE_MISMATCH', 'POLICY_DENIED');
  });
});

test('队列为空 → NO_CANDIDATES；队列超限 → QUEUE_TOO_LARGE', async () => {
  // 夹具与「目标表实况」必须是同一批行：只改夹具不改假客户端，测的就是另一件事（绑定失效）。
  const onlyBAttempt = [{ record_id: 'recX', fields: { 搜索词: '品牌词', 关键词分类: '品牌词', 优先级: 'B-持续观察' } }];
  await withFixture('nocandidates', { batch: { records: onlyBAttempt }, client: { records: onlyBAttempt } }, async ({ deps, batch }) => {
    // 不伪造一条 0 行的发布：游标要求 end >= 1，把「什么都没做」写成「推进一格」才是谎报。
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'NO_CANDIDATES', 'POLICY_DENIED');
  });
  await withFixture('toolarge', {}, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch, { maxCandidates: 1 })), 'QUEUE_TOO_LARGE', 'POLICY_DENIED');
  });
});

test('上游 AI 分析未完成（存在 优先级=待数据 的行）→ AI_REQUIRED，落 HUMAN_REQUIRED 而不是停线', async () => {
  const records = baseRecords().map((record) => (record.record_id === 'recA2'
    ? { ...record, fields: { ...record.fields, 优先级: '待数据' } }
    : record));
  // binding 由「AI 分析未跑之前的那份队列」给出：本用例要测的是采集期发现上游未就绪，
  // 不是队列绑定失效，因此夹具不能让 buildQueueBinding 先炸掉。
  const binding = buildQueueBinding({ appToken: APP_TOKEN, tableId: TABLE_ID, tableName: TABLE_NAME, records: baseRecords(), candidateMode: 'A_ONLY' });
  await withFixture('airequired', { batch: { records, binding }, client: { records } }, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'AI_REQUIRED', 'HUMAN_REQUIRED');
  });
});

test('candidateMode 不在契约内 → UNSUPPORTED_MODE', async () => {
  await withFixture('mode', {}, async ({ deps, batch }) => {
    await expectCode(readHuitunBatch(collectInputOf(batch, { candidateMode: 'C_ONLY' })), 'UNSUPPORTED_MODE', 'POLICY_DENIED');
  });
});

test('输入缺失：results 文件不存在 → RESULTS_MISSING；env 文件不存在 → CREDENTIALS_UNAVAILABLE', async () => {
  await withFixture('missing', {}, async ({ deps, batch }) => {
    await expectCode(
      readHuitunBatch(collectInputOf(batch, { resultsFile: join(batch.directory, 'nope.json') })),
      'RESULTS_MISSING', 'EVIDENCE_INVALID',
    );
    await expectCode(
      readHuitunBatch(collectInputOf(batch, { envFile: join(batch.directory, 'nope.env') })),
      'CREDENTIALS_UNAVAILABLE', 'HUMAN_REQUIRED',
    );
  });
});

test('采集段失败经运行时落地：确定性 code 必须映射成收据上的 failureClass', async () => {
  const onlyBAttempt = [{ record_id: 'recX', fields: { 搜索词: '品牌词', 关键词分类: '品牌词', 优先级: 'B-持续观察' } }];
  await withFixture('receiptmap', { batch: { records: onlyBAttempt }, client: { records: onlyBAttempt } },
    async ({ deps, batch }) => {
      const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: { expectedRows: null } });
      assert.equal(receipt.ok, false);
      assert.equal(receipt.stage, 'COLLECT');
      assert.equal(receipt.failureClass, 'POLICY_DENIED');
      assert.match(String(receipt.error), /NO_CANDIDATES/u);
      // 采集段失败的收据里没有发布段：发布轴的事实只在运行上下文里，且必须仍是 NOT_REQUESTED
      // （与 two-stage-runner 的核心用例同一口径）。
      assert.equal(receipt.publish, undefined, '采集段失败不允许出现任何发布段结论');
      assert.equal((await deps.controller.getContext(receipt.runId)).publicationStatus, 'NOT_REQUESTED');
    });
});

// ── 工件自检 ────────────────────────────────────────────────────────────────

test('工件字节被篡改 → validate 自检失败（摘要不再匹配）', async () => {
  await withFixture('tamper', {}, async ({ deps, batch }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch) });
    const bytes = Buffer.from(readFileSync(receipt.collect.artifactPath));
    assert.equal((await adapter.validate({ bytes, sha256: sha256Hex(bytes) })).ok, true);
    const tampered = Buffer.from(bytes.toString('utf8').replace('"planUpdates":2', '"planUpdates":3'));
    const verdict = await adapter.validate({ bytes: tampered, sha256: sha256Hex(bytes) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'DIGEST_MISMATCH');
  });
});

test('表面字段与字节不一致 → STRUCTURE_INVALID；用字节单独重建的工件（无 rowCount）也能通过', async () => {
  await withFixture('surface', {}, async ({ deps, batch }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch) });
    const bytes = Buffer.from(readFileSync(receipt.collect.artifactPath));
    const parsed = JSON.parse(bytes.toString('utf8'));
    // 第三方复核路径：只有字节，没有框架派生的表面字段。
    assert.equal((await adapter.validate({ bytes, sha256: sha256Hex(bytes) })).ok, true);
    const lying = { bytes, sha256: sha256Hex(bytes), keywordCount: parsed.keywordCount + 1 };
    const verdict = await adapter.validate(lying);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'STRUCTURE_INVALID');
  });
});

test('工件里没有计划行 → 发布段拒绝（不允许「空写」冒充对账）', async () => {
  const empty = Buffer.from(JSON.stringify({ plan: { updates: [], expected: [] } }), 'utf8');
  assert.throws(() => artifactPlan(empty), (error) => error.code === 'RESULTS_INCOMPLETE');
  assert.throws(() => artifactPlan(Buffer.from('not json', 'utf8')), (error) => error.code === 'RESULTS_INCOMPLETE');
});

// ── 发布段 ──────────────────────────────────────────────────────────────────

test('提交段：写入恰好一次、只含空白行、回读收敛后 VERIFIED 并推进游标', async () => {
  await withFixture('commit', { client: { priorityByRecord: { recA1: 'A-立即跟进', recA2: 'B-持续观察' } } }, async ({ deps, batch, client }) => {
    const receipt = await runHeat({
      deps,
      collectInput: collectInputOf(batch),
      overrides: commitOverrides(batch),
    });
    assert.equal(receipt.gate.status, 'APPROVED');
    assert.equal(receipt.publish.verdict, 'VERIFIED', JSON.stringify(receipt.publish));
    assert.equal(receipt.publicationStatus, 'VERIFIED');
    assert.equal(receipt.executionStatus, 'SUCCEEDED');
    assert.equal(receipt.cursorAdvanced, true);
    assert.deepEqual(receipt.verifiedCursor, { start: 1, end: 2, version: 1 });
    assert.equal(client.calls.updateBatches.length, 1);
    assert.deepEqual(client.calls.updateBatches[0], [
      { record_id: 'recA1', fields: { [WRITABLE_FIELD]: 12_000_000 } },
      { record_id: 'recA2', fields: { [WRITABLE_FIELD]: 0 } },
    ]);
  });
});

test('幂等写入：目标表已有同值（公式也已结算）→ 不产生第二次写入，回读仍然收敛', async () => {
  await withFixture('idempotent', {}, async ({ deps, batch, client }) => {
    const collected = await runHeat({ deps, collectInput: collectInputOf(batch) });
    // 模拟「上一次尝试已经把值写进去了、公式也结算了，但本地账本没记上」——这是 UNKNOWN 对账要跑通的那个状态。
    // 注意此时这两行已经**不是 A 候选**了（公式把 优先级 改写成了结算值）：这正是发布段不能把
    // 「队列指纹变化」当成无条件拒绝的原因。
    for (const [recordId, views, priority] of [['recA1', 12_000_000, 'A-立即跟进'], ['recA2', 0, 'B-持续观察']]) {
      const record = client.table.find((item) => item.record_id === recordId);
      record.fields[WRITABLE_FIELD] = views;
      record.fields.优先级 = priority;
    }
    const publisher = createPublisher({
      artifactBytes: readFileSync(collected.collect.artifactPath),
      publishInput: { target: { appToken: batch.appToken, tableId: batch.tableId, tableName: batch.tableName }, envFile: batch.envFile },
    });
    const outcome = await publisher.handler();
    assert.deepEqual(outcome.writtenRecordIds, []);
    assert.deepEqual(outcome.alreadySettledRecordIds, ['recA1', 'recA2']);
    assert.equal(client.calls.updateBatches.length, 0, '已经写过的行不允许再写一次');
    // 指纹此刻必然不匹配（行已离开 A候选 队列）：收据要把这个事实记下来，而不是把它当成失败。
    assert.equal(outcome.queueFingerprintMatched, false);
    // 回读证明「状态已经成立」——幂等重跑的成功判据是实况，不是写入次数。
    const receipt = await publisher.readBack();
    assert.equal(receipt.rows, 2, JSON.stringify(receipt));
    assert.equal(typeof receipt.verifiedAt, 'string', JSON.stringify(receipt));
  });
});

test('已有别的值 → OVERWRITE_REFUSED（策略拒绝，不是静默跳过）', async () => {
  const records = baseRecords().map((record) => (record.record_id === 'recA1'
    ? { ...record, fields: { ...record.fields, [WRITABLE_FIELD]: 999 } }
    : record));
  await withFixture('overwrite', { batch: { records }, client: { records } }, async ({ deps, batch, client }) => {
    // 「拒绝覆盖」与「幂等跳过」必须分开：合并会让一次越权改写被当作正常运行记进账本。
    // 采集段就拒绝（读到实况后即可判定），不等提交——一次注定要被拒的批准不该走完发布路径。
    await expectCode(readHuitunBatch(collectInputOf(batch)), 'OVERWRITE_REFUSED', 'POLICY_DENIED');
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: commitOverrides(batch) });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'POLICY_DENIED');
    assert.equal(client.calls.updateBatches.length, 0);
  });
});

test('写前守卫字段被改动 → GUARD_FIELD_CHANGED，且一次写入都没有发生', async () => {
  await withFixture('guard', {}, async ({ deps, batch, client }) => {
    const collected = await runHeat({ deps, collectInput: collectInputOf(batch) });
    // 采集之后、提交之前：有人改了决定优先级公式的输入字段。
    client.table.find((record) => record.record_id === 'recA1').fields.交易热度 = '低';
    const publisher = createPublisher({
      artifactBytes: readFileSync(collected.collect.artifactPath),
      publishInput: { target: { appToken: batch.appToken, tableId: batch.tableId, tableName: batch.tableName }, envFile: batch.envFile },
    });
    await expectCode(publisher.handler(), 'GUARD_FIELD_CHANGED', 'EVIDENCE_INVALID');
    assert.equal(client.calls.updateBatches.length, 0);
  });
});

test('写前队列指纹变化（新增一个 A 候选）→ QUEUE_CHANGED，且一次写入都没有发生', async () => {
  await withFixture('queuechanged', {}, async ({ deps, batch, client }) => {
    const collected = await runHeat({ deps, collectInput: collectInputOf(batch) });
    client.table.push({ record_id: 'recA3', fields: { 搜索词: '新词', 关键词分类: '场景词', 细分标签: '卫浴', 搜索热度: '高', 交易热度: '高', 内容热度: '高', 优先级: 'A候选' } });
    const publisher = createPublisher({
      artifactBytes: readFileSync(collected.collect.artifactPath),
      publishInput: { target: { appToken: batch.appToken, tableId: batch.tableId, tableName: batch.tableName }, envFile: batch.envFile },
    });
    await expectCode(publisher.handler(), 'QUEUE_CHANGED', 'EVIDENCE_INVALID');
    assert.equal(client.calls.updateBatches.length, 0);
  });
});

test('请求目标与已审批工件不一致 → REJECTED 并留下收据，而不是把运行留在 RUNNING', async () => {
  await withFixture('target', {}, async ({ deps, batch, client }) => {
    const receipt = await runHeat({
      deps,
      collectInput: collectInputOf(batch),
      overrides: commitOverrides(batch, { target: { appToken: batch.appToken, tableId: 'tblAnotherTarget', tableName: batch.tableName } }),
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publish.verdict, 'REJECTED');
    assert.equal(receipt.publicationStatus, 'READY');
    assert.equal(receipt.executionStatus, null);
    assert.equal(client.calls.updateBatches.length, 0);
  });
});

test('createPublisher 的边界：缺 artifactBytes → RESULTS_MISSING；缺 target → TARGET_REQUIRED', async () => {
  await withFixture('factoryboundary', {}, async ({ deps, batch }) => {
    assert.throws(() => createPublisher({}), (error) => error.code === 'RESULTS_MISSING');
    const collected = await runHeat({ deps, collectInput: collectInputOf(batch) });
    assert.throws(
      () => createPublisher({ artifactBytes: readFileSync(collected.collect.artifactPath), publishInput: {} }),
      (error) => error.code === 'TARGET_REQUIRED',
    );
  });
});

test('写入失败分流：5xx → UNKNOWN 等对账；4xx → 确定性拒绝 REJECTED', async () => {
  await withFixture('unknown', {}, async ({ deps, batch }) => {
    installFakeFeishu(fakeFeishu({ failUpdateWith: Object.assign(new Error('internal error'), { status: 500 }) }));
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: commitOverrides(batch) });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publicationStatus, 'UNKNOWN', JSON.stringify(receipt.publish));
    assert.equal(receipt.executionStatus, null, '未结算的运行不许自称成功');
    assert.equal(receipt.cursorAdvanced, false);
  });
  await withFixture('rejected', {}, async ({ deps, batch }) => {
    installFakeFeishu(fakeFeishu({ failUpdateWith: Object.assign(new Error('invalid field name'), { status: 400 }) }));
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: commitOverrides(batch) });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publish.verdict, 'REJECTED');
    assert.equal(receipt.publicationStatus, 'READY');
    assert.equal(receipt.cursorAdvanced, false);
  });
});

test('优先级公式始终不结算 → 回读不收敛，收据不带 verifiedAt，判 UNKNOWN 而不是 VERIFIED', async () => {
  // 默认 priorityByRecord 为空 = 公式一直没重算，这正是最危险的失败模式：
  // 浏览量写进去了，但决定跟不跟进的字段还没有值。
  await withFixture('nosettle', {}, async ({ deps, batch, client }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: commitOverrides(batch, { settleTimeoutMs: 40 }) });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.publicationStatus, 'UNKNOWN', JSON.stringify(receipt.publish));
    assert.equal(receipt.executionStatus, null);
    assert.equal(receipt.cursorAdvanced, false);
    // 写入确实发生了——不能因为回读失败就说「没写」。
    assert.equal(client.calls.updateBatches.length, 1);
  });
});

test('人工闸门：--commit 未记录审批人 → 停在 HUMAN_REQUIRED，一次外部调用都没发生', async () => {
  await withFixture('gate', {}, async ({ deps, batch, client }) => {
    const receipt = await runHeat({ deps, collectInput: collectInputOf(batch), overrides: { commit: true } });
    assert.equal(receipt.admitted, true);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
    assert.equal(receipt.gate.status, 'WAITING_HUMAN');
    assert.equal(client.calls.listTables + client.calls.listRecords + client.calls.updateBatches.length, 0);
  });
});

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('isUnknownWriteFailure 逐条：只有可能已经落库的失败才进 UNKNOWN', () => {
  assert.equal(isUnknownWriteFailure({ status: 500 }), true);
  assert.equal(isUnknownWriteFailure({ status: 400 }), false);
  assert.equal(isUnknownWriteFailure({ status: 403 }), false);
  assert.equal(isUnknownWriteFailure({ status: 429 }), true);
  assert.equal(isUnknownWriteFailure({ statusCode: 408 }), true);
  assert.equal(isUnknownWriteFailure({ code: 'ETIMEDOUT' }), true);
  assert.equal(isUnknownWriteFailure(new Error('fetch failed')), true);
  assert.equal(isUnknownWriteFailure(new Error('socket hang up')), true);
  assert.equal(isUnknownWriteFailure(new Error('invalid field name')), false);
});

test('translateFlowError 把中文策略结论映射成确定性分类，未知异常原样抛出', () => {
  assert.equal(translateFlowError(new Error('Huitun result is stale or expired')).code, 'RESULT_STALE');
  assert.equal(translateFlowError(new Error('Huitun result binding does not match the live queue')).code, 'QUEUE_CHANGED');
  assert.equal(translateFlowError(new Error('Refusing to overwrite 灰豚话题浏览量 for 家用浴缸: 999')).code, 'OVERWRITE_REFUSED');
  assert.equal(translateFlowError(new Error('Unsupported Huitun candidate mode: X')).code, 'UNSUPPORTED_MODE');
  assert.equal(translateFlowError(new Error('Live A-candidate queue differs from Huitun results: []')).code, 'QUEUE_CHANGED');
  const mapped = translateFlowError(Object.assign(new Error('3 populated row(s) are not ready for Huitun'), { code: 'AI_REQUIRED' }));
  assert.equal(mapped.code, 'AI_REQUIRED');
  assert.equal(mapped.failureClass, 'HUMAN_REQUIRED');
  // 未命中规则的异常不能被一个「看起来合理」的分类藏起来。
  const bug = new Error('unexpected internal invariant');
  assert.equal(translateFlowError(bug), bug);
  // 已经是确定性错误的，不再包装。
  const known = new HuitunEvidenceError('x', 'QUEUE_CHANGED');
  assert.equal(translateFlowError(known), known);
});

test('buildReadbackReceipt：归一化数字/富文本字段，分离缺失、浏览量不符、公式未结算与守卫漂移', () => {
  const expected = [
    { recordId: 'r1', keyword: 'a', views: 100, expectedPriority: 'A-立即跟进', guard: { 搜索词: 'a', 内容热度: '高' } },
    { recordId: 'r2', keyword: 'b', views: 200, expectedPriority: 'B-持续观察', guard: { 搜索词: 'b' } },
    { recordId: 'r3', keyword: 'c', views: 300, expectedPriority: 'C-常规跟踪', guard: { 搜索词: 'c' } },
    { recordId: 'r4', keyword: 'd', views: 400, expectedPriority: 'C-常规跟踪', guard: { 搜索词: 'd', 内容热度: '低' } },
    { recordId: 'r5', keyword: 'e', views: 500, expectedPriority: 'C-常规跟踪', guard: { 搜索词: 'e' } },
  ];
  const records = [
    { record_id: 'r1', fields: { 搜索词: [{ text: 'a' }], 内容热度: '高', [WRITABLE_FIELD]: '100', 优先级: 'A-立即跟进' } },
    { record_id: 'r2', fields: { 搜索词: 'b', [WRITABLE_FIELD]: 999, 优先级: 'B-持续观察' } },
    { record_id: 'r3', fields: { 搜索词: 'c', [WRITABLE_FIELD]: 300, 优先级: '待数据' } },
    { record_id: 'r4', fields: { 搜索词: 'd', 内容热度: '中', [WRITABLE_FIELD]: 400, 优先级: 'C-常规跟踪' } },
  ];
  const receipt = buildReadbackReceipt({ expected, records, tableId: 'tbl' });
  assert.equal(receipt.verifiedAt, null, '未收敛的回读收据不能带 verifiedAt');
  assert.equal(receipt.rows, 1);
  assert.equal(receipt.expectedRows, 5);
  assert.deepEqual(receipt.missing, ['r5']);
  assert.deepEqual(receipt.viewsMismatched, [{ recordId: 'r2', keyword: 'b', expected: 200, actual: '999' }]);
  assert.deepEqual(receipt.priorityPending.map((item) => item.recordId), ['r3']);
  assert.deepEqual(receipt.guardDrift.map((item) => item.recordId), ['r4']);
  assert.deepEqual(receipt.verified, [{ recordId: 'r1', keyword: 'a', views: 100, priority: 'A-立即跟进' }]);
  // 收敛时才有 verifiedAt，且摘要只覆盖已核验行。
  const converged = buildReadbackReceipt({ expected: [expected[0]], records: [records[0]], tableId: 'tbl' });
  assert.equal(typeof converged.verifiedAt, 'string');
  assert.equal(converged.rows, 1);
  assert.match(converged.digest, /^[0-9a-f]{64}$/u);
  // 同一批事实必须得到同一摘要（否则回读结果不可复算）。
  assert.equal(buildReadbackReceipt({ expected: [expected[0]], records: [records[0]], tableId: 'tbl' }).digest, converged.digest);
});

test('stableJson 与 sha256Hex 是确定性的（摘要绑定必须可复算）', () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(plain({ text: '  x ' }), 'x');
});
