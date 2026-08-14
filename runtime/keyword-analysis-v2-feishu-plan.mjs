import {
  FINE_LABEL_DICTIONARY,
  MAIN_CATEGORIES,
  buildV2FormulaDefinitions,
} from './keyword-analysis-v2-core.mjs';

export const TEST_TABLE_ID = 'tblPBRZ6ErrlXHLG';

const INTENTS = ['了解型', '对比型', '购买型', '灵感型', '问题解决型'];
const CREATED_FIELD_NAMES = new Set();
const UPDATED_FIELD_NAMES = new Set([
  '排名', '标准归并词', '关键词分类', '细分标签', '用户意图', '平台来源',
]);

const options = (names) => ({ options: names.map((name) => ({ name })) });

function requiredField(fields, ...names) {
  const field = fields.find((item) => names.includes(item.field_name));
  if (!field) throw new Error(`Required test field missing: ${names.join(' or ')}`);
  return field;
}

export function buildTestTableFieldPlan(fields, { batchId }) {
  const search = requiredField(fields, '搜索词');
  const popularity = requiredField(fields, '搜索人气');
  const trade = requiredField(fields, '支付转化率');
  const formulaFields = buildV2FormulaDefinitions({
    tableId: TEST_TABLE_ID,
    fieldIds: {
      搜索词: search.field_id,
      搜索人气: popularity.field_id,
      支付转化率: trade.field_id,
    },
    batchId,
  });
  const fineLabels = Object.entries(FINE_LABEL_DICTIONARY)
    .flatMap(([dimension, values]) => values.map((value) => `${dimension}/${value}`));
  const source = requiredField(fields, '来源渠道', '平台来源');
  const updates = [
    {
      fieldId: requiredField(fields, '排名').field_id,
      fieldName: '排名',
      body: { field_name: '排名', type: 2 },
    },
    {
      fieldId: requiredField(fields, '标准归并词').field_id,
      fieldName: '标准归并词',
      body: { field_name: '标准归并词', type: 1 },
    },
    {
      fieldId: requiredField(fields, '关键词分类').field_id,
      fieldName: '关键词分类',
      body: { field_name: '关键词分类', type: 3, property: options(MAIN_CATEGORIES) },
    },
    {
      fieldId: requiredField(fields, '细分标签').field_id,
      fieldName: '细分标签',
      body: { field_name: '细分标签', type: 4, property: options(fineLabels) },
    },
    {
      fieldId: requiredField(fields, '用户意图').field_id,
      fieldName: '用户意图',
      body: { field_name: '用户意图', type: 3, property: options(INTENTS) },
    },
    {
      fieldId: source.field_id,
      fieldName: '平台来源',
      body: {
        field_name: '平台来源',
        type: 20,
        property: { formula_expression: formulaFields.平台来源 },
      },
    },
  ];

  return { updates, creates: [] };
}

export function assertTestTableMutation({ method, path, body }, {
  appToken,
  allowedExistingFieldIds,
}) {
  if (method === 'GET') return;
  const root = `/bitable/v1/apps/${appToken}/tables/${TEST_TABLE_ID}/fields`;
  if (method === 'PUT' && path.startsWith(`${root}/`)) {
    const fieldId = path.slice(root.length + 1);
    if (allowedExistingFieldIds.has(fieldId) && UPDATED_FIELD_NAMES.has(body?.field_name)) return;
  }
  if (method === 'POST' && path === root && CREATED_FIELD_NAMES.has(body?.field_name)) return;
  throw new Error(`Blocked non-test-field mutation: ${method} ${path}`);
}
