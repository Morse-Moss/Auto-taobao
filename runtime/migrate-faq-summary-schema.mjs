#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { FAQ_MASTER_FIELDS, FAQ_MASTER_TABLE_NAME, FAQ_SCHEMA_VERSION, FAQ_WEEKLY_FIELDS, faqWeeklyTableName } from './faq-topic-summary.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_BASE_URL = 'https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const SCHEMA_VERSION = FAQ_SCHEMA_VERSION;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

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
  const options = { envFile: DEFAULT_ENV_FILE, baseUrl: DEFAULT_BASE_URL, runtimeRoot: 'runtime', apply: false };
  const valueOptions = new Map([
    ['--env-file', 'envFile'], ['--base-url', 'baseUrl'], ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--master-table-id', 'masterTableId'],
    ['--weekly-table-id', 'weeklyTableId'], ['--confirm-app-token', 'confirmAppToken'],
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
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be YYYY-MM-DD`);
  if (!options.masterTableId || !options.weeklyTableId) throw new Error('Both FAQ target table IDs are required');
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.weeklyName = faqWeeklyTableName(options.period);
  if (options.apply && options.confirmAppToken !== options.baseUrl.match(BASE_URL_PATTERN)?.[1]) throw new Error('--apply requires matching --base-url and --confirm-app-token');
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function serialized(value) { return JSON.stringify(canonical(value)); }

function fieldSnapshot(fields) {
  return fields.map(({ fieldId, fieldName, type, property }) => ({ fieldId, fieldName, type: Number(type), property: property ?? {} }));
}

function schemaMatches(actual, expected) {
  return actual.length === expected.length && actual.every((field, index) => {
    const target = expected[index];
    if (field.fieldName !== target.name || Number(field.type) !== Number(target.type)) return false;
    const currentProperty = field.property ?? {};
    const targetProperty = target.property ?? {};
    if (Number(target.type) === 3) {
      const currentOptions = (currentProperty.options ?? []).map((option) => option.name);
      const targetOptions = (targetProperty.options ?? []).map((option) => option.name);
      if (serialized(currentOptions) !== serialized(targetOptions)) return false;
    }
    return targetProperty.formatter === undefined || currentProperty.formatter === targetProperty.formatter;
  });
}

export function migrationPlan({ master, weekly, period }) {
  const desired = {
    master: FAQ_MASTER_FIELDS,
    weekly: FAQ_WEEKLY_FIELDS,
  };
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    period,
    targets: {
      master: { tableId: master.tableId, name: master.name, expectedName: FAQ_MASTER_TABLE_NAME, currentFields: fieldSnapshot(master.fields), targetFields: desired.master },
      weekly: { tableId: weekly.tableId, name: weekly.name, expectedName: faqWeeklyTableName(period), currentFields: fieldSnapshot(weekly.fields), targetFields: desired.weekly },
    },
  };
  return { ...plan, planHash: hash(serialized(plan)) };
}

async function deleteFields(client, tableId, fields) {
  for (const field of [...fields].reverse()) await client.request('DELETE', `/bitable/v1/apps/${client.appToken}/tables/${tableId}/fields/${field.fieldId}`);
}

async function rebuildSchema(client, tableId, expectedFields) {
  let fields = await client.listFields(tableId);
  if (fields.some((field) => field.fieldName === '原始内容')) throw new Error(`${tableId} is an original FAQ detail table; summary schema replacement is blocked`);
  if (schemaMatches(fields, expectedFields)) return;
  if (!fields.length) throw new Error(`No primary field found for ${tableId}`);
  const primary = fields[0];
  const expectedPrimary = expectedFields[0];
  const primaryMatches = primary.fieldName === expectedPrimary.name && Number(primary.type) === Number(expectedPrimary.type) && serialized(primary.property ?? {}) === serialized(expectedPrimary.property ?? {});
  if (!primaryMatches) await client.updateField(tableId, primary.fieldId, { name: `__faq_migration_primary_${tableId}`, type: primary.type, property: primary.property });
  fields = await client.listFields(tableId);
  await deleteFields(client, tableId, fields.slice(1));
  fields = await client.listFields(tableId);
  await client.updateField(tableId, fields[0].fieldId, expectedPrimary);
  for (const definition of expectedFields.slice(1)) await client.createField(tableId, definition);
  const actual = await client.listFields(tableId);
  if (!schemaMatches(actual, expectedFields)) throw new Error(`Schema read-back mismatch for ${tableId}`);
  return actual;
}

async function restoreSchema(client, tableId, fields) {
  let current = await client.listFields(tableId);
  if (!current.length || !fields.length) throw new Error(`Cannot restore empty schema for ${tableId}`);
  await client.updateField(tableId, current[0].fieldId, { name: `__faq_rollback_primary_${tableId}`, type: current[0].type, property: current[0].property });
  current = await client.listFields(tableId);
  await deleteFields(client, tableId, current.slice(1));
  current = await client.listFields(tableId);
  await client.updateField(tableId, current[0].fieldId, { name: fields[0].fieldName, type: fields[0].type, property: fields[0].property });
  for (const field of fields.slice(1)) await client.createField(tableId, { name: field.fieldName, type: field.type, property: field.property });
  const restored = await client.listFields(tableId);
  if (serialized(fieldSnapshot(restored).map(({ fieldId, ...field }) => field)) !== serialized(fields.map(({ fieldId, ...field }) => field))) throw new Error(`Schema rollback mismatch for ${tableId}`);
}

async function verifyTargets(client, options) {
  const tables = await client.listTables();
  const master = tables.find((table) => table.tableId === options.masterTableId && table.name === FAQ_MASTER_TABLE_NAME);
  const weekly = tables.find((table) => table.tableId === options.weeklyTableId && table.name === options.weeklyName);
  if (!master || !weekly) throw new Error('Confirmed FAQ target table ID/name pair not found');
  const [masterFields, weeklyFields, masterRecords, weeklyRecords] = await Promise.all([
    client.listFields(master.tableId), client.listFields(weekly.tableId), client.listRecords(master.tableId), client.listRecords(weekly.tableId),
  ]);
  return { master: { ...master, fields: masterFields, records: masterRecords }, weekly: { ...weekly, fields: weeklyFields, records: weeklyRecords } };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)[1];
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken });
  await client.authenticate();
  const before = await verifyTargets(client, options);
  const plan = migrationPlan({ master: before.master, weekly: before.weekly, period: options.period });
  const outputDir = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  await mkdir(outputDir, { recursive: true });
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READY', schemaVersion: SCHEMA_VERSION, planHash: plan.planHash, targets: { master: { tableId: before.master.tableId, name: before.master.name, fields: before.master.fields.length, records: before.master.records.length }, weekly: { tableId: before.weekly.tableId, name: before.weekly.name, fields: before.weekly.fields.length, records: before.weekly.records.length } }, targetSchema: { master: FAQ_MASTER_FIELDS, weekly: FAQ_WEEKLY_FIELDS }, feishuWrites: 0 }, null, 2));
    return;
  }
  client.authorizeFaqTargets({ [before.master.tableId]: before.master.name, [before.weekly.tableId]: before.weekly.name });
  const backupPath = resolve(outputDir, `schema-migration-backup-${new Date().toISOString().replace(/[-:.]/gu, '')}.json`);
  await writeFile(backupPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, planHash: plan.planHash, period: options.period, master: before.master, weekly: before.weekly }, null, 2)}\n`, 'utf8');
  try {
    await rebuildSchema(client, before.master.tableId, FAQ_MASTER_FIELDS);
    await rebuildSchema(client, before.weekly.tableId, FAQ_WEEKLY_FIELDS);
    const after = await verifyTargets(client, options);
    if (!schemaMatches(after.master.fields, FAQ_MASTER_FIELDS) || !schemaMatches(after.weekly.fields, FAQ_WEEKLY_FIELDS)) throw new Error('Final FAQ schema verification failed');
    const receipt = { mode: 'APPLIED_AND_VERIFIED', schemaVersion: SCHEMA_VERSION, planHash: plan.planHash, period: options.period, backupPath, master: { tableId: after.master.tableId, name: after.master.name, fields: after.master.fields.length, records: after.master.records.length }, weekly: { tableId: after.weekly.tableId, name: after.weekly.name, fields: after.weekly.fields.length, records: after.weekly.records.length }, recordsPreserved: true, feishuWrites: 1 };
    await writeFile(resolve(outputDir, 'schema-migration-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    try {
      await restoreSchema(client, before.master.tableId, before.master.fields);
      await restoreSchema(client, before.weekly.tableId, before.weekly.fields);
    } catch (rollbackError) {
      throw new Error(`FAQ schema rollback failed: ${error.message}; ${rollbackError.message}`);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
