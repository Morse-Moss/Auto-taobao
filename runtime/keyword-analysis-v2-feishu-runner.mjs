import { MAIN_CATEGORIES } from './keyword-analysis-v2-core.mjs';

const INTENTS = ['了解型', '对比型', '购买型', '灵感型', '问题解决型'];

export async function applyFieldPlan(api, plan) {
  for (const update of plan.updates) await api.updateField(update.fieldId, update.body);
  for (const create of plan.creates) await api.createField(create.body);
  return {
    updatedCount: plan.updates.length,
    createdCount: plan.creates.length,
  };
}

function requiredField(fields, name, type) {
  const field = fields.find((item) => item.field_name === name);
  if (!field) throw new Error(`Prepared test field missing: ${name}`);
  if (type != null && field.type !== type) {
    throw new Error(`Prepared test field ${name} expected type ${type}, received ${field.type}`);
  }
  return field;
}

function optionNames(field) {
  return (field.property?.options ?? []).map((option) => option.name);
}

export function verifyPreparedTestTable({ fields, recordCount }) {
  if (recordCount !== 0) throw new Error(`Test table must remain empty before the run; received ${recordCount} records`);
  requiredField(fields, '排名', 2);
  requiredField(fields, '标准归并词', 1);
  const classification = requiredField(fields, '关键词分类', 3);
  const fineLabels = requiredField(fields, '细分标签', 4);
  const intent = requiredField(fields, '用户意图', 3);
  requiredField(fields, '平台来源', 20);
  if (fields.some((field) => field.field_name === '来源渠道')) {
    throw new Error('Retired field name 来源渠道 is still present');
  }
  const categoryOptions = optionNames(classification);
  if (JSON.stringify(categoryOptions) !== JSON.stringify(MAIN_CATEGORIES)) {
    throw new Error(`Main category options differ: ${JSON.stringify(categoryOptions)}`);
  }
  const intentOptions = optionNames(intent);
  if (JSON.stringify(intentOptions) !== JSON.stringify(INTENTS)) {
    throw new Error(`Intent options differ: ${JSON.stringify(intentOptions)}`);
  }
  const invalidFineLabels = optionNames(fineLabels).filter((name) => !name.includes('/'));
  if (invalidFineLabels.length > 0) {
    throw new Error(`Invalid controlled label option: ${invalidFineLabels.join(', ')}`);
  }
  return {
    recordCount,
    fieldCount: fields.length,
    mainCategoryOptionCount: categoryOptions.length,
    intentOptionCount: intentOptions.length,
    controlledFineLabelOptionCount: optionNames(fineLabels).length,
    invalidFineLabelOptionCount: invalidFineLabels.length,
  };
}
