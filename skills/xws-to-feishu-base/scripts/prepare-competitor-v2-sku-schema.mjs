#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBaseUrl } from './import-core.mjs';
import {
  SKU_BACKLINK_FIELD_NAME,
  SKU_DETAIL_FIELDS,
  SKU_RELATION_FIELD_NAME,
  SKU_APPLICABLE_SPACES,
  assertSkuSchemaMutation,
  buildSkuSchemaMigrationPlan,
} from './competitor-v2-core.mjs';
import { CompetitorV2FeishuClient } from './import-competitor-v2.mjs';

const BIDIRECTIONAL_LINK = 21;
const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_RECEIPT_DIRECTORY = 'runtime/competitor-v2-sku-schema-migration';

function positiveInteger(value, option) {
  if (!/^\d+$/u.test(String(value)) || Number(value) < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return Number(value);
}

function zero(value, option) {
  if (String(value) !== '0') throw new Error(`${option} must be zero for the empty SKU明细 migration`);
  return 0;
}

export function parseSkuSchemaArgs(argv) {
  const options = {
    apply: false,
  };
  const valueOptions = new Set([
    '--base-url', '--sku-table-id', '--expected-main-rows', '--expected-sku-rows',
    '--env-file', '--confirm-app-token', '--confirm-main-table-id', '--confirm-sku-table-id',
    '--receipt-file',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (argument === '--expected-main-rows') options[key] = positiveInteger(value, argument);
    else if (argument === '--expected-sku-rows') options[key] = zero(value, argument);
    else options[key] = value;
    index += 1;
  }

  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!options.skuTableId) throw new Error('--sku-table-id is required');
  if (options.expectedMainRows == null) throw new Error('--expected-main-rows is required');
  if (options.expectedSkuRows == null) throw new Error('--expected-sku-rows is required');
  const target = parseBaseUrl(options.baseUrl);
  options.appToken = target.appToken;
  options.mainTableId = target.tableId;

  if (options.apply) {
    for (const option of [
      '--env-file', '--confirm-app-token', '--confirm-main-table-id', '--confirm-sku-table-id',
    ]) {
      const key = option.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      if (!options[key]) throw new Error(`${option} is required with --apply`);
    }
    if (options.confirmAppToken !== options.appToken) throw new Error('--confirm-app-token mismatch');
    if (options.confirmMainTableId !== options.mainTableId) throw new Error('--confirm-main-table-id mismatch');
    if (options.confirmSkuTableId !== options.skuTableId) throw new Error('--confirm-sku-table-id mismatch');
  }

  return options;
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function fieldName(field) {
  return field.field_name ?? field.fieldName;
}

function fieldId(field) {
  return field.field_id ?? field.fieldId;
}

function findOne(fields, name, tableName) {
  const matches = fields.filter((field) => fieldName(field) === name);
  if (matches.length !== 1) {
    throw new Error(`${tableName} must contain exactly one ${name}; received ${matches.length}`);
  }
  return matches[0];
}

function optionNames(field) {
  return (field.property?.options ?? []).map((option) => option.name);
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value ?? null;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function schemaFieldSignature(field) {
  return {
    fieldId: fieldId(field),
    fieldName: fieldName(field),
    type: Number(field.type),
    property: field.property ?? null,
  };
}

function fingerprintRecords(records, ignoredFieldNames = new Set()) {
  const stable = records.map((record) => ({
    recordId: record.record_id ?? record.recordId,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name]) => !ignoredFieldNames.has(name))),
  })).sort((left, right) => left.recordId.localeCompare(right.recordId));
  return crypto.createHash('sha256').update(JSON.stringify(canonical(stable))).digest('hex');
}

export function relationValueHasLinkedRecords(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => {
    if (item == null || item === '') return false;
    if (typeof item !== 'object') return true;
    const ids = item.record_ids ?? item.recordIds;
    if (Array.isArray(ids)) return ids.length > 0;
    if (typeof ids === 'string') return ids.trim() !== '';
    return false;
  });
}

function assertSkuDetailContract(skuFields, mainTableId) {
  for (const definition of SKU_DETAIL_FIELDS) {
    const actual = findOne(skuFields, definition.name, 'SKU明细');
    if (Number(actual.type) !== definition.type) {
      throw new Error(`SKU明细 ${definition.name} type differs from the approved contract`);
    }
    const expectedOptions = definition.property?.options?.map((option) => option.name);
    if (expectedOptions && optionNames(actual).join('|') !== expectedOptions.join('|')) {
      throw new Error(`SKU明细 ${definition.name} options differ from the approved contract`);
    }
  }

  const space = findOne(skuFields, '适用空间', 'SKU明细');
  if (!same(optionNames(space), SKU_APPLICABLE_SPACES) || optionNames(space).includes('大户型')) {
    throw new Error('SKU明细 适用空间 must contain only 小户型 and 常规卫生间');
  }
  const relation = findOne(skuFields, SKU_RELATION_FIELD_NAME, 'SKU明细');
  const property = relation.property ?? {};
  if (Number(relation.type) !== BIDIRECTIONAL_LINK
    || property.table_id !== mainTableId
    || property.multiple !== false
    || property.back_field_name !== SKU_BACKLINK_FIELD_NAME) {
    throw new Error('SKU明细 所属竞品 relation differs from the approved contract');
  }
}

function assertMainBacklink(mainFields, skuTableId) {
  const backlink = findOne(mainFields, SKU_BACKLINK_FIELD_NAME, '竞品主表');
  if (Number(backlink.type) !== BIDIRECTIONAL_LINK || backlink.property?.table_id !== skuTableId) {
    throw new Error('竞品主表 SKU采集明细 backlink differs from the approved contract');
  }
}

function assertMainTablePreserved({ beforeFields, afterFields, beforeRecords, afterRecords, skuTableId }) {
  const beforeWithoutBacklink = beforeFields.filter((field) => fieldName(field) !== SKU_BACKLINK_FIELD_NAME);
  const afterWithoutBacklink = afterFields.filter((field) => fieldName(field) !== SKU_BACKLINK_FIELD_NAME);
  if (!same(beforeWithoutBacklink.map(schemaFieldSignature), afterWithoutBacklink.map(schemaFieldSignature))) {
    throw new Error('SKU schema migration changed an existing 竞品主表 field');
  }
  const beforeBacklinks = beforeFields.filter((field) => fieldName(field) === SKU_BACKLINK_FIELD_NAME);
  const afterBacklinks = afterFields.filter((field) => fieldName(field) === SKU_BACKLINK_FIELD_NAME);
  if (beforeBacklinks.length > 1 || afterBacklinks.length !== 1) {
    throw new Error('竞品主表 SKU采集明细 backlink count is invalid');
  }
  assertMainBacklink(afterFields, skuTableId);

  const ignored = new Set([SKU_BACKLINK_FIELD_NAME]);
  if (fingerprintRecords(beforeRecords, ignored) !== fingerprintRecords(afterRecords, ignored)) {
    throw new Error('SKU schema migration changed an existing 竞品主表 record value');
  }
  if (afterRecords.some((record) => relationValueHasLinkedRecords(record.fields?.[SKU_BACKLINK_FIELD_NAME]))) {
    throw new Error('SKU schema migration created an unexpected main-table relation value');
  }
}

function assertSkuTablePreserved({ beforeFields, afterFields, operations }) {
  const expectedAddedNames = new Set(operations
    .filter((operation) => operation.method === 'POST')
    .map((operation) => operation.fieldName));
  const expectedNames = new Set([
    ...beforeFields.map(fieldName),
    ...expectedAddedNames,
  ]);
  const actualNames = new Set(afterFields.map(fieldName));
  if (!same([...actualNames].sort(), [...expectedNames].sort())) {
    throw new Error('SKU schema migration created or removed an unexpected SKU明细 field');
  }

  const mutableNames = new Set(operations.map((operation) => operation.fieldName));
  const beforeUnchanged = beforeFields
    .filter((field) => !mutableNames.has(fieldName(field)))
    .map(schemaFieldSignature);
  const afterUnchanged = afterFields
    .filter((field) => !mutableNames.has(fieldName(field)))
    .map(schemaFieldSignature);
  if (!same(beforeUnchanged, afterUnchanged)) {
    throw new Error('SKU schema migration changed an unrelated SKU明细 field');
  }
}

async function readLiveState(client, options) {
  const [tables, mainFields, skuFields, mainRecords, skuRecords] = await Promise.all([
    client.listTables(),
    client.listFields(options.mainTableId),
    client.listFields(options.skuTableId),
    client.listRecords(options.mainTableId),
    client.listRecords(options.skuTableId),
  ]);
  const mainTable = tables.find((table) => table.tableId === options.mainTableId);
  const skuTable = tables.find((table) => table.tableId === options.skuTableId);
  if (!mainTable || mainTable.name !== '竞品主表') {
    throw new Error(`Authorized main table mismatch: ${options.mainTableId}`);
  }
  if (!skuTable || skuTable.name !== 'SKU明细') {
    throw new Error(`Authorized SKU table mismatch: ${options.skuTableId}`);
  }
  return { tables, mainTable, skuTable, mainFields, skuFields, mainRecords, skuRecords };
}

function buildLivePlan(options, state) {
  return buildSkuSchemaMigrationPlan({
    appToken: options.appToken,
    mainTableId: options.mainTableId,
    skuTableId: options.skuTableId,
    expectedMainRows: options.expectedMainRows,
    mainRecordCount: state.mainRecords.length,
    skuRecordCount: state.skuRecords.length,
    mainFields: state.mainFields,
    skuFields: state.skuFields,
  });
}

function operationSummary(operation) {
  return { method: operation.method, fieldName: operation.fieldName };
}

function createReceiptFile(options, receipt) {
  const directory = path.resolve(DEFAULT_RECEIPT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const file = options.receiptFile
    ? path.resolve(options.receiptFile)
    : path.join(directory, `receipt-${new Date().toISOString().replace(/[-:.]/gu, '')}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return file;
}

function readCredentials(options) {
  const file = path.resolve(options.envFile ?? DEFAULT_ENV_FILE);
  if (!fs.existsSync(file)) throw new Error(`Environment file not found: ${file}`);
  const env = readEnv(file);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  }
  return env;
}

async function waitForSchema(client, options, before, plan) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await readLiveState(client, options);
    try {
      if (after.mainRecords.length !== options.expectedMainRows) {
        throw new Error(`Expected ${options.expectedMainRows} main records after apply; received ${after.mainRecords.length}`);
      }
      if (after.skuRecords.length !== options.expectedSkuRows) {
        throw new Error(`Expected ${options.expectedSkuRows} SKU records after apply; received ${after.skuRecords.length}`);
      }
      assertSkuDetailContract(after.skuFields, options.mainTableId);
      assertMainTablePreserved({
        beforeFields: before.mainFields,
        afterFields: after.mainFields,
        beforeRecords: before.mainRecords,
        afterRecords: after.mainRecords,
        skuTableId: options.skuTableId,
      });
      assertSkuTablePreserved({
        beforeFields: before.skuFields,
        afterFields: after.skuFields,
        operations: plan.operations,
      });
      const rerun = buildLivePlan(options, after);
      if (rerun.operations.length !== 0) {
        throw new Error(`Second SKU schema dry-run still plans ${rerun.operations.length} operation(s)`);
      }
      return after;
    } catch (error) {
      lastError = error;
      if (attempt === 19) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError ?? new Error('SKU schema verification did not settle');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSkuSchemaArgs(argv);
  const credentials = readCredentials(options);
  const client = new CompetitorV2FeishuClient({
    appId: credentials.FEISHU_APP_ID,
    appSecret: credentials.FEISHU_APP_SECRET,
    appToken: options.appToken,
  });
  await client.authenticate();

  const before = await readLiveState(client, options);
  const plan = buildLivePlan(options, before);
  const summary = {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
    appToken: options.appToken,
    mainTable: { id: options.mainTableId, name: before.mainTable.name, records: before.mainRecords.length },
    skuTable: { id: options.skuTableId, name: before.skuTable.name, records: before.skuRecords.length },
    operations: plan.operations.map(operationSummary),
    recordWrites: 0,
    aiRunTriggered: false,
  };
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const fieldRoot = `/bitable/v1/apps/${options.appToken}/tables/${options.skuTableId}/fields`;
  const mutate = async (operation) => {
    const requestPath = operation.method === 'POST'
      ? fieldRoot
      : `${fieldRoot}/${operation.fieldId}`;
    assertSkuSchemaMutation({ method: operation.method, path: requestPath, body: operation.body }, {
      appToken: options.appToken,
      skuTableId: options.skuTableId,
      operations: plan.operations,
    });
    return client.request(operation.method, requestPath, operation.body);
  };
  for (const operation of plan.operations) await mutate(operation);

  const after = await waitForSchema(client, options, before, plan);
  const receipt = {
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    mainRecordFingerprint: fingerprintRecords(before.mainRecords, new Set([SKU_BACKLINK_FIELD_NAME])),
    mainRecordFingerprintAfter: fingerprintRecords(after.mainRecords, new Set([SKU_BACKLINK_FIELD_NAME])),
    fieldCount: {
      mainBefore: before.mainFields.length,
      mainAfter: after.mainFields.length,
      skuBefore: before.skuFields.length,
      skuAfter: after.skuFields.length,
    },
    secondDryRunOperations: 0,
  };
  receipt.receiptFile = createReceiptFile(options, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
