import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'scripts', 'run-huitun-topic-heat.mjs');
const runner = await import('../scripts/run-huitun-topic-heat.mjs');
const buildAiRequiredManifest = runner.buildAiRequiredManifest ?? (() => assert.fail('missing export: buildAiRequiredManifest'));
const waitForFormulaSettlement = runner.waitForFormulaSettlement ?? (() => assert.fail('missing export: waitForFormulaSettlement'));

test('CLI documents the complete candidate-to-backfill workflow', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /A候选/u);
  assert.match(result.stdout, /--apply/u);
  assert.match(result.stdout, /--confirm-table/u);
  assert.match(result.stdout, /--results/u);
  assert.match(result.stdout, /--result-max-age-hours/u);
  assert.match(result.stdout, /--table-id ID\s+Required weekly Feishu table ID/iu);
  assert.match(result.stdout, /--table-name TEXT\s+Required exact weekly table name/iu);
  assert.doesNotMatch(result.stdout, /Defaults point to/iu);
});

test('CLI self-test is network-free', () => {
  const result = spawnSync(process.execPath, [cli, '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    checks: {
      options: true,
      exactMatch: true,
      noExact: true,
      risk: true,
      provenance: true,
      mutation: true,
    },
  });
});

test('AI_REQUIRED produces a terminal local manifest without credential data', () => {
  const manifest = buildAiRequiredManifest({
    runId: 'run-1',
    options: { tableId: 'tblCurrent', tableName: '关键词分析 V1（2026-08-14）' },
    snapshot: { fields: [{ field_name: '搜索词' }], records: [{ record_id: 'rec1' }] },
    error: { code: 'AI_REQUIRED', details: { pendingCount: 267 } },
    runDir: 'D:\\runs\\run-1',
  });
  assert.deepEqual(manifest, {
    status: 'AI_REQUIRED',
    runId: 'run-1',
    target: { tableId: 'tblCurrent', tableName: '关键词分析 V1（2026-08-14）' },
    fieldCount: 1,
    recordCount: 1,
    pendingCount: 267,
    runDir: 'D:\\runs\\run-1',
  });
  assert.equal(JSON.stringify(manifest).includes('token'), false);
});

test('formula settlement reads Feishu array-formatted formula text', async () => {
  const records = [{
    record_id: 'rec1',
    fields: { 优先级: [{ text: 'B-持续观察' }] },
  }];
  let calls = 0;
  const result = await waitForFormulaSettlement(
    { listRecords: async () => {
      calls += 1;
      if (calls > 1) throw new Error('formula value was not recognized on the first poll');
      return records;
    } },
    { expected: [{ recordId: 'rec1', expectedPriority: 'B-持续观察' }] },
  );
  assert.equal(result, records);
});
