import { buildFormulaDefinitions } from './keyword-dual-table-core.mjs';

const FIELD_NAMES = [
  '\u641c\u7d22\u8bcd',
  '\u641c\u7d22\u4eba\u6c14',
  '\u652f\u4ed8\u8f6c\u5316\u7387',
  '\u5173\u952e\u8bcd\u5206\u7c7b',
  '\u7ec6\u5206\u6807\u7b7e',
  '\u641c\u7d22\u70ed\u5ea6',
  '\u5185\u5bb9\u70ed\u5ea6',
  '\u4ea4\u6613\u70ed\u5ea6',
  '\u4e0a\u4e00\u6709\u6548\u5468\u91cd\u70b9\u8fbe\u6807',
  '\u4e0a\u4e00\u6709\u6548\u5468A\u7ea7\u8fbe\u6807',
  '\u4e0a\u4e00\u6709\u6548\u5468\u63a2\u7d22\u8fbe\u6807',
  '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570',
  '\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570',
  '\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570',
  '\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf',
  '\u662f\u5426\u91cd\u70b9\u8bcd',
  '\u4f18\u5148\u7ea7',
  '\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411',
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
  const heatFormulas = buildFormulaDefinitions({
    tableId,
    fieldIds: {
      '\u641c\u7d22\u8bcd': ids['\u641c\u7d22\u8bcd'],
      '\u641c\u7d22\u4eba\u6c14': ids['\u641c\u7d22\u4eba\u6c14'],
      '\u652f\u4ed8\u8f6c\u5316\u7387': ids['\u652f\u4ed8\u8f6c\u5316\u7387'],
    },
  });
  const category = ref('\u5173\u952e\u8bcd\u5206\u7c7b');
  const labels = ref('\u7ec6\u5206\u6807\u7b7e');
  const searchHeat = ref('\u641c\u7d22\u70ed\u5ea6');
  const contentHeat = ref('\u5185\u5bb9\u70ed\u5ea6');
  const tradeHeat = ref('\u4ea4\u6613\u70ed\u5ea6');
  const previousTargets = ref('\u4e0a\u4e00\u6709\u6548\u5468\u91cd\u70b9\u8fbe\u6807');
  const previousA = ref('\u4e0a\u4e00\u6709\u6548\u5468A\u7ea7\u8fbe\u6807');
  const previousExplore = ref('\u4e0a\u4e00\u6709\u6548\u5468\u63a2\u7d22\u8fbe\u6807');
  const recentTargets = ref('\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570');
  const recentA = ref('\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570');
  const recentExplore = ref('\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570');
  const huitunViews = ref('\u7070\u8c5a\u8bdd\u9898\u6d4f\u89c8\u91cf');
  const priority = ref('\u4f18\u5148\u7ea7');

  const isExcluded = `${category}="\u54c1\u724c\u8bcd"`;
  const contentReady = `OR(${contentHeat}="\u4e2d",${contentHeat}="\u9ad8")`;
  const searchReady = `OR(${searchHeat}="\u4e2d",${searchHeat}="\u9ad8")`;
  const tradeReady = `OR(${tradeHeat}="\u4e2d",${tradeHeat}="\u9ad8")`;
  const missing = (fieldRef) => `OR(ISBLANK(${fieldRef}),${fieldRef}="",${fieldRef}="\u5f85\u6838\u9a8c")`;
  const missingCurrentKeyData = `OR(${missing(searchHeat)},${missing(tradeHeat)})`;
  const missingPriorityData = `OR(${missing(category)},AND(${category}="\u75db\u70b9\u8bcd",${missing(labels)}),${missing(searchHeat)},${missing(tradeHeat)})`;
  const huitunPending = missing(huitunViews);
  const isA = `AND(${huitunViews}>=10000000,${searchReady},${contentReady},${tradeHeat}="\u9ad8")`;
  const isACandidate = `AND(${searchReady},${contentReady},${tradeHeat}="\u9ad8",${huitunPending})`;
  const isB = `AND(${searchReady},${tradeReady})`;
  const serviceExcluded = `OR(${labels}.CONTAIN("\u75db\u70b9/\u6e05\u6d01"),${labels}.CONTAIN("\u75db\u70b9/\u6f0f\u6c34"),${labels}.CONTAIN("\u75db\u70b9/\u6392\u6c34"),${labels}.CONTAIN("\u75db\u70b9/\u7ef4\u4fee"))`;
  const currentTarget = `IF(${missing(category)},"",IF(OR(${isExcluded},${serviceExcluded}),0,IF(AND(${category}="\u75db\u70b9\u8bcd",${missing(labels)}),"",IF(${missingCurrentKeyData},"",IF(AND(${searchHeat}="\u9ad8",${tradeReady}),1,0)))))`;
  const priorityResolvedNotA = `OR(${priority}="B-\u6301\u7eed\u89c2\u5bdf",${priority}="C-\u5e38\u89c4\u8ddf\u8e2a")`;
  const currentA = `IF(OR(${missing(priority)},${priority}="\u5f85\u6570\u636e",${priority}="A\u5019\u9009"),"",IF(${priority}="A-\u7acb\u5373\u8ddf\u8fdb",1,IF(${priorityResolvedNotA},0,"")))`;
  const currentExplore = `IF(OR(${missing(searchHeat)},${missing(contentHeat)}),"",IF(AND(${searchReady},${contentReady}),1,0))`;
  const combine = (previous, current) => `IF(OR(${missing(previous)},(${current})=""),"",${previous}+(${current}))`;

  return {
    '\u641c\u7d22\u70ed\u5ea6': heatFormulas['\u641c\u7d22\u70ed\u5ea6'],
    '\u4ea4\u6613\u70ed\u5ea6': heatFormulas['\u4ea4\u6613\u70ed\u5ea6'],
    '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570': combine(previousTargets, currentTarget),
    '\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570': combine(previousA, currentA),
    '\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570': combine(previousExplore, currentExplore),
    '\u662f\u5426\u91cd\u70b9\u8bcd': `IF(ISBLANK(${search}),"",IF(${isExcluded},"\u5426",IF(${missingCurrentKeyData},"\u5f85\u6570\u636e",IF(AND(${searchHeat}="\u9ad8",${tradeReady}),IF(${missing(recentTargets)},"\u5f85\u6570\u636e",IF(${recentTargets}>=2,"\u662f","\u5426")),"\u5426"))))`,
    '\u4f18\u5148\u7ea7': `IF(ISBLANK(${search}),"",IF(${isExcluded},"C-\u5e38\u89c4\u8ddf\u8e2a",IF(${missingPriorityData},"\u5f85\u6570\u636e",IF(${isA},"A-\u7acb\u5373\u8ddf\u8fdb",IF(${isACandidate},"A\u5019\u9009",IF(${isB},"B-\u6301\u7eed\u89c2\u5bdf","C-\u5e38\u89c4\u8ddf\u8e2a"))))))`,
    '\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411': `IF(ISBLANK(${search}),"",IF(${recentTargets}>=2,"\u4e3b\u63a8\u65b9\u5411\uff08\u5df2\u6709\u4f18\u52bf\u653e\u5927\uff09",IF(${recentA}>=2,"\u589e\u957f\u65b9\u5411\uff08\u672a\u6765\u65b0\u54c1\uff09",IF(${recentExplore}>=2,"\u63a2\u7d22\u65b9\u5411\uff08\u9a8c\u8bc1\u5e02\u573a\uff09","\u6682\u65e0"))))`,
  };
}

export function buildDecisionFormulaPlan({ tableId, fields }) {
  const formulas = formulaDefinitions(tableId, fields);
  return {
    updates: [
      '\u641c\u7d22\u70ed\u5ea6', '\u4ea4\u6613\u70ed\u5ea6',
      '\u8fd12\u5468\u91cd\u70b9\u8fbe\u6807\u6b21\u6570', '\u8fd12\u5468A\u7ea7\u8fbe\u6807\u6b21\u6570',
      '\u8fd12\u5468\u63a2\u7d22\u8fbe\u6807\u6b21\u6570', '\u662f\u5426\u91cd\u70b9\u8bcd',
      '\u4f18\u5148\u7ea7', '\u5bf9\u5e94\u4ea7\u54c1\u65b9\u5411',
    ].map((fieldName) => {
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

export function buildSearchHeatFormulaPlan({ tableId, fields }) {
  const ids = Object.fromEntries(['\u641c\u7d22\u8bcd', '\u641c\u7d22\u4eba\u6c14', '\u652f\u4ed8\u8f6c\u5316\u7387']
    .map((name) => [name, requiredField(fields, name).field_id]));
  const formulas = buildFormulaDefinitions({ tableId, fieldIds: ids });
  const field = requiredField(fields, '\u641c\u7d22\u70ed\u5ea6');
  return {
    updates: [{
      fieldId: field.field_id,
      fieldName: '\u641c\u7d22\u70ed\u5ea6',
      body: {
        field_name: '\u641c\u7d22\u70ed\u5ea6',
        type: 20,
        property: { formula_expression: formulas['\u641c\u7d22\u70ed\u5ea6'] },
      },
    }],
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
