import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';

test('updates one sanitized index while preserving the product identity and artifact basenames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xws-sku-index-'));
  const first = await updateSkuBatchIndex({
    directory,
    source: { mainRecordId: 'recMain', productId: '1038622504551', classification: 'A-爆款竞品' },
    artifacts: { payload: 'D:/other/payload.txt', captureReceipt: 'D:/other/capture.json' },
  });
  const second = await updateSkuBatchIndex({
    directory,
    source: { mainRecordId: 'recMain', productId: '1038622504551' },
    artifacts: { topology: 'D:/other/topology.json', topologyReceipt: 'D:/other/topology-receipt.json', manifest: 'D:/other/manifest.json' },
  });

  assert.equal(first, second);
  const index = JSON.parse(await readFile(first, 'utf8'));
  assert.equal(index.source.mainRecordId, 'recMain');
  assert.equal(index.artifacts.payload, 'payload.txt');
  assert.equal(index.artifacts.topology, 'topology.json');
  assert.equal(index.artifacts.manifest, 'manifest.json');
});
