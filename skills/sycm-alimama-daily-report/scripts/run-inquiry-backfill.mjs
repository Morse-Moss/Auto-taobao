#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../../runtime/feishu-targets.mjs';
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import { appendAudit, describeAuditRow } from '../../../runtime/daily-report-audit.mjs';
import { reportDateEpoch } from './daily-report-core.mjs';
import { buildEnvironment, dirHasEntries, evidenceBaseDir, resolveEvidenceDir } from './daily-report-runtime.mjs';
import { assertEvidenceShopKey } from './shop-identities.mjs';
import { classifyInquiryWrite, extractInquiryMetrics, selectDailyStoreRecord } from './inquiry-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');
const DEFAULTS = Object.freeze({
  // 端口来自 runtime/browser-ports.mjs（唯一来源）；这里是日报链的商家号代理。
  proxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
  appToken: TARGET.baseToken,
  tableId: TARGET.inquiryTable,
});
const WRITTEN_FIELDS = Object.freeze(['询单量', '同层同行询单量']);

function parseArgs(argv) {
  const args = { ...DEFAULTS, commit: false, allowMissingPeer: false, shopKey: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--commit') args.commit = true;
    else if (key === '--allow-missing-peer') args.allowMissingPeer = true;
    else if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--source-shop') args.sourceShop = argv[++index];
    else if (key === '--shop') args.shop = argv[++index];
    // 证据目录的店铺维度（运营叫法）。**不给时行为逐字不变**；多店铺必须给，
    // 而且必须与 push 那一步给同一个值 —— 否则回填会并入另一代的目录里（拆分产物）。
    else if (key === '--shop-key') args.shopKey = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.reportDate ?? '')) throw new Error('missing or invalid --date');
  if (!args.sourceShop) throw new Error('missing --source-shop');
  if (!args.shop) throw new Error('missing --shop');
  // 产物落哪一代：这里用 'latest' —— 回填是**同一次运行的第二阶段**，必须并入
  // run-daily-report 刚建好的那一代；按 'fresh' 走就会把它和 plan/receipt 拆到两个目录。
  args.outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
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

// 审计：**这是补上的缺口**（2026-09-17 复盘）。
//
// 007 的 CHECK 早就允许 `push | ui-verify | inquiry-backfill` 三个动作，可 appendAudit 只被
// run-daily-report.mjs 调用（push / ui-verify 两条路），而 run-inquiry-backfill.mjs 根本没接线
// ⇒ 询单回填**从来没有留下过审计行**。这是本项目反复出现的「词表/文档比代码乐观」形态
// （同族：登录态 AUTH_EXPIRING 只写在文档里）。词表里有这个值、却没人写，等于把缺口伪装成已完成。
//
// 两条纪律照搬 run-daily-report.mjs：只有真的走到对外动作那一步才建立上下文（dry-run 什么都没发生，
// 不记）；写审计失败**绝不能**让回填链失败 —— 数据已经进飞书了，本地旁证写不进去不该把成功判成失败。
let auditContext = null;

async function recordAudit(entry) {
  const row = describeAuditRow(entry);
  const result = await appendAudit(row);
  if (result.written) console.log(`[audit] 已记 ${row.action}/${row.outcome} id=${result.id}`);
  else console.error(`[audit] 未写入（不影响本次结论）：${result.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = evidenceBaseDir({ evidenceRoot: path.join(REPO_ROOT, 'evidence'),
    reportDate: args.reportDate, shopKey: args.shopKey });
  const resolved = resolveEvidenceDir({ baseDir, explicit: args.outputDir, isOccupied: dirHasEntries, policy: 'latest' });
  args.outputDir = resolved.dir;
  mkdirSync(args.outputDir, { recursive: true });
  const source = await readSycmTable(args);
  if (source.sourceShop !== args.sourceShop) {
    throw new Error(`unexpected SYCM shop: expected ${args.sourceShop}, got ${source.sourceShop}`);
  }
  // 目录名里的店铺键必须与飞书那一行的店铺叫法一致（两者都是运营叫法，本来就该同一个值）。
  // 不核的话会出现「目录叫 A 店、写进去的是 B 店那一行」——从文件名上完全看不出来。
  if (args.shopKey) assertEvidenceShopKey(args.shopKey, { shopKey: args.shop });
  const metrics = extractInquiryMetrics(source, args.reportDate,
    { peerBenchmarkRequired: !args.allowMissingPeer });

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
  // 降级时只写「询单量」，不碰「同层同行询单量」——让那一格保持空白，而不是写 0 或占位值。
  const values = metrics.peerBenchmark === 'PEER_UNAVAILABLE'
    ? { 询单量: metrics.inquiry }
    : { 询单量: metrics.inquiry, 同层同行询单量: metrics.peerInquiry };
  const plan = {
    mode: args.commit ? 'commit' : 'dry-run', reportDate: args.reportDate, shop: args.shop,
    environment: buildEnvironment({
      proxyUrl: args.proxy,
      ports: { browser: PROJECT_PORTS.dailyReportBrowser, proxy: PROJECT_PORTS.dailyReportProxy },
      identities: { id: BROWSER_IDS.dailyReport, label: BROWSER_LABELS.dailyReport },
    }),
    evidence: { outputDir: args.outputDir, generation: resolved.generation, reason: resolved.reason },
    target: { appToken: args.appToken, tableId: args.tableId, tableName: table.name, recordId: before.record_id },
    source: { url: source.url, shop: source.sourceShop, column: '当日询单人数',
      dateRow: args.reportDate, benchmarkRow: metrics.peerBenchmark === 'PEER_UNAVAILABLE' ? null : '同行同层均值',
      peerBenchmark: metrics.peerBenchmark, rows: (source.rows ?? []).length },
    degraded: metrics.peerBenchmark === 'PEER_UNAVAILABLE'
      // 历史日（自定义日期）实测只剩 3 行，数据源不返回同行同层对比行。
      // 这是显式降级：单据里写清缺什么、为什么缺，而不是静默留空或写 0。
      ? { code: 'PEER_UNAVAILABLE',
        reason: 'SYCM 自定义日期模式下表格不含「同行同层均值」行（预设「1天」才有）',
        omittedFields: ['同层同行询单量'], sourceRowCount: (source.rows ?? []).length }
      : null,
    values,
    prewrite: { disposition, 询单量: before.fields?.['询单量'] ?? null,
      同层同行询单量: before.fields?.['同层同行询单量'] ?? null },
  };
  const planPath = path.join(args.outputDir, 'inquiry-backfill-plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  if (!args.commit) {
    const status = disposition === 'WRITE_REQUIRED' ? 'DRY_RUN_READY' : 'ALREADY_VERIFIED';
    console.log(JSON.stringify({ status, planPath, recordId: before.record_id, values: plan.values,
      degraded: plan.degraded }, null, 2));
    return;
  }

  // 走到这里就意味着「一定会碰一次远端表」：写回填值，或至少回读一次做结论。
  // 所以审计上下文从这里开始有意义，而 dry-run 那条分支已经 return 掉了。
  auditContext = {
    action: 'inquiry-backfill', reportDate: args.reportDate, shopName: args.shop,
    mode: plan.mode, environment: plan.environment,
    detail: { sourceShop: source.sourceShop, sourceUrl: source.url, disposition,
      values: plan.values, peerBenchmark: metrics.peerBenchmark, evidenceGeneration: resolved.generation },
  };

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
    // 没写值，但**回读过了**——也是「我做过的动作」的一种，照记（重复本身是事实）。
    await recordAudit({ ...auditContext, outcome: 'ok', recordId: after.record_id,
      detail: { ...auditContext.detail, status: disposition, wrote: false, unchangedOtherFields: true } });
    console.log(JSON.stringify({ status: disposition, recordId: after.record_id, outputDir: args.outputDir,
      values: plan.values, unchangedOtherFields: true }, null, 2));
    return;
  }
  const receipt = { ...plan, status: 'COMMITTED_AND_VERIFIED',
    writeResponseError,
    verified: { recordId: after.record_id, unchangedOtherFields: true, values: plan.values } };
  const receiptPath = path.join(args.outputDir, 'inquiry-backfill-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(attemptPath, `${JSON.stringify({ ...receipt, before, source }, null, 2)}\n`, 'utf8');
  await recordAudit({ ...auditContext, outcome: 'ok', recordId: after.record_id, receiptPath,
    detail: { ...auditContext.detail, status: receipt.status, wrote: true, unchangedOtherFields: true } });
  console.log(JSON.stringify({ status: receipt.status, receiptPath, recordId: after.record_id,
    outputDir: args.outputDir, values: plan.values, unchangedOtherFields: true }, null, 2));
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  // 失败同样是一次「我做过的动作」，而且是最需要留下痕迹的那种。
  // 只在已经建立上下文（真的走到过对外动作那一步）时才记。
  if (auditContext) {
    await recordAudit({ ...auditContext, outcome: 'failed',
      detail: { ...auditContext.detail, error: String(error?.message ?? error).slice(0, 2000) } });
  }
  process.exitCode = 1;
});
