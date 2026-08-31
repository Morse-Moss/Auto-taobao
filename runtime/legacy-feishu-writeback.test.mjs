import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildLegacyWritebackPlan, mapLegacyResult, normalizeContentHeat, readArtifact } from './legacy-feishu-writeback.mjs';

const fieldDefinitions = [{ field_name: '细分标签', property: { options: [
  { name: '场景/家用' }, { name: '场景/小户型' }, { name: '品牌/TOTO' }, { name: '尺寸/70厘米' },
  { name: '功能/按摩' }, { name: '功能/深泡' },
] } }];

test('maps legacy enums and compatible labels to current Feishu options', () => {
  const mapped = mapLegacyResult({ record_id: 'r1', 字段: {
    标准归并词: '浴缸', 关键词分类: '适用人群与场景词', 细分标签: '家用、小户型、按摩',
    用户意图: '购买决策型', 内容热度: 'AI预测-高',
  } }, new Set(fieldDefinitions[0].property.options.map((item) => item.name)));
  assert.deepEqual(mapped.fields, { 标准归并词: '浴缸', 关键词分类: '场景词', 细分标签: ['场景/家用', '场景/小户型', '功能/按摩'], 用户意图: '购买型', 内容热度: '高' });
  assert.deepEqual(mapped.unmappedLabels, []);
});

test('normalizes legacy content heat prefix to the current formula contract', () => {
  assert.equal(normalizeContentHeat('AI预测-高'), '高');
  assert.equal(normalizeContentHeat('中'), '中');
  assert.equal(normalizeContentHeat('AI预测-低'), '低');
  assert.throws(() => normalizeContentHeat('待核验'), /内容热度/u);
});

test('retains unmapped labels in audit output instead of silently inventing options', () => {
  const mapped = mapLegacyResult({ record_id: 'r1', 字段: {
    标准归并词: '浴缸', 关键词分类: '核心大词', 细分标签: '70cm、未知属性', 用户意图: '了解型', 内容热度: 'AI预测-低',
  } }, new Set(['大词', '尺寸/70厘米']));
  assert.deepEqual(mapped.fields.细分标签, []);
  assert.deepEqual(mapped.unmappedLabels, ['70cm', '未知属性']);
});

test('builds updates only for blank writable fields and preserves populated values', () => {
  const artifact = { status: 'LOCAL_LEGACY_PROMPT_ANALYSIS_READY', recordCount: 2, results: [
    { record_id: 'r1', 字段: { 标准归并词: '浴缸', 关键词分类: '大词', 细分标签: '', 用户意图: '了解型', 内容热度: 'AI预测-低' } },
    { record_id: 'r2', 字段: { 标准归并词: '小浴缸', 关键词分类: '尺寸词', 细分标签: '小户型', 用户意图: '购买决策型', 内容热度: 'AI预测-高' } },
  ] };
  const records = [{ record_id: 'r1', fields: { 标准归并词: '', 关键词分类: '', 细分标签: [], 用户意图: '', 内容热度: '' } }, { record_id: 'r2', fields: { 标准归并词: '已有', 关键词分类: '大词', 细分标签: ['场景/家用'], 用户意图: '了解型', 内容热度: '已有' } }];
  const plan = buildLegacyWritebackPlan({ artifact, records, fieldDefinitions });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].record_id, 'r1');
  assert.equal(plan.preservedExisting, 5);
});

test('adapts the prior PUBLISH_READY analysis artifact to the legacy writeback shape', () => {
  const file = 'D:/Retire/sycm-automation/runtime/tmp-publish-ready-artifact.json';
  fs.writeFileSync(file, JSON.stringify({ status: 'PUBLISH_READY', analysisValues: [{ record_id: 'r1', keywordId: 'KW000001', fields: { 标准归并词: '浴缸', 关键词分类: '大词', 细分标签: ['功能/深泡'], 用户意图: '了解型', 内容热度: '低' } }] }));
  const adapted = readArtifact(file);
  assert.equal(adapted.status, 'LOCAL_LEGACY_PROMPT_ANALYSIS_READY');
  assert.equal(adapted.recordCount, 1);
  assert.equal(adapted.results[0].字段.内容热度, '低');
  fs.unlinkSync(file);
});
