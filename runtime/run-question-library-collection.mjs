#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { buildQuestionRecord, normalizeExportRows, selectTopABCompetitors } from './question-library-core.mjs';

const DEFAULT_ENV_FILE = 'E:/小红书/.env.local';
const BASE_URL_PATTERN = /\/base\/([^?/#]+)/u;
const PRODUCT_ID_PATTERN = /[?&]id=(\d+)/u;
const TABLE_NAME_PATTERN = /^问题库_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const MANIFEST_PRODUCT_FIELDS = ['productId', 'mainRecordId', 'weeklyRecordId', 'productUrl', 'productTitle', 'classification', 'validity', 'monthlyReceived', 'rank'];

function text(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function parseEnvFile(path) {
  const values = {};
  for (const raw of requireFile(path).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return readFileSync(path, 'utf8');
}

export function parseCsv(input) {
  const source = String(input ?? '').replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => text(value))) rows.push(row);
      row = [];
    } else cell += character;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => text(value))) rows.push(row); }
  if (rows.length < 1) return [];
  const headers = rows.shift().map((value, index) => text(value) || `列${index + 1}`);
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function productId(fields) {
  const direct = text(fields.商品ID);
  if (direct) return direct;
  return text(fields.商品链接).match(PRODUCT_ID_PATTERN)?.[1] ?? '';
}

export function buildCollectionPlan({ weeklyRecords, mainRecords, period, limit = 5 }) {
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u.test(period)) throw new Error('period must be YYYY-MM-DD_YYYY-MM-DD');
  const mainByProduct = new Map(mainRecords.map((record) => [productId(record.fields ?? {}), record]).filter(([id]) => id));
  const selected = selectTopABCompetitors(weeklyRecords, { limit });
  // 运营口径：高质量竞品不是每周都有。凑不满 5 个属正常空档，不得抛错阻断流程；
  // 0 个则产出空清单，由下游按“本周无合格标的、不采集”处理。
  if (selected.length > limit) {
    throw new Error(`Expected at most ${limit} valid A/B competitors with formula monthly values; received ${selected.length}`);
  }
  const products = selected.map((weekly) => {
    const fields = weekly.fields ?? {};
    const id = productId(fields);
    const main = mainByProduct.get(id);
    if (!main) throw new Error(`No master record for weekly product ${id}`);
    return {
      productId: id,
      mainRecordId: main.recordId,
      weeklyRecordId: weekly.recordId,
      productUrl: text(fields.商品链接),
      productTitle: text(fields.商品标题),
      classification: text(fields.竞品分类),
      validity: text(fields.是否有效竞品),
      monthlyReceived: Number(fields.月收货人数计算值),
      rank: Number(fields.序号),
      competitor: { recordId: main.recordId, fields: { ...fields, 商品ID: id, 主表记录ID: main.recordId, 竞品周记录ID: weekly.recordId } },
    };
  });
  return {
    period,
    limit,
    products,
    candidateCount: selected.length,
    outcome: selected.length === 0
      ? 'NO_QUALIFIED_CANDIDATES'
      : selected.length < limit ? 'PARTIAL_CANDIDATES' : 'OK',
  };
}

export function assertManifestMatches(manifest, plan) {
  if (!manifest || manifest.period !== plan.period || !Array.isArray(manifest.products)) throw new Error('TOP5 manifest mismatch: period or products missing');
  if (manifest.products.length !== plan.products.length) throw new Error('TOP5 manifest mismatch: product count changed');
  for (let index = 0; index < plan.products.length; index += 1) {
    const expected = manifest.products[index];
    const actual = plan.products[index];
    for (const field of MANIFEST_PRODUCT_FIELDS) {
      if (text(expected?.[field]) !== text(actual?.[field])) throw new Error(`TOP5 manifest mismatch at index ${index}: ${field}`);
    }
  }
}

export function buildRecordsFromEvidence({ plan, evidenceByProduct, collectedAt }) {
  const records = [];
  for (const product of plan.products) {
    const evidence = evidenceByProduct?.[product.productId];
    if (!evidence?.qa || !evidence?.reviews) throw new Error(`Missing QA or review evidence for product ${product.productId}`);
    let productRecordCount = 0;
    for (const [sourceType, source] of [['问大家', evidence.qa], ['评论', evidence.reviews]]) {
      if (!text(source.sourceHash)) throw new Error(`Missing source hash for ${product.productId} ${sourceType}`);
      const normalized = normalizeExportRows(sourceType, source.rows);
      for (const row of normalized) records.push(buildQuestionRecord({
        period: plan.period,
        competitor: product.competitor,
        sourceType,
        rawContent: row.rawContent,
        sourceHash: source.sourceHash,
        sourceRowNumber: row.sourceRowNumber,
        collectedAt,
      }));
      productRecordCount += normalized.length;
    }
    if (productRecordCount === 0) {
      // 下架/页面不可用商品允许显式 0 行：两份 receipt 均须标记 EMPTY_SOURCE_ROWS
      // 且写明不可采集原因，防止把普通空跑误标成完成（fail-closed 缺省仍是抛错）。
      const vacuous = [evidence.qa, evidence.reviews].every((source) =>
        text(source.receipt?.status) === 'EMPTY_SOURCE_ROWS' && text(source.receipt?.unavailableReason));
      if (!vacuous) throw new Error(`No non-empty raw rows for product ${product.productId}`);
    }
  }
  return records;
}

function hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function parseCliArgs(argv) {
  const options = { envFile: DEFAULT_ENV_FILE, limit: 5, apply: false };
  const valueOptions = new Map([
    ['--base-url', 'baseUrl'], ['--env-file', 'envFile'], ['--period-start', 'periodStart'],
    ['--period-end', 'periodEnd'], ['--evidence-root', 'evidenceRoot'], ['--output-dir', 'outputDir'],
    ['--confirm-app-token', 'confirmAppToken'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--limit') { options.limit = Number(argv[++index]); }
    else if (valueOptions.has(arg)) { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`); options[valueOptions.get(arg)] = value; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const name of ['baseUrl', 'periodStart', 'periodEnd']) if (!text(options[name])) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  if (!Number.isInteger(options.limit) || options.limit !== 5) throw new Error('--limit is fixed at 5 for this collection');
  options.period = `${options.periodStart}_${options.periodEnd}`;
  if (options.apply && (!options.evidenceRoot || !options.confirmAppToken)) throw new Error('--apply requires --evidence-root and --confirm-app-token');
  const appToken = options.baseUrl.match(BASE_URL_PATTERN)?.[1];
  if (!appToken) throw new Error('--base-url must contain /base/<app-token>');
  if (options.confirmAppToken && options.confirmAppToken !== appToken) throw new Error('--confirm-app-token does not match Base URL');
  return { ...options, appToken };
}

export async function readEvidence(root, productId) {
  const directory = resolve(root, productId);
  const qaPath = resolve(directory, 'qa.csv');
  const qaReceiptPath = resolve(directory, 'qa-receipt.json');
  const reviewsPath = resolve(directory, 'reviews.csv');
  const reviewsSourcePath = resolve(directory, 'reviews-source.zip');
  const reviewsReceiptPath = resolve(directory, 'reviews-receipt.json');
  const qaBytes = await readFile(qaPath);
  const reviewsBytes = await readFile(reviewsPath);
  if (!existsSync(qaReceiptPath) || !existsSync(reviewsReceiptPath)) throw new Error(`Missing source receipt for product ${productId}`);
  const qaReceipt = JSON.parse(await readFile(qaReceiptPath, 'utf8'));
  const reviewsReceipt = JSON.parse(await readFile(reviewsReceiptPath, 'utf8'));
  if (text(qaReceipt.productId) !== String(productId) || text(reviewsReceipt.productId) !== String(productId)) throw new Error(`Receipt product identity mismatch: ${productId}`);
  if (text(qaReceipt.sourceFile) !== 'qa.csv') throw new Error(`QA receipt source file mismatch: ${productId}`);
  if (text(reviewsReceipt.sourceFile) !== 'reviews-source.zip' || text(reviewsReceipt.normalizedFile) !== 'reviews.csv') throw new Error(`Review receipt source file mismatch: ${productId}`);
  if (reviewsReceipt.trial?.analysisCalls && Number(reviewsReceipt.trial.analysisCalls) !== 0) throw new Error(`Review analysis was called for ${productId}`);
  const scope = reviewsReceipt.scope;
  if (scope && (scope.content !== '全部' || scope.date !== '全部' || scope.sku !== '未指定' || scope.impression !== '未筛选' || scope.analysis !== '未调用')) throw new Error(`Review scope mismatch: ${productId}`);
  const qaHash = hashBytes(qaBytes);
  const reviewHash = hashBytes(reviewsBytes);
  if (text(qaReceipt.sha256) && text(qaReceipt.sha256) !== qaHash) throw new Error(`QA receipt hash mismatch: ${productId}`);
  if (!existsSync(reviewsSourcePath)) throw new Error(`Missing raw review archive: ${reviewsSourcePath}`);
  const reviewsSourceBytes = await readFile(reviewsSourcePath);
  if (reviewsSourceBytes.length < 4 || reviewsSourceBytes.subarray(0, 2).toString('ascii') !== 'PK') throw new Error(`Invalid review archive: ${reviewsSourcePath}`);
  if (text(reviewsReceipt.sha256) && text(reviewsReceipt.sha256) !== hashBytes(reviewsSourceBytes)) throw new Error(`Review archive receipt hash mismatch: ${productId}`);
  if (text(reviewsReceipt.normalizedSha256) && text(reviewsReceipt.normalizedSha256) !== reviewHash) throw new Error(`Review normalized hash mismatch: ${productId}`);
  const qaRows = parseCsv(qaBytes.toString('utf8'));
  const reviewRows = parseCsv(reviewsBytes.toString('utf8'));
  if (qaRows.length === 0 && text(qaReceipt.status) !== 'EMPTY_SOURCE_ROWS') throw new Error(`Empty QA source is not explicitly verified: ${productId}`);
  if (reviewRows.length === 0) {
    // 下架/页面不可用商品：0 行评论必须显式标记 EMPTY_SOURCE_ROWS 并写明原因。
    if (text(reviewsReceipt.status) !== 'EMPTY_SOURCE_ROWS' || !text(reviewsReceipt.unavailableReason)) {
      throw new Error(`Review source is not complete: ${productId}`);
    }
  } else if (text(reviewsReceipt.status) !== 'COMPLETED') {
    throw new Error(`Review source is not complete: ${productId}`);
  }
  return {
    qa: { sourceFile: 'qa.csv', sourceHash: qaHash, rows: qaRows, receipt: qaReceipt },
    reviews: {
      sourceFile: 'reviews-source.zip',
      sourceHash: hashBytes(reviewsSourceBytes),
      normalizedFile: 'reviews.csv',
      normalizedHash: reviewHash,
      rows: reviewRows,
      receipt: reviewsReceipt,
    },
  };
}


export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const env = parseEnvFile(resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await client.authenticate();
  const tables = await client.listTables();
  const weeklyTable = tables.find((table) => table.name === `竞品周_${options.period}`);
  const mainTable = tables.find((table) => table.name === '竞品主表');
  if (!weeklyTable || !mainTable) throw new Error(`Missing source tables for period ${options.period}`);
  const [weeklyRecords, mainRecords] = await Promise.all([client.listRecords(weeklyTable.tableId), client.listRecords(mainTable.tableId)]);
  const plan = buildCollectionPlan({ weeklyRecords, mainRecords, period: options.period, limit: options.limit });
  const outputDir = resolve(options.outputDir ?? `runtime/question-library-collection/${options.period}`);
  await mkdir(outputDir, { recursive: true });
  const manifestPath = resolve(outputDir, 'top5-manifest.json');
  const manifest = { ...plan, products: plan.products.map(({ competitor, ...product }) => product) };
  if (existsSync(manifestPath)) {
    const locked = JSON.parse(await readFile(manifestPath, 'utf8'));
    assertManifestMatches(locked, plan);
  } else {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'TOP5_LOCKED', outputDir, period: options.period, products: plan.products.map(({ competitor, ...product }) => product) }, null, 2));
    return;
  }
  const evidenceByProduct = {};
  for (const product of plan.products) evidenceByProduct[product.productId] = await readEvidence(options.evidenceRoot, product.productId);
  const records = buildRecordsFromEvidence({ plan, evidenceByProduct, collectedAt: new Date().toISOString() });
  const rawLines = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const rawPath = resolve(outputDir, 'raw-records.jsonl');
  const rawHash = hashBytes(Buffer.from(rawLines, 'utf8'));
  if (existsSync(rawPath)) {
    const existingBytes = await readFile(rawPath);
    if (hashBytes(existingBytes) !== rawHash) throw new Error('Existing local raw snapshot differs from current evidence');
  } else {
    await writeFile(rawPath, rawLines, 'utf8');
  }
  const receipt = {
    mode: 'APPLIED_AND_VERIFIED',
    period: options.period,
    snapshot: { path: rawPath, sha256: rawHash, format: 'jsonl' },
    top5: plan.products.map(({ competitor, ...product }) => product),
    sourceRecords: records.length,
    dedupKeys: records.map((record) => record.crossWeekDedupKey),
    analysisFieldsWritten: false,
    feishuWrites: 0,
  };
  await writeFile(resolve(outputDir, 'raw-snapshot-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
