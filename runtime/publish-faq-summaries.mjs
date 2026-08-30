#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { FAQ_ANALYSIS_VERSION } from './faq-text-analysis.mjs';
import { FAQ_MASTER_FIELDS, FAQ_MASTER_TABLE_NAME, FAQ_SCHEMA_VERSION, FAQ_WEEKLY_FIELDS, faqWeeklyTableName, rowsForFeishu } from './faq-topic-summary.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION } from './faq-local-summary.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

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
  const options = { envFile: DEFAULT_ENV_FILE, runtimeRoot: 'runtime', apply: false, replaceCurrent: false };
  const valueOptions = new Map([
    ['--base-url', 'baseUrl'], ['--env-file', 'envFile'], ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--output-dir', 'outputDir'],
    ['--master-table-id', 'masterTableId'], ['--weekly-table-id', 'weeklyTableId'], ['--confirm-app-token', 'confirmAppToken'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--replace-current') options.replaceCurrent = true;
    else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[valueOptions.get(arg)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir ??= resolve(options.runtimeRoot, 'faq-analysis', options.period);
  if (options.apply && (!options.baseUrl || options.confirmAppToken !== options.baseUrl.match(BASE_URL_PATTERN)?.[1])) throw new Error('--apply requires matching --base-url and --confirm-app-token');
  if (options.apply && (!options.masterTableId || !options.weeklyTableId)) throw new Error('--apply requires --master-table-id and --weekly-table-id');
  return options;
}

function canonicalRows(rows) {
  return rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(12)) : value])))).sort();
}

function sameField(actual, expected) {
  if (actual?.fieldName !== expected.name || Number(actual.type) !== Number(expected.type)) return false;
  const expectedProperty = expected.property ?? {};
  const actualProperty = actual.property ?? {};
  if (Number(expected.type) === SINGLE_SELECT) {
    const expectedOptions = (expectedProperty.options ?? []).map((option) => option.name);
    const actualOptions = (actualProperty.options ?? []).map((option) => option.name);
    if (JSON.stringify(actualOptions) !== JSON.stringify(expectedOptions)) return false;
  }
  if (expectedProperty.formatter !== undefined && actualProperty.formatter !== expectedProperty.formatter) return false;
  return true;
}

function summaryRows(summary, includeShare, aggregateReceipt) {
  if (!summary || summary.analysisVersion !== FAQ_ANALYSIS_VERSION || summary.dedupVersion !== FAQ_DEDUP_VERSION || summary.summaryVersion !== FAQ_SUMMARY_VERSION || summary.operatorContentVersion !== FAQ_OPERATOR_CONTENT_VERSION) {
    throw new Error('FAQ summary version mismatch');
  }
  if (summary.operatorContentSource?.sha256 !== aggregateReceipt?.source?.operatorXlsx?.sha256) throw new Error('FAQ operator content source mismatch');
  return rowsForFeishu(summary, includeShare);
}

export function assertSchema(fields, expected, name) {
  if (fields.some((field) => field.fieldName === '原始内容')) throw new Error(`${name} is an original FAQ detail table; summary replacement is blocked`);
  if (fields.length !== expected.length || expected.some((definition, index) => !sameField(fields[index], definition))) throw new Error(`${name} schema mismatch`);
}

async function deleteAll(client, tableId, records) {
  for (let index = 0; index < records.length; index += 500) await client.batchDeleteRecords(tableId, records.slice(index, index + 500).map((record) => record.recordId));
}

async function createAll(client, tableId, rows) {
  for (const row of rows) await client.batchCreateRecords(tableId, [row]);
}

function recordsToRows(records, expected) {
  return records.map((record) => Object.fromEntries(expected.map((field) => {
    const value = record.fields?.[field.name] ?? '';
    return [field.name, Number(field.type) === NUMBER && value !== '' ? Number(value) : value];
  })));
}

export async function replaceTable(client, tableId, expectedFields, desiredRows, label, backupPath, replaceCurrent) {
  const existingRecords = await client.listRecords(tableId);
  const existingRows = recordsToRows(existingRecords, expectedFields);
  const same = existingRows.length === desiredRows.length && JSON.stringify(canonicalRows(existingRows)) === JSON.stringify(canonicalRows(desiredRows));
  if (same) return { mode: 'NOOP_EXACT_MATCH', records: existingRecords, existingRows };
  if (existingRecords.length > 0 && !replaceCurrent) throw new Error(`${label} is non-empty and differs; rerun with --replace-current`);
  await writeFile(backupPath, `${JSON.stringify({ tableId, label, records: existingRecords }, null, 2)}\n`, 'utf8');
  try {
    await deleteAll(client, tableId, existingRecords);
    await createAll(client, tableId, desiredRows);
    const after = await client.listRecords(tableId);
    const actualRows = recordsToRows(after, expectedFields);
    if (after.length !== desiredRows.length || JSON.stringify(canonicalRows(actualRows)) !== JSON.stringify(canonicalRows(desiredRows))) throw new Error(`${label} read-back mismatch`);
    return { mode: 'REPLACED_AND_VERIFIED', records: after, existingRows };
  } catch (error) {
    const partial = await client.listRecords(tableId);
    await deleteAll(client, tableId, partial);
    await createAll(client, tableId, existingRows);
    const restored = await client.listRecords(tableId);
    if (JSON.stringify(canonicalRows(recordsToRows(restored, expectedFields))) !== JSON.stringify(canonicalRows(existingRows))) throw new Error(`${label} rollback failed: ${error.message}`);
    throw error;
  }
}

export async function publishFaqTables({ client, masterTable, weeklyTable, masterRows, weeklyRows, outputDir, period, analysisVersion, source, replaceCurrent }) {
  await mkdir(resolve(outputDir), { recursive: true });
  const backupBase = resolve(outputDir, `publish-backup-${new Date().toISOString().replace(/[-:.]/gu, '')}`);
  const weeklyResult = await replaceTable(client, weeklyTable.tableId, FAQ_WEEKLY_FIELDS, weeklyRows, weeklyTable.name, `${backupBase}-weekly.json`, replaceCurrent);
  let masterResult;
  try {
    masterResult = await replaceTable(client, masterTable.tableId, FAQ_MASTER_FIELDS, masterRows, FAQ_MASTER_TABLE_NAME, `${backupBase}-master.json`, replaceCurrent);
  } catch (error) {
    if (weeklyResult.mode !== 'NOOP_EXACT_MATCH') {
      try {
        const currentWeekly = await client.listRecords(weeklyTable.tableId);
        await deleteAll(client, weeklyTable.tableId, currentWeekly);
        await createAll(client, weeklyTable.tableId, weeklyResult.existingRows);
        const restoredWeekly = recordsToRows(await client.listRecords(weeklyTable.tableId), FAQ_WEEKLY_FIELDS);
        if (JSON.stringify(canonicalRows(restoredWeekly)) !== JSON.stringify(canonicalRows(weeklyResult.existingRows))) throw new Error('weekly snapshot mismatch');
      } catch (rollbackError) {
        throw new Error(`双表回滚失败: ${error.message}; ${rollbackError.message}`);
      }
    }
    throw error;
  }
  const readBack = { master: hash(JSON.stringify(canonicalRows(recordsToRows(masterResult.records, FAQ_MASTER_FIELDS)))), weekly: hash(JSON.stringify(canonicalRows(recordsToRows(weeklyResult.records, FAQ_WEEKLY_FIELDS)))) };
  return { mode: 'APPLIED_AND_VERIFIED', schemaVersion: FAQ_SCHEMA_VERSION, period, source, master: { tableId: masterTable.tableId, name: masterTable.name, result: masterResult.mode }, weekly: { tableId: weeklyTable.tableId, name: weeklyTable.name, result: weeklyResult.mode }, rows: { master: masterRows.length, weekly: weeklyRows.length }, analysisVersion, dedupVersion: FAQ_DEDUP_VERSION, summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION, painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION, operatorContentVersion: FAQ_OPERATOR_CONTENT_VERSION, readBack, feishuWrites: weeklyResult.mode === 'NOOP_EXACT_MATCH' && masterResult.mode === 'NOOP_EXACT_MATCH' ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const weeklyPath = resolve(options.outputDir, 'weekly-summary.json');
  const cumulativePath = resolve(options.outputDir, 'cumulative-summary.json');
  const aggregateReceiptPath = resolve(options.outputDir, 'aggregate-receipt.json');
  if (!existsSync(weeklyPath) || !existsSync(cumulativePath) || !existsSync(aggregateReceiptPath)) throw new Error('Missing verified FAQ summary artifacts');
  const weeklyText = await readFile(weeklyPath, 'utf8');
  const cumulativeText = await readFile(cumulativePath, 'utf8');
  const aggregateReceipt = JSON.parse(await readFile(aggregateReceiptPath, 'utf8'));
  if (aggregateReceipt.mode !== 'APPLIED_AND_VERIFIED' || aggregateReceipt.period !== options.period || aggregateReceipt.analysisVersion !== FAQ_ANALYSIS_VERSION || aggregateReceipt.dedupVersion !== FAQ_DEDUP_VERSION || aggregateReceipt.summaryVersion !== FAQ_SUMMARY_VERSION || aggregateReceipt.representativeSelectionVersion !== FAQ_REPRESENTATIVE_SELECTION_VERSION || aggregateReceipt.painDescriptionVersion !== FAQ_PAIN_DESCRIPTION_VERSION || aggregateReceipt.operatorContentVersion !== FAQ_OPERATOR_CONTENT_VERSION || aggregateReceipt.weekly?.rows !== 21 || aggregateReceipt.cumulative?.rows !== 21) throw new Error('FAQ summary receipt is not verified for the requested period');
  if (aggregateReceipt.weekly?.sha256 !== hash(weeklyText) || aggregateReceipt.cumulative?.sha256 !== hash(cumulativeText)) throw new Error('FAQ summary artifact hash mismatch');
  const weeklySummary = JSON.parse(weeklyText);
  const cumulativeSummary = JSON.parse(cumulativeText);
  const weeklyRows = summaryRows(weeklySummary, false, aggregateReceipt);
  const masterRows = summaryRows(cumulativeSummary, true, aggregateReceipt);
  await mkdir(resolve(options.outputDir), { recursive: true });
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READY', master: { name: FAQ_MASTER_TABLE_NAME, tableId: options.masterTableId ?? null, rows: masterRows.length }, weekly: { name: faqWeeklyTableName(options.period), tableId: options.weeklyTableId ?? null, rows: weeklyRows.length }, schemaVersion: FAQ_SCHEMA_VERSION, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION, summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION, painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION, operatorContentVersion: FAQ_OPERATOR_CONTENT_VERSION, sourceHashes: { weekly: hash(weeklyText), cumulative: hash(cumulativeText), operatorXlsx: aggregateReceipt.source.operatorXlsx.sha256 }, masterHash: hash(JSON.stringify(masterRows)), weeklyHash: hash(JSON.stringify(weeklyRows)), feishuWrites: 0 }, null, 2));
    return;
  }
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)[1];
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const master = tables.find((table) => table.tableId === options.masterTableId && table.name === FAQ_MASTER_TABLE_NAME);
  const weeklyTable = tables.find((table) => table.tableId === options.weeklyTableId && table.name === faqWeeklyTableName(options.period));
  if (!master || !weeklyTable) throw new Error('Confirmed FAQ target table ID/name pair not found');
  client.authorizeFaqTargets({ [master.tableId]: master.name, [weeklyTable.tableId]: weeklyTable.name });
  assertSchema(await client.listFields(master.tableId), FAQ_MASTER_FIELDS, FAQ_MASTER_TABLE_NAME);
  assertSchema(await client.listFields(weeklyTable.tableId), FAQ_WEEKLY_FIELDS, weeklyTable.name);
  const receipt = await publishFaqTables({ client, masterTable: master, weeklyTable, masterRows, weeklyRows, outputDir: options.outputDir, period: options.period, analysisVersion: FAQ_ANALYSIS_VERSION, source: { weeklyHash: hash(weeklyText), cumulativeHash: hash(cumulativeText), planHash: hash(JSON.stringify({ period: options.period, masterRows, weeklyRows, masterFields: FAQ_MASTER_FIELDS, weeklyFields: FAQ_WEEKLY_FIELDS })) }, replaceCurrent: options.replaceCurrent });
  await writeFile(resolve(options.outputDir, 'publish-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
