#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { buildMainUpsertPlan } from './sync-latest-ab-to-main-core.mjs';
import { latestWeeklyTable } from './weekly-table-target.mjs';

const TARGET = {
  appToken: 'OWebbPUcBa7B8JseYLccQCy9nkf',
  mainTableId: 'tblJ9LHFN6pMVjPv',
  mainTableName: '竞品主表',
};

function parseEnv(value) {
  return Object.fromEntries(String(value).split(/\r?\n/u).flatMap((line) => {
    const source = line.trim(); const index = source.indexOf('=');
    if (!source || source.startsWith('#') || index < 1) return [];
    return [[source.slice(0, index).trim(), source.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '')]];
  }));
}

function arg(argv, name, required = true) {
  const index = argv.indexOf(name); const value = index >= 0 ? argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} requires a value`);
  return value;
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? '');
  return String(value ?? '').trim();
}

function productId(value) {
  return text(value).match(/[?&]id=(\d+)/u)?.[1] ?? '';
}

async function readClient(envFile) {
  const path = resolve(envFile);
  if (!existsSync(path)) throw new Error('Feishu environment file is unavailable');
  const env = parseEnv(await readFile(path, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials are unavailable');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: TARGET.appToken });
  await client.authenticate();
  return client;
}

async function readState(client, historyTableId) {
  const tables = await client.listTables();
  const source = historyTableId ? tables.find((table) => table.tableId === historyTableId) : latestWeeklyTable(tables, '竞品');
  if (!source) throw new Error('No weekly competitor table found; create the current 竞品周_YYYY-MM-DD_YYYY-MM-DD table first');
  const [mainRecords, historyRecords] = await Promise.all([
    client.listRecords(TARGET.mainTableId), client.listRecords(source.tableId),
  ]);
  const names = new Map(tables.map((table) => [table.name, table.tableId]));
  if (names.get(TARGET.mainTableName) !== TARGET.mainTableId || !source.name.startsWith('竞品周_')) throw new Error('Latest competitor source table contract mismatch');
  return { mainRecords, historyRecords, historyTable: source };
}

function formulaText(value) {
  return text(value);
}

function verifyRows({ records, plan }) {
  const byProduct = new Map();
  for (const record of records) {
    const id = productId(record.fields?.商品链接);
    if (id) byProduct.set(id, record);
  }
  const unresolved = [];
  const verified = plan.items.map((item) => {
    const record = byProduct.get(item.productId);
    const classification = formulaText(record?.fields?.竞品分类);
    const validity = formulaText(record?.fields?.是否有效竞品);
    if (!record || !/^(?:A-|B-)/u.test(classification) || validity !== '是') {
      unresolved.push({ productId: item.productId, classification, validity });
    }
    return { productId: item.productId, mainRecordId: record?.recordId ?? record?.record_id, classification, validity };
  });
  if (unresolved.length) throw new Error(`Feishu formulas did not resolve all latest A/B rows: ${JSON.stringify(unresolved)}`);
  return verified;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function verifyWithSettling(client, plan, historyTableId) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await readState(client, historyTableId);
    try {
      return { state, verified: verifyRows({ records: state.mainRecords, plan }) };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await wait(1000);
    }
  }
  throw lastError ?? new Error('Latest competitor formula verification did not settle');
}

export async function syncLatestAbToMain({ envFile = 'E:/小红书/.env.local', historyTableId, apply = false } = {}) {
  const client = await readClient(envFile);
  const before = await readState(client, historyTableId);
  const plan = buildMainUpsertPlan({ historyRecords: before.historyRecords, mainRecords: before.mainRecords });
  if (apply) {
    for (let index = 0; index < plan.creates.length; index += 500) await client.batchCreateRecords(TARGET.mainTableId, plan.creates.slice(index, index + 500));
    for (let index = 0; index < plan.updates.length; index += 500) await client.batchUpdateRecords(TARGET.mainTableId, plan.updates.slice(index, index + 500));
  }
  const settled = apply ? await verifyWithSettling(client, plan, historyTableId) : { state: before, verified: [] };
  const afterState = settled.state;
  const verified = settled.verified;
  return {
    mode: apply ? 'APPLIED_AND_VERIFIED' : 'DRY_RUN',
    target: TARGET,
    sourceWeeklyTable: before.historyTable,
    period: plan.period,
    beforeMainRecordCount: before.mainRecords.length,
    afterMainRecordCount: afterState.mainRecords.length,
    plan: plan.summary,
    formulaVerification: apply ? verified : undefined,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  syncLatestAbToMain({ envFile: arg(argv, '--env-file', false) ?? 'E:/小红书/.env.local', historyTableId: arg(argv, '--history-table-id', false), apply: argv.includes('--apply') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
