import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

let buildSkuEvidence;
try {
  ({ buildSkuEvidence } = await import('./build-xws-sku-dry-run-manifest.mjs'));
} catch {
  // The first red run intentionally exercises the missing implementation.
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture() {
  const payload = '1.2米\n独立浴缸-左排-恒温';
  const topology = {
    version: 'xws-tmall-sku-topology-v1',
    payloadSha256: sha256(payload),
    properties: [{ values: [] }, { values: [] }],
    validCombinations: [{ skuId: 'sku-1', propertyValueIndexes: [0, 0] }],
  };
  const topologyText = `${JSON.stringify(topology, null, 2)}\n`;
  return {
    payload,
    topologyText,
    captureReceipt: {
      captureId: 'capture-1',
      payloadSha256: sha256(payload),
      metadata: {
        recordId: 'recMain',
        productId: '1053695212757',
        productUrl: 'https://item.taobao.com/item.htm?id=1053695212757',
        validity: '是',
        classification: 'A-高销量高GMV竞品',
        copiedItem: 'SKU',
        copyFeedback: '已复制',
      },
    },
    topologyReceipt: {
      version: 'xws-sku-topology-receipt-v1',
      productId: '1053695212757',
      payloadSha256: sha256(payload),
      topologySha256: sha256(topologyText),
      propertyCount: 2,
      validCombinationCount: 1,
    },
  };
}

test('builds a sanitized evidence descriptor only when the captured hashes agree', () => {
  assert.equal(typeof buildSkuEvidence, 'function');
  const input = fixture();
  const evidence = buildSkuEvidence({
    rawPayload: input.payload,
    captureReceipt: input.captureReceipt,
    topologyText: input.topologyText,
    topologyReceipt: input.topologyReceipt,
  });

  assert.deepEqual(evidence.source, {
    mainRecordId: 'recMain',
    productId: '1053695212757',
    productUrl: 'https://item.taobao.com/item.htm?id=1053695212757',
    capturedValidity: '是',
    capturedClassification: 'A-高销量高GMV竞品',
  });
  assert.equal(evidence.propertyCount, 2);
  assert.equal(evidence.validCombinationCount, 1);
  assert.equal(JSON.stringify(evidence).includes(input.payload), false);
});

test('rejects evidence when the topology receipt no longer matches the exact topology file', () => {
  const input = fixture();
  input.topologyReceipt.topologySha256 = 'not-the-topology-hash';

  assert.throws(() => buildSkuEvidence({
    rawPayload: input.payload,
    captureReceipt: input.captureReceipt,
    topologyText: input.topologyText,
    topologyReceipt: input.topologyReceipt,
  }), /topology hash/u);
});
