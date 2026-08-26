import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import {
  FAQ_ANALYSIS_FIELDS,
  FAQ_ANALYSIS_VERSION,
  assertAnalysisRecord,
  buildAnalysisRecords,
  expectedTopicCounts,
} from './faq-text-analysis.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function parseCliArgs(argv) {
  const options = { envFile: DEFAULT_ENV_FILE, apply: false };
  const valueOptions = new Map([
    ['--base-url', 'baseUrl'], ['--env-file', 'envFile'], ['--period-start', 'periodStart'],
    ['--period-end', 'periodEnd'], ['--output-dir', 'outputDir'], ['--confirm-app-token', 'confirmAppToken'],
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
  for (const name of ['baseUrl', 'periodStart', 'periodEnd']) if (!text(options[name])) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  if (!appToken) throw new Error('--base-url must contain /base/<app-token>');
  if (options.apply && (!options.confirmAppToken || options.confirmAppToken !== appToken)) throw new Error('--apply requires matching --confirm-app-token');
  return { ...options, appToken, period: `${options.periodStart}_${options.periodEnd}` };
}

function analysisTableName(period) { return `问题库分析_${period}`; }

function sameField(actual, expected) {
  if (!actual || actual.fieldName !== expected.name) return false;
  if (expected.name === '出现次数') return [2, 20].includes(Number(actual.type));
  if (Number(actual.type) !== Number(expected.type)) return false;
  return true;
}

async function ensureAnalysisTable(client, name) {
  const tables = await client.listTables();
  const matches = tables.filter((table) => table.name === name);
  if (matches.length > 1) throw new Error(`Multiple analysis tables named ${name}`);
  const tableId = matches.length ? matches[0].tableId : await client.createTable(name, FAQ_ANALYSIS_FIELDS);
  const fields = await client.listFields(tableId);
  if (fields.length !== FAQ_ANALYSIS_FIELDS.length || FAQ_ANALYSIS_FIELDS.some((field, index) => !sameField(fields[index], field))) {
    throw new Error(`Analysis table schema mismatch: ${name}`);
  }
  return tableId;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const rawTable = tables.find((table) => table.name === `问题库_${options.period}`);
  if (!rawTable) throw new Error(`Missing raw question table for period ${options.period}`);
  const rawRecords = await client.listRecords(rawTable.tableId);
  if (rawRecords.length === 0) throw new Error('Raw question table is empty');
  const desired = buildAnalysisRecords(rawRecords);
  const topicCounts = expectedTopicCounts(desired);
  const outputDir = resolve(options.outputDir ?? `runtime/faq-analysis/${options.period}`);
  await mkdir(outputDir, { recursive: true });
  const tableId = await ensureAnalysisTable(client, analysisTableName(options.period));
  const existing = await client.listRecords(tableId);
  const existingByKey = new Map(existing.map((record) => [text(record.fields?.来源记录唯一键), record]).filter(([key]) => key));
  const creates = [];
  const updates = [];
  for (const record of desired) {
    const key = text(record.fields?.来源记录唯一键);
    const prior = existingByKey.get(key);
    if (!prior) creates.push(record.fields);
    else {
      if (text(prior.fields?.原始内容) !== text(record.fields?.原始内容)) throw new Error(`Source content conflict for ${key}`);
      if (text(prior.fields?.高频问题或关键词) !== text(record.fields?.高频问题或关键词) || text(prior.fields?.分析版本) !== FAQ_ANALYSIS_VERSION) {
        updates.push({ recordId: prior.recordId, fields: { 高频问题或关键词: record.fields.高频问题或关键词, 分析版本: FAQ_ANALYSIS_VERSION } });
      }
    }
  }
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READY', period: options.period, table: { tableId, name: analysisTableName(options.period) }, rawRecords: rawRecords.length, toCreate: creates.length, toUpdate: updates.length, topicCounts, occurrenceCountsDeferredToSummary: true, analysisVersion: FAQ_ANALYSIS_VERSION }, null, 2));
    return;
  }
  for (let index = 0; index < creates.length; index += 500) await client.batchCreateRecords(tableId, creates.slice(index, index + 500));
  for (let index = 0; index < updates.length; index += 500) await client.batchUpdateRecords(tableId, updates.slice(index, index + 500));
  const after = await client.listRecords(tableId);
  if (after.length !== desired.length) throw new Error(`Analysis record count mismatch: expected ${desired.length}, got ${after.length}`);
  const afterByKey = new Map(after.map((record) => [text(record.fields?.来源记录唯一键), record]));
  for (const record of desired) {
    const actual = afterByKey.get(text(record.fields?.来源记录唯一键));
    if (!actual || text(actual.fields?.原始内容) !== text(record.fields?.原始内容) || text(actual.fields?.高频问题或关键词) !== text(record.fields?.高频问题或关键词)) throw new Error(`Analysis read-back mismatch for ${text(record.fields?.来源记录唯一键)}`);
    assertAnalysisRecord(actual);
  }
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: options.period, table: { tableId, name: analysisTableName(options.period) }, rawTable: { tableId: rawTable.tableId, name: rawTable.name }, sourceRecords: desired.length, toCreate: creates.length, toUpdate: updates.length, tableRecordCount: after.length, topicCounts, occurrenceCountsDeferredToSummary: true, analysisVersion: FAQ_ANALYSIS_VERSION, rawContentModified: false };
  await writeFile(resolve(outputDir, 'apply-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
