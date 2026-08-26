import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import {
  FAQ_ANALYSIS_VERSION,
  FAQ_TOPIC_COUNT_FORMULA,
  buildTopicSummaryFields,
  buildTopicSummaryRecords,
} from './faq-topic-summary.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
    if (Object.prototype.hasOwnProperty.call(value, 'record_ids')) return value.record_ids.map(text).join(',');
    if (Object.prototype.hasOwnProperty.call(value, 'record_id')) return text(value.record_id);
  }
  return String(value ?? '').trim();
}

function relationIds(value) {
  const ids = [];
  const visit = (item) => {
    if (item == null) return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item === 'string') { if (item.startsWith('rec')) ids.push(item); return; }
    if (typeof item === 'object') for (const key of ['record_ids', 'recordIds', 'record_id', 'recordId', 'value']) visit(item[key]);
  };
  visit(value);
  return [...new Set(ids)].sort();
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
  for (const name of ['baseUrl', 'periodStart', 'periodEnd']) if (!String(options[name] ?? '').trim()) throw new Error(`--${name} is required`);
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  if (!appToken) throw new Error('--base-url must contain /base/<app-token>');
  if (options.apply && options.confirmAppToken !== appToken) throw new Error('--apply requires matching --confirm-app-token');
  return { ...options, appToken, period: `${options.periodStart}_${options.periodEnd}` };
}

function tableName(period) { return `问题主题汇总_${period}`; }

function sameField(actual, expected) {
  if (!actual || actual.fieldName !== expected.name || Number(actual.type) !== Number(expected.type)) return false;
  if (expected.type === 21) return actual.property?.table_id === expected.property?.table_id;
  if (expected.type === 20) {
    // Feishu rewrites formulas to an internal table/field-ID expression after creation.
    return typeof actual.property?.formula_expression === 'string'
      && /COUNTA\(/u.test(actual.property.formula_expression);
  }
  return true;
}

function formulaUsesOverflowField(field) {
  return typeof field?.property?.formula_expression === 'string'
    && /COUNTA\(/u.test(field.property.formula_expression)
    && /关联分析记录补充|\$field\[[^\]]+\].*COUNTA/u.test(field.property.formula_expression);
}

async function ensureTable(client, name, detailTableId) {
  const tables = await client.listTables();
  const matches = tables.filter((table) => table.name === name);
  if (matches.length > 1) throw new Error(`Multiple topic summary tables named ${name}`);
  const definitions = buildTopicSummaryFields(detailTableId);
  let tableId;
  if (matches.length) {
    tableId = matches[0].tableId;
  } else {
    // Feishu rejects link properties in the table-create payload. Create the
    // fields in order after the empty table exists so the relation is valid.
    tableId = await client.createTable(name, [definitions[0]]);
  }
  let fields = await client.listFields(tableId);
  if (fields.length > definitions.length || fields.some((field, index) => !sameField(field, definitions[index]))) {
    throw new Error(`Topic summary schema mismatch: ${name}`);
  }
  for (const definition of definitions.slice(fields.length)) {
    const createDefinition = definition.name === '出现次数'
      ? { ...definition, property: { ...definition.property, formula_expression: 'COUNTA(关联分析记录)' } }
      : definition;
    await client.createField(tableId, createDefinition);
  }
  fields = await client.listFields(tableId);
  if (fields.length !== definitions.length || definitions.some((field, index) => !sameField(fields[index], field))) throw new Error(`Topic summary schema mismatch: ${name}`);
  const formula = fields.find((field) => field.fieldName === '出现次数');
  if (!formulaUsesOverflowField(formula)) {
    await client.updateField(tableId, formula.fieldId, definitions.find((field) => field.name === '出现次数'));
  }
  return tableId;
}

function sameIds(left, right) { return JSON.stringify(relationIds(left)) === JSON.stringify([...right].sort()); }

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const detailTable = tables.find((table) => table.name === `问题库分析_${options.period}`);
  if (!detailTable) throw new Error(`Missing detail analysis table for period ${options.period}`);
  const detailRecords = await client.listRecords(detailTable.tableId);
  if (detailRecords.length === 0) throw new Error('Detail analysis table is empty');
  const desired = buildTopicSummaryRecords(detailRecords, options.period);
  const topicIds = new Map(desired.map((record) => [record.fields.高频问题或关键词, {
    primary: relationIds(record.fields.关联分析记录),
    overflow: relationIds(record.fields.关联分析记录补充),
  }]));
  const tableId = await ensureTable(client, tableName(options.period), detailTable.tableId);
  const existing = await client.listRecords(tableId);
  const existingByTopic = new Map(existing.map((record) => [text(record.fields?.高频问题或关键词), record]).filter(([topic]) => topic));
  const creates = [];
  const updates = [];
  for (const record of desired) {
    const topic = record.fields.高频问题或关键词;
    const prior = existingByTopic.get(topic);
    if (!prior) creates.push(record.fields);
    else if (!sameIds(prior.fields?.关联分析记录, topicIds.get(topic).primary)
      || !sameIds(prior.fields?.关联分析记录补充, topicIds.get(topic).overflow)
      || text(prior.fields?.分析版本) !== FAQ_ANALYSIS_VERSION || text(prior.fields?.统计范围) !== options.period) {
      updates.push({ recordId: prior.recordId, fields: record.fields });
    }
  }
  const outputDir = resolve(options.outputDir ?? `runtime/faq-analysis/${options.period}`);
  await mkdir(outputDir, { recursive: true });
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READY', period: options.period, table: { tableId, name: tableName(options.period) }, detailRecords: detailRecords.length, topics: desired.length, toCreate: creates.length, toUpdate: updates.length, formula: FAQ_TOPIC_COUNT_FORMULA, analysisVersion: FAQ_ANALYSIS_VERSION }, null, 2));
    return;
  }
  for (let index = 0; index < creates.length; index += 500) await client.batchCreateRecords(tableId, creates.slice(index, index + 500));
  for (let index = 0; index < updates.length; index += 500) await client.batchUpdateRecords(tableId, updates.slice(index, index + 500));
  const after = await client.listRecords(tableId);
  if (after.length !== desired.length) throw new Error(`Topic summary count mismatch: expected ${desired.length}, got ${after.length}`);
  const afterByTopic = new Map(after.map((record) => [text(record.fields?.高频问题或关键词), record]));
  const counts = {};
  for (const record of desired) {
    const topic = record.fields.高频问题或关键词;
    const actual = afterByTopic.get(topic);
    if (!actual || !sameIds(actual.fields?.关联分析记录, topicIds.get(topic).primary)
      || !sameIds(actual.fields?.关联分析记录补充, topicIds.get(topic).overflow)) throw new Error(`Topic summary read-back mismatch for ${topic}`);
    const count = Number(text(actual.fields?.出现次数));
    const expectedCount = topicIds.get(topic).primary.length + topicIds.get(topic).overflow.length;
    if (!Number.isFinite(count) || count !== expectedCount) throw new Error(`Topic summary formula unsettled for ${topic}: expected ${expectedCount}, got ${text(actual.fields?.出现次数)}`);
    counts[topic] = count;
  }
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: options.period, table: { tableId, name: tableName(options.period) }, detailTable: { tableId: detailTable.tableId, name: detailTable.name }, detailRecords: detailRecords.length, topicRecords: after.length, toCreate: creates.length, toUpdate: updates.length, counts, formula: FAQ_TOPIC_COUNT_FORMULA, analysisVersion: FAQ_ANALYSIS_VERSION, rawContentModified: false };
  await writeFile(resolve(outputDir, 'topic-summary-apply-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
