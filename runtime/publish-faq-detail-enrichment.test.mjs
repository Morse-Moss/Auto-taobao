import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAnalysisRecords, sourceTopicIdentity } from './faq-text-analysis.mjs';
import { FAQ_DETAIL_FIELDS, FAQ_PUBLISH_MODE, buildDetailAppendPlan } from './faq-detail-enrichment.mjs';
import { publishFaqDetail } from './publish-faq-detail-enrichment.mjs';

const period = '2026-09-13_2026-09-19';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const operatorContent = { source: { path: 'operator.xlsx', sha256: 'a'.repeat(64) }, content: {} };

const RAW = [
  { recordId: 'raw-1', fields: { 商品ID: 'p1', 来源类型: '评论', 原始内容: '没有一点味道，排水顺畅', 来源记录唯一键: 'source-1', crossWeekDedupKey: 'text:source-1', 采集状态: '已采集' } },
  { recordId: 'raw-2', fields: { 商品ID: 'p1', 来源类型: '问大家', 原始内容: '太重了，两个人抬不动', 来源记录唯一键: 'source-2', crossWeekDedupKey: 'text:source-2', 采集状态: '已采集' } },
];

function finalRecords() {
  return buildAnalysisRecords(RAW);
}

async function artifacts() {
  const outputDir = await mkdtemp(join(tmpdir(), 'faq-publish-'));
  const records = finalRecords();
  const finalText = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const auditText = `${JSON.stringify({ version: 'audit', unresolvedCount: 0 }, null, 2)}\n`;
  const identities = records.map((record) => sourceTopicIdentity(record)).sort().join('\n');
  const finalPath = join(outputDir, 'final-classified-records.jsonl');
  const receiptPath = join(outputDir, 'final-classification-receipt.json');
  const reviewDir = join(outputDir, 'ai-review');
  await mkdir(reviewDir, { recursive: true });
  await writeFile(finalPath, finalText, 'utf8');
  await writeFile(join(reviewDir, 'source-topic-audit.json'), auditText, 'utf8');
  await writeFile(receiptPath, `${JSON.stringify({
    mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: records[0].classificationVersion,
    publishable: true, humanQueueCount: 0, classifiedRecords: records.length,
    legacyAudit: { unresolvedCount: 0 },
    source: {
      finalClassifiedSnapshot: { path: finalPath, sha256: hash(finalText) },
      sourceTopicSet: { count: records.length, sha256: hash(identities) },
      legacySourceTopicAudit: { path: join(reviewDir, 'source-topic-audit.json'), sha256: hash(auditText) },
    },
  }, null, 2)}\n`, 'utf8');
  return { outputDir, records };
}

const detailFields = FAQ_DETAIL_FIELDS.map((field) => ({ fieldName: field.name, type: field.type, property: field.property }));

// 总表里已有的历史行：两条与本期无关的身份（用来验「只新增」真的是追加）。
function legacyRows(extra = []) {
  const base = finalRecords()[0].fields;
  return [{ ...base, 来源记录唯一键: 'legacy-1' }, { ...base, 来源记录唯一键: 'legacy-2' }, ...extra];
}

class BaseClient {
  constructor({ masterId = 'tbl-master', masterRows = [], weekly = null } = {}) {
    this.masterId = masterId;
    this.tables = new Map([[masterId, '问题主库']]);
    this.fields = new Map([[masterId, detailFields]]);
    this.rows = new Map([[masterId, masterRows.map((fields, index) => ({ recordId: `${masterId}-m${index}`, fields: { ...fields } }))]]);
    this.mutations = [];
    this.seq = 0;
    if (weekly) {
      this.tables.set(weekly.tableId, weekly.name);
      this.fields.set(weekly.tableId, detailFields);
      this.rows.set(weekly.tableId, (weekly.rows ?? []).map((fields, index) => ({ recordId: `${weekly.tableId}-w${index}`, fields: { ...fields } })));
    }
  }
  async listTables() { return [...this.tables].map(([tableId, name]) => ({ tableId, name })); }
  async listFields(tableId) { return this.fields.get(tableId) ?? detailFields; }
  async listRecords(tableId) { return (this.rows.get(tableId) ?? []).map((record) => ({ recordId: record.recordId, fields: { ...record.fields } })); }
  async createTable(name) {
    this.mutations.push(`createTable:${name}`);
    const tableId = `tbl-auto-${++this.seq}`;
    this.tables.set(tableId, name);
    this.fields.set(tableId, detailFields);
    this.rows.set(tableId, []);
    return tableId;
  }
  async batchCreateRecords(tableId, rows) {
    const current = this.rows.get(tableId) ?? [];
    const ids = rows.map((fields) => {
      const recordId = `${tableId}-n${++this.seq}`;
      current.push({ recordId, fields: { ...fields } });
      return recordId;
    });
    this.rows.set(tableId, current);
    this.mutations.push(`create:${this.tables.get(tableId)}:${rows.length}`);
    return ids;
  }
  async batchDeleteRecords(tableId, recordIds) {
    const doomed = new Set(recordIds);
    this.rows.set(tableId, (this.rows.get(tableId) ?? []).filter((record) => !doomed.has(record.recordId)));
    this.mutations.push(`delete:${this.tables.get(tableId)}:${recordIds.length}`);
    return recordIds;
  }
  authorizeFaqTargets(targets) { this.authorized = targets; this.mutations.push('authorizeFaqTargets'); }
  authorizeTableDeletion(tableIds) { this.mutations.push(`authorizeTableDeletion:${tableIds.length}`); }
  async deleteTable(tableId) {
    this.mutations.push(`deleteTable:${this.tables.get(tableId)}`);
    this.tables.delete(tableId);
    this.rows.delete(tableId);
  }
  writes() { return this.mutations.filter((entry) => !entry.startsWith('authorize')); }
}

function options(outputDir) {
  return { outputDir, period, appToken: 'OWebbPUcBa7B8JseYLccQCy9nkf', masterTableId: 'tbl-master' };
}

// ── 领域函数：只新增 ─────────────────────────────────────────────────────────
test('buildDetailAppendPlan 只新增：重合身份不写、差异只记 conflicts、deletes 恒空', () => {
  const desired = finalRecords().map((record) => record.fields);
  const existing = [
    { recordId: 'm1', fields: { ...desired[0] } },
    { recordId: 'm2', fields: { ...desired[1], 原始内容: '被别人改过' } },
    { recordId: 'm3', fields: { ...desired[1], 来源记录唯一键: 'legacy-x' } },
  ];
  const plan = buildDetailAppendPlan({ desiredRows: desired, existingRecords: existing });
  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.overlapCount, 2);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0].changedFields, ['原始内容']);
  assert.equal(plan.existingCount, 3);
});

test('buildDetailAppendPlan 只把新身份放进 creates，且对总表内重复身份 fail-closed', () => {
  const desired = finalRecords().map((record) => record.fields);
  const plan = buildDetailAppendPlan({ desiredRows: desired, existingRecords: legacyRows() });
  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.conflicts.length, 0);
  const duplicated = [{ recordId: 'a', fields: { ...desired[0] } }, { recordId: 'b', fields: { ...desired[0] } }];
  assert.throws(() => buildDetailAppendPlan({ desiredRows: desired, existingRecords: duplicated }), /duplicate existing source-topic identity/u);
});

// ── 发布：dry-run ───────────────────────────────────────────────────────────
test('dry-run 报出「建周表 + 总表追加 N 行」且零写入', async () => {
  const { outputDir, records } = await artifacts();
  const client = new BaseClient({ masterRows: legacyRows() });
  const result = await publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: false });
  assert.equal(result.mode, 'PUBLISH_DRY_RUN_READY');
  assert.equal(result.weeklyTableMissing, true);
  assert.equal(result.weekly.planning, 'CREATE_THEN_WRITE');
  assert.equal(result.weekly.created, false);
  assert.equal(result.weekly.rows, records.length);
  assert.equal(result.master.recordsBefore, 2);
  assert.equal(result.master.appends, records.length);
  assert.equal(result.master.overlap, 0);
  assert.equal(result.master.deletes, 0);
  assert.equal(result.feishuWrites, 0);
  assert.deepEqual(client.writes(), []);
});

test('最终分类工件被改动时在读飞书写入前就拒绝', async () => {
  const { outputDir } = await artifacts();
  await writeFile(join(outputDir, 'final-classified-records.jsonl'), '{}\n', 'utf8');
  const client = new BaseClient({ masterRows: legacyRows() });
  await assert.rejects(
    () => publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: false }),
    /Analysis record|artifact hash mismatch/u,
  );
  assert.deepEqual(client.writes(), []);
});

test('总表 schema 漂移时拒绝发布', async () => {
  const { outputDir } = await artifacts();
  const client = new BaseClient({ masterRows: legacyRows() });
  client.fields.set(client.masterId, detailFields.slice(0, 5));
  await assert.rejects(
    () => publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: false }),
    /master table schema mismatch/u,
  );
  assert.deepEqual(client.writes(), []);
});

test('显式传了 --weekly-table-id 却查不到 → fail-closed', async () => {
  const { outputDir } = await artifacts();
  const client = new BaseClient({ masterRows: legacyRows() });
  await assert.rejects(
    () => publishFaqDetail({ client, options: { ...options(outputDir), weeklyTableId: 'tbl-nope' }, operatorContent, apply: false }),
    /weekly table id not found: tbl-nope/u,
  );
});

// ── 发布：apply ─────────────────────────────────────────────────────────────
test('apply 建周表 + 总表只追加，全程零删除', async () => {
  const { outputDir, records } = await artifacts();
  const client = new BaseClient({ masterRows: legacyRows() });
  const receipt = await publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: true });

  assert.equal(receipt.mode, FAQ_PUBLISH_MODE);
  assert.equal(receipt.weekly.created, true);
  assert.equal(receipt.weekly.rows, records.length);
  assert.equal(receipt.master.recordsBefore, 2);
  assert.equal(receipt.master.appended, records.length);
  assert.equal(receipt.master.recordsAfter, 2 + records.length);
  assert.equal(receipt.master.deletes, 0);
  assert.equal(receipt.master.conflicts, 0);
  assert.equal(receipt.master.appendedRecordIds.length, records.length);
  // 3 次写：建周表 + 写周表行 + 追加总表行（三者都是独立写入动作，不是一个）
  assert.equal(receipt.feishuWrites, 3);
  assert.ok(receipt.backup.sha256);
  // 总表只增：既没有删除动作，历史两行也还在
  assert.deepEqual(client.mutations.filter((entry) => entry.startsWith('delete')), []);
  assert.equal(client.rows.get(client.masterId).length, 2 + records.length);
  const names = client.rows.get(client.masterId).map((record) => record.fields.来源记录唯一键);
  assert.deepEqual(names.slice(0, 2), ['legacy-1', 'legacy-2']);
});

test('重跑：周表已一致时不动，总表追加 0 行，零写入', async () => {
  const { outputDir, records } = await artifacts();
  const client = new BaseClient({ masterRows: legacyRows() });
  await publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: true });
  const second = await publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: true });

  assert.equal(second.weekly.planning, 'NOOP_EXACT_MATCH');
  assert.equal(second.weekly.created, false);
  assert.equal(second.master.appends, 0);
  assert.equal(second.master.conflicts, 0);
  assert.equal(second.master.recordsAfter, 2 + records.length);
  assert.equal(second.feishuWrites, 0);
  assert.equal(client.rows.get(client.masterId).length, 2 + records.length);
});

test('周表已有历史行且与本期不一致 → 要求 --replace-weekly，否则不动库', async () => {
  const { outputDir } = await artifacts();
  const stale = { ...finalRecords()[0].fields, 原始内容: '上一版算错的内容' };
  const client = new BaseClient({ masterRows: legacyRows(), weekly: { tableId: 'tbl-weekly', name: `问题库_${period}`, rows: [stale] } });
  await assert.rejects(
    () => publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: true }),
    /--replace-weekly/u,
  );
  assert.deepEqual(client.writes(), []);
  assert.equal(client.rows.get('tbl-weekly').length, 1);
});

test('加了 --replace-weekly 才覆盖周表，总表仍只追加', async () => {
  const { outputDir, records } = await artifacts();
  const stale = { ...finalRecords()[0].fields, 原始内容: '上一版算错的内容' };
  const client = new BaseClient({ masterRows: legacyRows(), weekly: { tableId: 'tbl-weekly', name: `问题库_${period}`, rows: [stale] } });
  const receipt = await publishFaqDetail({ client, options: { ...options(outputDir), replaceWeekly: true }, operatorContent, apply: true });
  assert.equal(receipt.weekly.planning, 'REPLACE_NON_EMPTY');
  assert.equal(receipt.weekly.created, false);
  assert.equal(receipt.weekly.previousRows, 1);
  assert.equal(client.rows.get('tbl-weekly').length, records.length);
  assert.equal(receipt.master.recordsAfter, 2 + records.length);
  assert.equal(receipt.master.deletes, 0);
});

// ── 发布：失败回滚 ──────────────────────────────────────────────────────────
class BrokenReadBackClient extends BaseClient {
  constructor(args) { super(args); this.breakMasterReadBack = false; }
  async listRecords(tableId) {
    const rows = await super.listRecords(tableId);
    const appended = this.mutations.some((entry) => entry.startsWith('create:问题主库'));
    return this.breakMasterReadBack && tableId === this.masterId && appended ? rows.slice(0, -1) : rows;
  }
}

test('追加后回读对不上 → 撤回本次追加、删掉自建周表', async () => {
  const { outputDir } = await artifacts();
  const client = new BrokenReadBackClient({ masterRows: legacyRows() });
  client.breakMasterReadBack = true;
  await assert.rejects(
    () => publishFaqDetail({ client, options: options(outputDir), operatorContent, apply: true }),
    /问题主库 record count mismatch after append/u,
  );
  assert.equal(client.rows.get(client.masterId).length, 2);
  assert.equal(client.tables.has('tbl-auto-1'), false);
});
