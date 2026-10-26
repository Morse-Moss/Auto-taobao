#!/usr/bin/env node
// 周报 xlsx 的验收门：把「下游能真的抽出来」和「导入门禁能过」两件事一次做完。
//
// 为什么不看 build 自己报的数字：build-weekly-xlsx.py 报的是「我嵌了 N 张」，
// 那是自证。真正的判据是下游 extract_xws_xlsx.py 能不能把图抽回来、抽回来的行
// 能不能过 validateDataset。2026-10-26 第一次生成时 build 报「1384 张全嵌好了」，
// 实际序号整列为空——就是这个差别。
//
// 用法：
//   node runtime/verify-weekly-xlsx.mjs --manifest <extract manifest> --csv <csv> [--dir <extract 目录>]
//
// 退出码：0 = 全过；1 = 有问题（problems 里逐条写清）；2 = 参数错。
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './taobao-search-core.mjs';
import { validateDataset } from '../skills/xws-export-market-analysis/scripts/flow.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--manifest', '--csv', '--dir'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少取值`);
    args[key.slice(2)] = value;
    index += 1;
  }
  if (!args.manifest) throw new Error('--manifest 必填');
  if (!args.csv) throw new Error('--csv 必填');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
const table = parseCsv(fs.readFileSync(args.csv, 'utf8'));
const headers = table[0];
const rows = table.slice(1).filter((row) => row.some((cell) => cell.trim()));

const problems = [];
const images = manifest.images ?? [];
const extractedRows = manifest.rows ?? [];

// —— 一、结构：表头逐字一致、行数一致 ——
const actualHeaders = manifest.headers ?? [];
if (actualHeaders.length !== headers.length) {
  problems.push(`表头列数不符：xlsx ${actualHeaders.length} vs csv ${headers.length}`);
}
headers.forEach((header, index) => {
  if (actualHeaders[index] !== header) {
    problems.push(`第 ${index + 1} 列表头不符：xlsx=${JSON.stringify(actualHeaders[index])} csv=${JSON.stringify(header)}`);
  }
});
if (extractedRows.length !== rows.length) {
  problems.push(`数据行数不符：xlsx ${extractedRows.length} vs csv ${rows.length}`);
}

// —— 二、图片：全部落在「商品图片」列，行号与数据行一一对应，无重复无孤儿 ——
const imageColumn = headers.indexOf('商品图片') + 1;
const rowSeen = new Map();
for (const image of images) {
  if (image.column !== imageColumn) {
    problems.push(`图 ${image.path} 落在第 ${image.column} 列，应为第 ${imageColumn} 列`);
    break;
  }
  if (image.row < 2 || image.row > rows.length + 1) {
    problems.push(`图 ${image.path} 行号 ${image.row} 越界（应为 2..${rows.length + 1}）`);
    break;
  }
  rowSeen.set(image.row, (rowSeen.get(image.row) ?? 0) + 1);
}
if (images.length !== rows.length) {
  problems.push(`内嵌图数不符：xlsx ${images.length} vs 数据行 ${rows.length}`);
}
const duplicated = [...rowSeen.entries()].filter(([, count]) => count > 1);
if (duplicated.length > 0) {
  problems.push(`${duplicated.length} 行挂了多张图，例：${duplicated.slice(0, 5).map(([row]) => row).join(',')}`);
}
const orphans = rows.map((_, index) => index + 2).filter((row) => !rowSeen.has(row));
if (orphans.length > 0) {
  problems.push(`${orphans.length} 行没有图，例：${orphans.slice(0, 10).join(',')}`);
}

// —— 三、图片字节：按文件头嗅格式，不信扩展名 ——
const sniffed = { jpeg: 0, png: 0, webp: 0, other: 0 };
let badFiles = 0;
let minBytes = Infinity;
let maxBytes = 0;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const image of images) {
  let buffer;
  try { buffer = fs.readFileSync(image.path); } catch { badFiles += 1; continue; }
  minBytes = Math.min(minBytes, buffer.length);
  maxBytes = Math.max(maxBytes, buffer.length);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) sniffed.jpeg += 1;
  else if (buffer.subarray(0, 8).equals(PNG_MAGIC)) sniffed.png += 1;
  else if (buffer.subarray(8, 12).toString('ascii') === 'WEBP') sniffed.webp += 1;
  else sniffed.other += 1;
}
if (badFiles > 0) problems.push(`${badFiles} 个抽取文件读不到`);
if (sniffed.other > 0) problems.push(`${sniffed.other} 个抽取文件文件头不是已知图片格式`);

// —— 四、抽样：标题/链接/店铺名/平台与 CSV 同行相符 ——
const sampleIndexes = [...new Set([0, Math.floor(rows.length / 2), rows.length - 1])];
for (const index of sampleIndexes) {
  for (const column of ['商品标题', '商品链接', '店铺名', '平台']) {
    const columnIndex = headers.indexOf(column);
    const want = rows[index][columnIndex] ?? '';
    const raw = extractedRows[index]?.[column];
    const got = raw === null || raw === undefined ? '' : String(raw);
    if (got !== want) {
      problems.push(`抽样第 ${index + 2} 行「${column}」不符：xlsx=${JSON.stringify(got.slice(0, 40))} csv=${JSON.stringify(want.slice(0, 40))}`);
    }
  }
}

// —— 五、图片列不能残留文本（飞书要附件，留 URL 只会多一列废文本）——
const leaked = extractedRows.filter((row) => {
  const value = row?.['商品图片'];
  return value !== null && value !== undefined && String(value).trim() !== '';
}).length;
if (leaked > 0) problems.push(`${leaked} 行的「商品图片」单元格里残留文本（应为空）`);

// —— 六、导入链真正的门禁：拿抽回来的行跑 validateDataset ——
let contract = null;
try {
  const asArrays = extractedRows.map((row) => headers.map((header) => {
    const value = row?.[header];
    return value === null || value === undefined ? '' : String(value);
  }));
  contract = validateDataset(actualHeaders, asArrays);
} catch (error) {
  problems.push(`validateDataset 未通过：${error.message}`);
}

const summary = {
  ok: problems.length === 0,
  sheet: manifest.sheet,
  headers: actualHeaders.length,
  rows: extractedRows.length,
  images: images.length,
  imageFormat: sniffed,
  imageBytes: { min: minBytes === Infinity ? 0 : minBytes, max: maxBytes },
  sampledRows: sampleIndexes.map((index) => index + 2),
  contract,
  extractDir: args.dir ? path.resolve(args.dir) : null,
  problems,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
