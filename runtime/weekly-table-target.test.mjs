import test from 'node:test';
import assert from 'node:assert/strict';
import { latestWeeklyTable, parseWeeklyTable, weeklyTableName } from './weekly-table-target.mjs';

test('builds and parses dated weekly table names', () => {
  const name = weeklyTableName('SKU', '2026-08-31', '2026-09-06');
  assert.equal(name, 'SKU周_2026-08-31_2026-09-06');
  assert.equal(weeklyTableName('问题库', '2026-08-31', '2026-09-06'), '问题库_2026-08-31_2026-09-06');
  assert.deepEqual(parseWeeklyTable({ tableId: 'tbl-1', name }), {
    tableId: 'tbl-1', name, kind: 'SKU', startDate: '2026-08-31', endDate: '2026-09-06',
  });
});

test('selects the newest weekly table by start date', () => {
  const latest = latestWeeklyTable([
    { tableId: 'old', name: '竞品周_2026-08-23_2026-08-29' },
    { tableId: 'new', name: '竞品周_2026-08-30_2026-09-05' },
    { tableId: 'sku', name: 'SKU周_2026-08-30_2026-09-05' },
  ], '竞品');
  assert.equal(latest.tableId, 'new');
});
