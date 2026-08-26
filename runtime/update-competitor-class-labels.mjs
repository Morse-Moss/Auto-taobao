#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const DEFAULT_ENV = 'E:/小红书/.env.local';
const APP_TOKEN = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const OLD_LABELS = ['A-高销量高GMV竞品', 'B-高价值竞品', 'C-中价位竞品', 'D-低价位竞品'];
const NEW_LABELS = ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品'];

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

function replaceClassLabels(formula) {
  let next = String(formula ?? '');
  for (let index = 0; index < OLD_LABELS.length; index += 1) {
    next = next.replaceAll(`"${OLD_LABELS[index]}"`, `"${NEW_LABELS[index]}"`);
  }
  return next;
}

function countLabels(records) {
  const counts = {};
  for (const record of records) {
    const raw = record.fields?.竞品分类;
    const value = Array.isArray(raw) ? raw.map((item) => item?.text ?? item).join(',') : String(raw ?? '');
    counts[value || '<空>'] = (counts[value || '<空>'] ?? 0) + 1;
  }
  return counts;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseArgs(argv) {
  const options = { apply: false, envFile: DEFAULT_ENV, backupDir: 'runtime/competitor-class-label-migration' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (['--env-file', '--confirm-app-token', '--backup-dir'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.confirmAppToken !== APP_TOKEN) throw new Error('--confirm-app-token must match the authorized Base app token');
  return options;
}

async function loadTargets(client) {
  const tables = await client.listTables();
  const targets = tables.filter((table) => table.name === '竞品主表' || /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u.test(table.name));
  if (!targets.some((table) => table.name === '竞品主表')) throw new Error('竞品主表 is missing');
  return targets.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

async function inspectTarget(client, table) {
  const [fields, records] = await Promise.all([client.listFields(table.tableId), client.listRecords(table.tableId)]);
  const classField = fields.find((field) => field.fieldName === '竞品分类');
  if (!classField || classField.type !== 20) throw new Error(`${table.name}.竞品分类 is not a formula field`);
  const formula = classField.property?.formula_expression ?? '';
  if (!OLD_LABELS.every((label) => formula.includes(`"${label}"`))) {
    if (NEW_LABELS.every((label) => formula.includes(`"${label}"`))) return { table, fields, records, classField, formula, nextFormula: formula, alreadyUpdated: true };
    throw new Error(`${table.name}.竞品分类 formula does not match the expected old label contract`);
  }
  return { table, fields, records, classField, formula, nextFormula: replaceClassLabels(formula), alreadyUpdated: false };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: APP_TOKEN });
  await client.authenticate();
  const targets = await loadTargets(client);
  const inspections = [];
  for (const table of targets) inspections.push(await inspectTarget(client, table));
  const plan = inspections.map((item) => ({
    tableId: item.table.tableId,
    tableName: item.table.name,
    recordCount: item.records.length,
    fieldId: item.classField.fieldId,
    alreadyUpdated: item.alreadyUpdated,
    changed: item.formula !== item.nextFormula,
    beforeFormulaSha256: sha256(item.formula),
    afterFormulaSha256: sha256(item.nextFormula),
    beforeDistribution: countLabels(item.records),
  }));
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', labels: { old: OLD_LABELS, next: NEW_LABELS }, targets: plan }, null, 2));
    return;
  }
  const backupDir = path.resolve(options.backupDir);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `before-${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}.json`);
  fs.writeFileSync(backupFile, `${JSON.stringify({ createdAt: new Date().toISOString(), appToken: APP_TOKEN, targets: inspections.map(({ table, fields, records }) => ({ table, fields, records })) }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  for (const item of inspections.filter((inspection) => inspection.formula !== inspection.nextFormula)) {
    const fieldRoot = `/bitable/v1/apps/${APP_TOKEN}/tables/${item.table.tableId}/fields/${item.classField.fieldId}`;
    await client.request('PUT', fieldRoot, {
      field_name: '竞品分类',
      type: 20,
      property: { ...(item.classField.property ?? {}), formula_expression: item.nextFormula },
    });
  }
  const after = [];
  for (const item of inspections) {
    let currentFields;
    let currentRecords;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      [currentFields, currentRecords] = await Promise.all([client.listFields(item.table.tableId), client.listRecords(item.table.tableId)]);
      const current = currentFields.find((field) => field.fieldId === item.classField.fieldId);
      if (current?.property?.formula_expression === item.nextFormula && currentRecords.length === item.records.length) break;
      if (attempt === 59) throw new Error(`${item.table.name}.竞品分类 formula did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const current = currentFields.find((field) => field.fieldId === item.classField.fieldId);
    if (current?.property?.formula_expression !== item.nextFormula) throw new Error(`${item.table.name}.竞品分类 formula read-back mismatch`);
    after.push({ tableId: item.table.tableId, tableName: item.table.name, recordCount: currentRecords.length, formulaSha256: sha256(current.property.formula_expression), distribution: countLabels(currentRecords) });
  }
  const receipt = { mode: 'APPLIED_AND_VERIFIED', labels: { old: OLD_LABELS, next: NEW_LABELS }, backupFile, targets: after };
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { replaceClassLabels };
