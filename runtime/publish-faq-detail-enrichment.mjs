#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { readOperatorContent } from './faq-operator-content.mjs';
import { FAQ_DETAIL_ENRICHMENT_FIELDS, FAQ_DETAIL_ENRICHMENT_VERSION, assertEnrichmentReadBack, buildDetailEnrichmentPlan } from './faq-detail-enrichment.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_BASE_URL = 'https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const MASTER_NAME = '问题主库';

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
  const options = { envFile: DEFAULT_ENV_FILE, baseUrl: DEFAULT_BASE_URL, apply: false, runtimeRoot: 'runtime' };
  const valueOptions = new Map([
    ['--env-file', 'envFile'], ['--base-url', 'baseUrl'], ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--operator-xlsx', 'operatorXlsx'],
    ['--master-table-id', 'masterTableId'], ['--weekly-table-id', 'weeklyTableId'], ['--confirm-app-token', 'confirmAppToken'],
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
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name} must be YYYY-MM-DD`);
  if (!options.operatorXlsx) throw new Error('--operator-xlsx is required');
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  if (options.apply && (!options.masterTableId || !options.weeklyTableId)) throw new Error('--apply requires --master-table-id and --weekly-table-id');
  if (options.apply && options.confirmAppToken !== options.baseUrl.match(BASE_URL_PATTERN)?.[1]) throw new Error('--apply requires matching --base-url and --confirm-app-token');
  return options;
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function fieldMatches(actual, expected) {
  return actual?.fieldName === expected.name && Number(actual.type) === Number(expected.type);
}

async function ensureEnrichmentFields(client, tableId) {
  const current = await client.listFields(tableId);
  const byName = new Map(current.map((field) => [field.fieldName, field]));
  const created = [];
  for (const expected of FAQ_DETAIL_ENRICHMENT_FIELDS) {
    const existing = byName.get(expected.name);
    if (existing && !fieldMatches(existing, expected)) throw new Error(`FAQ enrichment field type mismatch: ${tableId}/${expected.name}`);
    if (!existing) {
      await client.createField(tableId, expected);
      created.push(expected.name);
    }
  }
  return { fields: await client.listFields(tableId), created };
}

async function updateRecords(client, tableId, updates) {
  for (let index = 0; index < updates.length; index += 500) await client.batchUpdateRecords(tableId, updates.slice(index, index + 500));
}

function originalSnapshot(records) {
  return records.map((record) => ({ recordId: record.recordId, fields: record.fields }));
}

export async function enrichFaqDetailTables({ client, masterTable, weeklyTable, operatorContent, outputDir, period, apply }) {
  const [masterBefore, weeklyBefore] = await Promise.all([client.listRecords(masterTable.tableId), client.listRecords(weeklyTable.tableId)]);
  const plan = buildDetailEnrichmentPlan({ masterRecords: masterBefore, weeklyRecords: weeklyBefore, operatorContent });
  const snapshot = { period, version: FAQ_DETAIL_ENRICHMENT_VERSION, master: originalSnapshot(masterBefore), weekly: originalSnapshot(weeklyBefore) };
  const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await mkdir(resolve(outputDir), { recursive: true });
  const snapshotPath = resolve(outputDir, `detail-enrichment-backup-${new Date().toISOString().replace(/[-:.]/gu, '')}.json`);
  if (!apply) {
    return { mode: 'DRY_RUN_READY', period, version: FAQ_DETAIL_ENRICHMENT_VERSION, fields: FAQ_DETAIL_ENRICHMENT_FIELDS, master: { tableId: masterTable.tableId, records: masterBefore.length, updates: plan.master.updates.length }, weekly: { tableId: weeklyTable.tableId, records: weeklyBefore.length, updates: plan.weekly.updates.length }, feishuWrites: 0 };
  }
  await writeFile(snapshotPath, snapshotText, 'utf8');
  const masterSchema = await ensureEnrichmentFields(client, masterTable.tableId);
  const weeklySchema = await ensureEnrichmentFields(client, weeklyTable.tableId);
  await updateRecords(client, masterTable.tableId, plan.master.updates);
  await updateRecords(client, weeklyTable.tableId, plan.weekly.updates);
  const [masterAfter, weeklyAfter] = await Promise.all([client.listRecords(masterTable.tableId), client.listRecords(weeklyTable.tableId)]);
  assertEnrichmentReadBack({ before: masterBefore, after: masterAfter, operatorContent });
  assertEnrichmentReadBack({ before: weeklyBefore, after: weeklyAfter, operatorContent });
  const receipt = {
    mode: 'APPLIED_AND_VERIFIED', version: FAQ_DETAIL_ENRICHMENT_VERSION, period,
    master: { tableId: masterTable.tableId, name: masterTable.name, records: masterAfter.length, updates: plan.master.updates.length, createdFields: masterSchema.created },
    weekly: { tableId: weeklyTable.tableId, name: weeklyTable.name, records: weeklyAfter.length, updates: plan.weekly.updates.length, createdFields: weeklySchema.created },
    backupPath: snapshotPath, backupSha256: hash(snapshotText), feishuWrites: plan.master.updates.length + plan.weekly.updates.length > 0 ? 1 : 0,
  };
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const operatorContent = readOperatorContent(options.operatorXlsx);
  if (!options.apply) {
    const env = parseEnvFile(resolve(options.envFile));
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
    const appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
    const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken });
    await client.authenticate();
    const tables = await client.listTables();
    const masterTable = tables.find((table) => table.name === MASTER_NAME);
    const weeklyTable = tables.find((table) => table.name === `问题库_${options.period}`);
    if (!masterTable || !weeklyTable) throw new Error('FAQ detail target tables not found');
    client.authorizeFaqTargets({ [masterTable.tableId]: masterTable.name, [weeklyTable.tableId]: weeklyTable.name });
    const result = await enrichFaqDetailTables({ client, masterTable, weeklyTable, operatorContent, outputDir: options.outputDir, period: options.period, apply: false });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const masterTable = tables.find((table) => table.tableId === options.masterTableId && table.name === MASTER_NAME);
  const weeklyTable = tables.find((table) => table.tableId === options.weeklyTableId && table.name === `问题库_${options.period}`);
  if (!masterTable || !weeklyTable) throw new Error('Confirmed FAQ detail target table ID/name pair not found');
  client.authorizeFaqTargets({ [masterTable.tableId]: masterTable.name, [weeklyTable.tableId]: weeklyTable.name });
  const receipt = await enrichFaqDetailTables({ client, masterTable, weeklyTable, operatorContent, outputDir: options.outputDir, period: options.period, apply: true });
  await writeFile(resolve(options.outputDir, 'detail-enrichment-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
