// 灰豚能力的**调度侧探测**（probeQueue）用例。
//
// 为什么单独一个文件：探测和采集是两件事，判断标准也不同。
// 采集段的 refusing 是「这批词为什么不能写」，探测的结论是「现在有没有活」——
// 后者一旦判错，方向是**静默漏做**（把有活的队列当成空队列跳过），因此它需要自己的一组用例：
//  1. 三种正向结论（READY / EMPTY / WAITING_HUMAN）各自只由一种实况触发；
//  2. **探测不做策略判决**：表名、字段类型、队列规模这些归采集段管，探测里不许复制一份，
//     否则会出现「探测说有活、采集段却拒绝」的假矛盾，两份判决早晚不一致；
//  3. 探测**只读**：一次写调用都不能有，也不建运行；
//  4. 与调度器串起来：空队列 → 跳过且一条运行都没创建；有活 → 照常发起。
//
// 全程不碰真实飞书、不碰浏览器：飞书客户端与 env 读取走 setDependenciesForTest 注入。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  HuitunEvidenceError,
  PROBE_REQUIRED_INPUT_KEYS,
  QUEUE_PROBE_SCHEMA_VERSION,
  QUEUE_PROBE_STATES,
  REQUIRED_FIELDS,
  capabilityId,
  probeHuitunQueue,
  probeQueue,
  resetStateForTest,
  setDependenciesForTest,
} from '../scripts/adapter.huitun-keyword-heat.mjs';

import { buildRegistryFromDisk } from '../../../runtime/sop-runtime/build-skill-registry.mjs';
import { createLoader } from '../../../runtime/sop-runtime/skill-loader.mjs';
import { createMemoryStore } from '../../../runtime/sop-runtime/stores/memory-store.mjs';
import { createController } from '../../../runtime/sop-runtime/workflow-controller.mjs';
import { createSideEffectLedger } from '../../../runtime/sop-runtime/side-effect-ledger.mjs';
import { createEvidenceStore } from '../../../runtime/sop-runtime/evidence-store.mjs';
import { runScheduled } from '../../../runtime/sop-runtime/capability-scheduler.mjs';

const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const TABLE_ID = 'tblHuitunKeyword01';
const TABLE_NAME = '关键词库_夹具';
const ENV_TEXT = 'FEISHU_APP_ID=cli_app\nFEISHU_APP_SECRET=cli_secret\n';

const IDENTITY = {
  tenantId: 'sycm', storeId: 'keyword-heat', platform: 'xhs',
  accountId: 'operator', browserProfileId: 'edge-isolated', contractVersion: 'sop-context-v1',
};

// 字段类型直接从能力自己的 REQUIRED_FIELDS 派生，不手抄（手抄顺序/取值抄错时，
// 断言会在端口内部抛出并被端口自己的 catch 收成别的结论，把「测试写错」伪装成「实现失败」）。
const FIELD_TYPES = Object.entries(REQUIRED_FIELDS).map(([fieldName, type]) => ({
  fieldName,
  type: type ?? 1,
}));

function recordOf(recordId, overrides = {}) {
  return {
    record_id: recordId,
    fields: {
      搜索词: '家用浴缸',
      关键词分类: '场景词',
      细分标签: '卫浴',
      搜索热度: '高',
      交易热度: '高',
      内容热度: '高',
      优先级: 'A候选',
      ...overrides,
    },
  };
}

const A_CANDIDATES = () => [
  recordOf('recA1', { 搜索词: '家用浴缸' }),
  recordOf('recA2', { 搜索词: '小户型浴缸', 搜索热度: '中', 交易热度: '中', 内容热度: '低' }),
];

const NO_CANDIDATES = () => [
  recordOf('recB1', { 搜索词: '浴缸品牌', 优先级: 'B-持续观察' }),
  recordOf('recB2', { 搜索词: '浴缸尺寸', 优先级: 'C-暂不跟进' }),
];

const AWAITING_AI = () => [
  recordOf('recPending', { 搜索词: '浴缸推荐', 优先级: '' }),
  recordOf('recA1', { 搜索词: '家用浴缸' }),
];

// 只读假客户端：把「有没有发生写」变成可断言的计数，而不是靠相信实现。
function fakeFeishu({ records = A_CANDIDATES(), tables = null, fields = null } = {}) {
  const calls = { listTables: 0, listFields: 0, listRecords: 0, writes: 0 };
  return {
    calls,
    async listTables() {
      calls.listTables += 1;
      return tables ?? [{ tableId: TABLE_ID, name: TABLE_NAME }];
    },
    async listFields() {
      calls.listFields += 1;
      return fields ?? FIELD_TYPES.map((field) => ({ ...field }));
    },
    async listRecords() {
      calls.listRecords += 1;
      return records.map((record) => ({ record_id: record.record_id, fields: { ...record.fields } }));
    },
    async batchUpdateRecords() {
      calls.writes += 1;
      throw new Error('the queue probe must never write');
    },
  };
}

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), 'huitun-probe-'));
  const envFile = join(dir, '.env.fixture');
  await writeFile(envFile, ENV_TEXT, 'utf8');
  return { dir, envFile };
}

function probeInputOf(envFile, overrides = {}) {
  return { envFile, appToken: APP_TOKEN, tableId: TABLE_ID, tableName: TABLE_NAME, ...overrides };
}

test('READY：队列里有 A 候选即报有活，且整个探测过程一次写调用都没有', async () => {
  const { envFile } = await fixtureDir();
  const client = fakeFeishu();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => client });
  try {
    const probe = await probeHuitunQueue(probeInputOf(envFile));
    assert.equal(probe.state, 'READY');
    assert.equal(probe.code, 'CANDIDATES_READY');
    assert.equal(probe.candidateCount, 2);
    assert.equal(probe.schemaVersion, QUEUE_PROBE_SCHEMA_VERSION);
    assert.equal(probe.capabilityId, capabilityId);
    assert.equal(probe.tableId, TABLE_ID);
    assert.equal(probe.tableName, TABLE_NAME);
    assert.deepEqual(client.calls, { listTables: 1, listFields: 1, listRecords: 1, writes: 0 }, '探测只读，且每个只读面只读一次');
  } finally {
    resetStateForTest();
  }
});

test('EMPTY：没有 A 候选就是「本周没有要补的词」，不是失败', async () => {
  const { envFile } = await fixtureDir();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu({ records: NO_CANDIDATES() }) });
  try {
    const probe = await probeHuitunQueue(probeInputOf(envFile));
    assert.equal(probe.state, 'EMPTY');
    assert.equal(probe.code, 'NO_CANDIDATES');
    assert.equal(probe.candidateCount, 0);
    assert.match(probe.reason, /candidate queue is empty/u);
  } finally {
    resetStateForTest();
  }
});

test('WAITING_HUMAN：还有内容行没结算完 → 等人工，并把待结算的行带出来', async () => {
  const { envFile } = await fixtureDir();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu({ records: AWAITING_AI() }) });
  try {
    const probe = await probeHuitunQueue(probeInputOf(envFile));
    assert.equal(probe.state, 'WAITING_HUMAN');
    assert.equal(probe.code, 'AI_REQUIRED');
    assert.equal(probe.pendingCount, 1);
    assert.deepEqual(probe.sampleKeywords, ['浴缸推荐']);
    assert.equal(probe.candidateCount, null, '未结算时候选数未知，不能编成 0');
  } finally {
    resetStateForTest();
  }
});

test('探测不做策略判决：表名/字段类型/队列规模都归采集段管，探测里不许复制第二份', async () => {
  const { envFile } = await fixtureDir();
  // 表名不符：原样抛 TABLE_MISMATCH（调度器会把它收成「没结论」，而不是「空队列」）。
  setDependenciesForTest({
    readEnvFile: async () => ENV_TEXT,
    createClient: async () => fakeFeishu({ tables: [{ tableId: TABLE_ID, name: '另一个表' }] }),
  });
  try {
    await assert.rejects(
      () => probeHuitunQueue(probeInputOf(envFile)),
      (error) => error instanceof HuitunEvidenceError && error.code === 'TABLE_MISMATCH',
    );
  } finally {
    resetStateForTest();
  }

  // 字段类型不符：同样原样抛（不在这里改成「没活」）。
  setDependenciesForTest({
    readEnvFile: async () => ENV_TEXT,
    createClient: async () => fakeFeishu({
      fields: FIELD_TYPES.map((field) => (field.fieldName === '灰豚话题浏览量' ? { ...field, type: 1 } : { ...field })),
    }),
  });
  try {
    await assert.rejects(
      () => probeHuitunQueue(probeInputOf(envFile)),
      (error) => error instanceof HuitunEvidenceError && error.code === 'FIELD_TYPE_MISMATCH',
    );
  } finally {
    resetStateForTest();
  }

  // 队列规模：探测不复制采集段的 maxCandidates 判决——60 行候选照样报 READY，
  // 让采集段自己去拒绝（QUEUE_TOO_LARGE）。两份判决只留一份，才不会有假矛盾。
  const many = Array.from({ length: 60 }, (_, index) => recordOf(`rec${index}`, { 搜索词: `关键词${index}` }));
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu({ records: many }) });
  try {
    const probe = await probeHuitunQueue(probeInputOf(envFile, { maxCandidates: 10 }));
    assert.equal(probe.state, 'READY');
    assert.equal(probe.candidateCount, 60);
    assert.ok(!Object.hasOwn(probe, 'maxCandidates'), '探测的结论里不该出现采集段的规模判决');
  } finally {
    resetStateForTest();
  }
});

test('探测不要求 resultsFile：它发生在浏览器采集之前，那时结果文件还不存在', async () => {
  const { envFile } = await fixtureDir();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu() });
  try {
    assert.deepEqual([...PROBE_REQUIRED_INPUT_KEYS], ['envFile', 'appToken', 'tableId', 'tableName']);
    assert.ok(!PROBE_REQUIRED_INPUT_KEYS.includes('resultsFile'), '把 resultsFile 设成探测前置条件会让探测永远探不出 READY');
    const probe = await probeHuitunQueue(probeInputOf(envFile));
    assert.equal(probe.state, 'READY', '没有 resultsFile 也能探出「有活」');
  } finally {
    resetStateForTest();
  }
});

test('探测输入缺失即拒绝（用自己的码，不冒充采集段的 RESULTS_MISSING）', async () => {
  const { envFile } = await fixtureDir();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu() });
  try {
    for (const key of PROBE_REQUIRED_INPUT_KEYS) {
      const input = probeInputOf(envFile);
      delete input[key];
      await assert.rejects(
        () => probeHuitunQueue(input),
        (error) => error instanceof HuitunEvidenceError && error.code === 'PROBE_INPUT_MISSING' && error.details.key === key,
        `${key} 缺失时必须给出 PROBE_INPUT_MISSING`,
      );
    }
    await assert.rejects(
      () => probeHuitunQueue(probeInputOf(envFile, { candidateMode: 'C_MODE' })),
      (error) => error instanceof HuitunEvidenceError && error.code === 'UNSUPPORTED_MODE',
    );
  } finally {
    resetStateForTest();
  }
});

test('凭据不可用原样抛出，由调度器判为「没结论」（绝不悄悄返回空队列）', async () => {
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu() });
  try {
    await assert.rejects(
      () => probeHuitunQueue(probeInputOf(join(tmpdir(), 'definitely-missing-env-file'))),
      (error) => error instanceof HuitunEvidenceError && error.code === 'CREDENTIALS_UNAVAILABLE',
    );
  } finally {
    resetStateForTest();
  }
});

test('契约形状：导出名是调度器固定的 probeQueue，且它只吃 collectInput', async () => {
  const { envFile } = await fixtureDir();
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu() });
  try {
    const probe = await probeQueue({ collectInput: probeInputOf(envFile) });
    assert.equal(probe.state, 'READY');
    assert.deepEqual([...QUEUE_PROBE_STATES], ['READY', 'EMPTY', 'WAITING_HUMAN'], '能力只回三种正向状态，其余由调度器派生');
  } finally {
    resetStateForTest();
  }
});

// ── 与调度器串起来（真实注册表 + 真实 loader） ────────────────────────────────
async function schedulerHarness(root) {
  const { registry, result } = await buildRegistryFromDisk();
  assert.equal(result.ok, true, `registry must be valid: ${JSON.stringify(result.errors ?? [])}`);
  const base = createMemoryStore();
  const runs = { created: 0 };
  const store = {
    ...base,
    createRun: async (args) => {
      runs.created += 1;
      return base.createRun(args);
    },
  };
  const workDir = resolve(root, 'work');
  await mkdir(workDir, { recursive: true });
  return {
    registry,
    loader: createLoader({ registry }),
    store,
    controller: createController({ store }),
    ledger: createSideEffectLedger({ store }),
    evidenceStore: createEvidenceStore({ root: resolve(workDir, 'evidence') }),
    runs,
    workDir,
  };
}

async function scheduleHeat({ dir, records, collectInput = {}, options = {} }) {
  const envFile = join(dir, '.env.fixture');
  setDependenciesForTest({ readEnvFile: async () => ENV_TEXT, createClient: async () => fakeFeishu({ records }) });
  const harness = await schedulerHarness(dir);
  try {
    const receipt = await runScheduled({
      registry: harness.registry,
      loader: harness.loader,
      store: harness.store,
      controller: harness.controller,
      ledger: harness.ledger,
      evidenceStore: harness.evidenceStore,
      workDir: harness.workDir,
      capabilityId,
      identity: { ...IDENTITY },
      businessKey: `huitun|${TABLE_ID}`,
      collectInput: probeInputOf(envFile, collectInput),
      ...options,
    });
    return { receipt, runs: harness.runs };
  } finally {
    resetStateForTest();
  }
}

test('调度器 × 空队列：跳过，且一条运行都没创建', async () => {
  const { dir } = await fixtureDir();
  const { receipt, runs } = await scheduleHeat({ dir, records: NO_CANDIDATES() });
  assert.equal(receipt.outcome, 'SKIPPED_EMPTY_QUEUE');
  assert.equal(receipt.scheduled, false);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.queueState, 'EMPTY');
  assert.equal(receipt.queueCode, 'NO_CANDIDATES');
  assert.equal(receipt.candidateCount, 0);
  assert.equal(receipt.run, null);
  assert.equal(runs.created, 0, '空队列不得留下失败的运行记录——这正是这条驱动器存在的理由');
});

test('调度器 × 等上游 AI：暂停等人工，同样不创建运行', async () => {
  const { dir } = await fixtureDir();
  const { receipt, runs } = await scheduleHeat({ dir, records: AWAITING_AI() });
  assert.equal(receipt.outcome, 'PAUSED_FOR_HUMAN');
  assert.equal(receipt.scheduled, false);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.humanRequired, true);
  assert.equal(receipt.failureClass, 'HUMAN_REQUIRED');
  assert.equal(receipt.probe.detail.pendingCount, 1, '能力自带的细节要留在 detail 里（不再被套第二层）');
  assert.equal(runs.created, 0);
});

test('调度器 × 有活：照常发起真实运行（这里因缺 resultsFile 在采集段确定性失败，但运行确实被创建）', async () => {
  const { dir } = await fixtureDir();
  const { receipt, runs } = await scheduleHeat({ dir, records: A_CANDIDATES(), collectInput: { resultsFile: join(dir, 'absent-results.json') } });
  assert.equal(receipt.outcome, 'RAN');
  assert.equal(receipt.scheduled, true);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.failureClass, 'EVIDENCE_INVALID', '缺结果文件是采集段的确定性拒绝，不是探测该管的事');
  assert.equal(receipt.run.stage, 'COLLECT');
  assert.equal(runs.created, 1, '有活就必须真的发起');
});
