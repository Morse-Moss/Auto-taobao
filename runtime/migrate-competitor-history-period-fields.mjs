#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_OUTPUT_DIR = 'runtime/competitor-history-migration-runs';
const HISTORY_TABLE_NAME = '竞品历史总表 V1';
const TEXT = 1;
const DATE = 5;
const PERIOD_FIELDS = ['周期开始日期', '周期结束日期'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? '');
  return String(value ?? '').trim();
}

function periodText(value) {
  const source = text(value);
  if (!source || /^\d{4}-\d{2}-\d{2}$/u.test(source)) return source;
  const timestamp = Number(source);
  if (!Number.isFinite(timestamp)) return source;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

export function periodTimestamp(value, name) {
  const source = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(source)) throw new Error(`${name} must use YYYY-MM-DD`);
  const timestamp = Date.parse(`${source}T00:00:00+08:00`);
  const normalized = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
  if (normalized !== source) throw new Error(`${name} is invalid`);
  return timestamp;
}

export function migrationValues(period) {
  const start = periodTimestamp(period?.startDate, 'period.startDate');
  const end = periodTimestamp(period?.endDate, 'period.endDate');
  if (end < start) throw new Error('History period must use YYYY-MM-DD');
  return { start, end };
}

export function buildMigrationPlan({ fields, records, period, expectedRows }) {
  const values = migrationValues(period);
  if (expectedRows !== undefined && (!Number.isSafeInteger(expectedRows) || expectedRows < 1)) {
    throw new Error('expectedRows must be a positive safe integer');
  }
  if (Number.isSafeInteger(expectedRows) && records.length !== expectedRows) {
    throw new Error(`History row count mismatch: expected ${expectedRows}, got ${records.length}`);
  }
  const byName = new Map(fields.map((field) => [field.fieldName ?? field.field_name, field]));
  const targets = PERIOD_FIELDS.map((name) => {
    const field = byName.get(name);
    if (!field) throw new Error(`Missing history field: ${name}`);
    return { name, fieldId: field.fieldId ?? field.field_id, currentType: Number(field.type), targetType: DATE };
  });
  const mismatchedTypes = targets.filter((field) => field.currentType !== TEXT && field.currentType !== DATE);
  if (mismatchedTypes.length) throw new Error(`History period field type mismatch: ${mismatchedTypes.map((field) => field.name).join(', ')}`);
  const updates = [];
  for (const record of records) {
    const start = periodText(record.fields?.['周期开始日期']);
    const end = periodText(record.fields?.['周期结束日期']);
    if (start && start !== period.startDate) throw new Error(`History start period mismatch in ${record.recordId ?? record.record_id ?? '<unknown>'}`);
    if (end && end !== period.endDate) throw new Error(`History end period mismatch in ${record.recordId ?? record.record_id ?? '<unknown>'}`);
    const fieldsToUpdate = {};
    if (Number(record.fields?.['周期开始日期']) !== values.start) fieldsToUpdate['周期开始日期'] = values.start;
    if (Number(record.fields?.['周期结束日期']) !== values.end) fieldsToUpdate['周期结束日期'] = values.end;
    if (Object.keys(fieldsToUpdate).length) updates.push({ record_id: record.recordId ?? record.record_id, fields: fieldsToUpdate });
  }
  const businessRecords = records.map((record) => ({
    recordId: record.recordId ?? record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {}).filter(([name]) => !PERIOD_FIELDS.includes(name))),
  }));
  return {
    period: { ...period },
    values,
    fields: targets,
    fieldTypeUpdates: targets.filter((field) => field.currentType !== DATE),
    recordUpdates: updates,
    before: { recordCount: records.length, fieldsHash: hash(fields), businessHash: hash(businessRecords) },
  };
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

function parseArgs(argv) {
  const options = { apply: false, envFile: DEFAULT_ENV_FILE, outputDir: DEFAULT_OUTPUT_DIR, expectedRows: undefined };
  const valueOptions = new Map([
    ['--base-url', 'baseUrl'], ['--history-table-id', 'historyTableId'], ['--period-start', 'periodStart'],
    ['--period-end', 'periodEnd'], ['--expected-rows', 'expectedRows'], ['--env-file', 'envFile'],
    ['--output-dir', 'outputDir'], ['--confirm-app-token', 'confirmAppToken'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[valueOptions.get(arg)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!options.historyTableId) throw new Error('--history-table-id is required');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options.periodStart ?? ''))) throw new Error('--period-start must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options.periodEnd ?? ''))) throw new Error('--period-end must be YYYY-MM-DD');
  if (!/^\d+$/u.test(String(options.expectedRows ?? ''))) throw new Error('--expected-rows is required');
  options.appToken = new URL(options.baseUrl).pathname.match(/^\/base\/([^/]+)/u)?.[1];
  if (!options.appToken) throw new Error('--base-url must be a Feishu /base/ URL');
  if (options.apply && options.confirmAppToken !== options.appToken) throw new Error('--apply requires matching --confirm-app-token');
  return { ...options, expectedRows: Number(options.expectedRows), period: { startDate: options.periodStart, endDate: options.periodEnd } };
}

async function writeReceipt(options, receipt) {
  const outputDir = resolve(options.outputDir, `${options.period.startDate}_${options.period.endDate}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'migration-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function writePartialReceipt(options, base, failure, completed) {
  await writeReceipt(options, {
    ...base,
    mode: 'PARTIALLY_APPLIED',
    failure: { stage: failure.stage, message: failure.error?.message || String(failure.error) },
    completed,
  });
}

async function writeExclusiveJson(file, value) {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function snapshotRecords(records) {
  return records.map((record) => ({ recordId: record.recordId ?? record.record_id, fields: record.fields ?? {} }));
}

function expectedFieldsAfterMigration(fields) {
  return fields.map((field) => PERIOD_FIELDS.includes(field.fieldName ?? field.field_name)
    ? { ...field, type: DATE }
    : field);
}

function assertBatchResponse(result, expectedRecords) {
  const actual = Array.isArray(result) ? result : [];
  const expectedIds = expectedRecords.map((record) => record.record_id).sort();
  const actualIds = actual.map((recordId) => String(recordId)).sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((recordId, index) => recordId !== expectedIds[index])) {
    throw new Error(`History batch response record IDs do not match requested records: expected ${expectedIds.join(',')}, got ${actualIds.join(',')}`);
  }
}

export async function runMigration({ client, options }) {
  await client.authenticate();
  const tables = await client.listTables();
  const table = tables.find((item) => item.tableId === options.historyTableId && item.name === HISTORY_TABLE_NAME);
  if (!table) throw new Error('Confirmed history table ID/name pair not found');
  const [fields, listedRecords] = await Promise.all([client.listFields(table.tableId), client.listRecords(table.tableId)]);
  const records = snapshotRecords(listedRecords);
  const plan = buildMigrationPlan({ fields, records, period: options.period, expectedRows: options.expectedRows });
  const backup = { table: { tableId: table.tableId, name: table.name }, period: options.period, fields, records, sha256: hash({ fields, records }) };
  const base = {
    operation: 'competitor_history_period_field_migration',
    table: { tableId: table.tableId, name: table.name },
    period: options.period,
    rows: { before: records.length, expected: options.expectedRows, updates: plan.recordUpdates.length },
    fields: plan.fields,
    fieldTypeUpdates: plan.fieldTypeUpdates,
    targetValues: plan.values,
    before: plan.before,
    backupSha256: backup.sha256,
    feishuWrites: 0,
  };
  if (!options.apply) {
    await writeReceipt(options, { ...base, mode: 'DRY_RUN_READY' });
    return { ...base, mode: 'DRY_RUN_READY' };
  }
  const outputDir = resolve(options.outputDir, `${options.period.startDate}_${options.period.endDate}`);
  await mkdir(outputDir, { recursive: true });
  const backupPath = resolve(outputDir, 'migration-backup.json');
  try {
    await writeExclusiveJson(backupPath, backup);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Migration backup already exists; use a new output directory: ${backupPath}`);
    throw error;
  }
  const baseWithBackup = { ...base, backup: { path: backupPath, sha256: backup.sha256 } };
  const completed = [];
  client.authorizeHistoryTarget(table.tableId, table.name);
  try {
    for (const field of plan.fieldTypeUpdates) {
      await client.updateField(table.tableId, field.fieldId, { name: field.name, type: DATE });
      completed.push({ stage: 'field_update', fieldId: field.fieldId, name: field.name });
    }
  } catch (error) {
    await writePartialReceipt(options, baseWithBackup, { stage: 'field_update', error }, completed);
    throw error;
  }
  try {
    for (let index = 0; index < plan.recordUpdates.length; index += 500) {
      const batch = plan.recordUpdates.slice(index, index + 500);
      const result = await client.batchUpdateRecords(table.tableId, batch);
      assertBatchResponse(result, batch);
      completed.push({ stage: 'record_update', recordIds: batch.map((record) => record.record_id) });
    }
  } catch (error) {
    await writePartialReceipt(options, baseWithBackup, { stage: 'record_update', error }, completed);
    throw error;
  }
  let afterFields;
  let afterRecords;
  try {
    [afterFields, afterRecords] = await Promise.all([client.listFields(table.tableId), client.listRecords(table.tableId)]);
  } catch (error) {
    await writePartialReceipt(options, baseWithBackup, { stage: 'read_back', error }, completed);
    throw error;
  }
  const after = snapshotRecords(afterRecords);
  try {
    const afterPlan = buildMigrationPlan({ fields: afterFields, records: after, period: options.period, expectedRows: options.expectedRows });
    if (hash(afterFields) !== hash(expectedFieldsAfterMigration(fields))) throw new Error('History schema field verification failed');
    if (afterPlan.fields.some((field) => field.currentType !== DATE)) throw new Error('History period field type verification failed');
    if (afterPlan.recordUpdates.length) throw new Error('History period value verification failed');
    if (afterPlan.before.businessHash !== plan.before.businessHash) throw new Error('History business field hash changed');
    const receipt = {
      ...baseWithBackup,
      mode: 'APPLIED_AND_VERIFIED',
      after: { recordCount: after.length, fieldsHash: hash(afterFields), businessHash: afterPlan.before.businessHash },
      completed,
      feishuWrites: plan.fieldTypeUpdates.length + Math.ceil(plan.recordUpdates.length / 500),
    };
    await writeReceipt(options, receipt);
    return receipt;
  } catch (error) {
    await writePartialReceipt(options, baseWithBackup, { stage: 'verification', error }, completed);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  const result = await runMigration({ client, options });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1]?.endsWith('migrate-competitor-history-period-fields.mjs')) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
