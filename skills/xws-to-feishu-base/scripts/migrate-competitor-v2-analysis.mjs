#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCompetitorMigrationMutation,
  buildCompetitorAIAnalysisPlan,
  buildCompetitorAISentinelPlan,
  buildCompetitorFieldMigrationPlan,
  classifyCompetitorValidity,
  classifyPriceBand,
  equivalentFeishuFieldValue,
  equivalentFeishuMoney,
  parseMonthlyReceived,
  parseCompetitorMigrationArgs,
  priceIsMissing,
  plainFeishuFormulaValue,
  pendingCompetitorAnalysisItems,
} from './competitor-v2-core.mjs';
import { CompetitorV2FeishuClient } from './import-competitor-v2.mjs';

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, index).trim()] = value;
  }
  return values;
}

function fieldName(field) {
  return field.field_name ?? field.fieldName;
}

function fieldId(field) {
  return field.field_id ?? field.fieldId;
}

const MUTABLE_FIELD_NAMES = new Set([
  '待补数据项', '月收货人数计算值', '计算口径', '月收货金额',
  '客单价带分类', '竞品分类', '数据状态', '是否有效竞品', '排除原因',
]);

export function assertCompetitorFieldContract({ before, after, mutableFieldNames = MUTABLE_FIELD_NAMES }) {
  if (before.length !== after.length) throw new Error('field count changed');
  const afterById = new Map(after.map((field) => [fieldId(field), field]));
  if (afterById.size !== after.length) throw new Error('duplicate field ids returned');
  for (const original of before) {
    const current = afterById.get(fieldId(original));
    if (!current) throw new Error(`field removed: ${fieldName(original)}`);
    if (fieldName(current) !== fieldName(original)) {
      throw new Error(`field identity changed: ${fieldName(original)}`);
    }
    if (mutableFieldNames.has(fieldName(original)) && current.type !== 20) {
      throw new Error(`mutable formula field changed to non-formula: ${fieldName(original)}`);
    }
    if (!mutableFieldNames.has(fieldName(original)) && current.type !== original.type) {
      throw new Error(`immutable field changed: ${fieldName(original)}`);
    }
  }
}

function recordId(record) {
  return record.record_id ?? record.recordId;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value ?? null;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function changedFormulaUpdates(fields, formulas) {
  return formulas.filter((update) => {
    const current = fields.find((field) => fieldId(field) === update.fieldId);
    return current?.type !== 20
      || current.property?.formula_expression !== update.body.property.formula_expression;
  });
}

function distribution(records, name, { formula = false } = {}) {
  const counts = new Map();
  for (const record of records) {
    const raw = record.fields?.[name];
    const value = formula ? plainFeishuFormulaValue(raw) : raw;
    const values = Array.isArray(value) ? value : [value || '<空>'];
    for (const item of values) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

function backupSnapshot(options, fields, records) {
  const directory = path.resolve(options.backupDir ?? 'runtime/competitor-v2-analysis-migration');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const file = path.join(directory, `before-${stamp}.json`);
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    appToken: options.appToken,
    tableId: options.tableId,
    fields,
    records,
  }, null, 2)}\n`;
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  return { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

function unaffectedRecords(records, ignored) {
  return records.map((record) => ({
    recordId: recordId(record),
    fields: Object.fromEntries(Object.entries(record.fields ?? {}).filter(([name]) => !ignored.has(name))),
  }));
}

function verifyAiSentinels(before, after, expectedUpdates) {
  if (before.length !== after.length) throw new Error('AI sentinel write changed record count');
  const expected = new Map(expectedUpdates.map((item) => [item.recordId, item.fields]));
  const beforeById = new Map(before.map((record) => [recordId(record), record.fields ?? {}]));
  for (const record of after) {
    const id = recordId(record);
    const beforeFields = beforeById.get(id);
    if (!beforeFields) throw new Error(`Record ${id} disappeared during AI sentinel write`);
    const updates = expected.get(id) ?? {};
    for (const name of ['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间']) {
      const beforeValue = beforeFields[name];
      const afterValue = record.fields?.[name];
      if (Object.prototype.hasOwnProperty.call(updates, name)) {
        if (!equivalentFeishuFieldValue(afterValue, updates[name])) {
          throw new Error(`Record ${id} AI sentinel differs in ${name}`);
        }
      } else if (!equivalentFeishuFieldValue(afterValue, beforeValue)) {
        throw new Error(`Record ${id} existing AI value changed in ${name}`);
      }
    }
  }
}

function verifyRecords(before, after, expectedUpdates) {
  const ignored = new Set([
    '是否有效竞品', '排除原因',
    '月收货人数计算值', '计算口径', '月收货金额', '客单价带分类',
    '竞品分类', '数据状态', '待补数据项',
    '材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间',
  ]);
  if (before.length !== after.length || !same(unaffectedRecords(before, ignored), unaffectedRecords(after, ignored))) {
    throw new Error('Migration changed unrelated record data');
  }
  const expected = new Map(expectedUpdates.map((item) => [item.recordId, item.fields]));
  for (const record of after) {
    const id = recordId(record);
    const fields = record.fields ?? {};
    for (const [name, value] of Object.entries(expected.get(id) ?? {})) {
      if (!equivalentFeishuFieldValue(fields[name], value)) throw new Error(`Record ${id} differs in ${name}`);
    }
    const expectedValidity = classifyCompetitorValidity(fields);
    const actualValidity = plainFeishuFormulaValue(fields.是否有效竞品);
    const actualReason = plainFeishuFormulaValue(fields.排除原因);
    if (actualValidity !== expectedValidity.validity) {
      throw new Error(`Record ${id} validity formula is unsettled`);
    }
    if (actualReason !== expectedValidity.reason) {
      throw new Error(`Record ${id} exclusion reason formula is unsettled`);
    }
    const isValid = actualValidity === '是';
    const parsedMonthly = parseMonthlyReceived(fields.月收货人数);
    const expectedCount = isValid ? parsedMonthly.value : null;
    const countText = plainFeishuFormulaValue(fields.月收货人数计算值);
    const actualCount = countText === '' ? null : Number(countText);
    if (!Object.is(expectedCount, actualCount)) throw new Error(`Record ${id} monthly count formula is unsettled`);
    const expectedBasis = isValid ? parsedMonthly.basis : '';
    if (plainFeishuFormulaValue(fields.计算口径) !== expectedBasis) {
      throw new Error(`Record ${id} count basis formula is unsettled`);
    }
    const missingPrice = priceIsMissing(fields.价格);
    const expectedBand = isValid && !missingPrice ? classifyPriceBand(fields.价格) : '';
    if (plainFeishuFormulaValue(fields.客单价带分类) !== expectedBand) {
      throw new Error(`Record ${id} price band formula is unsettled`);
    }
    const expectedAmount = expectedCount == null || missingPrice ? null : Number(fields.价格) * expectedCount;
    const amountText = plainFeishuFormulaValue(fields.月收货金额);
    const actualAmount = amountText === '' ? null : Number(amountText);
    if (!equivalentFeishuMoney(expectedAmount, actualAmount)) {
      throw new Error(`Record ${id} monthly amount formula is unsettled`);
    }
    const materials = (Array.isArray(fields.材质分类) ? fields.材质分类 : [fields.材质分类].filter(Boolean))
      .map((value) => plainFeishuFormulaValue(value));
    const hasHumanMadeStone = materials.some((value) => value.includes('人造石'));
    const expectedClass = !isValid || missingPrice
      ? '不适用'
      : expectedCount != null && expectedCount >= 80 && expectedAmount >= 200000 ? 'A'
        : hasHumanMadeStone && expectedCount != null && expectedCount >= 10 ? 'B'
          : Number(fields.价格) >= 8000 ? 'C'
            : Number(fields.价格) < 1000 ? 'D' : '无分类';
    const normalizedClass = plainFeishuFormulaValue(fields.竞品分类);
    const classPrefix = { A: 'A-高销量高GMV竞品', B: 'B-高价值竞品', C: 'C-中价位竞品', D: 'D-低价位竞品' }[expectedClass] ?? expectedClass;
    if (normalizedClass !== classPrefix) {
      throw new Error(`Record ${id} competitor class formula is unsettled`);
    }
    const pendingItems = pendingCompetitorAnalysisItems(fields, actualValidity);
    const pendingText = plainFeishuFormulaValue(fields.待补数据项);
    if (pendingText !== pendingItems.join('、')) {
      throw new Error(`Record ${id} pending items formula is unsettled`);
    }
    const expectedStatus = !isValid ? '' : pendingItems.length > 0 ? '部分待补' : '可用';
    if (plainFeishuFormulaValue(fields.数据状态) !== expectedStatus) {
      throw new Error(`Record ${id} data status formula is unsettled`);
    }
  }
}

async function waitForVerification(client, options, beforeFields, beforeRecords, expectedUpdates, plan) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [fields, records] = await Promise.all([
      client.listFields(options.tableId),
      client.listRecords(options.tableId),
    ]);
    try {
      assertCompetitorFieldContract({
        before: beforeFields,
        after: fields,
        mutableFieldNames: MUTABLE_FIELD_NAMES,
      });
      for (const update of plan.formulas) {
        const current = fields.find((field) => fieldId(field) === update.fieldId);
        if (current?.type !== 20 || current.property?.formula_expression !== update.body.property.formula_expression) {
          throw new Error(`${update.fieldName} formula is unsettled`);
        }
      }
      for (const update of plan.optionUpdates) {
        const current = fields.find((field) => fieldId(field) === update.fieldId);
        if (!same(
          (current?.property?.options ?? []).map((option) => option.name),
          update.body.property.options.map((option) => option.name),
        )) throw new Error(`${update.fieldName} options are unsettled`);
      }
      for (const name of ['是否有效竞品', '排除原因']) {
        if (!fields.some((field) => fieldName(field) === name)) throw new Error(`${name} is missing`);
      }
      verifyRecords(beforeRecords, records, expectedUpdates);
      return { fields, records };
    } catch (error) {
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Migration verification did not settle');
}

async function waitForFormulaVerification(client, options, beforeFields, beforeRecords, plan) {
  return waitForVerification(client, options, beforeFields, beforeRecords, [], plan);
}

async function main() {
  const options = parseCompetitorMigrationArgs(process.argv.slice(2));
  const envPath = path.resolve(options.envFile ?? 'E:/小红书/.env.local');
  const env = readEnv(envPath);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const client = new CompetitorV2FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
  });
  await client.authenticate();
  const tables = await client.listTables();
  const table = tables.find((item) => item.tableId === options.tableId);
  if (!table || table.name !== options.tableName) throw new Error(`Authorized table mismatch: ${options.tableId}`);
  const [beforeFields, beforeRecords] = await Promise.all([
    client.listFields(options.tableId),
    client.listRecords(options.tableId),
  ]);
  if (beforeRecords.length !== options.expectedRows) {
    throw new Error(`Expected ${options.expectedRows} records; received ${beforeRecords.length}`);
  }
  const plan = buildCompetitorFieldMigrationPlan({ tableId: options.tableId, fields: beforeFields });
  const formulaUpdates = changedFormulaUpdates(beforeFields, plan.formulas);
  const optionChange = plan.optionUpdates.length > 0 && plan.optionUpdates.some((update) => {
    const current = beforeFields.find((field) => fieldId(field) === update.fieldId);
    return current?.property?.options?.map((option) => option.name).join('|')
      !== update.body.property.options.map((option) => option.name).join('|');
  });
  const currentAiAnalysisUpdates = formulaUpdates.length === 0
    ? buildCompetitorAIAnalysisPlan({ records: beforeRecords, fields: beforeFields, searchKeyword: '浴缸' })
    : [];
  const summary = {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: table.name,
    recordCount: beforeRecords.length,
    fieldsToCreate: plan.creates.map((item) => item.fieldName),
    formulaFieldsToUpdate: formulaUpdates.map((item) => item.fieldName),
    optionFieldsToUpdate: optionChange ? plan.optionUpdates.map((item) => item.fieldName) : [],
    formulaRecordUpdates: 0,
    aiSentinelFields: [
      '材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间',
    ],
    aiAnalysisRecordsToUpdate: currentAiAnalysisUpdates.length,
    aiSentinelWriteDeferredUntilFormulaReadback: formulaUpdates.length > 0,
    competitorClassesBefore: distribution(beforeRecords, '竞品分类', { formula: true }),
    promptArtifact: path.resolve('skills/xws-to-feishu-base/scripts/competitor-v2-prompts.mjs'),
    aiRunTriggered: false,
  };
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backup = backupSnapshot(options, beforeFields, beforeRecords);
  const allowedFieldIds = new Set([
    ...plan.optionUpdates.map((item) => item.fieldId),
    ...plan.formulas.map((item) => item.fieldId),
  ]);
  const mutate = async (method, requestPath, body) => {
    assertCompetitorMigrationMutation({ method, path: requestPath, body }, {
      appToken: options.appToken,
      tableId: options.tableId,
      allowedFieldIds,
    });
    return client.request(method, requestPath, body);
  };
  const fieldRoot = `/bitable/v1/apps/${options.appToken}/tables/${options.tableId}/fields`;
  if (plan.creates.length > 0) throw new Error('Field creation is not allowed for an existing competitor table');

  if (optionChange) {
    for (const update of plan.optionUpdates) {
      await mutate('PUT', `${fieldRoot}/${update.fieldId}`, update.body);
    }
  }
  for (const update of formulaUpdates) await mutate('PUT', `${fieldRoot}/${update.fieldId}`, update.body);

  const { fields: afterFormulaFields, records: afterFormulaRecords } = await waitForFormulaVerification(
    client, options, beforeFields, beforeRecords, plan,
  );
  const aiAnalysisUpdates = buildCompetitorAIAnalysisPlan({
    records: afterFormulaRecords, fields: afterFormulaFields, searchKeyword: '浴缸',
  });
  for (const batch of chunks(aiAnalysisUpdates, 500)) {
    await mutate('POST', `/bitable/v1/apps/${options.appToken}/tables/${options.tableId}/records/batch_update`, {
      records: batch.map((item) => ({ record_id: item.recordId, fields: item.fields })),
    });
  }
  const { fields: afterFields, records: afterRecords } = await waitForFormulaVerification(
    client, options, beforeFields, beforeRecords, plan,
  );
  verifyAiSentinels(afterFormulaRecords, afterRecords, aiAnalysisUpdates);
  const receipt = {
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    backup,
    fieldCountBefore: beforeFields.length,
    fieldCountAfter: afterFields.length,
    competitorClassesAfter: distribution(afterRecords, '竞品分类', { formula: true }),
    validityAfter: distribution(afterRecords, '是否有效竞品', { formula: true }),
    exclusionReasonsAfter: distribution(afterRecords, '排除原因', { formula: true }),
    pendingAfter: distribution(afterRecords, '待补数据项', { formula: true }),
    aiAnalysisRecordsToUpdate: aiAnalysisUpdates.length,
  };
  if (options.receiptFile) {
    const file = path.resolve(options.receiptFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    receipt.receiptFile = file;
  }
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
