import assert from 'node:assert/strict';
import test from 'node:test';

let parseDryRunArgs;
try {
  ({ parseDryRunArgs } = await import('./run-xws-sku-dry-run.mjs'));
} catch {
  // Red phase: the parameterized dry-run entrypoint is not available yet.
}

test('accepts independent evidence files for a new SKU batch', () => {
  assert.equal(typeof parseDryRunArgs, 'function');
  const options = parseDryRunArgs([
    '--payload-file', 'D:/evidence/payload.txt',
    '--capture-receipt', 'D:/evidence/capture.json',
    '--topology-file', 'D:/evidence/topology.json',
    '--topology-receipt', 'D:/evidence/topology-receipt.json',
    '--output-directory', 'D:/evidence',
    '--env-file', 'E:/小红书/.env.local',
  ]);
  assert.equal(options.payloadFile, 'D:/evidence/payload.txt');
  assert.equal(options.captureReceipt, 'D:/evidence/capture.json');
  assert.equal(options.topologyFile, 'D:/evidence/topology.json');
  assert.equal(options.topologyReceipt, 'D:/evidence/topology-receipt.json');
  assert.equal(options.outputDirectory, 'D:/evidence');
});

test('rejects a partial evidence set before reading Feishu', () => {
  assert.equal(typeof parseDryRunArgs, 'function');
  assert.throws(
    () => parseDryRunArgs(['--payload-file', 'D:/evidence/payload.txt']),
    /capture-receipt/u,
  );
});

test('does not fall back to the retired shared evidence directory', () => {
  assert.equal(typeof parseDryRunArgs, 'function');
  assert.throws(
    () => parseDryRunArgs(['--env-file', 'E:/小红书/.env.local']),
    /payload-file is required for every SKU dry-run/u,
  );
});
