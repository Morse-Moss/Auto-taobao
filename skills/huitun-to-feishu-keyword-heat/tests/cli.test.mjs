import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'scripts', 'run-huitun-topic-heat.mjs');

test('CLI documents the complete candidate-to-backfill workflow', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /A候选/u);
  assert.match(result.stdout, /--apply/u);
  assert.match(result.stdout, /--confirm-table/u);
  assert.match(result.stdout, /--results/u);
  assert.match(result.stdout, /--result-max-age-hours/u);
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
