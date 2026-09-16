#!/usr/bin/env node
// 把「小旺神 评价下载」落地的 ZIP 登记为契约合法的 FAQ 证据（评论侧）。
//
// 为什么需要这一步：与 record-faq-qa-evidence.mjs 同源——采集是浏览器驱动（点「评价下载」→ 打包 →
// ZIP 落到下载目录），而 run-faq-operator 的 inspectEvidence / run-question-library-collection 的
// readEvidence 只认证据目录里的 reviews-source.zip + reviews.csv + reviews-receipt.json。
// 「落地文件 → 证据」这一步原本没有写入方，ZIP 只躺在 Downloads 里、随时会被同名覆盖
// （小旺神文件名带时间戳，但下载目录仍会被清理）。
//
// 两段式，因为 ZIP→CSV 归一化按契约必须走 PowerShell Core 的
// skills/xws-faq-raw-collection/scripts/normalize-xws-reviews.ps1（严格 UTF-8 → GB18030 回退、
// .txt 条目按 FullName 序、流式写出，Node 侧没有 GB18030 解码）：
//   phase=prepare  复制 ZIP 进证据目录，落 reviews-receipt.pending.json
//   （外部：pwsh normalize-xws-reviews.ps1 -ZipPath ... -CsvPath ... -ReceiptPath reviews-receipt.json）
//   phase=finalize 合并 pending + ps1 收据 → reviews-receipt.json，并更新 run-status.json
//
// 契约（见 skills/xws-faq-raw-collection/references/evidence-contract.md 与
// runtime/run-question-library-collection.mjs readEvidence）：
//   sourceFile 必须是 'reviews-source.zip'；normalizedFile 必须是 'reviews.csv'；
//   sha256 对 ZIP、normalizedSha256 对 CSV；rows > 0 时 status 必须是 COMPLETED；
//   scope 五元组必须是 内容=全部 / 日期=全部 / sku=未指定 / impression=未筛选 / analysis=未调用；
//   trial.analysisCalls 必须为 0（本流程只用「评价下载」，绝不调「评价分析」）。
//
// 用法：
//   node runtime/record-faq-reviews-evidence.mjs --phase prepare \
//     --period-start 2026-09-13 --period-end 2026-09-19 --product-id 921092099640 \
//     --source "C:/Users/Administrator/Downloads/小旺神评价下载_921092099640_2026-09-16_11_20_52.zip" \
//     [--quota-remaining 300 --quota-limit 300]
//   node runtime/record-faq-reviews-evidence.mjs --phase finalize \
//     --period-start 2026-09-13 --period-end 2026-09-19 --product-id 921092099640
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const REQUIRED_SCOPE = { content: '全部', date: '全部', sku: '未指定', impression: '未筛选', analysis: '未调用' };
const VERSION = 'faq-reviews-evidence-v1';

function parseArgs(argv) {
  const options = { phase: null, quotaRemaining: null, quotaLimit: null };
  const allowed = ['--phase', '--period-start', '--period-end', '--product-id', '--source', '--quota-remaining', '--quota-limit'];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!['prepare', 'finalize'].includes(String(options.phase ?? ''))) throw new Error('--phase must be prepare or finalize');
  for (const name of ['periodStart', 'periodEnd', 'productId']) {
    if (!String(options[name] ?? '').trim()) throw new Error(`--${name.replace(/[A-Z]/gu, (c) => '-' + c.toLowerCase())} is required`);
  }
  if (options.phase === 'prepare' && !String(options.source ?? '').trim()) throw new Error('--source is required for phase=prepare');
  return options;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const options = parseArgs(process.argv.slice(2));
const period = `${options.periodStart}_${options.periodEnd}`;
const directory = resolve('runtime/question-library-collection', period, options.productId);
const receiptPath = resolve(directory, 'reviews-receipt.json');
const pendingPath = resolve(directory, 'reviews-receipt.pending.json');

if (options.phase === 'prepare') {
  const sourcePath = resolve(options.source);
  if (!existsSync(sourcePath)) throw new Error(`landed export not found: ${sourcePath}`);
  const bytes = readFileSync(sourcePath);
  if (bytes.length < 4 || bytes.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('landed export is not a ZIP archive');
  mkdirSync(directory, { recursive: true });
  const archivePath = resolve(directory, 'reviews-source.zip');
  copyFileSync(sourcePath, archivePath);
  const pending = {
    version: VERSION,
    period,
    productId: options.productId,
    sourceFilename: basename(sourcePath),
    sourceFile: 'reviews-source.zip',
    normalizedFile: 'reviews.csv',
    bytes: bytes.length,
    sha256: sha256(bytes),
    downloadedAt: new Date(statSync(sourcePath).mtimeMs).toISOString(),
    quota: options.quotaRemaining == null
      ? null
      : { remaining: Number(options.quotaRemaining), limit: options.quotaLimit == null ? null : Number(options.quotaLimit) },
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    phase: 'prepare',
    archive: archivePath,
    bytes: pending.bytes,
    sha256: pending.sha256,
    downloadedAt: pending.downloadedAt,
    next: `run skills/xws-faq-raw-collection/scripts/normalize-xws-reviews.ps1 -ZipPath "${archivePath}" -CsvPath "${resolve(directory, 'reviews.csv')}" -ReceiptPath "${receiptPath}" -ProductId ${options.productId}`,
  }, null, 2));
  process.exit(0);
}

if (!existsSync(receiptPath)) throw new Error(`missing ${receiptPath}; run normalize-xws-reviews.ps1 first`);
const normalized = JSON.parse(readFileSync(receiptPath, 'utf8'));

// finalize 必须能重跑：run-status.json 是「两份源合起来」的商品进度，问大家侧收据稍后再写一次
// 就会把评论状态冲掉，此时需要只重刷 run-status 而不重跑归一化。pending 缺失时从已有收据重建。
function loadPending() {
  if (existsSync(pendingPath)) return JSON.parse(readFileSync(pendingPath, 'utf8'));
  const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!String(existing.rawSourceFilename ?? '').trim() || !String(existing.downloadedAt ?? '').trim()) {
    throw new Error(`missing ${pendingPath} and ${receiptPath} lacks rawSourceFilename/downloadedAt; re-run --phase prepare`);
  }
  return {
    version: VERSION,
    period,
    productId: String(options.productId),
    sourceFilename: existing.rawSourceFilename,
    sourceFile: 'reviews-source.zip',
    normalizedFile: 'reviews.csv',
    sha256: existing.sha256,
    downloadedAt: existing.downloadedAt,
    quota: existing.quota ?? null,
  };
}
const pending = loadPending();

const archiveBytes = readFileSync(resolve(directory, 'reviews-source.zip'));
const csvBytes = readFileSync(resolve(directory, 'reviews.csv'));
const archiveHash = sha256(archiveBytes);
const csvHash = sha256(csvBytes);
if (archiveHash !== pending.sha256) throw new Error('reviews-source.zip changed since prepare (hash mismatch)');
if (String(normalized.sha256 ?? '') !== archiveHash) throw new Error(`ps1 receipt archive hash mismatch: ${normalized.sha256}`);
if (String(normalized.normalizedSha256 ?? '') !== csvHash) throw new Error(`ps1 receipt normalized hash mismatch: ${normalized.normalizedSha256}`);
if (String(normalized.productId ?? '') !== String(options.productId)) throw new Error('ps1 receipt product identity mismatch');
if (Number(normalized.rows ?? 0) <= 0) throw new Error('normalized reviews.csv has zero rows; nothing to register');

const receipt = {
  version: VERSION,
  period,
  source: '评论',
  status: 'COMPLETED',
  productId: String(options.productId),
  sourceFile: 'reviews-source.zip',
  normalizedFile: 'reviews.csv',
  rawSourceFilename: pending.sourceFilename,
  downloadedAt: pending.downloadedAt,
  sha256: archiveHash,
  normalizedSha256: csvHash,
  entries: Number(normalized.entries ?? 0),
  rows: Number(normalized.rows ?? 0),
  excludedEntries: Number(normalized.excludedEntries ?? 0),
  deterministicOrder: normalized.deterministicOrder ?? 'FullName ordinal ascending; .txt entries only',
  // 采集口径：只点「评价下载」，不调「评价分析」。
  scope: { ...REQUIRED_SCOPE },
  trial: {
    used: '评价下载',
    analysisCalls: 0,
    observed: pending.quota ? `下载后页面观测 剩余: ${pending.quota.remaining} / ${pending.quota.limit}` : '未在收据中报告',
  },
  quota: pending.quota,
  recordedAt: new Date().toISOString(),
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

const runStatusPath = resolve(directory, 'run-status.json');
const runStatus = existsSync(runStatusPath) ? JSON.parse(readFileSync(runStatusPath, 'utf8')) : { version: 'faq-run-status-v1', period, productId: String(options.productId), sources: {} };
runStatus.state = 'COMPLETED';
runStatus.updatedAt = receipt.recordedAt;
runStatus.sources = { ...(runStatus.sources ?? {}), 评论: 'COMPLETED' };
runStatus.state = Object.values(runStatus.sources).every((value) => value === 'COMPLETED') ? 'COMPLETED' : 'IN_PROGRESS';
writeFileSync(runStatusPath, `${JSON.stringify(runStatus, null, 2)}\n`, 'utf8');
if (existsSync(pendingPath)) unlinkSync(pendingPath);

console.log(JSON.stringify({ phase: 'finalize', status: receipt.status, receiptPath, entries: receipt.entries, rows: receipt.rows, excludedEntries: receipt.excludedEntries, sha256: archiveHash, normalizedSha256: csvHash }, null, 2));
