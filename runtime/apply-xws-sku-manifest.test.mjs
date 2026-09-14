import assert from 'node:assert/strict';
import test from 'node:test';

import { activeProfileName, competitorBaseToken, tableId } from './feishu-targets.mjs';

// 期望值必须从目标配置**派生**，不能手抄：这两条用例测的是「确认参数与当前目标是否一致」，
// 手抄旧租户的 token 会让它们在切换租户时失败——而在测的其实不是租户，是比对逻辑。
const PROFILE = activeProfileName();
const AUTHORIZED_BASE = competitorBaseToken(PROFILE);
const AUTHORIZED_SKU_TABLE = tableId('skuDetail', PROFILE);

let buildApplyReceipt;
let classifyPostWriteVerification;
let isRecoverableWriteError;
let isRetryablePostWriteVerificationError;
let parseApplyArgs;
let runNode;
try {
  ({
    buildApplyReceipt,
    classifyPostWriteVerification,
    isRecoverableWriteError,
    isRetryablePostWriteVerificationError,
    parseApplyArgs,
    runNode,
  } = await import('./apply-xws-sku-manifest.mjs'));
} catch {
  // The first red run intentionally exercises the missing command adapter.
}

test('collects a successful child-process result before parsing the fresh dry-run receipt', async () => {
  assert.equal(typeof runNode, 'function');
  const result = await runNode(['-e', 'process.stdout.write("ready")']);
  assert.deepEqual(result, { stdout: 'ready', stderr: '' });
});

test('requires the exact authorized Base, SKU table, and record count', () => {
  assert.equal(typeof parseApplyArgs, 'function');
  const base = [
    '--manifest', 'D:/runtime/manifest.json',
    '--env-file', 'E:/小红书/.env.local',
    '--output-directory', 'D:/evidence',
    '--apply',
  ];
  assert.throws(() => parseApplyArgs(base), /confirm-app-token/u);
  assert.throws(() => parseApplyArgs([
    ...base,
    '--confirm-app-token', 'wrong-app',
    '--confirm-sku-table-id', 'tblddWTrPeB4TKmR',
    '--confirm-record-count', '36',
  ]), /confirm-app-token mismatch/u);
  assert.throws(() => parseApplyArgs([
    ...base,
    '--confirm-app-token', AUTHORIZED_BASE,
    '--confirm-sku-table-id', AUTHORIZED_SKU_TABLE,
    '--confirm-record-count', '0',
  ]), /positive integer/u);
});

test('accepts the exact authorized count for an independent product batch', () => {
  const options = parseApplyArgs([
    '--manifest', 'D:/runtime/manifest.json',
    '--env-file', 'E:/小红书/.env.local',
    '--apply',
    '--confirm-app-token', AUTHORIZED_BASE,
    '--confirm-sku-table-id', AUTHORIZED_SKU_TABLE,
    '--confirm-record-count', '6',
    '--payload-file', 'D:/evidence/payload.txt',
    '--capture-receipt', 'D:/evidence/capture.json',
    '--topology-file', 'D:/evidence/topology.json',
    '--topology-receipt', 'D:/evidence/topology-receipt.json',
    '--output-directory', 'D:/evidence',
  ]);
  assert.equal(options.confirmRecordCount, 6);
  assert.equal(options.payloadFile, 'D:/evidence/payload.txt');
  assert.equal(options.apply, true);
});

test('requires an independent evidence set even when the manifest flag is present', () => {
  assert.equal(typeof parseApplyArgs, 'function');
  assert.throws(() => parseApplyArgs([
    '--manifest', 'D:/runtime/manifest.json',
    '--env-file', 'E:/小红书/.env.local',
    '--apply',
    '--confirm-app-token', AUTHORIZED_BASE,
    '--confirm-sku-table-id', AUTHORIZED_SKU_TABLE,
    '--confirm-record-count', '2',
    '--output-directory', 'D:/evidence',
  ]), /payload-file is required for every guarded apply/u);
});

test('builds a post-write receipt without exposing SKU field values', () => {
  assert.equal(typeof buildApplyReceipt, 'function');
  const receipt = buildApplyReceipt({
    manifestPath: 'D:/runtime/manifest.json',
    manifestSha256: 'manifest-hash',
    createdRecordIds: ['rec1', 'rec2'],
    beforeSkuRecordCount: 0,
    afterSkuRecordCount: 2,
    verifiedPlan: {
      items: [
        { recordId: 'rec1', action: 'alreadyPresent', writeFields: { SKU规格: 'do not expose me' } },
        { recordId: 'rec2', action: 'alreadyPresent' },
      ],
    },
    expectedRecordCount: 2,
  });
  assert.equal(receipt.mode, 'APPLIED_AND_VERIFIED');
  assert.equal(receipt.verification.verifiedUniqueKeys, 2);
  assert.equal(receipt.verification.verifiedRelations, 2);
  assert.equal(JSON.stringify(receipt).includes('do not expose me'), false);
});

test('only treats transient or server write failures as readback-recoverable', () => {
  assert.equal(typeof isRecoverableWriteError, 'function');

  assert.equal(isRecoverableWriteError(Object.assign(
    new Error('Feishu API failed: POST /records/batch_create 500 999 internal error'),
    { status: 500 },
  )), true);
  assert.equal(isRecoverableWriteError(Object.assign(
    new Error('network request timed out'),
    { code: 'ETIMEDOUT' },
  )), true);
  assert.equal(isRecoverableWriteError(new Error(
    'Feishu API failed: POST /records/batch_create 403 999 permission denied',
  )), false);
  assert.equal(isRecoverableWriteError(new Error(
    'Feishu API failed: POST /records/batch_create 400 999 invalid field',
  )), false);
  assert.equal(isRecoverableWriteError(new Error('Feishu authentication failed')), false);
});

test('retries only unsettled read-back or transport failures, never a deterministic conflict', () => {
  assert.equal(typeof classifyPostWriteVerification, 'function');
  assert.equal(typeof isRetryablePostWriteVerificationError, 'function');

  const unsettled = classifyPostWriteVerification({
    fresh: {
      receipt: { verification: { skuRecordCount: 2 } },
      freshManifest: { manifest: { plan: {
        summary: { parsedRows: 2, toCreate: 1, alreadyPresent: 1, conflict: 0, duplicateExistingKeys: 0 },
        items: [],
      } } },
    },
    expectedRecordCount: 2,
    beforeSkuRecordCount: 1,
  });
  assert.deepEqual(unsettled, { ok: false, retryable: true, reason: 'not-converged' });

  const conflict = classifyPostWriteVerification({
    fresh: {
      receipt: { verification: { skuRecordCount: 3 } },
      freshManifest: { manifest: { plan: {
        summary: { parsedRows: 2, toCreate: 0, alreadyPresent: 1, conflict: 1, duplicateExistingKeys: 0 },
        items: [],
      } } },
    },
    expectedRecordCount: 2,
    beforeSkuRecordCount: 1,
  });
  assert.deepEqual(conflict, { ok: false, retryable: false, reason: 'contract-conflict' });
  assert.equal(isRetryablePostWriteVerificationError(Object.assign(new Error('field conflict'), { retryable: false })), false);
  assert.equal(isRetryablePostWriteVerificationError(Object.assign(new Error('not settled'), { retryable: true })), true);
});

test('separates API-confirmed records from records verified by read-back', () => {
  const receipt = buildApplyReceipt({
    manifestPath: 'D:/runtime/manifest.json',
    manifestSha256: 'manifest-hash',
    createdRecordIds: [],
    beforeSkuRecordCount: 2,
    afterSkuRecordCount: 4,
    verifiedPlan: {
      items: [
        { recordId: 'rec1', action: 'alreadyPresent' },
        { recordId: 'rec2', action: 'alreadyPresent' },
      ],
    },
    expectedRecordCount: 2,
    writeOutcome: 'readback-recovered',
  });

  assert.equal(receipt.write.apiConfirmedRecordCount, 0);
  assert.equal(receipt.write.verifiedRecordCount, 2);
  assert.equal(receipt.write.outcome, 'readback-recovered');
});
