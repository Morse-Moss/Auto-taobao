import test from 'node:test';
import assert from 'node:assert/strict';
import { INQUIRY_HEADERS, parseInquiryRows, planInquiryImport } from './inquiry-core.mjs';

test('drops report summaries and maps all item rows', () => {
  const rows = [[], [], [], [], [], INQUIRY_HEADERS, ['商品A','1','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'], ['平均值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计']];
  const parsed = parseInquiryRows(rows, '2026-09-23', '盖文淘宝');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].row[2], '1');
  const plan = planInquiryImport({ rows: parsed, existing: [] });
  assert.equal(plan.records[0].名称, '商品A'); assert.equal(plan.records[0].咨询人数, 2); assert.equal(plan.records[0].最终付款人数, '延迟统计');
});
