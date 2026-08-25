import assert from 'node:assert/strict';
import test from 'node:test';

import * as decisionFormulas from './keyword-decision-formulas.mjs';

const {
  buildDecisionFormulaPlan,
  buildSearchHeatFormulaPlan,
  normalizeFormulaExpression,
  verifyDecisionFormulaFields,
} = decisionFormulas;

const TABLE_ID = 'tblExample';

function field(id, name, type = 1, property = null) {
  return { field_id: id, field_name: name, type, property };
}

function currentFields() {
  return [
    field('fldSearch', '\u641c\u7d22\u8bcd'),
    field('fldPopularity', '\u641c\u7d22\u4eba\u6c14'),
    field('fldTrade', '\u652f\u4ed8\u8f6c\u5316\u7387'),
    field('fldClass', '\u5173\u952e\u8bcd\u5206\u7c7b', 3),
    field('fldLabels', '\u7ec6\u5206\u6807\u7b7e', 4),
    field('fldSearchHeat', '\u641c\u7d22\u70ed\u5ea6', 20, { formula_expression: 'old-search-heat' }),
    field('fldContentHeat', '\u5185\u5bb9\u70ed\u5ea6'),
    field('fldTradeHeat', '\u4ea4\u6613\u70ed\u5ea6', 20, { formula_expression: 'old-trade-heat' }),
    field('fldPreviousTargets', '\u4e0a\u4e00\u6709\u6548\u5468\u91cd\u70b9\u8fbe\u6807', 2),
    field('fldPreviousA', '\u4e0a\u4e00\u6709\u6548\u5468A\u7ea7\u8fbe\u6807', 2),
    field('fldPreviousExplore', '\u4e0a\u4e00\u6709\u6548\u5468\u63a2\u7d22\u8fbe\u6807', 2),
    field('fldRecentTargets', '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570', 2),
    field('fldRecentA', '\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570', 2),
    field('fldRecentExplore', '\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570', 2),
    field('fldHuitunViews', '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf', 2),
    field('fldKey', '\u662f\u5426\u91cd\u70b9\u8bcd'),
    field('fldPriority', '\u4f18\u5148\u7ea7'),
    field('fldDirection', '\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411'),
  ];
}

test('builds formulas from the latest operating criteria', () => {
  const plan = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: currentFields() });

  assert.deepEqual(plan.updates.map((item) => item.fieldName), [
    '\u641c\u7d22\u70ed\u5ea6', '\u4ea4\u6613\u70ed\u5ea6',
    '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570', '\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570',
    '\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570', '\u662f\u5426\u91cd\u70b9\u8bcd',
    '\u4f18\u5148\u7ea7', '\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411',
  ]);
  assert.equal(plan.updates.every((item) => item.body.type === 20), true);

  const formula = (name) => plan.updates.find((item) => item.fieldName === name).body.property.formula_expression;
  const searchFormula = formula('\u641c\u7d22\u70ed\u5ea6');
  const tradeFormula = formula('\u4ea4\u6613\u70ed\u5ea6');
  const recentTargetsFormula = formula('\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570');
  const recentAFormula = formula('\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570');
  const recentExploreFormula = formula('\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570');
  const keyFormula = formula('\u662f\u5426\u91cd\u70b9\u8bcd');
  const priorityFormula = formula('\u4f18\u5148\u7ea7');
  const directionFormula = formula('\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411');
  assert.match(searchFormula, /0 ~ 20/);
  assert.match(searchFormula, /1200 ~ 2500/);
  assert.match(searchFormula, /600 ~ 1200/);
  assert.ok(searchFormula.indexOf('1200 ~ 2500') < searchFormula.indexOf('"\u9ad8"'));
  assert.ok(searchFormula.indexOf('600 ~ 1200') > searchFormula.indexOf('"\u9ad8"'));
  assert.ok(searchFormula.indexOf('600 ~ 1200') < searchFormula.indexOf('"\u4e2d"'));
  assert.match(tradeFormula, /40% ~ 45%/);
  assert.match(tradeFormula, /"-","\u65e0\u6570\u636e"/);
  assert.match(recentTargetsFormula, /\$field\[fldPreviousTargets\]/);
  assert.match(recentTargetsFormula, /\$field\[fldClass\]/);
  assert.match(recentTargetsFormula, /\$field\[fldLabels\]/);
  assert.match(recentTargetsFormula, /\$field\[fldSearchHeat\]/);
  assert.match(recentTargetsFormula, /\$field\[fldTradeHeat\]/);
  assert.match(recentTargetsFormula, /\u75db\u70b9\/(?:\u6e05\u6d01|\u6f0f\u6c34|\u6392\u6c34|\u7ef4\u4fee)/);
  assert.match(recentAFormula, /\$field\[fldPreviousA\]/);
  assert.match(recentAFormula, /\$field\[fldPriority\]/);
  assert.match(recentAFormula, /\$field\[fldPriority\]="A\u5019\u9009"/);
  assert.ok(recentAFormula.indexOf('="A\u5019\u9009"') < recentAFormula.indexOf('="B-\u6301\u7eed\u89c2\u5bdf"'));
  assert.match(recentExploreFormula, /\$field\[fldPreviousExplore\]/);
  assert.match(recentExploreFormula, /\$field\[fldSearchHeat\]/);
  assert.match(recentExploreFormula, /\$field\[fldContentHeat\]/);
  for (const [formulaText, ownId] of [
    [recentTargetsFormula, 'fldRecentTargets'],
    [recentAFormula, 'fldRecentA'],
    [recentExploreFormula, 'fldRecentExplore'],
  ]) {
    assert.doesNotMatch(formulaText, new RegExp(`\\$field\\[${ownId}\\]`));
    assert.match(formulaText, /ISBLANK/);
  }
  for (const id of ['fldSearch', 'fldClass', 'fldSearchHeat', 'fldTradeHeat', 'fldRecentTargets']) {
    assert.match(keyFormula, new RegExp(`\\$field\\[${id}\\]`));
  }
  assert.doesNotMatch(keyFormula, /\$field\[fldContentHeat\]/);
  for (const id of ['fldSearch', 'fldClass', 'fldLabels', 'fldSearchHeat', 'fldContentHeat', 'fldTradeHeat', 'fldHuitunViews']) {
    assert.match(priorityFormula, new RegExp(`\\$field\\[${id}\\]`));
  }
  assert.match(keyFormula, /\u5f85\u6570\u636e/);
  assert.match(keyFormula, />=2/);
  assert.match(keyFormula, /\$field\[fldClass\]="\u54c1\u724c\u8bcd"/);
  assert.doesNotMatch(keyFormula, /\u75db\u70b9\/(?:\u6e05\u6d01|\u6f0f\u6c34|\u6392\u6c34|\u7ef4\u4fee)/);
  assert.match(priorityFormula, /A-\u7acb\u5373\u8ddf\u8fdb/);
  assert.match(priorityFormula, /A\u5019\u9009/);
  assert.match(priorityFormula, /10000000/);
  assert.match(priorityFormula, new RegExp(`\\$field\\[fldContentHeat\\]="\\u4e2d"`));
  assert.match(priorityFormula, new RegExp(`ISBLANK\\(bitable::\\$table\\[${TABLE_ID}\\]\\.\\$field\\[fldClass\\]\\)`));
  assert.ok(priorityFormula.indexOf('"C-\u5e38\u89c4\u8ddf\u8e2a"') < priorityFormula.indexOf('"\u5f85\u6570\u636e"'));
  assert.match(priorityFormula, new RegExp(`\\$field\\[fldTradeHeat\\]="\\u9ad8"`));
  assert.doesNotMatch(priorityFormula, new RegExp(`ISBLANK\\(bitable::\\$table\\[${TABLE_ID}\\]\\.\\$field\\[fldContentHeat\\]\\)`));
  assert.match(priorityFormula, new RegExp(`ISBLANK\\(bitable::\\$table\\[${TABLE_ID}\\]\\.\\$field\\[fldHuitunViews\\]\\)`));
  const recentBlank = `ISBLANK(bitable::$table[${TABLE_ID}].$field[fldRecentTargets])`;
  const currentSearchGate = `bitable::$table[${TABLE_ID}].$field[fldSearchHeat]="\u9ad8"`;
  assert.ok(keyFormula.indexOf(currentSearchGate) < keyFormula.indexOf(recentBlank));
  assert.doesNotMatch(keyFormula, /fldBatches/);
  assert.doesNotMatch(priorityFormula, /fldIntent|fldRank|fldBatches|fldRecentTargets/);
  for (const id of ['fldRecentTargets', 'fldRecentA', 'fldRecentExplore']) {
    assert.match(directionFormula, new RegExp(`\\$field\\[${id}\\]`));
  }
  assert.doesNotMatch(directionFormula, /fldContentHeat|fldSearchHeat|fldTradeHeat|fldHuitunViews/);
  assert.match(directionFormula, /\u4e3b\u63a8\u65b9\u5411\uff08\u5df2\u6709\u4f18\u52bf\u653e\u5927\uff09/);
  assert.match(directionFormula, /\u589e\u957f\u65b9\u5411\uff08\u672a\u6765\u65b0\u54c1\uff09/);
  assert.match(directionFormula, /\u63a2\u7d22\u65b9\u5411\uff08\u9a8c\u8bc1\u5e02\u573a\uff09/);
  assert.match(directionFormula, /\u6682\u65e0/);
  assert.ok(directionFormula.indexOf('fldRecentTargets') < directionFormula.indexOf('fldRecentA'));
  assert.ok(directionFormula.indexOf('fldRecentA') < directionFormula.indexOf('fldRecentExplore'));
});

test('builds a search-heat-only plan for history tables without AI decision fields', () => {
  const historyFields = [
    field('fldSearch', '\u641c\u7d22\u8bcd'),
    field('fldPopularity', '\u641c\u7d22\u4eba\u6c14'),
    field('fldTrade', '\u652f\u4ed8\u8f6c\u5316\u7387'),
    field('fldSearchHeat', '\u641c\u7d22\u70ed\u5ea6', 20, { formula_expression: 'old' }),
  ];
  const plan = buildSearchHeatFormulaPlan({ tableId: TABLE_ID, fields: historyFields });
  assert.deepEqual(plan.updates.map((item) => item.fieldName), ['\u641c\u7d22\u70ed\u5ea6']);
  assert.match(plan.updates[0].body.property.formula_expression, /1200 ~ 2500/);
});

test('selects the Huitun queue from the A-candidate workflow state', () => {
  const select = decisionFormulas.selectHuitunCandidates ?? (() => []);
  const record = (id, priority, extra = {}) => ({
    record_id: id,
    fields: {
      '\u4f18\u5148\u7ea7': priority,
      ...extra,
    },
  });
  const records = [
    record('candidate-one', 'A\u5019\u9009', { '\u641c\u7d22\u70ed\u5ea6': '\u4f4e' }),
    record('candidate-two', [{ text: 'A\u5019\u9009' }]),
    record('confirmed-a', 'A-\u7acb\u5373\u8ddf\u8fdb'),
    record('fallback-b', 'B-\u6301\u7eed\u89c2\u5bdf', { '\u641c\u7d22\u70ed\u5ea6': '\u9ad8', '\u4ea4\u6613\u70ed\u5ea6': '\u9ad8' }),
    record('ordinary-c', 'C-\u5e38\u89c4\u8ddf\u8e2a'),
  ];

  assert.deepEqual(select(records).map((item) => item.record_id), ['candidate-one', 'candidate-two']);
});

test('verification accepts only the intended formula field replacements', () => {
  const before = currentFields();
  const plan = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: before });
  const after = before.map((item) => {
    const update = plan.updates.find((candidate) => candidate.fieldId === item.field_id);
    return update ? { ...item, ...update.body } : structuredClone(item);
  });

  assert.deepEqual(verifyDecisionFormulaFields({ tableId: TABLE_ID, before, after, plan }), {
    formulaFieldsUpdated: 8,
    unexpectedFieldChanges: 0,
  });
});

test('verification accepts a priority-only formula replacement', () => {
  const before = currentFields();
  const fullPlan = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: before });
  const plan = { updates: fullPlan.updates.filter((item) => item.fieldName === '\u4f18\u5148\u7ea7') };
  const after = before.map((item) => {
    const update = plan.updates.find((candidate) => candidate.fieldId === item.field_id);
    return update ? { ...item, ...update.body } : structuredClone(item);
  });

  assert.deepEqual(verifyDecisionFormulaFields({ tableId: TABLE_ID, before, after, plan }), {
    formulaFieldsUpdated: 1,
    unexpectedFieldChanges: 0,
  });
});

test('filters an already-current formula out of the mutation plan', () => {
  const before = currentFields();
  const fullPlan = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: before });
  const current = before.map((item) => {
    const update = fullPlan.updates.find((candidate) =>
      candidate.fieldId === item.field_id && candidate.fieldName !== '\u4f18\u5148\u7ea7');
    return update ? { ...item, ...update.body } : structuredClone(item);
  });
  const filter = decisionFormulas.filterChangedFormulaPlan ?? (() => fullPlan);

  assert.deepEqual(
    filter({ fields: current, plan: fullPlan }).updates.map((item) => item.fieldName),
    ['\u4f18\u5148\u7ea7'],
  );
});

test('normalizes table-specific field references for cross-table formula verification', () => {
  const left = 'IF(bitable::$table[tblLeft].$field[fldOne]=1,"x","y")';
  const right = 'IF(bitable::$table[tblRight].$field[fldTwo]=1,"x","y")';

  assert.equal(normalizeFormulaExpression(left), normalizeFormulaExpression(right));
  assert.notEqual(normalizeFormulaExpression(left), normalizeFormulaExpression('IF(1=2,"x","y")'));
});
