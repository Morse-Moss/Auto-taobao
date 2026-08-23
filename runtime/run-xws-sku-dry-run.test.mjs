import assert from 'node:assert/strict';
import test from 'node:test';

let buildDryRunReceipt;
try {
  ({ buildDryRunReceipt } = await import('./run-xws-sku-dry-run.mjs'));
} catch {
  // The first red run intentionally exercises the missing adapter.
}

test('builds a summary receipt without exposing parsed SKU fields', () => {
  assert.equal(typeof buildDryRunReceipt, 'function');
  const receipt = buildDryRunReceipt({
    target: { appToken: 'app', mainTableId: 'tblMain', skuTableId: 'tblSku' },
    evidence: {
      payloadSha256: 'payload-hash',
      topologySha256: 'topology-hash',
      propertyCount: 2,
      validCombinationCount: 36,
      source: { mainRecordId: 'recMain', productId: '1053695212757' },
    },
    mainRecordCount: 1333,
    skuRecordCount: 0,
    plan: {
      summary: {
        parsedRows: 36,
        toCreate: 36,
        alreadyPresent: 0,
        conflict: 0,
        duplicateExistingKeys: 0,
        writeReady: true,
      },
      items: [{ writeFields: { SKU规格: 'sensitive SKU payload text' } }],
    },
    manifestPath: 'D:/runtime/manifest.json',
    manifestSha256: 'manifest-hash',
    receiptPath: 'D:/runtime/receipt.json',
  });

  assert.equal(receipt.mode, 'DRY_RUN_READY');
  assert.equal(receipt.plan.toCreate, 36);
  assert.equal(receipt.verification.validCombinationCount, 36);
  assert.equal(JSON.stringify(receipt).includes('sensitive SKU payload text'), false);
});
