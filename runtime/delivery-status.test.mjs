import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDelivery } from '../scripts/delivery-status.mjs';

test('does not call a branch commit delivered until mainline contains it', () => {
  assert.equal(evaluateDelivery({ status: '', mainlineContains: false, remoteContains: false, remoteKnown: true }), 'NOT_MERGED');
});

test('distinguishes mainline merge from remote push', () => {
  assert.equal(evaluateDelivery({ status: '', mainlineContains: true, remoteContains: false, remoteKnown: true }), 'NOT_PUSHED');
});

test('reports a clean commit present in mainline and remote as verified', () => {
  assert.equal(evaluateDelivery({ status: '', mainlineContains: true, remoteContains: true, remoteKnown: true }), 'DELIVERY_VERIFIED');
});

test('does not hide unrelated dirty worktree state', () => {
  assert.equal(evaluateDelivery({ status: ' M evidence/run.txt', mainlineContains: true, remoteContains: true, remoteKnown: true }), 'WORKTREE_DIRTY');
});
