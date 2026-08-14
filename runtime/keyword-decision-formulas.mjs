const FIELD_NAMES = [
  '\u641c\u7d22\u8bcd',
  '\u5173\u952e\u8bcd\u5206\u7c7b',
  '\u7ec6\u5206\u6807\u7b7e',
  '\u641c\u7d22\u70ed\u5ea6',
  '\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09',
  '\u4ea4\u6613\u70ed\u5ea6',
  '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570',
  '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf',
  '\u662f\u5426\u91cd\u70b9\u8bcd',
  '\u4f18\u5148\u7ea7',
];

const EXCLUDED_SERVICE_LABELS = [
  '\u75db\u70b9/\u6e05\u6d01',
  '\u75db\u70b9/\u6f0f\u6c34',
  '\u75db\u70b9/\u6392\u6c34',
  '\u75db\u70b9/\u7ef4\u4fee',
];

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

export function selectHuitunCandidates(records) {
  return records.filter((record) => plain(record.fields?.['\u4f18\u5148\u7ea7']) === 'A\u5019\u9009');
}

function requiredField(fields, name) {
  const matches = fields.filter((field) => field.field_name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  return matches[0];
}

function fieldReference(tableId, fieldId) {
  return `bitable::$table[${tableId}].$field[${fieldId}]`;
}

export function normalizeFormulaExpression(expression) {
  return String(expression ?? '').replace(/bitable::\$table\[[^\]]+\]\.\$field\[[^\]]+\]/gu, 'FIELD');
}

function formulaDefinitions(tableId, fields) {
  const ids = Object.fromEntries(FIELD_NAMES.map((name) => [name, requiredField(fields, name).field_id]));
  const ref = (name) => fieldReference(tableId, ids[name]);
  const search = ref('\u641c\u7d22\u8bcd');
  const category = ref('\u5173\u952e\u8bcd\u5206\u7c7b');
  const labels = ref('\u7ec6\u5206\u6807\u7b7e');
  const searchHeat = ref('\u641c\u7d22\u70ed\u5ea6');
  const contentHeat = ref('\u5185\u5bb9\u70ed\u5ea6\uff08\u540e\u7eed\uff09');
  const tradeHeat = ref('\u4ea4\u6613\u70ed\u5ea6');
  const recentTargets = ref('\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570');
  const huitunViews = ref('\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf');

  // Label checks stringify the multi-select value so the formula stays valid for empty labels.
  const excludedLabelChecks = EXCLUDED_SERVICE_LABELS
    .map((label) => `IFERROR(FIND("${label}",${labels}&""),0)>0`)
    .join(',');
  const isExcluded = `OR(${category}="\u54c1\u724c\u8bcd",${excludedLabelChecks})`;
  const contentReady = `OR(${contentHeat}="\u4e2d",${contentHeat}="\u9ad8")`;
  const searchReady = `OR(${searchHeat}="\u4e2d",${searchHeat}="\u9ad8")`;
  const tradeReady = `OR(${tradeHeat}="\u4e2d",${tradeHeat}="\u9ad8")`;
  const missingKeyData = `OR(ISBLANK(${searchHeat}),ISBLANK(${contentHeat}),ISBLANK(${tradeHeat}),ISBLANK(${recentTargets}))`;
  const huitunPending = `OR(ISBLANK(${contentHeat}),ISBLANK(${huitunViews}))`;
  const isA = `AND(${huitunViews}>=10000000,${searchReady},${contentReady},${tradeHeat}="\u9ad8")`;
  const isACandidate = `AND(${searchReady},${tradeHeat}="\u9ad8",${huitunPending})`;
  const isB = `AND(${searchReady},${tradeReady})`;

  return {
    '\u662f\u5426\u91cd\u70b9\u8bcd': `IF(ISBLANK(${search}),"",IF(${isExcluded},"\u5426",IF(${missingKeyData},"\u5f85\u6570\u636e",IF(AND(${searchHeat}="\u9ad8",${contentReady},${tradeReady},${recentTargets}>=2),"\u662f","\u5426"))))`,
    '\u4f18\u5148\u7ea7': `IF(ISBLANK(${search}),"",IF(${isExcluded},"C-\u5e38\u89c4\u8ddf\u8e2a",IF(OR(ISBLANK(${searchHeat}),ISBLANK(${tradeHeat})),"\u5f85\u6570\u636e",IF(${isA},"A-\u7acb\u5373\u8ddf\u8fdb",IF(${isACandidate},"A\u5019\u9009",IF(${isB},"B-\u6301\u7eed\u89c2\u5bdf","C-\u5e38\u89c4\u8ddf\u8e2a"))))))`,
  };
}

export function buildDecisionFormulaPlan({ tableId, fields }) {
  const formulas = formulaDefinitions(tableId, fields);
  return {
    updates: ['\u662f\u5426\u91cd\u70b9\u8bcd', '\u4f18\u5148\u7ea7'].map((fieldName) => {
      const field = requiredField(fields, fieldName);
      return {
        fieldId: field.field_id,
        fieldName,
        body: {
          field_name: fieldName,
          type: 20,
          property: { formula_expression: formulas[fieldName] },
        },
      };
    }),
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedFormulaField(field) {
  return {
    field_id: field.field_id,
    field_name: field.field_name,
    type: field.type,
    property: {
      formula_expression: field.property?.formula_expression,
    },
  };
}

export function filterChangedFormulaPlan({ fields, plan }) {
  return {
    updates: plan.updates.filter((update) => {
      const current = requiredField(fields, update.fieldName);
      const expected = {
        field_id: current.field_id,
        field_name: update.body.field_name,
        type: update.body.type,
        property: { formula_expression: update.body.property.formula_expression },
      };
      return !same(normalizedFormulaField(current), expected);
    }),
  };
}

export function verifyDecisionFormulaFields({ tableId, before, after, plan }) {
  if (before.length !== after.length) throw new Error('Formula migration changed the field count');
  const updates = new Map(plan.updates.map((item) => [item.fieldId, item]));
  let formulaFieldsUpdated = 0;
  let unexpectedFieldChanges = 0;
  for (const beforeField of before) {
    const afterField = after.find((field) => field.field_id === beforeField.field_id);
    if (!afterField) throw new Error(`Formula migration removed field ${beforeField.field_name}`);
    const update = updates.get(beforeField.field_id);
    if (!update) {
      if (!same(beforeField, afterField)) unexpectedFieldChanges += 1;
      continue;
    }
    const expected = {
      field_id: beforeField.field_id,
      field_name: update.body.field_name,
      type: update.body.type,
      property: { formula_expression: update.body.property.formula_expression },
    };
    if (!same(expected, normalizedFormulaField(afterField))) {
      throw new Error(`Formula field ${update.fieldName} does not match the approved expression`);
    }
    if (!afterField.property?.formula_expression?.includes(`$table[${tableId}]`)) {
      throw new Error(`Formula field ${update.fieldName} does not reference the authorized table`);
    }
    formulaFieldsUpdated += 1;
  }
  if (formulaFieldsUpdated !== plan.updates.length || unexpectedFieldChanges !== 0) {
    throw new Error('Formula migration verification failed');
  }
  return { formulaFieldsUpdated, unexpectedFieldChanges };
}
