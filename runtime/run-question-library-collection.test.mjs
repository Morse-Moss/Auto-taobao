import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCollectionPlan,
  buildRecordsFromEvidence,
  parseCsv,
  readEvidence,
  assertManifestMatches,
} from './run-question-library-collection.mjs';

function weekly(id, monthly, rank) {
  return {
    recordId: `weekly-${id}`,
    fields: {
      商品ID: id,
      商品链接: `https://item.taobao.com/item.htm?id=${id}`,
      商品标题: `商品 ${id}`,
      竞品分类: 'A-爆款竞品',
      是否有效竞品: '是',
      月收货人数计算值: monthly,
      序号: rank,
      主表记录ID: `main-${id}`,
    },
  };
}

test('parseCsv handles quoted commas and newlines', () => {
  assert.deepEqual(parseCsv('问题,回答\n"安装,方便吗？","可以\n自己装"\n'), [
    { 问题: '安装,方便吗？', 回答: '可以\n自己装' },
  ]);
});

test('buildCollectionPlan locks the latest weekly A top five to main records', () => {
  const weeklyRecords = [
    weekly('1', 10, 2), weekly('2', 30, 3), weekly('3', 30, 1),
    weekly('4', 20, 4), weekly('5', 15, 5), weekly('6', 5, 6),
  ];
  const mainRecords = weeklyRecords.map((record) => ({
    recordId: `main-${record.fields.商品ID}`,
    fields: { 商品ID: record.fields.商品ID },
  }));
  const plan = buildCollectionPlan({ weeklyRecords, mainRecords, period: '2026-08-23_2026-08-29' });
  assert.deepEqual(plan.products.map((item) => item.productId), ['3', '2', '4', '5', '1']);
  assert.equal(plan.products.every((item) => item.mainRecordId.startsWith('main-')), true);
  assert.equal(plan.products[0].weeklyRecordId, 'weekly-3');
});

test('buildRecordsFromEvidence keeps raw data and leaves analysis fields blank', () => {
  const plan = buildCollectionPlan({
    weeklyRecords: [weekly('1', 100, 1)],
    mainRecords: [{ recordId: 'main-1', fields: { 商品ID: '1' } }],
    period: '2026-08-23_2026-08-29',
    limit: 1,
  });
  const records = buildRecordsFromEvidence({
    plan,
    evidenceByProduct: {
      '1': {
        qa: { sourceHash: 'qa-hash', rows: [{ 问题: '好安装吗？', 回答: '可以' }] },
        reviews: { sourceHash: 'review-hash', rows: [{ 评论内容: '安装方便' }] },
      },
    },
    collectedAt: '2026-08-25T10:00:00.000Z',
  });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.来源类型), ['问大家', '评论']);
  assert.equal(records.every((record) => record.高频问题或关键词 === '' && record.出现次数 === ''), true);
  assert.equal(new Set(records.map((record) => record.来源记录唯一键)).size, 2);
});

test('buildRecordsFromEvidence allows an empty QA export when reviews contain raw rows', () => {
  const plan = buildCollectionPlan({
    weeklyRecords: [weekly('1', 100, 1)],
    mainRecords: [{ recordId: 'main-1', fields: { 商品ID: '1' } }],
    period: '2026-08-23_2026-08-29',
    limit: 1,
  });
  const records = buildRecordsFromEvidence({
    plan,
    evidenceByProduct: {
      '1': {
        qa: { sourceHash: 'empty-qa-hash', rows: [] },
        reviews: { sourceHash: 'review-hash', rows: [{ 评论内容: '安装方便' }] },
      },
    },
    collectedAt: '2026-08-25T10:00:00.000Z',
  });
  assert.deepEqual(records.map((record) => record.来源类型), ['评论']);
});

test('readEvidence uses the raw review archive hash for idempotency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-evidence-'));
  const directory = join(root, '1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'qa.csv'), '问题,回答\n安装方便吗？,可以\n', 'utf8');
  await writeFile(join(directory, 'reviews.csv'), '评论内容\n安装方便\n', 'utf8');
  await writeFile(join(directory, 'qa-receipt.json'), JSON.stringify({ productId: '1', sourceFile: 'qa.csv', status: 'COMPLETED' }));
  await writeFile(join(directory, 'reviews-receipt.json'), JSON.stringify({ productId: '1', sourceFile: 'reviews-source.zip', normalizedFile: 'reviews.csv', status: 'COMPLETED' }));
  await writeFile(join(directory, 'reviews-source.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
  const evidence = await readEvidence(root, '1');
  assert.equal(evidence.reviews.sourceFile, 'reviews-source.zip');
  assert.notEqual(evidence.reviews.sourceHash, evidence.reviews.normalizedHash);
  assert.deepEqual(evidence.reviews.rows, [{ 评论内容: '安装方便' }]);
});

test('readEvidence rejects review CSV evidence without the raw archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'faq-evidence-missing-archive-'));
  const directory = join(root, '1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'qa.csv'), '问题,回答\n安装方便吗？,可以\n', 'utf8');
  await writeFile(join(directory, 'reviews.csv'), '评论内容\n安装方便\n', 'utf8');
  await writeFile(join(directory, 'qa-receipt.json'), JSON.stringify({ productId: '1', sourceFile: 'qa.csv', status: 'COMPLETED' }));
  await writeFile(join(directory, 'reviews-receipt.json'), JSON.stringify({ productId: '1', sourceFile: 'reviews-source.zip', normalizedFile: 'reviews.csv', status: 'COMPLETED' }));
  await assert.rejects(() => readEvidence(root, '1'), /reviews-source\.zip/);
});

test('assertManifestMatches rejects a changed locked product set', () => {
  const manifest = {
    period: '2026-08-23_2026-08-29',
    products: [{ productId: '1', mainRecordId: 'main-1', weeklyRecordId: 'week-1', monthlyReceived: 10, rank: 1 }],
  };
  const changedPlan = {
    period: '2026-08-23_2026-08-29',
    products: [{ productId: '2', mainRecordId: 'main-2', weeklyRecordId: 'week-2', monthlyReceived: 9, rank: 2 }],
  };
  assert.throws(() => assertManifestMatches(manifest, changedPlan), /manifest mismatch/);
});
