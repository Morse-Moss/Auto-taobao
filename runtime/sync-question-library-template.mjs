import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync as readFileSyncBytes } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const TEMPLATE_TABLE_ID = 'tblRS5lo0nNN3DOJ';
const TARGET_TABLE_NAME = '问题库';

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSyncBytes(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
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

function parseArgs(argv) {
  const options = { envFile: DEFAULT_ENV_FILE, outputDir: undefined, apply: false, replaceCurrent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--replace-current') options.replaceCurrent = true;
    else if (['--env-file', '--output-dir', '--period-start', '--period-end', '--confirm-app-token'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[key] ?? ''))) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir ??= `runtime/faq-analysis/${options.period}`;
  if (options.apply && options.confirmAppToken !== APP_TOKEN) throw new Error('--confirm-app-token must match the authorized Base app token');
  return options;
}

function assertTemplateFields(fields) {
  const expected = [
    ['商品链接', 1], ['商品标题', 1], ['竞品分类', 4], ['来源类型', 3],
    ['原始内容', 1], ['高频问题或关键词', 1], ['出现次数', 2], ['采集状态', 3],
  ];
  if (fields.length !== expected.length || fields.some((field, index) => field.fieldName !== expected[index][0] || Number(field.type) !== expected[index][1])) {
    throw new Error('问题库 template schema mismatch');
  }
}

function buildTemplateRows(detailRecords, summaryRecords) {
  const countByTopic = new Map();
  for (const record of summaryRecords) {
    const topic = text(record.fields?.高频问题或关键词);
    const count = Number(text(record.fields?.出现次数));
    if (!topic || !Number.isFinite(count)) throw new Error(`Summary count missing for ${topic || 'unknown topic'}`);
    countByTopic.set(topic, count);
  }
  return detailRecords.map((record) => {
    const source = record.fields ?? {};
    const topic = text(source.高频问题或关键词);
    const raw = text(source.原始内容);
    if (!raw || !topic || !countByTopic.has(topic)) throw new Error(`Analysis record ${record.recordId} is incomplete`);
    return {
      商品链接: text(source.商品链接),
      商品标题: text(source.商品标题),
      竞品分类: [text(source.竞品分类)],
      来源类型: text(source.来源类型),
      原始内容: raw,
      高频问题或关键词: topic,
      出现次数: countByTopic.get(topic),
      采集状态: text(source.采集状态) || '已采集',
    };
  });
}

function canonicalRows(rows) {
  return rows.map((row) => JSON.stringify({
    商品链接: text(row.商品链接),
    商品标题: text(row.商品标题),
    竞品分类: (Array.isArray(row.竞品分类) ? row.竞品分类 : [row.竞品分类]).map(text).filter(Boolean).sort(),
    来源类型: text(row.来源类型),
    原始内容: text(row.原始内容),
    高频问题或关键词: text(row.高频问题或关键词),
    出现次数: Number(text(row.出现次数)),
    采集状态: text(row.采集状态),
  })).sort();
}

export function planTemplateSync(existingRows, desiredRows, replaceCurrent = false) {
  const same = existingRows.length === desiredRows.length
    && JSON.stringify(canonicalRows(existingRows)) === JSON.stringify(canonicalRows(desiredRows));
  if (same) return { mode: 'NOOP_EXACT_MATCH', toCreate: 0, toDelete: 0 };
  if (existingRows.length === 0) return { mode: 'CREATE_EMPTY_TARGET', toCreate: desiredRows.length, toDelete: 0 };
  if (!replaceCurrent) return { mode: 'BLOCKED_NON_EMPTY_MISMATCH', toCreate: 0, toDelete: 0 };
  return { mode: 'REPLACE_CURRENT', toCreate: desiredRows.length, toDelete: existingRows.length };
}

async function deleteAll(client, tableId, records) {
  for (let index = 0; index < records.length; index += 500) {
    await client.batchDeleteRecords(tableId, records.slice(index, index + 500).map((record) => record.recordId));
  }
}

async function createAll(client, tableId, rows) {
  for (let index = 0; index < rows.length; index += 500) {
    await client.batchCreateRecords(tableId, rows.slice(index, index + 500));
  }
}

function rowsFromRecords(records, keys) {
  return records.map((record) => Object.fromEntries(keys.map((key) => [key, record.fields?.[key] ?? ''])));
}

function assertRowsMatch(records, expectedRows, label) {
  const actualRows = rowsFromRecords(records, Object.keys(expectedRows[0] ?? {}));
  if (records.length !== expectedRows.length
    || JSON.stringify(canonicalRows(actualRows)) !== JSON.stringify(canonicalRows(expectedRows))) {
    throw new Error(`${label} read-back mismatch: expected ${expectedRows.length}, got ${records.length}`);
  }
}

export async function applyOperatorPublish({
  client, tableId, plan, existingRecords, existingRows, desiredRows, writeBackup,
}) {
  if (plan.mode === 'NOOP_EXACT_MATCH') return existingRecords;
  if (plan.mode === 'BLOCKED_NON_EMPTY_MISMATCH') throw new Error('问题库 is non-empty and differs from current analysis');
  if (!['CREATE_EMPTY_TARGET', 'REPLACE_CURRENT'].includes(plan.mode)) throw new Error(`Unsupported publish plan: ${plan.mode}`);

  if (plan.mode === 'REPLACE_CURRENT') await writeBackup();
  try {
    if (plan.mode === 'REPLACE_CURRENT') await deleteAll(client, tableId, existingRecords);
    await createAll(client, tableId, desiredRows);
    const after = await client.listRecords(tableId);
    assertRowsMatch(after, desiredRows, '问题库');
    return after;
  } catch (error) {
    const partial = await client.listRecords(tableId);
    await deleteAll(client, tableId, partial);
    if (existingRows.length > 0) await createAll(client, tableId, existingRows);
    const restored = await client.listRecords(tableId);
    assertRowsMatch(restored, existingRows, '问题库 rollback');
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const tables = await client.listTables();
  const target = tables.find((table) => table.tableId === TEMPLATE_TABLE_ID && table.name === TARGET_TABLE_NAME);
  const detail = tables.find((table) => table.name === `问题库分析_${options.period}`);
  const summary = tables.find((table) => table.name === `问题主题汇总_${options.period}`);
  if (!target || !detail || !summary) throw new Error('Required FAQ tables are missing');
  assertTemplateFields(await client.listFields(target.tableId));
  const [detailRecords, summaryRecords, existing] = await Promise.all([
    client.listRecords(detail.tableId), client.listRecords(summary.tableId), client.listRecords(target.tableId),
  ]);
  const rows = buildTemplateRows(detailRecords, summaryRecords);
  const existingRows = existing.map((record) => Object.fromEntries(Object.keys(rows[0] ?? {}).map((key) => [key, record.fields?.[key] ?? ''])));
  const plan = planTemplateSync(existingRows, rows, options.replaceCurrent);
  await mkdir(resolve(options.outputDir), { recursive: true });
  const receiptPath = resolve(options.outputDir, 'template-sync-receipt.json');
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN_READY', target: { tableId: target.tableId, name: target.name }, sourceRecords: detailRecords.length, summaryRecords: summaryRecords.length, existingRecords: existing.length, ...plan }, null, 2));
    return;
  }
  if (plan.mode === 'BLOCKED_NON_EMPTY_MISMATCH') throw new Error(`问题库 is non-empty and differs from current analysis; rerun with --replace-current after source verification`);
  const backupPath = resolve(options.outputDir, `operator-mirror-backup-${new Date().toISOString().replace(/[-:.]/gu, '')}.json`);
  const after = await applyOperatorPublish({
    client,
    tableId: target.tableId,
    plan,
    existingRecords: existing,
    existingRows,
    desiredRows: rows,
    writeBackup: async () => {
      await writeFile(backupPath, `${JSON.stringify({ table: { tableId: target.tableId, name: target.name }, period: options.period, records: existing }, null, 2)}\n`, 'utf8');
    },
  });
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: options.period, plan: plan.mode, target: { tableId: target.tableId, name: target.name }, source: { tableId: detail.tableId, name: detail.name }, summary: { tableId: summary.tableId, name: summary.name }, sourceRecords: detailRecords.length, targetRecords: after.length, toCreate: plan.toCreate, toDelete: plan.toDelete, backupPath: plan.mode === 'REPLACE_CURRENT' ? backupPath : null, countsFromFeishuSummary: true, rawContentModified: false };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
