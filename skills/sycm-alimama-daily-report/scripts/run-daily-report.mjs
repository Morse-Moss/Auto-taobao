#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../../runtime/feishu-targets.mjs';
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import { appendAudit, describeAuditRow } from '../../../runtime/daily-report-audit.mjs';
import { buildCombinedFields, reportDateEpoch, summarizeSourceDates, valuesEqual } from './daily-report-core.mjs';
import { buildEnvironment, dirHasEntries, resolveEvidenceDir } from './daily-report-runtime.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');
const DEFAULTS = Object.freeze({
  // 端口来自 runtime/browser-ports.mjs（唯一来源）；这里是日报链的商家号代理。
  proxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
  appToken: TARGET.baseToken,
  tableId: TARGET.sourceTable,
  viewId: TARGET.sourceView,
  // 期望的 base 名。**刻意不提供 --base-name 覆盖口**：这个值的用途正是「防手填参数造成假绿灯」，
  // 再给它一个命令行入口就等于把守卫自己拆了。要换 base 就改 config/feishu 配置层那一个地方。
  expectedBaseName: TARGET.sourceBaseName,
});

function parseArgs(argv) {
  const args = { ...DEFAULTS, commit: false, verifyExisting: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--commit') args.commit = true;
    else if (key === '--verify-existing') args.verifyExisting = true;
    else if (key === '--expected-before-count') args.expectedBeforeCount = Number(argv[++index]);
    else if (key === '--shop-xlsx') args.shopXlsx = argv[++index];
    else if (key === '--promotion-zip') args.promotionZip = argv[++index];
    else if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--app-token') args.appToken = argv[++index];
    else if (key === '--table-id') args.tableId = argv[++index];
    else if (key === '--view-id') args.viewId = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${key}`);
  }
  for (const required of ['shopXlsx', 'promotionZip', 'reportDate']) {
    if (!args[required]) throw new Error(`missing required argument: ${required}`);
  }
  args.shopXlsx = path.resolve(args.shopXlsx);
  args.promotionZip = path.resolve(args.promotionZip);
  if (!existsSync(args.shopXlsx)) throw new Error(`shop workbook not found: ${args.shopXlsx}`);
  if (!existsSync(args.promotionZip)) throw new Error(`promotion ZIP not found: ${args.promotionZip}`);
  // 证据目录的**代次**不在这里决定（要等知道上一次跑过没有）；这里只记「调用方有没有明说」。
  args.outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  if (args.commit && args.verifyExisting) throw new Error('--commit and --verify-existing are mutually exclusive');
  if (args.verifyExisting && !Number.isInteger(args.expectedBeforeCount)) {
    throw new Error('--verify-existing requires --expected-before-count');
  }
  return args;
}

// 产物落哪一代（同一天重跑不再覆盖上一轮）：判据与实现都在 daily-report-runtime.mjs，
// 询单回填用的是同一个「目录里有没有东西」，不许有两份实现。
function resolveOutputDir(args) {
  const baseDir = path.join(REPO_ROOT, 'evidence', `daily-report-${args.reportDate}`);
  // 干跑与 `--commit` 是**同一次运行的两个阶段**：干跑建了哪一代，提交就并进哪一代。
  // 用默认的 'fresh' 会把一次运行的 plan/paste 与 receipt 拆到两个目录（2026-09-17 实测：
  // 干跑落 `-rerun4`、提交又顺延到 `-rerun5`），也和回填/回读用 'latest' 的规矩不一致。
  return resolveEvidenceDir({ baseDir, explicit: args.outputDir, isOccupied: dirHasEntries,
    policy: args.commit ? 'latest' : 'fresh' });
}

async function inspectTarget(args) {
  const targets = await fetch(`${args.proxy}/targets`).then(response => response.json());
  const matches = targets.filter(target => target.type === 'page' && target.url.includes(`/base/${args.appToken}`));
  if (matches.length !== 1) throw new Error(`expected one Feishu page for target base, got ${matches.length}`);
  const page = matches[0];
  const url = new URL(page.url);
  if (url.searchParams.get('table') !== args.tableId || url.searchParams.get('view') !== args.viewId) {
    throw new Error(`Feishu page is not on authorized table/view: ${page.url}`);
  }
  const expression = `(() => {
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu bitable model is not ready');
    const table = Object.values(base.tables || {}).find(item => item?.id === ${JSON.stringify(args.tableId)});
    const view = Object.values(table?.views || {}).find(item => item?.id === ${JSON.stringify(args.viewId)});
    if (!table || !view) throw new Error('authorized table/view is not loaded');
    const fields = Object.fromEntries(Object.values(table.fields || {}).filter(Boolean).map(field => [field.id, {
      id: field.id, name: field.name, type: field.type
    }]));
    const visibleIds = view._visibleFieldIds || view.property?.fields || [];
    return JSON.stringify({baseName: base.name, tableName: table.name, recordsNum: table.recordsNum,
      fields: visibleIds.map(id => fields[id])});
  })()`;
  const response = await fetch(`${args.proxy}/eval?target=${encodeURIComponent(page.targetId)}`, {
    method: 'POST', body: expression,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Feishu schema eval failed: HTTP ${response.status}`);
  const target = JSON.parse(payload.value);
  // base 名的第二因子断言。原先这里写死的是 '各店铺日报副本' —— 那正是 2026-09-18 查出来的坑：
  // 配置指向的是副本 base，而运营的 12 家店历史在另一个同名的「各店铺日报」里，两边同名表 6 张
  // 逐表行数与字段签名完全一样，肉眼分辨不出来。写死的名字只是「当时那条结论的快照」，
  // 它不会随配置一起被改，换 base 时它才是第一个炸的地方（而且是在浏览器里炸）。
  // 现在期望值来自配置层同一个对象 —— id 与名字要错一起错，不可能只改一个。
  //
  // 去空格再比：接口读回的名字有尾随空格（「各店铺日报 」）和中间空格（「各店铺日报  副本」），
  // 这种看不见的东西不该决定写入的是哪一张 base。
  const normalizeBaseName = value => String(value ?? '').replaceAll(' ', '');
  if (normalizeBaseName(target.baseName) !== normalizeBaseName(args.expectedBaseName)
    || target.tableName !== '总数据来源底单') {
    throw new Error('unexpected Feishu target identity: '
      + `${JSON.stringify(target.baseName)} / ${target.tableName}`
      + `（期望 base 名 ${JSON.stringify(args.expectedBaseName)}／表名 总数据来源底单）`);
  }
  return target;
}

function extractSources(args) {
  const python = process.env.SYCM_PYTHON || 'py';
  const pythonArgs = path.basename(python).toLowerCase() === 'py' ? ['-3'] : [];
  pythonArgs.push(path.join(SCRIPT_DIR, 'extract-sources.py'), '--shop-xlsx', args.shopXlsx,
    '--promotion-zip', args.promotionZip, '--date', args.reportDate);
  const result = spawnSync(python, pythonArgs, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0) throw new Error(`source extraction failed: ${result.stderr || result.stdout}`.trim());
  return JSON.parse(result.stdout);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// 「这次是在什么环境里跑的」原先只在本文件实现，收据里一个字都没有 —— 后来的代价见
// ./daily-report-runtime.mjs 的说明（浏览器实际跑在退役端口上，却无法从任何产物自证）。
// 现在这份实现搬进了那个模块：询单回填是同一条链的第二个写入方，它对同一件事必须给同一个答案。
function buildRunEnvironment(args) {
  return buildEnvironment({
    proxyUrl: args.proxy,
    ports: { browser: PROJECT_PORTS.dailyReportBrowser, proxy: PROJECT_PORTS.dailyReportProxy },
    identities: { id: BROWSER_IDS.dailyReport, label: BROWSER_LABELS.dailyReport },
  });
}

// 下载后置自证：数据不是目标日那天的，就不进这条链。
//
// 必须在 buildCombinedFields **之前**跑：那层字段映射也会对日期做等值断言，但它先撞上，
// 报出来的是 `unexpected 关键词推广 identity/date: 2026-09-15 / 371 / 关键词推广` ——
// 不说是哪个文件，得靠人回翻自己刚下载了什么。这里带文件名和两侧观察到的日期。
function assertSourceDates(source, args) {
  const selfCheck = summarizeSourceDates(source, args.reportDate);
  if (!selfCheck.allMatchDate) {
    throw new Error(
      `source date self-check failed for ${args.reportDate}`
      + `（shop=${JSON.stringify(selfCheck.shop)} ← ${path.basename(args.shopXlsx)}`
      + `；promotion=${JSON.stringify(selfCheck.promotion)} ← ${path.basename(args.promotionZip)}）`,
    );
  }
  return selfCheck;
}

function buildPlan(args, target, source, fields, sourceSelfChecks, evidence) {
  return {
    mode: args.commit ? 'api-commit' : args.verifyExisting ? 'verify-existing' : 'dry-run',
    reportDate: args.reportDate,
    environment: buildRunEnvironment(args),
    // 产物落在哪一代：同一天重跑不再覆盖上一轮，收据自己说得出这一点。
    evidence,
    sourceSelfChecks,
    target: { appToken: args.appToken, tableId: args.tableId, viewId: args.viewId,
      baseName: target.baseName, tableName: target.tableName },
    source: {
      shopFile: args.shopXlsx, shopSha256: sha256(args.shopXlsx), shopWorkbookRows: source.shop.workbookRows,
      promotionFile: args.promotionZip, promotionSha256: sha256(args.promotionZip),
      promotionCsv: source.promotion.csvName,
    },
    checks: {
      visibleFields: target.fields.length,
      shopColumns: source.shop.headers.length,
      promotionColumns: source.promotion.headers.length,
      promotionRows: source.promotion.rows.length,
      payloadFields: Object.keys(fields).length,
      shopName: fields['店铺名称'],
      keywordSceneId: fields['场景ID'],
      audienceSceneId: fields['场景ID (1)'],
      dateEpoch: reportDateEpoch(args.reportDate),
      targetOnlyPromotionFieldsBlank: ['原二级场景ID', '原二级场景名字', '原二级场景ID (1)', '原二级场景名字 (1)']
        .every(name => !Object.hasOwn(fields, name)),
    },
    fields,
  };
}

// 「店铺」是飞书侧的派生字段，写入后由服务端异步算出来：
// 紧随创建的 listRecords 可能还读不到它（实测：记录已创建且 265 个字段全对，但 店铺 仍是 []）。
// 这属于「写入成功、回读太快」，不该当成写入失败，所以这里给一个有界重试；
// 但预算耗尽后仍然如实报错——不是「重试到成功为止」（那等于把断言变成恒真）。
const DERIVED_FIELD = '店铺';
const DERIVED_READBACK = Object.freeze({ attempts: 6, delayMs: 1500 });

function delay(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

function verifyRecordFields(created, fields, target) {
  const fieldsByName = new Map(target.fields.map(field => [field.name, field]));
  const mismatches = Object.entries(fields).filter(([name, expected]) =>
    !valuesEqual(expected, created.fields?.[name], fieldsByName.get(name)));
  if (mismatches.length) {
    throw new Error(`readback mismatch in fields: ${mismatches.slice(0, 10).map(([name]) => name).join(', ')}`);
  }
  const blankPromotionFields = ['原二级场景ID', '原二级场景名字', '原二级场景ID (1)', '原二级场景名字 (1)'];
  if (blankPromotionFields.some(name => created.fields?.[name] !== null && created.fields?.[name] !== undefined)) {
    throw new Error('target-only promotion fields did not remain blank');
  }
  return Object.keys(fields).length;
}

// 只重读「店铺」这一个派生字段，其余字段以最后一次读到的快照为准。
async function rereadUntilDerivedShop(client, recordId, options = {}) {
  const attempts = options.attempts ?? DERIVED_READBACK.attempts;
  const delayMs = options.delayMs ?? DERIVED_READBACK.delayMs;
  const trace = [];
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const records = await client.listRecords();
    const created = records.find(record => record.record_id === recordId);
    if (!created) throw new Error(`created record not found on reread: ${recordId}`);
    last = created;
    const derived = created.fields?.[DERIVED_FIELD];
    if (Array.isArray(derived) && derived.length === 1) return { created, attempts: attempt, trace, records };
    trace.push({ attempt, derived: derived ?? null });
    if (attempt < attempts) await delay(delayMs);
  }
  const error = new Error(`derived field ${DERIVED_FIELD} was not populated after ${attempts} rereads `
    + `(last=${JSON.stringify(last?.fields?.[DERIVED_FIELD] ?? null)}); the record itself exists: ${recordId}`);
  error.trace = trace;
  throw error;
}

function buildPasteTsv(fields, visibleFields, reportDate) {
  const cells = visibleFields.map((field) => {
    if (!Object.hasOwn(fields, field.name)) return '';
    const value = field.type === 5 ? reportDate : String(fields[field.name]);
    if (/[\t\r\n]/u.test(value)) throw new Error(`field cannot be represented in TSV: ${field.name}`);
    return value;
  });
  if (cells.length !== 265) throw new Error(`paste row must contain 265 cells, got ${cells.length}`);
  return `${cells.join('\t')}\n`;
}

// 审计上下文：只有「真的动了外部系统」的路径才建立（dry-run 什么都不记 —— 它没发生）。
// 模块级是为了让顶层 catch 也能把失败记下来：失败同样是一次「我做过的动作」。
let auditContext = null;

// 写审计。**只打印、不改变结果**：数据已经进飞书了，本地旁证写不进去不该把成功判成失败。
// 表结构与语义边界见 db/migrations/007-daily-report-push-audit.sql。
async function recordAudit(entry) {
  const row = describeAuditRow(entry);
  const result = await appendAudit(row);
  if (result.written) console.log(`[audit] 已记 ${row.action}/${row.outcome} id=${result.id}`);
  else console.error(`[audit] 未写入（不影响本次结论）：${result.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 先定产物落哪一代，再动任何东西：同一天第二次跑会顺延到 -rerun2，而不是覆盖上一轮。
  const resolved = resolveOutputDir(args);
  args.outputDir = resolved.dir;
  const target = await inspectTarget(args);
  const source = extractSources(args);
  const sourceSelfChecks = assertSourceDates(source, args);
  const fields = buildCombinedFields(source, target.fields, args.reportDate);
  const evidence = { outputDir: args.outputDir, generation: resolved.generation, reason: resolved.reason };
  const plan = buildPlan(args, target, source, fields, sourceSelfChecks, evidence);
  mkdirSync(args.outputDir, { recursive: true });
  const planPath = path.join(args.outputDir, 'plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  const tsvPath = path.join(args.outputDir, 'paste.tsv');
  writeFileSync(tsvPath, buildPasteTsv(fields, target.fields, args.reportDate), 'utf8');

  // 审计上下文（dry-run 为 null：没有对外动作，没什么可记的）。放在这里是因为
  // 到这一步才有 reportDate/店铺/源文件哈希/环境这四样东西。
  const auditBase = {
    reportDate: args.reportDate,
    shopName: fields['店铺名称'],
    mode: plan.mode,
    source: {
      shopFile: plan.source.shopFile, shopSha256: plan.source.shopSha256,
      promotionFile: plan.source.promotionFile, promotionSha256: plan.source.promotionSha256,
    },
    environment: plan.environment,
  };
  auditContext = args.verifyExisting ? { ...auditBase, action: 'ui-verify' }
    : args.commit ? { ...auditBase, action: 'push' }
      : null;

  const clientModule = await import(pathToFileURL(path.join(REPO_ROOT, 'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')));
  const credentials = loadFeishuCredentials('kcne');
  const client = new clientModule.FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret,
    appToken: args.appToken, tableId: args.tableId });
  const tables = await client.listTables();
  if (!tables.some(table => table.tableId === args.tableId && table.name === '总数据来源底单')) {
    throw new Error('Feishu API target identity check failed');
  }
  const before = await client.listRecords();
  const epoch = reportDateEpoch(args.reportDate);
  const duplicates = before.filter(record => Number(record.fields?.['统计日期']) === epoch
    && record.fields?.['店铺名称'] === fields['店铺名称']);
  if (args.verifyExisting) {
    if (before.length !== args.expectedBeforeCount + 1) {
      throw new Error(`record count mismatch for UI import: expected ${args.expectedBeforeCount + 1}, got ${before.length}`);
    }
    if (duplicates.length !== 1) throw new Error(`expected one imported row, got ${duplicates.length}`);
    const settled = await rereadUntilDerivedShop(client, duplicates[0].record_id);
    const created = settled.created;
    const verifiedFields = verifyRecordFields(created, fields, target);
    const receipt = { ...plan, status: 'UI_COMMITTED_AND_VERIFIED', recordId: created.record_id,
      recordCountBefore: args.expectedBeforeCount, recordCountAfter: before.length, verifiedFields,
      derivedShop: created.fields[DERIVED_FIELD], derivedReadbackAttempts: settled.attempts,
      derivedReadbackTrace: settled.trace };
    const receiptPath = path.join(args.outputDir, 'receipt.json');
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await recordAudit({ ...auditContext, outcome: 'ok', recordId: created.record_id,
      recordCountBefore: args.expectedBeforeCount, recordCountAfter: before.length, verifiedFields, receiptPath,
      detail: { status: receipt.status, derivedReadbackAttempts: settled.attempts } });
    console.log(JSON.stringify({ status: receipt.status, recordId: created.record_id, receiptPath,
      outputDir: args.outputDir, evidenceGeneration: resolved.generation,
      recordCountBefore: args.expectedBeforeCount, recordCountAfter: before.length, verifiedFields,
      derivedReadbackAttempts: settled.attempts, checks: plan.checks }, null, 2));
    return;
  }
  if (duplicates.length) throw new Error(`duplicate daily report row exists: ${duplicates.map(item => item.record_id).join(', ')}`);

  if (!args.commit) {
    console.log(JSON.stringify({ status: 'DRY_RUN_READY', planPath, tsvPath,
      outputDir: args.outputDir, evidenceGeneration: resolved.generation,
      recordCount: before.length, checks: plan.checks }, null, 2));
    return;
  }

  const [recordId] = await client.batchCreateRecords([fields]);
  const settled = await rereadUntilDerivedShop(client, recordId);
  const after = settled.records;
  if (after.length !== before.length + 1) throw new Error(`record count mismatch after create: ${before.length} -> ${after.length}`);
  const created = settled.created;
  const verifiedFields = verifyRecordFields(created, fields, target);
  const receipt = { ...plan, status: 'COMMITTED_AND_VERIFIED', recordId,
    recordCountBefore: before.length, recordCountAfter: after.length, verifiedFields,
    derivedShop: created.fields[DERIVED_FIELD], derivedReadbackAttempts: settled.attempts,
    derivedReadbackTrace: settled.trace };
  const receiptPath = path.join(args.outputDir, 'receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await recordAudit({ ...auditContext, outcome: 'ok', recordId, recordCountBefore: before.length,
    recordCountAfter: after.length, verifiedFields, receiptPath,
    detail: { status: receipt.status, derivedReadbackAttempts: settled.attempts } });
  console.log(JSON.stringify({ status: receipt.status, recordId, receiptPath,
    outputDir: args.outputDir, evidenceGeneration: resolved.generation,
    recordCountBefore: before.length, recordCountAfter: after.length, verifiedFields,
    derivedReadbackAttempts: settled.attempts, checks: plan.checks }, null, 2));
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  // 失败也是一次「我做过的动作」——而且是最需要留下痕迹的那种。
  // 只有在已经建立上下文（即真的走到过对外动作那一步）时才记。
  if (auditContext) {
    await recordAudit({ ...auditContext, outcome: 'failed',
      detail: { error: String(error?.message ?? error).slice(0, 2000) } });
  }
  process.exitCode = 1;
});
