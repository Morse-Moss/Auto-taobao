#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { readOperatorContent } from './faq-operator-content.mjs';
import { FAQ_ANALYSIS_VERSION, assertAnalysisRecord, sourceTopicIdentity } from './faq-text-analysis.mjs';
import {
  FAQ_DETAIL_FIELDS,
  FAQ_DETAIL_ENRICHMENT_VERSION,
  assertDetailReadBack,
  buildDetailReplacementPlan,
  detailSchemaHash,
  sourceTopicSetHash,
} from './faq-detail-enrichment.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const DEFAULT_BASE_URL = 'https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const MASTER_NAME = '问题主库';
const MASTER_TABLE_ID = 'tblRS5lo0nNN3DOJ';
const WEEKLY_TABLE_ID = 'tblKYtO4SInsW9Oe';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stamp() { return new Date().toISOString().replace(/[-:.]/gu, ''); }
function candidateName(kind, planHash) { return `${kind === 'master' ? '问题主库' : '问题库'}_candidate_${planHash.slice(0, 12)}`; }
function weeklyName(period) { return `问题库_${period}`; }

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
  const options = { phase: 'prepare', apply: false, envFile: DEFAULT_ENV_FILE, baseUrl: DEFAULT_BASE_URL, runtimeRoot: 'runtime' };
  const values = new Map([
    ['--phase', 'phase'], ['--env-file', 'envFile'], ['--base-url', 'baseUrl'], ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--operator-xlsx', 'operatorXlsx'],
    ['--master-table-id', 'masterTableId'], ['--weekly-table-id', 'weeklyTableId'],
    ['--candidate-master-table-id', 'candidateMasterTableId'], ['--candidate-weekly-table-id', 'candidateWeeklyTableId'],
    ['--candidate-receipt-sha256', 'candidateReceiptSha256'], ['--confirm-app-token', 'confirmAppToken'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (values.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[values.get(arg)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['prepare', 'switch'].includes(options.phase)) throw new Error('--phase must be prepare or switch');
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  options.masterTableId ??= MASTER_TABLE_ID;
  options.weeklyTableId ??= WEEKLY_TABLE_ID;
  options.appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  if (!options.appToken) throw new Error('Invalid FAQ Base URL');
  if (options.apply && options.confirmAppToken !== options.appToken) throw new Error('--apply requires matching --confirm-app-token');
  if (options.phase === 'prepare' && !options.operatorXlsx) throw new Error('--operator-xlsx is required for prepare');
  if (options.phase === 'switch' && (!options.candidateReceiptSha256 || !options.candidateMasterTableId || !options.candidateWeeklyTableId)) throw new Error('switch requires candidate receipt SHA and both candidate table IDs');
  return options;
}

async function readFinalClassification(options) {
  const finalPath = resolve(options.outputDir, 'final-classified-records.jsonl');
  const receiptPath = resolve(options.outputDir, 'final-classification-receipt.json');
  const auditPath = resolve(options.outputDir, 'ai-review', 'source-topic-audit.json');
  if (![finalPath, receiptPath, auditPath].every(existsSync)) throw new Error('Missing verified final FAQ classification artifacts');
  const [finalText, receiptText, auditText] = await Promise.all([readFile(finalPath, 'utf8'), readFile(receiptPath, 'utf8'), readFile(auditPath, 'utf8')]);
  const receipt = JSON.parse(receiptText);
  const records = finalText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  records.forEach(assertAnalysisRecord);
  const identityHash = sourceTopicSetHash(records);
  if (receipt.mode !== 'FINAL_CLASSIFICATION_READY' || receipt.period !== options.period || receipt.analysisVersion !== FAQ_ANALYSIS_VERSION || receipt.publishable !== true || receipt.humanQueueCount !== 0 || receipt.legacyAudit?.unresolvedCount !== 0) throw new Error('FAQ final classification is not publishable');
  if (receipt.classifiedRecords !== records.length || receipt.source?.sourceTopicSet?.count !== records.length || receipt.source?.sourceTopicSet?.sha256 !== identityHash) throw new Error('FAQ final source-topic identity mismatch');
  if (receipt.source?.finalClassifiedSnapshot?.sha256 !== hash(finalText)) throw new Error('FAQ final classification artifact hash mismatch');
  if (receipt.source?.legacySourceTopicAudit?.sha256 !== hash(auditText)) throw new Error('FAQ source-topic audit hash mismatch');
  return { records, finalPath, finalText, receiptPath, receiptText, auditPath, auditText, identityHash };
}

function normalizedField(field) {
  return { name: field.fieldName ?? field.name, type: Number(field.type), property: field.property ?? undefined };
}

function schemaMatches(actual, expected = FAQ_DETAIL_FIELDS) {
  if (actual.length !== expected.length) return false;
  return expected.every((field, index) => {
    const item = normalizedField(actual[index]);
    if (item.name !== field.name || item.type !== Number(field.type)) return false;
    if (field.property?.formatter !== undefined && item.property?.formatter !== field.property.formatter) return false;
    if (Number(field.type) === 3) {
      const expectedOptions = (field.property?.options ?? []).map((option) => option.name);
      const actualOptions = (item.property?.options ?? []).map((option) => option.name);
      return JSON.stringify(actualOptions) === JSON.stringify(expectedOptions);
    }
    return true;
  });
}

async function listExactTables(client, identities) {
  const tables = await client.listTables();
  return identities.map(({ tableId, name }) => {
    const table = tables.find((item) => item.tableId === tableId);
    if (!table || table.name !== name) throw new Error(`FAQ table identity mismatch: ${tableId}/${name}`);
    return table;
  });
}

async function snapshotTable(client, table) {
  const [fields, records] = await Promise.all([client.listFields(table.tableId), client.listRecords(table.tableId)]);
  return { tableId: table.tableId, name: table.name, fields, records };
}

async function createRows(client, tableId, rows) {
  for (let index = 0; index < rows.length; index += 500) await client.batchCreateRecords(tableId, rows.slice(index, index + 500));
}

function canonicalReceiptText(receipt) { return `${JSON.stringify(receipt, null, 2)}\n`; }

export async function prepareReplacement({ client, options, operatorContent, apply }) {
  const final = await readFinalClassification(options);
  const plan = buildDetailReplacementPlan({ finalRecords: final.records, operatorContent, period: options.period });
  const planHash = hash(JSON.stringify({ period: options.period, schemaHash: plan.schemaHash, master: plan.master, weekly: plan.weekly, finalArtifactHash: hash(final.finalText) }));
  const names = { master: candidateName('master', planHash), weekly: candidateName('weekly', planHash) };
  const [oldMaster, oldWeekly] = await listExactTables(client, [
    { tableId: options.masterTableId, name: MASTER_NAME },
    { tableId: options.weeklyTableId, name: weeklyName(options.period) },
  ]);
  const [masterSnapshot, weeklySnapshot] = await Promise.all([snapshotTable(client, oldMaster), snapshotTable(client, oldWeekly)]);
  const backup = { period: options.period, appToken: options.appToken, master: masterSnapshot, weekly: weeklySnapshot };
  const backupText = canonicalReceiptText(backup);
  const common = {
    period: options.period, version: FAQ_DETAIL_ENRICHMENT_VERSION, analysisVersion: FAQ_ANALYSIS_VERSION,
    appToken: options.appToken, planHash, schemaHash: detailSchemaHash(), sourceTopicHash: final.identityHash,
    denominator: plan.denominator, statisticsHash: plan.statisticsHash,
    source: { finalClassifiedSnapshot: { path: final.finalPath, sha256: hash(final.finalText) }, finalClassificationReceipt: { path: final.receiptPath, sha256: hash(final.receiptText) }, legacySourceTopicAudit: { path: final.auditPath, sha256: hash(final.auditText) }, operatorXlsx: operatorContent.source },
    oldTables: { master: { tableId: oldMaster.tableId, name: oldMaster.name, records: masterSnapshot.records.length }, weekly: { tableId: oldWeekly.tableId, name: oldWeekly.name, records: weeklySnapshot.records.length } },
    candidates: {
      master: { name: names.master, rows: plan.master.rowCount, rowsHash: plan.master.rowsHash, denominator: plan.master.denominator, statisticsHash: plan.master.statisticsHash },
      weekly: { name: names.weekly, rows: plan.weekly.rowCount, rowsHash: plan.weekly.rowsHash, denominator: plan.weekly.denominator, statisticsHash: plan.weekly.statisticsHash },
    },
  };
  if (!apply) return { mode: 'PREPARE_DRY_RUN_READY', ...common, backupSha256: hash(backupText), feishuWrites: 0 };
  await mkdir(options.outputDir, { recursive: true });
  const backupPath = resolve(options.outputDir, `detail-replacement-backup-${stamp()}.json`);
  await writeFile(backupPath, backupText, 'utf8');
  const existing = await client.listTables();
  if (existing.some((table) => table.name === names.master || table.name === names.weekly)) throw new Error('FAQ candidate table name already exists without a verified candidate receipt');
  const masterId = await client.createTable(names.master, FAQ_DETAIL_FIELDS);
  const weeklyId = await client.createTable(names.weekly, FAQ_DETAIL_FIELDS);
  client.authorizeFaqReplacement({ candidates: { [masterId]: names.master, [weeklyId]: names.weekly } });
  const [masterFields, weeklyFields] = await Promise.all([client.listFields(masterId), client.listFields(weeklyId)]);
  if (!schemaMatches(masterFields) || !schemaMatches(weeklyFields)) throw new Error('FAQ candidate schema mismatch');
  await createRows(client, masterId, plan.master.rows);
  await createRows(client, weeklyId, plan.weekly.rows);
  const [masterRecords, weeklyRecords] = await Promise.all([client.listRecords(masterId), client.listRecords(weeklyId)]);
  const masterReadBack = assertDetailReadBack({ records: masterRecords, expectedRows: plan.master.rows, expectedPeriod: options.period, label: names.master });
  const weeklyReadBack = assertDetailReadBack({ records: weeklyRecords, expectedRows: plan.weekly.rows, expectedPeriod: options.period, label: names.weekly });
  const receipt = {
    mode: 'CANDIDATES_PREPARED_AND_VERIFIED', ...common,
    backup: { path: backupPath, sha256: hash(backupText) },
    candidates: {
      master: { ...common.candidates.master, tableId: masterId, schemaHash: detailSchemaHash(), readBackHash: masterReadBack.rowsHash },
      weekly: { ...common.candidates.weekly, tableId: weeklyId, schemaHash: detailSchemaHash(), readBackHash: weeklyReadBack.rowsHash },
    },
    feishuWrites: 2,
  };
  const receiptText = canonicalReceiptText(receipt);
  const receiptPath = resolve(options.outputDir, 'detail-replacement-candidate-receipt.json');
  await writeFile(receiptPath, receiptText, 'utf8');
  return { ...receipt, candidateReceiptPath: receiptPath, candidateReceiptSha256: hash(receiptText) };
}

async function loadCandidateReceipt(options) {
  const path = resolve(options.outputDir, 'detail-replacement-candidate-receipt.json');
  if (!existsSync(path)) throw new Error('Missing FAQ candidate receipt');
  const text = await readFile(path, 'utf8');
  if (hash(text) !== options.candidateReceiptSha256) throw new Error('FAQ candidate receipt hash mismatch');
  const receipt = JSON.parse(text);
  if (receipt.mode !== 'CANDIDATES_PREPARED_AND_VERIFIED' || receipt.appToken !== options.appToken || receipt.period !== options.period) throw new Error('FAQ candidate receipt is not valid for this target');
  if (receipt.oldTables.master.tableId !== options.masterTableId || receipt.oldTables.weekly.tableId !== options.weeklyTableId || receipt.candidates.master.tableId !== options.candidateMasterTableId || receipt.candidates.weekly.tableId !== options.candidateWeeklyTableId) throw new Error('FAQ switch table IDs do not match candidate receipt');
  return { path, text, receipt };
}

async function verifyCandidate(client, candidate) {
  const fields = await client.listFields(candidate.tableId);
  if (!schemaMatches(fields) || detailSchemaHash() !== candidate.schemaHash) throw new Error(`FAQ candidate schema drift: ${candidate.tableId}`);
  const records = await client.listRecords(candidate.tableId);
  if (records.length !== candidate.rows) throw new Error(`FAQ candidate record count drift: ${candidate.tableId}`);
  const readBack = assertDetailReadBack({ records, expectedRows: records.map((record) => record.fields), label: candidate.name });
  if (readBack.rowsHash !== candidate.rowsHash || candidate.readBackHash !== candidate.rowsHash) throw new Error(`FAQ candidate content drift: ${candidate.tableId}`);
}

export async function switchReplacement({ client, options, apply }) {
  const loaded = await loadCandidateReceipt(options);
  const receipt = loaded.receipt;
  await listExactTables(client, [
    { tableId: receipt.oldTables.master.tableId, name: receipt.oldTables.master.name },
    { tableId: receipt.oldTables.weekly.tableId, name: receipt.oldTables.weekly.name },
    { tableId: receipt.candidates.master.tableId, name: receipt.candidates.master.name },
    { tableId: receipt.candidates.weekly.tableId, name: receipt.candidates.weekly.name },
  ]);
  await Promise.all([verifyCandidate(client, receipt.candidates.master), verifyCandidate(client, receipt.candidates.weekly)]);
  if (!apply) return { mode: 'SWITCH_DRY_RUN_READY', period: options.period, candidateReceiptSha256: hash(loaded.text), oldTables: receipt.oldTables, candidates: receipt.candidates, feishuWrites: 0 };
  const rollbackNames = {
    master: `问题主库_rollback_${receipt.oldTables.master.tableId}`,
    weekly: `${weeklyName(options.period)}_rollback_${receipt.oldTables.weekly.tableId}`,
  };
  const renames = {
    [receipt.oldTables.master.tableId]: rollbackNames.master,
    [receipt.oldTables.weekly.tableId]: rollbackNames.weekly,
    [receipt.candidates.master.tableId]: MASTER_NAME,
    [receipt.candidates.weekly.tableId]: weeklyName(options.period),
  };
  client.authorizeFaqReplacement({ candidates: { [receipt.candidates.master.tableId]: receipt.candidates.master.name, [receipt.candidates.weekly.tableId]: receipt.candidates.weekly.name }, renames, deletes: [receipt.oldTables.master.tableId, receipt.oldTables.weekly.tableId] });
  const completed = [];
  try {
    for (const [tableId, name] of Object.entries(renames)) {
      await client.renameTable(tableId, name);
      completed.push(tableId);
    }
  } catch (error) {
    const reverse = {
      [receipt.oldTables.master.tableId]: receipt.oldTables.master.name,
      [receipt.oldTables.weekly.tableId]: receipt.oldTables.weekly.name,
      [receipt.candidates.master.tableId]: receipt.candidates.master.name,
      [receipt.candidates.weekly.tableId]: receipt.candidates.weekly.name,
    };
    client.authorizeFaqReplacement({ candidates: { [receipt.candidates.master.tableId]: receipt.candidates.master.name, [receipt.candidates.weekly.tableId]: receipt.candidates.weekly.name }, renames: reverse });
    for (const tableId of completed.reverse()) await client.renameTable(tableId, reverse[tableId]);
    throw error;
  }
  await listExactTables(client, [
    { tableId: receipt.oldTables.master.tableId, name: rollbackNames.master },
    { tableId: receipt.oldTables.weekly.tableId, name: rollbackNames.weekly },
    { tableId: receipt.candidates.master.tableId, name: MASTER_NAME },
    { tableId: receipt.candidates.weekly.tableId, name: weeklyName(options.period) },
  ]);
  await Promise.all([verifyCandidate(client, receipt.candidates.master), verifyCandidate(client, receipt.candidates.weekly)]);
  await client.deleteTable(receipt.oldTables.master.tableId);
  await client.deleteTable(receipt.oldTables.weekly.tableId);
  const remaining = await client.listTables();
  if (remaining.some((table) => [receipt.oldTables.master.tableId, receipt.oldTables.weekly.tableId].includes(table.tableId))) throw new Error('FAQ old table deletion verification failed');
  const finalReceipt = {
    mode: 'REPLACEMENT_APPLIED_AND_VERIFIED',
    period: options.period,
    version: FAQ_DETAIL_ENRICHMENT_VERSION,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    appToken: options.appToken,
    candidateReceipt: { path: loaded.path, sha256: hash(loaded.text) },
    backup: receipt.backup,
    oldTables: receipt.oldTables,
    newTables: {
      master: { tableId: receipt.candidates.master.tableId, name: MASTER_NAME, rows: receipt.candidates.master.rows, rowsHash: receipt.candidates.master.rowsHash, denominator: receipt.candidates.master.denominator, statisticsHash: receipt.candidates.master.statisticsHash },
      weekly: { tableId: receipt.candidates.weekly.tableId, name: weeklyName(options.period), rows: receipt.candidates.weekly.rows, rowsHash: receipt.candidates.weekly.rowsHash, denominator: receipt.candidates.weekly.denominator, statisticsHash: receipt.candidates.weekly.statisticsHash },
    },
    deletedOldTableIds: [receipt.oldTables.master.tableId, receipt.oldTables.weekly.tableId],
    sourceTopicHash: receipt.sourceTopicHash,
    schemaHash: receipt.schemaHash,
    denominator: receipt.denominator,
    statisticsHash: receipt.statisticsHash,
    feishuWrites: 1,
  };
  await writeFile(resolve(options.outputDir, 'detail-enrichment-receipt.json'), canonicalReceiptText(finalReceipt), 'utf8');
  return finalReceipt;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await client.authenticate();
  const result = options.phase === 'prepare'
    ? await prepareReplacement({ client, options, operatorContent: readOperatorContent(options.operatorXlsx), apply: options.apply })
    : await switchReplacement({ client, options, apply: options.apply });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
