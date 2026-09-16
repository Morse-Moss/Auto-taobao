#!/usr/bin/env node
// 把「小旺神 问大家 导出」的落地 CSV 登记为契约合法的 FAQ 证据。
//
// 为什么需要这一步：skills/xws-faq-raw-collection 的采集是浏览器驱动的（点菜单 → 导出 → 文件落到
// 下载目录），而 run-faq-operator 的 inspectEvidence 只认证据目录里的 qa-receipt.json + qa.csv。
// 「落地文件 → 证据」这一步原本没有写入方，落地文件只躺在 Downloads 里、随时会被覆盖（小旺神
// 会给重名文件加 (2)(3) 后缀），所以必须显式登记。
//
// 契约（见 skills/xws-faq-raw-collection/references/evidence-contract.md）：
//   status ∈ {COMPLETED, EMPTY_SOURCE_ROWS}；EMPTY_SOURCE_ROWS 仅当页面明确说无数据；
//   收据需含 商品身份 / 来源类型 / 原始文件名 / 原始 sha256 / 下载时间 / 行数 / 选取口径 / 额度观测。
//   本脚本只登记 qa.csv（问大家不需要归一化）；评论侧走 reviews-source.zip + normalize-xws-reviews.ps1。
//
// 用法：
//   node runtime/record-faq-qa-evidence.mjs --period-start 2026-09-13 --period-end 2026-09-19 \
//     --product-id 921092099640 --source "C:/Users/Administrator/Downloads/小旺神 (3).csv" \
//     [--quota-remaining 299 --quota-limit 300] [--scope 全部]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function parseArgs(argv) {
  const options = { scope: '全部', quotaRemaining: null, quotaLimit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--period-start', '--period-end', '--product-id', '--source', '--scope', '--quota-remaining', '--quota-limit'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const name of ['periodStart', 'periodEnd', 'productId', 'source']) {
    if (!String(options[name] ?? '').trim()) throw new Error(`--${name.replace(/[A-Z]/gu, (c) => '-' + c.toLowerCase())} is required`);
  }
  return options;
}

// 小旺神导出的 CSV 是 UTF-8 BOM + 单层引号转义；这里只做「有几行真实数据」的忠实计数。
function countRows(text) {
  const body = text.replace(/^\uFEFF/u, '');
  const lines = body.split(/\r?\n/u).filter((line) => line.trim() !== '');
  return { header: lines[0] ?? '', dataRows: Math.max(0, lines.length - 1) };
}

const options = parseArgs(process.argv.slice(2));
const period = `${options.periodStart}_${options.periodEnd}`;
const sourcePath = resolve(options.source);
if (!existsSync(sourcePath)) throw new Error(`landed export not found: ${sourcePath}`);

const bytes = readFileSync(sourcePath);
if (bytes.length === 0) throw new Error('landed export is empty');
const rawSha256 = createHash('sha256').update(bytes).digest('hex');
const text = bytes.toString('utf8');
const { header, dataRows } = countRows(text);

const directory = resolve('runtime/question-library-collection', period, options.productId);
mkdirSync(directory, { recursive: true });
const targetPath = resolve(directory, 'qa.csv');
copyFileSync(sourcePath, targetPath);

const downloadedAt = new Date(statSync(sourcePath).mtimeMs).toISOString();
const receipt = {
  version: 'faq-qa-evidence-v1',
  period,
  productId: options.productId,
  sourceType: '问大家',
  // readEvidence 硬校验 sourceFile === 'qa.csv'（run-question-library-collection.mjs:195），
  // 缺这个字段会在 --apply 阶段才炸；收据从写下那一刻起就必须是契约合法的。
  sourceFile: 'qa.csv',
  status: dataRows > 0 ? 'COMPLETED' : 'EMPTY_SOURCE_ROWS',
  unavailableReason: dataRows > 0 ? null : '页面明确报告无数据（导出仅含表头）',
  rawSource: { filename: basename(sourcePath), bytes: bytes.length, sha256: rawSha256, downloadedAt },
  normalized: { filename: 'qa.csv', sha256: rawSha256, note: '问大家 不需归一化：qa.csv 同时是原始源与行式产物' },
  rows: { header, dataRows },
  scope: { 内容: options.scope },
  quota: options.quotaRemaining == null ? null : { remaining: Number(options.quotaRemaining), limit: options.quotaLimit == null ? null : Number(options.quotaLimit) },
  recordedAt: new Date().toISOString(),
};
writeFileSync(resolve(directory, 'qa-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

// run-status.json 记的是「两份源合起来的商品进度」，不是单个源的进度。
// 早先这里硬写 评论: 'PENDING'，结果重跑问大家会把已经采集完的评论状态打回未完成——
// 一个只看得到「我这一步」的写入方，会把兄弟步骤的事实抹掉。改成读改写、只覆盖自己那一路。
const runStatusPath = resolve(directory, 'run-status.json');
let runStatus = null;
if (existsSync(runStatusPath)) {
  try { runStatus = JSON.parse(readFileSync(runStatusPath, 'utf8')); } catch { runStatus = null; }
}
runStatus = runStatus && typeof runStatus === 'object' ? runStatus : { version: 'faq-run-status-v1', period, productId: options.productId, sources: { 评论: 'PENDING' } };
runStatus.sources = { ...(runStatus.sources ?? {}), 问大家: receipt.status };
const sources = runStatus.sources;
runStatus.state = Object.values(sources).every((value) => value === 'COMPLETED') ? 'COMPLETED' : 'IN_PROGRESS';
runStatus.updatedAt = receipt.recordedAt;
writeFileSync(runStatusPath, `${JSON.stringify(runStatus, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ status: receipt.status, directory, qaCsv: targetPath, rows: dataRows, header, sha256: rawSha256, quota: receipt.quota }, null, 2));
