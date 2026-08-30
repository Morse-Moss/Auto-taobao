import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyApiPreflight,
  publishCompetitorVisualization,
  runCompetitorVisualization,
} from './publish-competitor-visualization.mjs';

const options = {
  appToken: 'app123',
  baseUrl: 'https://tenant.feishu.cn/base/app123?table=tblHistory',
  period: { startDate: '2026-08-23', endDate: '2026-08-29' },
  expectedRows: 1,
  historyTableId: 'tblHistory',
  outputDir: '',
  apply: true,
};

function fakeClient({ authenticateError = null, tables = [] } = {}) {
  const events = [];
  return {
    events,
    appToken: options.appToken,
    async authenticate() {
      events.push('authenticate');
      if (authenticateError) throw new Error(authenticateError);
    },
    async listTables() {
      events.push('listTables');
      return tables;
    },
    async listRecords() {
      events.push('listRecords');
      return [];
    },
    authorizeHistoryTarget() { events.push('authorizeHistoryTarget'); },
    async createTable() { events.push('createTable'); return 'tblNew'; },
    async listFields() { events.push('listFields'); return []; },
    async createField() { events.push('createField'); },
    async batchCreateRecords() { events.push('batchCreate'); },
    async batchUpdateRecords() { events.push('batchUpdate'); },
  };
}

test('classifies an authenticated exact Base and history target as ready', () => {
  assert.deepEqual(classifyApiPreflight({
    authenticated: true,
    appToken: 'app123',
    requestedAppToken: 'app123',
    historyTableId: 'tblHistory',
    tables: [{ tableId: 'tblHistory', name: '竞品历史总表 V1' }],
  }), { status: 'READY', reasonCode: null });
});

test('classifies a missing exact history target as a blocking target error', () => {
  const result = classifyApiPreflight({
    authenticated: true,
    appToken: 'app123',
    requestedAppToken: 'app123',
    historyTableId: 'tblOther',
    tables: [{ tableId: 'tblOther', name: '任意新表' }],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'FEISHU_TABLE_MISMATCH');
});

test('stops before any write when API authentication fails and writes a blocking receipt', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-publish-auth-'));
  const client = fakeClient({ authenticateError: 'invalid tenant access token' });
  const result = await assert.rejects(
    runCompetitorVisualization({ client, options: { ...options, outputDir } }),
    (error) => error.code === 'FEISHU_AUTH_FAILED',
  );
  assert.equal(result, undefined);
  assert.deepEqual(client.events, ['authenticate']);
  const receipt = JSON.parse(await readFile(path.join(outputDir, 'publish-receipt.json'), 'utf8'));
  assert.equal(receipt.mode, 'BLOCKED');
  assert.equal(receipt.error.reasonCode, 'FEISHU_AUTH_FAILED');
  assert.doesNotMatch(JSON.stringify(receipt), /access token|secret|authorization/iu);
});

test('stops before any write when the weekly quality gate fails', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-publish-gate-'));
  const client = fakeClient({
    tables: [
      { tableId: 'tblWeekly', name: '竞品周_2026-08-23_2026-08-29' },
      { tableId: 'tblHistory', name: '竞品历史总表 V1' },
    ],
  });
  client.listRecords = async (tableId) => {
    client.events.push(`listRecords:${tableId}`);
    return [];
  };
  await assert.rejects(
    runCompetitorVisualization({ client, options: { ...options, outputDir } }),
    (error) => error.code === 'FEISHU_WEEKLY_GATE_FAILED',
  );
  assert.equal(client.events.some((event) => /createTable|createField|batchCreate|batchUpdate/u.test(event)), false);
  const receipt = JSON.parse(await readFile(path.join(outputDir, 'publish-receipt.json'), 'utf8'));
  assert.equal(receipt.mode, 'BLOCKED');
  assert.equal(receipt.error.reasonCode, 'FEISHU_WEEKLY_GATE_FAILED');
});

test('publishes in create-then-update order and verifies the read-back', async () => {
  const events = [];
  const client = {
    authorizeHistoryTarget() { events.push('authorize'); },
    async createTable() { events.push('createTable'); return 'tblNew'; },
    async listFields() { events.push('listFields'); return []; },
    async createField() { events.push('createField'); },
    async batchCreateRecords() { events.push('batchCreate'); },
    async batchUpdateRecords() { events.push('batchUpdate'); },
    async listRecords() { events.push('readBack'); return [{ fields: { 商品周期唯一键: 'key-1' } }]; },
  };
  const prepared = {
    historyTable: { needsCreate: true, tableId: null, name: '竞品历史总表 V1' },
    weeklyTable: { tableId: 'tblWeekly', name: '竞品周_2026-08-23_2026-08-29' },
    plan: { creates: [{ 商品周期唯一键: 'key-1' }], updates: [] },
    desiredRows: [{ fields: { 商品周期唯一键: 'key-1' } }],
    sourceHash: 'hash',
    visualization: { money: { coveredAmount: 1 } },
  };
  const result = await publishCompetitorVisualization({ client, prepared, options });
  assert.equal(result.mode, 'APPLIED_AND_VERIFIED');
  assert.deepEqual(events.slice(0, 3), ['createTable', 'authorize', 'listFields']);
  assert.ok(events.indexOf('createField') > events.indexOf('listFields'));
  assert.ok(events.indexOf('batchCreate') > events.indexOf('createField'));
  assert.ok(events.indexOf('readBack') > events.indexOf('batchCreate'));
});

test('converts an unauthorized write target into a stable blocking error', async () => {
  const client = {
    authorizeHistoryTarget() {},
    async listFields() { throw new Error('Blocked record write outside authorized competitor tables'); },
  };
  const prepared = {
    historyTable: { needsCreate: false, tableId: 'tblOther', name: '竞品历史总表 V1' },
    weeklyTable: { tableId: 'tblWeekly', name: '竞品周_2026-08-23_2026-08-29' },
    plan: { creates: [], updates: [] },
    desiredRows: [],
  };
  await assert.rejects(
    publishCompetitorVisualization({ client, prepared, options }),
    (error) => error.code === 'FEISHU_WRITE_TARGET_BLOCKED',
  );
});

test('converts read-back mismatch into a stable blocking error', async () => {
  const client = {
    authorizeHistoryTarget() {},
    async listFields() { return []; },
    async createField() {},
    async batchCreateRecords() {},
    async batchUpdateRecords() {},
    async listRecords() { return [{ fields: { 商品周期唯一键: 'different-key' } }]; },
  };
  const prepared = {
    historyTable: { needsCreate: false, tableId: 'tblHistory', name: '竞品历史总表 V1' },
    weeklyTable: { tableId: 'tblWeekly', name: '竞品周_2026-08-23_2026-08-29' },
    plan: { creates: [], updates: [] },
    desiredRows: [{ fields: { 商品周期唯一键: 'key-1' } }],
  };
  await assert.rejects(
    publishCompetitorVisualization({ client, prepared, options }),
    (error) => error.code === 'FEISHU_READBACK_MISMATCH',
  );
});

test('blocks before any write when the exact weekly target is missing', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-publish-weekly-'));
  const client = fakeClient({
    tables: [{ tableId: 'tblHistory', name: '竞品历史总表 V1' }],
  });
  await assert.rejects(
    runCompetitorVisualization({ client, options: { ...options, outputDir } }),
    (error) => error.code === 'FEISHU_TABLE_MISMATCH',
  );
  assert.deepEqual(client.events, ['authenticate', 'listTables']);
  const receipt = JSON.parse(await readFile(path.join(outputDir, 'publish-receipt.json'), 'utf8'));
  assert.equal(receipt.mode, 'BLOCKED');
  assert.equal(receipt.preflight.reasonCode, 'FEISHU_TABLE_MISMATCH');
});

test('stops before any write when the confirmed history target does not match', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-publish-target-'));
  const client = fakeClient({
    tables: [{ tableId: 'tblOther', name: '任意新表' }],
  });
  await assert.rejects(
    runCompetitorVisualization({ client, options: { ...options, outputDir } }),
    (error) => error.code === 'FEISHU_TABLE_MISMATCH',
  );
  assert.deepEqual(client.events, ['authenticate', 'listTables']);
  const receipt = JSON.parse(await readFile(path.join(outputDir, 'publish-receipt.json'), 'utf8'));
  assert.equal(receipt.mode, 'BLOCKED');
  assert.equal(receipt.preflight.reasonCode, 'FEISHU_TABLE_MISMATCH');
  assert.equal(receipt.writes, undefined);
});
