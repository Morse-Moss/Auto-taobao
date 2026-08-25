import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TABLE_DEFINITIONS,
  buildSchemaPlan,
  assertSchemaMutation,
} from './competitor-weekly-schema-core.mjs';

test('plans the three immutable weekly competitor tables with required fields', () => {
  const plan = buildSchemaPlan({ tables: [] });

  assert.deepEqual(plan.tablesToCreate.map((table) => table.name), [
    '分析周次', '竞品采集批次', '竞品周快照',
  ]);
  assert.equal(plan.recordsWillBeWritten, false);
  assert.ok(TABLE_DEFINITIONS['竞品周快照'].some((field) => field.name === '快照唯一键'));
  assert.ok(TABLE_DEFINITIONS['竞品采集批次'].some((field) => field.name === 'XLSX SHA256'));
});

test('rerun is a no-op when approved tables already have the contract fields', () => {
  const existing = Object.entries(TABLE_DEFINITIONS).map(([name, fields], index) => ({
    tableId: `tbl${index}`,
    name,
    fields: fields.map((field, fieldIndex) => ({
      fieldId: `fld${index}-${fieldIndex}`,
      fieldName: field.name,
      type: field.type,
      property: field.property ?? null,
    })),
    recordCount: 0,
  }));

  const plan = buildSchemaPlan({ tables: existing });
  assert.deepEqual(plan.tablesToCreate, []);
  assert.deepEqual(plan.fieldsToCreate, []);
});

test('blocks writes outside the exact schema plan', () => {
  const plan = buildSchemaPlan({ tables: [] });

  assert.throws(() => assertSchemaMutation({
    method: 'POST',
    path: '/bitable/v1/apps/other/tables',
    body: { table: { name: '不应创建' } },
  }, plan), /Blocked competitor weekly schema mutation/u);
});
