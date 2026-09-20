import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildPublishPlan, canonicalDigest } from '../../../runtime/weekly-local-analysis.mjs';
import { activeProfileName, envFilePath } from '../../../runtime/feishu-targets.mjs';
import { parseOptions, runPostAiWorkflow } from '../scripts/run-weekly-post-ai.mjs';

const current = buildPublishPlan({
  appToken: 'appToken',
  currentTable: { tableId: 'tblCurrent', tableName: '关键词分析 V1（2026-08-21）' },
  updates: [{ record_id: 'rec1', fields: { 内容热度: '中' } }],
});
const publishPlan = {
  appToken: 'appToken',
  tables: {
    current,
    history: {
      tableId: 'tblHistory', tableName: '关键词历史总表 V1',
      creates: [], updates: [{ record_id: 'hist1', fields: { 优先级: 'A候选' } }],
    },
    library: {
      tableId: 'tblLibrary', tableName: '关键词编号库 V1',
      creates: [],
    },
  },
};
const artifact = {
  status: 'PUBLISH_READY',
  artifactDigest: 'artifact-digest',
  evidence: { source: { csvSha256: 'csv', xlsxSha256: 'xlsx' }, providerDigest: 'provider', promptDigest: 'prompt' },
  publishPlan: { ...publishPlan, planDigest: canonicalDigest(publishPlan) },
};

function options(args = []) {
  return parseOptions(['--publish-artifact', 'artifact.json', ...args], {
    readArtifact: () => artifact,
  });
}

test('post rejects obsolete READY_FOR_AI manifests', () => {
  assert.throws(() => parseOptions(['--pre-ai-manifest', 'old.json'], {
    readArtifact: () => ({ status: 'READY_FOR_AI' }),
    readManifest: () => ({ status: 'READY_FOR_AI' }),
  }), /obsolete|PUBLISH_READY/iu);
});

test('publish artifact requires exact confirmations in apply mode', () => {
  assert.equal(options().apply, false);
  assert.throws(() => options(['--apply']), /confirm-base/iu);
  assert.throws(() => options(['--apply', '--confirm-base', 'appToken']), /confirm-current-table/iu);
  assert.equal(options([
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory', '--confirm-library-table', 'tblLibrary',
  ]).apply, true);
});

test('dry-run validates the frozen target and performs no mutation', async () => {
  const calls = [];
  const result = await runPostAiWorkflow(options(), {
    readTarget: async () => ({
      records: [{ record_id: 'rec1', fields: { 内容热度: '中' } }],
      tables: {
        history: { records: [{ record_id: 'hist1', fields: { 优先级: '旧值' } }] },
        library: { records: [] },
      },
      api: { batchUpdate: async () => calls.push('write') },
    }),
  });
  assert.equal(result.status, 'PUBLISH_DRY_RUN_READY');
  assert.equal(result.planDigest, artifact.publishPlan.planDigest);
  assert.deepEqual(result.tables, { current: { updates: 1 }, history: { creates: 0, updates: 1 }, library: { creates: 0 } });
  assert.deepEqual(calls, []);
});

test('apply writes the frozen plan once and verifies by rereading', async () => {
  const calls = [];
  const api = {
    batchUpdate: async (tableId, updates) => calls.push({ tableId, updates }),
    batchCreate: async (tableId, creates) => calls.push({ tableId, creates }),
    listRecords: async (tableId) => tableId === 'tblCurrent'
      ? [{ record_id: 'rec1', fields: { 内容热度: '中' } }]
      : tableId === 'tblHistory'
        ? [{ record_id: 'hist1', fields: { 优先级: 'A候选' } }]
        : [],
  };
  const result = await runPostAiWorkflow(options([
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory', '--confirm-library-table', 'tblLibrary',
  ]), { readTarget: async () => ({ api, records: [{ record_id: 'rec1', fields: { 内容热度: '中' } }], tables: {
    history: { records: [{ record_id: 'hist1', fields: { 优先级: '旧值' } }] }, library: { records: [] },
  } }) });
  assert.equal(result.status, 'PUBLISHED_AND_VERIFIED');
  assert.deepEqual(calls, [
    { tableId: 'tblCurrent', updates: artifact.publishPlan.tables.current.updates },
    { tableId: 'tblHistory', updates: artifact.publishPlan.tables.history.updates },
  ]);
});

test('publish stops before mutation when the target records drift', async () => {
  let writes = 0;
  await assert.rejects(runPostAiWorkflow(options([
    '--apply', '--confirm-base', 'appToken', '--confirm-current-table', 'tblCurrent',
    '--confirm-history-table', 'tblHistory', '--confirm-library-table', 'tblLibrary',
  ]), {
    readTarget: async () => ({
      records: [{ record_id: 'different-record' }],
      tables: { history: { records: [] }, library: { records: [] } },
      api: { batchUpdate: async () => { writes += 1; } },
    }),
  }), /publish record mismatch/iu);
  assert.equal(writes, 0);
});

// 默认凭据文件必须来自租户登记表。这一条与 pre-ai / update-weekly-base 两侧同因：
// 脚本里写死旧租户的 E:/小红书/.env.local，而 base 已经搬到 kcne618basvj，
// 于是「拿旧租户凭据读新租户 base」报 91403 Forbidden —— 会被误读成
// 「应用没被加为协作者」的假故障（2026-09-20 实测）。
// 断言对着访问器而不是字面量：写死字面量等于把当前默认值固化成测试。
test('the default credentials file comes from the tenant registry', () => {
  assert.equal(options().envFile, envFilePath(activeProfileName()));

  const source = readFileSync(new URL('../scripts/run-weekly-post-ai.mjs', import.meta.url), 'utf8');
  assert.match(source, /envFile: envFilePath\(activeProfileName\(\)\)/u);
  assert.doesNotMatch(source, /envFile: 'E:\//u);
});
