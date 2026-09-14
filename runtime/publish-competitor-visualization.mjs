#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { buildCompetitorVisualization } from './competitor-visualization-core.mjs';
import { assessCompetitorWeeklyGate, buildHistoryPlan, buildHistoryRows } from './competitor-history-publish-core.mjs';
import { requireWeeklyTable } from './weekly-table-target.mjs';
import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';

const PROFILE = activeProfileName();
const DEFAULT_ENV_FILE = envFilePath(PROFILE);
// base / 历史总表 id 也按 profile 兜底：切换租户后不应还要人肉记住两个新 id 才跑得起来。
// 调用方仍可用 --base-url / --history-table-id 覆盖（跨租户手动发布时仍需要）。
const DEFAULT_BASE_URL = baseUrl(PROFILE);
const DEFAULT_HISTORY_TABLE_ID = tableId('history', PROFILE);
const HISTORY_TABLE_NAME = '竞品历史总表 V1';
const PERIOD_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TEXT = 1;
const NUMBER = 2;
const DATE = 5;

const HISTORY_FIELDS = [
  ['商品周期唯一键', TEXT], ['快照唯一键', TEXT], ['周期开始日期', DATE], ['周期结束日期', DATE],
  ['商品ID', TEXT], ['序号', TEXT], ['商品图片', 17], ['商品标题', TEXT], ['商品链接', TEXT], ['价格', NUMBER],
  ['月收货人数', TEXT], ['月收货人数计算值', NUMBER], ['计算口径', TEXT], ['月收货金额', NUMBER],
  ['类目', TEXT], ['同款数', TEXT], ['平台', TEXT], ['占位类型', TEXT], ['店铺名', TEXT], ['店铺旺旺', TEXT],
  ['店铺类型', TEXT], ['地址', TEXT], ['收藏人数', TEXT], ['卖点', TEXT], ['批次ID', TEXT], ['来源时间', DATE],
  ['搜索关键词', TEXT], ['公式版本', TEXT], ['AI提示词版本', TEXT], ['是否有效竞品', TEXT], ['竞品分类', TEXT],
  ['客单价带分类', TEXT], ['材质分类', TEXT], ['店铺展示分类', TEXT], ['材质金额分摊值', NUMBER], ['金额可计算标记', TEXT],
  ['金额质量状态', TEXT], ['批次有效性', TEXT], ['可视化资格', TEXT], ['本期标记', TEXT], ['来源周表', TEXT],
  ['来源哈希', TEXT], ['规则版本', TEXT], ['数据状态', TEXT,
  ],
];

function parseEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? '');
  return String(value ?? '').trim();
}

function parseArgs(argv) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    baseUrl: DEFAULT_BASE_URL,
    historyTableId: DEFAULT_HISTORY_TABLE_ID,
    outputDir: 'runtime/competitor-visualization-runs',
    apply: false,
  };
  const valueOptions = new Map([
    ['--base-url', 'baseUrl'], ['--env-file', 'envFile'], ['--period-start', 'periodStart'],
    ['--period-end', 'periodEnd'], ['--expected-rows', 'expectedRows'], ['--output-dir', 'outputDir'],
    ['--history-table-id', 'historyTableId'], ['--confirm-app-token', 'confirmAppToken'],
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
  for (const name of ['periodStart', 'periodEnd']) if (!PERIOD_PATTERN.test(String(options[name] ?? ''))) throw new Error(`--${name} must be YYYY-MM-DD`);
  // base-url / history-table-id 不再强制：默认取当前 profile，调用方按需覆盖。
  if (!options.expectedRows || !/^\d+$/u.test(String(options.expectedRows))) throw new Error('--expected-rows is required');
  const appToken = new URL(options.baseUrl).pathname.match(/^\/base\/([^/]+)/u)?.[1];
  if (!appToken) throw new Error('--base-url must be a Feishu /base/ URL');
  if (options.apply && options.confirmAppToken !== appToken) throw new Error('--apply requires matching --confirm-app-token');
  return { ...options, appToken, expectedRows: Number(options.expectedRows), period: { startDate: options.periodStart, endDate: options.periodEnd } };
}

function sameSchema(actual, expected) {
  const byName = new Map(actual.map((field) => [field.fieldName, field]));
  const missing = expected.filter(([name]) => !byName.has(name)).map(([name]) => name);
  const mismatched = expected.filter(([name, type]) => byName.has(name) && Number(byName.get(name).type) !== type).map(([name]) => name);
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

async function createMissingFields(client, tableId, fields) {
  const current = await client.listFields(tableId);
  const schema = sameSchema(current, HISTORY_FIELDS);
  if (schema.mismatched.length) throw new Error(`History schema type mismatch: ${schema.mismatched.join(', ')}`);
  for (const [name, type] of HISTORY_FIELDS) if (schema.missing.includes(name)) await client.createField(tableId, { name, type });
}

async function batchCreate(client, tableId, rows) {
  for (let index = 0; index < rows.length; index += 500) await client.batchCreateRecords(tableId, rows.slice(index, index + 500));
}

async function batchUpdate(client, tableId, rows) {
  for (let index = 0; index < rows.length; index += 500) await client.batchUpdateRecords(tableId, rows.slice(index, index + 500));
}

const NUMBER_FIELDS = new Set(['价格', '月收货人数计算值', '月收货金额', '材质金额分摊值']);
const MONEY_FIELDS = new Set(['月收货金额', '材质金额分摊值']);
const ATTACHMENT_FIELDS = new Set(['商品图片']);

function canonicalScalar(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.map(canonicalScalar);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalScalar(value[key])]));
  return value;
}

function equivalentField(name, desired, actual) {
  if (NUMBER_FIELDS.has(name)) {
    const left = desired === null || desired === undefined || desired === '' ? null : Number(desired);
    const right = actual === null || actual === undefined || actual === '' ? null : Number(actual);
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.isNaN(left) && Number.isNaN(right);
    return MONEY_FIELDS.has(name) ? Math.abs(left - right) <= 1e-6 : left === right;
  }
  if (ATTACHMENT_FIELDS.has(name)) {
    const left = Array.isArray(desired) ? desired.length : 0;
    const right = Array.isArray(actual) ? actual.length : 0;
    return left === right;
  }
  return JSON.stringify(canonicalScalar(desired)) === JSON.stringify(canonicalScalar(actual));
}

function apiBlock(reasonCode, reason = reasonCode) {
  const error = new Error(reason);
  error.code = reasonCode;
  error.details = { reasonCode, reason };
  return error;
}

export function classifyApiPreflight({ authenticated, appToken, requestedAppToken, historyTableId, tables = [] } = {}) {
  if (authenticated !== true) return { status: 'BLOCKED', reasonCode: 'FEISHU_AUTH_FAILED' };
  if (!appToken || appToken !== requestedAppToken) return { status: 'BLOCKED', reasonCode: 'FEISHU_BASE_MISMATCH' };
  if (historyTableId === 'NEW') return { status: 'READY', reasonCode: null };
  const history = (Array.isArray(tables) ? tables : []).find((table) => (
    table.tableId === historyTableId && table.name === HISTORY_TABLE_NAME
  ));
  if (!history) return { status: 'BLOCKED', reasonCode: 'FEISHU_TABLE_MISMATCH' };
  return { status: 'READY', reasonCode: null };
}

function sanitizeError(error) {
  return String(error?.message ?? error)
    .replace(/(?:bearer|token|secret|password|authorization)\s*[:=]?\s*[^\s,;]+/giu, '[redacted]')
    .slice(0, 300);
}

function receiptBase(options, { mode = 'BLOCKED', authStatus = 'NOT_REQUESTED', preflight = {} } = {}) {
  return {
    version: 'feishu-automation-receipt-v1',
    operation: 'competitor_visualization_publish',
    mode,
    startedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    recoveredAt: null,
    auth: { api: { status: authStatus, checkedAt: new Date().toISOString() }, ui: { status: 'NOT_REQUESTED', checkedAt: null } },
    preflight: { status: preflight.status ?? 'NOT_APPLICABLE', reasonCode: preflight.reasonCode ?? null, checkedAt: new Date().toISOString(), recoveredAt: null },
    browserContext: { proxy: null, browserId: null, contextId: null, targetId: null, automationLabel: null },
    target: { baseUrl: options.baseUrl, appToken: options.appToken, tableId: options.historyTableId, tableName: HISTORY_TABLE_NAME },
  };
}

async function writeReceipt(options, receipt) {
  await mkdir(resolve(options.outputDir), { recursive: true });
  await writeFile(resolve(options.outputDir, 'publish-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

export function readBackMatches(records, desiredRows) {
  const actual = new Map(records.map((record) => [text(record.fields?.商品周期唯一键), record.fields ?? {}]));
  return desiredRows.every((row) => {
    const fields = actual.get(text(row.fields.商品周期唯一键));
    if (!fields) return false;
    return Object.entries(row.fields).every(([name, desired]) => equivalentField(name, desired, fields[name]));
  });
}

export async function prepareCompetitorVisualization({ client, options }) {
  const tables = options.prefetchedTables ?? await client.listTables();
  const weeklyTable = requireWeeklyTable(tables, '竞品', `竞品周_${options.period.startDate}_${options.period.endDate}`);
  let historyTable = tables.find((table) => table.tableId === options.historyTableId && table.name === HISTORY_TABLE_NAME);
  const weeklyRecords = await client.listRecords(weeklyTable.tableId);
  if (!historyTable) {
    if (options.historyTableId !== 'NEW') throw new Error('Confirmed history table ID/name pair not found');
    historyTable = { tableId: null, name: HISTORY_TABLE_NAME, needsCreate: true };
  }
  const gate = assessCompetitorWeeklyGate({ records: weeklyRecords, period: options.period, expectedRows: options.expectedRows });
  if (gate.status !== '通过') throw apiBlock('FEISHU_WEEKLY_GATE_FAILED', `Weekly quality gate failed: ${gate.failures.join(', ')}`);
  const source = JSON.stringify(weeklyRecords.map((record) => ({ recordId: record.recordId, fields: record.fields })));
  const sourceHash = (await import('node:crypto')).createHash('sha256').update(source).digest('hex');
  const normalizedRecords = weeklyRecords.map((record) => ({
    ...record,
    fields: {
      ...record.fields,
      批次有效性: text(record.fields?.批次有效性) || '有效',
    },
  }));
  const desiredRows = buildHistoryRows({ records: normalizedRecords, period: options.period, sourceTable: weeklyTable.name, sourceHash });
  const existingRecords = historyTable.tableId ? await client.listRecords(historyTable.tableId) : [];
  const plan = buildHistoryPlan({ desiredRows, existingRecords });
  const visualization = buildCompetitorVisualization({ records: normalizedRecords, ...options.period });
  return { tables, weeklyTable, historyTable, gate, sourceHash, weeklyRecords, desiredRows, existingRecords, plan, visualization };
}

export async function publishCompetitorVisualization({ client, prepared, options }) {
  try {
    if (prepared.historyTable.needsCreate) {
      const definitions = HISTORY_FIELDS.map(([name, type]) => ({ name, type }));
      prepared.historyTable.tableId = await client.createTable(HISTORY_TABLE_NAME, definitions);
    }
    client.authorizeHistoryTarget(prepared.historyTable.tableId, prepared.historyTable.name);
    await createMissingFields(client, prepared.historyTable.tableId, HISTORY_FIELDS);
    await batchCreate(client, prepared.historyTable.tableId, prepared.plan.creates);
    await batchUpdate(client, prepared.historyTable.tableId, prepared.plan.updates);
    const after = await client.listRecords(prepared.historyTable.tableId);
    if (!readBackMatches(after, prepared.desiredRows)) throw apiBlock('FEISHU_READBACK_MISMATCH', 'History read-back mismatch');
    return {
      mode: 'APPLIED_AND_VERIFIED',
      historyTable: { tableId: prepared.historyTable.tableId, name: prepared.historyTable.name },
      weeklyTable: { tableId: prepared.weeklyTable.tableId, name: prepared.weeklyTable.name },
      rows: { desired: prepared.desiredRows.length, creates: prepared.plan.creates.length, updates: prepared.plan.updates.length, deletes: 0, after: after.length },
      sourceHash: prepared.sourceHash,
      money: prepared.visualization.money,
      readBack: true,
    };
  } catch (error) {
    if (error?.code?.startsWith('FEISHU_')) throw error;
    const source = String(error?.message ?? error);
    if (/Blocked record (?:write|delete) outside authorized competitor tables/iu.test(source)) {
      throw apiBlock('FEISHU_WRITE_TARGET_BLOCKED', 'Feishu write target is outside the authorized table set');
    }
    if (/permission|forbidden|无权限|权限不足/iu.test(source)) {
      throw apiBlock('FEISHU_PERMISSION_REQUIRED', 'Feishu target does not permit this write');
    }
    throw error;
  }
}

export async function runCompetitorVisualization({ client, options }) {
  let receipt = receiptBase(options);
  try {
    try {
      await client.authenticate();
      receipt.auth.api = { status: 'AUTHENTICATED', checkedAt: new Date().toISOString() };
    } catch (error) {
      receipt.auth.api = { status: 'AUTH_FAILED', checkedAt: new Date().toISOString(), reasonCode: 'FEISHU_AUTH_FAILED' };
      receipt.error = { reasonCode: 'FEISHU_AUTH_FAILED', message: 'Feishu API authentication failed' };
      await writeReceipt(options, receipt);
      throw apiBlock('FEISHU_AUTH_FAILED', 'Feishu API authentication failed');
    }

    let tables;
    try {
      tables = await client.listTables();
    } catch (error) {
      receipt.preflight = { status: 'BLOCKED', reasonCode: 'FEISHU_BASE_MISMATCH', checkedAt: new Date().toISOString(), recoveredAt: null };
      receipt.error = { reasonCode: 'FEISHU_BASE_MISMATCH', message: sanitizeError(error) };
      await writeReceipt(options, receipt);
      throw apiBlock('FEISHU_BASE_MISMATCH', 'Feishu Base read preflight failed');
    }
    const preflight = classifyApiPreflight({
      authenticated: true,
      appToken: client.appToken ?? options.appToken,
      requestedAppToken: options.appToken,
      historyTableId: options.historyTableId,
      tables,
    });
    receipt.preflight = { ...preflight, checkedAt: new Date().toISOString(), recoveredAt: null };
    if (preflight.status !== 'READY') {
      receipt.error = { reasonCode: preflight.reasonCode, message: 'Feishu API target preflight blocked the operation' };
      await writeReceipt(options, receipt);
      throw apiBlock(preflight.reasonCode, receipt.error.message);
    }

    let prepared;
    try {
      prepared = await prepareCompetitorVisualization({ client, options: { ...options, prefetchedTables: tables } });
    } catch (error) {
      const reasonCode = error?.code?.startsWith('FEISHU_')
        ? error.code
        : /Weekly (?:竞品|SKU|问题库) table not found|Confirmed history table ID\/name pair not found/iu.test(String(error?.message ?? error))
          ? 'FEISHU_TABLE_MISMATCH'
          : 'FEISHU_PUBLISH_FAILED';
      receipt.mode = ['FEISHU_WEEKLY_GATE_FAILED', 'FEISHU_TABLE_MISMATCH'].includes(reasonCode) ? 'BLOCKED' : 'FAILED';
      if (reasonCode === 'FEISHU_TABLE_MISMATCH' || reasonCode === 'FEISHU_WEEKLY_GATE_FAILED') {
        receipt.preflight = { status: 'BLOCKED', reasonCode, checkedAt: new Date().toISOString(), recoveredAt: null };
      }
      receipt.error = { reasonCode, message: reasonCode === 'FEISHU_WEEKLY_GATE_FAILED'
        ? 'Weekly quality gate blocked the operation'
        : reasonCode === 'FEISHU_TABLE_MISMATCH' ? 'Feishu target table preflight blocked the operation' : sanitizeError(error) };
      await writeReceipt(options, receipt);
      throw error.code === reasonCode ? error : apiBlock(reasonCode, receipt.error.message);
    }
    receipt = {
      ...receipt,
      mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
      historyTable: { tableId: prepared.historyTable.tableId, name: prepared.historyTable.name },
      weeklyTable: { tableId: prepared.weeklyTable.tableId, name: prepared.weeklyTable.name },
      gate: prepared.gate,
      rows: { source: prepared.weeklyRecords?.length ?? prepared.desiredRows.length, desired: prepared.desiredRows.length, creates: prepared.plan.creates.length, updates: prepared.plan.updates.length, deletes: 0 },
      sourceHash: prepared.sourceHash,
      money: prepared.visualization.money,
      aggregates: {
        material: prepared.visualization.materialAmountShare,
        priceBand: prepared.visualization.priceBandAmountShare,
        store: prepared.visualization.storeAmountShare,
        bHighValue: prepared.visualization.bHighValueRanking,
      },
    };
    if (options.apply) Object.assign(receipt, await publishCompetitorVisualization({ client, prepared, options }));
    await writeReceipt(options, receipt);
    return receipt;
  } catch (error) {
    if (!receipt.error) {
      const reasonCode = error?.code?.startsWith('FEISHU_') ? error.code : 'FEISHU_PUBLISH_FAILED';
      receipt.mode = ['FEISHU_PERMISSION_REQUIRED', 'FEISHU_WRITE_TARGET_BLOCKED', 'FEISHU_READBACK_MISMATCH'].includes(reasonCode) ? 'BLOCKED' : 'FAILED';
      receipt.error = { reasonCode, message: reasonCode === 'FEISHU_PERMISSION_REQUIRED'
        ? 'Feishu target does not permit this write'
        : reasonCode === 'FEISHU_WRITE_TARGET_BLOCKED'
          ? 'Feishu write target is outside the authorized table set'
          : reasonCode === 'FEISHU_READBACK_MISMATCH' ? 'Feishu history read-back did not match the publish plan' : sanitizeError(error) };
      await writeReceipt(options, receipt);
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const env = parseEnvFile(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  const receipt = await runCompetitorVisualization({ client, options });
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1]?.endsWith('publish-competitor-visualization.mjs')) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
