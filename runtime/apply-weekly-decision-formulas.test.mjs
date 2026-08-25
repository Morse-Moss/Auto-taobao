import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFormulaMutation,
  assertSupportedRepairPlan,
  assertWeeklyDecisionMutation,
  buildDirectionReplacementPlan,
  formulaInputsSettled,
  parseOptions,
  prepareFormulaApplyPlan,
  prepareDecisionFormulaApplyPlan,
  verifyTargetDecisionApply,
  verifyTargetFormulaApply,
  verifySchemaStage,
} from './apply-weekly-decision-formulas.mjs';
import { buildDecisionFormulaPlan } from './keyword-decision-formulas.mjs';
import { buildDecisionSchemaPlan } from './keyword-decision-schema.mjs';

const TABLE_ID = 'tblCurrent';

function field(id, name, type = 1, property = null) {
  return { field_id: id, field_name: name, type, property };
}

function fields() {
  return [
    field('fldSearch', '搜索词'),
    field('fldPopularity', '搜索人气'),
    field('fldTrade', '支付转化率'),
    field('fldClass', '关键词分类', 3),
    field('fldLabels', '细分标签', 4),
    field('fldSearchHeat', '搜索热度', 20, { formula_expression: 'search' }),
    field('fldContentHeat', '内容热度'),
    field('fldTradeHeat', '交易热度', 20, { formula_expression: 'trade' }),
    field('fldRecent', '近2周重点达标次数', 2),
    field('fldRecentA', '近2周A级达标次数', 2),
    field('fldRecentExplore', '近2周探索达标次数', 2),
    field('fldPreviousTarget', '上一有效周重点达标', 2),
    field('fldPreviousA', '上一有效周A级达标', 2),
    field('fldPreviousExplore', '上一有效周探索达标', 2),
    field('fldViews', '灰豚话题浏览量', 2),
    field('fldKey', '是否重点词', 20, { formula_expression: 'old-key' }),
    field('fldPriority', '优先级', 20, { formula_expression: 'old-priority' }),
    field('fldDirection', '对应产品方向', 1),
  ];
}

test('formula migration CLI is dry-run by default and requires exact Base and table confirmations', () => {
  const args = [
    '--base-url', 'https://example.feishu.cn/base/appToken',
    '--table-id', TABLE_ID,
    '--table-name', '关键词分析 V1（2026-08-14）',
  ];
  assert.equal(parseOptions(args).apply, false);
  assert.equal(parseOptions([...args, '--search-heat-only']).searchHeatOnly, true);
  assert.throws(() => parseOptions([...args, '--apply']), /confirm-base/iu);
  assert.equal(parseOptions([
    ...args, '--apply', '--confirm-base', 'appToken', '--confirm-table', TABLE_ID,
  ]).apply, true);
});

test('direction replacement preserves the old text field until the new formula field is ready', () => {
  const current = fields();
  const directionField = current.find((item) => item.field_name === '对应产品方向');
  const directionUpdate = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: current }).updates
    .find((item) => item.fieldName === '对应产品方向');
  const replacement = buildDirectionReplacementPlan({ field: directionField, formulaUpdate: directionUpdate });

  assert.equal(replacement.renameOld.body.field_name, '__对应产品方向_旧AI备份');
  assert.equal(replacement.createNew.body.field_name, '对应产品方向');
  assert.equal(replacement.createNew.body.type, 20);
  const scope = {
    appToken: 'appToken',
    tableId: TABLE_ID,
    schemaPlan: { updates: [], creates: [] },
    plan: { updates: [] },
    directionReplacement: replacement,
  };
  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${directionField.field_id}`,
    body: replacement.renameOld.body,
  }, scope));
  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'POST',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields`,
    body: replacement.createNew.body,
  }, scope));
  assert.throws(() => assertWeeklyDecisionMutation({
    method: 'DELETE',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${directionField.field_id}`,
  }, scope), /Blocked unauthorized/iu);
  replacement.canDeleteOld = true;
  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'DELETE',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${directionField.field_id}`,
  }, scope));
});

test('AI product direction replacement creates and verifies a temporary formula before deleting the AI field', () => {
  const current = fields().map((item) => item.field_name === '对应产品方向'
    ? { ...item, type: 25, ui_type: 'Object', property: null }
    : item);
  const directionField = current.find((item) => item.field_name === '对应产品方向');
  const directionUpdate = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: current }).updates
    .find((item) => item.fieldName === '对应产品方向');
  const replacement = buildDirectionReplacementPlan({ field: directionField, formulaUpdate: directionUpdate });

  assert.equal(replacement.strategy, 'temporary-formula-first');
  assert.equal(replacement.renameOld, null);
  assert.equal(replacement.createNew.body.field_name, '__对应产品方向_新公式');
  assert.equal(replacement.promoteNew.body.field_name, '对应产品方向');
  assert.equal(replacement.createNew.body.type, 20);

  replacement.newFieldId = 'fldDirectionFormula';
  replacement.canDeleteNew = true;
  const scope = {
    appToken: 'appToken',
    tableId: TABLE_ID,
    schemaPlan: { updates: [], creates: [] },
    plan: { updates: [] },
    directionReplacement: replacement,
  };
  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'DELETE',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${replacement.newFieldId}`,
  }, scope));
});

test('decision apply plan separates a text product direction field from normal formula updates', () => {
  const current = fields();
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: current });
  const prepared = prepareDecisionFormulaApplyPlan({ fields: current, plan: full });

  assert.deepEqual(prepared.plan.updates.map((item) => item.fieldName), [
    '搜索热度', '交易热度',
    '近2周重点达标次数', '近2周A级达标次数', '近2周探索达标次数',
    '是否重点词', '优先级',
  ]);
  assert.equal(prepared.directionReplacement.oldFieldId, 'fldDirection');
  assert.equal(prepared.directionReplacement.createNew.body.field_name, '对应产品方向');
});

test('search-heat-only mode skips product-direction preparation for history tables', () => {
  const plan = { updates: [{ fieldId: 'fldSearchHeat', fieldName: '搜索热度', body: {} }] };
  assert.deepEqual(prepareFormulaApplyPlan({ fields: [], plan, searchHeatOnly: true }), {
    plan,
    directionReplacement: null,
  });
});

test('search-heat-only settlement does not require decision fields', () => {
  assert.equal(formulaInputsSettled([
    { fields: { 搜索词: '浴缸', 搜索热度: '高' } },
  ], '对应产品方向', true), true);
  assert.equal(formulaInputsSettled([
    { fields: { 搜索词: '浴缸', 搜索热度: '#ERROR!' } },
  ], '对应产品方向', true), false);
});

test('search-heat-only schema stage verifies zero changes without decision helper fields', () => {
  const historyFields = [field('fldSearch', '搜索词'), field('fldSearchHeat', '搜索热度', 20)];
  const historyRecords = [{ record_id: 'r1', fields: { 搜索词: '浴缸', 搜索热度: '低' } }];
  assert.deepEqual(verifySchemaStage({
    tableId: TABLE_ID,
    beforeFields: historyFields,
    afterFields: structuredClone(historyFields),
    beforeRecords: historyRecords,
    afterRecords: structuredClone(historyRecords),
    schemaPlan: { updates: [], creates: [] },
    searchHeatOnly: true,
  }), { fieldsRenamed: 0, fieldsCreated: 0, recordsWritten: 0 });
});

test('decision apply verification accepts one proven product direction replacement', () => {
  const beforeFields = fields();
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: beforeFields });
  const prepared = prepareDecisionFormulaApplyPlan({ fields: beforeFields, plan: full });
  const priorityUpdate = prepared.plan.updates.find((item) => item.fieldName === '优先级');
  const normalPlan = { updates: [priorityUpdate] };
  const replacement = prepared.directionReplacement;
  replacement.newFieldId = 'fldDirectionFormula';
  replacement.canDeleteOld = true;

  const afterFields = beforeFields
    .filter((item) => item.field_id !== replacement.oldFieldId)
    .map((item) => item.field_id === priorityUpdate.fieldId ? { ...item, ...priorityUpdate.body } : structuredClone(item));
  afterFields.push({
    field_id: replacement.newFieldId,
    ...replacement.createNew.body,
  });
  const beforeRecords = [{
    record_id: 'r1',
    fields: { 搜索词: '浴缸', 优先级: 'B-持续观察', 对应产品方向: '旧 AI 方向', 排名: '1' },
  }];
  const afterRecords = [{
    record_id: 'r1',
    fields: { 搜索词: '浴缸', 优先级: 'A候选', 对应产品方向: '暂无', 排名: '1' },
  }];

  assert.deepEqual(verifyTargetDecisionApply({
    tableId: TABLE_ID,
    beforeFields,
    afterFields,
    beforeRecords,
    afterRecords,
    plan: normalPlan,
    directionReplacement: replacement,
  }), { fieldsUpdated: 2, recordsWritten: 0, fieldReplaced: true });
});

test('mutation guard permits only exact planned formula field updates', () => {
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: fields() });
  const plan = { updates: full.updates.filter((item) => item.fieldName === '优先级') };
  const update = plan.updates[0];
  const scope = { appToken: 'appToken', tableId: TABLE_ID, plan };
  assert.doesNotThrow(() => assertFormulaMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${update.fieldId}`,
    body: update.body,
  }, scope));
  assert.throws(() => assertFormulaMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/fldSearch`,
    body: { field_name: '搜索词', type: 1 },
  }, scope), /Blocked unauthorized/iu);
});

test('combined mutation guard permits the exact schema and formula plans only', () => {
  const beforeFields = fields().map((item) => item.field_name === '内容热度'
    ? { ...item, field_name: '内容热度（后续）' }
    : item);
  const schemaPlan = buildDecisionSchemaPlan({ fields: beforeFields, records: [] });
  const formulaPlan = { updates: buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: fields() }).updates.slice(-1) };
  const scope = { appToken: 'appToken', tableId: TABLE_ID, schemaPlan, plan: formulaPlan };
  const schemaUpdate = schemaPlan.updates[0];
  const formulaUpdate = formulaPlan.updates[0];

  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${schemaUpdate.fieldId}`,
    body: schemaUpdate.body,
  }, scope));
  assert.doesNotThrow(() => assertWeeklyDecisionMutation({
    method: 'PUT',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/fields/${formulaUpdate.fieldId}`,
    body: formulaUpdate.body,
  }, scope));
  assert.throws(() => assertWeeklyDecisionMutation({
    method: 'POST',
    path: `/bitable/v1/apps/appToken/tables/${TABLE_ID}/records/batch_update`,
    body: { records: [] },
  }, scope), /Blocked unauthorized/iu);
});

test('repair plan permits all eight approved formula fields and rejects unrelated fields', () => {
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: fields() });
  assert.doesNotThrow(() => assertSupportedRepairPlan(full));
  assert.throws(() => assertSupportedRepairPlan({ updates: [
    ...full.updates,
    { fieldName: '未授权字段', fieldId: 'fldOther', body: {} },
  ] }), /unsupported formula repair/iu);
});

test('repair plan explicitly permits the two heat formulas', () => {
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: fields() });
  assert.deepEqual(full.updates.map((item) => item.fieldName), [
    '搜索热度', '交易热度',
    '近2周重点达标次数', '近2周A级达标次数', '近2周探索达标次数',
    '是否重点词', '优先级', '对应产品方向',
  ]);
  assert.doesNotThrow(() => assertSupportedRepairPlan({
    updates: full.updates.filter((item) => ['搜索热度', '交易热度'].includes(item.fieldName)),
  }));
});

test('verification allows only the planned formula definition and its calculated values to change', () => {
  const beforeFields = fields();
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: beforeFields });
  const plan = { updates: full.updates.filter((item) => item.fieldName === '优先级') };
  const afterFields = beforeFields.map((item) => {
    const update = plan.updates.find((candidate) => candidate.fieldId === item.field_id);
    return update ? { ...item, ...update.body } : structuredClone(item);
  });
  const beforeRecords = [{ record_id: 'r1', fields: { 搜索词: '浴缸', 关键词分类: '', 优先级: 'A候选' } }];
  const afterRecords = [{ record_id: 'r1', fields: { 搜索词: '浴缸', 关键词分类: '', 优先级: '待数据' } }];
  assert.deepEqual(verifyTargetFormulaApply({
    tableId: TABLE_ID, beforeFields, afterFields, beforeRecords, afterRecords, plan,
  }), { fieldsUpdated: 1, recordsWritten: 0 });

  const corrupted = structuredClone(afterRecords);
  corrupted[0].fields.搜索词 = '被改坏';
  assert.throws(() => verifyTargetFormulaApply({
    tableId: TABLE_ID, beforeFields, afterFields, beforeRecords, afterRecords: corrupted, plan,
  }), /business record data/iu);
});

test('verification treats Feishu projected nulls as unchanged blank fields', () => {
  const beforeFields = fields();
  const full = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: beforeFields });
  const plan = { updates: full.updates.filter((item) => item.fieldName === '优先级') };
  const afterFields = beforeFields.map((item) => {
    const update = plan.updates.find((candidate) => candidate.fieldId === item.field_id);
    return update ? { ...item, ...update.body } : structuredClone(item);
  });
  const beforeRecords = [{ record_id: 'r1', fields: { 搜索词: '浴缸', 优先级: 'B-持续观察' } }];
  const afterRecords = [{
    record_id: 'r1',
    fields: { 搜索词: '浴缸', 优先级: 'B-持续观察', 上一有效周重点达标: null },
  }];
  assert.deepEqual(verifyTargetFormulaApply({
    tableId: TABLE_ID, beforeFields, afterFields, beforeRecords, afterRecords, plan,
  }), { fieldsUpdated: 1, recordsWritten: 0 });
});
