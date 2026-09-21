import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { USAGE_LIMIT_CODE } from '../scripts/flow.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'scripts', 'run-huitun-topic-heat.mjs');
const runner = await import('../scripts/run-huitun-topic-heat.mjs');
const buildAiRequiredManifest = runner.buildAiRequiredManifest ?? (() => assert.fail('missing export: buildAiRequiredManifest'));
const waitForFormulaSettlement = runner.waitForFormulaSettlement ?? (() => assert.fail('missing export: waitForFormulaSettlement'));
const cliExitCodeFor = runner.cliExitCodeFor ?? (() => assert.fail('missing export: cliExitCodeFor'));
const preserveBrowserFor = runner.preserveBrowserFor ?? (() => assert.fail('missing export: preserveBrowserFor'));

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
  // 退出码的含义要写在 help 里：它是这条链唯一对人可见的失败契约（收据在运行时那侧）。
  assert.match(result.stdout, /USAGE_LIMIT_REACHED/iu);
  assert.match(result.stdout, /exit 2 and keep this run's page open/iu);
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

test('CLI 的两条轴（退出码 / 是否保留页签）由同一处判据给出，配额墙与登录墙同级', () => {
  assert.equal(cliExitCodeFor({ code: 'HUMAN_REQUIRED' }), 2);
  assert.equal(cliExitCodeFor({ code: USAGE_LIMIT_CODE }), 2, '配额用尽同样要人（升级套餐或等明天）');
  assert.equal(cliExitCodeFor({ code: 'STALLED' }), 3);
  assert.equal(cliExitCodeFor({ code: 'QUEUE_CHANGED' }), 1);
  assert.equal(cliExitCodeFor(new Error('no code')), 1);
  assert.equal(cliExitCodeFor(undefined), 1, '拿不到 error 也不许抛：退出码必须总有确定值');

  assert.equal(preserveBrowserFor({ code: 'HUMAN_REQUIRED' }), true);
  assert.equal(preserveBrowserFor({ code: USAGE_LIMIT_CODE }), true, '留着那堵墙，人一眼就能看到');
  assert.equal(preserveBrowserFor({ code: 'STALLED' }), true);
  assert.equal(preserveBrowserFor({ code: 'QUEUE_CHANGED' }), false);
  assert.equal(preserveBrowserFor(undefined), false);
});

test('接线判据：两个调用点都必须走判据函数，不许再抄一份内联清单', () => {
  const source = readFileSync(cli, 'utf8');
  assert.match(source, /preserveBrowser = preserveBrowserFor\(error\);/u);
  assert.match(source, /return cliExitCodeFor\(error\);/u);
  // 被函数取代的那两份内联清单不许复活 —— 它们正是「改一处、另一处纹丝不动」的来源。
  assert.doesNotMatch(source, /\['HUMAN_REQUIRED', 'STALLED'\]/u);
  assert.doesNotMatch(source, /code === 'HUMAN_REQUIRED' \? 2/u);
});
