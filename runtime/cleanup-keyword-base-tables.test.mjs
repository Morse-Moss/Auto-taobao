import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_TOKEN,
  DELETE_TARGETS,
  PROTECTED_TABLES,
  assertApplyConfirmation,
  assertCleanupMutation,
  buildCleanupPlan,
  verifyCleanupResult,
} from './cleanup-keyword-base-tables.mjs';

function liveTables() {
  return [...PROTECTED_TABLES, ...DELETE_TARGETS].map((table) => ({
    table_id: table.tableId,
    name: table.tableName,
    recordCount: table.expectedRecords,
  }));
}

test('cleanup plan contains only exact approved table identities and row counts', () => {
  const plan = buildCleanupPlan(liveTables());
  assert.deepEqual(plan.deletes, DELETE_TARGETS);
  assert.deepEqual(plan.protected, PROTECTED_TABLES);
});

test('cleanup plan rejects name and row-count drift', () => {
  const renamed = liveTables();
  renamed.find((table) => table.table_id === DELETE_TARGETS[0].tableId).name = 'unexpected';
  assert.throws(() => buildCleanupPlan(renamed), /identity mismatch/i);

  const changedCount = liveTables();
  changedCount.find((table) => table.table_id === DELETE_TARGETS[0].tableId).recordCount += 1;
  assert.throws(() => buildCleanupPlan(changedCount), /record count mismatch/i);
});

test('apply requires exact app token and complete ordered target set', () => {
  const tableIds = DELETE_TARGETS.map((table) => table.tableId);
  assert.doesNotThrow(() => assertApplyConfirmation({ appToken: APP_TOKEN, tableIds }));
  assert.throws(() => assertApplyConfirmation({ appToken: 'wrong', tableIds }), /app confirmation/i);
  assert.throws(() => assertApplyConfirmation({ appToken: APP_TOKEN, tableIds: tableIds.slice(1) }), /table confirmation/i);
  assert.throws(() => assertApplyConfirmation({ appToken: APP_TOKEN, tableIds: [...tableIds].reverse() }), /table confirmation/i);
});

test('mutation guard permits only DELETE requests for approved tables', () => {
  for (const target of DELETE_TARGETS) {
    assert.doesNotThrow(() => assertCleanupMutation({
      method: 'DELETE',
      path: `/bitable/v1/apps/${APP_TOKEN}/tables/${target.tableId}`,
      body: undefined,
    }));
  }
  assert.throws(() => assertCleanupMutation({
    method: 'DELETE', path: `/bitable/v1/apps/${APP_TOKEN}/tables/${PROTECTED_TABLES[0].tableId}`,
  }), /blocked unauthorized mutation/i);
  assert.throws(() => assertCleanupMutation({
    method: 'POST', path: `/bitable/v1/apps/${APP_TOKEN}/tables/${DELETE_TARGETS[0].tableId}`,
  }), /blocked unauthorized mutation/i);
  assert.throws(() => assertCleanupMutation({
    method: 'DELETE', path: `/bitable/v1/apps/wrong/tables/${DELETE_TARGETS[0].tableId}`,
  }), /blocked unauthorized mutation/i);
});

test('post-delete verification requires every protected table and no delete target', () => {
  const remaining = PROTECTED_TABLES.map((table) => ({
    table_id: table.tableId,
    name: table.tableName,
    recordCount: table.expectedRecords,
  }));
  assert.deepEqual(verifyCleanupResult(remaining), {
    deletedTableIds: DELETE_TARGETS.map((table) => table.tableId),
    protectedTables: PROTECTED_TABLES,
  });
  assert.throws(() => verifyCleanupResult([...remaining, liveTables().at(-1)]), /still exists/i);
  assert.throws(() => verifyCleanupResult(remaining.slice(1)), /protected table missing/i);
});
