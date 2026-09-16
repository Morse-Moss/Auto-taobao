#!/usr/bin/env node
// FAQ 明细发布：周表（问题库_<周期>）+ 总表（问题主库，只新增）
//
// 语义（2026-09-16 由运营口径钉死）：
//   周表 = 本周期的明细行，按周期独立存在；本期缺表就**建表**（历史
//          `run-question-library-collection.mjs` 的 `ensureQuestionTable` 语义——
//          迁移 3 把采集段改成纯本地快照时把这个能力连带删掉了，于是每个新周期都必然
//          在「旧表必须已存在」的断言上抛错）。
//   总表 = 长期沉淀，**只新增**：按「来源记录唯一键 + 分类标签」判重，已存在的一律不动、
//          任何情况下不删行。与词库/竞品库同约定（竞品历史总表见
//          `competitor-history-publish-core.mjs` 的 `buildHistoryPlan`）。
//
// 上一版把两张表都当「整体替换」目标（master == weekly == 本期行），会把总表从
// 2023 行缩到 50 行——已被运营否掉，故本次改成单阶段、无 candidate/switch 两步。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { readOperatorContent } from './faq-operator-content.mjs';
import { activeProfileName, baseUrl, envFilePath, tableId } from './feishu-targets.mjs';
import { FAQ_ANALYSIS_VERSION, assertAnalysisRecord, sourceTopicIdentity } from './faq-text-analysis.mjs';
import {
  FAQ_DETAIL_ENRICHMENT_VERSION,
  FAQ_DETAIL_FIELDS,
  FAQ_PUBLISH_MODE,
  assertAppendReadBack,
  assertDetailReadBack,
  buildDetailAppendPlan,
  buildDetailReplacementPlan,
  detailRowsHash,
  detailSchemaHash,
  sourceTopicSetHash,
} from './faq-detail-enrichment.mjs';

const PROFILE = activeProfileName();
const DEFAULT_ENV_FILE = envFilePath(PROFILE);
const DEFAULT_BASE_URL = baseUrl(PROFILE);
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const MASTER_NAME = '问题主库';
// 总表 id 只能来自 feishu-targets.mjs（唯一事实来源）。原先写死旧租户的
// tblRS5lo0nNN3DOJ，裸跑会静默指向一张不存在的表（坑 35「默认值即目标」）。
const MASTER_TABLE_ID = tableId('questionMaster', PROFILE);
const WEEKLY_TABLE_NAME_PATTERN = /^问题库_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const BATCH = 500;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stamp() { return new Date().toISOString().replace(/[-:.]/gu, ''); }
function weeklyName(period) { return `问题库_${period}`; }
function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}
function canonicalReceiptText(receipt) { return `${JSON.stringify(receipt, null, 2)}\n`; }

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
  const options = { phase: 'publish', apply: false, replaceWeekly: false, envFile: DEFAULT_ENV_FILE, baseUrl: DEFAULT_BASE_URL, runtimeRoot: 'runtime' };
  const values = new Map([
    ['--phase', 'phase'], ['--env-file', 'envFile'], ['--base-url', 'baseUrl'], ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--operator-xlsx', 'operatorXlsx'],
    ['--master-table-id', 'masterTableId'], ['--weekly-table-id', 'weeklyTableId'], ['--confirm-app-token', 'confirmAppToken'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--replace-weekly') options.replaceWeekly = true;
    else if (values.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[values.get(arg)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['publish', 'prepare'].includes(options.phase)) {
    if (options.phase === 'switch') throw new Error('--phase switch 已废弃：发布改成单阶段「周表补齐/替换 + 总表只新增」，请用 --phase publish --apply');
    throw new Error('--phase must be publish (or its alias prepare)');
  }
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  options.masterTableId ??= MASTER_TABLE_ID;
  options.appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  if (!options.appToken) throw new Error('Invalid FAQ Base URL');
  if (!options.operatorXlsx) throw new Error('--operator-xlsx is required');
  if (options.apply && options.confirmAppToken !== options.appToken) throw new Error('--apply requires matching --confirm-app-token');
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

const sameRows = (left, right) => JSON.stringify(left.map((row) => JSON.stringify(FAQ_DETAIL_FIELDS.map(({ name }) => row[name] ?? '')))) ===
  JSON.stringify(right.map((row) => JSON.stringify(FAQ_DETAIL_FIELDS.map(({ name }) => row[name] ?? ''))));

async function deleteRecords(client, tableId, recordIds) {
  for (let index = 0; index < recordIds.length; index += BATCH) await client.batchDeleteRecords(tableId, recordIds.slice(index, index + BATCH));
}

async function createRecords(client, tableId, rows) {
  const ids = [];
  for (let index = 0; index < rows.length; index += BATCH) ids.push(...await client.batchCreateRecords(tableId, rows.slice(index, index + BATCH)));
  return ids;
}

// 周表定位：名字必须严格匹配 `问题库_<周期>`；显式传了 id 却查不到 → fail-closed，
// 不静默当作「不存在」。缺表时**不在这里建**（建表是写操作，只在 apply 下发生）。
async function resolveWeeklyTable(client, name, { explicitId }) {
  if (!WEEKLY_TABLE_NAME_PATTERN.test(name)) throw new Error(`Refusing to publish non-weekly FAQ table: ${name}`);
  const tables = await client.listTables();
  const matches = tables.filter((table) => table.name === name);
  if (matches.length > 1) throw new Error(`Multiple tables named ${name}`);
  if (matches.length) return { table: matches[0], existed: true };
  if (explicitId) {
    const byId = tables.find((table) => table.tableId === explicitId);
    throw new Error(byId
      ? `FAQ table identity mismatch: ${byId.tableId}/${byId.name} (expected ${name})`
      : `FAQ weekly table id not found: ${explicitId}`);
  }
  return { table: null, existed: false };
}

export async function publishFaqDetail({ client, options, operatorContent, apply }) {
  const final = await readFinalClassification(options);
  const plan = buildDetailReplacementPlan({ finalRecords: final.records, operatorContent, period: options.period });
  const weeklyRows = plan.weekly.rows;
  const weeklyTableName = weeklyName(options.period);

  const tables = await client.listTables();
  const master = tables.find((table) => table.tableId === options.masterTableId && table.name === MASTER_NAME);
  if (!master) throw new Error(`FAQ master table identity mismatch: ${options.masterTableId}/${MASTER_NAME}`);
  if (!schemaMatches(await client.listFields(master.tableId))) throw new Error(`FAQ master table schema mismatch: ${master.tableId}`);

  const resolved = await resolveWeeklyTable(client, weeklyTableName, { explicitId: options.weeklyTableId });
  let weeklyTable = resolved.table;
  let weeklyCreated = false;
  let weeklyOldRows = [];
  let weeklyOldRecordIds = [];
  if (weeklyTable) {
    if (!schemaMatches(await client.listFields(weeklyTable.tableId))) throw new Error(`FAQ weekly table schema mismatch: ${weeklyTable.tableId}`);
    const records = await client.listRecords(weeklyTable.tableId);
    weeklyOldRecordIds = records.map((record) => record.recordId);
    weeklyOldRows = records.map((record) => Object.fromEntries(FAQ_DETAIL_FIELDS.map(({ name }) => [name, record.fields?.[name] ?? ''])));
  } else if (apply) {
    const createdId = await client.createTable(weeklyTableName, FAQ_DETAIL_FIELDS);
    if (!schemaMatches(await client.listFields(createdId))) throw new Error(`Created FAQ weekly table schema mismatch: ${weeklyTableName}`);
    weeklyTable = { tableId: createdId, name: weeklyTableName };
    weeklyCreated = true;
  }

  const weeklyPlanning = !weeklyTable ? 'CREATE_THEN_WRITE'
    : weeklyOldRows.length === 0 ? 'FILL_EMPTY'
      : sameRows(weeklyOldRows, weeklyRows) ? 'NOOP_EXACT_MATCH'
        : 'REPLACE_NON_EMPTY';
  if (weeklyPlanning === 'REPLACE_NON_EMPTY' && !options.replaceWeekly) {
    throw new Error(`${weeklyTableName} 已有 ${weeklyOldRows.length} 行且与本期不一致；确认要用本期数据覆盖请加 --replace-weekly`);
  }

  // 总表只新增：拿线上现有行判重，已存在的身份不写、不删、不改。
  const masterRecords = await client.listRecords(master.tableId);
  const appendPlan = buildDetailAppendPlan({ desiredRows: weeklyRows, existingRecords: masterRecords, label: MASTER_NAME });
  const appendsHash = detailRowsHash(appendPlan.creates);

  const common = {
    period: options.period,
    version: FAQ_DETAIL_ENRICHMENT_VERSION,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    appToken: options.appToken,
    planHash: hash(JSON.stringify({ period: options.period, schemaHash: plan.schemaHash, weekly: plan.weekly, finalArtifactHash: hash(final.finalText) })),
    schemaHash: detailSchemaHash(),
    sourceTopicHash: final.identityHash,
    denominator: plan.denominator,
    statisticsHash: plan.statisticsHash,
    source: {
      finalClassifiedSnapshot: { path: final.finalPath, sha256: hash(final.finalText) },
      finalClassificationReceipt: { path: final.receiptPath, sha256: hash(final.receiptText) },
      legacySourceTopicAudit: { path: final.auditPath, sha256: hash(final.auditText) },
      operatorXlsx: operatorContent.source,
    },
    master: {
      tableId: master.tableId, name: MASTER_NAME,
      recordsBefore: masterRecords.length,
      appends: appendPlan.creates.length,
      overlap: appendPlan.overlapCount,
      conflicts: appendPlan.conflicts.length,
      appendsHash,
      deletes: 0,
    },
    weekly: {
      tableId: weeklyTable?.tableId ?? null, name: weeklyTableName,
      existed: resolved.existed, created: false, planning: weeklyPlanning,
      previousRows: weeklyOldRows.length, rows: weeklyRows.length, rowsHash: detailRowsHash(weeklyRows),
    },
  };

  if (!apply) {
    return { mode: 'PUBLISH_DRY_RUN_READY', ...common, weeklyTableMissing: !resolved.existed, conflictSample: appendPlan.conflicts.slice(0, 5), feishuWrites: 0 };
  }

  await mkdir(options.outputDir, { recursive: true });
  // 回滚所需的最小事实：周表旧行（要还原）+ 本次追加的身份集合（要撤回）。
  // 不落整张总表 dump——总表 2000+ 行、且本次只增不删，撤回靠身份集合即可定位。
  const backup = {
    period: options.period,
    appToken: options.appToken,
    master: { tableId: master.tableId, name: MASTER_NAME, recordCountBefore: masterRecords.length, identitiesBeforeHash: hash(masterRecords.map((record) => sourceTopicIdentity(record.fields ?? {})).sort().join('\n')) },
    weekly: { tableId: weeklyTable.tableId, name: weeklyTableName, created: weeklyCreated, recordIds: weeklyOldRecordIds, rows: weeklyOldRows },
    appendIdentities: appendPlan.creates.map((row) => sourceTopicIdentity(row)),
  };
  const backupText = canonicalReceiptText(backup);
  const backupPath = resolve(options.outputDir, `detail-append-backup-${stamp()}.json`);
  await writeFile(backupPath, backupText, 'utf8');

  client.authorizeFaqTargets({ [master.tableId]: MASTER_NAME, [weeklyTable.tableId]: weeklyTableName });
  const writes = { weeklyTableCreated: weeklyCreated ? 1 : 0, weeklyRows: 0, masterAppend: 0 };
  const appendedRecordIds = [];
  try {
    if (weeklyPlanning !== 'NOOP_EXACT_MATCH') {
      if (weeklyOldRecordIds.length) await deleteRecords(client, weeklyTable.tableId, weeklyOldRecordIds);
      await createRecords(client, weeklyTable.tableId, weeklyRows);
      writes.weeklyRows = 1;
    }
    if (appendPlan.creates.length) {
      appendedRecordIds.push(...await createRecords(client, master.tableId, appendPlan.creates));
      writes.masterAppend = 1;
    }

    const weeklyReadBack = assertDetailReadBack({
      records: await client.listRecords(weeklyTable.tableId), expectedRows: weeklyRows, expectedPeriod: options.period, label: weeklyTableName,
    });
    const masterReadBack = assertAppendReadBack({
      records: await client.listRecords(master.tableId), appended: appendPlan.creates,
      expectedCountBefore: masterRecords.length, label: MASTER_NAME,
    });
    if (masterReadBack.recordCount !== masterRecords.length + appendPlan.creates.length) throw new Error('问题主库 append read-back mismatch');
    if (appendedRecordIds.length !== appendPlan.creates.length) throw new Error('问题主库 appended record id count mismatch');

    const receipt = {
      mode: FAQ_PUBLISH_MODE,
      ...common,
      master: {
        ...common.master,
        recordsAfter: masterReadBack.recordCount,
        appended: appendedRecordIds.length,
        appendedRecordIds,
      },
      weekly: { ...common.weekly, created: weeklyCreated, rowsHash: weeklyReadBack.rowsHash },
      backup: { path: backupPath, sha256: hash(backupText) },
      feishuWrites: writes.weeklyTableCreated + writes.weeklyRows + writes.masterAppend,
    };
    await writeFile(resolve(options.outputDir, 'detail-enrichment-receipt.json'), canonicalReceiptText(receipt), 'utf8');
    return receipt;
  } catch (error) {
    const failures = [];
    if (appendedRecordIds.length) {
      try {
        await deleteRecords(client, master.tableId, appendedRecordIds);
        const after = await client.listRecords(master.tableId);
        if (after.length !== masterRecords.length) failures.push(`master rollback left ${after.length} rows (expected ${masterRecords.length})`);
      } catch (rollbackError) { failures.push(`master rollback: ${rollbackError.message}`); }
    }
    try {
      const current = await client.listRecords(weeklyTable.tableId);
      if (current.length) await deleteRecords(client, weeklyTable.tableId, current.map((record) => record.recordId));
      if (weeklyOldRows.length) await createRecords(client, weeklyTable.tableId, weeklyOldRows);
      const restored = await client.listRecords(weeklyTable.tableId);
      if (restored.length !== weeklyOldRows.length) failures.push(`weekly rollback left ${restored.length} rows (expected ${weeklyOldRows.length})`);
      if (weeklyCreated) {
        client.authorizeTableDeletion([weeklyTable.tableId]);
        await client.deleteTable(weeklyTable.tableId);
      }
    } catch (rollbackError) { failures.push(`weekly rollback: ${rollbackError.message}`); }
    if (failures.length) throw new Error(`FAQ publish failed: ${error.message}; 回滚未完成：${failures.join('; ')}`);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await client.authenticate();
  const result = await publishFaqDetail({ client, options, operatorContent: readOperatorContent(options.operatorXlsx), apply: options.apply });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
