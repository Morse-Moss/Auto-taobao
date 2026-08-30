import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_MASTER_FIELDS, FAQ_WEEKLY_FIELDS } from './faq-topic-summary.mjs';
import { assertSchema, publishFaqTables, replaceTable } from './publish-faq-summaries.mjs';


const baseRow = (label, count = 0) => ({
  分类标签: label,
  是否痛点: '否',
  出现次数: count,
  痛点描述: '',
  典型问题: '用户典型问题是什么？',
  典型用户原话: '',
});
const weeklyRows = FAQ_LABEL_CATALOG.map(({ label }) => baseRow(label, label === '其他评价' ? 1 : 0));
const masterRows = weeklyRows.map((row) => ({ ...row, 占比: row.出现次数 ? 1 : 0 }));
const weeklyRow = weeklyRows.find((row) => row.分类标签 === '其他评价');
const masterRow = masterRows.find((row) => row.分类标签 === '其他评价');

class MemoryClient {
  constructor(records = []) {
    this.records = [...records];
    this.nextId = this.records.length + 1;
    this.failReadBack = false;
  }

  async listRecords() {
    if (this.failReadBack) throw new Error('read-back failed');
    return this.records;
  }

  async batchDeleteRecords(_tableId, ids) {
    const idSet = new Set(ids);
    this.records = this.records.filter((record) => !idSet.has(record.recordId));
  }

  async batchCreateRecords(_tableId, rows) {
    this.records.push(...rows.map((fields) => ({ recordId: `rec${this.nextId++}`, fields })));
  }
}

class TwoTableClient extends MemoryClient {
  constructor(masterRecords, weeklyRecords) {
    super();
    this.byTable = new Map([['master', [...masterRecords]], ['weekly', [...weeklyRecords]]]);
    this.failMaster = false;
  }

  async listRecords(tableId) {
    if (this.failMaster && tableId === 'master') throw new Error('master write failed');
    return this.byTable.get(tableId) ?? [];
  }

  async batchDeleteRecords(tableId, ids) {
    const idSet = new Set(ids);
    this.byTable.set(tableId, (this.byTable.get(tableId) ?? []).filter((record) => !idSet.has(record.recordId)));
  }

  async batchCreateRecords(tableId, rows) {
    const records = this.byTable.get(tableId) ?? [];
    records.push(...rows.map((fields) => ({ recordId: `rec${this.nextId++}`, fields })));
    this.byTable.set(tableId, records);
  }
}

function existing(fields) {
  return [{ recordId: 'old1', fields }];
}

test('summary replacement rejects original detail tables', () => {
  assert.throws(() => assertSchema([{ fieldName: '原始内容', type: 1 }], FAQ_MASTER_FIELDS, '问题主库'), /original FAQ detail table/u);
});

test('exact content is a NOOP and does not create a backup', async () => {
  const client = new MemoryClient(existing(masterRow));
  const directory = await mkdtemp(join(tmpdir(), 'faq-publish-noop-'));
  const result = await replaceTable(client, 'tbl-master', FAQ_MASTER_FIELDS, [masterRow], '问题主库', join(directory, 'backup.json'), false);
  assert.equal(result.mode, 'NOOP_EXACT_MATCH');
  await assert.rejects(readFile(join(directory, 'backup.json')));
});

test('non-empty differing table requires explicit replacement', async () => {
  const client = new MemoryClient(existing({ ...masterRow, 出现次数: 2 }));
  const directory = await mkdtemp(join(tmpdir(), 'faq-publish-block-'));
  await assert.rejects(
    replaceTable(client, 'tbl-master', FAQ_MASTER_FIELDS, [masterRow], '问题主库', join(directory, 'backup.json'), false),
    /non-empty and differs/u,
  );
  assert.equal(client.records.length, 1);
});

test('replacement normalizes number fields returned as strings', async () => {
  const client = new MemoryClient(existing({ ...weeklyRow, 出现次数: '2' }));
  const directory = await mkdtemp(join(tmpdir(), 'faq-publish-replace-'));
  const backup = join(directory, 'backup.json');
  const result = await replaceTable(client, 'tbl-weekly', FAQ_WEEKLY_FIELDS, [weeklyRow], '问题库_2026-08-23_2026-08-29', backup, true);
  assert.equal(result.mode, 'REPLACED_AND_VERIFIED');
  assert.deepEqual(client.records.map((record) => record.fields), [weeklyRow]);
  assert.equal(JSON.parse(await readFile(backup, 'utf8')).records.length, 1);
});

test('master failure restores a successfully replaced weekly table', async () => {
  const originalWeekly = existing({ ...weeklyRow, 出现次数: 2 });
  const client = new TwoTableClient(existing({ ...masterRow, 出现次数: 2 }), originalWeekly);
  client.failMaster = true;
  const directory = await mkdtemp(join(tmpdir(), 'faq-publish-two-table-'));
  await assert.rejects(
    publishFaqTables({
      client,
      masterTable: { tableId: 'master', name: '问题主库' },
      weeklyTable: { tableId: 'weekly', name: '问题库_2026-08-23_2026-08-29' },
      masterRows: [masterRow],
      weeklyRows: [weeklyRow],
      outputDir: directory,
      period: '2026-08-23_2026-08-29',
      analysisVersion: 'faq-ops-rule-v2.0.0',
      source: { weeklyHash: 'weekly', cumulativeHash: 'cumulative', planHash: 'plan' },
      replaceCurrent: true,
    }),
    /master write failed/u,
  );
  assert.deepEqual(client.byTable.get('weekly').map((record) => record.fields), [{ ...weeklyRow, 出现次数: 2 }]);
  await assert.rejects(readFile(join(directory, 'publish-receipt.json')));
});

test('read-back failure restores the original rows', async () => {
  const client = new MemoryClient(existing({ ...weeklyRow, 出现次数: 2 }));
  const directory = await mkdtemp(join(tmpdir(), 'faq-publish-rollback-'));
  const originalListRecords = client.listRecords.bind(client);
  let reads = 0;
  client.listRecords = async (...args) => {
    reads += 1;
    if (reads === 2) {
      client.failReadBack = true;
      try {
        return await originalListRecords(...args);
      } finally {
        client.failReadBack = false;
      }
    }
    return originalListRecords(...args);
  };
  await assert.rejects(
    replaceTable(client, 'tbl-weekly', FAQ_WEEKLY_FIELDS, [weeklyRow], '问题库_2026-08-23_2026-08-29', join(directory, 'backup.json'), true),
    /read-back failed/u,
  );
  client.failReadBack = false;
  assert.deepEqual(client.records.map((record) => record.fields), [{ ...weeklyRow, 出现次数: 2 }]);
});
