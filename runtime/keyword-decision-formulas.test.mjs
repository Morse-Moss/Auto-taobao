import assert from 'node:assert/strict';
import test from 'node:test';

import * as decisionFormulas from './keyword-decision-formulas.mjs';

const {
  buildDecisionFormulaPlan,
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
    field('fldClass', '\u5173\u952e\u8bcd\u5206\u7c7b', 3),
    field('fldLabels', '\u7ec6\u5206\u6807\u7b7e', 4),
    field('fldSearchHeat', '\u641c\u7d22\u70ed\u5ea6', 20, { formula_expression: 'old-search-heat' }),
    field('fldContentHeat', '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09'),
    field('fldTradeHeat', '\u4ea4\u6613\u70ed\u5ea6', 20, { formula_expression: 'old-trade-heat' }),
    field('fldRecentTargets', '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570', 2),
    field('fldHuitunViews', '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf', 2),
    field('fldKey', '\u662f\u5426\u91cd\u70b9\u8bcd'),
    field('fldPriority', '\u4f18\u5148\u7ea7'),
  ];
}

test('builds formulas from the latest operating criteria', () => {
  const plan = buildDecisionFormulaPlan({ tableId: TABLE_ID, fields: currentFields() });

  assert.deepEqual(plan.updates.map((item) => item.fieldName), ['\u662f\u5426\u91cd\u70b9\u8bcd', '\u4f18\u5148\u7ea7']);
  assert.equal(plan.updates.every((item) => item.body.type === 20), true);

  const keyFormula = plan.updates[0].body.property.formula_expression;
  const priorityFormula = plan.updates[1].body.property.formula_expression;
  for (const id of ['fldSearch', 'fldClass', 'fldLabels', 'fldSearchHeat', 'fldContentHeat', 'fldTradeHeat', 'fldRecentTargets']) {
    assert.match(keyFormula, new RegExp(`\\$field\\[${id}\\]`));
  }
  for (const id of ['fldSearch', 'fldClass', 'fldLabels', 'fldSearchHeat', 'fldContentHeat', 'fldTradeHeat', 'fldHuitunViews']) {
    assert.match(priorityFormula, new RegExp(`\\$field\\[${id}\\]`));
  }
  assert.match(keyFormula, /\u5f85\u6570\u636e/);
  assert.match(keyFormula, />=2/);
  assert.match(keyFormula, /IF\(OR\([^)]*\u54c1\u724c\u8bcd/);
  assert.match(priorityFormula, /A-\u7acb\u5373\u8ddf\u8fdb/);
  assert.match(priorityFormula, /A\u5019\u9009/);
  assert.match(priorityFormula, /10000000/);
  assert.ok(priorityFormula.indexOf('"C-\u5e38\u89c4\u8ddf\u8e2a"') < priorityFormula.indexOf('"\u5f85\u6570\u636e"'));
  assert.match(priorityFormula, new RegExp(`\\$field\\[fldTradeHeat\\]="\\u9ad8"`));
  assert.match(priorityFormula, new RegExp(`ISBLANK\\(bitable::\\$table\\[${TABLE_ID}\\]\\.\\$field\\[fldContentHeat\\]\\)`));
  assert.match(priorityFormula, new RegExp(`ISBLANK\\(bitable::\\$table\\[${TABLE_ID}\\]\\.\\$field\\[fldHuitunViews\\]\\)`));
  assert.doesNotMatch(keyFormula, /fldBatches/);
  assert.doesNotMatch(priorityFormula, /fldIntent|fldRank|fldBatches|fldRecentTargets/);
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
    formulaFieldsUpdated: 2,
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
      candidate.fieldId === item.field_id && candidate.fieldName === '\u662f\u5426\u91cd\u70b9\u8bcd');
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
