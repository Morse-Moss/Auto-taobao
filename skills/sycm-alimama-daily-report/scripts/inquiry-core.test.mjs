import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyInquiryWrite, extractInquiryMetrics, selectDailyStoreRecord } from './inquiry-core.mjs';

test('extracts the date row and peer average from 当日询单人数', () => {
  const table = {
    headers: ['日期', '延 询单人数', '当日询单人数', '当日付款人数'],
    rows: [
      ['2026-09-15', '延迟统计', '14', '3'],
      ['同行同层优秀', '延迟统计', '72', '23'],
      ['同行同层均值', '延迟统计', '36', '7'],
    ],
  };
  assert.deepEqual(extractInquiryMetrics(table, '2026-09-15'),
    { inquiry: 14, peerInquiry: 36, peerBenchmark: 'PEER_AVAILABLE' });
  assert.throws(() => extractInquiryMetrics({ ...table,
    rows: [...table.rows, ['2026-09-14', '延迟统计', '10', '2']] }, '2026-09-15'), /exactly one daily/u);
});

test('rejects ambiguous headers, missing rows, and nonnumeric values', () => {
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数', '当日询单人数'], rows: [] },
    '2026-09-15'), /expected one header/u);
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数'], rows: [['2026-09-15', '-']] },
    '2026-09-15'), /benchmark row/u);
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数'], rows: [
    ['2026-09-15', '-'], ['同行同层均值', '36'],
  ] }, '2026-09-15'), /invalid 当日询单人数/u);
});

// 实测：自定义日期模式下 SYCM 只给 3 行，同行同层对比行不返回。
test('默认对缺失的同行基准 fail-closed，显式关闭才降级为 PEER_UNAVAILABLE', () => {
  const historical = {
    headers: ['日期', '当日询单人数', '当日付款人数'],
    rows: [['2026-09-14', '10', '1'], ['汇总值', '10', '1'], ['平均值', '10', '1']],
  };
  assert.throws(() => extractInquiryMetrics(historical, '2026-09-14'), /benchmark row/u);
  assert.deepEqual(extractInquiryMetrics(historical, '2026-09-14', { peerBenchmarkRequired: false }),
    { inquiry: 10, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' });
  // 基准行出现两次属于源数据异常，任何模式下都要报错
  assert.throws(() => extractInquiryMetrics({ ...historical,
    rows: [...historical.rows, ['同行同层均值', '36', '7'], ['同行同层均值', '35', '7']] },
    '2026-09-14', { peerBenchmarkRequired: false }), /got 2/u);
});

test('selects exactly one Feishu row by date and shop', () => {
  const records = [
    { record_id: 'a', fields: { 日期: 1, 店铺: '盖文天猫' } },
    { record_id: 'b', fields: { 日期: 1, 店铺: '盖文淘宝' } },
  ];
  assert.equal(selectDailyStoreRecord(records, 1, '盖文天猫').record_id, 'a');
  assert.throws(() => selectDailyStoreRecord([...records, records[0]], 1, '盖文天猫'), /got 2/u);
  assert.throws(() => selectDailyStoreRecord(records, 2, '盖文天猫'), /got 0/u);
});

test('allows only a blank write or an exact idempotent rerun', () => {
  const metrics = { inquiry: 14, peerInquiry: 36, peerBenchmark: 'PEER_AVAILABLE' };
  assert.equal(classifyInquiryWrite({}, metrics), 'WRITE_REQUIRED');
  assert.equal(classifyInquiryWrite({ 询单量: 14, 同层同行询单量: 36 }, metrics), 'ALREADY_VERIFIED');
  assert.throws(() => classifyInquiryWrite({ 询单量: 14 }, metrics), /not jointly blank/u);
  assert.throws(() => classifyInquiryWrite({ 询单量: 15, 同层同行询单量: 36 }, metrics), /not jointly blank/u);
  assert.throws(() => classifyInquiryWrite({ 询单量: 0 }, { inquiry: 0, peerInquiry: 0 }), /not jointly blank/u);
  assert.equal(classifyInquiryWrite({ 询单量: 0, 同层同行询单量: 0 },
    { inquiry: 0, peerInquiry: 0 }), 'ALREADY_VERIFIED');
});

test('降级写入只认「询单量」，且要求同行那一格保持空白', () => {
  const metrics = { inquiry: 10, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' };
  assert.equal(classifyInquiryWrite({}, metrics), 'WRITE_REQUIRED');
  assert.equal(classifyInquiryWrite({ 询单量: 10, 同层同行询单量: null }, metrics), 'ALREADY_VERIFIED');
  // 重复运行必须是幂等的，而不是每次都抛错
  assert.equal(classifyInquiryWrite({ 询单量: '10' }, metrics), 'ALREADY_VERIFIED');
  assert.throws(() => classifyInquiryWrite({ 询单量: 11 }, metrics), /does not match source/u);
  // 降级模式下同行那一格若已有值，说明状态不可解释
  assert.throws(() => classifyInquiryWrite({ 询单量: 10, 同层同行询单量: 36 }, metrics), /is not blank/u);
});
