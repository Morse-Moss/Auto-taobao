import assert from 'node:assert/strict';
import test from 'node:test';

let parseTopologyArgs;
try {
  ({ parseTopologyArgs } = await import('./collect-live-xws-sku-topology.mjs'));
} catch {
  // Red phase: the parameterized topology entrypoint is not available yet.
}

test('accepts an independent product, evidence directory, and target label', () => {
  assert.equal(typeof parseTopologyArgs, 'function');
  const options = parseTopologyArgs([
    '--product-id', '1038622504551',
    '--payload-file', 'D:/evidence/payload.txt',
    '--output-directory', 'D:/evidence',
    '--target-label', 'xws-sku-batch-1038622504551',
  ]);
  assert.equal(options.productId, '1038622504551');
  assert.equal(options.payloadFile, 'D:/evidence/payload.txt');
  assert.equal(options.outputDirectory, 'D:/evidence');
  assert.equal(options.targetLabel, 'xws-sku-batch-1038622504551');
});

test('requires a product id and payload file before any browser action', () => {
  assert.equal(typeof parseTopologyArgs, 'function');
  assert.throws(
    () => parseTopologyArgs(['--output-directory', 'D:/evidence']),
    /product-id/u,
  );
  assert.throws(
    () => parseTopologyArgs(['--product-id', '1038622504551']),
    /payload-file/u,
  );
});
