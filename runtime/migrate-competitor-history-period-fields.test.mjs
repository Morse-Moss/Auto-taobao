import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildMigrationPlan,
  migrationValues,
  periodTimestamp,
  runMigration,
} from './migrate-competitor-history-period-fields.mjs';

const period = { startDate: '2026-08-23', endDate: '2026-08-29' };
const fields = [
  { fieldId: 'start', fieldName: '周期开始日期', type: 1 },
  { fieldId: 'end', fieldName: '周期结束日期', type: 1 },
  { fieldId: 'title', fieldName: '商品标题', type: 1 },
];
const records = [{
  recordId: 'rec-1',
  fields: { 周期开始日期: '2026-08-23', 周期结束日期: '2026-08-29', 商品标题: '铸铁浴缸' },
}];

function migrationOptions(outputDir, overrides = {}) {
  return {
    apply: true,
    historyTableId: 'tbl-history',
    period,
    expectedRows: 1,
    outputDir,
    ...overrides,
  };
}

function fakeMigrationClient({ afterFields, updateFieldError, batchUpdateError, batchUpdateResult } = {}) {
  let currentFields = fields.map((field) => ({ ...field }));
  let currentRecords = records.map((record) => ({ ...record, fields: { ...record.fields } }));
  let listFieldsCalls = 0;
  return {
    async authenticate() {},
    async listTables() { return [{ tableId: 'tbl-history', name: '竞品历史总表 V1' }]; },
    async listFields() {
      listFieldsCalls += 1;
      return (listFieldsCalls > 1 && afterFields ? afterFields : currentFields).map((field) => ({ ...field }));
    },
    async listRecords() { return currentRecords.map((record) => ({ ...record, fields: { ...record.fields } })); },
    authorizeHistoryTarget() {},
    async updateField(_tableId, fieldId, definition) {
      if (updateFieldError) throw updateFieldError;
      currentFields = currentFields.map((field) => field.fieldId === fieldId ? { ...field, type: definition.type } : field);
    },
    async batchUpdateRecords(_tableId, updates) {
      if (batchUpdateError) throw batchUpdateError;
      for (const update of updates) {
        const record = currentRecords.find((item) => item.recordId === update.record_id);
        record.fields = { ...record.fields, ...update.fields };
      }
      return batchUpdateResult ?? updates.map((update) => update.record_id);
    },
  };
}

test('plans history period type and value migration without changing business fields', () => {
  const plan = buildMigrationPlan({ fields, records, period, expectedRows: 1 });
  assert.deepEqual(plan.fieldTypeUpdates.map(({ name }) => name), ['周期开始日期', '周期结束日期']);
  assert.deepEqual(plan.recordUpdates, [{
    record_id: 'rec-1',
    fields: {
      周期开始日期: Date.parse('2026-08-23T00:00:00+08:00'),
      周期结束日期: Date.parse('2026-08-29T00:00:00+08:00'),
    },
  }]);
  assert.equal(plan.before.recordCount, 1);
});

test('treats migrated date values as idempotent', () => {
  const values = migrationValues(period);
  const plan = buildMigrationPlan({
    fields: fields.map((field) => ['周期开始日期', '周期结束日期'].includes(field.fieldName) ? { ...field, type: 5 } : field),
    records: [{ recordId: 'rec-1', fields: { 周期开始日期: values.start, 周期结束日期: values.end, 商品标题: '铸铁浴缸' } }],
    period,
    expectedRows: 1,
  });
  assert.equal(plan.fieldTypeUpdates.length, 0);
  assert.equal(plan.recordUpdates.length, 0);
});

test('rejects invalid, reversed, mismatched, and unexpected history periods', () => {
  assert.throws(() => periodTimestamp('2026-02-29', 'start'), /start is invalid/u);
  assert.throws(() => migrationValues({ startDate: '2026-08-30', endDate: '2026-08-29' }), /History period must use YYYY-MM-DD/u);
  assert.throws(() => buildMigrationPlan({ fields, records: [{ ...records[0], fields: { ...records[0].fields, 周期开始日期: '2026-08-22' } }], period, expectedRows: 1 }), /History start period mismatch/u);
  assert.throws(() => buildMigrationPlan({ fields: [{ fieldName: '周期开始日期', fieldId: 'start', type: 2 }, fields[1]], records, period, expectedRows: 1 }), /History period field type mismatch/u);
  assert.throws(() => buildMigrationPlan({ fields, records, period, expectedRows: Number.MAX_SAFE_INTEGER + 1 }), /safe integer|row count/u);
});

test('does not declare verified when a non-period field changes after the write', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'history-migration-'));
  try {
    const result = runMigration({
      client: fakeMigrationClient({
        afterFields: [
          { fieldId: 'start', fieldName: '周期开始日期', type: 5 },
          { fieldId: 'end', fieldName: '周期结束日期', type: 5 },
          { fieldId: 'title', fieldName: '商品标题', type: 2 },
        ],
      }),
      options: migrationOptions(outputDir),
    });
    await assert.rejects(result, /schema|field/u);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('leaves a machine-readable partial receipt when a write stage fails', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'history-migration-'));
  try {
    await assert.rejects(
      runMigration({
        client: fakeMigrationClient({ updateFieldError: new Error('field update failed') }),
        options: migrationOptions(outputDir),
      }),
      /field update failed/u,
    );
    const periodDir = path.join(outputDir, '2026-08-23_2026-08-29');
    const receipt = JSON.parse(await readFile(path.join(periodDir, 'migration-receipt.json'), 'utf8'));
    assert.equal(receipt.mode, 'PARTIALLY_APPLIED');
    assert.equal(receipt.failure.stage, 'field_update');
    assert.deepEqual(receipt.completed, []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('does not overwrite an existing migration backup', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'history-migration-'));
  const periodDir = path.join(outputDir, '2026-08-23_2026-08-29');
  const backupPath = path.join(periodDir, 'migration-backup.json');
  try {
    await mkdir(periodDir, { recursive: true });
    await writeFile(backupPath, '{"sentinel":true}\n', 'utf8');
    await assert.rejects(
      runMigration({ client: fakeMigrationClient(), options: migrationOptions(outputDir) }),
      /backup.*exist|overwrite|run/u,
    );
    assert.equal(await readFile(backupPath, 'utf8'), '{"sentinel":true}\n');
    assert.deepEqual((await readdir(periodDir)).sort(), ['migration-backup.json']);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('rejects a batch response that does not confirm the requested record IDs', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'history-migration-'));
  try {
    await assert.rejects(
      runMigration({
        client: fakeMigrationClient({ batchUpdateResult: ['rec-other'] }),
        options: migrationOptions(outputDir),
      }),
      /record.*ID|batch.*response/u,
    );
    const receipt = JSON.parse(await readFile(path.join(outputDir, '2026-08-23_2026-08-29', 'migration-receipt.json'), 'utf8'));
    assert.equal(receipt.mode, 'PARTIALLY_APPLIED');
    assert.equal(receipt.failure.stage, 'record_update');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('records a partial receipt when read-back verification fails', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'history-migration-'));
  try {
    await assert.rejects(
      runMigration({
        client: fakeMigrationClient({
          afterFields: [
            { fieldId: 'start', fieldName: '周期开始日期', type: 5 },
            { fieldId: 'end', fieldName: '周期结束日期', type: 5 },
            { fieldId: 'title', fieldName: '商品标题', type: 2 },
          ],
        }),
        options: migrationOptions(outputDir),
      }),
      /schema|field/u,
    );
    const receipt = JSON.parse(await readFile(path.join(outputDir, '2026-08-23_2026-08-29', 'migration-receipt.json'), 'utf8'));
    assert.equal(receipt.mode, 'PARTIALLY_APPLIED');
    assert.equal(receipt.failure.stage, 'verification');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
