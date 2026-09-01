import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAnalysisRecords, sourceTopicIdentity } from './faq-text-analysis.mjs';
import { prepareReplacement, switchReplacement } from './publish-faq-detail-enrichment.mjs';

const period = '2026-08-23_2026-08-29';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function finalRecords() {
  return buildAnalysisRecords([{
    recordId: 'raw-1',
    fields: {
      商品ID: 'p1',
      来源类型: '评论',
      原始内容: '没有一点味道，排水顺畅',
      来源记录唯一键: 'source-1',
      crossWeekDedupKey: 'text:source-1',
      采集状态: '已采集',
    },
  }]);
}

async function artifacts() {
  const outputDir = await mkdtemp(join(tmpdir(), 'faq-replacement-'));
  const records = finalRecords();
  const finalText = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const auditText = `${JSON.stringify({ version: 'audit', unresolvedCount: 0 }, null, 2)}\n`;
  const identities = records.map((record) => sourceTopicIdentity(record)).sort().join('\n');
  const finalPath = join(outputDir, 'final-classified-records.jsonl');
  const receiptPath = join(outputDir, 'final-classification-receipt.json');
  const reviewDir = join(outputDir, 'ai-review');
  const auditPath = join(reviewDir, 'source-topic-audit.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(reviewDir, { recursive: true }));
  await writeFile(finalPath, finalText, 'utf8');
  await writeFile(auditPath, auditText, 'utf8');
  await writeFile(receiptPath, `${JSON.stringify({
    mode: 'FINAL_CLASSIFICATION_READY', period, analysisVersion: records[0].classificationVersion,
    publishable: true, humanQueueCount: 0, classifiedRecords: records.length,
    legacyAudit: { unresolvedCount: 0 },
    source: {
      finalClassifiedSnapshot: { path: finalPath, sha256: hash(finalText) },
      sourceTopicSet: { count: records.length, sha256: hash(identities) },
      legacySourceTopicAudit: { path: auditPath, sha256: hash(auditText) },
    },
  }, null, 2)}\n`, 'utf8');
  return { outputDir, records };
}

class DryClient {
  constructor() { this.mutations = []; }
  async listTables() {
    return [
      { tableId: 'tblRS5lo0nNN3DOJ', name: '问题主库' },
      { tableId: 'tblKYtO4SInsW9Oe', name: `问题库_${period}` },
    ];
  }
  async listFields() { return []; }
  async listRecords(tableId) { return [{ recordId: `old-${tableId}`, fields: { 原始内容: '旧行' } }]; }
  async createTable() { this.mutations.push('create'); throw new Error('dry-run mutation'); }
  async batchCreateRecords() { this.mutations.push('write'); throw new Error('dry-run mutation'); }
  async renameTable() { this.mutations.push('rename'); throw new Error('dry-run mutation'); }
  async deleteTable() { this.mutations.push('delete'); throw new Error('dry-run mutation'); }
}

function options(outputDir) {
  return {
    outputDir, period, appToken: 'OWebbPUcBa7B8JseYLccQCy9nkf',
    masterTableId: 'tblRS5lo0nNN3DOJ', weeklyTableId: 'tblKYtO4SInsW9Oe',
  };
}

test('prepare dry-run snapshots exact old tables and performs no mutation', async () => {
  const { outputDir, records } = await artifacts();
  const client = new DryClient();
  const result = await prepareReplacement({ client, options: options(outputDir), operatorContent: { source: { path: 'operator.xlsx', sha256: 'a'.repeat(64) }, content: {} }, apply: false });
  assert.equal(result.mode, 'PREPARE_DRY_RUN_READY');
  assert.equal(result.candidates.master.rows, records.length);
  assert.equal(result.candidates.weekly.rows, records.length);
  assert.equal(result.denominator, 1);
  assert.equal(result.candidates.master.denominator, 1);
  assert.match(result.statisticsHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.candidates.master.statisticsHash, result.statisticsHash);
  assert.equal(result.oldTables.master.tableId, 'tblRS5lo0nNN3DOJ');
  assert.deepEqual(client.mutations, []);
});

test('prepare dry-run rejects final artifact content drift before reading Feishu', async () => {
  const { outputDir } = await artifacts();
  await writeFile(join(outputDir, 'final-classified-records.jsonl'), '{}\n', 'utf8');
  const client = new DryClient();
  await assert.rejects(() => prepareReplacement({ client, options: options(outputDir), operatorContent: { source: {}, content: {} }, apply: false }), /Analysis record|artifact hash mismatch/u);
  assert.deepEqual(client.mutations, []);
});

test('switch rejects candidate receipt hash drift without mutations', async () => {
  const { outputDir } = await artifacts();
  await writeFile(join(outputDir, 'detail-replacement-candidate-receipt.json'), '{}\n', 'utf8');
  const client = new DryClient();
  const switchOptions = { ...options(outputDir), candidateReceiptSha256: '0'.repeat(64), candidateMasterTableId: 'new-master', candidateWeeklyTableId: 'new-weekly' };
  await assert.rejects(() => switchReplacement({ client, options: switchOptions, apply: false }), /receipt hash mismatch/u);
  assert.deepEqual(client.mutations, []);
});
