#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../../runtime/feishu-targets.mjs';
import { reportDateEpoch } from './daily-report-core.mjs';
import { classifyInquiryWrite, extractInquiryMetrics, selectDailyStoreRecord } from './inquiry-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');
const DEFAULTS = Object.freeze({
  proxy: 'http://127.0.0.1:3458',
  appToken: TARGET.baseToken,
  tableId: TARGET.inquiryTable,
});
const WRITTEN_FIELDS = Object.freeze(['询单量', '同层同行询单量']);

function parseArgs(argv) {
  const args = { ...DEFAULTS, commit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--commit') args.commit = true;
    else if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--source-shop') args.sourceShop = argv[++index];
    else if (key === '--shop') args.shop = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.reportDate ?? '')) throw new Error('missing or invalid --date');
  if (!args.sourceShop) throw new Error('missing --source-shop');
  if (!args.shop) throw new Error('missing --shop');
  args.outputDir = path.resolve(args.outputDir || path.join(REPO_ROOT, 'evidence', `daily-report-${args.reportDate}`));
  return args;
}

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `proxy request failed: HTTP ${response.status}`);
  return payload;
}

async function discoverSycmTarget(args) {
  const targets = await proxyJson(`${args.proxy}/targets`);
  const matches = targets.filter(target => target.type === 'page'
    && target.url.includes('sycm.taobao.com/qos/service/frame/shop/performance'));
  if (matches.length !== 1) throw new Error(`expected one SYCM shop-performance page, got ${matches.length}`);
  return matches[0];
}

async function readSycmTable(args) {
  const target = await discoverSycmTarget(args);
  const expression = `(() => {
    const clean = value => String(value ?? '').trim().replace(/\\s+/g, ' ');
    const account = [...document.querySelectorAll('.ebase-frame-header-root a')]
      .map(anchor => clean(anchor.innerText)).find(text => text.endsWith(' 主店'));
    if (!account) throw new Error('current SYCM shop identity is unavailable');
    const tables = [...document.querySelectorAll('table')].filter(table =>
      [...table.querySelectorAll('thead th')].some(th => clean(th.innerText) === '当日询单人数'));
    if (tables.length !== 1) throw new Error('expected one 当日询单人数 table, got ' + tables.length);
    const table = tables[0];
    return JSON.stringify({
      url: location.href,
      sourceShop: account.replace(/ 主店$/u, ''),
      headers: [...table.querySelectorAll('thead th')].map(th => clean(th.innerText)),
      rows: [...table.querySelectorAll('tbody tr:not(.ant-table-measure-row), tfoot tr')]
        .map(row => [...row.querySelectorAll('th,td')].map(td => clean(td.innerText))),
    });
  })()`;
  const payload = await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(target.targetId)}`, {
    method: 'POST', body: expression,
  });
  return JSON.parse(payload.value);
}

function withoutInquiryFields(fields) {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([name]) => !WRITTEN_FIELDS.includes(name)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });
  const source = await readSycmTable(args);
  if (source.sourceShop !== args.sourceShop) {
    throw new Error(`unexpected SYCM shop: expected ${args.sourceShop}, got ${source.sourceShop}`);
  }
  const metrics = extractInquiryMetrics(source, args.reportDate);

  const clientModule = await import(pathToFileURL(path.join(REPO_ROOT,
    'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')));
  const credentials = loadFeishuCredentials('kcne');
  const client = new clientModule.FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret,
    appToken: args.appToken, tableId: args.tableId });
  const [tables, fields, beforeRecords] = await Promise.all([
    client.listTables(), client.listFields(), client.listRecords(),
  ]);
  const table = tables.find(item => item.tableId === args.tableId);
  if (table?.name !== '各店铺数据日报') throw new Error(`unexpected Feishu table: ${table?.name ?? 'missing'}`);
  for (const [name, type] of [['日期', 5], ['店铺', 3], ['询单量', 2], ['同层同行询单量', 2]]) {
    const field = fields.find(item => item.fieldName === name);
    if (!field || field.type !== type) throw new Error(`unexpected Feishu field ${name}: ${JSON.stringify(field)}`);
  }

  const epoch = reportDateEpoch(args.reportDate);
  const before = selectDailyStoreRecord(beforeRecords, epoch, args.shop);
  const disposition = classifyInquiryWrite(before.fields, metrics);
  const plan = {
    mode: args.commit ? 'commit' : 'dry-run', reportDate: args.reportDate, shop: args.shop,
    target: { appToken: args.appToken, tableId: args.tableId, tableName: table.name, recordId: before.record_id },
    source: { url: source.url, shop: source.sourceShop, column: '当日询单人数',
      dateRow: args.reportDate, benchmarkRow: '同行同层均值' },
    values: { 询单量: metrics.inquiry, 同层同行询单量: metrics.peerInquiry },
    prewrite: { disposition, 询单量: before.fields?.['询单量'] ?? null,
      同层同行询单量: before.fields?.['同层同行询单量'] ?? null },
  };
  const planPath = path.join(args.outputDir, 'inquiry-backfill-plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  if (!args.commit) {
    const status = disposition === 'WRITE_REQUIRED' ? 'DRY_RUN_READY' : 'ALREADY_VERIFIED';
    console.log(JSON.stringify({ status, planPath, recordId: before.record_id, values: plan.values }, null, 2));
    return;
  }

  let writeResponseError;
  const attemptPath = path.join(args.outputDir, `inquiry-attempt-${Date.now()}.json`);
  if (disposition === 'WRITE_REQUIRED') {
    writeFileSync(attemptPath, `${JSON.stringify({ status: 'WRITE_OUTCOME_UNKNOWN', plan, before, source }, null, 2)}\n`, 'utf8');
    try {
      const updated = await client.batchUpdateRecords([{ record_id: before.record_id, fields: plan.values }]);
      assert.deepEqual(updated, [before.record_id]);
    } catch (error) {
      writeResponseError = error.message;
    }
  }
  const afterRecords = await client.listRecords();
  const after = selectDailyStoreRecord(afterRecords, epoch, args.shop);
  assert.equal(classifyInquiryWrite(after.fields, metrics), 'ALREADY_VERIFIED');
  assert.equal(after.record_id, before.record_id);
  assert.deepEqual(withoutInquiryFields(after.fields), withoutInquiryFields(before.fields));

  if (disposition === 'ALREADY_VERIFIED') {
    console.log(JSON.stringify({ status: disposition, recordId: after.record_id,
      values: plan.values, unchangedOtherFields: true }, null, 2));
    return;
  }
  const receipt = { ...plan, status: 'COMMITTED_AND_VERIFIED',
    writeResponseError,
    verified: { recordId: after.record_id, unchangedOtherFields: true, values: plan.values } };
  const receiptPath = path.join(args.outputDir, 'inquiry-backfill-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(attemptPath, `${JSON.stringify({ ...receipt, before, source }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: receipt.status, receiptPath, recordId: after.record_id,
    values: plan.values, unchangedOtherFields: true }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
